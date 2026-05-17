import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import { TenantPrismaService } from '@shared/tenant';
import { UnwrappedEvent, processWithIdempotency, unwrapEnvelope } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';
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
 * Topics + GL mapping (REVIEW-CYCLE26 BLOCKING 1 accrual model):
 *
 *   pay.invoice.created   →  DEBIT 1100 AR + CREDIT 4000 Tuition
 *                            (revenue accrued when the school issues
 *                            the invoice; AR opens for the family).
 *
 *   pay.payment.received  →  DEBIT 1000 Cash + CREDIT 1100 AR
 *                            (cash up, AR cleared — revenue is NOT
 *                            touched again because it was already
 *                            recognised when the invoice landed; the
 *                            previous incorrect mapping double-
 *                            credited Tuition Revenue and left AR
 *                            perpetually outstanding).
 *
 *   pay.refund.issued     →  DEBIT 1100 AR + CREDIT 1000 Cash
 *                            (cash leg reversed; AR is restored as a
 *                            credit-balance signalling refund-credit
 *                            owed to the family for application to a
 *                            future invoice. Revenue recognised when
 *                            the original invoice was issued is NOT
 *                            auto-reversed — explicit MANUAL
 *                            adjustment batch handles writeoff per
 *                            school policy. Refund-category-aware
 *                            routing — restock fees, withdrawals,
 *                            programme cancellations — carries to
 *                            Phase 2 as the "finance posting rules
 *                            table" follow-up.).
 *
 *   pay.credit_note.issued + pay.debt.written_off — schema-ready,
 *   skipped this cycle (Cycle 6 doesn't emit either yet).
 *
 * Account codes 1000 / 1100 / 4000 are hard-coded today (Phase 2
 * replaces with a `fin_posting_rules` lookup keyed on event_type
 * + optional fee_schedule_id). On missing chart mapping or missing
 * synthetic CFO actor the consumer THROWS so the standard
 * KafkaConsumerService retry/park chain catches the failure and
 * lands the event in `platform.platform_dlq_messages` for operator
 * action — financial events are never silently dropped on
 * configuration miss (REVIEW-CYCLE26 BLOCKING 3).
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

interface PayrollProcessedPayload {
  payrollRecordId: string;
  schoolId: string;
  employeeId: string;
  payPeriodId: string;
  payDate: string;
  grossPay: number | string;
  totalDeductions: number | string;
  netPay: number | string;
  deductions?: Array<{ deductionType?: string; amount: number | string }>;
  paidAt: string;
}

// P2-12 Step 10 — Events & Ticketing GL integration. On
// evt.event.completed we materialise the cumulative gross ticket
// revenue for the event into a balanced journal batch
// (DR Cash / CR Fee Revenue — account 4100). On evt.refund.issued
// the refund posts a reversing batch (DR Fee Revenue / CR Cash).
// Event-level revenue lands once per event-id on completion to keep
// the chart of accounts clear of per-order noise.
interface EventCompletedPayload {
  eventId: string;
  schoolId: string;
  completedAt: string;
  completedBy?: string;
}

interface EventRefundIssuedPayload {
  refundId: string;
  orderId: string;
  schoolId?: string;
  refundAmount: number | string;
  reason: string;
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
        // P2-4c — payroll integration. hr.payroll.processed posts a
        // balanced batch: DR Salaries Expense (5100) for grossPay,
        // CR Cash (1000) for netPay, CR Accrued Liabilities (2100)
        // for totalDeductions. The math balances because
        // grossPay = netPay + totalDeductions by definition.
        prefixedTopic('hr.payroll.processed'),
        // P2-12 Step 10 — Events & Ticketing GL integration. Revenue
        // recognises once per event on completion (DR Cash / CR Fee
        // Revenue 4100) and refunds reverse the cash leg (DR Fee
        // Revenue / CR Cash). Ticket-by-ticket posting would flood the
        // ledger; event-level batching keeps the audit reasonable.
        prefixedTopic('evt.event.completed'),
        prefixedTopic('evt.refund.issued'),
      ],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
    this.logger.log(
      `Subscribed to 5 dev.pay.* + 1 dev.hr.payroll.processed + 2 dev.evt.* topic(s) under group ${CONSUMER_GROUP}`,
    );
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

    // Resolve the chart of accounts mapping once per event. If the
    // canonical accounts (Cash 1000 + AR 1100 + Tuition 4000) are
    // missing OR inactive, THROW — financial events must not be
    // silently dropped on configuration failure (REVIEW-CYCLE26
    // BLOCKING 3). The thrown error propagates up through
    // processWithIdempotency which leaves the event unclaimed; the
    // standard consumer retry/DLQ path then catches it and parks
    // it into platform.platform_dlq_messages for operator action.
    const accounts = await this.loadAccountMapping();
    if (!accounts) {
      throw new Error(
        `[${CONSUMER_GROUP}] cannot resolve canonical accounts (Cash 1000 + AR 1100 + Tuition 4000) for tenant ${event.tenant.schoolId} — finance configuration must be completed before payment events can land`,
      );
    }
    const cashAccount = accounts.cash;
    const tuitionAccount = accounts.tuition;
    const arAccount = accounts.ar;
    const fundId = accounts.fundId;

    // Resolve a synthetic CFO-equivalent actor for the GL post —
    // the PostingService requires an employee actor. We pick the
    // first ACTIVE hr_employee in the tenant. THROW on miss — see
    // the loadAccountMapping comment above for the same reasoning.
    const cfo = await this.resolveSyntheticActor(event.tenant.schoolId);
    if (!cfo) {
      throw new Error(
        `[${CONSUMER_GROUP}] no ACTIVE hr_employees row available for tenant ${event.tenant.schoolId} — at least one staff member must exist before payment events can post to the GL`,
      );
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
      // ACCRUAL MODEL (REVIEW-CYCLE26 BLOCKING 1) — payment.received
      // is DR Cash / CR AR. Revenue was already recognised when the
      // invoice landed (pay.invoice.created → DR AR / CR Tuition).
      // The earlier mapping double-credited Tuition Revenue and left
      // AR un-cleared; now Cash goes up and AR clears in lockstep.
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
          accountId: arAccount,
          fundId,
          debit: 0,
          credit: amt,
          description: 'Accounts receivable cleared',
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
      // ACCRUAL MODEL (REVIEW-CYCLE26 BLOCKING 1) — refund reverses
      // the cash leg of the original payment by restoring AR (a
      // credit-balance receivable signals a refund-credit owed to
      // the family for application to a future invoice). Revenue
      // recognised when the original invoice was issued is NOT
      // automatically reversed — the school may want to apply the
      // refund-credit to a future invoice (in which case revenue
      // stays recognised), or write off the original revenue via
      // an explicit MANUAL adjustment batch (Phase 2 follow-up:
      // category-based refund routing — restock fees, programme
      // cancellations, withdrawals would each post differently).
      entries = [
        {
          accountId: arAccount,
          fundId,
          debit: amt,
          credit: 0,
          description: 'Accounts receivable restored (refund-credit owed to family)',
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
    } else if (logical === 'hr.payroll.processed') {
      // P2-4c — payroll posting. Balanced batch:
      //   DR Salaries Expense (5100) for grossPay
      //   CR Cash (1000)                for netPay
      //   CR Accrued Liabilities (2100) for totalDeductions
      // Math balances because grossPay = netPay + totalDeductions
      // by definition. The deductions stay on the balance sheet
      // until the school remits them (taxes to government, benefits
      // to provider, etc.) — the school's downstream remittance
      // workflow posts a separate batch DR Accrued Liabilities /
      // CR Cash to clear them.
      const p = event.payload as PayrollProcessedPayload;
      const gross = Number(p.grossPay);
      const net = Number(p.netPay);
      const deductions = Number(p.totalDeductions);
      if (!gross || gross <= 0 || net < 0 || deductions < 0) {
        this.logger.warn(
          `[${CONSUMER_GROUP}] hr.payroll.processed with non-positive grossPay or negative net/deductions — drop payrollRecordId=${p.payrollRecordId.slice(0, 8)}`,
        );
        return;
      }
      // Sanity — gross must equal net + deductions to within
      // rounding tolerance. Reject otherwise as a configuration
      // bug rather than silently posting an unbalanced batch.
      if (Math.abs(gross - (net + deductions)) > 0.01) {
        throw new Error(
          `[${CONSUMER_GROUP}] hr.payroll.processed payroll record ${p.payrollRecordId} has gross=${gross} but net+deductions=${net + deductions} — refusing to post unbalanced batch`,
        );
      }
      const payrollAccounts = await this.loadPayrollAccountMapping();
      if (!payrollAccounts) {
        throw new Error(
          `[${CONSUMER_GROUP}] cannot resolve payroll accounts (Salaries 5100 + Accrued Liabilities 2100) for tenant ${event.tenant.schoolId} — finance configuration must include payroll posting accounts`,
        );
      }
      batchType = 'AUTO_PAYROLL';
      description = `Payroll processed — gross $${gross.toFixed(2)} net $${net.toFixed(2)} (recordId=${p.payrollRecordId.slice(0, 8)})`;
      referenceType = 'hr_payroll_records';
      referenceId = p.payrollRecordId;
      const payrollEntries: CreateGLEntryLineDto[] = [
        {
          accountId: payrollAccounts.salaries,
          fundId,
          debit: gross,
          credit: 0,
          description: 'Salaries expense — gross pay',
          referenceType,
          referenceId,
        },
        {
          accountId: cashAccount,
          fundId,
          debit: 0,
          credit: net,
          description: 'Cash disbursed — net pay',
          referenceType,
          referenceId,
        },
      ];
      // Only emit the deductions credit when there ARE deductions,
      // so a zero-deduction payroll batch stays tightly balanced
      // with two lines instead of three.
      if (deductions > 0) {
        payrollEntries.push({
          accountId: payrollAccounts.accruedLiabilities,
          fundId,
          debit: 0,
          credit: deductions,
          description: 'Payroll liabilities — taxes + benefits accrued',
          referenceType,
          referenceId,
        });
      }
      entries = payrollEntries;
    } else if (logical === 'evt.event.completed') {
      // P2-12 Step 10. Post the cumulative gross sale revenue when an
      // event is marked COMPLETED. We compute the gross by SUMming
      // confirmed + refunded order totals minus prior refunds (the net
      // figure the school actually retains). The
      // event-completion event carries only the eventId so we look the
      // totals up at post time. Posts: DR Cash / CR Fee Revenue (4100).
      const p = event.payload as EventCompletedPayload;
      const totals = await this.loadEventNetRevenue(p.eventId);
      if (totals === null) {
        this.logger.warn(
          `[${CONSUMER_GROUP}] evt.event.completed: cannot read totals for eventId=${p.eventId.slice(0, 8)} — drop`,
        );
        return;
      }
      const net = totals.net;
      if (net <= 0) {
        this.logger.log(
          `[${CONSUMER_GROUP}] evt.event.completed: net revenue is $${net.toFixed(2)} — no journal entry posted`,
        );
        return;
      }
      const feeRevenueAccount = await this.loadFeeRevenueAccount();
      if (!feeRevenueAccount) {
        throw new Error(
          `[${CONSUMER_GROUP}] cannot resolve Fee Revenue account (4100) for tenant ${event.tenant.schoolId} — finance configuration must include Fee Revenue before event completion can post`,
        );
      }
      batchType = 'AUTO_PAYMENT';
      description = `Event revenue $${net.toFixed(2)} (eventId=${p.eventId.slice(0, 8)})`;
      referenceType = 'evt_events';
      referenceId = p.eventId;
      entries = [
        {
          accountId: cashAccount,
          fundId,
          debit: net,
          credit: 0,
          description: 'Event ticket revenue received',
          referenceType,
          referenceId,
        },
        {
          accountId: feeRevenueAccount,
          fundId,
          debit: 0,
          credit: net,
          description: 'Event ticket revenue recognised',
          referenceType,
          referenceId,
        },
      ];
    } else if (logical === 'evt.refund.issued') {
      // P2-12 Step 10. Reverse the cash leg of the original event
      // revenue when a refund issues. DR Fee Revenue / CR Cash. Note:
      // this fires per refund. If the event has not yet been
      // COMPLETED, the refund still posts (the refund cash leaves the
      // school before the event-completion journal lands; on
      // completion the gross/refund math nets correctly).
      const p = event.payload as EventRefundIssuedPayload;
      const amt = Number(p.refundAmount);
      if (!amt || amt <= 0) {
        this.logger.warn(`[${CONSUMER_GROUP}] evt.refund.issued with non-positive amount — drop`);
        return;
      }
      const feeRevenueAccount = await this.loadFeeRevenueAccount();
      if (!feeRevenueAccount) {
        throw new Error(
          `[${CONSUMER_GROUP}] cannot resolve Fee Revenue account (4100) for tenant ${event.tenant.schoolId} — finance configuration must include Fee Revenue before event refunds can post`,
        );
      }
      batchType = 'AUTO_REFUND';
      description = `Event refund $${amt.toFixed(2)} (refundId=${p.refundId.slice(0, 8)})`;
      referenceType = 'evt_refunds';
      referenceId = p.refundId;
      entries = [
        {
          accountId: feeRevenueAccount,
          fundId,
          debit: amt,
          credit: 0,
          description: 'Event refund — revenue reversed',
          referenceType,
          referenceId,
        },
        {
          accountId: cashAccount,
          fundId,
          debit: 0,
          credit: amt,
          description: 'Event refund — cash paid out',
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
        // P2-4c — sourceModule reflects the originating event so the
        // finance audit trail can distinguish payment-driven posts
        // from payroll-driven posts.
        sourceModule:
          logical === 'hr.payroll.processed'
            ? 'payroll'
            : logical.startsWith('evt.')
              ? 'events'
              : 'payments',
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

  /**
   * P2-4c — payroll posting requires Salaries Expense (5100) +
   * Accrued Liabilities (2100). Cash (1000) is shared with the
   * payment-event mapping so we look those up via the existing
   * loadAccountMapping. The seeded chart of accounts (Cycle 26
   * seed-finance.ts) already includes both 5100 + 2100, so a
   * tenant that ran the canonical finance seed has the rows.
   * Returns null on missing config — the consumer THROWs and the
   * standard retry/DLQ chain catches it (REVIEW-CYCLE26 BLOCKING 3
   * pattern).
   */
  private async loadPayrollAccountMapping(): Promise<{
    salaries: string;
    accruedLiabilities: string;
  } | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT account_code, id::text AS id FROM fin_chart_of_accounts WHERE account_code IN ('5100', '2100') AND is_active = true`,
      );
    })) as Array<{ account_code: string; id: string }>;
    const byCode = new Map(rows.map((r) => [r.account_code, r]));
    const salaries = byCode.get('5100');
    const accrued = byCode.get('2100');
    if (!salaries || !accrued) return null;
    return { salaries: salaries.id, accruedLiabilities: accrued.id };
  }

  /**
   * P2-12 Step 10 — Fee Revenue account (4100) lookup for events
   * revenue recognition. The seeded chart of accounts (Cycle 26
   * seed-finance.ts) already includes 4100 Fee Revenue under the
   * GENERAL fund, so a tenant that ran the canonical finance seed has
   * the row. Returns null on missing config — the consumer THROWs and
   * the standard retry/DLQ chain catches it (REVIEW-CYCLE26 BLOCKING
   * 3 pattern).
   */
  private async loadFeeRevenueAccount(): Promise<string | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_chart_of_accounts WHERE account_code = '4100' AND is_active = true LIMIT 1`,
      );
    })) as Array<{ id: string }>;
    if (rows.length === 0) return null;
    return rows[0]!.id;
  }

  /**
   * P2-12 Step 10 — net event revenue lookup at completion time.
   * Returns { gross, refunds, net } where net = gross - refunds.
   * Gross is the sum of confirmed-and-refunded order totals; refunds
   * is the sum of evt_refunds.refund_amount for the event. Returns
   * null when the event does not exist (defensive).
   */
  private async loadEventNetRevenue(
    eventId: string,
  ): Promise<{ gross: number; refunds: number; net: number } | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT
           (SELECT COALESCE(SUM(total_amount),0)::numeric
              FROM evt_orders WHERE event_id = $1::uuid
                AND status IN ('CONFIRMED','REFUNDED')) AS gross,
           (SELECT COALESCE(SUM(r.refund_amount),0)::numeric
              FROM evt_refunds r
              JOIN evt_orders o ON o.id = r.order_id
              WHERE o.event_id = $1::uuid) AS refunds`,
        eventId,
      );
    })) as Array<{ gross: string | number; refunds: string | number }>;
    if (rows.length === 0) return null;
    const gross = Number(rows[0]!.gross);
    const refunds = Number(rows[0]!.refunds);
    return { gross, refunds, net: Number((gross - refunds).toFixed(2)) };
  }

  /**
   * REVIEW-P2-4c MAJOR — synthetic actor lookup is now scoped to
   * the current school. The previous query selected the first
   * ACTIVE employee in the tenant schema ordered by created_at
   * with no school_id predicate; in a multi-school tenant schema
   * this could pick a foreign-school employee as the posting
   * actor. The schema-per-tenant model puts one school per
   * tenant schema today, so the predicate is defensive and
   * forward-compatible with a future multi-school tenancy model.
   */
  private async resolveSyntheticActor(schoolId: string): Promise<ResolvedActor | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT e.id::text AS employee_id, ip.id::text AS person_id, pu.id::text AS account_id ` +
          `FROM hr_employees e ` +
          `JOIN platform.iam_person ip ON ip.id = e.person_id ` +
          `LEFT JOIN platform.platform_users pu ON pu.person_id = ip.id ` +
          `WHERE e.school_id = $1::uuid AND e.employment_status = 'ACTIVE' ` +
          `ORDER BY e.created_at LIMIT 1`,
        schoolId,
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
