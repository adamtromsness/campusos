import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { HallPassService } from './hall-pass.service';

/**
 * P2-7a Step 2 — HallPassOverdueWorker.
 *
 * Cron-style worker that walks every active school once per minute and
 * flips ACTIVE rows whose expected_return_at has passed to OVERDUE.
 * Per row that flips, HallPassService.sweepOverdueForCurrentTenant
 * emits cls.hall_pass.overdue with the documented payload contract for
 * downstream notification fan-out.
 *
 * Configurable via env:
 *   HALL_PASS_OVERDUE_DISABLED=1            fully disable
 *   HALL_PASS_OVERDUE_INTERVAL_MS           poll interval (default 60s)
 *   HALL_PASS_OVERDUE_WARMUP_MS             first-tick delay (default 30s)
 *
 * Idempotency: the underlying UPDATE filters on status='ACTIVE' so a
 * second tick on the same row is a no-op (status flipped once, the row
 * is OVERDUE on the next pass and excluded from the predicate). Re-emit
 * on a future ACTIVE -> OVERDUE flip is intentional — there is no
 * deterministic event_id reuse here because the OVERDUE moment is
 * inherently new each time.
 */
@Injectable()
export class HallPassOverdueWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HallPassOverdueWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly passes: HallPassService,
  ) {}

  onModuleInit(): void {
    if (process.env.HALL_PASS_OVERDUE_DISABLED === '1') {
      this.logger.log('HallPassOverdueWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.HALL_PASS_OVERDUE_INTERVAL_MS || 60_000);
    const warmup = Number(process.env.HALL_PASS_OVERDUE_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('hall-pass-overdue tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('hall-pass-overdue tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'HallPassOverdueWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip overdue tick — previous still running');
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
    } catch (e: any) {
      this.logger.warn('hall-pass-overdue: could not load schools: ' + (e?.message || e));
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      const self = this;
      await runWithTenantContextAsync({ tenant }, async () => {
        const flipped = await self.passes.sweepOverdueForCurrentTenant();
        if (flipped.length > 0) {
          self.logger.log(
            'hall-pass-overdue: tenant=' +
              tenant.subdomain +
              ' flipped ' +
              flipped.length +
              ' pass(es) to OVERDUE',
          );
        }
      });
    } catch (e: any) {
      this.logger.warn(
        'hall-pass-overdue: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          (e?.stack || e?.message || e),
      );
    }
  }
}
