import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';
import { CatalogueImportService } from './catalogue-import.service';

/**
 * P2-25a Step 5 — CatalogueImportWorker.
 *
 * Cron-style worker that walks every active school every minute and
 * processes any QUEUED lib_catalogue_import_jobs rows. The
 * CatalogueImportService is the canonical worker — this class is the
 * scheduler that runs it under the right tenant context.
 *
 * Configurable via env:
 *   LIB_IMPORT_WORKER_DISABLED=1            fully disable
 *   LIB_IMPORT_WORKER_INTERVAL_MS           poll interval (default 60s)
 *   LIB_IMPORT_WORKER_WARMUP_MS             first-tick delay (default 30s)
 */
@Injectable()
export class CatalogueImportWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(CatalogueImportWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly imports: CatalogueImportService,
  ) {}

  onModuleInit(): void {
    if (process.env.LIB_IMPORT_WORKER_DISABLED === '1') {
      this.logger.log('CatalogueImportWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.LIB_IMPORT_WORKER_INTERVAL_MS || 60_000);
    const warmup = Number(process.env.LIB_IMPORT_WORKER_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('catalogue-import tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('catalogue-import tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'CatalogueImportWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip import tick — previous still running');
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
        'catalogue-import: could not load schools: ' + (e instanceof Error ? e.message : String(e)),
      );
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      const self = this;
      await runWithTenantContextAsync({ tenant }, async () => {
        const ids = await self.imports.listQueuedForCurrentTenant();
        if (ids.length > 0) {
          self.logger.log(
            'catalogue-import: tenant=' +
              tenant.subdomain +
              ' processing ' +
              ids.length +
              ' QUEUED job(s)',
          );
        }
        for (const id of ids) {
          await self.imports.processQueuedJob(id);
        }
      });
    } catch (e: unknown) {
      this.logger.warn(
        'catalogue-import: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          (e instanceof Error ? e.stack || e.message : String(e)),
      );
    }
  }
}
