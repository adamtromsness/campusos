import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';
import { ClassSetService } from './class-set.service';

/**
 * P2-25a Step 4 — ClassSetOverdueWorker.
 *
 * Cron-style worker that walks every active school nightly and flips
 * ACTIVE or PARTIALLY_RETURNED rows whose due_date has passed and
 * still have unreturned copies to OVERDUE. The underlying UPDATE
 * filters by status so a second tick on the same row is a no-op
 * (OVERDUE rows fall out of the predicate). Mirrors the Cycle 5
 * HallPassOverdueWorker shape.
 *
 * Configurable via env:
 *   CLASS_SET_OVERDUE_DISABLED=1            fully disable
 *   CLASS_SET_OVERDUE_INTERVAL_MS           poll interval (default 6h)
 *   CLASS_SET_OVERDUE_WARMUP_MS             first-tick delay (default 60s)
 */
@Injectable()
export class ClassSetOverdueWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClassSetOverdueWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly classSets: ClassSetService,
  ) {}

  onModuleInit(): void {
    if (process.env.CLASS_SET_OVERDUE_DISABLED === '1') {
      this.logger.log('ClassSetOverdueWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.CLASS_SET_OVERDUE_INTERVAL_MS || 6 * 60 * 60 * 1000);
    const warmup = Number(process.env.CLASS_SET_OVERDUE_WARMUP_MS || 60_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('class-set-overdue tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('class-set-overdue tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'ClassSetOverdueWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
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
    } catch (e: unknown) {
      this.logger.warn(
        'class-set-overdue: could not load schools: ' +
          (e instanceof Error ? e.message : String(e)),
      );
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      const self = this;
      await runWithTenantContextAsync({ tenant }, async () => {
        const flipped = await self.classSets.sweepOverdueForCurrentTenant();
        if (flipped.length > 0) {
          self.logger.log(
            'class-set-overdue: tenant=' +
              tenant.subdomain +
              ' flipped ' +
              flipped.length +
              ' class set(s) to OVERDUE',
          );
        }
      });
    } catch (e: unknown) {
      this.logger.warn(
        'class-set-overdue: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          (e instanceof Error ? e.stack || e.message : String(e)),
      );
    }
  }
}
