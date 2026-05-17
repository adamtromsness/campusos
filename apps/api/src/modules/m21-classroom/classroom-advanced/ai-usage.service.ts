import { ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { RedisService } from '@modules/m40-communications/notifications/redis.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  AIQuotaResponseDto,
  AIUsageRowResponseDto,
  AIUsageSummaryDto,
} from './dto/ai-tutoring.dto';

interface UsageRow {
  id: string;
  school_id: string;
  job_type: 'GRADING' | 'SUMMARISATION' | 'TUTORING' | 'STUDENT_SUMMARY';
  tokens_used: number;
  cost_usd: string;
  reference_id: string | null;
  actor_id: string | null;
  created_at: Date | string;
}

function toIso(v: Date | string | null): string {
  if (v === null) return '';
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: UsageRow): AIUsageRowResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    jobType: row.job_type,
    tokensUsed: row.tokens_used,
    costUsd: Number(row.cost_usd),
    referenceId: row.reference_id,
    actorId: row.actor_id,
    createdAt: toIso(row.created_at),
  };
}

/**
 * AIUsageService — P2-7c Step 6.
 *
 * Per-tenant AI quota enforcement via Redis daily counter at
 * `ai:quota:{schoolId}:{YYYY-MM-DD}` with 25-hour TTL — long enough
 * to survive a one-hour DST transition without resetting early. The
 * default daily limit is 100 000 tokens (overrideable via
 * AI_QUOTA_DAILY_TOKENS env). assertWithinQuota is called BEFORE
 * every chargeable AI call; recordUsage is called AFTER the call
 * completes successfully. This ordering means a failed AI call
 * does NOT count against quota.
 *
 * cls_ai_usage_log is RANGE-partitioned monthly by created_at so the
 * by-month aggregate query the admin dashboard runs prunes cleanly to
 * the matching partition leaf.
 */
@Injectable()
export class AIUsageService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  private dailyLimit(): number {
    const raw = process.env.AI_QUOTA_DAILY_TOKENS;
    if (!raw) return 100_000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 100_000;
  }

  private todayKey(schoolId: string): string {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    return 'ai:quota:' + schoolId + ':' + today;
  }

  /**
   * Throw 403 when the school has exhausted its daily token budget.
   *
   * REVIEW-P2C7 MAJOR 6 — fail-closed env support. When
   * AI_QUOTA_FAIL_CLOSED=1 is set, a Redis outage that returns 0 used
   * is treated as a quota failure and the AI call is blocked. The
   * default (Redis returns 0 used) is fail-OPEN, which is appropriate
   * for dev / demo where the Gateway is stubbed and the cost is 0.
   * Production schools that want strict cost enforcement should flip
   * the env on.
   */
  async assertWithinQuota(schoolId: string): Promise<void> {
    const failClosed = process.env.AI_QUOTA_FAIL_CLOSED === '1';
    const limit = this.dailyLimit();
    if (failClosed && !this.redis.isConnected()) {
      throw new ForbiddenException(
        'AI quota check unavailable (Redis offline) and AI_QUOTA_FAIL_CLOSED is set. Retry shortly or contact ops.',
      );
    }
    const used = await this.redis.readCounter(this.todayKey(schoolId));
    if (used >= limit) {
      throw new ForbiddenException(
        'School has exhausted its daily AI token quota (' +
          limit +
          ' tokens). Try again tomorrow or contact an admin to raise the quota.',
      );
    }
  }

  /**
   * Persist usage AFTER the AI call commits. Writes one cls_ai_usage_log
   * row + bumps the Redis daily counter. Best-effort — a Redis failure
   * does not block the DB write.
   */
  async recordUsage(input: {
    schoolId: string;
    jobType: 'GRADING' | 'SUMMARISATION' | 'TUTORING' | 'STUDENT_SUMMARY';
    tokensUsed: number;
    costUsd: number;
    referenceId?: string | null;
    actorAccountId?: string | null;
  }): Promise<void> {
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO cls_ai_usage_log ' +
          '(id, school_id, job_type, tokens_used, cost_usd, reference_id, actor_id) VALUES ' +
          '($1::uuid, $2::uuid, $3, $4::int, $5::numeric, $6::uuid, $7::uuid)',
        id,
        input.schoolId,
        input.jobType,
        input.tokensUsed,
        input.costUsd,
        input.referenceId ?? null,
        input.actorAccountId ?? null,
      );
    });
    // 25-hour TTL — long enough to survive a one-hour DST transition.
    await this.redis.incrementCounter(
      this.todayKey(input.schoolId),
      input.tokensUsed,
      25 * 60 * 60,
    );
  }

  /** GET /classroom/ai-usage — admin dashboard, last N days summary. */
  async getSummary(actor: ResolvedActor, daysParam?: number): Promise<AIUsageSummaryDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can view AI usage.');
    }
    const days = Math.max(1, Math.min(90, daysParam ?? 30));
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<UsageRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, job_type, tokens_used, ' +
          'cost_usd, reference_id::text AS reference_id, actor_id::text AS actor_id, created_at ' +
          'FROM cls_ai_usage_log ' +
          'WHERE school_id = $1::uuid AND created_at >= now() - ($2::int || $3)::interval ' +
          'ORDER BY created_at DESC LIMIT 5000',
        tenant.schoolId,
        days,
        ' days',
      );
    });
    const byJobType: AIUsageSummaryDto['byJobType'] = {};
    let totalTokens = 0;
    let totalCost = 0;
    for (const r of rows) {
      totalTokens += r.tokens_used;
      const cost = Number(r.cost_usd);
      totalCost += cost;
      if (!byJobType[r.job_type]) byJobType[r.job_type] = { tokens: 0, cost: 0, calls: 0 };
      byJobType[r.job_type]!.tokens += r.tokens_used;
      byJobType[r.job_type]!.cost += cost;
      byJobType[r.job_type]!.calls += 1;
    }
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return {
      totalTokens,
      totalCost: Math.round(totalCost * 10000) / 10000,
      byJobType,
      windowStart: start.toISOString(),
      windowEnd: now.toISOString(),
    };
  }

  /** GET /classroom/ai-usage/log — admin paginated log. */
  async listUsage(actor: ResolvedActor, limit?: number): Promise<AIUsageRowResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can view the AI usage log.');
    }
    const cap = Math.max(1, Math.min(500, limit ?? 100));
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<UsageRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, job_type, tokens_used, ' +
          'cost_usd, reference_id::text AS reference_id, actor_id::text AS actor_id, created_at ' +
          'FROM cls_ai_usage_log WHERE school_id = $1::uuid ORDER BY created_at DESC LIMIT $2::int',
        tenant.schoolId,
        cap,
      );
    });
    return rows.map(rowToDto);
  }

  /** GET /classroom/ai-usage/quota — current day's quota state. */
  async getQuota(actor: ResolvedActor): Promise<AIQuotaResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only teachers and admins can view the AI quota.');
    }
    const tenant = getCurrentTenant();
    const used = await this.redis.readCounter(this.todayKey(tenant.schoolId));
    const limit = this.dailyLimit();
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    return {
      schoolId: tenant.schoolId,
      dailyLimitTokens: limit,
      usedTokensToday: used,
      remainingTokensToday: Math.max(0, limit - used),
      resetAt: tomorrow.toISOString(),
    };
  }
}
