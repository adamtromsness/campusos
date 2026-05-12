import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import {
  AccountDto,
  AccountStatus,
  AccountTimelineDto,
  ACCOUNT_STATUSES,
  CreateAccountDto,
  ListAccountsArgs,
  PatchAccountDto,
} from '../dto/crm.dto';

/**
 * P2-21a — AccountService.
 *
 * CRUD + lifecycle validation for crm_accounts. Lifecycle transitions
 * enforced at the service layer (multi-step state machine the schema
 * cannot encode):
 *
 *   PROSPECT > PILOT          requires signed_date populated
 *   PILOT > ONBOARDING        requires signed_date
 *   ONBOARDING > ACTIVE       requires onboarding checklist COMPLETED
 *   ACTIVE > CHURNED          terminal
 *   any > SUSPENDED           administrative (kept simple — admin can flip)
 *   SUSPENDED > previous      not modeled here; admin restores by PATCHing
 *
 * Emits crm.account.lifecycle_changed (best-effort) when status flips.
 * The tenant_id on the envelope is set from the account's school_id
 * when bound to a school (the common case); accounts bound only to an
 * organisation skip the emit since there is no tenant_id to carry per
 * the ADR-057 envelope contract.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly kafka: KafkaProducerService,
  ) {}

  // ── Reads ─────────────────────────────────────────────────────────

  async list(args: ListAccountsArgs): Promise<AccountDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.status) {
      params.push(args.status);
      where.push(`status = $${params.length}`);
    }
    if (args.renewalAfter) {
      params.push(args.renewalAfter);
      where.push(`renewal_date >= $${params.length}::date`);
    }
    if (args.renewalBefore) {
      params.push(args.renewalBefore);
      where.push(`renewal_date <= $${params.length}::date`);
    }
    const whereSql = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
    const sql = `
      SELECT id::text, school_id::text, organisation_id::text, account_name,
        pricing_band_id::text, status, billing_email, billing_address_json,
        stripe_customer_id, school_champion_person_id::text,
        signed_date::text, go_live_date::text, renewal_date::text,
        created_at, updated_at
      FROM platform.crm_accounts
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    const rows = await this.platform.$queryRawUnsafe<RawAccountRow[]>(sql, ...params);
    return rows.map(rowToAccountDto);
  }

  async getById(id: string): Promise<AccountDto> {
    const row = await this.loadOrFail(id);
    return rowToAccountDto(row);
  }

  async getTimeline(id: string): Promise<AccountTimelineDto> {
    const account = await this.getById(id);
    const [interactions, healthScores, checklistRows, subs, renewals] = await Promise.all([
      this.platform.$queryRawUnsafe<RawInteractionRow[]>(
        `SELECT id::text, account_id::text, contact_id::text, interaction_type, subject, notes,
                logged_by::text, interaction_at, created_at
         FROM platform.crm_interactions WHERE account_id = $1::uuid
         ORDER BY interaction_at DESC LIMIT 200`,
        id,
      ),
      this.platform.$queryRawUnsafe<RawHealthScoreRow[]>(
        `SELECT id::text, account_id::text, score_date::text, overall_score, adoption_score,
                engagement_score, support_ticket_score, nps_score, risk_level, created_at
         FROM platform.crm_health_scores WHERE account_id = $1::uuid
         ORDER BY score_date DESC LIMIT 26`,
        id,
      ),
      this.platform.$queryRawUnsafe<RawChecklistJoinRow[]>(
        `SELECT c.id::text AS id, c.account_id::text AS account_id, c.template_version,
                c.started_at, c.completed_at, c.status,
                t.id::text AS task_id, t.task_name, t.task_category, t.sort_order,
                t.status AS task_status, t.completed_at AS task_completed_at,
                t.completed_by::text AS task_completed_by
         FROM platform.crm_onboarding_checklists c
         LEFT JOIN platform.crm_onboarding_tasks t ON t.checklist_id = c.id
         WHERE c.account_id = $1::uuid
         ORDER BY t.sort_order NULLS FIRST`,
        id,
      ),
      this.platform.$queryRawUnsafe<RawSubscriptionRow[]>(
        `SELECT id::text, account_id::text, plan_name, stripe_subscription_id, billing_interval,
                mrr_cents, student_count_at_sign, status,
                current_period_start::text, current_period_end::text,
                cancel_at_period_end, created_at, updated_at
         FROM platform.crm_subscriptions WHERE account_id = $1::uuid
         ORDER BY created_at DESC`,
        id,
      ),
      this.platform.$queryRawUnsafe<RawRenewalRow[]>(
        `SELECT id::text, account_id::text, renewal_date::text, current_mrr_cents,
                proposed_mrr_cents, stage, risk_factors, assigned_csm::text,
                notes, created_at, updated_at
         FROM platform.crm_renewal_pipeline WHERE account_id = $1::uuid
         ORDER BY renewal_date ASC`,
        id,
      ),
    ]);

    return {
      account,
      interactions: interactions.map(rowToInteractionDto),
      healthScores: healthScores.map(rowToHealthScoreDto),
      onboardingChecklist: foldChecklistRows(checklistRows),
      subscriptions: subs.map(rowToSubscriptionDto),
      renewals: renewals.map(rowToRenewalDto),
    };
  }

  // ── Writes ────────────────────────────────────────────────────────

  async create(input: CreateAccountDto): Promise<AccountDto> {
    if (!input.schoolId && !input.organisationId) {
      throw new BadRequestException(
        'Either schoolId or organisationId must be set on the account.',
      );
    }
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.crm_accounts
        (id, school_id, organisation_id, account_name, pricing_band_id, status,
         billing_email, billing_address_json, school_champion_person_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'PROSPECT',
         $6, $7::jsonb, $8::uuid)`,
      id,
      input.schoolId ?? null,
      input.organisationId ?? null,
      input.accountName,
      input.pricingBandId ?? null,
      input.billingEmail,
      input.billingAddressJson ? JSON.stringify(input.billingAddressJson) : null,
      input.schoolChampionPersonId ?? null,
    );
    return this.getById(id);
  }

  async patch(id: string, input: PatchAccountDto): Promise<AccountDto> {
    await this.loadOrFail(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };

    if (input.accountName !== undefined) push('account_name = $$', input.accountName);
    if (input.billingEmail !== undefined) push('billing_email = $$', input.billingEmail);
    if (input.stripeCustomerId !== undefined)
      push('stripe_customer_id = $$', input.stripeCustomerId || null);
    if (input.pricingBandId !== undefined)
      push('pricing_band_id = $$::uuid', input.pricingBandId || null);
    if (input.schoolChampionPersonId !== undefined)
      push('school_champion_person_id = $$::uuid', input.schoolChampionPersonId || null);
    if (input.signedDate !== undefined) push('signed_date = $$::date', input.signedDate || null);
    if (input.goLiveDate !== undefined) push('go_live_date = $$::date', input.goLiveDate || null);
    if (input.renewalDate !== undefined) push('renewal_date = $$::date', input.renewalDate || null);
    if (input.billingAddressJson !== undefined) {
      push('billing_address_json = $$::jsonb', JSON.stringify(input.billingAddressJson));
    }

    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.crm_accounts SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return this.getById(id);
  }

  /**
   * Transition account status with validation. Throws BadRequest on
   * illegal transitions; throws Conflict when prerequisite conditions
   * (signed_date, onboarding completed) aren't met.
   *
   * Emits crm.account.lifecycle_changed on success.
   */
  async transitionStatus(id: string, target: AccountStatus): Promise<AccountDto> {
    if (!ACCOUNT_STATUSES.includes(target)) {
      throw new BadRequestException(`Unknown target status: ${target}`);
    }
    const row = await this.loadOrFail(id);
    const current = row.status as AccountStatus;
    if (current === target) {
      return rowToAccountDto(row);
    }

    assertTransitionAllowed(current, target);

    if (target === 'PILOT' && !row.signed_date) {
      throw new ConflictException(
        'PROSPECT > PILOT requires signed_date to be populated. PATCH the account first.',
      );
    }
    if (target === 'ONBOARDING' && !row.signed_date) {
      throw new ConflictException('PILOT > ONBOARDING requires signed_date to be populated.');
    }
    if (target === 'ACTIVE' && current === 'ONBOARDING') {
      // Onboarding > ACTIVE requires checklist completed.
      const checklist = await this.platform.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM platform.crm_onboarding_checklists WHERE account_id = $1::uuid LIMIT 1`,
        id,
      );
      if (checklist.length === 0 || checklist[0]!.status !== 'COMPLETED') {
        throw new ConflictException(
          'ONBOARDING > ACTIVE requires the onboarding checklist to be COMPLETED.',
        );
      }
    }

    await this.platform.$executeRawUnsafe(
      `UPDATE platform.crm_accounts SET status = $1, updated_at = now() WHERE id = $2::uuid`,
      target,
      id,
    );

    await this.emitLifecycleEvent(id, current, target, row.school_id);
    return this.getById(id);
  }

  /**
   * Internal hook called by OnboardingService when the checklist is
   * marked COMPLETED. Auto-flips ONBOARDING > ACTIVE. No-op for
   * accounts in any other status (e.g. an admin reopened the
   * checklist after the account already went ACTIVE).
   */
  async autoFlipOnOnboardingComplete(accountId: string): Promise<void> {
    const row = await this.loadOrFail(accountId);
    if (row.status !== 'ONBOARDING') return;
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.crm_accounts SET status = 'ACTIVE', go_live_date = COALESCE(go_live_date, CURRENT_DATE), updated_at = now() WHERE id = $1::uuid`,
      accountId,
    );
    await this.emitLifecycleEvent(accountId, 'ONBOARDING', 'ACTIVE', row.school_id);
    this.logger.log(
      `[crm-account] auto-transitioned ${accountId} ONBOARDING > ACTIVE on checklist completion`,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawAccountRow> {
    const rows = await this.platform.$queryRawUnsafe<RawAccountRow[]>(
      `SELECT id::text, school_id::text, organisation_id::text, account_name,
              pricing_band_id::text, status, billing_email, billing_address_json,
              stripe_customer_id, school_champion_person_id::text,
              signed_date::text, go_live_date::text, renewal_date::text,
              created_at, updated_at
       FROM platform.crm_accounts WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`CRM account ${id} not found.`);
    }
    return rows[0]!;
  }

  private async emitLifecycleEvent(
    accountId: string,
    fromStatus: AccountStatus,
    toStatus: AccountStatus,
    schoolId: string | null,
  ): Promise<void> {
    if (!schoolId) {
      // ADR-057 envelope requires tenant_id; org-bound accounts skip.
      this.logger.debug(
        `[crm-account] skipping lifecycle emit for ${accountId} (no school_id binding)`,
      );
      return;
    }
    await this.kafka.emit({
      topic: 'crm.account.lifecycle_changed',
      key: accountId,
      payload: {
        accountId,
        fromStatus,
        toStatus,
        schoolId,
        changedAt: new Date().toISOString(),
      },
      sourceModule: 'crm',
      tenantId: schoolId,
    });
  }
}

// ── Lifecycle transition graph ───────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<AccountStatus, AccountStatus[]> = {
  PROSPECT: ['PILOT', 'CHURNED', 'SUSPENDED'],
  PILOT: ['ONBOARDING', 'CHURNED', 'SUSPENDED'],
  ONBOARDING: ['ACTIVE', 'CHURNED', 'SUSPENDED'],
  ACTIVE: ['CHURNED', 'SUSPENDED'],
  CHURNED: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['PROSPECT', 'PILOT', 'ONBOARDING', 'ACTIVE', 'CHURNED'],
};

export function assertTransitionAllowed(from: AccountStatus, to: AccountStatus): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new BadRequestException(
      `Illegal transition ${from} > ${to}. Allowed from ${from}: ${allowed.join(', ')}`,
    );
  }
}

// ── Row shapes + mappers ─────────────────────────────────────────────

interface RawAccountRow {
  id: string;
  school_id: string | null;
  organisation_id: string | null;
  account_name: string;
  pricing_band_id: string | null;
  status: string;
  billing_email: string;
  billing_address_json: Record<string, unknown> | null;
  stripe_customer_id: string | null;
  school_champion_person_id: string | null;
  signed_date: string | null;
  go_live_date: string | null;
  renewal_date: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RawInteractionRow {
  id: string;
  account_id: string;
  contact_id: string | null;
  interaction_type: string;
  subject: string;
  notes: string | null;
  logged_by: string;
  interaction_at: Date;
  created_at: Date;
}

interface RawHealthScoreRow {
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

interface RawSubscriptionRow {
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

interface RawRenewalRow {
  id: string;
  account_id: string;
  renewal_date: string;
  current_mrr_cents: number;
  proposed_mrr_cents: number | null;
  stage: string;
  risk_factors: string[];
  assigned_csm: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RawChecklistJoinRow {
  id: string;
  account_id: string;
  template_version: number;
  started_at: Date | null;
  completed_at: Date | null;
  status: string;
  task_id: string | null;
  task_name: string | null;
  task_category: string | null;
  sort_order: number | null;
  task_status: string | null;
  task_completed_at: Date | null;
  task_completed_by: string | null;
}

export function rowToAccountDto(row: RawAccountRow): AccountDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    organisationId: row.organisation_id,
    accountName: row.account_name,
    pricingBandId: row.pricing_band_id,
    status: row.status as AccountStatus,
    billingEmail: row.billing_email,
    billingAddressJson: row.billing_address_json,
    stripeCustomerId: row.stripe_customer_id,
    schoolChampionPersonId: row.school_champion_person_id,
    signedDate: row.signed_date,
    goLiveDate: row.go_live_date,
    renewalDate: row.renewal_date,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToInteractionDto(
  row: RawInteractionRow,
): import('../dto/crm.dto').InteractionDto {
  return {
    id: row.id,
    accountId: row.account_id,
    contactId: row.contact_id,
    interactionType: row.interaction_type as import('../dto/crm.dto').InteractionType,
    subject: row.subject,
    notes: row.notes,
    loggedBy: row.logged_by,
    interactionAt: row.interaction_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export function rowToHealthScoreDto(
  row: RawHealthScoreRow,
): import('../dto/crm.dto').HealthScoreDto {
  return {
    id: row.id,
    accountId: row.account_id,
    scoreDate: row.score_date,
    overallScore: row.overall_score,
    adoptionScore: row.adoption_score,
    engagementScore: row.engagement_score,
    supportTicketScore: row.support_ticket_score,
    npsScore: row.nps_score,
    riskLevel: row.risk_level as import('../dto/crm.dto').RiskLevel,
    createdAt: row.created_at.toISOString(),
  };
}

export function rowToSubscriptionDto(
  row: RawSubscriptionRow,
): import('../dto/crm.dto').SubscriptionDto {
  return {
    id: row.id,
    accountId: row.account_id,
    planName: row.plan_name,
    stripeSubscriptionId: row.stripe_subscription_id,
    billingInterval: row.billing_interval as import('../dto/crm.dto').SubscriptionInterval,
    mrrCents: row.mrr_cents,
    studentCountAtSign: row.student_count_at_sign,
    status: row.status as import('../dto/crm.dto').SubscriptionStatus,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToRenewalDto(row: RawRenewalRow): import('../dto/crm.dto').RenewalDto {
  return {
    id: row.id,
    accountId: row.account_id,
    renewalDate: row.renewal_date,
    currentMrrCents: row.current_mrr_cents,
    proposedMrrCents: row.proposed_mrr_cents,
    stage: row.stage as import('../dto/crm.dto').RenewalStage,
    riskFactors: row.risk_factors,
    assignedCsm: row.assigned_csm,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function foldChecklistRows(
  rows: RawChecklistJoinRow[],
): import('../dto/crm.dto').OnboardingChecklistDto | null {
  if (rows.length === 0) return null;
  const first = rows[0]!;
  const tasks: import('../dto/crm.dto').OnboardingTaskDto[] = [];
  let pending = 0;
  let completed = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.task_id) continue;
    tasks.push({
      id: r.task_id,
      checklistId: first.id,
      taskName: r.task_name!,
      taskCategory: r.task_category! as import('../dto/crm.dto').TaskCategory,
      sortOrder: r.sort_order!,
      status: r.task_status! as import('../dto/crm.dto').TaskStatus,
      completedAt: r.task_completed_at ? r.task_completed_at.toISOString() : null,
      completedBy: r.task_completed_by,
    });
    if (r.task_status === 'PENDING') pending++;
    else if (r.task_status === 'COMPLETED') completed++;
    else if (r.task_status === 'SKIPPED') skipped++;
  }
  return {
    id: first.id,
    accountId: first.account_id,
    templateVersion: first.template_version,
    startedAt: first.started_at ? first.started_at.toISOString() : null,
    completedAt: first.completed_at ? first.completed_at.toISOString() : null,
    status: first.status as import('../dto/crm.dto').ChecklistStatus,
    tasks,
    taskCounts: { total: tasks.length, pending, completed, skipped },
  };
}
