import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  AddEvidenceDto,
  ClassStandardsReportDto,
  CreateStandardGradeDto,
  PROFICIENCY_LEVELS,
  type ProficiencyLevel,
  StandardGradeEvidenceResponseDto,
  StandardGradeResponseDto,
  UpdateStandardGradeDto,
} from './dto/standard-grade.dto';

interface StandardGradeRow {
  id: string;
  student_id: string;
  student_name: string | null;
  standard_id: string;
  standard_code: string | null;
  standard_description: string | null;
  class_id: string;
  class_name: string | null;
  proficiency_level: ProficiencyLevel;
  assessed_by: string;
  assessed_by_name: string | null;
  assessed_at: Date | string;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceRow {
  id: string;
  standard_grade_id: string;
  evidence_type: 'SUBMISSION' | 'OBSERVATION' | 'ASSESSMENT' | 'TEACHER_NOTE';
  evidence_ref_id: string | null;
  description: string | null;
  added_by: string | null;
  added_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

function evidenceRowToDto(row: EvidenceRow): StandardGradeEvidenceResponseDto {
  return {
    id: row.id,
    standardGradeId: row.standard_grade_id,
    evidenceType: row.evidence_type,
    evidenceRefId: row.evidence_ref_id,
    description: row.description,
    addedBy: row.added_by,
    addedAt: toIso(row.added_at),
  };
}

function rowToDto(row: StandardGradeRow, evidence: EvidenceRow[]): StandardGradeResponseDto {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    standardId: row.standard_id,
    standardCode: row.standard_code,
    standardDescription: row.standard_description,
    classId: row.class_id,
    className: row.class_name,
    proficiencyLevel: row.proficiency_level,
    assessedBy: row.assessed_by,
    assessedByName: row.assessed_by_name,
    assessedAt: toIso(row.assessed_at),
    notes: row.notes,
    evidence: evidence.map(evidenceRowToDto),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * SELECT base joins:
 * - sis_students -> platform_students -> iam_person for student name
 * - sis_classes -> sis_courses for class label
 * - hr_employees -> iam_person for assessed_by name
 * - LEFT JOIN tenant cur_standards (custom standards) — when standard_id
 *   resolves to a platform standard the row's standard_code/description
 *   columns come back NULL and the StandardGradeService backfills them
 *   from platform.cur_standards_platform on the response. Same shape used
 *   by the Cycle 23 cur_unit_standards display path.
 */
const SELECT_GRADE_BASE =
  'SELECT sg.id, sg.student_id, ' +
  "(ip_s.first_name || ' ' || ip_s.last_name) AS student_name, " +
  'sg.standard_id, ' +
  'cs.code AS standard_code, ' +
  'cs.description AS standard_description, ' +
  'sg.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  'sg.proficiency_level, sg.assessed_by, ' +
  "(ip_t.first_name || ' ' || ip_t.last_name) AS assessed_by_name, " +
  'sg.assessed_at, sg.notes, sg.created_at, sg.updated_at ' +
  'FROM cls_standard_grades sg ' +
  'LEFT JOIN sis_students s ON s.id = sg.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_s ON ip_s.id = ps.person_id ' +
  'LEFT JOIN sis_classes c ON c.id = sg.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN hr_employees he ON he.id = sg.assessed_by ' +
  'LEFT JOIN platform.iam_person ip_t ON ip_t.id = he.person_id ' +
  'LEFT JOIN cur_standards cs ON cs.id = sg.standard_id ';

@Injectable()
export class StandardGradeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireEmployee(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can rate standards. The calling user has no hr_employees record.',
      );
    }
    return actor.employeeId;
  }

  /** Verify the assessor teaches the class. Admins bypass. */
  private async assertCanWriteClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can rate standards. The calling user has no hr_employees record.',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException(
        'You are not assigned to class ' + classId + ' and cannot rate standards for it.',
      );
    }
  }

  /**
   * Validate the standard_id resolves to either tenant cur_standards
   * (custom school standards) OR platform.cur_standards_platform
   * (national CCSS/NGSS catalogue) per the Cycle 23 dual-resolution
   * keystone. Mirrors cur_unit_standards.alignStandard validation.
   */
  private async assertStandardExists(standardId: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ src: string }>>(
        "SELECT 'tenant' AS src FROM cur_standards WHERE id = $1::uuid " +
          'UNION ALL ' +
          "SELECT 'platform' AS src FROM platform.cur_standards_platform WHERE id = $1::uuid " +
          'LIMIT 1',
        standardId,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException(
        'standardId does not match any standard in tenant cur_standards or platform cur_standards_platform.',
      );
    }
  }

  private async loadEvidenceForGrades(gradeIds: string[]): Promise<Map<string, EvidenceRow[]>> {
    if (gradeIds.length === 0) return new Map();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<EvidenceRow[]>(
        'SELECT id, standard_grade_id, evidence_type, evidence_ref_id, description, ' +
          'added_by, added_at FROM cls_standard_grade_evidence ' +
          'WHERE standard_grade_id = ANY($1::uuid[]) ORDER BY added_at',
        gradeIds,
      );
    });
    const map = new Map<string, EvidenceRow[]>();
    for (const r of rows) {
      const arr = map.get(r.standard_grade_id) ?? [];
      arr.push(r);
      map.set(r.standard_grade_id, arr);
    }
    return map;
  }

  /** GET /classroom/students/:studentId/standard-grades — proficiency profile across all standards. */
  async listForStudent(studentId: string): Promise<StandardGradeResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StandardGradeRow[]>(
        SELECT_GRADE_BASE + ' WHERE sg.student_id = $1::uuid ORDER BY sg.assessed_at DESC',
        studentId,
      );
    });
    const evidenceMap = await this.loadEvidenceForGrades(rows.map((r) => r.id));
    return rows.map((r) => rowToDto(r, evidenceMap.get(r.id) ?? []));
  }

  /** GET /classroom/standard-grades/:id */
  async getById(id: string): Promise<StandardGradeResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StandardGradeRow[]>(
        SELECT_GRADE_BASE + ' WHERE sg.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Standard grade ' + id + ' not found');
    const evidenceMap = await this.loadEvidenceForGrades([id]);
    return rowToDto(rows[0]!, evidenceMap.get(id) ?? []);
  }

  /**
   * POST /classroom/standard-grades — UPSERT keyed on
   * (student_id, standard_id, class_id). Re-rating the same triple
   * updates the existing row in-place — keeps the partial UNIQUE
   * INDEX honest while letting teachers iteratively re-assess.
   */
  async upsert(
    input: CreateStandardGradeDto,
    actor: ResolvedActor,
  ): Promise<StandardGradeResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.assertCanWriteClass(input.classId, actor);
    await this.assertStandardExists(input.standardId);

    // Validate student is enrolled in the class
    const enrollRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        input.classId,
        input.studentId,
      );
    });
    if (enrollRows.length === 0) {
      throw new BadRequestException(
        'Student ' + input.studentId + ' is not actively enrolled in class ' + input.classId,
      );
    }

    const newId = generateId();
    const idRows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'INSERT INTO cls_standard_grades ' +
          '(id, student_id, standard_id, class_id, proficiency_level, assessed_by, assessed_at, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, now(), $7) ' +
          'ON CONFLICT (student_id, standard_id, class_id) DO UPDATE SET ' +
          'proficiency_level = EXCLUDED.proficiency_level, ' +
          'assessed_by = EXCLUDED.assessed_by, ' +
          'assessed_at = now(), ' +
          'notes = EXCLUDED.notes, ' +
          'updated_at = now() ' +
          'RETURNING id::text AS id',
        newId,
        input.studentId,
        input.standardId,
        input.classId,
        input.proficiencyLevel,
        employeeId,
        input.notes ?? null,
      );
      return inserted;
    });
    return this.getById(idRows[0]!.id);
  }

  /** PATCH /classroom/standard-grades/:id */
  async update(
    id: string,
    input: UpdateStandardGradeDto,
    actor: ResolvedActor,
  ): Promise<StandardGradeResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ class_id: string }>>(
        'SELECT class_id::text AS class_id FROM cls_standard_grades WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Standard grade ' + id + ' not found');
      if (!actor.isSchoolAdmin) {
        const teaches = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
          rows[0]!.class_id,
          employeeId,
        );
        if (teaches.length === 0) {
          throw new ForbiddenException('You are not assigned to this class.');
        }
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.proficiencyLevel !== undefined) {
        sets.push('proficiency_level = $' + i++);
        params.push(input.proficiencyLevel);
        sets.push('assessed_by = $' + i++ + '::uuid');
        params.push(employeeId);
        sets.push('assessed_at = now()');
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + i++);
        params.push(input.notes);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE cls_standard_grades SET ' + sets.join(', ') + ' WHERE id = $' + i + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  /**
   * POST /classroom/standard-grades/:id/evidence — link evidence to a
   * proficiency rating. The schema's multi-column ref_chk requires
   * evidence_ref_id when type is SUBMISSION or ASSESSMENT.
   */
  async addEvidence(
    standardGradeId: string,
    input: AddEvidenceDto,
    actor: ResolvedActor,
  ): Promise<StandardGradeEvidenceResponseDto> {
    const employeeId = this.requireEmployee(actor);

    // Verify parent standard grade exists + caller can write the class
    const parents = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string }>>(
        'SELECT class_id::text AS class_id FROM cls_standard_grades WHERE id = $1::uuid',
        standardGradeId,
      );
    });
    if (parents.length === 0) {
      throw new NotFoundException('Standard grade ' + standardGradeId + ' not found');
    }
    await this.assertCanWriteClass(parents[0]!.class_id, actor);

    // Type-specific validation
    if (input.evidenceType === 'SUBMISSION' || input.evidenceType === 'ASSESSMENT') {
      if (!input.evidenceRefId) {
        throw new BadRequestException(
          'evidenceRefId is required for evidence_type ' + input.evidenceType + '.',
        );
      }
      const refTable = input.evidenceType === 'SUBMISSION' ? 'cls_submissions' : 'cls_grades';
      const refExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM ' + refTable + ' WHERE id = $1::uuid',
          input.evidenceRefId,
        );
      });
      if (refExists.length === 0) {
        throw new BadRequestException('evidenceRefId does not match a row in ' + refTable + '.');
      }
    }

    const newId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_standard_grade_evidence ' +
          '(id, standard_grade_id, evidence_type, evidence_ref_id, description, added_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        newId,
        standardGradeId,
        input.evidenceType,
        input.evidenceRefId ?? null,
        input.description ?? null,
        employeeId,
      );
    });

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<EvidenceRow[]>(
        'SELECT id, standard_grade_id, evidence_type, evidence_ref_id, description, ' +
          'added_by, added_at FROM cls_standard_grade_evidence WHERE id = $1::uuid',
        newId,
      );
    });
    return evidenceRowToDto(rows[0]!);
  }

  /**
   * GET /classroom/classes/:id/standards-report — class-wide proficiency
   * heatmap. Returns one row per (student, standard) cell plus aggregate
   * counts per standard for the heatmap legend.
   */
  async classReport(classId: string, actor: ResolvedActor): Promise<ClassStandardsReportDto> {
    await this.assertCanWriteClass(classId, actor);

    const cells = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          student_id: string;
          student_name: string | null;
          standard_id: string;
          standard_code: string | null;
          standard_description: string | null;
          proficiency_level: ProficiencyLevel | null;
        }>
      >(
        'SELECT sg.student_id, ' +
          "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
          'sg.standard_id, ' +
          'cs.code AS standard_code, ' +
          'cs.description AS standard_description, ' +
          'sg.proficiency_level ' +
          'FROM cls_standard_grades sg ' +
          'LEFT JOIN sis_students s ON s.id = sg.student_id ' +
          'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
          'LEFT JOIN cur_standards cs ON cs.id = sg.standard_id ' +
          'WHERE sg.class_id = $1::uuid ' +
          'ORDER BY student_name, sg.standard_id',
        classId,
      );
    });

    const className = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ name: string | null }>>(
        "SELECT (co.name || ' (' || c.section_code || ')') AS name " +
          'FROM sis_classes c LEFT JOIN sis_courses co ON co.id = c.course_id WHERE c.id = $1::uuid',
        classId,
      );
      return rows[0]?.name ?? null;
    });

    // Aggregate counts per standard
    const byStandard = new Map<
      string,
      { code: string | null; desc: string | null; counts: Record<ProficiencyLevel, number> }
    >();
    for (const cell of cells) {
      let entry = byStandard.get(cell.standard_id);
      if (!entry) {
        entry = {
          code: cell.standard_code,
          desc: cell.standard_description,
          counts: PROFICIENCY_LEVELS.reduce(
            (acc, l) => ({ ...acc, [l]: 0 }),
            {} as Record<ProficiencyLevel, number>,
          ),
        };
        byStandard.set(cell.standard_id, entry);
      }
      if (cell.proficiency_level) {
        entry.counts[cell.proficiency_level]++;
      }
    }

    return {
      classId,
      className,
      standards: Array.from(byStandard.entries()).map(([standardId, v]) => ({
        standardId,
        standardCode: v.code,
        standardDescription: v.desc,
        counts: v.counts,
      })),
      cells: cells.map((c) => ({
        studentId: c.student_id,
        studentName: c.student_name,
        standardId: c.standard_id,
        standardCode: c.standard_code,
        proficiencyLevel: c.proficiency_level,
      })),
    };
  }
}
