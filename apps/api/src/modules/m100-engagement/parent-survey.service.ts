import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import { assertEngagementAdmin, isUniqueViolation } from './access';
import { deterministicSurveyOpenedEventId } from './event-ids';
import type {
  CreateSurveyDto,
  SubmitSurveyResponseDto,
  SurveyDto,
  SurveyQuestion,
  SurveyQuestionType,
  SurveyStatus,
  UpdateSurveyDto,
} from './dto/engagement.dto';

interface SurveyRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  questions: unknown;
  is_anonymous: boolean;
  opens_at: string | null;
  closes_at: string | null;
  status: string;
  total_responses: number;
  response_data_aggregated: unknown;
  responses: unknown;
  created_by: string;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const ALLOWED_TRANSITIONS: Record<SurveyStatus, SurveyStatus[]> = {
  DRAFT: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: [],
};

@Injectable()
export class ParentSurveyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private toDto(row: SurveyRow): SurveyDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      title: row.title,
      description: row.description,
      questions: parseJsonArray(row.questions) as SurveyQuestion[],
      isAnonymous: Boolean(row.is_anonymous),
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      status: row.status as SurveyStatus,
      totalResponses: Number(row.total_responses),
      responseDataAggregated: parseJsonObject(row.response_data_aggregated),
      createdBy: row.created_by,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private surveySelectSql(): string {
    return `SELECT id::text AS id, school_id::text AS school_id, title, description,
                   questions, is_anonymous,
                   opens_at::text AS opens_at, closes_at::text AS closes_at,
                   status, total_responses, response_data_aggregated, responses,
                   created_by::text AS created_by,
                   opened_at::text AS opened_at, closed_at::text AS closed_at,
                   created_at::text AS created_at, updated_at::text AS updated_at
            FROM eng_parent_surveys`;
  }

  async list(actor: ResolvedActor): Promise<SurveyDto[]> {
    const tenant = getCurrentTenant();
    const isStaff = actor.isSchoolAdmin || actor.personType === 'STAFF';
    const args: unknown[] = [tenant.schoolId];
    let where = ' WHERE school_id = $1::uuid';
    if (!isStaff) {
      // Non-staff sees only OPEN surveys
      where += " AND status = 'OPEN'";
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.surveySelectSql() + where + ' ORDER BY created_at DESC',
        ...args,
      );
    })) as SurveyRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<SurveyDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.surveySelectSql() + ' WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
    })) as SurveyRow[];
    if (rows.length === 0) {
      throw new NotFoundException(`Survey ${id} not found`);
    }
    const row = rows[0]!;
    const isStaff = actor.isSchoolAdmin || actor.personType === 'STAFF';
    if (!isStaff && row.status !== 'OPEN') {
      throw new NotFoundException(`Survey ${id} not found`);
    }
    return this.toDto(row);
  }

  /**
   * Admin: full aggregated results. Includes per-question aggregates
   * but NEVER individual responses (the response array is filtered
   * out at the API boundary regardless of is_anonymous).
   */
  async getResults(actor: ResolvedActor, id: string): Promise<SurveyDto> {
    await assertEngagementAdmin(actor, this.permCheck, 'Reading survey results');
    return this.getById(actor, id);
  }

  async create(actor: ResolvedActor, input: CreateSurveyDto): Promise<SurveyDto> {
    await assertEngagementAdmin(actor, this.permCheck, 'Creating a survey');
    const tenant = getCurrentTenant();

    if (!Array.isArray(input.questions) || input.questions.length === 0) {
      throw new BadRequestException('Survey must include at least one question');
    }
    // Validate question shape + unique ids
    const seen = new Set<string>();
    for (const q of input.questions) {
      if (!q.id || !q.question_text || !q.question_type) {
        throw new BadRequestException(
          'Each question must include id, question_text, and question_type',
        );
      }
      if (seen.has(q.id)) {
        throw new BadRequestException(`Duplicate question id: ${q.id}`);
      }
      seen.add(q.id);
      if (q.question_type === 'MULTIPLE_CHOICE') {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          throw new BadRequestException(
            `MULTIPLE_CHOICE question ${q.id} must include at least 2 options`,
          );
        }
      }
    }
    if (input.opensAt && input.closesAt && new Date(input.closesAt) <= new Date(input.opensAt)) {
      throw new BadRequestException('closesAt must be after opensAt');
    }

    const id = generateId();
    const isAnonymous = input.isAnonymous ?? true;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          `INSERT INTO eng_parent_surveys
             (id, school_id, title, description, questions, is_anonymous,
              opens_at, closes_at, status, total_responses,
              response_data_aggregated, responses, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6,
                   $7::timestamptz, $8::timestamptz, 'DRAFT', 0,
                   $9::jsonb, $10::jsonb, $11::uuid)`,
          id,
          tenant.schoolId,
          input.title.trim(),
          input.description ?? null,
          JSON.stringify(input.questions),
          isAnonymous,
          input.opensAt ?? null,
          input.closesAt ?? null,
          JSON.stringify({}),
          JSON.stringify([]),
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Survey already exists');
      }
      throw err;
    }
    return this.getById(actor, id);
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateSurveyDto): Promise<SurveyDto> {
    await assertEngagementAdmin(actor, this.permCheck, 'Updating a survey');
    const tenant = getCurrentTenant();
    const tenantSubdomain = tenant.subdomain;
    let emitOpened = false;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        `SELECT status, opens_at::text AS opens_at, closes_at::text AS closes_at
         FROM eng_parent_surveys
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ status: string; opens_at: string | null; closes_at: string | null }>;
      if (locked.length === 0) {
        throw new NotFoundException(`Survey ${id} not found`);
      }
      const before = locked[0]!;
      if (input.status && input.status !== before.status) {
        const allowed = ALLOWED_TRANSITIONS[before.status as SurveyStatus] ?? [];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            `Cannot transition survey from ${before.status} to ${input.status}. Allowed: ${allowed.join(', ') || 'none'}`,
          );
        }
      }

      const opensAt = input.opensAt ?? before.opens_at;
      const closesAt = input.closesAt ?? before.closes_at;
      if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
        throw new BadRequestException('closesAt must be after opensAt');
      }

      const fields: string[] = [];
      const args: unknown[] = [];
      let pos = 1;
      const push = (col: string, val: unknown, cast?: string): void => {
        const ph = '$' + pos + (cast ? '::' + cast : '');
        fields.push(`${col} = ${ph}`);
        args.push(val);
        pos += 1;
      };
      if (input.title !== undefined) push('title', input.title.trim());
      if (input.description !== undefined) push('description', input.description);
      if (input.questions !== undefined) {
        push('questions', JSON.stringify(input.questions), 'jsonb');
      }
      if (input.opensAt !== undefined) push('opens_at', input.opensAt, 'timestamptz');
      if (input.closesAt !== undefined) push('closes_at', input.closesAt, 'timestamptz');
      if (input.status !== undefined) {
        push('status', input.status);
        if (input.status === 'OPEN' && before.status === 'DRAFT') {
          fields.push('opened_at = COALESCE(opened_at, now())');
          emitOpened = true;
        }
        if (input.status === 'CLOSED' && before.status !== 'CLOSED') {
          fields.push('closed_at = now()');
        }
      }
      fields.push('updated_at = now()');

      if (fields.length === 1) return;

      args.push(tenant.schoolId, id);
      const sql =
        'UPDATE eng_parent_surveys SET ' +
        fields.join(', ') +
        ` WHERE school_id = $${pos}::uuid AND id = $${pos + 1}::uuid`;
      await tx.$executeRawUnsafe(sql, ...args);

      if (emitOpened) {
        await this.outbox.enqueueInTx(tx, {
          topic: 'eng.survey.opened',
          payload: {
            surveyId: id,
            schoolId: tenant.schoolId,
            sourceRefId: id,
          },
          sourceModule: 'engagement',
          eventId: deterministicSurveyOpenedEventId(id),
          tenantId: tenant.schoolId,
          tenantSubdomain,
          key: id,
        });
      }
    });
    return this.getById(actor, id);
  }

  /**
   * THE ANONYMITY KEYSTONE.
   *
   * When the survey is_anonymous=true, respondent_id is NEVER stored
   * on the response row. When false, respondent_id is recorded.
   * Aggregated rollups are recomputed on every submission so the
   * results dashboard never has to walk the full responses array.
   */
  async submitResponse(
    actor: ResolvedActor,
    id: string,
    input: SubmitSurveyResponseDto,
  ): Promise<{ submitted: true; totalResponses: number }> {
    if (actor.personType === 'STUDENT') {
      throw new ForbiddenException('Students cannot submit parent surveys');
    }
    const tenant = getCurrentTenant();

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status, is_anonymous, questions,
                response_data_aggregated, responses, total_responses
         FROM eng_parent_surveys
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{
        id: string;
        status: string;
        is_anonymous: boolean;
        questions: unknown;
        response_data_aggregated: unknown;
        responses: unknown;
        total_responses: number;
      }>;
      if (rows.length === 0) throw new NotFoundException(`Survey ${id} not found`);
      const row = rows[0]!;
      if (row.status !== 'OPEN') {
        throw new BadRequestException('Survey is not open for responses');
      }

      const questions = parseJsonArray(row.questions) as SurveyQuestion[];
      const responses = parseJsonArray(row.responses) ?? [];

      // Validate every answer maps to a known question
      const questionMap = new Map<string, SurveyQuestion>();
      for (const q of questions) questionMap.set(q.id, q);

      const cleanedAnswers: Record<string, unknown> = {};
      for (const [qid, answer] of Object.entries(input.answers)) {
        const q = questionMap.get(qid);
        if (!q) {
          throw new BadRequestException(`Unknown question id: ${qid}`);
        }
        cleanedAnswers[qid] = validateAnswer(q.question_type, answer);
      }

      // REVIEW-P2C24 MAJOR 1 — identified-survey deduplication.
      // Identified surveys (is_anonymous=false) enforce one response
      // per respondent — duplicate submissions return 409. Anonymous
      // surveys allow multiple submissions by design: there is no
      // respondent_id stored, so we cannot distinguish a re-submit from
      // a different parent, and adding a rate-limit token strategy
      // would compromise anonymity. Documented in P2C24-REVIEW-NOTES.
      if (!row.is_anonymous) {
        const existing = (responses as Array<Record<string, unknown>>).find(
          (r) => r && typeof r === 'object' && r.respondent_id === actor.accountId,
        );
        if (existing) {
          throw new ConflictException(
            'You have already submitted a response to this survey. Identified surveys accept one response per respondent.',
          );
        }
      }

      // Build response row — STRICT contract: when is_anonymous, no
      // respondent_id is stored. When identified, store the parent's
      // accountId.
      const responseRow: Record<string, unknown> = {
        submitted_at: new Date().toISOString(),
        answers: cleanedAnswers,
      };
      if (!row.is_anonymous) {
        responseRow.respondent_id = actor.accountId;
      }

      const newResponses = [...(responses as unknown[]), responseRow];
      const newAggregated = recomputeAggregates(
        questions,
        newResponses as Array<{ answers: Record<string, unknown> }>,
      );
      const newTotal = Number(row.total_responses) + 1;

      await tx.$executeRawUnsafe(
        `UPDATE eng_parent_surveys
         SET responses = $1::jsonb,
             response_data_aggregated = $2::jsonb,
             total_responses = $3,
             updated_at = now()
         WHERE school_id = $4::uuid AND id = $5::uuid`,
        JSON.stringify(newResponses),
        JSON.stringify(newAggregated),
        newTotal,
        tenant.schoolId,
        id,
      );

      return { totalResponses: newTotal };
    });
    return { submitted: true, totalResponses: result.totalResponses };
  }
}

function parseJsonArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function validateAnswer(type: SurveyQuestionType, answer: unknown): unknown {
  if (type === 'RATING_1_5') {
    const n = typeof answer === 'number' ? answer : Number(answer);
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      throw new BadRequestException('RATING_1_5 must be 1..5');
    }
    return n;
  }
  if (type === 'RATING_1_10') {
    const n = typeof answer === 'number' ? answer : Number(answer);
    if (!Number.isFinite(n) || n < 1 || n > 10) {
      throw new BadRequestException('RATING_1_10 must be 1..10');
    }
    return n;
  }
  if (type === 'YES_NO') {
    if (typeof answer === 'boolean') return answer;
    if (answer === 'yes' || answer === 'YES') return true;
    if (answer === 'no' || answer === 'NO') return false;
    throw new BadRequestException('YES_NO must be true/false or yes/no');
  }
  if (type === 'FREE_TEXT') {
    const s = String(answer ?? '');
    if (s.length > 5000) {
      throw new BadRequestException('FREE_TEXT response exceeds 5000 character limit');
    }
    return s;
  }
  if (type === 'MULTIPLE_CHOICE') {
    if (typeof answer !== 'string') {
      throw new BadRequestException('MULTIPLE_CHOICE answer must be a string option');
    }
    return answer;
  }
  return answer;
}

/**
 * Recompute aggregates from the full responses array. RATING_1_5 +
 * RATING_1_10 produce per-question {count, average, distribution}.
 * YES_NO produces {yes, no, count}. MULTIPLE_CHOICE produces
 * {count, distribution: {option: n}}. FREE_TEXT produces {count}
 * only — the raw text is never aggregated to preserve anonymity.
 */
function recomputeAggregates(
  questions: SurveyQuestion[],
  responses: Array<{ answers: Record<string, unknown> }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of questions) {
    const values = responses
      .map((r) => r.answers?.[q.id])
      .filter((v) => v !== undefined && v !== '');
    if (q.question_type === 'RATING_1_5' || q.question_type === 'RATING_1_10') {
      const nums = values.map(Number).filter((n) => Number.isFinite(n));
      const sum = nums.reduce((a, b) => a + b, 0);
      const dist: Record<string, number> = {};
      const max = q.question_type === 'RATING_1_5' ? 5 : 10;
      for (let i = 1; i <= max; i++) dist[String(i)] = 0;
      for (const n of nums) {
        const k = String(Math.round(n));
        if (dist[k] !== undefined) dist[k] += 1;
      }
      out[q.id] = {
        count: nums.length,
        average: nums.length === 0 ? 0 : Math.round((sum / nums.length) * 10) / 10,
        distribution: dist,
      };
    } else if (q.question_type === 'YES_NO') {
      let yes = 0;
      let no = 0;
      for (const v of values) {
        if (v === true) yes += 1;
        else if (v === false) no += 1;
      }
      out[q.id] = { count: yes + no, yes, no };
    } else if (q.question_type === 'MULTIPLE_CHOICE') {
      const dist: Record<string, number> = {};
      for (const v of values) {
        const k = String(v);
        dist[k] = (dist[k] ?? 0) + 1;
      }
      out[q.id] = { count: values.length, distribution: dist };
    } else if (q.question_type === 'FREE_TEXT') {
      // Never aggregate the raw text — preserve anonymity.
      out[q.id] = { count: values.length };
    }
  }
  return out;
}
