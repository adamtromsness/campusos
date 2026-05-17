import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreateReportCardSubjectDto,
  ReportCardSubjectResponseDto,
  UpdateReportCardSubjectDto,
} from './dto/report-card-subject.dto';

interface SubjectRow {
  id: string;
  report_card_id: string;
  subject_label: string;
  course_id: string | null;
  course_name: string | null;
  final_grade: string | null;
  grade_value: string | null;
  teacher_comments: string | null;
  effort_grade: string | null;
  sort_order: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: SubjectRow): ReportCardSubjectResponseDto {
  return {
    id: row.id,
    reportCardId: row.report_card_id,
    subjectLabel: row.subject_label,
    courseId: row.course_id,
    courseName: row.course_name,
    finalGrade: row.final_grade,
    gradeValue: row.grade_value === null ? null : Number(row.grade_value),
    teacherComments: row.teacher_comments,
    effortGrade: row.effort_grade,
    sortOrder: row.sort_order,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_BASE =
  'SELECT s.id, s.report_card_id, s.subject_label, s.course_id, ' +
  'co.name AS course_name, s.final_grade, s.grade_value, s.teacher_comments, ' +
  's.effort_grade, s.sort_order, s.created_at, s.updated_at ' +
  'FROM cls_report_card_subjects s ' +
  'LEFT JOIN sis_courses co ON co.id = s.course_id ';

@Injectable()
export class ReportCardSubjectService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** Verify the calling actor can write the parent report card. */
  private async assertCanWriteReportCard(
    reportCardId: string,
    actor: ResolvedActor,
  ): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string }>>(
        'SELECT class_id::text AS class_id FROM cls_report_cards WHERE id = $1::uuid',
        reportCardId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Report card ' + reportCardId + ' not found');
    }
    if (actor.isSchoolAdmin) return;
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can author report card subjects. The calling user has no hr_employees record.',
      );
    }
    const teaches = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        rows[0]!.class_id,
        actor.employeeId,
      );
    });
    if (teaches.length === 0) {
      throw new ForbiddenException('You are not assigned to the class for this report card.');
    }
  }

  /** GET /classroom/report-cards/:id/subjects */
  async listForReportCard(reportCardId: string): Promise<ReportCardSubjectResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubjectRow[]>(
        SELECT_BASE + ' WHERE s.report_card_id = $1::uuid ORDER BY s.sort_order, s.subject_label',
        reportCardId,
      );
    });
    return rows.map(rowToDto);
  }

  /** GET /classroom/report-card-subjects/:id */
  async getById(id: string): Promise<ReportCardSubjectResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubjectRow[]>(SELECT_BASE + ' WHERE s.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Report card subject ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /** POST /classroom/report-cards/:id/subjects */
  async create(
    reportCardId: string,
    input: CreateReportCardSubjectDto,
    actor: ResolvedActor,
  ): Promise<ReportCardSubjectResponseDto> {
    await this.assertCanWriteReportCard(reportCardId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_report_card_subjects ' +
          '(id, report_card_id, subject_label, course_id, final_grade, grade_value, ' +
          'teacher_comments, effort_grade, sort_order) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7, $8, $9::int)',
        id,
        reportCardId,
        input.subjectLabel,
        input.courseId ?? null,
        input.finalGrade ?? null,
        input.gradeValue ?? null,
        input.teacherComments ?? null,
        input.effortGrade ?? null,
        input.sortOrder ?? 0,
      );
    });
    return this.getById(id);
  }

  /** PATCH /classroom/report-card-subjects/:id */
  async update(
    id: string,
    input: UpdateReportCardSubjectDto,
    actor: ResolvedActor,
  ): Promise<ReportCardSubjectResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ report_card_id: string }>>(
        'SELECT report_card_id::text AS report_card_id ' +
          'FROM cls_report_card_subjects WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) {
        throw new NotFoundException('Report card subject ' + id + ' not found');
      }
      await this.assertCanWriteReportCard(rows[0]!.report_card_id, actor);
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.subjectLabel !== undefined) {
        sets.push('subject_label = $' + i++);
        params.push(input.subjectLabel);
      }
      if (input.courseId !== undefined) {
        sets.push('course_id = $' + i++ + '::uuid');
        params.push(input.courseId);
      }
      if (input.finalGrade !== undefined) {
        sets.push('final_grade = $' + i++);
        params.push(input.finalGrade);
      }
      if (input.gradeValue !== undefined) {
        sets.push('grade_value = $' + i++ + '::numeric');
        params.push(input.gradeValue);
      }
      if (input.teacherComments !== undefined) {
        sets.push('teacher_comments = $' + i++);
        params.push(input.teacherComments);
      }
      if (input.effortGrade !== undefined) {
        sets.push('effort_grade = $' + i++);
        params.push(input.effortGrade);
      }
      if (input.sortOrder !== undefined) {
        sets.push('sort_order = $' + i++ + '::int');
        params.push(input.sortOrder);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE cls_report_card_subjects SET ' + sets.join(', ') + ' WHERE id = $' + i + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  /** DELETE /classroom/report-card-subjects/:id */
  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ report_card_id: string }>>(
        'SELECT report_card_id::text AS report_card_id ' +
          'FROM cls_report_card_subjects WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) {
        throw new NotFoundException('Report card subject ' + id + ' not found');
      }
      await this.assertCanWriteReportCard(rows[0]!.report_card_id, actor);
      await tx.$executeRawUnsafe('DELETE FROM cls_report_card_subjects WHERE id = $1::uuid', id);
    });
  }
}
