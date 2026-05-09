import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { ImmunisationComplianceService } from './immunisation-compliance.service';

/**
 * P2C3 Step 4 — ImmunisationComplianceWorker.
 *
 * Nightly cron-style worker that walks every active school and
 * recomputes hlth_immunisation_compliance for every enrolled student.
 *
 * Configurable via env:
 *   IMMUNISATION_COMPLIANCE_DISABLED=1   fully disable
 *   IMMUNISATION_COMPLIANCE_INTERVAL_MS  poll interval (default 24h)
 *   IMMUNISATION_COMPLIANCE_WARMUP_MS    first-tick delay (default 60s)
 *
 * Idempotency: the underlying ImmunisationComplianceService.computeForSchool
 * UPSERTs on (student_id, COALESCE(academic_year_id, sentinel)) so a
 * second run is a no-op (or refreshes last_computed_at).
 *
 * Newly-NON_COMPLIANT students emit hlth.immunisation.noncompliant
 * exactly once — on the next run the existing row's status is already
 * NON_COMPLIANT so the wasNonCompliant short-circuit fires.
 */
@Injectable()
export class ImmunisationComplianceWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ImmunisationComplianceWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly compliance: ImmunisationComplianceService,
  ) {}

  onModuleInit(): void {
    if (process.env.IMMUNISATION_COMPLIANCE_DISABLED === '1') {
      this.logger.log('ImmunisationComplianceWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.IMMUNISATION_COMPLIANCE_INTERVAL_MS || 24 * 60 * 60 * 1000);
    const warmup = Number(process.env.IMMUNISATION_COMPLIANCE_WARMUP_MS || 60_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('compliance tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('compliance tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'ImmunisationComplianceWorker scheduled (warmup=' +
        warmup +
        'ms interval=' +
        interval +
        'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip compliance tick — previous still running');
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
      this.logger.warn('compliance: could not load schools: ' + (e?.message || e));
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      const self = this;
      await runWithTenantContextAsync({ tenant }, async () => {
        const result = await self.compliance.computeForSchool(null);
        self.logger.log(
          'compliance: tenant=' +
            tenant.subdomain +
            ' computed=' +
            result.computed +
            ' newly_non_compliant=' +
            result.newlyNonCompliant,
        );
      });
    } catch (e: any) {
      this.logger.warn(
        'compliance: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          (e?.stack || e?.message || e),
      );
    }
  }
}
