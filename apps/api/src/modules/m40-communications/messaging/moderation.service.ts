import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * ModerationService — Cycle 14 Step 6.
 *
 * Admin-side moderation read + review surface on top of Cycle 3's
 * ContentModerationService.evaluate() pipeline. ContentModerationService
 * remains the canonical writer of msg_moderation_log on the
 * outbound-message path. This service adds:
 *
 *   - listPolicies(includeInactive)  — admin: every active policy
 *     across PLATFORM / DISTRICT / BUILDING tiers for the school.
 *   - createPolicy(input, actor)     — admin: create a BUILDING-tier
 *     policy. Refuses PLATFORM / DISTRICT scope writes (those are
 *     seed-only).
 *   - patchPolicy(id, input, actor)  — admin: update a BUILDING-tier
 *     policy. Refuses edits on PLATFORM / DISTRICT.
 *   - listQueue()                    — admin: messages with
 *     moderation_status='FLAGGED' or 'ESCALATED' joined to the
 *     most-restrictive matching msg_moderation_log row.
 *   - reviewLogEntry(id, outcome)    — admin: stamp review_outcome on a
 *     msg_moderation_log row. RELEASED flips the parent message back
 *     to APPROVED. CONFIRMED_BLOCK keeps the BLOCKED state.
 *   - listLog(filters)               — admin: paginated audit trail.
 *
 * All endpoints gated on com-004:read (queue + log) or com-004:write
 * (review actions + policy edits) — held only by Staff + Admin per
 * the Cycle 14 IAM seed.
 */

const POLICY_SCOPES = ['PLATFORM', 'DISTRICT', 'BUILDING'] as const;
const POLICY_ACTIONS = ['BLOCK', 'FLAG_FOR_REVIEW', 'ESCALATE_TO_COUNSELLOR'] as const;
const REVIEW_OUTCOMES = ['CONFIRMED_BLOCK', 'RELEASED', 'ESCALATED'] as const;

type PolicyScope = (typeof POLICY_SCOPES)[number];
type PolicyAction = (typeof POLICY_ACTIONS)[number];
type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

interface PolicyRow {
  id: string;
  scope: string;
  scope_id: string | null;
  name: string | null;
  description: string | null;
  keywords: string[];
  keyword_action: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModerationPolicyDto {
  id: string;
  scope: PolicyScope;
  scopeId: string | null;
  name: string | null;
  description: string | null;
  keywords: string[];
  keywordAction: PolicyAction;
  isActive: boolean;
  isEditable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBuildingPolicyDto {
  name: string;
  description?: string;
  keywords: string[];
  keywordAction: PolicyAction;
}

export interface UpdatePolicyDto {
  name?: string;
  description?: string;
  keywords?: string[];
  keywordAction?: PolicyAction;
  isActive?: boolean;
}

export interface ModerationQueueRowDto {
  logId: string;
  messageId: string;
  threadId: string | null;
  senderId: string;
  senderName: string | null;
  flagType: string;
  matchedKeywords: string[];
  severity: string;
  policyId: string;
  policyName: string | null;
  reviewOutcome: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  messagePreview: string | null;
  messageStatus: string | null;
  loggedAt: string;
}

export interface ListLogFiltersDto {
  flagType?: string;
  fromDate?: string;
  toDate?: string;
  policyId?: string;
  limit?: number;
}

const SELECT_POLICY =
  'SELECT id::text AS id, scope, scope_id::text AS scope_id, name, description, ' +
  'keywords, keyword_action, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM msg_moderation_policies ';

function policyRowToDto(r: PolicyRow): ModerationPolicyDto {
  return {
    id: r.id,
    scope: r.scope as PolicyScope,
    scopeId: r.scope_id,
    name: r.name,
    description: r.description,
    keywords: r.keywords,
    keywordAction: r.keyword_action as PolicyAction,
    isActive: r.is_active,
    isEditable: r.scope === 'BUILDING',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ModerationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor) {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Moderation administration is admin-only');
    }
  }

  async listPolicies(
    includeInactive: boolean,
    actor: ResolvedActor,
  ): Promise<ModerationPolicyDto[]> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const sql =
      SELECT_POLICY +
      "WHERE scope = 'PLATFORM' OR (scope = 'BUILDING' AND scope_id = $1::uuid) " +
      (includeInactive ? '' : 'AND is_active = true ') +
      'ORDER BY ' +
      "  CASE scope WHEN 'PLATFORM' THEN 1 WHEN 'DISTRICT' THEN 2 ELSE 3 END, " +
      '  keyword_action ASC, name ASC NULLS LAST';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PolicyRow[]>(sql, tenant.schoolId);
    });
    return rows.map(policyRowToDto);
  }

  async createPolicy(
    input: CreateBuildingPolicyDto,
    actor: ResolvedActor,
  ): Promise<ModerationPolicyDto> {
    this.assertAdmin(actor);
    if (!input.keywords || input.keywords.length === 0) {
      throw new BadRequestException('keywords must be a non-empty array');
    }
    if (!POLICY_ACTIONS.includes(input.keywordAction)) {
      throw new BadRequestException('keywordAction must be one of ' + POLICY_ACTIONS.join(', '));
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO msg_moderation_policies ' +
          '(id, scope, scope_id, name, description, keywords, keyword_action, is_active) ' +
          "VALUES ($1::uuid, 'BUILDING', $2::uuid, $3, $4, $5::text[], $6, true)",
        id,
        tenant.schoolId,
        input.name,
        input.description ?? null,
        input.keywords,
        input.keywordAction,
      );
    });
    return this.getPolicyOrFail(id);
  }

  async patchPolicy(
    id: string,
    input: UpdatePolicyDto,
    actor: ResolvedActor,
  ): Promise<ModerationPolicyDto> {
    this.assertAdmin(actor);
    const policy = await this.getPolicyOrFail(id);
    if (policy.scope !== 'BUILDING') {
      throw new ForbiddenException(
        'Only BUILDING-tier policies are editable. PLATFORM and DISTRICT policies are seed-only.',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push('name = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.keywords !== undefined) {
      if (input.keywords.length === 0) {
        throw new BadRequestException('keywords cannot be cleared — set isActive=false instead');
      }
      params.push(input.keywords);
      sets.push('keywords = $' + params.length + '::text[]');
    }
    if (input.keywordAction !== undefined) {
      if (!POLICY_ACTIONS.includes(input.keywordAction)) {
        throw new BadRequestException('keywordAction must be one of ' + POLICY_ACTIONS.join(', '));
      }
      params.push(input.keywordAction);
      sets.push('keyword_action = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) return policy;
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE msg_moderation_policies SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.getPolicyOrFail(id);
  }

  async listQueue(actor: ResolvedActor): Promise<ModerationQueueRowDto[]> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    // Show every msg_moderation_log row that hasn't been resolved
    // yet (review_outcome = 'PENDING'). The flag_type carries the
    // action taken (BLOCKED / FLAGGED_FOR_REVIEW /
    // ESCALATED_TO_COUNSELLOR / AUTO_APPROVED). We filter out
    // AUTO_APPROVED rows from the queue but keep them in the audit
    // log.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT l.id::text AS log_id, l.message_id::text AS message_id, ' +
          'l.thread_id::text AS thread_id, l.sender_id::text AS sender_id, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
          '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          '  WHERE pu.id = l.sender_id) AS sender_name, ' +
          'l.flag_type, l.matched_keywords, l.severity, l.policy_id::text AS policy_id, ' +
          '(SELECT name FROM msg_moderation_policies WHERE id = l.policy_id) AS policy_name, ' +
          'l.review_outcome, ' +
          'TO_CHAR(l.reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS reviewed_at, ' +
          "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
          '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
          '  WHERE pu.id = l.reviewed_by) AS reviewed_by_name, ' +
          '(SELECT LEFT(body, 200) FROM msg_messages WHERE id = l.message_id LIMIT 1) AS message_preview, ' +
          '(SELECT moderation_status FROM msg_messages WHERE id = l.message_id LIMIT 1) AS message_status, ' +
          'TO_CHAR(l.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS logged_at ' +
          'FROM msg_moderation_log l ' +
          "WHERE l.school_id = $1::uuid AND l.flag_type IN ('BLOCKED','FLAGGED_FOR_REVIEW','ESCALATED_TO_COUNSELLOR') " +
          "AND (l.review_outcome IS NULL OR l.review_outcome = 'PENDING') " +
          'ORDER BY l.created_at DESC LIMIT 200',
        tenant.schoolId,
      );
    })) as Array<{
      log_id: string;
      message_id: string;
      thread_id: string | null;
      sender_id: string;
      sender_name: string | null;
      flag_type: string;
      matched_keywords: string[];
      severity: string;
      policy_id: string;
      policy_name: string | null;
      review_outcome: string | null;
      reviewed_at: string | null;
      reviewed_by_name: string | null;
      message_preview: string | null;
      message_status: string | null;
      logged_at: string;
    }>;
    return rows.map((r) => ({
      logId: r.log_id,
      messageId: r.message_id,
      threadId: r.thread_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      flagType: r.flag_type,
      matchedKeywords: r.matched_keywords,
      severity: r.severity,
      policyId: r.policy_id,
      policyName: r.policy_name,
      reviewOutcome: r.review_outcome,
      reviewedAt: r.reviewed_at,
      reviewedByName: r.reviewed_by_name,
      messagePreview: r.message_preview,
      messageStatus: r.message_status,
      loggedAt: r.logged_at,
    }));
  }

  async reviewLogEntry(
    logId: string,
    outcome: ReviewOutcome,
    notes: string | null,
    actor: ResolvedActor,
  ): Promise<{ logId: string; messageId: string; outcome: ReviewOutcome }> {
    this.assertAdmin(actor);
    if (!REVIEW_OUTCOMES.includes(outcome)) {
      throw new BadRequestException('review outcome must be one of ' + REVIEW_OUTCOMES.join(', '));
    }

    const messageId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, message_id::text AS message_id, review_outcome FROM msg_moderation_log WHERE id = $1::uuid FOR UPDATE',
        logId,
      )) as Array<{ id: string; message_id: string; review_outcome: string | null }>;
      if (lock.length === 0) throw new NotFoundException('Moderation log entry not found');
      if (lock[0]!.review_outcome && lock[0]!.review_outcome !== 'PENDING') {
        throw new BadRequestException(
          'Log entry is already reviewed (outcome=' + lock[0]!.review_outcome + ')',
        );
      }

      await tx.$executeRawUnsafe(
        'UPDATE msg_moderation_log SET review_outcome = $1, reviewed_at = now(), reviewed_by = $2::uuid, notes = $3 WHERE id = $4::uuid',
        outcome,
        actor.accountId,
        notes,
        logId,
      );

      // RELEASED: flip the parent message back to APPROVED so it
      // becomes visible to the recipient.
      if (outcome === 'RELEASED') {
        await tx.$executeRawUnsafe(
          "UPDATE msg_messages SET moderation_status = 'APPROVED', updated_at = now() WHERE id = $1::uuid",
          lock[0]!.message_id,
        );
      }
      // CONFIRMED_BLOCK + ESCALATED leave moderation_status alone — the
      // message stays in BLOCKED / FLAGGED state per the original
      // verdict.

      return lock[0]!.message_id;
    });

    return { logId, messageId, outcome };
  }

  async listLog(
    filters: ListLogFiltersDto,
    actor: ResolvedActor,
  ): Promise<ModerationQueueRowDto[]> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const sql: string[] = [
      'SELECT l.id::text AS log_id, l.message_id::text AS message_id, ',
      'l.thread_id::text AS thread_id, l.sender_id::text AS sender_id, ',
      "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu ",
      '  JOIN platform.iam_person ip ON ip.id = pu.person_id ',
      '  WHERE pu.id = l.sender_id) AS sender_name, ',
      'l.flag_type, l.matched_keywords, l.severity, l.policy_id::text AS policy_id, ',
      '(SELECT name FROM msg_moderation_policies WHERE id = l.policy_id) AS policy_name, ',
      'l.review_outcome, ',
      'TO_CHAR(l.reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS reviewed_at, ',
      "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu ",
      '  JOIN platform.iam_person ip ON ip.id = pu.person_id ',
      '  WHERE pu.id = l.reviewed_by) AS reviewed_by_name, ',
      '(SELECT LEFT(body, 200) FROM msg_messages WHERE id = l.message_id LIMIT 1) AS message_preview, ',
      '(SELECT moderation_status FROM msg_messages WHERE id = l.message_id LIMIT 1) AS message_status, ',
      'TO_CHAR(l.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS logged_at ',
      'FROM msg_moderation_log l ',
      'WHERE l.school_id = $1::uuid ',
    ];
    const params: unknown[] = [tenant.schoolId];
    if (filters.flagType) {
      params.push(filters.flagType);
      sql.push('AND l.flag_type = $' + params.length + ' ');
    }
    if (filters.policyId) {
      params.push(filters.policyId);
      sql.push('AND l.policy_id = $' + params.length + '::uuid ');
    }
    if (filters.fromDate) {
      params.push(filters.fromDate);
      sql.push('AND l.created_at >= $' + params.length + '::timestamptz ');
    }
    if (filters.toDate) {
      params.push(filters.toDate);
      sql.push('AND l.created_at <= $' + params.length + '::timestamptz ');
    }
    const limit = filters.limit && filters.limit > 0 && filters.limit <= 500 ? filters.limit : 100;
    sql.push('ORDER BY l.created_at DESC LIMIT ' + limit);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql.join(''), ...params);
    })) as Array<{
      log_id: string;
      message_id: string;
      thread_id: string | null;
      sender_id: string;
      sender_name: string | null;
      flag_type: string;
      matched_keywords: string[];
      severity: string;
      policy_id: string;
      policy_name: string | null;
      review_outcome: string | null;
      reviewed_at: string | null;
      reviewed_by_name: string | null;
      message_preview: string | null;
      message_status: string | null;
      logged_at: string;
    }>;
    return rows.map((r) => ({
      logId: r.log_id,
      messageId: r.message_id,
      threadId: r.thread_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      flagType: r.flag_type,
      matchedKeywords: r.matched_keywords,
      severity: r.severity,
      policyId: r.policy_id,
      policyName: r.policy_name,
      reviewOutcome: r.review_outcome,
      reviewedAt: r.reviewed_at,
      reviewedByName: r.reviewed_by_name,
      messagePreview: r.message_preview,
      messageStatus: r.message_status,
      loggedAt: r.logged_at,
    }));
  }

  private async getPolicyOrFail(id: string): Promise<ModerationPolicyDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PolicyRow[]>(SELECT_POLICY + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Moderation policy not found');
    return policyRowToDto(rows[0]!);
  }
}
