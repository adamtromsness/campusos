import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreateSubscriptionDto,
  MrrSummaryDto,
  PatchSubscriptionDto,
  SubscriptionDto,
} from '../dto/crm.dto';
import { AccountService, rowToSubscriptionDto } from './account.service';

/**
 * P2-21a — SubscriptionService.
 *
 * Stripe-synced subscriptions per account. The MRR summary is computed
 * by aggregating ACTIVE rows. PATCH paths are admin-write; the eventual
 * Stripe webhook will land via a separate handler that calls back into
 * this service.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly accounts: AccountService,
  ) {}

  async list(accountId?: string): Promise<SubscriptionDto[]> {
    const sql = accountId
      ? `SELECT id::text, account_id::text, plan_name, stripe_subscription_id, billing_interval,
                mrr_cents, student_count_at_sign, status,
                current_period_start::text, current_period_end::text,
                cancel_at_period_end, created_at, updated_at
         FROM platform.crm_subscriptions WHERE account_id = $1::uuid
         ORDER BY created_at DESC`
      : `SELECT id::text, account_id::text, plan_name, stripe_subscription_id, billing_interval,
                mrr_cents, student_count_at_sign, status,
                current_period_start::text, current_period_end::text,
                cancel_at_period_end, created_at, updated_at
         FROM platform.crm_subscriptions ORDER BY created_at DESC LIMIT 500`;
    const rows = accountId
      ? await this.platform.$queryRawUnsafe<RawSubRow[]>(sql, accountId)
      : await this.platform.$queryRawUnsafe<RawSubRow[]>(sql);
    return rows.map(rowToSubscriptionDto);
  }

  async getById(id: string): Promise<SubscriptionDto> {
    const rows = await this.platform.$queryRawUnsafe<RawSubRow[]>(
      `SELECT id::text, account_id::text, plan_name, stripe_subscription_id, billing_interval,
              mrr_cents, student_count_at_sign, status,
              current_period_start::text, current_period_end::text,
              cancel_at_period_end, created_at, updated_at
       FROM platform.crm_subscriptions WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) throw new NotFoundException(`Subscription ${id} not found.`);
    return rowToSubscriptionDto(rows[0]!);
  }

  async create(input: CreateSubscriptionDto): Promise<SubscriptionDto> {
    await this.accounts.loadOrFail(input.accountId);
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.crm_subscriptions
          (id, account_id, plan_name, stripe_subscription_id, billing_interval, mrr_cents,
           student_count_at_sign, status, current_period_start, current_period_end,
           cancel_at_period_end)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11)`,
        id,
        input.accountId,
        input.planName,
        input.stripeSubscriptionId ?? null,
        input.billingInterval,
        input.mrrCents,
        input.studentCountAtSign ?? null,
        input.status,
        input.currentPeriodStart ?? null,
        input.currentPeriodEnd ?? null,
        input.cancelAtPeriodEnd ?? false,
      );
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new BadRequestException(
          'A subscription with this stripe_subscription_id already exists.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(id: string, input: PatchSubscriptionDto): Promise<SubscriptionDto> {
    await this.getById(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };
    if (input.planName !== undefined) push('plan_name = $$', input.planName);
    if (input.billingInterval !== undefined) push('billing_interval = $$', input.billingInterval);
    if (input.mrrCents !== undefined) push('mrr_cents = $$', input.mrrCents);
    if (input.status !== undefined) push('status = $$', input.status);
    if (input.stripeSubscriptionId !== undefined)
      push('stripe_subscription_id = $$', input.stripeSubscriptionId || null);
    if (input.currentPeriodStart !== undefined)
      push('current_period_start = $$::date', input.currentPeriodStart || null);
    if (input.currentPeriodEnd !== undefined)
      push('current_period_end = $$::date', input.currentPeriodEnd || null);
    if (input.cancelAtPeriodEnd !== undefined)
      push('cancel_at_period_end = $$', input.cancelAtPeriodEnd);

    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.crm_subscriptions SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return this.getById(id);
  }

  /**
   * Aggregate MRR view. Walks crm_subscriptions and rolls up by status.
   * ACTIVE rows are the canonical MRR contributors; PAST_DUE counts as
   * "at risk" but stays in the running MRR. TRIALING contributes 0 to
   * MRR (it's expected revenue, not booked).
   */
  async mrrSummary(): Promise<MrrSummaryDto> {
    const rows = await this.platform.$queryRawUnsafe<RawMrrRow[]>(
      `SELECT status,
              COUNT(*)::int AS subs,
              COALESCE(SUM(mrr_cents) FILTER (WHERE status IN ('ACTIVE','PAST_DUE')), 0)::bigint AS mrr_cents
       FROM platform.crm_subscriptions
       GROUP BY status`,
    );
    const summary: MrrSummaryDto = {
      totalMrrCents: 0,
      activeSubscriptions: 0,
      trialingSubscriptions: 0,
      pastDueSubscriptions: 0,
      cancelledSubscriptions: 0,
    };
    for (const r of rows) {
      const mrr = Number(r.mrr_cents);
      summary.totalMrrCents += mrr;
      if (r.status === 'ACTIVE') summary.activeSubscriptions = r.subs;
      else if (r.status === 'TRIALING') summary.trialingSubscriptions = r.subs;
      else if (r.status === 'PAST_DUE') summary.pastDueSubscriptions = r.subs;
      else if (r.status === 'CANCELLED') summary.cancelledSubscriptions = r.subs;
    }
    return summary;
  }
}

interface RawSubRow {
  id: string;
  account_id: string;
  plan_name: string;
  stripe_subscription_id: string | null;
  billing_interval: string;
  mrr_cents: number;
  student_count_at_sign: number | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RawMrrRow {
  status: string;
  subs: number;
  mrr_cents: number | bigint;
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: string; meta?: { code?: string }; message?: string };
  if (anyErr.code === 'P2010') return true;
  if (anyErr.meta?.code === '23505') return true;
  if (typeof anyErr.message === 'string' && anyErr.message.includes('23505')) return true;
  return false;
}
