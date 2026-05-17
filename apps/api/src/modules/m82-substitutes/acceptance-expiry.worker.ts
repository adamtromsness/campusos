import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant';

/**
 * AcceptanceExpiryWorker — P2-9b Step 6.
 *
 * Sweeps sub_job_notifications rows WHERE response='PENDING' AND
 * acceptance_window_expires_at <= now() and flips them to EXPIRED with
 * responded_at = now(). This is the proactive path for the acceptance
 * window — JobPostingService.accept also handles the reactive case
 * (when the substitute tries to accept after the window has passed).
 *
 * Uses the partial index sub_job_notifications_pending_expiry_idx as
 * the hot path. Idempotent — the UPDATE filters on response='PENDING'
 * so a second tick on the same row is a no-op.
 *
 * Configurable via env:
 *   SUB_EXPIRY_DISABLED=1            fully disable
 *   SUB_EXPIRY_INTERVAL_MS           poll interval (default 60s)
 *   SUB_EXPIRY_WARMUP_MS             first-tick delay (default 30s)
 */
@Injectable()
export class AcceptanceExpiryWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AcceptanceExpiryWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  onModuleInit(): void {
    if (process.env.SUB_EXPIRY_DISABLED === '1') {
      this.logger.log('AcceptanceExpiryWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.SUB_EXPIRY_INTERVAL_MS || 60_000);
    const warmup = Number(process.env.SUB_EXPIRY_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('acceptance-expiry tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('acceptance-expiry tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'AcceptanceExpiryWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip expiry tick — previous still running');
      return;
    }
    this.running = true;
    try {
      const schools = await this.loadActiveSchools();
      for (const school of schools) {
        await this.tickForTenant(school);
      }
    } finally {
      this.running = false;
    }
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      const client = this.tenantPrisma.getPlatformClient();
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      )) as Array<{
        id: string;
        subdomain: string;
        schema_name: string;
        organisation_id: string | null;
      }>;
      return rows.map((r) => ({
        schoolId: r.id,
        subdomain: r.subdomain,
        schemaName: r.schema_name,
        organisationId: r.organisation_id,
        isFrozen: false,
        planTier: 'STANDARD' as const,
        homeRegion: process.env.AWS_REGION ?? 'us-east-1',
      }));
    } catch (e: unknown) {
      this.logger.warn(
        'acceptance-expiry: could not load schools: ' + ((e as Error)?.message || String(e)),
      );
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      await runWithTenantContextAsync({ tenant }, async () => {
        const flipped = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
          // REVIEW-P2C9 BLOCKING 3: school-scope the expiry sweep.
          // The worker iterates platform.schools and enters each tenant
          // context, but the tenant schema may host multiple schools
          // (multi-school tenant pool — REVIEW-CYCLE7 ROUND 3). Without
          // a j.school_id = $1 predicate, School A's tick would expire
          // School B's pending notifications. We join through the parent
          // sub_job_postings row to scope the UPDATE to this school.
          const result = (await tx.$queryRawUnsafe(
            `UPDATE sub_job_notifications n
             SET response = 'EXPIRED', responded_at = now(), updated_at = now()
             FROM sub_job_postings j
             WHERE n.job_id = j.id
               AND j.school_id = $1::uuid
               AND n.response = 'PENDING'
               AND n.acceptance_window_expires_at <= now()
             RETURNING n.id`,
            tenant.schoolId,
          )) as Array<{ id: string }>;
          return result.length;
        });
        if (flipped > 0) {
          this.logger.log(
            'acceptance-expiry: tenant=' +
              tenant.subdomain +
              ' flipped ' +
              flipped +
              ' notification(s) to EXPIRED',
          );
        }
      });
    } catch (e: unknown) {
      this.logger.warn(
        'acceptance-expiry: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          ((e as Error)?.stack || (e as Error)?.message || String(e)),
      );
    }
  }
}
