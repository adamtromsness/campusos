import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GLConsumer } from '@modules/m83-finance/gl.consumer';
import { PostingService } from '@modules/m83-finance/posting.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService, KafkaConsumerService } from '@shared/kafka';
import type { ConsumedMessage } from '@shared/kafka';

import {
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';

const CONSUMER_GROUP = 'gl-consumer';

/**
 * DB-backed integration tests for GLConsumer — the DOUBLE-ENTRY KEYSTONE.
 *
 * Subscribes to:
 *   - pay.invoice.created  → DR AR / CR Tuition
 *   - pay.payment.received → DR Cash / CR AR
 *   - pay.refund.issued    → DR AR / CR Cash
 *   - hr.payroll.processed → DR Salaries / CR Cash / CR Accrued Liab
 *   - evt.event.completed  → DR Cash / CR Fee Revenue
 *   - evt.refund.issued    → DR Fee Revenue / CR Cash
 *
 * Drives the consumer's private handle() via bracket access.
 */
describe('integration:m83-finance/gl-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let idempotency: IdempotencyService;
  let kafkaConsumer: KafkaConsumerService;
  let posting: PostingService;
  let consumer: GLConsumer;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    idempotency = new IdempotencyService(tenantPrisma);
    kafkaConsumer = new KafkaConsumerService(tenantPrisma);
    posting = new PostingService(tenantPrisma);
    consumer = new GLConsumer(kafkaConsumer, idempotency, tenantPrisma, posting);

    // Ensure the chart has the canonical account codes the consumer
    // looks up: 1000 Cash, 1100 AR, 4000 Tuition, 5100 Salaries,
    // 2100 Accrued Liabilities, 4100 Fee Revenue. The finance fixture
    // seeds Cash/AR/Tuition under standard test codes — the fixture's
    // codes ARE '1000' / '1100' / '4000' so this works. We just need
    // to add 5100, 2100, 4100 if not already present.
    await ensureExtraAccount(rawClient, '5100', 'Salaries Expense', 'EXPENSE', 'DEBIT');
    await ensureExtraAccount(rawClient, '2100', 'Accrued Liabilities', 'LIABILITY', 'CREDIT');
    await ensureExtraAccount(rawClient, '4100', 'Fee Revenue', 'REVENUE', 'CREDIT');
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // fin_gl_entries has IMMUTABLE trigger — use TRUNCATE
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.fin_gl_entries, ${TEST_SCHEMA}.fin_journal_batches CASCADE`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = $1`,
      CONSUMER_GROUP,
    );
  });

  function buildMessage(opts: {
    topic: string;
    payload: Record<string, unknown>;
    schoolId?: string;
    subdomain?: string;
    eventId?: string;
    headerPrefix?: string;
  }): ConsumedMessage {
    const schoolId = opts.schoolId ?? TEST_SCHOOL_ID;
    const subdomain = opts.subdomain ?? TEST_SUBDOMAIN;
    const eventId = opts.eventId ?? generateId();
    return {
      topic: opts.topic,
      partition: 0,
      key: eventId,
      headers: {
        'event-id': eventId,
        'tenant-id': schoolId,
        'tenant-subdomain': subdomain,
      },
      payload: {
        event_id: eventId,
        event_type: opts.topic,
        tenant_id: schoolId,
        source_module: 'test',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload: opts.payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  async function callHandle(msg: ConsumedMessage): Promise<void> {
    await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
  }

  async function getAccountId(code: string): Promise<string> {
    const rows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.fin_chart_of_accounts WHERE account_code = $1 AND school_id = $2::uuid LIMIT 1`,
      code,
      TEST_SCHOOL_ID,
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  describe('pay.invoice.created → DR AR / CR Tuition', () => {
    it('posts a balanced batch with AR debit + Tuition credit', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.invoice.created',
        payload: {
          invoiceId: generateId(),
          familyAccountId: generateId(),
          totalAmount: 250,
        },
      });
      await callHandle(msg);

      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_number, batch_type, source_module
           FROM ${TEST_SCHEMA}.fin_journal_batches
          WHERE source_module = 'payments'`,
      )) as Array<{ id: string; batch_number: string; batch_type: string; source_module: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_INVOICE');

      const arId = await getAccountId('1100');
      const tuitionId = await getAccountId('4000');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid ORDER BY line_order`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      expect(entries.length).toBe(2);
      const arEntry = entries.find((e) => e.account_id === arId)!;
      const tuitionEntry = entries.find((e) => e.account_id === tuitionId)!;
      expect(Number(arEntry.debit)).toBe(250);
      expect(Number(tuitionEntry.credit)).toBe(250);
    });

    it('non-positive totalAmount → drop (no batch)', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.invoice.created',
        payload: { invoiceId: generateId(), familyAccountId: generateId(), totalAmount: 0 },
      });
      await callHandle(msg);
      const batches = await batchCount(rawClient);
      expect(batches).toBe(0);
    });
  });

  describe('pay.payment.received → DR Cash / CR AR', () => {
    it('posts a balanced batch with Cash debit + AR credit', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.payment.received',
        payload: {
          paymentId: generateId(),
          invoiceId: generateId(),
          familyAccountId: generateId(),
          amount: 100,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: new Date().toISOString(),
        },
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_type FROM ${TEST_SCHEMA}.fin_journal_batches`,
      )) as Array<{ id: string; batch_type: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_PAYMENT');
      const cashId = await getAccountId('1000');
      const arId = await getAccountId('1100');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      expect(entries.length).toBe(2);
      const cashLine = entries.find((e) => e.account_id === cashId)!;
      const arLine = entries.find((e) => e.account_id === arId)!;
      expect(Number(cashLine.debit)).toBe(100);
      expect(Number(arLine.credit)).toBe(100);
    });

    it('zero amount → drop', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.payment.received',
        payload: {
          paymentId: generateId(),
          invoiceId: generateId(),
          familyAccountId: generateId(),
          amount: 0,
          paymentMethod: 'CARD',
          invoiceStatus: 'PAID',
          paidAt: new Date().toISOString(),
        },
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });

  describe('pay.refund.issued → DR AR / CR Cash', () => {
    it('posts a balanced batch with AR debit + Cash credit', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.refund.issued',
        payload: {
          refundId: generateId(),
          paymentId: generateId(),
          familyAccountId: generateId(),
          amount: 50,
          refundCategory: 'WITHDRAWAL',
        },
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_type FROM ${TEST_SCHEMA}.fin_journal_batches`,
      )) as Array<{ id: string; batch_type: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_REFUND');
      const arId = await getAccountId('1100');
      const cashId = await getAccountId('1000');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      const arLine = entries.find((e) => e.account_id === arId)!;
      const cashLine = entries.find((e) => e.account_id === cashId)!;
      expect(Number(arLine.debit)).toBe(50);
      expect(Number(cashLine.credit)).toBe(50);
    });

    it('non-positive amount → drop', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.refund.issued',
        payload: {
          refundId: generateId(),
          paymentId: generateId(),
          familyAccountId: generateId(),
          amount: 0,
          refundCategory: 'OTHER',
        },
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });

  describe('hr.payroll.processed → DR Salaries / CR Cash / CR Accrued Liab', () => {
    function payrollPayload(overrides: Record<string, unknown> = {}) {
      return {
        payrollRecordId: generateId(),
        schoolId: TEST_SCHOOL_ID,
        employeeId: generateId(),
        payPeriodId: generateId(),
        payDate: '2026-05-15',
        grossPay: 5000,
        totalDeductions: 1000,
        netPay: 4000,
        paidAt: new Date().toISOString(),
        ...overrides,
      };
    }

    it('balanced 3-line payroll batch (gross = net + deductions)', async () => {
      const msg = buildMessage({
        topic: 'dev.hr.payroll.processed',
        payload: payrollPayload(),
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_type, source_module FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'payroll'`,
      )) as Array<{ id: string; batch_type: string; source_module: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_PAYROLL');
      const salariesId = await getAccountId('5100');
      const cashId = await getAccountId('1000');
      const accruedId = await getAccountId('2100');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      expect(entries.length).toBe(3);
      const salariesLine = entries.find((e) => e.account_id === salariesId)!;
      const cashLine = entries.find((e) => e.account_id === cashId)!;
      const accruedLine = entries.find((e) => e.account_id === accruedId)!;
      expect(Number(salariesLine.debit)).toBe(5000);
      expect(Number(cashLine.credit)).toBe(4000);
      expect(Number(accruedLine.credit)).toBe(1000);
    });

    it('zero-deduction payroll → 2 lines only', async () => {
      const msg = buildMessage({
        topic: 'dev.hr.payroll.processed',
        payload: payrollPayload({ grossPay: 5000, totalDeductions: 0, netPay: 5000 }),
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.fin_journal_batches`,
      )) as Array<{ id: string }>;
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ n: number }>;
      expect(entries[0]!.n).toBe(2);
    });

    it('imbalanced gross != net + deductions → throws (refuse to post)', async () => {
      const msg = buildMessage({
        topic: 'dev.hr.payroll.processed',
        payload: payrollPayload({ grossPay: 5000, totalDeductions: 1000, netPay: 4500 }),
      });
      await expect(callHandle(msg)).rejects.toThrow(/refusing to post unbalanced batch/);
      expect(await batchCount(rawClient)).toBe(0);
    });

    it('non-positive grossPay → drop', async () => {
      const msg = buildMessage({
        topic: 'dev.hr.payroll.processed',
        payload: payrollPayload({ grossPay: 0, totalDeductions: 0, netPay: 0 }),
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });

    it('negative net or deductions → drop', async () => {
      const msg = buildMessage({
        topic: 'dev.hr.payroll.processed',
        payload: payrollPayload({ grossPay: 1000, totalDeductions: -100, netPay: 1100 }),
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });

  describe('evt.event.completed → DR Cash / CR Fee Revenue', () => {
    async function seedEventWithOrders(opts: {
      gross: number;
      refundsTotal?: number;
    }): Promise<string> {
      const eventId = generateId();
      // Seed evt_events row to satisfy any FK
      const orderId = generateId();
      // Find evt_events / evt_orders / evt_refunds schemas. For test
      // we directly seed evt_orders rows so loadEventNetRevenue() returns a sum.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_events (id, school_id, title, event_type, event_date, start_time, status, created_by)
         VALUES ($1::uuid, $2::uuid, $3, 'COMMUNITY', CURRENT_DATE, '12:00:00', 'COMPLETED', $4::uuid)
         ON CONFLICT (id) DO NOTHING`,
        eventId,
        TEST_SCHOOL_ID,
        'Test Event ' + eventId.slice(0, 6),
        '019e0cf8-aaaa-7777-8888-000000000012', // admin employee
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_orders (id, event_id, purchaser_id, total_amount, status, confirmed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, 'CONFIRMED', now())`,
        orderId,
        eventId,
        '019e0cf8-aaaa-7777-8888-000000000010', // admin person
        opts.gross,
      );
      if (opts.refundsTotal && opts.refundsTotal > 0) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.evt_refunds (id, order_id, refund_amount, reason, refunded_by)
           VALUES ($1::uuid, $2::uuid, $3::numeric, 'Test refund', $4::uuid)`,
          generateId(),
          orderId,
          opts.refundsTotal,
          '019e0cf8-aaaa-7777-8888-000000000012',
        );
      }
      return eventId;
    }

    afterAll(async () => {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_refunds WHERE refund_amount > 0`,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_orders WHERE event_id IN
           (SELECT id FROM ${TEST_SCHEMA}.evt_events WHERE title LIKE 'Test Event %')`,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_events WHERE title LIKE 'Test Event %'`,
      );
    });

    it('posts net revenue as DR Cash / CR Fee Revenue', async () => {
      const eventId = await seedEventWithOrders({ gross: 500, refundsTotal: 100 });
      const msg = buildMessage({
        topic: 'dev.evt.event.completed',
        payload: {
          eventId,
          schoolId: TEST_SCHOOL_ID,
          completedAt: new Date().toISOString(),
        },
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_type, source_module FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'events'`,
      )) as Array<{ id: string; batch_type: string; source_module: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_PAYMENT');
      const cashId = await getAccountId('1000');
      const feeRevId = await getAccountId('4100');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      const cashLine = entries.find((e) => e.account_id === cashId)!;
      const feeLine = entries.find((e) => e.account_id === feeRevId)!;
      expect(Number(cashLine.debit)).toBe(400); // net = gross 500 - refunds 100
      expect(Number(feeLine.credit)).toBe(400);
    });

    it('zero net revenue (refunds == gross) → no batch posted', async () => {
      const eventId = await seedEventWithOrders({ gross: 500, refundsTotal: 500 });
      const msg = buildMessage({
        topic: 'dev.evt.event.completed',
        payload: {
          eventId,
          schoolId: TEST_SCHOOL_ID,
          completedAt: new Date().toISOString(),
        },
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });

  describe('evt.refund.issued → DR Fee Revenue / CR Cash', () => {
    it('reverses cash leg of event revenue', async () => {
      const msg = buildMessage({
        topic: 'dev.evt.refund.issued',
        payload: {
          refundId: generateId(),
          orderId: generateId(),
          refundAmount: 75,
          reason: 'Customer requested refund',
        },
      });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_type FROM ${TEST_SCHEMA}.fin_journal_batches`,
      )) as Array<{ id: string; batch_type: string }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.batch_type).toBe('AUTO_REFUND');
      const cashId = await getAccountId('1000');
      const feeRevId = await getAccountId('4100');
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      const feeLine = entries.find((e) => e.account_id === feeRevId)!;
      const cashLine = entries.find((e) => e.account_id === cashId)!;
      expect(Number(feeLine.debit)).toBe(75);
      expect(Number(cashLine.credit)).toBe(75);
    });

    it('non-positive amount → drop', async () => {
      const msg = buildMessage({
        topic: 'dev.evt.refund.issued',
        payload: {
          refundId: generateId(),
          orderId: generateId(),
          refundAmount: 0,
          reason: 'test',
        },
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('replay same event_id → no duplicate batch', async () => {
      const eventId = generateId();
      const msg = buildMessage({
        topic: 'dev.pay.invoice.created',
        eventId,
        payload: {
          invoiceId: generateId(),
          familyAccountId: generateId(),
          totalAmount: 100,
        },
      });
      await callHandle(msg);
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(1);
    });

    it('claim row written after success', async () => {
      const eventId = generateId();
      const msg = buildMessage({
        topic: 'dev.pay.invoice.created',
        eventId,
        payload: {
          invoiceId: generateId(),
          familyAccountId: generateId(),
          totalAmount: 100,
        },
      });
      await callHandle(msg);
      const claim = (await rawClient.$queryRawUnsafe(
        `SELECT 1 AS ok FROM platform.platform_event_consumer_idempotency WHERE consumer_group = $1 AND event_id = $2`,
        CONSUMER_GROUP,
        eventId,
      )) as Array<{ ok: number }>;
      expect(claim.length).toBe(1);
    });
  });

  describe('routing edge cases', () => {
    it('unknown topic → no batch + no error', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.credit_note.issued',
        payload: { someField: 'x' },
      });
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });

    it('missing routing fields → drop with warn', async () => {
      const msg = buildMessage({
        topic: 'dev.pay.invoice.created',
        payload: {
          invoiceId: generateId(),
          familyAccountId: generateId(),
          totalAmount: 100,
        },
      });
      // Strip headers and envelope event_id
      msg.headers = {};
      (msg.payload as Record<string, unknown>).event_id = undefined;
      (msg.payload as Record<string, unknown>).tenant_id = undefined;
      await callHandle(msg);
      expect(await batchCount(rawClient)).toBe(0);
    });
  });
});

async function ensureExtraAccount(
  prisma: PrismaClient,
  code: string,
  name: string,
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE',
  normal: 'DEBIT' | 'CREDIT',
): Promise<void> {
  const id = generateId();
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fin_chart_of_accounts
       (id, school_id, fund_id, account_code, account_name, account_type, normal_balance, is_active, is_system)
     VALUES ($1::uuid, $2::uuid,
             (SELECT id FROM ${TEST_SCHEMA}.fin_funds WHERE school_id = $2::uuid LIMIT 1),
             $3, $4, $5, $6, true, false)
     ON CONFLICT (school_id, account_code) DO NOTHING`,
    id,
    TEST_SCHOOL_ID,
    code,
    name,
    type,
    normal,
  );
}

async function batchCount(prisma: PrismaClient): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches`,
  )) as Array<{ n: number }>;
  return rows[0]!.n;
}
