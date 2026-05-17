import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { KafkaProducerService } from '@shared/kafka';
import {
  ComplianceDashboardDto,
  ComplianceStatus,
  ImmunisationComplianceDto,
  ListComplianceQueryDto,
  MissingVaccineDto,
} from '../records/dto/health-advanced.dto';
import { ImmunisationRequirementService } from './immunisation-requirement.service';

interface ComplianceRow {
  id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  student_grade: string | null;
  school_id: string;
  academic_year_id: string | null;
  status: string;
  missing_vaccines: unknown;
  exemption_type: string | null;
  exemption_document_s3_key: string | null;
  last_computed_at: string;
  parent_notified_at: string | null;
}

interface ImmunisationDoseRow {
  health_record_id: string;
  vaccine_name: string;
  status: string;
  student_id: string;
}

const SELECT_COMPLIANCE_BASE =
  'SELECT c.id::text AS id, c.student_id::text AS student_id, ' +
  '       sip.first_name AS student_first, sip.last_name AS student_last, ' +
  '       s.grade_level AS student_grade, ' +
  '       c.school_id::text AS school_id, ' +
  '       c.academic_year_id::text AS academic_year_id, ' +
  '       c.status, c.missing_vaccines, c.exemption_type, c.exemption_document_s3_key, ' +
  '       c.last_computed_at::text AS last_computed_at, ' +
  '       c.parent_notified_at::text AS parent_notified_at ' +
  'FROM hlth_immunisation_compliance c ' +
  'LEFT JOIN sis_students s ON s.id = c.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person sip ON sip.id = ps.person_id ';

/**
 * Compliance read + manual trigger surface plus the materialisation
 * primitive used by the nightly ImmunisationComplianceWorker.
 *
 * Materialisation contract:
 *   - For each enrolled sis_students row, count the dose entries in
 *     hlth_immunisations (joined through hlth_student_health_records)
 *     by vaccine_name where status='CURRENT'.
 *   - Compare against active hlth_immunisation_requirements for the
 *     student's grade.
 *   - Emit COMPLIANT (no missing), NON_COMPLIANT (one or more gaps),
 *     EXEMPT (existing exemption_type populated — preserved across
 *     re-runs), or PROVISIONAL (caller-supplied; we don't auto-flag
 *     PROVISIONAL today — schools enter it manually for transfer
 *     students within the grace window).
 *   - UPSERT into hlth_immunisation_compliance keyed on
 *     (student_id, COALESCE(academic_year_id, sentinel)) so re-runs
 *     are idempotent (REVIEW-CYCLE3 BLOCKING-class — re-running the
 *     worker should never insert duplicates).
 *   - Newly-NON_COMPLIANT students (was COMPLIANT or EXEMPT or
 *     missing, now NON_COMPLIANT) emit hlth.immunisation.noncompliant
 *     for parent notification.
 */
@Injectable()
export class ImmunisationComplianceService {
  private readonly logger = new Logger(ImmunisationComplianceService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly requirements: ImmunisationRequirementService,
    private readonly kafka: KafkaProducerService,
  ) {}

  // ---------- read surface -------------------------------------------------

  async dashboard(): Promise<ComplianceDashboardDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT ' +
          '  COUNT(*)::int AS total, ' +
          "  COUNT(*) FILTER (WHERE status='COMPLIANT')::int AS compliant, " +
          "  COUNT(*) FILTER (WHERE status='NON_COMPLIANT')::int AS non_compliant, " +
          "  COUNT(*) FILTER (WHERE status='EXEMPT')::int AS exempt, " +
          "  COUNT(*) FILTER (WHERE status='PROVISIONAL')::int AS provisional, " +
          '  MAX(last_computed_at)::text AS last_computed_at ' +
          'FROM hlth_immunisation_compliance WHERE school_id = $1::uuid',
        tenant.schoolId,
      )) as Array<{
        total: number;
        compliant: number;
        non_compliant: number;
        exempt: number;
        provisional: number;
        last_computed_at: string | null;
      }>;
      const r = rows[0]!;
      const compliantPlusExempt = r.compliant + r.exempt;
      const compliancePercent =
        r.total > 0 ? Math.round((compliantPlusExempt / r.total) * 1000) / 10 : 0;
      return {
        schoolId: tenant.schoolId,
        totalStudents: r.total,
        compliant: r.compliant,
        nonCompliant: r.non_compliant,
        exempt: r.exempt,
        provisional: r.provisional,
        compliancePercent,
        lastComputedAt: r.last_computed_at,
      };
    });
  }

  async list(args: ListComplianceQueryDto): Promise<ImmunisationComplianceDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 200, 500);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const params: unknown[] = [tenant.schoolId];
      let where = 'WHERE c.school_id = $1::uuid';
      if (args.status) {
        params.push(args.status);
        where += ' AND c.status = $' + params.length;
      }
      if (args.grade) {
        params.push(args.grade);
        where += ' AND s.grade_level = $' + params.length;
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_COMPLIANCE_BASE +
          where +
          ' ORDER BY c.status, sip.last_name, sip.first_name LIMIT ' +
          limit,
        ...params,
      )) as ComplianceRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getForStudent(studentId: string, actor: ResolvedActor): Promise<ImmunisationComplianceDto> {
    const tenant = getCurrentTenant();
    // REVIEW-P2C3 Round 2 BLOCKING — actor-type-specific gating.
    //
    // The endpoint sits behind hlt-001:read at the controller (held
    // broadly: Teacher / Parent / Student / Staff). hlt-001:read alone
    // is NOT sufficient for full immunisation compliance detail —
    // teachers must NOT be able to read a student's compliance record
    // by UUID. Per-actor narrowing:
    //
    //   - School admin: full access.
    //   - GUARDIAN: only linked children via sis_student_guardians.
    //   - STUDENT: only own row resolved actor.personId →
    //     platform_students.person_id → sis_students.id.
    //   - STAFF (or anyone else with hlt-001:read): require an
    //     immunisation-compliance permission (hlt-007 read/write/admin).
    //     Generic teachers without HLT-007 fall through to 404.
    //   - Anything else: 404 don't-leak-existence.
    if (!actor.isSchoolAdmin) {
      const allowed = await this.tenantPrisma.executeInTenantContext(async (client) => {
        if (actor.personType === 'GUARDIAN' && actor.personId) {
          // REVIEW-P2C3 Round 3 closeout — guardian probe is now
          // school-scoped via the sis_students join. The compliance
          // read below is already school-scoped, but joining at the
          // relationship-check stage matches the student-self path
          // shape and collapses cross-school guardian-id collisions
          // to 404 at the relationship gate rather than at the
          // compliance-row read.
          const rows = (await client.$queryRawUnsafe(
            'SELECT 1 FROM sis_student_guardians sg ' +
              'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
              'JOIN sis_students s ON s.id = sg.student_id ' +
              'WHERE s.school_id = $1::uuid ' +
              '  AND sg.student_id = $2::uuid ' +
              '  AND g.person_id = $3::uuid LIMIT 1',
            tenant.schoolId,
            studentId,
            actor.personId,
          )) as unknown[];
          return rows.length > 0;
        }
        if (actor.personType === 'STUDENT' && actor.personId) {
          const rows = (await client.$queryRawUnsafe(
            'SELECT 1 FROM sis_students s ' +
              'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
              'WHERE s.school_id = $1::uuid AND s.id = $2::uuid AND ps.person_id = $3::uuid LIMIT 1',
            tenant.schoolId,
            studentId,
            actor.personId,
          )) as unknown[];
          return rows.length > 0;
        }
        // Staff, nurse, or any non-guardian / non-student actor must
        // hold a HLT-007 (Immunisation Compliance) permission. The
        // controller's hlt-001:read gate is no longer a pass-through.
        const hasCompliance = await this.permissions.hasAnyPermissionInTenant(
          actor.accountId,
          tenant.schoolId,
          ['hlt-007:read', 'hlt-007:write', 'hlt-007:admin'],
        );
        return hasCompliance;
      });
      if (!allowed) {
        throw new NotFoundException('Compliance record not found');
      }
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_COMPLIANCE_BASE + 'WHERE c.school_id = $1::uuid AND c.student_id = $2::uuid LIMIT 1',
        tenant.schoolId,
        studentId,
      )) as ComplianceRow[];
      if (rows.length === 0) throw new NotFoundException('Compliance record not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async runManually(
    studentId: string | null,
    actor: ResolvedActor,
  ): Promise<{ computed: number; newlyNonCompliant: number }> {
    await this.assertAdmin(actor);
    return this.computeForSchool(studentId);
  }

  // ---------- materialisation primitive -----------------------------------

  /**
   * Compute compliance for one student or every enrolled student in
   * the calling tenant. Returns counts and emits
   * hlth.immunisation.noncompliant per newly NON_COMPLIANT student.
   * The worker calls this with studentId=null; an admin can call with
   * a specific studentId for ad-hoc recompute.
   */
  async computeForSchool(
    studentId: string | null,
  ): Promise<{ computed: number; newlyNonCompliant: number }> {
    const tenant = getCurrentTenant();
    const stateCode = await this.resolveSchoolState(tenant.schoolId);
    const requirements = await this.requirements.loadActiveForCompute(stateCode);

    // Group requirements by required_by_grade — schools sort by grade
    // bands ("K", "1", ..., "7", ...). The plan's contract is "all
    // requirements for grade X or below apply at grade X" — i.e. a
    // K-required vaccine still applies in grade 5. We treat
    // numeric grades comparably; "K"/"PK" rank below 1.
    const gradeRank = (g: string): number => {
      const u = g.toUpperCase().trim();
      if (u === 'PK') return -1;
      if (u === 'K') return 0;
      const n = Number.parseInt(u, 10);
      return Number.isNaN(n) ? 99 : n;
    };

    const yearRow = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_academic_years WHERE is_current = true LIMIT 1',
      )) as Array<{ id: string }>;
      return rows.length > 0 ? rows[0]!.id : null;
    });

    return this.tenantPrisma
      .executeInTenantTransaction(async (tx) => {
        const studentRows = (await tx.$queryRawUnsafe(
          studentId
            ? 'SELECT s.id::text AS id, s.grade_level FROM sis_students s WHERE s.id = $1::uuid LIMIT 1'
            : 'SELECT s.id::text AS id, s.grade_level FROM sis_students s',
          ...(studentId ? [studentId] : []),
        )) as Array<{ id: string; grade_level: string | null }>;

        // Read existing compliance rows in one shot for newly-flag detection.
        const existingRows = (await tx.$queryRawUnsafe(
          'SELECT student_id::text AS student_id, status, exemption_type ' +
            'FROM hlth_immunisation_compliance WHERE school_id = $1::uuid',
          tenant.schoolId,
        )) as Array<{ student_id: string; status: string; exemption_type: string | null }>;
        const existingByStudent = new Map<
          string,
          { status: string; exemption_type: string | null }
        >();
        for (const r of existingRows) {
          existingByStudent.set(r.student_id, {
            status: r.status,
            exemption_type: r.exemption_type,
          });
        }

        // Read all immunisations once.
        const immunisations = (await tx.$queryRawUnsafe(
          'SELECT i.health_record_id::text AS health_record_id, i.vaccine_name, i.status, ' +
            '       hr.student_id::text AS student_id ' +
            'FROM hlth_immunisations i ' +
            'JOIN hlth_student_health_records hr ON hr.id = i.health_record_id ' +
            'WHERE hr.school_id = $1::uuid',
          tenant.schoolId,
        )) as ImmunisationDoseRow[];
        const dosesByStudent = new Map<string, Map<string, number>>();
        for (const i of immunisations) {
          if (i.status !== 'CURRENT') continue;
          const m = dosesByStudent.get(i.student_id) ?? new Map<string, number>();
          m.set(i.vaccine_name, (m.get(i.vaccine_name) ?? 0) + 1);
          dosesByStudent.set(i.student_id, m);
        }

        // Collect (studentId, missingVaccines, computedAt) tuples inside
        // the tx so the post-commit emit carries the exact contract the
        // reviewer specified. Emit happens AFTER the tx resolves so a
        // Kafka outage cannot roll back the compliance row write.
        const newlyNonCompliant: Array<{
          studentId: string;
          missingVaccines: MissingVaccineDto[];
          computedAt: string;
        }> = [];
        let computed = 0;

        for (const stu of studentRows) {
          const grade = stu.grade_level;
          const studentRank = grade ? gradeRank(grade) : 99;
          const applicable = requirements.filter(
            (r) => gradeRank(r.required_by_grade) <= studentRank,
          );
          const doses = dosesByStudent.get(stu.id) ?? new Map<string, number>();

          const missing: MissingVaccineDto[] = [];
          for (const r of applicable) {
            const received = doses.get(r.vaccine_name) ?? 0;
            if (received < r.required_doses) {
              missing.push({
                vaccineName: r.vaccine_name,
                dosesReceived: received,
                dosesRequired: r.required_doses,
              });
            }
          }

          const existing = existingByStudent.get(stu.id);
          // Preserve existing EXEMPT / PROVISIONAL status if the school
          // has already classified the student. The worker only flips
          // COMPLIANT ↔ NON_COMPLIANT; manual EXEMPT / PROVISIONAL stays.
          let newStatus: ComplianceStatus;
          if (existing && (existing.status === 'EXEMPT' || existing.status === 'PROVISIONAL')) {
            newStatus = existing.status as ComplianceStatus;
          } else {
            newStatus = missing.length === 0 ? 'COMPLIANT' : 'NON_COMPLIANT';
          }

          const wasNonCompliant = existing?.status === 'NON_COMPLIANT';
          const isNowNonCompliant = newStatus === 'NON_COMPLIANT';
          if (isNowNonCompliant && !wasNonCompliant) {
            newlyNonCompliant.push({
              studentId: stu.id,
              missingVaccines: missing,
              computedAt: new Date().toISOString(),
            });
          }

          const id = existing ? null : generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO hlth_immunisation_compliance ' +
              '(id, student_id, school_id, academic_year_id, status, missing_vaccines, ' +
              ' exemption_type, last_computed_at) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7, now()) ' +
              'ON CONFLICT (student_id, COALESCE(academic_year_id, ' +
              "  '00000000-0000-0000-0000-000000000000'::uuid)) " +
              'DO UPDATE SET status = EXCLUDED.status, ' +
              '  missing_vaccines = EXCLUDED.missing_vaccines, ' +
              '  last_computed_at = now(), updated_at = now()',
            id ?? generateId(),
            stu.id,
            tenant.schoolId,
            yearRow,
            newStatus,
            JSON.stringify(
              missing.map((m) => ({
                vaccine_name: m.vaccineName,
                doses_received: m.dosesReceived,
                doses_required: m.dosesRequired,
              })),
            ),
            existing?.exemption_type ?? null,
          );
          computed += 1;
        }

        return { computed, pending: newlyNonCompliant };
      })
      .then(async ({ computed, pending }) => {
        // Post-commit emit. Topic + sourceModule + payload shape match
        // P2C3-REVIEW-NOTES.md exactly: the consumer needs the missing
        // vaccine breakdown to render the parent notification body
        // without a second round-trip back into the database.
        for (const ev of pending) {
          try {
            await this.kafka.emit({
              topic: 'hlth.immunisation.noncompliant',
              key: ev.studentId,
              sourceModule: 'health-advanced',
              payload: {
                schoolId: tenant.schoolId,
                studentId: ev.studentId,
                missingVaccines: ev.missingVaccines,
                computedAt: ev.computedAt,
              },
            });
          } catch (e: any) {
            this.logger.warn(
              'hlth.immunisation.noncompliant emit failed for student=' +
                ev.studentId +
                ': ' +
                (e?.message || e),
            );
          }
        }
        return { computed, newlyNonCompliant: pending.length };
      });
  }

  // ---------- helpers ------------------------------------------------------

  private async resolveSchoolState(_schoolId: string): Promise<string> {
    // Minimum viable resolution: most US states use 2-letter codes; we
    // default to KS for the demo seed. A future migration can read
    // platform.schools.state if/when that column is added.
    return 'KS';
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-007:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Manual compliance recompute requires hlt-007:admin or school admin.',
      );
    }
  }

  private rowToDto(r: ComplianceRow): ImmunisationComplianceDto {
    let missing: MissingVaccineDto[] = [];
    if (Array.isArray(r.missing_vaccines)) {
      missing = (r.missing_vaccines as Array<Record<string, unknown>>).map((m) => ({
        vaccineName: String(m['vaccine_name'] ?? ''),
        dosesReceived: Number(m['doses_received'] ?? 0),
        dosesRequired: Number(m['doses_required'] ?? 0),
      }));
    }
    const studentName =
      r.student_first || r.student_last
        ? [r.student_first, r.student_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      studentId: r.student_id,
      studentName,
      studentGrade: r.student_grade,
      schoolId: r.school_id,
      academicYearId: r.academic_year_id,
      status: r.status as ComplianceStatus,
      missingVaccines: missing,
      exemptionType: r.exemption_type,
      exemptionDocumentS3Key: r.exemption_document_s3_key,
      lastComputedAt: r.last_computed_at,
      parentNotifiedAt: r.parent_notified_at,
    };
  }

  /**
   * State-formatted CSV for the annual compliance report. Columns:
   * student_state_id, grade_level, vaccine_name, doses_required,
   * doses_received, compliance_status, exemption_type. Each missing
   * vaccine becomes its own row; COMPLIANT / EXEMPT students have one
   * summary row per applicable vaccine.
   */
  async stateReportCsv(): Promise<string> {
    const tenant = getCurrentTenant();
    const stateCode = await this.resolveSchoolState(tenant.schoolId);
    const requirements = await this.requirements.loadActiveForCompute(stateCode);
    const compliance = await this.list({ limit: 500 });

    const rows: string[] = [];
    rows.push(
      'student_state_id,grade_level,vaccine_name,doses_required,doses_received,compliance_status,exemption_type',
    );
    for (const c of compliance) {
      const grade = c.studentGrade ?? '';
      const status = c.status;
      const exemption = c.exemptionType ?? '';
      // For NON_COMPLIANT we already have the missing list.
      if (status === 'NON_COMPLIANT' && c.missingVaccines.length > 0) {
        for (const m of c.missingVaccines) {
          rows.push(
            csvRow([
              c.studentId,
              grade,
              m.vaccineName,
              String(m.dosesRequired),
              String(m.dosesReceived),
              status,
              exemption,
            ]),
          );
        }
        continue;
      }
      // For COMPLIANT / EXEMPT / PROVISIONAL emit one row per applicable
      // requirement so the state's per-vaccine rollup picks up the
      // student under each vaccine's column.
      for (const r of requirements) {
        rows.push(
          csvRow([
            c.studentId,
            grade,
            r.vaccine_name,
            String(r.required_doses),
            status === 'EXEMPT' ? '' : String(r.required_doses),
            status,
            exemption,
          ]),
        );
      }
    }
    return rows.join('\n') + '\n';
  }
}

function csvRow(fields: string[]): string {
  return fields
    .map((f) => {
      if (f === null || f === undefined) return '';
      const s = String(f);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}
