import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PostingService } from './posting.service';
import type { BatchType, CreateGLEntryLineDto } from './dto/finance.dto';

/**
 * GLConsumer (Cycle 26 Step 6).
 *
 * The DOUBLE-ENTRY KEYSTONE consumer that closes the M84 → M83
 * integration contract. Subscribes to the 5 `dev.pay.*` topics
 * (or whatever `KAFKA_TOPIC_ENV` resolves to) under group
 * `gl-consumer` and on every payment event constructs + posts a
 * balanced journal batch via PostingService.createAndPost(). The
 * `fin_journal_batches.source_event_id UNIQUE` constraint provides
 * Kafka redelivery idempotency — a second post with the same
 * eventId silently returns the existing batch.
 *
 * Topics + GL mapping:
 *
 *   pay.payment.received  →  DEBIT 1000 Cash + CREDIT 4000 Tuition
 *                            (or appropriate revenue account based
 *                            on the source — Cycle 26 hard-codes
 *                            tuition; Phase 2 adds a per-fee-schedule
 *                            account_id mapping table).
 *   pay.invoice.created   →  DEBIT 1100 AR + CREDIT 4000 Tuition
 *                            (records the receivable when the school
 *                            sends the invoice, before the payment
 *                            lands).
 *   pay.refund.issued     →  DEBIT 4000 Tuition + CREDIT 1000 Cash
 *                            (reverses the original revenue + cash
 *                            recognition on a refund).
 *   pay.credit_note.issued + pay.debt.written_off — schema-ready,
 *   skipped this cycle (Cycle 6 doesn't emit either yet).
 */

interface PaymentReceivedPayload {
  paymentId: string;
  invoiceId: string;
  familyAccountId: string;
  amount: number | string;
  paymentMethod: string;
  invoiceStatus: string;
  totalAmount?: number | string;
  amountPaid?: number | string;
  paidAt: string;
  schoolId?: string;
}

interface InvoiceCreatedPayload {
  invoiceId: string;
  familyAccountId: string;
  totalAmount: number | string;
  schoolId?: string;
}

interface RefundIssuedPayload {
  refundId: string;
  paymentId: string;
  familyAccountId: string;
  amount: number | string;
  refundCategory: string;
  schoolId?: string;
}

const CONSUMER_GROUP = 'gl-consumer';

@Injectable()
export class GLConsumer implements OnModuleInit {
  private readonly logger = new Logger(GLConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly posting: PostingService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [
        prefixedTopic('pay.payment.received'),
        prefixedTopic('pay.invoice.created'),
        prefixedTopic('pay.refund.issued'),
        prefixedTopic('pay.credit_note.issued'),
        prefixedTopic('pay.debt.written_off'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
    this.logger.log(`Subscribed to 5 dev.pay.* topics under group ${CONSUMER_GROUP}`);
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<unknown>(msg, this.logger);
    if (!event) return;
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event,
      this.idempotency,
      this.logger,
      async function () {
        await self.process(msg.topic, event);
      },
    );
  }

  private async process(topic: string, event: UnwrappedEvent<unknown>): Promise<void> {
    // Route on the un-prefixed topic name — strip the env prefix.
    const prefix = process.env.KAFKA_TOPIC_ENV || 'dev';
    const logical = topic.startsWith(`${prefix}.`) ? topic.slice(prefix.length + 1) : topic;

    // Resolve the chart of accounts mapping once per event.
    const accounts = await this.loadAccountMapping();
    if (!accounts) {
      this.logger.warn(
        `[${CONSUMER_GROUP}] cannot resolve canonical accounts (Cash + Tuition + AR) for tenant ${event.tenant.schoolId} — drop event`,
      );
      return;
    }
    const cashAccount = accounts.cash;
    const tuitionAccount = accounts.tuition;
    const arAccount = accounts.ar;
    const fundId = accounts.fundId;

    // Resolve a synthetic CFO-equivalent actor for the GL post —
    // the PostingService requires an employee actor. We pick the
    // first ACTIVE hr_employee in the tenant.
    const cfo = await this.resolveSyntheticActor();
    if (!cfo) {
      this.logger.warn(
        `[${CONSUMER_GROUP}] no hr_employees row available for tenant ${event.tenant.schoolId} — drop event`,
      );
      return;
    }

    const eventId = event.eventId;
    const batchNumber = `AUTO-${eventId.slice(0, 8).toUpperCase()}`;
    let entries: CreateGLEntryLineDto[];
    let batchType: BatchType;
    let description: string;
    let referenceType: string;
    let referenceId: string;

    if (logical === 'pay.payment.received') {
      const p = event.payload as PaymentReceivedPayload;
      const amt = Number(p.amount);
      if (!amt || amt <= 0) {
        this.logger.warn(`[${CONSUMER_GROUP}] payment.received with non-positive amount — drop`);
        return;
      }
      batchType = 'AUTO_PAYMENT';
      description = `Family payment $${amt.toFixed(2)} (paymentId=${p.paymentId.slice(0, 8)})`;
      referenceType = 'pay_payments';
      referenceId = p.paymentId;
      entries = [
        {
          accountId: cashAccount,
          fundId,
          debit: amt,
          credit: 0,
          description: 'Cash received from family',
          referenceType,
          referenceId,
        },
        {
          accountId: tuitionAccount,
          fundId,
          debit: 0,
          credit: amt,
          description: 'Tuition revenue earned',
          referenceType,
          referenceId,
        },
      ];
    } else if (logical === 'pay.invoice.created') {
      const p = event.payload as InvoiceCreatedPayload;
      const amt = Number(p.totalAmount);
      if (!amt || amt <= 0) {
        this.logger.warn(`[${CONSUMER_GROUP}] invoice.created with non-positive total — drop`);
        return;
      }
      batchType = 'AUTO_INVOICE';
      description = `Invoice issued $${amt.toFixed(2)} (invoiceId=${p.invoiceId.slice(0, 8)})`;
      referenceType = 'pay_invoices';
      referenceId = p.invoiceId;
      entries = [
        {
          accountId: arAccount,
          fundId,
          debit: amt,
          credit: 0,
          description: 'Account receivable created',
          referenceType,
          referenceId,
        },
        {
          accountId: tuitionAccount,
          fundId,
          debit: 0,
          credit: amt,
          description: 'Tuition revenue accrued',
          referenceType,
          referenceId,
        },
      ];
    } else if (logical === 'pay.refund.issued') {
      const p = event.payload as RefundIssuedPayload;
      const amt = Number(p.amount);
      if (!amt || amt <= 0) {
        this.logger.warn(`[${CONSUMER_GROUP}] refund.issued with non-positive amount — drop`);
        return;
      }
      batchType = 'AUTO_REFUND';
      description = `Refund issued $${amt.toFixed(2)} (refundId=${p.refundId.slice(0, 8)})`;
      referenceType = 'pay_refunds';
      referenceId = p.refundId;
      entries = [
        {
          accountId: tuitionAccount,
          fundId,
          debit: amt,
          credit: 0,
          description: 'Tuition revenue reversal',
          referenceType,
          referenceId,
        },
        {
          accountId: cashAccount,
          fundId,
          debit: 0,
          credit: amt,
          description: 'Cash refund to family',
          referenceType,
          referenceId,
        },
      ];
    } else {
      this.logger.debug(`[${CONSUMER_GROUP}] no GL handler for ${logical} — skip`);
      return;
    }

    try {
      const batch = await this.posting.createAndPost(cfo, {
        batchNumber,
        description,
        batchType,
        sourceModule: 'payments',
        accountingPeriodId: '00000000-0000-0000-0000-000000000000', // ignored when periodId omitted
        entries,
        sourceEventId: eventId,
      });
      this.logger.log(
        `[${CONSUMER_GROUP}] posted batch ${batch.batchNumber} (${batch.id.slice(0, 8)}) from ${logical} eventId=${eventId.slice(0, 8)}`,
      );
    } catch (err) {
      this.logger.error(
        `[${CONSUMER_GROUP}] post failed for ${logical} eventId=${eventId.slice(0, 8)}: ${(err as Error).message}`,
      );
      throw err; // unclaim → retry on redelivery
    }
  }

  private async loadAccountMapping(): Promise<{
    cash: string;
    tuition: string;
    ar: string;
    fundId: string;
  } | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT account_code, id::text AS id, fund_id::text AS fund_id FROM fin_chart_of_accounts WHERE account_code IN ('1000', '1100', '4000') AND is_active = true`,
      );
    })) as Array<{ account_code: string; id: string; fund_id: string | null }>;
    const byCode = new Map(rows.map((r) => [r.account_code, r]));
    const cash = byCode.get('1000');
    const ar = byCode.get('1100');
    const tuition = byCode.get('4000');
    if (!cash || !ar || !tuition || !cash.fund_id) return null;
    return {
      cash: cash.id,
      tuition: tuition.id,
      ar: ar.id,
      fundId: cash.fund_id,
    };
  }

  private async resolveSyntheticActor(): Promise<ResolvedActor | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS employee_id, ip.id::text AS person_id, pu.id::text AS account_id FROM hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id LEFT JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE e.employment_status = 'ACTIVE' ORDER BY e.created_at LIMIT 1`,
      );
    })) as Array<{ employee_id: string; person_id: string; account_id: string }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      accountId: r.account_id,
      personId: r.person_id,
      employeeId: r.employee_id,
      personType: 'STAFF',
      isSchoolAdmin: true, // synthetic CFO — full posting authority
    };
  }
}
