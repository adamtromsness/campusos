import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  type AssessmentType,
  CreateFormativeAssessmentDto,
  FormativeAssessmentResponseDto,
  FormativeQuestionInputDto,
  FormativeResponseRowDto,
  FormativeResultsDto,
  SubmitFormativeResponseDto,
  UpdateFormativeAssessmentDto,
} from './dto/formative-assessment.dto';

interface AssessmentRow {
  id: string;
  class_id: string;
  class_name: string | null;
  title: string;
  assessment_type: AssessmentType;
  questions: unknown;
  is_active: boolean;
  activated_at: Date | string | null;
  closed_at: Date | string | null;
  created_by: string;
  created_by_name: string | null;
  response_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ResponseRow {
  id: string;
  assessment_id: string;
  student_id: string;
  student_name: string | null;
  responses: unknown;
  submitted_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: AssessmentRow): FormativeAssessmentResponseDto {
  return {
    id: row.id,
    classId: row.class_id,
    className: row.class_name,
    title: row.title,
    assessmentType: row.assessment_type,
    questions: Array.isArray(row.questions) ? (row.questions as FormativeQuestionInputDto[]) : [],
    isActive: row.is_active,
    activatedAt: toIso(row.activated_at),
    closedAt: toIso(row.closed_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    responseCount: Number(row.response_count),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function responseRowToDto(row: ResponseRow): FormativeResponseRowDto {
  return {
    id: row.id,
    assessmentId: row.assessment_id,
    studentId: row.student_id,
    studentName: row.student_name,
    responses:
      typeof row.responses === 'object' && row.responses !== null
        ? (row.responses as Record<string, unknown>)
        : {},
    submittedAt: toIso(row.submitted_at) ?? '',
  };
}

const SELECT_ASSESSMENT_BASE =
  'SELECT fa.id, fa.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  'fa.title, fa.assessment_type, fa.questions, fa.is_active, ' +
  'fa.activated_at, fa.closed_at, fa.created_by, ' +
  "(ip.first_name || ' ' || ip.last_name) AS created_by_name, " +
  '(SELECT count(*)::int FROM cls_formative_responses r WHERE r.assessment_id = fa.id) AS response_count, ' +
  'fa.created_at, fa.updated_at ' +
  'FROM cls_formative_assessments fa ' +
  'LEFT JOIN sis_classes c ON c.id = fa.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN hr_employees he ON he.id = fa.created_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = he.person_id ';

const SELECT_RESPONSE_BASE =
  'SELECT r.id, r.assessment_id, r.student_id, ' +
  "(ip.first_name || ' ' || ip.last_name) AS student_name, " +
  'r.responses, r.submitted_at ' +
  'FROM cls_formative_responses r ' +
  'LEFT JOIN sis_students s ON s.id = r.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = ps.person_id ';

@Injectable()
export class FormativeAssessmentService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireEmployee(actor: ResolvedActor): string {
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only teachers can manage formative assessments. The calling user has no hr_employees record.',
      );
    }
    return actor.employeeId;
  }

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
      throw new ForbiddenException('Only teachers can manage formative assessments.');
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
        'You are not assigned to class ' +
          classId +
          ' and cannot manage its formative assessments.',
      );
    }
  }

  private async resolveStudentSelfId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid',
        actor.personId,
      );
    });
    return rows[0]?.id ?? null;
  }

  /** GET /classroom/classes/:id/formative-assessments */
  async listForClass(
    classId: string,
    actor: ResolvedActor,
  ): Promise<FormativeAssessmentResponseDto[]> {
    // For students: only ACTIVE assessments visible.
    const where =
      actor.isSchoolAdmin || actor.personType === 'STAFF'
        ? ' WHERE fa.class_id = $1::uuid'
        : ' WHERE fa.class_id = $1::uuid AND fa.is_active = true';

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssessmentRow[]>(
        SELECT_ASSESSMENT_BASE + where + ' ORDER BY fa.created_at DESC',
        classId,
      );
    });
    return rows.map(rowToDto);
  }

  /** GET /classroom/formative-assessments/:id */
  async getById(id: string): Promise<FormativeAssessmentResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssessmentRow[]>(
        SELECT_ASSESSMENT_BASE + ' WHERE fa.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Formative assessment ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /** POST /classroom/formative-assessments */
  async create(
    input: CreateFormativeAssessmentDto,
    actor: ResolvedActor,
  ): Promise<FormativeAssessmentResponseDto> {
    const employeeId = this.requireEmployee(actor);
    await this.assertCanWriteClass(input.classId, actor);

    if (input.questions.length === 0) {
      throw new BadRequestException('questions array must contain at least one question.');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_formative_assessments ' +
          '(id, class_id, created_by, title, assessment_type, questions, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, false)',
        id,
        input.classId,
        employeeId,
        input.title,
        input.assessmentType,
        JSON.stringify(input.questions),
      );
    });
    return this.getById(id);
  }

  /** PATCH /classroom/formative-assessments/:id — refused once activated. */
  async update(
    id: string,
    input: UpdateFormativeAssessmentDto,
    actor: ResolvedActor,
  ): Promise<FormativeAssessmentResponseDto> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ class_id: string; created_by: string; is_active: boolean }>
      >(
        'SELECT class_id::text AS class_id, created_by::text AS created_by, is_active ' +
          'FROM cls_formative_assessments WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0)
        throw new NotFoundException('Formative assessment ' + id + ' not found');
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.created_by !== actor.employeeId) {
        throw new ForbiddenException(
          'Only the authoring teacher or an admin can update an assessment.',
        );
      }
      if (row.is_active) {
        throw new BadRequestException(
          'Cannot edit an active assessment. Close it first via PATCH /:id/close.',
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (input.title !== undefined) {
        sets.push('title = $' + i++);
        params.push(input.title);
      }
      if (input.questions !== undefined) {
        if (input.questions.length === 0) {
          throw new BadRequestException('questions array must contain at least one question.');
        }
        sets.push('questions = $' + i++ + '::jsonb');
        params.push(JSON.stringify(input.questions));
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE cls_formative_assessments SET ' + sets.join(', ') + ' WHERE id = $' + i + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  /** PATCH /classroom/formative-assessments/:id/activate — opens for student responses. */
  async activate(id: string, actor: ResolvedActor): Promise<FormativeAssessmentResponseDto> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ class_id: string; created_by: string; is_active: boolean; closed_at: Date | null }>
      >(
        'SELECT class_id::text AS class_id, created_by::text AS created_by, is_active, closed_at ' +
          'FROM cls_formative_assessments WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0)
        throw new NotFoundException('Formative assessment ' + id + ' not found');
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.created_by !== actor.employeeId) {
        throw new ForbiddenException(
          'Only the authoring teacher or an admin can activate an assessment.',
        );
      }
      if (row.is_active) {
        throw new BadRequestException('Assessment is already active.');
      }
      if (row.closed_at !== null) {
        throw new BadRequestException(
          'Assessment is closed and cannot be reactivated. Create a new one instead.',
        );
      }
      // Multi-column active_chk requires activated_at NOT NULL + closed_at NULL on activation
      await tx.$executeRawUnsafe(
        'UPDATE cls_formative_assessments SET is_active = true, activated_at = now(), ' +
          'closed_at = NULL, updated_at = now() WHERE id = $1::uuid',
        id,
      );
    });
    return this.getById(id);
  }

  /** PATCH /classroom/formative-assessments/:id/close */
  async close(id: string, actor: ResolvedActor): Promise<FormativeAssessmentResponseDto> {
    this.requireEmployee(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ created_by: string; is_active: boolean }>>(
        'SELECT created_by::text AS created_by, is_active ' +
          'FROM cls_formative_assessments WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0)
        throw new NotFoundException('Formative assessment ' + id + ' not found');
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.created_by !== actor.employeeId) {
        throw new ForbiddenException(
          'Only the authoring teacher or an admin can close an assessment.',
        );
      }
      if (!row.is_active) {
        throw new BadRequestException('Assessment is not active.');
      }
      await tx.$executeRawUnsafe(
        'UPDATE cls_formative_assessments SET is_active = false, closed_at = now(), ' +
          'updated_at = now() WHERE id = $1::uuid',
        id,
      );
    });
    return this.getById(id);
  }

  /** POST /classroom/formative-assessments/:id/respond — student submits. */
  async submitResponse(
    id: string,
    input: SubmitFormativeResponseDto,
    actor: ResolvedActor,
  ): Promise<FormativeResponseRowDto> {
    if (actor.personType !== 'STUDENT' && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only enrolled students or admins can submit formative responses.',
      );
    }
    const studentId =
      actor.isSchoolAdmin && actor.personType !== 'STUDENT'
        ? null
        : await this.resolveStudentSelfId(actor);
    if (!studentId && !actor.isSchoolAdmin) {
      throw new ForbiddenException('Could not resolve student identity for the calling user.');
    }
    if (!studentId) {
      throw new BadRequestException(
        'Admin-on-behalf submissions require a STUDENT actor — synthetic admin cannot submit.',
      );
    }

    // Verify assessment is active + student is enrolled in the class
    const cfg = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string; is_active: boolean }>>(
        'SELECT class_id::text AS class_id, is_active FROM cls_formative_assessments WHERE id = $1::uuid',
        id,
      );
    });
    if (cfg.length === 0) {
      throw new NotFoundException('Formative assessment ' + id + ' not found');
    }
    if (!cfg[0]!.is_active) {
      throw new BadRequestException('Assessment is not currently active.');
    }
    const enrolled = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_enrollments ' +
          "WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        cfg[0]!.class_id,
        studentId,
      );
    });
    if (enrolled.length === 0) {
      throw new ForbiddenException('Student is not actively enrolled in the class.');
    }

    const newId = generateId();
    const idRows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'INSERT INTO cls_formative_responses (id, assessment_id, student_id, responses) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb) ' +
          'ON CONFLICT (assessment_id, student_id) DO UPDATE SET ' +
          'responses = EXCLUDED.responses, submitted_at = now(), updated_at = now() ' +
          'RETURNING id::text AS id',
        newId,
        id,
        studentId,
        JSON.stringify(input.responses),
      );
      return inserted;
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ResponseRow[]>(
        SELECT_RESPONSE_BASE + ' WHERE r.id = $1::uuid',
        idRows[0]!.id,
      );
    });
    return responseRowToDto(rows[0]!);
  }

  /** GET /classroom/formative-assessments/:id/results — teacher real-time aggregate. */
  async getResults(id: string, actor: ResolvedActor): Promise<FormativeResultsDto> {
    const cfg = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ class_id: string; questions: unknown }>>(
        'SELECT class_id::text AS class_id, questions ' +
          'FROM cls_formative_assessments WHERE id = $1::uuid',
        id,
      );
    });
    if (cfg.length === 0) {
      throw new NotFoundException('Formative assessment ' + id + ' not found');
    }
    await this.assertCanWriteClass(cfg[0]!.class_id, actor);

    const responses = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ResponseRow[]>(
        SELECT_RESPONSE_BASE + ' WHERE r.assessment_id = $1::uuid ORDER BY r.submitted_at DESC',
        id,
      );
    });

    const questions: FormativeQuestionInputDto[] = Array.isArray(cfg[0]!.questions)
      ? (cfg[0]!.questions as FormativeQuestionInputDto[])
      : [];

    const summaries = questions.map((q) => {
      const counts: Record<string, number> = {};
      const samples: string[] = [];
      for (const r of responses) {
        const responseMap = (r.responses ?? {}) as Record<string, unknown>;
        const ans = responseMap[q.questionId];
        if (ans === undefined || ans === null) continue;
        const key = typeof ans === 'string' ? ans : JSON.stringify(ans);
        counts[key] = (counts[key] ?? 0) + 1;
        if (samples.length < 5 && typeof ans === 'string') {
          samples.push(ans);
        }
      }
      return {
        questionId: q.questionId,
        prompt: q.prompt,
        responseCounts: counts,
        sampleResponses: samples,
      };
    });

    return {
      assessmentId: id,
      totalResponses: responses.length,
      questionSummaries: summaries,
      responses: responses.map(responseRowToDto),
    };
  }
}
