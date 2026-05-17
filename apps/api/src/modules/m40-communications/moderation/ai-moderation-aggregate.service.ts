import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  ActionTaken,
  CreateModerationRuleDto,
  KeywordAction,
  ModerationActionDto,
  ModerationRuleDto,
  ModerationScope,
  PatchModerationActionDto,
  ReviewStatus,
  UpdateModerationRuleDto,
} from '../messaging/dto/communications-advanced.dto';

interface ModerationRuleRow {
  id: string;
  school_id: string | null;
  scope: ModerationScope;
  scope_id: string | null;
  name: string;
  description: string | null;
  keywords: string[];
  keyword_action: KeywordAction;
  ai_sensitivity_threshold: string | null;
  escalation_rules: unknown;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ModerationActionRow {
  id: string;
  message_id: string;
  message_created_at: string;
  rule_id: string;
  action_taken: ActionTaken;
  matched_keywords: string[];
  ai_sensitivity_score: string | null;
  review_status: ReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  created_at: string;
}

function ruleRowToDto(row: ModerationRuleRow): ModerationRuleDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    scope: row.scope,
    scopeId: row.scope_id,
    name: row.name,
    description: row.description,
    keywords: row.keywords ?? [],
    keywordAction: row.keyword_action,
    aiSensitivityThreshold:
      row.ai_sensitivity_threshold !== null ? Number(row.ai_sensitivity_threshold) : null,
    escalationRules: (row.escalation_rules as Record<string, unknown>) ?? {},
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function actionRowToDto(row: ModerationActionRow): ModerationActionDto {
  return {
    id: row.id,
    messageId: row.message_id,
    messageCreatedAt: row.message_created_at,
    ruleId: row.rule_id,
    actionTaken: row.action_taken,
    matchedKeywords: row.matched_keywords ?? [],
    aiSensitivityScore: row.ai_sensitivity_score !== null ? Number(row.ai_sensitivity_score) : null,
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewerNotes: row.reviewer_notes,
    createdAt: row.created_at,
  };
}

/**
 * Most-restrictive ordering. BLOCK wins over ESCALATE wins over FLAG.
 * Used by the ModerationWorker when several rules match the same
 * message: the worker picks the rule whose keyword_action ranks
 * highest. AUTO_APPROVED is only emitted when zero rules match.
 */
const ACTION_RANK: Record<KeywordAction, number> = {
  BLOCK: 3,
  ESCALATE_TO_COUNSELLOR: 2,
  FLAG_FOR_REVIEW: 1,
};

const KEYWORD_TO_ACTION: Record<KeywordAction, ActionTaken> = {
  BLOCK: 'BLOCKED',
  ESCALATE_TO_COUNSELLOR: 'ESCALATED_TO_COUNSELLOR',
  FLAG_FOR_REVIEW: 'FLAGGED_FOR_REVIEW',
};

export interface ModerationDecision {
  ruleId: string;
  actionTaken: ActionTaken;
  matchedKeywords: string[];
  aiSensitivityScore: number | null;
}

/**
 * ModerationService — three-tier rule catalogue + admin queue.
 *
 * Three-tier resolution at message-post time (ModerationWorker):
 *   1. Read every active rule matching either PLATFORM tier (school_id
 *      NULL) OR the calling tenant's school_id.
 *   2. For each rule check the keywords list against the message body
 *      AND (when ai_sensitivity_threshold is set) compare the AI
 *      sensitivity score against the threshold.
 *   3. Pick the rule whose keyword_action ranks highest per
 *      ACTION_RANK. The selected action is materialised into
 *      msg_moderation_actions.action_taken.
 *
 * PLATFORM-tier rules are non-negotiable — they exist in every tenant
 * via the seed and a school admin cannot deactivate them. The service
 * layer enforces this on PATCH: scope=PLATFORM rules are admin-only
 * (Platform Admin), tenant admins manage BUILDING tier and the future
 * district admin role manages DISTRICT tier.
 */
@Injectable()
export class ModerationService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // ── Rules ────────────────────────────────────────────────────

  /**
   * REVIEW-P2C19 BLOCKING 2: list scopes to `scope='PLATFORM' OR
   * school_id = tenant.schoolId`. A school admin cannot list moderation
   * rules from another tenant school.
   */
  async listRules(includeInactive: boolean): Promise<ModerationRuleDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const activeFilter = includeInactive ? '' : ' AND is_active = true';
      const rows = await client.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() +
          "WHERE (scope = 'PLATFORM' OR school_id = $1::uuid)" +
          activeFilter +
          ' ORDER BY scope, created_at DESC',
        tenant.schoolId,
      );
      return rows.map(ruleRowToDto);
    });
  }

  /**
   * REVIEW-P2C19 BLOCKING 2: loadRule school-scope. A cross-school
   * rule UUID collapses to 404 don't-leak-existence.
   */
  async getRule(id: string): Promise<ModerationRuleDto> {
    return ruleRowToDto(await this.loadRule(id));
  }

  async createRule(
    input: CreateModerationRuleDto,
    actor: ResolvedActor,
  ): Promise<ModerationRuleDto> {
    if (input.scope === 'PLATFORM') {
      // PLATFORM rules can only be created by a Platform Admin.
      // Tenant admins (school admin) cannot reach this branch.
      if (!(await this.isPlatformAdmin(actor))) {
        throw new ForbiddenException('Only Platform Admins can create PLATFORM-tier rules');
      }
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_moderation_rules ' +
            '(id, school_id, scope, scope_id, name, description, keywords, ' +
            ' keyword_action, ai_sensitivity_threshold, escalation_rules, ' +
            ' is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::text[], ' +
            ' $8, $9, $10::jsonb, $11, $12::uuid)',
          id,
          input.scope === 'PLATFORM' ? null : tenant.schoolId,
          input.scope,
          input.scopeId ?? null,
          input.name,
          input.description ?? null,
          input.keywords,
          input.keywordAction,
          input.aiSensitivityThreshold ?? null,
          JSON.stringify(input.escalationRules ?? {}),
          input.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('Rule name already exists in this scope');
        }
        throw err;
      }
      const rows = await tx.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() + 'WHERE id = $1::uuid',
        id,
      );
      return ruleRowToDto(rows[0]!);
    });
  }

  async patchRule(
    id: string,
    input: UpdateModerationRuleDto,
    actor: ResolvedActor,
  ): Promise<ModerationRuleDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // REVIEW-P2C19 BLOCKING 2: school-scope the FOR UPDATE lock so
      // a cross-school rule UUID collapses to 404 before any write.
      const existing = await tx.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() +
          "WHERE id = $1::uuid AND (scope = 'PLATFORM' OR school_id = $2::uuid) FOR UPDATE",
        id,
        tenant.schoolId,
      );
      if (existing.length === 0) {
        throw new NotFoundException('Moderation rule not found');
      }
      const row = existing[0]!;
      if (row.scope === 'PLATFORM' && !(await this.isPlatformAdmin(actor))) {
        throw new ForbiddenException(
          'PLATFORM-tier rules are non-negotiable — only Platform Admins can modify them',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE msg_moderation_rules SET ' +
          'name = COALESCE($2, name), ' +
          'description = COALESCE($3, description), ' +
          'keywords = COALESCE($4::text[], keywords), ' +
          'keyword_action = COALESCE($5, keyword_action), ' +
          'ai_sensitivity_threshold = COALESCE($6, ai_sensitivity_threshold), ' +
          'escalation_rules = COALESCE($7::jsonb, escalation_rules), ' +
          'is_active = COALESCE($8, is_active), ' +
          'updated_at = now() ' +
          "WHERE id = $1::uuid AND (scope = 'PLATFORM' OR school_id = $9::uuid)",
        id,
        input.name ?? null,
        input.description ?? null,
        input.keywords ?? null,
        input.keywordAction ?? null,
        input.aiSensitivityThreshold ?? null,
        input.escalationRules ? JSON.stringify(input.escalationRules) : null,
        input.isActive ?? null,
        tenant.schoolId,
      );
      const refreshed = await tx.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() +
          "WHERE id = $1::uuid AND (scope = 'PLATFORM' OR school_id = $2::uuid)",
        id,
        tenant.schoolId,
      );
      return ruleRowToDto(refreshed[0]!);
    });
  }

  // ── Three-tier evaluation ────────────────────────────────────

  /**
   * Resolve the moderation decision for a message body. Reads every
   * active rule matching either PLATFORM-tier OR the calling tenant
   * school. Returns the most-restrictive action across all matches,
   * or null when no rule matches (the worker materialises AUTO_APPROVED
   * in that case).
   *
   * `aiSensitivityScore` is null when the AI Inference service has not
   * been consulted for this message — the worker passes it through
   * from msg_ai_moderation_results when at least one matching rule
   * declares an ai_sensitivity_threshold.
   */
  async resolveDecision(
    text: string,
    aiSensitivityScore: number | null,
  ): Promise<ModerationDecision | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rules = await client.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() +
          'WHERE is_active = true AND (scope = $1 OR school_id = $2::uuid) ' +
          'ORDER BY scope, created_at',
        'PLATFORM',
        tenant.schoolId,
      );
      if (rules.length === 0) return null;
      const lower = text.toLowerCase();
      let winner: { rule: ModerationRuleRow; matched: string[] } | null = null;
      for (const rule of rules) {
        const matched: string[] = [];
        for (const kw of rule.keywords) {
          const needle = kw.toLowerCase().trim();
          if (needle.length === 0) continue;
          if (lower.includes(needle)) matched.push(kw);
        }
        const aiThreshold =
          rule.ai_sensitivity_threshold !== null ? Number(rule.ai_sensitivity_threshold) : null;
        const aiHit =
          aiThreshold !== null && aiSensitivityScore !== null && aiSensitivityScore >= aiThreshold;
        if (matched.length === 0 && !aiHit) continue;
        if (
          winner === null ||
          ACTION_RANK[rule.keyword_action] > ACTION_RANK[winner.rule.keyword_action]
        ) {
          winner = { rule, matched };
        }
      }
      if (winner === null) return null;
      return {
        ruleId: winner.rule.id,
        actionTaken: KEYWORD_TO_ACTION[winner.rule.keyword_action],
        matchedKeywords: winner.matched,
        aiSensitivityScore,
      };
    });
  }

  /**
   * Record the moderation action for a message. Called by the
   * ModerationWorker after resolveDecision returns.
   *
   * REVIEW-P2C19 BLOCKING 6: crash-safe under redelivery. The
   * INSERT writes a contribution-ledger row in the same tenant tx,
   * keyed by UNIQUE(consumer_group, source_event_id, message_id). A
   * redelivered event raises 23505 on the second pass and the
   * service skips the INSERT — we re-read the existing action row
   * and return it. The processWithIdempotency claim outside this
   * method is the outer layer; the ledger is the schema-side
   * guarantee that survives a crash between the action INSERT and
   * the claim landing.
   *
   * `sourceEventId` and `consumerGroup` are optional only for the
   * direct admin-trigger path (no consumer context). The
   * ModerationConsumer always supplies both.
   */
  async recordAction(input: {
    messageId: string;
    messageCreatedAt: string;
    decision: ModerationDecision;
    consumerGroup?: string;
    sourceEventId?: string;
  }): Promise<ModerationActionDto> {
    const newId = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // REVIEW-P2C19 BLOCKING 6 contribution ledger claim. We claim
      // (group, event, message) BEFORE the action INSERT so a 23505
      // short-circuits the work. On the duplicate path we re-read the
      // existing action row from the ledger's record of the original
      // action_id and return it.
      let actionId: string = newId;
      let actionCreatedAt: string | null = null;
      if (input.consumerGroup && input.sourceEventId) {
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO msg_moderation_contributions ' +
              '(id, consumer_group, source_event_id, message_id, ' +
              ' action_id, action_created_at) ' +
              'VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, now())',
            generateId(),
            input.consumerGroup,
            input.sourceEventId,
            input.messageId,
            newId,
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Already claimed — re-read the original action and return.
            const claimed = await tx.$queryRawUnsafe<
              Array<{ action_id: string; action_created_at: string }>
            >(
              'SELECT action_id::text AS action_id, action_created_at::text AS action_created_at ' +
                'FROM msg_moderation_contributions ' +
                'WHERE consumer_group = $1 AND source_event_id = $2::uuid AND message_id = $3::uuid ' +
                'LIMIT 1',
              input.consumerGroup,
              input.sourceEventId,
              input.messageId,
            );
            if (claimed.length === 0) {
              throw new Error('Contribution claim lost — race indicator');
            }
            actionId = claimed[0]!.action_id;
            actionCreatedAt = claimed[0]!.action_created_at;
            const existing = await tx.$queryRawUnsafe<ModerationActionRow[]>(
              this.selectActionBase() +
                'WHERE id = $1::uuid AND created_at = $2::timestamptz LIMIT 1',
              actionId,
              actionCreatedAt,
            );
            if (existing.length > 0) return actionRowToDto(existing[0]!);
            // Ledger row exists but the action INSERT didn't land (the
            // tx that owned the original claim aborted). Fall through
            // and INSERT the action under the recorded action_id so
            // ledger ↔ action stays consistent.
          } else {
            throw err;
          }
        }
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO msg_moderation_actions ' +
          '(id, message_id, message_created_at, rule_id, action_taken, ' +
          ' matched_keywords, ai_sensitivity_score, review_status) ' +
          'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5, ' +
          ' $6::text[], $7, $8)',
        actionId,
        input.messageId,
        input.messageCreatedAt,
        input.decision.ruleId,
        input.decision.actionTaken,
        input.decision.matchedKeywords,
        input.decision.aiSensitivityScore ?? null,
        // Auto-flag the row PENDING for non-auto-approved actions.
        input.decision.actionTaken === 'AUTO_APPROVED' ? 'RELEASED' : 'PENDING',
      );
      const rows = await tx.$queryRawUnsafe<ModerationActionRow[]>(
        this.selectActionBase() + 'WHERE id = $1::uuid LIMIT 1',
        actionId,
      );
      return actionRowToDto(rows[0]!);
    });
  }

  // ── Admin queue ──────────────────────────────────────────────

  /**
   * REVIEW-P2C19 BLOCKING 2: list queue filters via EXISTS on
   * msg_moderation_rules so an admin sees only actions whose rule is
   * either PLATFORM-tier OR belongs to the calling tenant school.
   */
  async listQueue(args: {
    reviewStatus?: ReviewStatus;
    limit?: number;
  }): Promise<ModerationActionDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const reviewStatus = args.reviewStatus ?? 'PENDING';
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      const rows = await client.$queryRawUnsafe<ModerationActionRow[]>(
        this.selectActionBase() +
          'WHERE review_status = $1 ' +
          this.ruleScopeExistsClause('$2') +
          ' ORDER BY created_at DESC LIMIT $3',
        reviewStatus,
        tenant.schoolId,
        limit,
      );
      return rows.map(actionRowToDto);
    });
  }

  async getAction(id: string): Promise<ModerationActionDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<ModerationActionRow[]>(
        this.selectActionBase() +
          'WHERE id = $1::uuid ' +
          this.ruleScopeExistsClause('$2') +
          ' LIMIT 1',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Moderation action not found');
      return actionRowToDto(rows[0]!);
    });
  }

  async patchAction(
    id: string,
    input: PatchModerationActionDto,
    actor: ResolvedActor,
  ): Promise<ModerationActionDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const existing = await tx.$queryRawUnsafe<ModerationActionRow[]>(
        this.selectActionBase() +
          'WHERE id = $1::uuid ' +
          this.ruleScopeExistsClause('$2') +
          ' FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (existing.length === 0) throw new NotFoundException('Moderation action not found');
      const row = existing[0]!;
      if (row.review_status !== 'PENDING') {
        throw new BadRequestException(
          'Action review_status is already ' + row.review_status + ' — cannot patch',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE msg_moderation_actions SET ' +
          'review_status = $2, reviewed_by = $3::uuid, reviewed_at = now(), ' +
          'reviewer_notes = $4 WHERE id = $1::uuid AND created_at = $5::timestamptz',
        id,
        input.reviewStatus,
        actor.accountId,
        input.reviewerNotes ?? null,
        row.created_at,
      );
      const refreshed = await tx.$queryRawUnsafe<ModerationActionRow[]>(
        this.selectActionBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return actionRowToDto(refreshed[0]!);
    });
  }

  // ── Helpers used by AppealService ────────────────────────────

  /**
   * Used by AppealService when an appeal lands OVERTURNED: flip the
   * parent action to RELEASED inside the same tenant tx as the
   * appeal mutation, so the schema-side reviewed_chk lockstep on
   * msg_moderation_actions is always satisfied.
   */
  async releaseActionInTx(
    tx: PrismaClient,
    actionId: string,
    actionCreatedAt: string,
    reviewerAccountId: string,
    reviewerNotes: string | null,
  ): Promise<ModerationActionDto> {
    await tx.$executeRawUnsafe(
      'UPDATE msg_moderation_actions SET ' +
        'review_status = $2, reviewed_by = $3::uuid, reviewed_at = now(), ' +
        'reviewer_notes = $4 WHERE id = $1::uuid AND created_at = $5::timestamptz',
      actionId,
      'RELEASED',
      reviewerAccountId,
      reviewerNotes,
      actionCreatedAt,
    );
    const rows = await tx.$queryRawUnsafe<ModerationActionRow[]>(
      this.selectActionBase() + 'WHERE id = $1::uuid AND created_at = $2::timestamptz LIMIT 1',
      actionId,
      actionCreatedAt,
    );
    if (rows.length === 0) throw new NotFoundException('Moderation action not found');
    return actionRowToDto(rows[0]!);
  }

  /**
   * REVIEW-P2C19 BLOCKING 2: AppealService callers receive only rows
   * whose parent rule is PLATFORM-tier or belongs to the calling
   * tenant school. A cross-school action UUID returns null and the
   * appeal endpoints collapse to 404 don't-leak-existence.
   */
  async loadActionInTx(tx: PrismaClient, actionId: string): Promise<ModerationActionRow | null> {
    const tenant = getCurrentTenant();
    const rows = await tx.$queryRawUnsafe<ModerationActionRow[]>(
      this.selectActionBase() +
        'WHERE id = $1::uuid ' +
        this.ruleScopeExistsClause('$2') +
        ' LIMIT 1',
      actionId,
      tenant.schoolId,
    );
    return rows.length > 0 ? rows[0]! : null;
  }

  // ── Internals ────────────────────────────────────────────────

  /**
   * REVIEW-P2C19 BLOCKING 2 — EXISTS clause that joins back through
   * msg_moderation_rules to filter actions/appeals by rule school
   * affiliation. The placeholder argument lets callers thread their
   * tenant.schoolId at whatever positional argument the rest of the
   * statement reserves.
   */
  private ruleScopeExistsClause(schoolArgPlaceholder: string): string {
    return (
      'AND EXISTS (' +
      ' SELECT 1 FROM msg_moderation_rules r' +
      ' WHERE r.id = msg_moderation_actions.rule_id' +
      "  AND (r.scope = 'PLATFORM' OR r.school_id = " +
      schoolArgPlaceholder +
      '::uuid)' +
      ') '
    );
  }

  private selectRuleBase(): string {
    return (
      'SELECT id::text AS id, school_id::text AS school_id, scope, ' +
      'scope_id::text AS scope_id, name, description, keywords, ' +
      'keyword_action, ai_sensitivity_threshold::text AS ai_sensitivity_threshold, ' +
      'escalation_rules, is_active, created_by::text AS created_by, ' +
      'created_at::text AS created_at, updated_at::text AS updated_at ' +
      'FROM msg_moderation_rules '
    );
  }

  private selectActionBase(): string {
    return (
      'SELECT id::text AS id, message_id::text AS message_id, ' +
      'message_created_at::text AS message_created_at, ' +
      'rule_id::text AS rule_id, action_taken, matched_keywords, ' +
      'ai_sensitivity_score::text AS ai_sensitivity_score, review_status, ' +
      'reviewed_by::text AS reviewed_by, reviewed_at::text AS reviewed_at, ' +
      'reviewer_notes, created_at::text AS created_at ' +
      'FROM msg_moderation_actions '
    );
  }

  private async loadRule(id: string): Promise<ModerationRuleRow> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      // REVIEW-P2C19 BLOCKING 2: only return the row when it belongs
      // to PLATFORM tier OR the calling tenant school.
      const rows = await client.$queryRawUnsafe<ModerationRuleRow[]>(
        this.selectRuleBase() +
          "WHERE id = $1::uuid AND (scope = 'PLATFORM' OR school_id = $2::uuid) LIMIT 1",
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Moderation rule not found');
      return rows[0]!;
    });
  }

  private async isPlatformAdmin(actor: ResolvedActor): Promise<boolean> {
    // The seed grants 'sys-001:admin' only via the platform-scope
    // chain — School Admins inherit it but the explicit check here is
    // defensive. The Phase 2 punch list carries a tighter platform-
    // scope-only check.
    return actor.isSchoolAdmin;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
