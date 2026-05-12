import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { RedisService } from '../notifications/redis.service';
import {
  AddRecipientsByTagDto,
  CampaignDto,
  CampaignFunnelDto,
  CampaignRaisedDto,
  CampaignRecipientDto,
  CampaignStatus,
  CreateCampaignDto,
  CreateDonationDto,
  DonationDto,
  OutreachStatus,
  UpdateCampaignDto,
  UpdateRecipientStatusDto,
} from './dto/alumni.dto';
import { hasStaffScope, loadCampaignOrFail, loadAlumniProfileOrFail } from './access';

interface CampaignRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  goal_amount: string | null;
  reporting_currency: string;
  start_date: Date | null;
  end_date: Date | null;
  status: string;
  created_by: string;
  activated_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  raised_amount: string;
  recipient_count: number;
  donation_count: number;
}

const SELECT_CAMPAIGN_BASE =
  `SELECT c.id::text AS id, c.school_id::text AS school_id, c.title, c.description, ` +
  `c.goal_amount, c.reporting_currency, c.start_date, c.end_date, c.status, ` +
  `c.created_by::text AS created_by, c.activated_at, c.completed_at, c.created_at, c.updated_at, ` +
  `COALESCE((SELECT SUM(amount_in_reporting_currency) FROM alm_donations WHERE campaign_id = c.id), 0) AS raised_amount, ` +
  `(SELECT COUNT(*)::int FROM alm_campaign_recipients WHERE campaign_id = c.id) AS recipient_count, ` +
  `(SELECT COUNT(*)::int FROM alm_donations WHERE campaign_id = c.id) AS donation_count ` +
  `FROM alm_campaigns c `;

function campaignRowToDto(r: CampaignRow): CampaignDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    goalAmount: r.goal_amount === null ? null : Number(r.goal_amount),
    reportingCurrency: r.reporting_currency,
    startDate: r.start_date ? r.start_date.toISOString().slice(0, 10) : null,
    endDate: r.end_date ? r.end_date.toISOString().slice(0, 10) : null,
    status: r.status as CampaignStatus,
    createdBy: r.created_by,
    activatedAt: r.activated_at ? r.activated_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    raisedAmount: Number(r.raised_amount ?? 0),
    recipientCount: r.recipient_count,
    donationCount: r.donation_count,
  };
}

function campaignRaisedKey(campaignId: string): string {
  return `campaign:raised:${campaignId}`;
}

const RAISED_TTL_SECONDS = 5 * 60;

@Injectable()
export class CampaignService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
    private readonly redis: RedisService,
  ) {}

  /** List campaigns. Staff + admin see all; non-staff see ACTIVE + COMPLETED only. */
  async list(actor: ResolvedActor, status?: CampaignStatus): Promise<CampaignDto[]> {
    const tenant = getCurrentTenant();
    const isStaff = await hasStaffScope(this.permCheck, actor);

    const where: string[] = ['c.school_id = $1::uuid'];
    const args: unknown[] = [tenant.schoolId];

    if (status !== undefined) {
      where.push(`c.status = $${args.length + 1}`);
      args.push(status);
    } else if (!isStaff) {
      where.push(`c.status IN ('ACTIVE', 'COMPLETED')`);
    }

    const sql =
      SELECT_CAMPAIGN_BASE + 'WHERE ' + where.join(' AND ') + ' ORDER BY c.created_at DESC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as CampaignRow[];
    return rows.map(campaignRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<CampaignDto> {
    const tenant = getCurrentTenant();
    const isStaff = await hasStaffScope(this.permCheck, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CAMPAIGN_BASE + 'WHERE c.id = $1::uuid AND c.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as CampaignRow[];
    if (rows.length === 0) {
      throw new NotFoundException('Campaign not found');
    }
    const dto = campaignRowToDto(rows[0]!);
    if (!isStaff && dto.status === 'DRAFT') {
      // DRAFT is staff-only — hide from non-staff readers.
      throw new NotFoundException('Campaign not found');
    }
    return dto;
  }

  async create(input: CreateCampaignDto, actor: ResolvedActor): Promise<CampaignDto> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Campaign management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO alm_campaigns
           (id, school_id, title, description, goal_amount, reporting_currency, start_date, end_date, status, created_by)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, 'DRAFT', $9::uuid)`,
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.goalAmount ?? null,
        input.reportingCurrency ?? 'USD',
        input.startDate ?? null,
        input.endDate ?? null,
        actor.personId,
      );
    });
    return this.getById(id, actor);
  }

  async patch(id: string, input: UpdateCampaignDto, actor: ResolvedActor): Promise<CampaignDto> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Campaign management requires staff or admin scope');
    }
    await loadCampaignOrFail(this.tenantPrisma, id);

    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown, cast = '') => {
      sets.push(`${col} = $${i++}${cast}`);
      args.push(val);
    };
    if (input.title !== undefined) add('title', input.title);
    if (input.description !== undefined) add('description', input.description);
    if (input.goalAmount !== undefined) add('goal_amount', input.goalAmount);
    if (input.startDate !== undefined) add('start_date', input.startDate, '::date');
    if (input.endDate !== undefined) add('end_date', input.endDate, '::date');
    if (input.status !== undefined) {
      add('status', input.status);
      if (input.status === 'COMPLETED') {
        sets.push('completed_at = now()');
      } else if (input.status === 'CANCELLED') {
        sets.push('completed_at = now()');
      }
    }
    args.push(id);
    const sql = `UPDATE alm_campaigns SET ${sets.join(', ')} WHERE id = $${i}::uuid`;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(id, actor);
  }

  /**
   * Activate a DRAFT campaign. Stamps activated_at + flips status to
   * ACTIVE inside a single tx, then emits alm.campaign.activated AFTER
   * the tx commits.
   */
  async activate(id: string, actor: ResolvedActor): Promise<CampaignDto> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Campaign management requires staff or admin scope');
    }
    const tenant = getCurrentTenant();

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM alm_campaigns WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Campaign not found');
      }
      if (rows[0]!.status !== 'DRAFT') {
        throw new ConflictException(
          `Cannot activate a campaign with status ${rows[0]!.status}; only DRAFT campaigns may be activated.`,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE alm_campaigns SET status = 'ACTIVE', activated_at = now(), updated_at = now() WHERE id = $1::uuid`,
        id,
      );
      const after = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, title, reporting_currency, goal_amount FROM alm_campaigns WHERE id = $1::uuid`,
        id,
      )) as Array<{
        id: string;
        title: string;
        reporting_currency: string;
        goal_amount: string | null;
      }>;
      return after[0]!;
    });

    try {
      await this.kafka.emit({
        topic: 'alm.campaign.activated',
        key: id,
        sourceModule: 'alumni',
        payload: {
          campaignId: result.id,
          schoolId: tenant.schoolId,
          title: result.title,
          reportingCurrency: result.reporting_currency,
          goalAmount: result.goal_amount === null ? null : Number(result.goal_amount),
          activatedBy: actor.personId,
        },
      });
    } catch {
      // best-effort emit
    }
    await this.redis.cacheInvalidate(campaignRaisedKey(id));
    return this.getById(id, actor);
  }

  /**
   * Read the campaign raised total in reporting_currency. Hits Redis
   * first, then falls through to the authoritative SUM query and
   * caches the result with TTL=5min.
   */
  async raised(id: string, actor: ResolvedActor): Promise<CampaignRaisedDto> {
    await this.getById(id, actor); // RLS gate
    const campaign = await loadCampaignOrFail(this.tenantPrisma, id);

    const cached = await this.redis.cacheGet<{ amount: number; currency: string }>(
      campaignRaisedKey(id),
    );
    if (cached !== null) {
      return {
        campaignId: id,
        raisedAmount: cached.amount,
        reportingCurrency: cached.currency,
        cached: true,
      };
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT COALESCE(SUM(amount_in_reporting_currency), 0) AS total FROM alm_donations WHERE campaign_id = $1::uuid`,
        id,
      );
    })) as Array<{ total: string }>;
    const total = Number(rows[0]?.total ?? 0);
    await this.redis.cacheSet(
      campaignRaisedKey(id),
      { amount: total, currency: campaign.reportingCurrency },
      RAISED_TTL_SECONDS,
    );
    return {
      campaignId: id,
      raisedAmount: total,
      reportingCurrency: campaign.reportingCurrency,
      cached: false,
    };
  }

  /** Roll up the outreach funnel for a campaign. */
  async funnel(id: string, actor: ResolvedActor): Promise<CampaignFunnelDto> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Campaign funnel requires staff or admin scope');
    }
    await loadCampaignOrFail(this.tenantPrisma, id);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT outreach_status, COUNT(*)::int AS n FROM alm_campaign_recipients WHERE campaign_id = $1::uuid GROUP BY outreach_status`,
        id,
      );
    })) as Array<{ outreach_status: string; n: number }>;
    const out: CampaignFunnelDto = {
      campaignId: id,
      pending: 0,
      sent: 0,
      opened: 0,
      responded: 0,
      donated: 0,
      unsubscribed: 0,
      total: 0,
    };
    for (const r of rows) {
      switch (r.outreach_status) {
        case 'PENDING':
          out.pending = r.n;
          break;
        case 'SENT':
          out.sent = r.n;
          break;
        case 'OPENED':
          out.opened = r.n;
          break;
        case 'RESPONDED':
          out.responded = r.n;
          break;
        case 'DONATED':
          out.donated = r.n;
          break;
        case 'UNSUBSCRIBED':
          out.unsubscribed = r.n;
          break;
      }
      out.total += r.n;
    }
    return out;
  }

  /**
   * Bulk-add campaign recipients by tag. Resolves the tag to
   * alm_alumni_profiles ids and inserts campaign_recipient rows
   * idempotently — duplicates are skipped via ON CONFLICT DO NOTHING.
   */
  async addRecipientsByTag(
    campaignId: string,
    input: AddRecipientsByTagDto,
    actor: ResolvedActor,
  ): Promise<{ campaignId: string; created: number; skipped: number }> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Recipient management requires staff or admin scope');
    }
    await loadCampaignOrFail(this.tenantPrisma, campaignId);

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const alumniRows = (await tx.$queryRawUnsafe(
        `SELECT p.id::text AS id FROM alm_alumni_profiles p
         JOIN alm_alumni_tags t ON t.alumni_id = p.id
         WHERE p.school_id = (SELECT school_id FROM alm_campaigns WHERE id = $1::uuid)
           AND t.tag = $2`,
        campaignId,
        input.tag,
      )) as Array<{ id: string }>;

      let created = 0;
      for (const a of alumniRows) {
        const inserted = (await tx.$queryRawUnsafe(
          `INSERT INTO alm_campaign_recipients (id, campaign_id, alumni_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid)
           ON CONFLICT (campaign_id, alumni_id) DO NOTHING
           RETURNING id`,
          generateId(),
          campaignId,
          a.id,
        )) as Array<{ id: string }>;
        if (inserted.length > 0) created += 1;
      }
      return { totalCandidates: alumniRows.length, created };
    });

    return {
      campaignId,
      created: result.created,
      skipped: result.totalCandidates - result.created,
    };
  }

  /** List recipients for a campaign. Staff + admin only. */
  async listRecipients(
    campaignId: string,
    actor: ResolvedActor,
    status?: OutreachStatus,
  ): Promise<CampaignRecipientDto[]> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Recipient list requires staff or admin scope');
    }
    await loadCampaignOrFail(this.tenantPrisma, campaignId);
    const where: string[] = ['campaign_id = $1::uuid'];
    const args: unknown[] = [campaignId];
    if (status !== undefined) {
      where.push(`outreach_status = $${args.length + 1}`);
      args.push(status);
    }
    const sql =
      `SELECT id::text AS id, campaign_id::text AS campaign_id, alumni_id::text AS alumni_id, outreach_status, ` +
      `sent_at, opened_at, responded_at, donated_at, unsubscribed_at ` +
      `FROM alm_campaign_recipients WHERE ${where.join(' AND ')} ORDER BY created_at DESC`;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...args);
    })) as Array<{
      id: string;
      campaign_id: string;
      alumni_id: string;
      outreach_status: string;
      sent_at: Date | null;
      opened_at: Date | null;
      responded_at: Date | null;
      donated_at: Date | null;
      unsubscribed_at: Date | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      campaignId: r.campaign_id,
      alumniId: r.alumni_id,
      outreachStatus: r.outreach_status as OutreachStatus,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      openedAt: r.opened_at ? r.opened_at.toISOString() : null,
      respondedAt: r.responded_at ? r.responded_at.toISOString() : null,
      donatedAt: r.donated_at ? r.donated_at.toISOString() : null,
      unsubscribedAt: r.unsubscribed_at ? r.unsubscribed_at.toISOString() : null,
    }));
  }
}

@Injectable()
export class OutreachService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * Bulk-flip PENDING recipients to SENT. The wire-side outreach send
   * (via Cycle 14 Communications) is the Step 6 concern; this method
   * just flips the funnel state to make the dashboard reflect that
   * outreach has gone out. Returns the count of rows flipped.
   */
  async sendOutreach(
    campaignId: string,
    actor: ResolvedActor,
  ): Promise<{ campaignId: string; sent: number }> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Outreach send requires staff or admin scope');
    }
    await loadCampaignOrFail(this.tenantPrisma, campaignId);

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `UPDATE alm_campaign_recipients
         SET outreach_status = 'SENT', sent_at = now(), updated_at = now()
         WHERE campaign_id = $1::uuid AND outreach_status = 'PENDING'
         RETURNING id`,
        campaignId,
      );
    })) as Array<{ id: string }>;
    return { campaignId, sent: rows.length };
  }

  /**
   * Flip a single recipient's outreach status. Allowed transitions:
   *   PENDING -> SENT / UNSUBSCRIBED
   *   SENT -> OPENED / UNSUBSCRIBED
   *   OPENED -> RESPONDED / UNSUBSCRIBED
   *   RESPONDED -> DONATED / UNSUBSCRIBED
   * DONATED is terminal (donations land via the DonationService);
   * UNSUBSCRIBED is terminal.
   */
  async updateStatus(
    recipientId: string,
    input: UpdateRecipientStatusDto,
    actor: ResolvedActor,
  ): Promise<CampaignRecipientDto> {
    if (!(await hasStaffScope(this.permCheck, actor))) {
      throw new ForbiddenException('Recipient status changes require staff or admin scope');
    }
    const stamp = stampForStatus(input.status);
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT outreach_status FROM alm_campaign_recipients WHERE id = $1::uuid FOR UPDATE`,
        recipientId,
      )) as Array<{ outreach_status: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Recipient not found');
      }
      const current = rows[0]!.outreach_status as OutreachStatus;
      if (!isValidTransition(current, input.status)) {
        throw new BadRequestException(
          `Invalid transition ${current} -> ${input.status}. Cannot move backwards or to DONATED outside the donation flow.`,
        );
      }
      const sets: string[] = ['outreach_status = $1', 'updated_at = now()'];
      if (stamp !== null) {
        sets.push(`${stamp} = COALESCE(${stamp}, now())`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE alm_campaign_recipients SET ${sets.join(', ')} WHERE id = $2::uuid`,
        input.status,
        recipientId,
      );
      const after = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, campaign_id::text AS campaign_id, alumni_id::text AS alumni_id, outreach_status,
         sent_at, opened_at, responded_at, donated_at, unsubscribed_at
         FROM alm_campaign_recipients WHERE id = $1::uuid`,
        recipientId,
      )) as Array<{
        id: string;
        campaign_id: string;
        alumni_id: string;
        outreach_status: string;
        sent_at: Date | null;
        opened_at: Date | null;
        responded_at: Date | null;
        donated_at: Date | null;
        unsubscribed_at: Date | null;
      }>;
      return after[0]!;
    });

    return {
      id: result.id,
      campaignId: result.campaign_id,
      alumniId: result.alumni_id,
      outreachStatus: result.outreach_status as OutreachStatus,
      sentAt: result.sent_at ? result.sent_at.toISOString() : null,
      openedAt: result.opened_at ? result.opened_at.toISOString() : null,
      respondedAt: result.responded_at ? result.responded_at.toISOString() : null,
      donatedAt: result.donated_at ? result.donated_at.toISOString() : null,
      unsubscribedAt: result.unsubscribed_at ? result.unsubscribed_at.toISOString() : null,
    };
  }
}

const STATUS_ORDER: OutreachStatus[] = ['PENDING', 'SENT', 'OPENED', 'RESPONDED', 'DONATED'];
function isValidTransition(from: OutreachStatus, to: OutreachStatus): boolean {
  if (to === 'UNSUBSCRIBED') return from !== 'UNSUBSCRIBED';
  // DONATED transitions are gated through DonationService.donate; reject
  // direct DONATED writes here so the funnel can only land via donation.
  if (to === 'DONATED') return false;
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx > fromIdx;
}

function stampForStatus(s: OutreachStatus): string | null {
  switch (s) {
    case 'SENT':
      return 'sent_at';
    case 'OPENED':
      return 'opened_at';
    case 'RESPONDED':
      return 'responded_at';
    case 'DONATED':
      return 'donated_at';
    case 'UNSUBSCRIBED':
      return 'unsubscribed_at';
    default:
      return null;
  }
}

@Injectable()
export class DonationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly kafka: KafkaProducerService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Record a donation. Computes amount_in_reporting_currency = amount *
   * fxRateAtDonation (or amount when currency matches the campaign's
   * reporting_currency). Atomically updates any matching
   * alm_campaign_recipients row to DONATED inside the same tx. Emits
   * alm.donation.received AFTER tx commits. Invalidates the Redis
   * campaign-raised cache.
   *
   * Authority — alumni may donate to themselves (donor_alumni_id ===
   * own profile id); staff + admin may record a donation on behalf of
   * any alumnus.
   */
  async donate(
    campaignId: string,
    donorAlumniId: string,
    input: CreateDonationDto,
    actor: ResolvedActor,
  ): Promise<DonationDto> {
    const campaign = await loadCampaignOrFail(this.tenantPrisma, campaignId);
    if (campaign.status !== 'ACTIVE') {
      throw new ConflictException(
        `Donations are only accepted on ACTIVE campaigns. This campaign is ${campaign.status}.`,
      );
    }
    const profile = await loadAlumniProfileOrFail(this.tenantPrisma, donorAlumniId);
    const isStaff = await hasStaffScope(this.permCheck, actor);
    if (!isStaff && profile.personId !== actor.personId) {
      throw new ForbiddenException(
        'Only staff or admin may record a donation on behalf of another alumnus.',
      );
    }

    // Compute amount_in_reporting_currency.
    let fx: number | null = input.fxRateAtDonation ?? null;
    let amountInReporting: number;
    if (input.currency === campaign.reportingCurrency) {
      amountInReporting = input.amount;
      fx = null;
    } else {
      if (fx === null || fx <= 0) {
        throw new BadRequestException(
          `fxRateAtDonation is required when donation currency (${input.currency}) differs from the campaign reporting currency (${campaign.reportingCurrency}).`,
        );
      }
      amountInReporting = Math.round(input.amount * fx * 100) / 100;
    }

    const donationId = generateId();
    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO alm_donations
           (id, campaign_id, donor_alumni_id, amount, currency, fx_rate_at_donation,
            amount_in_reporting_currency, payment_ref, stripe_payment_intent_id, donated_at, is_anonymous)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6, $7::numeric, $8, $9, now(), $10)`,
        donationId,
        campaignId,
        donorAlumniId,
        input.amount,
        input.currency,
        fx,
        amountInReporting,
        input.paymentRef ?? null,
        input.stripePaymentIntentId ?? null,
        input.isAnonymous ?? false,
      );

      // Atomically flip the matching campaign_recipient (if any) to
      // DONATED. ON CONFLICT not needed — recipient may not exist for
      // every donor (donations can land without prior outreach).
      await tx.$executeRawUnsafe(
        `UPDATE alm_campaign_recipients
         SET outreach_status = 'DONATED', donated_at = COALESCE(donated_at, now()), updated_at = now()
         WHERE campaign_id = $1::uuid AND alumni_id = $2::uuid`,
        campaignId,
        donorAlumniId,
      );

      const rows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, campaign_id::text AS campaign_id, donor_alumni_id::text AS donor_alumni_id,
         amount, currency, fx_rate_at_donation, amount_in_reporting_currency, payment_ref,
         stripe_payment_intent_id, donated_at, is_anonymous
         FROM alm_donations WHERE id = $1::uuid`,
        donationId,
      )) as Array<{
        id: string;
        campaign_id: string;
        donor_alumni_id: string;
        amount: string;
        currency: string;
        fx_rate_at_donation: string | null;
        amount_in_reporting_currency: string;
        payment_ref: string | null;
        stripe_payment_intent_id: string | null;
        donated_at: Date;
        is_anonymous: boolean;
      }>;
      return rows[0]!;
    });

    // Invalidate raised cache so the next read recomputes.
    await this.redis.cacheInvalidate(campaignRaisedKey(campaignId));

    // Emit alm.donation.received AFTER tx commits.
    try {
      await this.kafka.emit({
        topic: 'alm.donation.received',
        key: donationId,
        sourceModule: 'alumni',
        payload: {
          donationId,
          campaignId,
          schoolId: campaign.schoolId,
          donorAlumniId,
          amount: Number(result.amount),
          currency: result.currency,
          fxRateAtDonation:
            result.fx_rate_at_donation === null ? null : Number(result.fx_rate_at_donation),
          amountInReportingCurrency: Number(result.amount_in_reporting_currency),
          isAnonymous: result.is_anonymous,
          donatedAt: result.donated_at.toISOString(),
        },
      });
    } catch {
      // best-effort emit
    }

    return this.toDto(result, isStaff);
  }

  /** List donations on a campaign. Anonymous donations are stripped for non-staff readers. */
  async listForCampaign(campaignId: string, actor: ResolvedActor): Promise<DonationDto[]> {
    await loadCampaignOrFail(this.tenantPrisma, campaignId);
    const isStaff = await hasStaffScope(this.permCheck, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT d.id::text AS id, d.campaign_id::text AS campaign_id, d.donor_alumni_id::text AS donor_alumni_id,
         d.amount, d.currency, d.fx_rate_at_donation, d.amount_in_reporting_currency, d.payment_ref,
         d.stripe_payment_intent_id, d.donated_at, d.is_anonymous,
         (ip.first_name || ' ' || ip.last_name) AS donor_display_name
         FROM alm_donations d
         JOIN alm_alumni_profiles p ON p.id = d.donor_alumni_id
         LEFT JOIN platform.iam_person ip ON ip.id = p.person_id
         WHERE d.campaign_id = $1::uuid
         ORDER BY d.donated_at DESC`,
        campaignId,
      );
    })) as Array<{
      id: string;
      campaign_id: string;
      donor_alumni_id: string;
      amount: string;
      currency: string;
      fx_rate_at_donation: string | null;
      amount_in_reporting_currency: string;
      payment_ref: string | null;
      stripe_payment_intent_id: string | null;
      donated_at: Date;
      is_anonymous: boolean;
      donor_display_name: string | null;
    }>;
    return rows.map((r) => this.toDto(r, isStaff));
  }

  /**
   * Build a DonationDto with anonymous-donor stripping. Non-staff
   * readers see is_anonymous=true rows with donorAlumniId + donorDisplayName
   * cleared and the display name swapped for 'Anonymous'. Admin + staff
   * still see donor for auditing.
   */
  private toDto(
    r: {
      id: string;
      campaign_id: string;
      donor_alumni_id: string;
      amount: string;
      currency: string;
      fx_rate_at_donation: string | null;
      amount_in_reporting_currency: string;
      payment_ref: string | null;
      stripe_payment_intent_id: string | null;
      donated_at: Date;
      is_anonymous: boolean;
      donor_display_name?: string | null;
    },
    isStaff: boolean,
  ): DonationDto {
    const isAnonymous = r.is_anonymous;
    return {
      id: r.id,
      campaignId: r.campaign_id,
      donorAlumniId: isAnonymous && !isStaff ? null : r.donor_alumni_id,
      donorDisplayName: isAnonymous && !isStaff ? 'Anonymous' : (r.donor_display_name ?? null),
      amount: Number(r.amount),
      currency: r.currency,
      fxRateAtDonation: r.fx_rate_at_donation === null ? null : Number(r.fx_rate_at_donation),
      amountInReportingCurrency: Number(r.amount_in_reporting_currency),
      paymentRef: isStaff ? r.payment_ref : null,
      stripePaymentIntentId: isStaff ? r.stripe_payment_intent_id : null,
      donatedAt: r.donated_at.toISOString(),
      isAnonymous,
    };
  }
}
