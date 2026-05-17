import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getPlatformClient } from '@campusos/database';

/**
 * OverdueActionWorker (P2-14 Step 3).
 *
 * Periodic sweep across every active school. Per tenant:
 *   UPDATE sis_rj_agreement_actions SET status='OVERDUE', updated_at=now()
 *   WHERE status='PENDING' AND due_date < CURRENT_DATE
 *
 * Reuses the partial INDEX (due_date, status) WHERE status='PENDING'
 * from the Step 1 migration as the hot path. Returns the count of
 * rows flipped. Notification fan-out to the facilitator is the next
 * cycle's NotificationConsumer wiring — for now the schema state
 * change is the load-bearing observation.
 *
 * Best-effort run: an exception in one tenant does not abort the
 * remaining tenants.
 *
 * Run cadence: every 6 hours by default. Configurable via
 * BEH_OVERDUE_SWEEP_INTERVAL_MS env var. Production deployments should
 * gate to a single replica via leader election (Phase 3 ops).
 */
@Injectable()
export class OverdueActionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverdueActionWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(private readonly tenantPrisma: TenantPrismaService) {
    this.intervalMs = Number(process.env.BEH_OVERDUE_SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      // Do not auto-schedule under vitest
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('OverdueActionWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'OverdueActionWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 60000) +
        ' minutes',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sweep every active school's tenant schema for overdue agreement
   * actions. Returns total rows flipped across all tenants.
   */
  async runOnce(): Promise<{ tenantsScanned: number; rowsFlipped: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({
      where: { isActive: true },
    });

    let totalFlipped = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const flipped = await this.tenantPrisma.executeInExplicitSchema(
          school.schemaName,
          async (client) => {
            // REVIEW-P2C14 BLOCKING 4 — school-scope the sweep through the
            // parent conference. Without this predicate, a per-school worker
            // pass would flip every PENDING row in the tenant schema even
            // though the loop iterates per school. Belt-and-braces against
            // future shared-schema rearrangements.
            const rows = (await client.$queryRawUnsafe(
              'UPDATE sis_rj_agreement_actions a SET status = $1, updated_at = now() ' +
                'FROM sis_restorative_justice_conferences c ' +
                'WHERE c.id = a.conference_id ' +
                '  AND c.school_id = $2::uuid ' +
                '  AND a.status = $3 ' +
                '  AND a.due_date < CURRENT_DATE ' +
                'RETURNING a.id::text AS id, a.conference_id::text AS conference_id',
              'OVERDUE',
              school.id,
              'PENDING',
            )) as Array<{ id: string; conference_id: string }>;
            return rows.length;
          },
        );
        totalFlipped += flipped;
        if (flipped > 0) {
          this.logger.log(
            'OverdueActionWorker flipped ' +
              flipped +
              ' actions to OVERDUE in ' +
              school.schemaName,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('OverdueActionWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsFlipped: totalFlipped };
  }
}
