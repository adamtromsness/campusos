import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreatePushCampaignDto,
  PushAnalyticsDto,
  PushCampaignDto,
  PushCampaignStatus,
  PushDeliveryEventDto,
  PushDeviceTokenDto,
  RegisterPushDeviceDto,
  UpdatePushCampaignDto,
} from '../messaging/dto/communications-advanced.dto';

interface CampaignRow {
  id: string;
  school_id: string;
  title: string;
  body: string;
  deep_link_url: string | null;
  image_s3_key: string | null;
  audience_segment_id: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  status: PushCampaignStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface AnalyticsRow {
  id: string;
  campaign_id: string;
  total_targeted: number;
  total_delivered: number;
  total_opened: number;
  total_clicked: number;
  delivery_rate: string | null;
  open_rate: string | null;
  click_rate: string | null;
  last_updated_at: string | null;
}

interface DeviceTokenRow {
  id: string;
  user_id: string;
  device_token: string;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  device_name: string | null;
  app_version: string | null;
  is_active: boolean;
  registered_at: string;
  last_used_at: string | null;
}

function campaignRowToDto(row: CampaignRow): PushCampaignDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    title: row.title,
    body: row.body,
    deepLinkUrl: row.deep_link_url,
    imageS3Key: row.image_s3_key,
    audienceSegmentId: row.audience_segment_id,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function analyticsRowToDto(row: AnalyticsRow): PushAnalyticsDto {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    totalTargeted: row.total_targeted,
    totalDelivered: row.total_delivered,
    totalOpened: row.total_opened,
    totalClicked: row.total_clicked,
    deliveryRate: row.delivery_rate !== null ? Number(row.delivery_rate) : null,
    openRate: row.open_rate !== null ? Number(row.open_rate) : null,
    clickRate: row.click_rate !== null ? Number(row.click_rate) : null,
    lastUpdatedAt: row.last_updated_at,
  };
}

function deviceTokenRowToDto(row: DeviceTokenRow): PushDeviceTokenDto {
  return {
    id: row.id,
    userId: row.user_id,
    deviceToken: row.device_token,
    platform: row.platform,
    deviceName: row.device_name,
    appVersion: row.app_version,
    isActive: row.is_active,
    registeredAt: row.registered_at,
    lastUsedAt: row.last_used_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e?.code === 'P2002') return true;
  if (e?.code === 'P2010' && e?.meta?.code === '23505') return true;
  if (typeof e?.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

/**
 * PushCampaignService — push notification campaigns + analytics +
 * device token registry. Three keystones:
 *
 *   1. Schedule keystone — DRAFT → SCHEDULED requires scheduled_at
 *      populated (schema-side msg_push_campaigns_scheduled_chk).
 *      Worker polls SCHEDULED rows whose scheduled_at has elapsed.
 *   2. Send keystone — SCHEDULED → SENT stamps sent_at atomically
 *      (schema-side msg_push_campaigns_sent_chk pins them together)
 *      and initialises msg_push_analytics with total_targeted.
 *   3. Analytics keystone — UPSERT on (campaign_id) means duplicate
 *      delivery callbacks land as updates, recomputing delivery_rate
 *      = delivered/total, open_rate = opened/delivered,
 *      click_rate = clicked/opened.
 */
@Injectable()
export class PushCampaignService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  // ── Campaign CRUD ────────────────────────────────────────────

  async list(args: { status?: PushCampaignStatus; limit?: number }): Promise<PushCampaignDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
      if (args.status) {
        const rows = await client.$queryRawUnsafe<CampaignRow[]>(
          this.selectCampaignBase() +
            'WHERE school_id = $1::uuid AND status = $2 ORDER BY created_at DESC LIMIT $3',
          tenant.schoolId,
          args.status,
          limit,
        );
        return rows.map(campaignRowToDto);
      }
      const rows = await client.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE school_id = $1::uuid ORDER BY created_at DESC LIMIT $2',
        tenant.schoolId,
        limit,
      );
      return rows.map(campaignRowToDto);
    });
  }

  async getById(id: string): Promise<PushCampaignDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Push campaign not found');
      return campaignRowToDto(rows[0]!);
    });
  }

  async create(input: CreatePushCampaignDto, actor: ResolvedActor): Promise<PushCampaignDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create push campaigns');
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C19 MAJOR 2: audienceSegmentId must belong to the
    // current tenant. Without this check a School A admin could
    // create a campaign that references a School B segment whose
    // resolve() returns School B users.
    if (input.audienceSegmentId) {
      await this.assertSegmentInCurrentSchool(input.audienceSegmentId, tenant.schoolId);
    }
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // Default status: DRAFT when no scheduled_at; SCHEDULED when caller
      // supplied scheduled_at AT create-time (send-later authoring).
      const status: PushCampaignStatus = input.scheduledAt ? 'SCHEDULED' : 'DRAFT';
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_push_campaigns ' +
          '(id, school_id, title, body, deep_link_url, image_s3_key, ' +
          ' audience_segment_id, scheduled_at, status, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, ' +
          ' $8::timestamptz, $9, $10::uuid)',
        id,
        tenant.schoolId,
        input.title,
        input.body,
        input.deepLinkUrl ?? null,
        input.imageS3Key ?? null,
        input.audienceSegmentId ?? null,
        input.scheduledAt ?? null,
        status,
        actor.accountId,
      );
      const rows = await tx.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return campaignRowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdatePushCampaignDto,
    actor: ResolvedActor,
  ): Promise<PushCampaignDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can edit push campaigns');
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C19 MAJOR 2: audienceSegmentId on patch must belong to
    // current tenant. The validation runs before the FOR UPDATE so a
    // bogus / cross-tenant id surfaces 400 before any lock.
    if (input.audienceSegmentId) {
      await this.assertSegmentInCurrentSchool(input.audienceSegmentId, tenant.schoolId);
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const existing = await tx.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (existing.length === 0) throw new NotFoundException('Push campaign not found');
      const row = existing[0]!;
      if (row.status === 'SENT' || row.status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot edit a campaign in ' + row.status + ' state — it is terminal',
        );
      }
      // Status transition validation:
      //   DRAFT/SCHEDULED → DRAFT: re-open for editing (clears scheduled_at unless re-supplied).
      //   DRAFT → SCHEDULED: requires scheduled_at to be populated (schema CHECK).
      //   SCHEDULED → CANCELLED: stop the worker from picking it up.
      if (input.status === 'SCHEDULED') {
        const effectiveScheduled =
          input.scheduledAt !== undefined ? input.scheduledAt : row.scheduled_at;
        if (!effectiveScheduled) {
          throw new BadRequestException(
            'Cannot transition to SCHEDULED without scheduled_at populated',
          );
        }
      }
      await tx.$executeRawUnsafe(
        'UPDATE msg_push_campaigns SET ' +
          'title = COALESCE($2, title), ' +
          'body = COALESCE($3, body), ' +
          'deep_link_url = $4, ' +
          'image_s3_key = $5, ' +
          'audience_segment_id = $6::uuid, ' +
          'scheduled_at = $7::timestamptz, ' +
          'status = COALESCE($8, status), ' +
          'updated_at = now() ' +
          'WHERE id = $1::uuid',
        id,
        input.title ?? null,
        input.body ?? null,
        input.deepLinkUrl !== undefined ? input.deepLinkUrl : row.deep_link_url,
        input.imageS3Key !== undefined ? input.imageS3Key : row.image_s3_key,
        input.audienceSegmentId !== undefined ? input.audienceSegmentId : row.audience_segment_id,
        input.scheduledAt !== undefined ? input.scheduledAt : row.scheduled_at,
        input.status ?? null,
      );
      const refreshed = await tx.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return campaignRowToDto(refreshed[0]!);
    });
  }

  /**
   * PushCampaignWorker dispatch path. Locks the row, validates
   * SCHEDULED + scheduled_at elapsed, flips to SENT with sent_at
   * stamped atomically (sent_chk lockstep), and seeds analytics with
   * total_targeted = resolved audience size. Returns the post-flip
   * row so the worker can log per-campaign. Idempotent: a redelivered
   * worker tick for a row already in SENT state returns null.
   */
  async dispatchScheduled(
    campaignId: string,
    audienceSize: number,
  ): Promise<PushCampaignDto | null> {
    // REVIEW-P2C19 BLOCKING 4: school-scope the worker dispatch. The
    // worker iterates active tenants and resets the search_path for
    // each one, but a SCHEDULED row keyed by id alone could
    // theoretically belong to a different tenant within the same
    // schema. Adding school_id to the lock keeps the dispatch within
    // the current tenant boundary.
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const rows = await tx.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        campaignId,
        tenant.schoolId,
      );
      if (rows.length === 0) return null;
      const row = rows[0]!;
      if (row.status !== 'SCHEDULED') return null;
      await tx.$executeRawUnsafe(
        'UPDATE msg_push_campaigns SET status = $2, sent_at = now(), updated_at = now() ' +
          'WHERE id = $1::uuid AND school_id = $3::uuid',
        campaignId,
        'SENT',
        tenant.schoolId,
      );
      const analyticsId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO msg_push_analytics ' +
          '(id, campaign_id, total_targeted, total_delivered, total_opened, ' +
          ' total_clicked, last_updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, 0, 0, 0, now()) ' +
          'ON CONFLICT (campaign_id) DO NOTHING',
        analyticsId,
        campaignId,
        audienceSize,
      );
      const refreshed = await tx.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() + 'WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        campaignId,
        tenant.schoolId,
      );
      return campaignRowToDto(refreshed[0]!);
    });
  }

  /**
   * Worker poll: rows ripe for dispatch (status=SCHEDULED AND
   * scheduled_at <= now()) for the current tenant. The PushCampaignWorker
   * iterates the returned rows and calls dispatchScheduled per row.
   *
   * REVIEW-P2C19 BLOCKING 4: scope by tenant.schoolId so a worker
   * pass for School A never picks up School B's scheduled campaigns.
   */
  async findRipe(limit = 25): Promise<PushCampaignDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<CampaignRow[]>(
        this.selectCampaignBase() +
          "WHERE school_id = $1::uuid AND status = 'SCHEDULED' AND scheduled_at <= now() " +
          'ORDER BY scheduled_at LIMIT $2',
        tenant.schoolId,
        limit,
      );
      return rows.map(campaignRowToDto);
    });
  }

  // ── Analytics ────────────────────────────────────────────────

  async getAnalytics(campaignId: string): Promise<PushAnalyticsDto | null> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<AnalyticsRow[]>(
        this.selectAnalyticsBase() + 'WHERE campaign_id = $1::uuid LIMIT 1',
        campaignId,
      );
      if (rows.length === 0) return null;
      return analyticsRowToDto(rows[0]!);
    });
  }

  /**
   * Used by PushAnalyticsWorker on every push delivery callback.
   * Additive update — delivered/opened/clicked counters bump and the
   * rates recompute.
   *
   * REVIEW-P2C19 BLOCKING 5: crash-safe under redelivery. The
   * additive update writes a contribution-ledger row in the same
   * tenant tx, keyed by UNIQUE(consumer_group, source_event_id,
   * campaign_id). A redelivered event raises 23505 on the second pass
   * and the additive bump is skipped — we return the current
   * analytics row instead of double-counting. The
   * processWithIdempotency claim outside this method is the outer
   * layer; the ledger is the schema-side guarantee that survives a
   * crash between this method completing and the claim landing.
   *
   * `sourceEventId` and `consumerGroup` are optional only for the
   * direct admin-trigger path (no consumer context). The
   * PushAnalyticsConsumer always supplies both.
   */
  async recordDelivery(
    event: PushDeliveryEventDto,
    consumerGroup: string | null = null,
    sourceEventId: string | null = null,
  ): Promise<PushAnalyticsDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const existing = await tx.$queryRawUnsafe<AnalyticsRow[]>(
        this.selectAnalyticsBase() + 'WHERE campaign_id = $1::uuid FOR UPDATE',
        event.campaignId,
      );
      if (existing.length === 0) {
        throw new NotFoundException(
          'Analytics row not found — call dispatchScheduled before recording deliveries',
        );
      }

      // REVIEW-P2C19 BLOCKING 5 contribution ledger claim. We claim the
      // (group, event, campaign) tuple BEFORE the additive bump so a
      // 23505 short-circuits the work. The claim row records the per-
      // event deltas for audit + replay.
      if (consumerGroup && sourceEventId) {
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO msg_push_analytics_contributions ' +
              '(id, consumer_group, source_event_id, campaign_id, ' +
              ' delivered_delta, opened_delta, clicked_delta) ' +
              'VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7)',
            generateId(),
            consumerGroup,
            sourceEventId,
            event.campaignId,
            event.delivered ?? 0,
            event.opened ?? 0,
            event.clicked ?? 0,
          );
        } catch (err) {
          if (isUniqueViolation(err)) {
            // Already claimed — skip the additive bump and return the
            // current analytics row. This is the crash-safe path.
            return analyticsRowToDto(existing[0]!);
          }
          throw err;
        }
      }

      const row = existing[0]!;
      const total = row.total_targeted;
      const delivered = row.total_delivered + (event.delivered ?? 0);
      const opened = row.total_opened + (event.opened ?? 0);
      const clicked = row.total_clicked + (event.clicked ?? 0);
      const deliveryRate = total > 0 ? Math.min(delivered / total, 1) : null;
      const openRate = delivered > 0 ? Math.min(opened / delivered, 1) : null;
      const clickRate = opened > 0 ? Math.min(clicked / opened, 1) : null;
      await tx.$executeRawUnsafe(
        'UPDATE msg_push_analytics SET ' +
          'total_delivered = $2, total_opened = $3, total_clicked = $4, ' +
          'delivery_rate = $5, open_rate = $6, click_rate = $7, ' +
          'last_updated_at = now() WHERE campaign_id = $1::uuid',
        event.campaignId,
        delivered,
        opened,
        clicked,
        deliveryRate,
        openRate,
        clickRate,
      );
      const refreshed = await tx.$queryRawUnsafe<AnalyticsRow[]>(
        this.selectAnalyticsBase() + 'WHERE campaign_id = $1::uuid LIMIT 1',
        event.campaignId,
      );
      return analyticsRowToDto(refreshed[0]!);
    });
  }

  // ── Device tokens ────────────────────────────────────────────

  async registerDevice(
    input: RegisterPushDeviceDto,
    actor: ResolvedActor,
  ): Promise<PushDeviceTokenDto> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      // UNIQUE(user_id, device_token) — re-register is an UPDATE.
      const existing = await tx.$queryRawUnsafe<DeviceTokenRow[]>(
        this.selectDeviceBase() + 'WHERE user_id = $1::uuid AND device_token = $2 LIMIT 1',
        actor.accountId,
        input.deviceToken,
      );
      if (existing.length > 0) {
        await tx.$executeRawUnsafe(
          'UPDATE msg_push_device_tokens SET ' +
            'platform = $3, device_name = $4, app_version = $5, ' +
            'is_active = true, last_used_at = now(), updated_at = now() ' +
            'WHERE user_id = $1::uuid AND device_token = $2',
          actor.accountId,
          input.deviceToken,
          input.platform,
          input.deviceName ?? null,
          input.appVersion ?? null,
        );
        const refreshed = await tx.$queryRawUnsafe<DeviceTokenRow[]>(
          this.selectDeviceBase() + 'WHERE user_id = $1::uuid AND device_token = $2 LIMIT 1',
          actor.accountId,
          input.deviceToken,
        );
        return deviceTokenRowToDto(refreshed[0]!);
      }
      const id = generateId();
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO msg_push_device_tokens ' +
            '(id, user_id, device_token, platform, device_name, app_version, ' +
            ' registered_at, last_used_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now(), now())',
          id,
          actor.accountId,
          input.deviceToken,
          input.platform,
          input.deviceName ?? null,
          input.appVersion ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('Device token already registered for this user');
        }
        throw err;
      }
      const rows = await tx.$queryRawUnsafe<DeviceTokenRow[]>(
        this.selectDeviceBase() + 'WHERE id = $1::uuid LIMIT 1',
        id,
      );
      return deviceTokenRowToDto(rows[0]!);
    });
  }

  async listOwnDevices(actor: ResolvedActor): Promise<PushDeviceTokenDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<DeviceTokenRow[]>(
        this.selectDeviceBase() + 'WHERE user_id = $1::uuid ORDER BY registered_at DESC',
        actor.accountId,
      );
      return rows.map(deviceTokenRowToDto);
    });
  }

  async deregisterDevice(id: string, actor: ResolvedActor): Promise<void> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx: PrismaClient) => {
      const rows = await tx.$queryRawUnsafe<DeviceTokenRow[]>(
        this.selectDeviceBase() + 'WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Device token not found');
      const row = rows[0]!;
      if (row.user_id !== actor.accountId && !actor.isSchoolAdmin) {
        throw new ForbiddenException('Can only deregister your own device tokens');
      }
      await tx.$executeRawUnsafe('DELETE FROM msg_push_device_tokens WHERE id = $1::uuid', id);
    });
  }

  /**
   * Resolve the audience size for a campaign.
   *
   * REVIEW-P2C19 BLOCKING 4: the school-wide path counts only device
   * tokens belonging to users with a current-school projection in
   * sis_students (via platform_students.person_id), sis_guardians, or
   * hr_employees. Counting every active token in the tenant schema is
   * wrong in a future shared-tenant model and is materially wrong any
   * time the schema holds historical/orphaned tokens — total_targeted
   * has to reflect the real audience for the rate divisors to make
   * sense.
   *
   * The segment-scoped path is forwarded to BroadcastSegmentService
   * in a future cycle.
   */
  async resolveAudienceSize(campaignId: string): Promise<number> {
    const campaign = await this.getById(campaignId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      if (campaign.audienceSegmentId === null) {
        const rows = await client.$queryRawUnsafe<Array<{ count: string }>>(
          'SELECT COUNT(DISTINCT t.id)::text AS count ' +
            'FROM msg_push_device_tokens t ' +
            'JOIN platform.platform_users pu ON pu.id = t.user_id ' +
            'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
            'WHERE t.is_active = true AND ( ' +
            '  EXISTS ( ' +
            '    SELECT 1 FROM sis_students s ' +
            '    JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '    WHERE s.school_id = $1::uuid AND ps.person_id = ip.id' +
            '  ) OR EXISTS ( ' +
            '    SELECT 1 FROM sis_guardians g WHERE g.school_id = $1::uuid AND g.person_id = ip.id' +
            '  ) OR EXISTS ( ' +
            '    SELECT 1 FROM hr_employees e WHERE e.school_id = $1::uuid AND e.person_id = ip.id' +
            '  ) ' +
            ')',
          tenant.schoolId,
        );
        return Number(rows[0]!.count);
      }
      // Segment-scoped audience resolution lives in the
      // BroadcastSegmentService — the worker plugs it in once Phase 2
      // wires the cross-service call. Today we return zero so the
      // worker dispatches but the analytics row shows total_targeted=0.
      return 0;
    });
  }

  // ── Internals ────────────────────────────────────────────────

  /**
   * REVIEW-P2C19 MAJOR 2 — validates that the supplied segment id
   * belongs to the calling tenant school. The 400 carries the offending
   * id for client debugging.
   */
  private async assertSegmentInCurrentSchool(segmentId: string, schoolId: string): Promise<void> {
    return this.tenantPrisma.executeInTenantContext(async (client: PrismaClient) => {
      const rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM msg_broadcast_segments ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        segmentId,
        schoolId,
      );
      if (rows.length === 0) {
        throw new BadRequestException(
          'audienceSegmentId does not match a broadcast segment in this school: ' + segmentId,
        );
      }
    });
  }

  private selectCampaignBase(): string {
    return (
      'SELECT id::text AS id, school_id::text AS school_id, title, body, ' +
      'deep_link_url, image_s3_key, audience_segment_id::text AS audience_segment_id, ' +
      'scheduled_at::text AS scheduled_at, sent_at::text AS sent_at, status, ' +
      'created_by::text AS created_by, created_at::text AS created_at, ' +
      'updated_at::text AS updated_at FROM msg_push_campaigns '
    );
  }

  private selectAnalyticsBase(): string {
    return (
      'SELECT id::text AS id, campaign_id::text AS campaign_id, ' +
      'total_targeted, total_delivered, total_opened, total_clicked, ' +
      'delivery_rate::text AS delivery_rate, open_rate::text AS open_rate, ' +
      'click_rate::text AS click_rate, last_updated_at::text AS last_updated_at ' +
      'FROM msg_push_analytics '
    );
  }

  private selectDeviceBase(): string {
    return (
      'SELECT id::text AS id, user_id::text AS user_id, device_token, ' +
      'platform, device_name, app_version, is_active, ' +
      'registered_at::text AS registered_at, last_used_at::text AS last_used_at ' +
      'FROM msg_push_device_tokens '
    );
  }
}
