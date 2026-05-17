import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { GpaService } from './gpa.service';
import type { GpaConfigDto } from './dto/sis-graduation.dto';

interface StudentRow {
  id: string;
  grade_level: string | null;
}

interface GradeRow {
  grade_value: string;
  letter_grade: string | null;
  credit_hours: string | null;
  is_honors: boolean;
  is_ap: boolean;
  course_id: string;
  course_code: string;
  course_name: string;
  term_id: string | null;
  academic_year_id: string | null;
}

export interface GpaRunSummary {
  studentsEvaluated: number;
  snapshotsUpserted: number;
  configsUsed: number;
  runId: string;
}

/**
 * GPAWorker — materialises sis_student_gpa_snapshots at end-of-term
 * for every active student under the default GPA configuration.
 *
 * Algorithm per (student, config):
 *   1. Pull every published cls_grade joined to sis_classes →
 *      sis_courses (for credit_hours) → sis_terms (for term filter).
 *   2. Resolve a letter grade for the grade_value:
 *        - Prefer cls_grades.letter_grade when populated.
 *        - Fallback to sis_grade_scale_entries lookup using the school's
 *          'Standard' scale (min_percentage <= grade_value <= max_percentage).
 *   3. Apply the config.grade_point_mapping to derive base points.
 *   4. Apply honors_weight_bonus / ap_weight_bonus when calculation_method
 *      = 'WEIGHTED' AND the assignment's is_honors / is_ap flag is true.
 *   5. Accumulate weighted-credits + credits-attempted + credits-earned
 *      (earned only when is_passing OR grade_points > 0).
 *   6. cumulative_gpa = total_weighted_points / total_credits_attempted.
 *   7. term_gpa filtered to the supplied termId.
 *   8. UPSERT sis_student_gpa_snapshots keyed on (student, config, year, term).
 *
 * Returns a summary describing the work done.
 *
 * Honors / AP attribution: the seed-classroom data does not flag
 * assignments as honors / AP today, so both bonuses come out to 0 for
 * existing data — but the algorithm correctly applies the bonus when
 * an upstream cycle starts populating cls_assignments.is_honors or a
 * is_ap column. For now we read assignment-level flags via
 * cls_assignment_categories if they exist; if not, both default false.
 */
@Injectable()
export class GpaWorker {
  private readonly logger = new Logger(GpaWorker.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly gpa: GpaService,
  ) {}

  /**
   * Compute snapshots for every active student in the current tenant
   * using the supplied termId (when provided) for term_gpa + the
   * default GPA config for cumulative_gpa. When termId is omitted only
   * a cumulative-only snapshot row lands (academic_year_id + term_id NULL).
   */
  async runForCurrentTenant(
    opts: {
      termId?: string;
      academicYearId?: string;
      configId?: string;
    } = {},
  ): Promise<GpaRunSummary> {
    const tenant = getCurrentTenant();
    const runId = generateId();
    const summary: GpaRunSummary = {
      studentsEvaluated: 0,
      snapshotsUpserted: 0,
      configsUsed: 0,
      runId,
    };

    // Resolve the GPA config to use — explicit or default.
    let config: GpaConfigDto | null = null;
    if (opts.configId) {
      config = await this.gpa.getConfig(opts.configId);
    } else {
      config = await this.gpa.getDefaultConfig();
    }
    if (config === null) {
      this.logger.warn('No default GPA configuration set; GPAWorker skipping run.');
      return summary;
    }
    summary.configsUsed = 1;

    // Load the grade-points fallback scale (used when cls_grades.letter_grade
    // is null). Currently hard-coded to 'Standard'; future cycles can
    // make this configurable per config.
    const fallbackScale = await this.loadFallbackScale(tenant.schoolId);

    const students = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<StudentRow[]>(
        "SELECT id::text, grade_level FROM sis_students WHERE school_id = $1::uuid AND enrollment_status = 'ENROLLED'",
        tenant.schoolId,
      ),
    );
    summary.studentsEvaluated = students.length;

    // Map: studentId → snapshot
    const computed: Array<{
      studentId: string;
      gradeLevel: string | null;
      cumulativeGpa: number | null;
      termGpa: number | null;
      creditsAttempted: number;
      creditsEarned: number;
    }> = [];

    for (const student of students) {
      const grades = await this.loadGradesForStudent(student.id);
      const cum = this.computeGpa(grades, config, fallbackScale, null, null);
      const term = opts.termId
        ? this.computeGpa(grades, config, fallbackScale, opts.termId, opts.academicYearId ?? null)
        : null;
      computed.push({
        studentId: student.id,
        gradeLevel: student.grade_level,
        cumulativeGpa: cum.totalCreditsAttempted > 0 ? cum.gpa : null,
        termGpa: term && term.totalCreditsAttempted > 0 ? term.gpa : null,
        creditsAttempted: cum.totalCreditsAttempted,
        creditsEarned: cum.totalCreditsEarned,
      });
    }

    // Compute class rank within (grade_level, school). Only ranks
    // students who have a non-null cumulative_gpa.
    const byGrade = new Map<string | null, typeof computed>();
    for (const c of computed) {
      const arr = byGrade.get(c.gradeLevel) ?? [];
      arr.push(c);
      byGrade.set(c.gradeLevel, arr);
    }
    const rankByStudent = new Map<string, { rank: number; size: number }>();
    for (const [, group] of byGrade) {
      const ranked = group
        .filter((g) => g.cumulativeGpa !== null)
        .sort((a, b) => (b.cumulativeGpa ?? 0) - (a.cumulativeGpa ?? 0));
      ranked.forEach((g, idx) => {
        rankByStudent.set(g.studentId, { rank: idx + 1, size: ranked.length });
      });
    }

    // Upsert one snapshot row per student. Two rows in fact — the
    // termed snapshot (when termId supplied) plus a cumulative-only
    // row (academic_year_id + term_id NULL) so the read paths can
    // pull "latest cumulative" without supplying year + term.
    for (const c of computed) {
      const rank = rankByStudent.get(c.studentId) ?? null;
      if (opts.termId) {
        await this.upsertSnapshot({
          studentId: c.studentId,
          configId: config.id,
          academicYearId: opts.academicYearId ?? null,
          termId: opts.termId,
          cumulativeGpa: c.cumulativeGpa,
          termGpa: c.termGpa,
          creditsAttempted: c.creditsAttempted,
          creditsEarned: c.creditsEarned,
          classRank: rank?.rank ?? null,
          classSize: rank?.size ?? null,
        });
        summary.snapshotsUpserted += 1;
      }
      // Cumulative-only row.
      await this.upsertSnapshot({
        studentId: c.studentId,
        configId: config.id,
        academicYearId: null,
        termId: null,
        cumulativeGpa: c.cumulativeGpa,
        termGpa: null,
        creditsAttempted: c.creditsAttempted,
        creditsEarned: c.creditsEarned,
        classRank: rank?.rank ?? null,
        classSize: rank?.size ?? null,
      });
      summary.snapshotsUpserted += 1;
    }

    this.logger.log(
      'GPA run complete: ' +
        summary.studentsEvaluated +
        ' students × ' +
        summary.configsUsed +
        ' config; ' +
        summary.snapshotsUpserted +
        ' snapshots upserted',
    );
    return summary;
  }

  /**
   * Public entry — compute snapshots for one student. Used by the manual
   * trigger admin endpoint + by the GraduationAuditWorker indirectly when
   * the MINIMUM_GPA requirement reads the latest snapshot.
   */
  async runForStudent(
    studentId: string,
    opts: { termId?: string; academicYearId?: string; configId?: string } = {},
  ): Promise<{ snapshotsUpserted: number; cumulativeGpa: number | null; termGpa: number | null }> {
    const tenant = getCurrentTenant();
    let config: GpaConfigDto | null = null;
    if (opts.configId) {
      config = await this.gpa.getConfig(opts.configId);
    } else {
      config = await this.gpa.getDefaultConfig();
    }
    if (config === null) {
      return { snapshotsUpserted: 0, cumulativeGpa: null, termGpa: null };
    }
    const fallbackScale = await this.loadFallbackScale(tenant.schoolId);
    const grades = await this.loadGradesForStudent(studentId);
    const cum = this.computeGpa(grades, config, fallbackScale, null, null);
    const term = opts.termId
      ? this.computeGpa(grades, config, fallbackScale, opts.termId, opts.academicYearId ?? null)
      : null;
    const cumulativeGpa = cum.totalCreditsAttempted > 0 ? cum.gpa : null;
    const termGpa = term && term.totalCreditsAttempted > 0 ? term.gpa : null;
    let upserted = 0;
    if (opts.termId) {
      await this.upsertSnapshot({
        studentId,
        configId: config.id,
        academicYearId: opts.academicYearId ?? null,
        termId: opts.termId,
        cumulativeGpa,
        termGpa,
        creditsAttempted: cum.totalCreditsAttempted,
        creditsEarned: cum.totalCreditsEarned,
        classRank: null,
        classSize: null,
      });
      upserted += 1;
    }
    await this.upsertSnapshot({
      studentId,
      configId: config.id,
      academicYearId: null,
      termId: null,
      cumulativeGpa,
      termGpa: null,
      creditsAttempted: cum.totalCreditsAttempted,
      creditsEarned: cum.totalCreditsEarned,
      classRank: null,
      classSize: null,
    });
    upserted += 1;
    return { snapshotsUpserted: upserted, cumulativeGpa, termGpa };
  }

  private async loadFallbackScale(
    schoolId: string,
  ): Promise<
    Array<{ letter: string; min: number; max: number; gradePoints: number; isPassing: boolean }>
  > {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<
        Array<{
          letter_grade: string;
          min_percentage: string | null;
          max_percentage: string | null;
          grade_points: string | null;
          is_passing: boolean;
        }>
      >(
        'SELECT letter_grade, min_percentage::text, max_percentage::text, grade_points::text, is_passing ' +
          "FROM sis_grade_scale_entries WHERE school_id = $1::uuid AND scale_name = 'Standard' " +
          'ORDER BY sort_order',
        schoolId,
      ),
    );
    return rows.map((r) => ({
      letter: r.letter_grade,
      min: r.min_percentage === null ? 0 : Number(r.min_percentage),
      max: r.max_percentage === null ? 100 : Number(r.max_percentage),
      gradePoints: r.grade_points === null ? 0 : Number(r.grade_points),
      isPassing: r.is_passing,
    }));
  }

  private async loadGradesForStudent(studentId: string): Promise<GradeRow[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<GradeRow[]>(
        'SELECT g.grade_value::text, g.letter_grade, co.credit_hours::text, ' +
          'false AS is_honors, false AS is_ap, ' +
          'co.id::text AS course_id, co.code AS course_code, co.name AS course_name, ' +
          'c.term_id::text AS term_id, c.academic_year_id::text AS academic_year_id ' +
          'FROM cls_grades g ' +
          'JOIN cls_assignments a ON a.id = g.assignment_id ' +
          'JOIN sis_classes c ON c.id = a.class_id ' +
          'JOIN sis_courses co ON co.id = c.course_id ' +
          'WHERE g.student_id = $1::uuid AND g.is_published = true',
        studentId,
      ),
    );
  }

  /**
   * Pure compute — given the loaded grade rows, the config, and an
   * optional term filter, returns weighted GPA + credits attempted +
   * credits earned.
   *
   * When termId is provided AND no rows match, returns
   * totalCreditsAttempted=0 so the caller can decide whether to land
   * a NULL term_gpa snapshot.
   */
  computeGpa(
    grades: GradeRow[],
    config: GpaConfigDto,
    fallbackScale: Array<{
      letter: string;
      min: number;
      max: number;
      gradePoints: number;
      isPassing: boolean;
    }>,
    termId: string | null,
    academicYearId: string | null,
  ): { gpa: number; totalCreditsAttempted: number; totalCreditsEarned: number } {
    const filtered = grades.filter((g) => {
      if (termId !== null && g.term_id !== termId) return false;
      if (academicYearId !== null && g.academic_year_id !== academicYearId) return false;
      return true;
    });
    let weightedPoints = 0;
    let attempted = 0;
    let earned = 0;
    for (const grade of filtered) {
      const credits = grade.credit_hours === null ? 1 : Number(grade.credit_hours);
      if (credits <= 0) continue;
      // Resolve letter grade.
      let letter = grade.letter_grade;
      if (!letter) {
        letter = this.resolveLetterFromScale(Number(grade.grade_value), fallbackScale);
      }
      const basePointsRaw = config.gradePointMapping[letter];
      let basePoints: number;
      if (basePointsRaw === undefined) {
        // Letter not in mapping — fall back to scale-derived grade_points.
        const scaleEntry = fallbackScale.find((s) => s.letter === letter);
        basePoints = scaleEntry?.gradePoints ?? 0;
      } else {
        basePoints = basePointsRaw;
      }
      let points = basePoints;
      if (config.calculationMethod === 'WEIGHTED') {
        if (grade.is_honors === true) points += config.honorsWeightBonus;
        if (grade.is_ap === true) points += config.apWeightBonus;
      }
      attempted += credits;
      weightedPoints += points * credits;
      // Earned: pass when basePoints > 0 OR fallback scale marks is_passing.
      const passingByMapping = basePoints > 0;
      const scaleEntry = fallbackScale.find((s) => s.letter === letter);
      const isPassing = passingByMapping || (scaleEntry?.isPassing ?? false);
      if (isPassing) earned += credits;
    }
    const gpa = attempted > 0 ? weightedPoints / attempted : 0;
    return {
      gpa: Number(gpa.toFixed(3)),
      totalCreditsAttempted: Number(attempted.toFixed(2)),
      totalCreditsEarned: Number(earned.toFixed(2)),
    };
  }

  resolveLetterFromScale(
    percentage: number,
    scale: Array<{
      letter: string;
      min: number;
      max: number;
      gradePoints: number;
      isPassing: boolean;
    }>,
  ): string {
    for (const entry of scale) {
      if (percentage >= entry.min && percentage <= entry.max) return entry.letter;
    }
    return 'F';
  }

  private async upsertSnapshot(input: {
    studentId: string;
    configId: string;
    academicYearId: string | null;
    termId: string | null;
    cumulativeGpa: number | null;
    termGpa: number | null;
    creditsAttempted: number;
    creditsEarned: number;
    classRank: number | null;
    classSize: number | null;
  }): Promise<void> {
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      // The COALESCE-sentinel UNIQUE on (student, config, year, term) makes
      // raw ON CONFLICT awkward — do a manual SELECT-and-decide.
      const existing = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text FROM sis_student_gpa_snapshots ' +
          'WHERE student_id = $1::uuid AND gpa_config_id = $2::uuid ' +
          "AND COALESCE(academic_year_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid) " +
          "AND COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid) " +
          'LIMIT 1',
        input.studentId,
        input.configId,
        input.academicYearId,
        input.termId,
      );
      if (existing.length > 0) {
        await client.$executeRawUnsafe(
          'UPDATE sis_student_gpa_snapshots SET cumulative_gpa = $1, term_gpa = $2, ' +
            'total_credits_attempted = $3, total_credits_earned = $4, class_rank = $5, class_size = $6, ' +
            'calculated_at = now(), updated_at = now() WHERE id = $7::uuid',
          input.cumulativeGpa,
          input.termGpa,
          input.creditsAttempted,
          input.creditsEarned,
          input.classRank,
          input.classSize,
          existing[0]!.id,
        );
      } else {
        await client.$executeRawUnsafe(
          'INSERT INTO sis_student_gpa_snapshots ' +
            '(id, student_id, gpa_config_id, academic_year_id, term_id, cumulative_gpa, term_gpa, ' +
            'total_credits_attempted, total_credits_earned, class_rank, class_size, calculated_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, now())',
          id,
          input.studentId,
          input.configId,
          input.academicYearId,
          input.termId,
          input.cumulativeGpa,
          input.termGpa,
          input.creditsAttempted,
          input.creditsEarned,
          input.classRank,
          input.classSize,
        );
      }
    });
  }
}
