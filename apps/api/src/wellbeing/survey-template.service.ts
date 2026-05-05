import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  AddQuestionDto,
  CreateSurveyTemplateDto,
  FrequencyRecommendation,
  QuestionType,
  SurveyTemplateResponseDto,
  UpdateQuestionDto,
  UpdateSurveyTemplateDto,
  WellbeingDomain,
  WellbeingQuestionResponseDto,
} from './dto/wellbeing.dto';

interface TemplateRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  frequency_recommendation: string;
  is_active: boolean;
  created_by: string;
  creator_first: string | null;
  creator_last: string | null;
  created_at: string;
  updated_at: string;
}

interface QuestionRow {
  id: string;
  template_id: string;
  question_text: string;
  question_type: string;
  domain: string;
  sort_order: number;
}

const SELECT_TEMPLATE_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.name, t.description, ' +
  't.frequency_recommendation, t.is_active, ' +
  't.created_by::text AS created_by, ' +
  'cp.first_name AS creator_first, cp.last_name AS creator_last, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_wellbeing_survey_templates t ' +
  'LEFT JOIN hr_employees ce ON ce.id = t.created_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

const SELECT_QUESTION_BASE =
  'SELECT q.id::text AS id, q.template_id::text AS template_id, ' +
  'q.question_text, q.question_type, q.domain, q.sort_order ' +
  'FROM svc_wellbeing_questions q ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToTemplateDto(r: TemplateRow): SurveyTemplateResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    frequencyRecommendation: r.frequency_recommendation as FrequencyRecommendation,
    isActive: r.is_active,
    createdById: r.created_by,
    createdByName: fullName(r.creator_first, r.creator_last),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToQuestionDto(r: QuestionRow): WellbeingQuestionResponseDto {
  return {
    id: r.id,
    templateId: r.template_id,
    questionText: r.question_text,
    questionType: r.question_type as QuestionType,
    domain: r.domain as WellbeingDomain,
    sortOrder: r.sort_order,
  };
}

@Injectable()
export class SurveyTemplateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-004:write — the canonical
   * counsellor signal for the wellbeing surface. The IAM seed grants
   * cou-004:write only to Staff (covering counsellor, VP, admin
   * assistant) so the service can use it as a single test in lieu of
   * checking each non-counsellor STAFF role individually.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-004:write',
    ]);
  }

  async list(includeInactive = false): Promise<SurveyTemplateResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_TEMPLATE_BASE, 'WHERE t.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (!includeInactive) sql.push('AND t.is_active = true ');
    sql.push('ORDER BY t.created_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TemplateRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToTemplateDto);
  }

  async getById(id: string): Promise<SurveyTemplateResponseDto> {
    const dto = await this.loadOrFail(id);
    const questions = await this.listQuestions(id);
    return { ...dto, questions };
  }

  async listQuestions(templateId: string): Promise<WellbeingQuestionResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<QuestionRow[]>(
        SELECT_QUESTION_BASE +
          'WHERE q.template_id = $1::uuid ORDER BY q.sort_order ASC, q.created_at ASC',
        templateId,
      );
    });
    return rows.map(rowToQuestionDto);
  }

  /**
   * Create template + questions in one tenant tx. Counsellor or admin
   * only. UNIQUE(school_id, name) catch surfaces the conflict as a
   * friendly 400.
   */
  async create(
    input: CreateSurveyTemplateDto,
    actor: ResolvedActor,
  ): Promise<SurveyTemplateResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can create wellbeing survey templates',
      );
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Survey template author must have an employee record');
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_wellbeing_survey_templates (id, school_id, name, description, frequency_recommendation, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, $6::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.frequencyRecommendation,
          actor.employeeId,
        );
        for (const q of input.questions) {
          await tx.$executeRawUnsafe(
            'INSERT INTO svc_wellbeing_questions (id, template_id, question_text, question_type, domain, sort_order) ' +
              'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
            generateId(),
            id,
            q.questionText,
            q.questionType,
            q.domain,
            q.sortOrder,
          );
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A wellbeing survey template named "' + input.name + '" already exists in this school',
        );
      }
      throw err;
    }

    return this.getById(id);
  }

  /**
   * Update template metadata. Locks the row inside one tenant tx. The
   * is_active flag is the canonical soft-deactivate path — the schema
   * NO ACTION FK from svc_wellbeing_deployments.template_id refuses a
   * hard-delete while any deployment references the template.
   */
  async patch(
    id: string,
    input: UpdateSurveyTemplateDto,
    actor: ResolvedActor,
  ): Promise<SurveyTemplateResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can update wellbeing survey templates',
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM svc_wellbeing_survey_templates WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Survey template ' + id);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.name !== undefined) {
        updates.push('name = $' + idx);
        params.push(input.name);
        idx++;
      }
      if (input.description !== undefined) {
        updates.push('description = $' + idx);
        params.push(input.description);
        idx++;
      }
      if (input.frequencyRecommendation !== undefined) {
        updates.push('frequency_recommendation = $' + idx);
        params.push(input.frequencyRecommendation);
        idx++;
      }
      if (input.isActive !== undefined) {
        updates.push('is_active = $' + idx);
        params.push(input.isActive);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      try {
        await tx.$executeRawUnsafe(
          'UPDATE svc_wellbeing_survey_templates SET ' +
            updates.join(', ') +
            ' WHERE id = $1::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A wellbeing survey template with that name already exists in this school',
          );
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  /**
   * Append a new question to an existing template. The template's
   * questions are ordered by sort_order — callers are responsible for
   * choosing a sort_order that fits their intended position.
   */
  async addQuestion(
    templateId: string,
    input: AddQuestionDto,
    actor: ResolvedActor,
  ): Promise<WellbeingQuestionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can add wellbeing survey questions');
    }
    await this.assertTemplateExists(templateId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_wellbeing_questions (id, template_id, question_text, question_type, domain, sort_order) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
        id,
        templateId,
        input.questionText,
        input.questionType,
        input.domain,
        input.sortOrder,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<QuestionRow[]>(
        SELECT_QUESTION_BASE + 'WHERE q.id = $1::uuid',
        id,
      );
    });
    return rowToQuestionDto(rows[0]!);
  }

  async patchQuestion(
    questionId: string,
    input: UpdateQuestionDto,
    actor: ResolvedActor,
  ): Promise<WellbeingQuestionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can update wellbeing survey questions',
      );
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const updates: string[] = [];
      const params: unknown[] = [questionId];
      let idx = 2;
      if (input.questionText !== undefined) {
        updates.push('question_text = $' + idx);
        params.push(input.questionText);
        idx++;
      }
      if (input.questionType !== undefined) {
        updates.push('question_type = $' + idx);
        params.push(input.questionType);
        idx++;
      }
      if (input.domain !== undefined) {
        updates.push('domain = $' + idx);
        params.push(input.domain);
        idx++;
      }
      if (input.sortOrder !== undefined) {
        updates.push('sort_order = $' + idx);
        params.push(input.sortOrder);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      const r = await client.$executeRawUnsafe(
        'UPDATE svc_wellbeing_questions SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
      if (r === 0) throw new NotFoundException('Wellbeing question ' + questionId);
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<QuestionRow[]>(
        SELECT_QUESTION_BASE + 'WHERE q.id = $1::uuid',
        questionId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Wellbeing question ' + questionId);
    return rowToQuestionDto(rows[0]!);
  }

  /**
   * Delete a question. Refused with a friendly 400 when any response
   * references the question — the schema-side NO ACTION FK on
   * svc_wellbeing_responses.question_id is the safety net but the
   * service-layer pre-check provides a better error message.
   */
  async deleteQuestion(questionId: string, actor: ResolvedActor): Promise<void> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can delete wellbeing survey questions',
      );
    }
    const refs = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ c: number }>>(
        'SELECT count(*)::int AS c FROM svc_wellbeing_responses WHERE question_id = $1::uuid',
        questionId,
      );
    })) as Array<{ c: number }>;
    if (refs.length > 0 && refs[0]!.c > 0) {
      throw new BadRequestException(
        'Cannot delete a question with ' +
          refs[0]!.c +
          ' existing response(s). Deactivate the parent template instead via PATCH /templates/:id with isActive=false.',
      );
    }
    const r = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM svc_wellbeing_questions WHERE id = $1::uuid',
        questionId,
      );
    });
    if (r === 0) throw new NotFoundException('Wellbeing question ' + questionId);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<SurveyTemplateResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TemplateRow[]>(
        SELECT_TEMPLATE_BASE + 'WHERE t.id = $1::uuid AND t.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Survey template ' + id);
    return rowToTemplateDto(rows[0]!);
  }

  /**
   * Public helper for DeploymentService — resolves a template id to
   * its full DTO + question list. Used at deployment-create time to
   * validate the template exists in this tenant + at activate time to
   * stamp question references.
   */
  async loadActiveOrFail(id: string): Promise<SurveyTemplateResponseDto> {
    const dto = await this.loadOrFail(id);
    if (!dto.isActive) {
      throw new BadRequestException(
        'Survey template "' + dto.name + '" is inactive. Reactivate it before deploying.',
      );
    }
    const questions = await this.listQuestions(id);
    if (questions.length === 0) {
      throw new BadRequestException(
        'Survey template "' + dto.name + '" has no questions. Add questions before deploying.',
      );
    }
    return { ...dto, questions };
  }

  private async assertTemplateExists(id: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM svc_wellbeing_survey_templates WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Survey template ' + id);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
