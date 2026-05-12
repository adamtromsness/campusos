import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { CreateHealthScoreDto, HealthScoreDto, RiskLevel } from '../dto/crm.dto';
import { AccountService, rowToHealthScoreDto } from './account.service';

/**
 * P2-21a — HealthScoreService.
 *
 * Per-account health snapshot history. The HealthScoreWorker writes
 * a row weekly (Monday 06:00 UTC) per ACTIVE/ONBOARDING account; this
 * service exposes the read paths and an explicit "record" path used
 * by the worker + by manual recomputes.
 *
 * UNIQUE(account_id, score_date) ensures re-runs are idempotent. The
 * recordScore path upserts so a same-day re-run overwrites instead of
 * erroring.
 */
@Injectable()
export class HealthScoreService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly accounts: AccountService,
  ) {}

  async listForAccount(accountId: string, limit = 52): Promise<HealthScoreDto[]> {
    await this.accounts.loadOrFail(accountId);
    const rows = await this.platform.$queryRawUnsafe<RawScoreRow[]>(
      `SELECT id::text, account_id::text, score_date::text, overall_score, adoption_score,
              engagement_score, support_ticket_score, nps_score, risk_level, created_at
       FROM platform.crm_health_scores WHERE account_id = $1::uuid
       ORDER BY score_date DESC LIMIT $2`,
      accountId,
      Math.min(Math.max(limit, 1), 200),
    );
    return rows.map(rowToHealthScoreDto);
  }

  async atRisk(): Promise<
    Array<{ account: import('../dto/crm.dto').AccountDto; score: HealthScoreDto }>
  > {
    // Latest score per account where risk_level in (AT_RISK, CRITICAL).
    const rows = await this.platform.$queryRawUnsafe<RawAtRiskRow[]>(
      `WITH latest AS (
         SELECT DISTINCT ON (account_id)
           id::text AS id, account_id::text AS account_id, score_date::text AS score_date,
           overall_score, adoption_score, engagement_score, support_ticket_score, nps_score,
           risk_level, created_at
         FROM platform.crm_health_scores
         ORDER BY account_id, score_date DESC
       )
       SELECT l.*, a.id::text AS a_id, a.school_id::text AS a_school_id,
              a.organisation_id::text AS a_organisation_id, a.account_name AS a_account_name,
              a.pricing_band_id::text AS a_pricing_band_id, a.status AS a_status,
              a.billing_email AS a_billing_email, a.billing_address_json AS a_billing_address_json,
              a.stripe_customer_id AS a_stripe_customer_id,
              a.school_champion_person_id::text AS a_school_champion_person_id,
              a.signed_date::text AS a_signed_date, a.go_live_date::text AS a_go_live_date,
              a.renewal_date::text AS a_renewal_date,
              a.created_at AS a_created_at, a.updated_at AS a_updated_at
       FROM latest l
       JOIN platform.crm_accounts a ON a.id = l.account_id::uuid
       WHERE l.risk_level IN ('AT_RISK', 'CRITICAL')
       ORDER BY
         CASE l.risk_level WHEN 'CRITICAL' THEN 0 ELSE 1 END,
         l.overall_score ASC`,
    );
    return rows.map((r) => ({
      account: {
        id: r.a_id,
        schoolId: r.a_school_id,
        organisationId: r.a_organisation_id,
        accountName: r.a_account_name,
        pricingBandId: r.a_pricing_band_id,
        status: r.a_status as import('../dto/crm.dto').AccountStatus,
        billingEmail: r.a_billing_email,
        billingAddressJson: r.a_billing_address_json,
        stripeCustomerId: r.a_stripe_customer_id,
        schoolChampionPersonId: r.a_school_champion_person_id,
        signedDate: r.a_signed_date,
        goLiveDate: r.a_go_live_date,
        renewalDate: r.a_renewal_date,
        createdAt: r.a_created_at.toISOString(),
        updatedAt: r.a_updated_at.toISOString(),
      },
      score: rowToHealthScoreDto({
        id: r.id,
        account_id: r.account_id,
        score_date: r.score_date,
        overall_score: r.overall_score,
        adoption_score: r.adoption_score,
        engagement_score: r.engagement_score,
        support_ticket_score: r.support_ticket_score,
        nps_score: r.nps_score,
        risk_level: r.risk_level,
        created_at: r.created_at,
      }),
    }));
  }

  async recordScore(accountId: string, input: CreateHealthScoreDto): Promise<HealthScoreDto> {
    await this.accounts.loadOrFail(accountId);
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.crm_health_scores
        (id, account_id, score_date, overall_score, adoption_score, engagement_score,
         support_ticket_score, nps_score, risk_level)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (account_id, score_date) DO UPDATE
         SET overall_score = EXCLUDED.overall_score,
             adoption_score = EXCLUDED.adoption_score,
             engagement_score = EXCLUDED.engagement_score,
             support_ticket_score = EXCLUDED.support_ticket_score,
             nps_score = EXCLUDED.nps_score,
             risk_level = EXCLUDED.risk_level`,
      id,
      accountId,
      input.scoreDate,
      input.overallScore,
      input.adoptionScore ?? null,
      input.engagementScore ?? null,
      input.supportTicketScore ?? null,
      input.npsScore ?? null,
      input.riskLevel,
    );
    const rows = await this.platform.$queryRawUnsafe<RawScoreRow[]>(
      `SELECT id::text, account_id::text, score_date::text, overall_score, adoption_score,
              engagement_score, support_ticket_score, nps_score, risk_level, created_at
       FROM platform.crm_health_scores WHERE account_id = $1::uuid AND score_date = $2::date`,
      accountId,
      input.scoreDate,
    );
    return rowToHealthScoreDto(rows[0]!);
  }

  /**
   * Compute the health score for one account on a given date. The
   * formula here is a placeholder: in production the worker would
   * pull usage stats + ticket counts + NPS surveys. For Cycle 21a it
   * uses a deterministic computation against subscription + invoice +
   * ticket counts visible in the platform schema. The worker calls
   * this on every active account weekly.
   */
  async computeForAccount(accountId: string, scoreDate: string): Promise<HealthScoreDto> {
    // Pull headline signals.
    const signals = await this.platform.$queryRawUnsafe<RawSignalRow[]>(
      `SELECT
         (SELECT COUNT(*)::int FROM platform.crm_subscriptions
            WHERE account_id = $1::uuid AND status = 'ACTIVE') AS active_subs,
         (SELECT COUNT(*)::int FROM platform.crm_subscriptions
            WHERE account_id = $1::uuid AND status = 'PAST_DUE') AS past_due_subs,
         (SELECT COUNT(*)::int FROM platform.crm_invoices
            WHERE account_id = $1::uuid AND status = 'OPEN' AND due_date < CURRENT_DATE) AS overdue_invoices,
         (SELECT COUNT(*)::int FROM platform.crm_interactions
            WHERE account_id = $1::uuid AND interaction_type IN ('SUPPORT')
              AND interaction_at >= now() - INTERVAL '30 days') AS recent_support_interactions`,
      accountId,
    );
    const s = signals[0]!;

    // Per-domain scores, each 0..100.
    const adoptionScore = s.active_subs > 0 ? 90 : 40;
    const engagementScore = Math.max(20, 100 - s.recent_support_interactions * 5);
    const supportTicketScore = Math.max(0, 100 - s.recent_support_interactions * 10);
    // No NPS source yet; leave null.

    let overallScore = Math.round((adoptionScore + engagementScore + supportTicketScore) / 3);
    if (s.past_due_subs > 0) overallScore = Math.max(20, overallScore - 20);
    if (s.overdue_invoices > 0) overallScore = Math.max(15, overallScore - 15);

    const riskLevel: RiskLevel =
      overallScore >= 70 ? 'HEALTHY' : overallScore >= 50 ? 'AT_RISK' : 'CRITICAL';

    return this.recordScore(accountId, {
      scoreDate,
      overallScore,
      adoptionScore,
      engagementScore,
      supportTicketScore,
      riskLevel,
    });
  }
}

interface RawScoreRow {
  id: string;
  account_id: string;
  score_date: string;
  overall_score: number;
  adoption_score: number | null;
  engagement_score: number | null;
  support_ticket_score: number | null;
  nps_score: number | null;
  risk_level: string;
  created_at: Date;
}

interface RawAtRiskRow extends RawScoreRow {
  a_id: string;
  a_school_id: string | null;
  a_organisation_id: string | null;
  a_account_name: string;
  a_pricing_band_id: string | null;
  a_status: string;
  a_billing_email: string;
  a_billing_address_json: Record<string, unknown> | null;
  a_stripe_customer_id: string | null;
  a_school_champion_person_id: string | null;
  a_signed_date: string | null;
  a_go_live_date: string | null;
  a_renewal_date: string | null;
  a_created_at: Date;
  a_updated_at: Date;
}

interface RawSignalRow {
  active_subs: number;
  past_due_subs: number;
  overdue_invoices: number;
  recent_support_interactions: number;
}
