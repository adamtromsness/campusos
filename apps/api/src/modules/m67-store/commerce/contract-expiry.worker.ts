import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { deterministicContractExpiringEventId } from './event-ids';

/**
 * P2-29a — ContractExpiryWorker.
 *
 * Periodic sweep across every active school. Per tenant runs:
 *
 *   UPDATE prc_contracts
 *      SET status = 'EXPIRING', updated_at = now()
 *    WHERE school_id = $1::uuid
 *      AND status = 'ACTIVE'
 *      AND (end_date - (renewal_reminder_days || ' days')::interval) <= now()
 *    RETURNING id, contract_number, title, vendor_id, end_date,
 *              renewal_reminder_days
 *
 * For each flipped row enqueues `prc.contract.expiring` to the
 * platform outbox INSIDE the same transaction. The deterministic
 * v5-shape event_id keys on contractId — subsequent ticks see
 * status='EXPIRING' and the WHERE clause skips, so the emit fires
 * exactly once per contract per renewal cycle.
 *
 * Reuses the partial INDEX `prc_contracts_renewal_alert_idx
 * (school_id, end_date) WHERE status='ACTIVE'` from migration 175
 * as the hot path. Best-effort per tenant — an exception in one
 * tenant does not abort the rest.
 *
 * Run cadence: every 6 hours by default. Configurable via
 * PRC_CONTRACT_EXPIRY_INTERVAL_MS env var.
 */
@Injectable()
export class ContractExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractExpiryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {
    this.intervalMs = Number(process.env.PRC_CONTRACT_EXPIRY_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('ContractExpiryWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'ContractExpiryWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 1000 / 60) +
        ' minute(s)',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ tenantsScanned: number; rowsFlipped: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({ where: { isActive: true } });
    let totalFlipped = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const flipped = await this.tickForSchool(school.schemaName, school.id, school.subdomain);
        totalFlipped += flipped;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('ContractExpiryWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsFlipped: totalFlipped };
  }

  async tickForSchool(schemaName: string, schoolId: string, subdomain: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      const flipped = (await client.$queryRawUnsafe(
        `UPDATE prc_contracts
            SET status = 'EXPIRING', updated_at = now()
          WHERE school_id = $1::uuid
            AND status = 'ACTIVE'
            AND (end_date - (renewal_reminder_days || ' days')::interval) <= now()
          RETURNING id::text AS id, contract_number, title,
                    vendor_id::text AS vendor_id,
                    end_date::text AS end_date,
                    renewal_reminder_days,
                    total_value`,
        schoolId,
      )) as Array<{
        id: string;
        contract_number: string;
        title: string;
        vendor_id: string;
        end_date: string;
        renewal_reminder_days: number;
        total_value: string | number | null;
      }>;

      for (const row of flipped) {
        await this.outbox.enqueueInTx(client, {
          topic: 'prc.contract.expiring',
          payload: {
            contractId: row.id,
            schoolId,
            contractNumber: row.contract_number,
            title: row.title,
            vendorId: row.vendor_id,
            endDate: row.end_date,
            renewalReminderDays: Number(row.renewal_reminder_days),
            totalValue: row.total_value === null ? null : Number(row.total_value),
            sourceRefId: row.id,
          },
          sourceModule: 'commerce',
          eventId: deterministicContractExpiringEventId(row.id),
          tenantId: schoolId,
          tenantSubdomain: subdomain,
          key: row.id,
        });
      }

      if (flipped.length > 0) {
        this.logger.log(
          'ContractExpiryWorker flipped ' +
            flipped.length +
            ' contract(s) to EXPIRING in ' +
            schemaName,
        );
      }
      return flipped.length;
    });
  }
}
