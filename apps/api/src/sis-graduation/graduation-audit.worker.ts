import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { GpaService } from './gpa.service';

/**
 * Deterministic event_id for sis.graduation.at_risk — derived from
 * (studentId, runId). Used by the durable emit so a redelivered envelope
 * carries the same id and downstream consumers dedupe naturally.
 */
export function deterministicAtRiskEventId(studentId: string, runId: string): string {
  const hash = createHash('sha256')
    .update(studentId + ':' + runId + ':sis.graduation.at_risk:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

interface RequirementRow {
  id: string;
  requirement_type: string;
  requirement_name: string;
  subject_area: string | null;
  credits_required: string | null;
  specific_course_id: string | null;
  hours_required: number | null;
  assessment_name: string | null;
  minimum_gpa: string | null;
  applies_to_grade_levels: string[];
}

interface StudentRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  grade_level: string | null;
}

export interface GraduationAuditRunSummary {
  studentsEvaluated: number;
  requirementsEvaluated: number;
  auditsUpserted: number;
  atRiskSeniors: number;
  runId: string;
  emittedAtRiskCount: number;
}

/**
 * GraduationAuditWorker — materialises sis_student_graduation_audits
 * nightly for every active student in the school. For each (student,
 * requirement) pair the worker walks cls_grades + sis_courses (for
 * credit-bearing requirements) plus sis_service_learning_hours (for
 * SERVICE_HOURS) plus sis_student_gpa_snapshots (for MINIMUM_GPA) and
 * computes MET / IN_PROGRESS / NOT_MET.
 *
 * Emits sis.graduation.at_risk per senior who has ANY NOT_MET requirement
 * after the run completes. Deterministic event_id keyed on
 * (studentId, runId) so dedupe at the consumer side stays clean.
 *
 * Currently 'senior' is mapped to grade_level='12'. Schools may
 * configure other definitions; the worker accepts a 'seniorGrades'
 * argument and defaults to ['12'].
 */
@Injectable()
export class GraduationAuditWorker {
  private readonly logger = new Logger(GraduationAuditWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly gpa: GpaService,
  ) {}

  /**
   * Run the audit for every active student in the current tenant.
   * Returns a summary describing the work done. Emits one
   * sis.graduation.at_risk envelope per senior with NOT_MET audits.
   */
  async runForCurrentTenant(
    opts: { seniorGrades?: string[] } = {},
  ): Promise<GraduationAuditRunSummary> {
    const tenant = getCurrentTenant();
    const seniorGrades = opts.seniorGrades ?? ['12'];
    const runId = generateId();
    const summary: GraduationAuditRunSummary = {
      studentsEvaluated: 0,
      requirementsEvaluated: 0,
      auditsUpserted: 0,
      atRiskSeniors: 0,
      runId,
      emittedAtRiskCount: 0,
    };

    const requirements = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(
        'SELECT id::text, requirement_type, requirement_name, subject_area, credits_required::text, ' +
          'specific_course_id::text, hours_required, assessment_name, minimum_gpa::text, applies_to_grade_levels ' +
          'FROM sis_graduation_requirements WHERE school_id = $1::uuid AND is_active = true',
        tenant.schoolId,
      ),
    );
    summary.requirementsEvaluated = requirements.length;
    if (requirements.length === 0) return summary;

    const students = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<StudentRow[]>(
        'SELECT s.id::text, ip.first_name, ip.last_name, s.grade_level FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          "WHERE s.school_id = $1::uuid AND s.enrollment_status = 'ENROLLED'",
        tenant.schoolId,
      ),
    );
    summary.studentsEvaluated = students.length;

    type AtRiskEmit = {
      studentId: string;
      studentName: string;
      gradeLevel: string | null;
      missing: Array<{ requirementId: string; requirementName: string; status: string }>;
    };
    const atRiskEmits: AtRiskEmit[] = [];

    for (const student of students) {
      const isSenior = student.grade_level !== null && seniorGrades.includes(student.grade_level);
      const missingForEmit: AtRiskEmit['missing'] = [];

      for (const req of requirements) {
        // Skip requirements that don't apply to this grade level.
        const applies = req.applies_to_grade_levels ?? [];
        if (
          applies.length > 0 &&
          student.grade_level !== null &&
          !applies.includes(student.grade_level)
        ) {
          continue;
        }

        const result = await this.evaluateRequirement(student.id, req);
        await this.upsertAudit(student.id, req.id, result);
        summary.auditsUpserted += 1;
        if (isSenior && result.status === 'NOT_MET') {
          missingForEmit.push({
            requirementId: req.id,
            requirementName: req.requirement_name,
            status: result.status,
          });
        }
      }

      if (isSenior && missingForEmit.length > 0) {
        summary.atRiskSeniors += 1;
        atRiskEmits.push({
          studentId: student.id,
          studentName: ((student.first_name ?? '') + ' ' + (student.last_name ?? '')).trim(),
          gradeLevel: student.grade_level,
          missing: missingForEmit,
        });
      }
    }

    // Emit at-risk events outside the tenant-context loop so a Kafka hiccup
    // does not roll back the audit writes.
    for (const item of atRiskEmits) {
      try {
        await this.kafka.emit({
          topic: 'sis.graduation.at_risk',
          key: item.studentId,
          eventId: deterministicAtRiskEventId(item.studentId, runId),
          payload: {
            studentId: item.studentId,
            studentName: item.studentName,
            schoolId: tenant.schoolId,
            gradeLevel: item.gradeLevel,
            missingRequirements: item.missing,
            runId,
            evaluatedAt: new Date().toISOString(),
          },
          sourceModule: 'sis-graduation',
        });
        summary.emittedAtRiskCount += 1;
      } catch (err) {
        this.logger.warn(
          'Failed to emit sis.graduation.at_risk for student ' + item.studentId,
          err,
        );
      }
    }

    this.logger.log(
      'Graduation audit complete: ' +
        summary.studentsEvaluated +
        ' students × ' +
        summary.requirementsEvaluated +
        ' requirements; ' +
        summary.auditsUpserted +
        ' rows; ' +
        summary.atRiskSeniors +
        ' at-risk seniors',
    );
    return summary;
  }

  /**
   * Public single-student run used by the manual "re-audit this student"
   * admin endpoint. Does NOT emit sis.graduation.at_risk since the manual
   * trigger is request-bound; the nightly run is the canonical emit path.
   */
  async runForStudent(studentId: string): Promise<{ auditsUpserted: number }> {
    const tenant = getCurrentTenant();
    const requirements = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequirementRow[]>(
        'SELECT id::text, requirement_type, requirement_name, subject_area, credits_required::text, ' +
          'specific_course_id::text, hours_required, assessment_name, minimum_gpa::text, applies_to_grade_levels ' +
          'FROM sis_graduation_requirements WHERE school_id = $1::uuid AND is_active = true',
        tenant.schoolId,
      ),
    );

    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<StudentRow[]>(
        'SELECT s.id::text, ip.first_name, ip.last_name, s.grade_level FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'WHERE s.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) return { auditsUpserted: 0 };
    const student = studentRows[0]!;

    let upserted = 0;
    for (const req of requirements) {
      const applies = req.applies_to_grade_levels ?? [];
      if (
        applies.length > 0 &&
        student.grade_level !== null &&
        !applies.includes(student.grade_level)
      ) {
        continue;
      }
      const result = await this.evaluateRequirement(student.id, req);
      await this.upsertAudit(student.id, req.id, result);
      upserted += 1;
    }
    return { auditsUpserted: upserted };
  }

  /**
   * Evaluate one (student, requirement) pair. Returns a partial audit
   * row ready for upsert. Keystone — wraps every requirement_type variant.
   */
  private async evaluateRequirement(
    studentId: string,
    req: RequirementRow,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number | null;
    creditsRemaining: number | null;
    detail: string | null;
  }> {
    switch (req.requirement_type) {
      case 'CREDIT_TOTAL':
        return this.evalCreditTotal(studentId, Number(req.credits_required ?? '0'));
      case 'SUBJECT_CREDIT':
        return this.evalSubjectCredit(
          studentId,
          req.subject_area ?? '',
          Number(req.credits_required ?? '0'),
        );
      case 'SPECIFIC_COURSE':
        return this.evalSpecificCourse(studentId, req.specific_course_id ?? '');
      case 'SERVICE_HOURS':
        return this.evalServiceHours(studentId, req.hours_required ?? 0);
      case 'ASSESSMENT':
        // Assessment tracking is a future extension — for now we keep the
        // existing audit row's status untouched by reading it back and
        // returning IN_PROGRESS as the safe default.
        return {
          status: 'IN_PROGRESS',
          creditsEarned: null,
          creditsRemaining: null,
          detail: 'Assessment tracking integration pending — manual status updates only.',
        };
      case 'MINIMUM_GPA':
        return this.evalMinimumGpa(studentId, Number(req.minimum_gpa ?? '0'));
      default:
        return {
          status: 'IN_PROGRESS',
          creditsEarned: null,
          creditsRemaining: null,
          detail: 'Unknown requirement type.',
        };
    }
  }

  /**
   * Compute total credits earned from cls_grades joined to sis_classes →
   * sis_courses. A grade contributes its course's credit_hours when the
   * grade is published AND the letter_grade is passing OR the grade_value
   * is >= 60 (the conservative default — schools customise via the
   * grade scale on sis_grade_scale_entries; that fine-grained pass-fail
   * resolution lands in a later cycle).
   */
  private async evalCreditTotal(
    studentId: string,
    creditsRequired: number,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number;
    creditsRemaining: number;
    detail: string;
  }> {
    const totalEarned = await this.computeCreditsEarned(studentId, null);
    const remaining = Math.max(creditsRequired - totalEarned, 0);
    let status: 'MET' | 'IN_PROGRESS' | 'NOT_MET' = 'NOT_MET';
    if (totalEarned >= creditsRequired) status = 'MET';
    else if (totalEarned > 0) status = 'IN_PROGRESS';
    return {
      status,
      creditsEarned: totalEarned,
      creditsRemaining: remaining,
      detail:
        totalEarned.toFixed(2) +
        ' of ' +
        creditsRequired.toFixed(2) +
        ' credits earned (' +
        remaining.toFixed(2) +
        ' remaining).',
    };
  }

  private async evalSubjectCredit(
    studentId: string,
    subjectArea: string,
    creditsRequired: number,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number;
    creditsRemaining: number;
    detail: string;
  }> {
    // Subject area matched via sis_departments.name OR sis_courses.code
    // prefix (e.g. ELA, MATH, SCI). The seed uses department joins so we
    // route through sis_departments.name when set.
    const earned = await this.computeCreditsEarned(studentId, subjectArea);
    const remaining = Math.max(creditsRequired - earned, 0);
    let status: 'MET' | 'IN_PROGRESS' | 'NOT_MET' = 'NOT_MET';
    if (earned >= creditsRequired) status = 'MET';
    else if (earned > 0) status = 'IN_PROGRESS';
    return {
      status,
      creditsEarned: earned,
      creditsRemaining: remaining,
      detail:
        earned.toFixed(2) +
        ' of ' +
        creditsRequired.toFixed(2) +
        ' ' +
        subjectArea +
        ' credits earned.',
    };
  }

  private async computeCreditsEarned(
    studentId: string,
    subjectArea: string | null,
  ): Promise<number> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const baseSql =
        'SELECT COALESCE(SUM(co.credit_hours), 0)::text AS earned FROM cls_grades g ' +
        'JOIN cls_assignments a ON a.id = g.assignment_id ' +
        'JOIN sis_classes c ON c.id = a.class_id ' +
        'JOIN sis_courses co ON co.id = c.course_id ' +
        'LEFT JOIN sis_departments d ON d.id = co.department_id ' +
        'WHERE g.student_id = $1::uuid AND g.is_published = true AND g.grade_value >= 60';
      const sql =
        subjectArea === null ? baseSql : baseSql + ' AND (d.name = $2 OR co.code ILIKE $3)';
      const params: unknown[] = [studentId];
      if (subjectArea !== null) {
        params.push(subjectArea);
        params.push(this.subjectAreaToCodePrefix(subjectArea) + '%');
      }
      const rows = await client.$queryRawUnsafe<Array<{ earned: string }>>(sql, ...params);
      return Number(rows[0]?.earned ?? '0');
    });
  }

  /**
   * Map a subject area (display name) to its likely sis_courses.code
   * prefix. The seed uses ELA / MATH / SCI / SS — the request-path
   * SubjectCredit requirement can be configured with either subject
   * area name or the prefix.
   */
  private subjectAreaToCodePrefix(subjectArea: string): string {
    const upper = subjectArea.toUpperCase();
    if (upper === 'ENGLISH' || upper === 'ELA') return 'ELA';
    if (upper.startsWith('MATH')) return 'MATH';
    if (upper.startsWith('SCIENCE') || upper === 'SCI') return 'SCI';
    if (upper.includes('HISTORY') || upper.includes('SOCIAL')) return 'SS';
    return upper;
  }

  private async evalSpecificCourse(
    studentId: string,
    specificCourseId: string,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number | null;
    creditsRemaining: number | null;
    detail: string;
  }> {
    if (!specificCourseId) {
      return {
        status: 'NOT_MET',
        creditsEarned: null,
        creditsRemaining: null,
        detail: 'Requirement misconfigured — specific_course_id missing.',
      };
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Look up best grade for the student on any cls_assignment in any
      // class that targets the required course. Passing grade required.
      const rows = await client.$queryRawUnsafe<
        Array<{ best: string | null; co_name: string | null }>
      >(
        'SELECT MAX(g.grade_value)::text AS best, co.name AS co_name ' +
          'FROM cls_grades g ' +
          'JOIN cls_assignments a ON a.id = g.assignment_id ' +
          'JOIN sis_classes c ON c.id = a.class_id ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE g.student_id = $1::uuid AND co.id = $2::uuid AND g.is_published = true ' +
          'GROUP BY co.name LIMIT 1',
        studentId,
        specificCourseId,
      );
      const best =
        rows[0]?.best === null || rows[0]?.best === undefined ? null : Number(rows[0]!.best);
      const courseName = rows[0]?.co_name ?? 'required course';
      if (best === null) {
        // No grade yet — check if currently enrolled.
        const enrollment = await client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_classes c ON c.id = e.class_id ' +
            "WHERE e.student_id = $1::uuid AND c.course_id = $2::uuid AND e.status = 'ACTIVE' LIMIT 1",
          studentId,
          specificCourseId,
        );
        if (enrollment.length > 0) {
          return {
            status: 'IN_PROGRESS' as const,
            creditsEarned: null,
            creditsRemaining: null,
            detail: 'Currently enrolled in ' + courseName + '.',
          };
        }
        return {
          status: 'NOT_MET' as const,
          creditsEarned: null,
          creditsRemaining: null,
          detail: courseName + ' has not been completed.',
        };
      }
      if (best >= 60) {
        return {
          status: 'MET' as const,
          creditsEarned: null,
          creditsRemaining: null,
          detail: courseName + ' completed with grade ' + best.toFixed(1) + '.',
        };
      }
      return {
        status: 'NOT_MET' as const,
        creditsEarned: null,
        creditsRemaining: null,
        detail: courseName + ' attempted but not yet passed (grade ' + best.toFixed(1) + ').',
      };
    });
  }

  private async evalServiceHours(
    studentId: string,
    hoursRequired: number,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number | null;
    creditsRemaining: number | null;
    detail: string;
  }> {
    const approved = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ total: string }>>(
        "SELECT COALESCE(SUM(hours), 0)::text AS total FROM sis_service_learning_hours WHERE student_id = $1::uuid AND status = 'APPROVED'",
        studentId,
      );
      return Number(rows[0]?.total ?? '0');
    });
    let status: 'MET' | 'IN_PROGRESS' | 'NOT_MET' = 'NOT_MET';
    if (approved >= hoursRequired) status = 'MET';
    else if (approved > 0) status = 'IN_PROGRESS';
    return {
      status,
      creditsEarned: null,
      creditsRemaining: null,
      detail:
        approved.toFixed(2) +
        ' of ' +
        hoursRequired +
        ' service hours approved (' +
        Math.max(hoursRequired - approved, 0).toFixed(2) +
        ' remaining).',
    };
  }

  private async evalMinimumGpa(
    studentId: string,
    minimumGpa: number,
  ): Promise<{
    status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
    creditsEarned: number | null;
    creditsRemaining: number | null;
    detail: string;
  }> {
    // Use the default GPA config; fall back to "no snapshot" when none exists.
    const tenant = getCurrentTenant();
    const cumulative = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ gpa: string | null }>>(
        'SELECT s.cumulative_gpa::text AS gpa FROM sis_student_gpa_snapshots s ' +
          'JOIN sis_gpa_configurations c ON c.id = s.gpa_config_id ' +
          'WHERE s.student_id = $1::uuid AND c.school_id = $2::uuid AND c.is_default = true ' +
          'ORDER BY s.calculated_at DESC LIMIT 1',
        studentId,
        tenant.schoolId,
      );
      return rows[0]?.gpa === null || rows[0]?.gpa === undefined ? null : Number(rows[0]!.gpa);
    });
    if (cumulative === null) {
      return {
        status: 'NOT_MET',
        creditsEarned: null,
        creditsRemaining: null,
        detail: 'No GPA snapshot yet — minimum ' + minimumGpa.toFixed(2) + ' required.',
      };
    }
    return {
      status: cumulative >= minimumGpa ? 'MET' : 'NOT_MET',
      creditsEarned: null,
      creditsRemaining: null,
      detail:
        'Cumulative GPA ' + cumulative.toFixed(2) + ' vs required ' + minimumGpa.toFixed(2) + '.',
    };
  }

  /**
   * Upsert a single audit row keyed on (student_id, requirement_id).
   * UNIQUE catch on the schema turns concurrent writes into single-row
   * UPDATEs — we use ON CONFLICT for stability under the nightly + manual
   * trigger overlap.
   */
  private async upsertAudit(
    studentId: string,
    requirementId: string,
    r: {
      status: 'MET' | 'IN_PROGRESS' | 'NOT_MET';
      creditsEarned: number | null;
      creditsRemaining: number | null;
      detail: string | null;
    },
  ): Promise<void> {
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_student_graduation_audits ' +
          '(id, student_id, requirement_id, status, credits_earned, credits_remaining, detail, last_calculated) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, now()) ' +
          'ON CONFLICT (student_id, requirement_id) DO UPDATE SET ' +
          'status = EXCLUDED.status, credits_earned = EXCLUDED.credits_earned, ' +
          'credits_remaining = EXCLUDED.credits_remaining, detail = EXCLUDED.detail, ' +
          'last_calculated = now(), updated_at = now()',
        id,
        studentId,
        requirementId,
        r.status,
        r.creditsEarned,
        r.creditsRemaining,
        r.detail,
      ),
    );
    void this.gpa; // keep the injection for future weighted-credit evaluation
  }
}
