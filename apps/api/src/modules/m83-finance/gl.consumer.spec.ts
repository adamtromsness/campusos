import { describe, it, expect } from 'vitest';
import { GLConsumer } from './gl.consumer';

/**
 * P2-H4 test coverage uplift — gl.consumer.ts (679 LOC, Tier 1 Financial
 * the cross-cycle M84 → M83 keystone consumer).
 *
 * Subscribes to 8 topics under group `gl-consumer`:
 *   - pay.payment.received    → DR Cash + CR AR
 *   - pay.invoice.created     → DR AR + CR Tuition (accrual, REVIEW-CYCLE26 BLOCKING 1)
 *   - pay.refund.issued       → DR AR + CR Cash (refund-credit signal)
 *   - pay.credit_note.issued  → no-op (Cycle 6 doesn't emit)
 *   - pay.debt.written_off    → no-op
 *   - hr.payroll.processed    → DR Salaries + CR Cash + CR Accrued Liabilities (P2-4c)
 *   - evt.event.completed     → DR Cash + CR Fee Revenue (gross - prior refunds; P2-12 Step 10)
 *   - evt.refund.issued       → DR Fee Revenue + CR Cash
 *
 * Idempotency contracts:
 *   - processWithIdempotency claims event_id at consumer-group level
 *   - PostingService.createAndPost UNIQUE source_event_id catches Kafka redelivery
 *
 * REVIEW-CYCLE26 BLOCKING 3 fail-closed: on missing canonical accounts
 * (1000/1100/4000) OR missing synthetic CFO actor, the consumer THROWS so
 * the standard KafkaConsumerService retry/park chain catches the failure
 * and lands the event in platform_dlq_messages. Financial events MUST NOT
 * be silently dropped on configuration miss.
 *
 * Coverage target: ≥95% (Tier 1 Financial).
 */

const SCHOOL_ID = '019e03f8-cf0b-7444-92d2-85e2c67b549a';

interface SqlCapture {
  sql: string;
  args: unknown[];
}

interface FakeOpts {
  accountMappingRows?: Array<{ account_code: string; id: string; fund_id: string | null }>;
  payrollAccountRows?: Array<{ account_code: string; id: string }>;
  feeRevenueRows?: Array<{ id: string }>;
  netRevenueRows?: Array<{ gross: string | number; refunds: string | number }>;
  syntheticActorRows?: Array<{
    employee_id: string;
    person_id: string;
    account_id: string | null;
  }>;
}

function makeTenantPrisma(opts: FakeOpts) {
  const captures: SqlCapture[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      captures.push({ sql, args });
      // loadAccountMapping
      if (sql.includes("'1000'") && sql.includes("'1100'") && sql.includes("'4000'")) {
        return opts.accountMappingRows ?? [];
      }
      // loadPayrollAccountMapping
      if (sql.includes("'5100'") && sql.includes("'2100'")) {
        return opts.payrollAccountRows ?? [];
      }
      // loadFeeRevenueAccount
      if (sql.includes("'4100'") && sql.includes('LIMIT 1')) {
        return opts.feeRevenueRows ?? [];
      }
      // loadEventNetRevenue — joins evt_orders + evt_refunds
      if (sql.includes('FROM evt_orders') && sql.includes('FROM evt_refunds')) {
        return opts.netRevenueRows ?? [];
      }
      // resolveSyntheticActor — hr_employees JOIN platform.iam_person
      if (sql.includes('FROM hr_employees e') && sql.includes('platform.iam_person ip')) {
        return opts.syntheticActorRows ?? [];
      }
      return [];
    },
    $executeRawUnsafe: async () => 0,
  };
  return {
    tenantPrisma: {
      executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
      executeInTenantTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
    },
    captures,
  };
}

interface PostingCalls {
  createAndPost: Array<{ actor: Record<string, unknown>; input: Record<string, unknown> }>;
  shouldFail?: boolean;
}

function makePosting(shouldFail = false) {
  const calls: PostingCalls = { createAndPost: [] };
  return {
    posting: {
      createAndPost: async (actor: Record<string, unknown>, input: Record<string, unknown>) => {
        calls.createAndPost.push({ actor, input });
        if (shouldFail) throw new Error('posting blew up');
        return { id: 'batch-1', batchNumber: input.batchNumber };
      },
    },
    calls,
  };
}

const ACCOUNT_MAPPING = [
  { account_code: '1000', id: 'a-cash', fund_id: 'f-1' },
  { account_code: '1100', id: 'a-ar', fund_id: 'f-1' },
  { account_code: '4000', id: 'a-tuition', fund_id: 'f-1' },
];

const PAYROLL_ACCOUNTS = [
  { account_code: '5100', id: 'a-salaries' },
  { account_code: '2100', id: 'a-accrued' },
];

const SAMPLE_CFO = [{ employee_id: 'emp-1', person_id: 'person-1', account_id: 'acct-1' }];

function makeConsumer(opts: FakeOpts, postingShouldFail = false) {
  const fake = makeTenantPrisma(opts);
  const posting = makePosting(postingShouldFail);
  const kafkaConsumer = { subscribe: async () => undefined };
  const idempotency = { isClaimed: async () => false, claim: async () => undefined };
  const consumer = new GLConsumer(
    kafkaConsumer as never,
    idempotency as never,
    fake.tenantPrisma as never,
    posting.posting as never,
  );
  return { consumer, postingCalls: posting.calls, captures: fake.captures };
}

// Reach the private `process` method via prototype reflection so we can
// drive deterministic scenarios without standing up Kafka.
function processEvent(
  consumer: GLConsumer,
  topic: string,
  event: { eventId: string; tenant: { schoolId: string; subdomain: string }; payload: unknown },
) {
  return (
    consumer as unknown as {
      process: (
        t: string,
        e: { eventId: string; tenant: { schoolId: string; subdomain: string }; payload: unknown },
      ) => Promise<void>;
    }
  ).process(topic, event);
}

const SAMPLE_EVENT_ID = '019e03f8-aaaa-bbbb-cccc-000000000001';

function baseEvent<P>(payload: P) {
  return {
    eventId: SAMPLE_EVENT_ID,
    tenant: { schoolId: SCHOOL_ID, subdomain: 'demo' },
    payload,
  };
}

describe('GLConsumer.process — fail-closed on configuration miss (REVIEW-CYCLE26 BLOCKING 3)', () => {
  it('throws when canonical accounts (Cash/AR/Tuition) are missing', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: [], // empty → loadAccountMapping returns null
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(
        consumer,
        'dev.pay.payment.received',
        baseEvent({
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        }),
      ),
    ).rejects.toThrow(/cannot resolve canonical accounts \(Cash 1000 \+ AR 1100 \+ Tuition 4000\)/);
  });

  it('throws when Cash account has no fund_id', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: [
        { account_code: '1000', id: 'a-cash', fund_id: null }, // null fund
        { account_code: '1100', id: 'a-ar', fund_id: 'f-1' },
        { account_code: '4000', id: 'a-tuition', fund_id: 'f-1' },
      ],
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(
        consumer,
        'dev.pay.payment.received',
        baseEvent({
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        }),
      ),
    ).rejects.toThrow(/cannot resolve canonical accounts/);
  });

  it('throws when no ACTIVE employee exists for synthetic CFO', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: [], // no employee → resolveSyntheticActor returns null
    });
    await expect(
      processEvent(
        consumer,
        'dev.pay.payment.received',
        baseEvent({
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        }),
      ),
    ).rejects.toThrow(/no ACTIVE hr_employees row available/);
  });
});

describe('GLConsumer.process — pay.payment.received (DR Cash / CR AR)', () => {
  it('posts a balanced batch with correct accrual mapping', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.payment.received',
      baseEvent({
        paymentId: 'pmt-1',
        invoiceId: 'inv-1',
        familyAccountId: 'fa-1',
        amount: 250.75,
        paymentMethod: 'CARD',
        invoiceStatus: 'PAID',
        paidAt: '2026-04-15',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(1);
    const { actor, input } = postingCalls.createAndPost[0]!;
    expect(actor).toMatchObject({
      employeeId: 'emp-1',
      personType: 'STAFF',
      isSchoolAdmin: true,
    });
    expect(input.sourceModule).toBe('payments');
    expect(input.sourceEventId).toBe(SAMPLE_EVENT_ID);
    expect(input.batchType).toBe('AUTO_PAYMENT');
    expect((input.batchNumber as string).startsWith('AUTO-')).toBe(true);
    expect((input.batchNumber as string).length).toBe(13); // AUTO- + 8 hex
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      accountId: 'a-cash',
      fundId: 'f-1',
      debit: 250.75,
      credit: 0,
      referenceType: 'pay_payments',
      referenceId: 'pmt-1',
    });
    expect(entries[1]).toMatchObject({
      accountId: 'a-ar',
      fundId: 'f-1',
      debit: 0,
      credit: 250.75,
      referenceType: 'pay_payments',
      referenceId: 'pmt-1',
    });
  });

  it('drops non-positive amount with WARN (no post)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.payment.received',
      baseEvent({
        paymentId: 'pmt-1',
        invoiceId: 'inv-1',
        familyAccountId: 'fa-1',
        amount: 0,
        paymentMethod: 'CARD',
        invoiceStatus: 'PAID',
        paidAt: '2026-04-15',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('drops negative amount with WARN', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.payment.received',
      baseEvent({
        paymentId: 'pmt-1',
        invoiceId: 'inv-1',
        familyAccountId: 'fa-1',
        amount: -50,
        paymentMethod: 'CARD',
        invoiceStatus: 'PAID',
        paidAt: '2026-04-15',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('coerces string-typed amount to Number', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.payment.received',
      baseEvent({
        paymentId: 'pmt-1',
        invoiceId: 'inv-1',
        familyAccountId: 'fa-1',
        amount: '125.50',
        paymentMethod: 'CARD',
        invoiceStatus: 'PAID',
        paidAt: '2026-04-15',
      }),
    );
    const entries = postingCalls.createAndPost[0]!.input.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.debit).toBe(125.5);
  });
});

describe('GLConsumer.process — pay.invoice.created (DR AR / CR Tuition)', () => {
  it('posts AUTO_INVOICE batch with AR + Tuition Revenue legs', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.invoice.created',
      baseEvent({
        invoiceId: 'inv-2',
        familyAccountId: 'fa-1',
        totalAmount: 500,
      }),
    );
    const { input } = postingCalls.createAndPost[0]!;
    expect(input.batchType).toBe('AUTO_INVOICE');
    expect(input.sourceModule).toBe('payments');
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ accountId: 'a-ar', debit: 500, credit: 0 });
    expect(entries[1]).toMatchObject({ accountId: 'a-tuition', debit: 0, credit: 500 });
  });

  it('drops non-positive total with WARN', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.invoice.created',
      baseEvent({ invoiceId: 'inv-2', familyAccountId: 'fa-1', totalAmount: 0 }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });
});

describe('GLConsumer.process — pay.refund.issued (DR AR / CR Cash)', () => {
  it('posts AUTO_REFUND batch reversing the cash leg', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.refund.issued',
      baseEvent({
        refundId: 'ref-1',
        paymentId: 'pmt-1',
        familyAccountId: 'fa-1',
        amount: 75,
        refundCategory: 'GOODWILL',
      }),
    );
    const { input } = postingCalls.createAndPost[0]!;
    expect(input.batchType).toBe('AUTO_REFUND');
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ accountId: 'a-ar', debit: 75, credit: 0 });
    expect(entries[1]).toMatchObject({ accountId: 'a-cash', debit: 0, credit: 75 });
    expect(entries[0]!.referenceType).toBe('pay_refunds');
  });

  it('drops zero refund with WARN', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.pay.refund.issued',
      baseEvent({
        refundId: 'ref-1',
        paymentId: 'pmt-1',
        familyAccountId: 'fa-1',
        amount: 0,
        refundCategory: 'GOODWILL',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });
});

describe('GLConsumer.process — hr.payroll.processed (P2-4c)', () => {
  const payrollPayload = {
    payrollRecordId: 'pr-1',
    schoolId: SCHOOL_ID,
    employeeId: 'emp-1',
    payPeriodId: 'pp-1',
    payDate: '2026-04-15',
    grossPay: 1000,
    totalDeductions: 200,
    netPay: 800,
    paidAt: '2026-04-15',
  };

  it('posts balanced 3-line batch: DR Salaries + CR Cash + CR Accrued Liabilities', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: PAYROLL_ACCOUNTS,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(consumer, 'dev.hr.payroll.processed', baseEvent(payrollPayload));
    const { input } = postingCalls.createAndPost[0]!;
    expect(input.batchType).toBe('AUTO_PAYROLL');
    expect(input.sourceModule).toBe('payroll');
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ accountId: 'a-salaries', debit: 1000, credit: 0 });
    expect(entries[1]).toMatchObject({ accountId: 'a-cash', debit: 0, credit: 800 });
    expect(entries[2]).toMatchObject({ accountId: 'a-accrued', debit: 0, credit: 200 });
    expect(entries[0]!.referenceType).toBe('hr_payroll_records');
  });

  it('omits the deductions credit line when totalDeductions is zero (2-line batch)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: PAYROLL_ACCOUNTS,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.hr.payroll.processed',
      baseEvent({ ...payrollPayload, totalDeductions: 0, netPay: 1000 }),
    );
    const entries = postingCalls.createAndPost[0]!.input.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.accountId).toBe('a-salaries');
    expect(entries[1]!.accountId).toBe('a-cash');
  });

  it('throws when gross ≠ net + deductions (refuses unbalanced batch)', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: PAYROLL_ACCOUNTS,
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(
        consumer,
        'dev.hr.payroll.processed',
        baseEvent({ ...payrollPayload, grossPay: 1000, netPay: 800, totalDeductions: 100 }),
      ),
    ).rejects.toThrow(/refusing to post unbalanced batch/);
  });

  it('throws when payroll accounts (5100/2100) missing', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: [], // missing
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(consumer, 'dev.hr.payroll.processed', baseEvent(payrollPayload)),
    ).rejects.toThrow(/cannot resolve payroll accounts/);
  });

  it('drops payload with non-positive grossPay or negative net/deductions', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: PAYROLL_ACCOUNTS,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.hr.payroll.processed',
      baseEvent({ ...payrollPayload, grossPay: 0, netPay: 0, totalDeductions: 0 }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('drops payload with negative net pay', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      payrollAccountRows: PAYROLL_ACCOUNTS,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.hr.payroll.processed',
      baseEvent({ ...payrollPayload, netPay: -10 }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });
});

describe('GLConsumer.process — evt.event.completed (P2-12)', () => {
  it('posts net revenue (gross - prior refunds) as DR Cash / CR Fee Revenue', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      netRevenueRows: [{ gross: '500', refunds: '50' }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.event.completed',
      baseEvent({
        eventId: 'evt-1',
        schoolId: SCHOOL_ID,
        completedAt: '2026-04-15',
      }),
    );
    const { input } = postingCalls.createAndPost[0]!;
    expect(input.batchType).toBe('AUTO_PAYMENT');
    expect(input.sourceModule).toBe('events');
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ accountId: 'a-cash', debit: 450, credit: 0 });
    expect(entries[1]).toMatchObject({ accountId: 'a-fee-revenue', debit: 0, credit: 450 });
    expect(entries[0]!.referenceType).toBe('evt_events');
  });

  it('skips post when net revenue is zero or negative', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      netRevenueRows: [{ gross: '100', refunds: '100' }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.event.completed',
      baseEvent({ eventId: 'evt-1', schoolId: SCHOOL_ID, completedAt: '2026-04-15' }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('throws when Fee Revenue account (4100) is missing', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [], // missing
      netRevenueRows: [{ gross: '500', refunds: '0' }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(
        consumer,
        'dev.evt.event.completed',
        baseEvent({ eventId: 'evt-1', schoolId: SCHOOL_ID, completedAt: '2026-04-15' }),
      ),
    ).rejects.toThrow(/cannot resolve Fee Revenue account \(4100\)/);
  });

  it('drops event when loadEventNetRevenue returns null (no rows)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      netRevenueRows: [],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.event.completed',
      baseEvent({ eventId: 'evt-1', schoolId: SCHOOL_ID, completedAt: '2026-04-15' }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('rounds net to 2dp (gross 100.001 - refunds 0 = 100.00)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      netRevenueRows: [{ gross: '100.001', refunds: 0 }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.event.completed',
      baseEvent({ eventId: 'evt-1', schoolId: SCHOOL_ID, completedAt: '2026-04-15' }),
    );
    const entries = postingCalls.createAndPost[0]!.input.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.debit).toBe(100);
  });
});

describe('GLConsumer.process — evt.refund.issued (P2-12)', () => {
  it('posts AUTO_REFUND batch DR Fee Revenue / CR Cash', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.refund.issued',
      baseEvent({
        refundId: 'ref-1',
        orderId: 'order-1',
        schoolId: SCHOOL_ID,
        refundAmount: 25,
        reason: 'Customer request',
      }),
    );
    const { input } = postingCalls.createAndPost[0]!;
    expect(input.batchType).toBe('AUTO_REFUND');
    expect(input.sourceModule).toBe('events');
    const entries = input.entries as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({ accountId: 'a-fee-revenue', debit: 25, credit: 0 });
    expect(entries[1]).toMatchObject({ accountId: 'a-cash', debit: 0, credit: 25 });
    expect(entries[0]!.referenceType).toBe('evt_refunds');
  });

  it('drops zero refund with WARN', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [{ id: 'a-fee-revenue' }],
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(
      consumer,
      'dev.evt.refund.issued',
      baseEvent({
        refundId: 'ref-1',
        orderId: 'order-1',
        schoolId: SCHOOL_ID,
        refundAmount: 0,
        reason: 'noop',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('throws when Fee Revenue account (4100) missing for refund', async () => {
    const { consumer } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      feeRevenueRows: [],
      syntheticActorRows: SAMPLE_CFO,
    });
    await expect(
      processEvent(
        consumer,
        'dev.evt.refund.issued',
        baseEvent({
          refundId: 'ref-1',
          orderId: 'order-1',
          schoolId: SCHOOL_ID,
          refundAmount: 25,
          reason: 'r',
        }),
      ),
    ).rejects.toThrow(/cannot resolve Fee Revenue account \(4100\)/);
  });
});

describe('GLConsumer.process — topic routing + skipped paths', () => {
  it('silently skips pay.credit_note.issued (no GL handler this cycle)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(consumer, 'dev.pay.credit_note.issued', baseEvent({ creditNoteId: 'cn-1' }));
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('silently skips pay.debt.written_off (no GL handler this cycle)', async () => {
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    await processEvent(consumer, 'dev.pay.debt.written_off', baseEvent({ writeOffId: 'wo-1' }));
    expect(postingCalls.createAndPost).toHaveLength(0);
  });

  it('handles un-prefixed topic (e.g. pay.payment.received without dev. prefix)', async () => {
    // KAFKA_TOPIC_ENV may not be set in some environments; consumer falls back to 'dev'
    const { consumer, postingCalls } = makeConsumer({
      accountMappingRows: ACCOUNT_MAPPING,
      syntheticActorRows: SAMPLE_CFO,
    });
    // pass the un-prefixed name — the slice logic should leave it unchanged
    await processEvent(
      consumer,
      'pay.payment.received',
      baseEvent({
        paymentId: 'pmt-1',
        invoiceId: 'inv-1',
        familyAccountId: 'fa-1',
        amount: 100,
        paymentMethod: 'CARD',
        invoiceStatus: 'PAID',
        paidAt: '2026-04-15',
      }),
    );
    expect(postingCalls.createAndPost).toHaveLength(1);
  });

  it('handles custom KAFKA_TOPIC_ENV prefix', async () => {
    const original = process.env.KAFKA_TOPIC_ENV;
    process.env.KAFKA_TOPIC_ENV = 'staging';
    try {
      const { consumer, postingCalls } = makeConsumer({
        accountMappingRows: ACCOUNT_MAPPING,
        syntheticActorRows: SAMPLE_CFO,
      });
      await processEvent(
        consumer,
        'staging.pay.payment.received',
        baseEvent({
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        }),
      );
      expect(postingCalls.createAndPost).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.KAFKA_TOPIC_ENV;
      else process.env.KAFKA_TOPIC_ENV = original;
    }
  });
});

describe('GLConsumer.process — posting failure', () => {
  it('rethrows when PostingService.createAndPost fails so the event stays unclaimed', async () => {
    const { consumer } = makeConsumer(
      {
        accountMappingRows: ACCOUNT_MAPPING,
        syntheticActorRows: SAMPLE_CFO,
      },
      true, // posting blows up
    );
    await expect(
      processEvent(
        consumer,
        'dev.pay.payment.received',
        baseEvent({
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        }),
      ),
    ).rejects.toThrow('posting blew up');
  });
});

describe('GLConsumer — module init / Kafka subscribe shape', () => {
  it('subscribes to 8 topics under group gl-consumer', async () => {
    const subscribedTopics: string[] = [];
    let subscribedGroup: string | undefined;
    const fake = makeTenantPrisma({});
    const posting = makePosting();
    const kafkaConsumer = {
      subscribe: async (opts: {
        topics: string[];
        groupId: string;
        handler: (m: unknown) => Promise<void>;
      }) => {
        subscribedTopics.push(...opts.topics);
        subscribedGroup = opts.groupId;
      },
    };
    const idempotency = { isClaimed: async () => false, claim: async () => undefined };
    const consumer = new GLConsumer(
      kafkaConsumer as never,
      idempotency as never,
      fake.tenantPrisma as never,
      posting.posting as never,
    );
    await consumer.onModuleInit();
    expect(subscribedGroup).toBe('gl-consumer');
    expect(subscribedTopics).toHaveLength(8);
    // Topic names are prefixed via prefixedTopic() — pre-prefix names contained:
    expect(subscribedTopics.some((t) => t.endsWith('pay.payment.received'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('pay.invoice.created'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('pay.refund.issued'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('pay.credit_note.issued'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('pay.debt.written_off'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('hr.payroll.processed'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('evt.event.completed'))).toBe(true);
    expect(subscribedTopics.some((t) => t.endsWith('evt.refund.issued'))).toBe(true);
  });
});

describe('GLConsumer.handle — envelope + idempotency', () => {
  it('skips claimed events (idempotency hit)', async () => {
    const fake = makeTenantPrisma({});
    const posting = makePosting();
    const kafkaConsumer = { subscribe: async () => undefined };
    const idempotency = { isClaimed: async () => true, claim: async () => undefined };
    const consumer = new GLConsumer(
      kafkaConsumer as never,
      idempotency as never,
      fake.tenantPrisma as never,
      posting.posting as never,
    );
    await (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle({
      topic: 'dev.pay.payment.received',
      partition: 0,
      offset: '1',
      payload: {
        event_id: 'e-1',
        tenant_id: SCHOOL_ID,
        payload: {
          paymentId: 'pmt-1',
          invoiceId: 'inv-1',
          familyAccountId: 'fa-1',
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: '2026-04-15',
        },
      },
      headers: { 'event-id': 'e-1', 'tenant-id': SCHOOL_ID, 'tenant-subdomain': 'demo' },
    });
    expect(posting.calls.createAndPost).toHaveLength(0);
  });

  it('drops messages with missing routing fields (no envelope, no headers)', async () => {
    const fake = makeTenantPrisma({});
    const posting = makePosting();
    const kafkaConsumer = { subscribe: async () => undefined };
    const idempotency = { isClaimed: async () => false, claim: async () => undefined };
    const consumer = new GLConsumer(
      kafkaConsumer as never,
      idempotency as never,
      fake.tenantPrisma as never,
      posting.posting as never,
    );
    await (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle({
      topic: 'dev.pay.payment.received',
      partition: 0,
      offset: '1',
      payload: { wrong: 'shape' },
      headers: {},
    });
    expect(posting.calls.createAndPost).toHaveLength(0);
  });
});
