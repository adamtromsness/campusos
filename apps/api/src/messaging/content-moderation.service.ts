import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';

/**
 * Three-tier content moderation. Cycle 3 Step 6.
 *
 * Every direct message goes through `evaluate()` before persistence. The
 * service walks the active `msg_moderation_policies` rows for the tenant —
 * each tenant carries its own copy of the PLATFORM, DISTRICT, and BUILDING
 * tiers that apply to it (see Step 3 design notes), so the lookup is a
 * single tenant query, no cross-schema reads.
 *
 * "Most restrictive wins" — BLOCK > ESCALATE > FLAG > CLEAN. The service
 * walks every active policy, collects every match, and returns the
 * action ranked most-restrictive first plus the policy_id and the matched
 * keywords that triggered it. The MessageService uses the response to
 * decide whether to insert the message at all (BLOCK) and what status to
 * set on it (FLAG / ESCALATED). When the verdict is non-CLEAN the service
 * also writes a `msg_moderation_log` row so the moderator queue picks it
 * up.
 *
 * Keyword match is a case-insensitive whole-word check. The plan also
 * mentions a `sensitivity_threshold` for an optional ML-style classifier;
 * Cycle 3 ships keyword-only — the threshold column is unused at the
 * service layer for now and will be revisited in Phase 2 if a classifier
 * lands.
 */

export type ModerationAction = 'CLEAN' | 'FLAGGED' | 'ESCALATED' | 'BLOCKED';

interface PolicyRow {
  id: string;
  scope: string;
  keywords: string[];
  keyword_action: string;
}

export interface ModerationVerdict {
  action: ModerationAction;
  policyId: string | null;
  matchedKeywords: string[];
  /**
   * The status to write onto `msg_messages.moderation_status` when the
   * message is persisted. Mirrors `action` 1:1 except for ESCALATED which
   * shares the `ESCALATED` constant.
   */
  messageStatus: 'CLEAN' | 'FLAGGED' | 'BLOCKED' | 'ESCALATED';
}

var ACTION_PRIORITY: Record<ModerationAction, number> = {
  CLEAN: 0,
  FLAGGED: 1,
  ESCALATED: 2,
  BLOCKED: 3,
};

function actionFromKeywordAction(a: string): ModerationAction {
  switch (a) {
    case 'BLOCK':
      return 'BLOCKED';
    case 'FLAG_FOR_REVIEW':
      return 'FLAGGED';
    case 'ESCALATE_TO_COUNSELLOR':
      return 'ESCALATED';
    default:
      return 'FLAGGED';
  }
}

function severityForAction(a: ModerationAction): string {
  if (a === 'BLOCKED' || a === 'ESCALATED') return 'URGENT';
  if (a === 'FLAGGED') return 'WARNING';
  return 'INFO';
}

function flagTypeFor(a: ModerationAction): 'BLOCKED' | 'FLAGGED' | 'ESCALATED' {
  if (a === 'BLOCKED') return 'BLOCKED';
  if (a === 'ESCALATED') return 'ESCALATED';
  return 'FLAGGED';
}

@Injectable()
export class ContentModerationService {
  private readonly logger = new Logger(ContentModerationService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Run the active moderation policies against `body`. Tenant-scoped — must
   * be called inside `runWithTenantContextAsync`. Never throws on lookup
   * failure; an unreachable policies table degrades to CLEAN so a transient
   * platform issue can't shut down messaging.
   */
  async evaluate(body: string): Promise<ModerationVerdict> {
    var policies: PolicyRow[];
    try {
      policies = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<PolicyRow[]>(
          'SELECT id::text AS id, scope, keywords, keyword_action ' +
            'FROM msg_moderation_policies ' +
            'WHERE is_active = true',
        );
      });
    } catch (e: any) {
      this.logger.warn(
        'Moderation policy lookup failed, defaulting to CLEAN: ' + (e?.message || e),
      );
      return { action: 'CLEAN', policyId: null, matchedKeywords: [], messageStatus: 'CLEAN' };
    }

    if (policies.length === 0) {
      return { action: 'CLEAN', policyId: null, matchedKeywords: [], messageStatus: 'CLEAN' };
    }

    var verdict: ModerationVerdict = {
      action: 'CLEAN',
      policyId: null,
      matchedKeywords: [],
      messageStatus: 'CLEAN',
    };

    for (var i = 0; i < policies.length; i++) {
      var p = policies[i]!;
      var matches = matchKeywords(body, p.keywords);
      if (matches.length === 0) continue;
      var act = actionFromKeywordAction(p.keyword_action);
      if (ACTION_PRIORITY[act] > ACTION_PRIORITY[verdict.action]) {
        verdict = {
          action: act,
          policyId: p.id,
          matchedKeywords: matches,
          messageStatus:
            act === 'ESCALATED' ? 'ESCALATED' : (act as ModerationVerdict['messageStatus']),
        };
      }
    }

    return verdict;
  }

  /**
   * Persist a moderation log row for a non-CLEAN verdict. Called by
   * MessageService AFTER it has chosen to insert (or refuse) the message.
   *
   * For BLOCKED messages there is no `msg_messages` row — we still log so
   * the moderator queue can see the attempt. We carry the synthetic
   * messageId / messageCreatedAt the caller used (BLOCKED messages get a
   * fresh UUID + the attempt timestamp; the row never lands in
   * `msg_messages` so the soft ref is one-sided).
   *
   * Tenant-scoped — must be called inside `runWithTenantContextAsync`.
   */
  async log(opts: {
    verdict: ModerationVerdict;
    messageId: string;
    messageCreatedAt: Date;
    threadId: string | null;
    senderId: string;
  }): Promise<void> {
    if (opts.verdict.action === 'CLEAN' || opts.verdict.policyId === null) {
      return;
    }
    var tenant = getCurrentTenant();
    var logId = generateId();
    var flag = flagTypeFor(opts.verdict.action);
    var severity = severityForAction(opts.verdict.action);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO msg_moderation_log ' +
            '(id, school_id, message_id, message_created_at, thread_id, sender_id, ' +
            ' policy_id, flag_type, matched_keywords, severity, review_outcome) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::uuid, $6::uuid, ' +
            " $7::uuid, $8, $9::text[], $10, 'PENDING')",
          logId,
          tenant.schoolId,
          opts.messageId,
          opts.messageCreatedAt.toISOString(),
          opts.threadId,
          opts.senderId,
          opts.verdict.policyId,
          flag,
          opts.verdict.matchedKeywords,
          severity,
        );
      });
    } catch (e: any) {
      // Never let a logging failure swallow the message verdict — the
      // verdict has already been applied. Log it loudly so an operator
      // notices the audit gap.
      this.logger.error('Failed to write msg_moderation_log row: ' + (e?.stack || e?.message || e));
    }
  }
}

/**
 * Case-insensitive whole-word match. Returns the matched keywords (lower-cased,
 * de-duplicated, in the order they were configured) so the moderator queue
 * can show what triggered the policy.
 *
 * Whole-word — a "ban" keyword should match "ban" but not "banana". The
 * regex escape is defensive against keywords containing regex metacharacters.
 */
function matchKeywords(body: string, keywords: string[]): string[] {
  if (keywords.length === 0) return [];
  var lower = body.toLowerCase();
  var matched: string[] = [];
  var seen: Record<string, boolean> = {};
  for (var i = 0; i < keywords.length; i++) {
    var k = keywords[i]!.trim();
    if (k.length === 0) continue;
    var lk = k.toLowerCase();
    if (seen[lk]) continue;
    var pattern = new RegExp('\\b' + escapeRegex(lk) + '\\b', 'i');
    if (pattern.test(lower)) {
      seen[lk] = true;
      matched.push(lk);
    }
  }
  return matched;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
