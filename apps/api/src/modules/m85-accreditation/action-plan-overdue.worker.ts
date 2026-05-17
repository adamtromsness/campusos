import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { deterministicActionPlanOverdueEventId } from './event-ids';

/**
 * P2-23a — ActionPlanOverdueWorker.
 *
 * Periodic sweep across every active school. Per tenant:
 *   UPDATE acc_action_plans
 *   SET status='OVERDUE', updated_at=now()
 *   FROM (...rows where target_date < CURRENT_DATE
 *           AND status='IN_PROGRESS') ...
 *   RETURNING id, school_id, standard_id, responsible_party, target_date, goal
 *
 * For each flipped row, enqueues `acc.action_plan.overdue` to the
 * platform outbox INSIDE the same transaction so durable delivery
 * is guaranteed. The deterministic v5-shape event_id keys on
 * actionPlanId so a redelivered envelope from the
 * OutboxPublisherWorker hits the consumer-group idempotency claim
 * cleanly.
 *
 * Reuses the partial INDEX(target_date, status) WHERE status='IN_PROGRESS'
 * from migration 161 as the hot path. Returns the count of rows
 * flipped per tenant.
 *
 * Best-effort run: an exception in one tenant does not abort the
 * remaining tenants.
 *
 * Run cadence: every 6 hours by default. Configurable via
 * ACC_OVERDUE_SWEEP_INTERVAL_MS env var. Production deployments
 * should gate to a single replica via leader election (Phase 3 ops).
 */
@Injectable()
export class ActionPlanOverdueWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ActionPlanOverdueWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {
    this.intervalMs = Number(process.env.ACC_OVERDUE_SWEEP_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      // Do not auto-schedule under vitest
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('ActionPlanOverdueWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'ActionPlanOverdueWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 60000) +
        ' minutes',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sweep every active school's tenant schema for overdue action
   * plans. Returns total rows flipped across all tenants.
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
        const flipped = await this.tickForSchool(school.schemaName, school.id, school.subdomain);
        totalFlipped += flipped;
        if (flipped > 0) {
          this.logger.log(
            'ActionPlanOverdueWorker flipped ' +
              flipped +
              ' action plan(s) to OVERDUE in ' +
              school.schemaName,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('ActionPlanOverdueWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsFlipped: totalFlipped };
  }

  /**
   * Per-tenant flip + outbox enqueue inside one transaction. Public
   * so integration tests can drive it deterministically without
   * scheduling the timer.
   */
  async tickForSchool(schemaName: string, schoolId: string, subdomain: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      const flipped = (await client.$queryRawUnsafe(
        `UPDATE acc_action_plans
         SET status = 'OVERDUE', updated_at = now()
         WHERE school_id = $1::uuid
           AND status = 'IN_PROGRESS'
           AND target_date < CURRENT_DATE
         RETURNING id::text AS id, standard_id::text AS standard_id,
                   responsible_party::text AS responsible_party,
                   target_date::text AS target_date, goal`,
        schoolId,
      )) as Array<{
        id: string;
        standard_id: string;
        responsible_party: string;
        target_date: string;
        goal: string;
      }>;

      for (const row of flipped) {
        await this.outbox.enqueueInTx(client, {
          topic: 'acc.action_plan.overdue',
          payload: {
            actionPlanId: row.id,
            schoolId,
            standardId: row.standard_id,
            responsiblePartyEmployeeId: row.responsible_party,
            targetDate: row.target_date,
            goal: row.goal,
            sourceRefId: row.id,
          },
          sourceModule: 'accreditation',
          eventId: deterministicActionPlanOverdueEventId(row.id),
          tenantId: schoolId,
          tenantSubdomain: subdomain,
          key: row.id,
        });
      }

      return flipped.length;
    });
  }
}
