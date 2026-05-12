import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantAccessService } from './services/tenant-access.service';

/**
 * P2-21b — TenantAccessExpiryWorker.
 *
 * Sweeps expired tenant-access grants every 5 minutes and stamps
 * revoked_at on rows whose expires_at < now() AND revoked_at is
 * still NULL. The schema-side duration_chk caps grants at 4 hours
 * from granted_at; this worker is the operational tail that flips
 * the audit-visible revoked_at on schedule so the admin dashboard's
 * "active grants" panel never shows a stale row.
 *
 * Env knobs:
 *   OPS_TENANT_ACCESS_DISABLED=1     fully disable
 *   OPS_TENANT_ACCESS_INTERVAL_MS    poll interval (default 5min)
 *   OPS_TENANT_ACCESS_WARMUP_MS      first-tick delay (default 30s)
 *
 * The sweep is idempotent — a second tick on already-stamped rows is
 * a no-op via the WHERE clause.
 */
@Injectable()
export class TenantAccessExpiryWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TenantAccessExpiryWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  // 5 minutes per ADR-072.
  private static readonly DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

  constructor(private readonly tenantAccess: TenantAccessService) {}

  onModuleInit(): void {
    if (process.env.OPS_TENANT_ACCESS_DISABLED === '1') {
      this.logger.log('TenantAccessExpiryWorker disabled via env.');
      return;
    }
    const interval = Number(
      process.env.OPS_TENANT_ACCESS_INTERVAL_MS || TenantAccessExpiryWorker.DEFAULT_INTERVAL_MS,
    );
    const warmup = Number(process.env.OPS_TENANT_ACCESS_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error(
          'tenant-access expiry tick failed: ' + ((e as Error).stack ?? (e as Error).message),
        ),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error(
            'tenant-access expiry tick failed: ' + ((e as Error).stack ?? (e as Error).message),
          ),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'TenantAccessExpiryWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip tenant-access expiry tick — previous still running');
      return;
    }
    this.running = true;
    try {
      const count = await this.tenantAccess.sweepExpired();
      if (count > 0) {
        this.logger.log(`[ops-tenant-access] swept ${count} expired grant(s)`);
      } else {
        this.logger.debug(`[ops-tenant-access] no expired grants to sweep`);
      }
    } finally {
      this.running = false;
    }
  }
}
