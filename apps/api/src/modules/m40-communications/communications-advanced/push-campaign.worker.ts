import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';
import { PushCampaignService } from './push-campaign.service';

const POLL_INTERVAL_MS_DEFAULT = 30_000; // 30s

/**
 * PushCampaignWorker — scheduled push notification dispatcher.
 *
 * Tick body per tenant:
 *   1. PushCampaignService.findRipe() returns every campaign in
 *      status=SCHEDULED whose scheduled_at has elapsed (limit 25).
 *   2. For each row: resolveAudienceSize() (today: count active
 *      device tokens for the school when audience_segment_id is
 *      null; Phase 2 wires the segment-scoped path); then
 *      dispatchScheduled() locks the row, validates SCHEDULED state,
 *      flips to SENT with sent_at populated atomically, and seeds
 *      msg_push_analytics with total_targeted.
 *   3. Production swap-in: between dispatchScheduled and the analytics
 *      seed the worker calls the push notification service (APNs,
 *      FCM, web push). Today the dispatch is a logged no-op so the
 *      schema-side state machine and analytics seed can be exercised
 *      end-to-end without the external service.
 *
 * Idempotency: dispatchScheduled refuses non-SCHEDULED rows so a
 * worker tick that catches a row already flipped to SENT by a sibling
 * worker is a no-op.
 */
@Injectable()
export class PushCampaignWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PushCampaignWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly campaigns: PushCampaignService,
  ) {}

  async onModuleInit(): Promise<void> {
    const intervalMs =
      Number(process.env.PUSH_CAMPAIGN_POLL_INTERVAL_MS) || POLL_INTERVAL_MS_DEFAULT;
    this.logger.log('PushCampaignWorker polling every ' + intervalMs + 'ms');
    this.scheduleNext(intervalMs);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Test seam — synchronous one-shot tick across every active tenant.
   * Used by smoke scripts so they don't wait for the next interval.
   */
  async pollOnceForTest(): Promise<void> {
    await this.tick();
  }

  private scheduleNext(intervalMs: number): void {
    if (this.stopped) return;
    const self = this;
    this.timer = setTimeout(async function () {
      try {
        await self.tick();
      } catch (e: unknown) {
        const m = (e as { stack?: string; message?: string }).stack ?? (e as Error).message;
        self.logger.error('Tick failed: ' + m);
      } finally {
        self.scheduleNext(intervalMs);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip push tick — previous tick still running');
      return;
    }
    this.running = true;
    try {
      const schools = await this.loadActiveSchools();
      for (const tenant of schools) {
        await this.tickForTenant(tenant);
      }
    } finally {
      this.running = false;
    }
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      const client = this.tenantPrisma.getPlatformClient();
      const rows = await client.$queryRawUnsafe<
        Array<{
          id: string;
          subdomain: string;
          schema_name: string;
          organisation_id: string | null;
        }>
      >(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      );
      return rows.map(function (r): TenantInfo {
        return {
          schoolId: r.id,
          subdomain: r.subdomain,
          schemaName: r.schema_name,
          organisationId: r.organisation_id,
          isFrozen: false,
          planTier: 'STANDARD',
          // Cycle 32 Step 6 — worker is regional; AWS_REGION is the
          // home region for any tenant it processes.
          homeRegion: process.env.AWS_REGION ?? 'us-east-1',
        };
      });
    } catch (e: unknown) {
      const m = (e as { message?: string }).message ?? String(e);
      this.logger.warn('Could not load schools: ' + m);
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    const self = this;
    try {
      await runWithTenantContextAsync({ tenant }, async function () {
        await self.dispatchForTenant(tenant);
      });
    } catch (e: unknown) {
      const m = (e as { stack?: string; message?: string }).stack ?? (e as Error).message;
      this.logger.warn('Push tenant tick failed for ' + tenant.subdomain + ': ' + m);
    }
  }

  private async dispatchForTenant(tenant: TenantInfo): Promise<void> {
    const ripe = await this.campaigns.findRipe(25);
    if (ripe.length === 0) return;
    for (const campaign of ripe) {
      try {
        const audienceSize = await this.campaigns.resolveAudienceSize(campaign.id);
        const dispatched = await this.campaigns.dispatchScheduled(campaign.id, audienceSize);
        if (dispatched === null) {
          this.logger.debug(
            'PushCampaignWorker skip campaign=' + campaign.id + ' — already flipped',
          );
          continue;
        }
        // Production swap-in: the actual push send happens here. For
        // dev/test the dispatch is logged. The push-notification-
        // service stub would iterate the audience device tokens and
        // call APNs/FCM per token, then emit msg.push.delivered
        // events the PushAnalyticsConsumer consumes.
        this.logger.log(
          'PushCampaignWorker dispatched campaign=' +
            campaign.id +
            ' audience=' +
            audienceSize +
            ' tenant=' +
            tenant.subdomain,
        );
      } catch (e: unknown) {
        const m = (e as { stack?: string; message?: string }).stack ?? (e as Error).message;
        this.logger.warn('PushCampaignWorker dispatch failed campaign=' + campaign.id + ': ' + m);
      }
    }
  }
}
