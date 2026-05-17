import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import { TenantPrismaService } from '@shared/tenant';
import { processWithIdempotency, unwrapEnvelope } from '@shared/kafka';
import { NotificationQueueService } from '@modules/m40-communications';

const CONSUMER_GROUP = 'gl-reconciliation-alert-consumer';

interface GlReconciliationDiscrepancyPayload {
  reconciliationRunId: string;
  schoolId: string;
  checkType: string;
  discrepancyCount: number;
  status: 'CLEAN' | 'DISCREPANCIES_FOUND' | 'FAILED';
  severity: string;
  discrepancies: Array<Record<string, unknown>>;
  detectedAt: string;
}

/**
 * P2-H5 DEFECT 5 — wire the alert consumer for
 * `fin.gl_reconciliation.discrepancy`. Pre-fix the worker emitted the
 * event but no consumer fanned it out — SRE only saw the rpt_gl_recon
 * row if they looked at the dashboard. The consumer enqueues IN_APP +
 * EMAIL notifications via NotificationQueueService for every school
 * admin so the alert reaches an inbox within the 15-minute financial-
 * event SLA.
 *
 * Idempotency: the consumer uses processWithIdempotency keyed on the
 * Kafka event_id so redelivery does NOT re-enqueue. The
 * NotificationQueueService also dedups via Redis SET NX on the per-
 * (recipient, idempotencyKey) tuple — belt-and-braces.
 */
@Injectable()
export class GlReconciliationAlertConsumer implements OnModuleInit {
  private readonly logger = new Logger(GlReconciliationAlertConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly queue: NotificationQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.consumer.subscribe({
      groupId: CONSUMER_GROUP,
      topics: [prefixedTopic('fin.gl_reconciliation.discrepancy')],
      handler: (message) => this.handle(message),
    });
    this.logger.log('GlReconciliationAlertConsumer subscribed');
  }

  private async handle(message: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<GlReconciliationDiscrepancyPayload>(message, this.logger);
    if (!event) return;
    await processWithIdempotency(CONSUMER_GROUP, event, this.idempotency, this.logger, async () => {
      const payload = event.payload;
      const admins = await this.loadSchoolAdminAccounts(payload.schoolId);
      for (const accountId of admins) {
        await this.queue.enqueue({
          notificationType: 'finance.gl_reconciliation.alert',
          recipientAccountId: accountId,
          payload: {
            reconciliationRunId: payload.reconciliationRunId,
            checkType: payload.checkType,
            discrepancyCount: payload.discrepancyCount,
            status: payload.status,
            severity: payload.severity,
            detectedAt: payload.detectedAt,
            firstDiscrepancies: payload.discrepancies.slice(0, 5),
            deepLink: `/finance/reconciliation/${payload.reconciliationRunId}`,
          },
          idempotencyKey: 'gl-recon:' + payload.reconciliationRunId + ':' + accountId,
        });
      }
      // P2-H5 DEFECT 5: also write the urgent alert directly to
      // platform_audit_log so a downstream PagerDuty / alertmanager
      // poll catches the event even if no school admin happens to
      // hold sch-001:admin in this tenant.
      try {
        const platform = this.tenantPrisma.getPlatformClient();
        await platform.auditLog.create({
          data: {
            id: generateId(),
            actorType: 'SYSTEM',
            action: 'fin.gl_reconciliation.alert',
            actionCategory: 'MUTATE',
            entityType: 'rpt_gl_reconciliation',
            entityId: payload.reconciliationRunId,
            tenantId: payload.schoolId,
            metadata: {
              checkType: payload.checkType,
              status: payload.status,
              severity: payload.severity,
              discrepancyCount: payload.discrepancyCount,
            },
          },
        });
      } catch (err) {
        this.logger.warn(
          'gl-reconciliation-alert: audit-log write failed: ' + (err as Error).message,
        );
      }
    });
  }

  private async loadSchoolAdminAccounts(schoolId: string): Promise<string[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT eac.account_id::text AS account_id ' +
          'FROM platform.iam_effective_access_cache eac ' +
          'JOIN platform.iam_scope s ON s.id = eac.scope_id ' +
          'JOIN platform.iam_scope_type st ON st.id = s.scope_type_id ' +
          "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
          ' AND s.is_active = true ' +
          " AND ((st.code = 'SCHOOL' AND s.entity_id = $1::uuid) OR st.code = 'PLATFORM')",
        schoolId,
      ),
    );
    return rows.map((r) => r.account_id);
  }
}
