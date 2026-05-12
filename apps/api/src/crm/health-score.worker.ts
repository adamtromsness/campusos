import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { HealthScoreService } from './services/health-score.service';

/**
 * P2-21a — HealthScoreWorker.
 *
 * Computes a weekly health snapshot for every active CRM account.
 * Default cadence: 7 days. The UNIQUE(account_id, score_date) on
 * crm_health_scores makes same-day re-runs idempotent (UPSERT in
 * HealthScoreService.recordScore).
 *
 * Env knobs:
 *   CRM_HEALTH_DISABLED=1            fully disable
 *   CRM_HEALTH_INTERVAL_MS           poll interval (default 7d)
 *   CRM_HEALTH_WARMUP_MS             first-tick delay (default 30s)
 *
 * The worker walks accounts in status (PROSPECT, PILOT, ONBOARDING,
 * ACTIVE) — accounts in CHURNED / SUSPENDED do not get scored
 * because they're either gone or being recovered manually.
 */
@Injectable()
export class HealthScoreWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HealthScoreWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  // 7 days. Weekly cadence per the cycle plan.
  private static readonly DEFAULT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

  constructor(
    private readonly platform: PrismaClient,
    private readonly healthScores: HealthScoreService,
  ) {}

  onModuleInit(): void {
    if (process.env.CRM_HEALTH_DISABLED === '1') {
      this.logger.log('HealthScoreWorker disabled via env.');
      return;
    }
    const interval = Number(
      process.env.CRM_HEALTH_INTERVAL_MS || HealthScoreWorker.DEFAULT_INTERVAL_MS,
    );
    const warmup = Number(process.env.CRM_HEALTH_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error(
          'health-score tick failed: ' + ((e as Error).stack ?? (e as Error).message),
        ),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error(
            'health-score tick failed: ' + ((e as Error).stack ?? (e as Error).message),
          ),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'HealthScoreWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip health-score tick — previous still running');
      return;
    }
    this.running = true;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const accounts = await this.platform.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM platform.crm_accounts
         WHERE status IN ('PROSPECT', 'PILOT', 'ONBOARDING', 'ACTIVE')`,
      );
      let computed = 0;
      let failed = 0;
      for (const a of accounts) {
        try {
          await this.healthScores.computeForAccount(a.id, today);
          computed++;
        } catch (e: unknown) {
          failed++;
          this.logger.warn(`health-score compute failed for ${a.id}: ${(e as Error).message}`);
        }
      }
      this.logger.log(
        `[crm-health] week=${today} accounts=${accounts.length} computed=${computed} failed=${failed}`,
      );
    } finally {
      this.running = false;
    }
  }
}
