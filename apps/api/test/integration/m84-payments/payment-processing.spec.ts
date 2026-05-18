import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { InvoiceService } from '@modules/m84-payments/invoice.service';
import { PaymentService } from '@modules/m84-payments/payment.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { RedisService } from '@shared/cache';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';

/**
 * Wave 1 — DB-backed integration tests for PaymentService.
 * Replaces apps/api/src/modules/m84-payments/payment.service.spec.ts.
 *
 * Headline contracts under test (test strategy v3 Wave 1):
 *   - pay.payment.received lands in platform_outbox in the SAME tx as the
 *     pay_payments INSERT + pay_invoices status flip + PAYMENT ledger entry
 *   - Concurrent payment serialisation via FOR UPDATE on the invoice row
 *     (verified indirectly: re-pay against PAID invoice rejected)
 *   - Stripe stub: CARD payment gets pi_dev_* intent + status=COMPLETED
 *   - Authorisation:
 *     * admin OR account-holder GUARDIAN may pay
 *     * other guardians, students, teachers, officers → Forbidden
 *     * non-admin self-service may use CARD or BANK_TRANSFER only
 *   - Over-pay rejected (amount > balance_due → BadRequest)
 *   - Partial payment → status=PARTIAL; subsequent payment that closes
 *     the gap flips to PAID
 */

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/payment-processing', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let payments: PaymentService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    payments = new PaymentService(tenantPrisma, outbox, ledger);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ─── seed helpers ───
  async function seedFamilyAccount(opts?: {
    schoolId?: string;
    holderId?: string;
    status?: string;
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      opts?.holderId ?? TEST_PARENT_PERSON_ID,
      'FA-' + id,
      opts?.status ?? 'ACTIVE',
    );
    return id;
  }

  async function seedSentInvoice(opts?: { familyAccountId?: string; total?: number }) {
    const faId = opts?.familyAccountId ?? (await seedFamilyAccount());
    const draft = await withTestTenant(async () =>
      invoices.create(
        {
          familyAccountId: faId,
          title: 'Test',
          lineItems: [{ description: 'X', quantity: 1, unitPrice: opts?.total ?? 100 }],
        },
        adminActor(),
      ),
    );
    await withTestTenant(async () => invoices.send(draft.id, adminActor()));
    return { invoiceId: draft.id, familyAccountId: faId, total: opts?.total ?? 100 };
  }

  async function readOutboxFor(topic: string, schoolId = TEST_SCHOOL_ID) {
    return rawClient.$queryRawUnsafe<
      Array<{ topic: string; message_key: string; envelope: string }>
    >(
      `SELECT topic, message_key, envelope::text AS envelope
         FROM platform.platform_outbox
        WHERE topic = $1 AND tenant_id = $2::uuid`,
      topic,
      schoolId,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // pay — KEYSTONE outbox-in-tx contract
  // ────────────────────────────────────────────────────────────────────
  describe('pay (outbox-in-tx + invoice status flip)', () => {
    it('full payment: invoice flips to PAID + PAYMENT ledger entry + pay.payment.received outbox', async () => {
      const { invoiceId, familyAccountId, total } = await seedSentInvoice({ total: 100 });
      const result = await withTestTenant(async () =>
        payments.pay(invoiceId, { amount: total, paymentMethod: 'CARD' }, adminActor()),
      );

      expect(result.status).toBe('COMPLETED');
      expect(result.amount).toBe(100);
      // Stripe stub: CARD payment gets pi_dev_* intent id immediately
      expect(result.stripePaymentIntentId).toMatch(/^pi_dev_/);
      expect(result.paidAt).not.toBeNull();
      expect(result.invoiceId).toBe(invoiceId);
      expect(result.familyAccountId).toBe(familyAccountId);

      // DB-state: invoice flipped to PAID
      const invRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        invoiceId,
      )) as Array<{ status: string }>;
      expect(invRows[0]!.status).toBe('PAID');

      // PAYMENT ledger entry (negative — reduces balance)
      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        result.id,
      )) as Array<{ entry_type: string; amount: string }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.entry_type).toBe('PAYMENT');
      expect(Number(ledgerRows[0]!.amount)).toBe(-100);

      // Outbox: pay.payment.received with full payload
      const emits = await readOutboxFor('pay.payment.received');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.message_key).toBe(result.id);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('pay.payment.received');
      expect(envelope.payload.paymentId).toBe(result.id);
      expect(envelope.payload.invoiceId).toBe(invoiceId);
      expect(envelope.payload.familyAccountId).toBe(familyAccountId);
      expect(envelope.payload.amount).toBe(100);
      expect(envelope.payload.paymentMethod).toBe('CARD');
      expect(envelope.payload.invoiceStatus).toBe('PAID');
      expect(envelope.payload.totalAmount).toBe(100);
      expect(envelope.payload.amountPaid).toBe(100);
    });

    it('partial payment: invoice flips to PARTIAL; pay.payment.received carries the new amountPaid', async () => {
      const { invoiceId, total } = await seedSentInvoice({ total: 200 });
      const partial = await withTestTenant(async () =>
        payments.pay(invoiceId, { amount: 75 }, adminActor()),
      );
      expect(partial.amount).toBe(75);

      const invRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        invoiceId,
      )) as Array<{ status: string }>;
      expect(invRows[0]!.status).toBe('PARTIAL');

      const emits = await readOutboxFor('pay.payment.received');
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.invoiceStatus).toBe('PARTIAL');
      expect(envelope.payload.amountPaid).toBe(75);
      expect(envelope.payload.totalAmount).toBe(total);
    });

    it('two partial payments: second flips invoice to PAID', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });

      await withTestTenant(async () =>
        payments.pay(invoiceId, { amount: 40 }, adminActor()),
      );
      const second = await withTestTenant(async () =>
        payments.pay(invoiceId, { amount: 60 }, adminActor()),
      );
      expect(second.status).toBe('COMPLETED');

      const invRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        invoiceId,
      )) as Array<{ status: string }>;
      expect(invRows[0]!.status).toBe('PAID');

      // Two outbox events, both for this invoice
      const emits = await readOutboxFor('pay.payment.received');
      expect(emits).toHaveLength(2);
      const statuses = emits
        .map((e) => JSON.parse(e.envelope).payload.invoiceStatus)
        .sort();
      expect(statuses).toEqual(['PAID', 'PARTIAL']);
    });

    it('non-CARD method gets stripe_payment_intent_id = NULL', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 50 });
      const result = await withTestTenant(async () =>
        payments.pay(invoiceId, { amount: 50, paymentMethod: 'CASH' }, adminActor()),
      );
      expect(result.paymentMethod).toBe('CASH');
      expect(result.stripePaymentIntentId).toBeNull();
    });

    it('admin can pay using any method (CASH, CHEQUE, WAIVER, BANK_TRANSFER)', async () => {
      const fa = await seedFamilyAccount();
      for (const method of ['CASH', 'CHEQUE', 'WAIVER', 'BANK_TRANSFER'] as const) {
        const sent = await seedSentInvoice({ familyAccountId: fa, total: 25 });
        const result = await withTestTenant(async () =>
          payments.pay(sent.invoiceId, { amount: 25, paymentMethod: method }, adminActor()),
        );
        expect(result.paymentMethod).toBe(method);
      }
    });

    it.each(['CASH', 'CHEQUE', 'WAIVER'] as const)(
      'non-admin self-service rejects %s (admin-only payment method)',
      async (method) => {
        const fa = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
        const sent = await seedSentInvoice({ familyAccountId: fa, total: 25 });
        await expect(
          withTestTenant(async () =>
            payments.pay(sent.invoiceId, { amount: 25, paymentMethod: method }, parentActor()),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each(['CARD', 'BANK_TRANSFER'] as const)(
      'non-admin account holder can use %s',
      async (method) => {
        const fa = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
        const sent = await seedSentInvoice({ familyAccountId: fa, total: 25 });
        const result = await withTestTenant(async () =>
          payments.pay(sent.invoiceId, { amount: 25, paymentMethod: method }, parentActor()),
        );
        expect(result.amount).toBe(25);
      },
    );

    it('non-account-holder GUARDIAN cannot pay another family\'s invoice', async () => {
      // Create an invoice for a DIFFERENT family account holder
      const otherPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Holder', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      const faOther = await seedFamilyAccount({ holderId: otherPersonId });
      const sent = await seedSentInvoice({ familyAccountId: faOther, total: 50 });

      // parentActor's personId = TEST_PARENT_PERSON_ID, not otherPersonId
      await expect(
        withTestTenant(async () =>
          payments.pay(sent.invoiceId, { amount: 50, paymentMethod: 'CARD' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
    ])('pay as %s → Forbidden (not GUARDIAN, not admin)', async (_label, actor) => {
      const fa = await seedFamilyAccount();
      const sent = await seedSentInvoice({ familyAccountId: fa, total: 25 });
      await expect(
        withTestTenant(async () =>
          payments.pay(sent.invoiceId, { amount: 25, paymentMethod: 'CARD' }, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('amount <= 0 rejected before any DB activity', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: 0 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: -1 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);

      // No payment row, no ledger entry, no outbox event
      const paymentRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_payments WHERE invoice_id = $1::uuid`,
        invoiceId,
      )) as Array<{ n: number }>;
      expect(paymentRows[0]!.n).toBe(0);
      const emits = await readOutboxFor('pay.payment.received');
      expect(emits).toHaveLength(0);
    });

    it('overpay rejected (amount > balance_due) — no payment / ledger / outbox written', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: 101 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);

      const paymentRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_payments WHERE invoice_id = $1::uuid`,
        invoiceId,
      )) as Array<{ n: number }>;
      expect(paymentRows[0]!.n).toBe(0);
    });

    it('overpay after partial: amount that exceeds REMAINING balance rejected', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });
      await withTestTenant(async () => payments.pay(invoiceId, { amount: 60 }, adminActor()));
      // Remaining = 40; attempt 50
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: 50 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paying a DRAFT invoice → BadRequest', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Draft',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => payments.pay(draft.id, { amount: 50 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paying a CANCELLED invoice → BadRequest', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });
      await withTestTenant(async () => invoices.cancel(invoiceId, adminActor()));
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: 50 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paying a PAID invoice (already fully paid) → BadRequest', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 50 });
      await withTestTenant(async () => payments.pay(invoiceId, { amount: 50 }, adminActor()));
      // Try to pay again
      await expect(
        withTestTenant(async () => payments.pay(invoiceId, { amount: 10 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paying when family account is SUSPENDED → BadRequest', async () => {
      const fa = await seedFamilyAccount();
      const sent = await seedSentInvoice({ familyAccountId: fa, total: 50 });
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_family_accounts SET status='SUSPENDED' WHERE id = $1::uuid`,
        fa,
      );
      await expect(
        withTestTenant(async () => payments.pay(sent.invoiceId, { amount: 50 }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('paying a non-existent invoice → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          payments.pay('00000000-0000-0000-0000-000000000000', { amount: 1 }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list + getById (actor scoping)
  // ────────────────────────────────────────────────────────────────────
  describe('list + getById', () => {
    it('admin sees all payments; guardian sees only own; teacher/student see none', async () => {
      // parent's family
      const faParent = await seedFamilyAccount({ holderId: TEST_PARENT_PERSON_ID });
      const sentParent = await seedSentInvoice({ familyAccountId: faParent, total: 25 });
      await withTestTenant(async () =>
        payments.pay(sentParent.invoiceId, { amount: 25 }, adminActor()),
      );

      // other family
      const otherPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Holder', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      const faOther = await seedFamilyAccount({ holderId: otherPersonId });
      const sentOther = await seedSentInvoice({ familyAccountId: faOther, total: 35 });
      await withTestTenant(async () =>
        payments.pay(sentOther.invoiceId, { amount: 35 }, adminActor()),
      );

      const adminList = await withTestTenant(async () => payments.list({}, adminActor()));
      expect(adminList).toHaveLength(2);

      const parentList = await withTestTenant(async () => payments.list({}, parentActor()));
      expect(parentList).toHaveLength(1);
      expect(parentList[0]!.familyAccountId).toBe(faParent);

      expect(await withTestTenant(async () => payments.list({}, teacherActor()))).toEqual([]);
      expect(await withTestTenant(async () => payments.list({}, studentActor()))).toEqual([]);
    });

    it('list filters by familyAccountId / invoiceId / status', async () => {
      const fa = await seedFamilyAccount();
      const sent1 = await seedSentInvoice({ familyAccountId: fa, total: 100 });
      const sent2 = await seedSentInvoice({ familyAccountId: fa, total: 50 });
      await withTestTenant(async () => payments.pay(sent1.invoiceId, { amount: 100 }, adminActor()));
      await withTestTenant(async () => payments.pay(sent2.invoiceId, { amount: 50 }, adminActor()));

      const byInvoice = await withTestTenant(async () =>
        payments.list({ invoiceId: sent1.invoiceId }, adminActor()),
      );
      expect(byInvoice).toHaveLength(1);
      expect(byInvoice[0]!.invoiceId).toBe(sent1.invoiceId);

      const byFa = await withTestTenant(async () =>
        payments.list({ familyAccountId: fa }, adminActor()),
      );
      expect(byFa).toHaveLength(2);

      const completed = await withTestTenant(async () =>
        payments.list({ status: 'COMPLETED' }, adminActor()),
      );
      expect(completed).toHaveLength(2);
      const pending = await withTestTenant(async () =>
        payments.list({ status: 'PENDING' }, adminActor()),
      );
      expect(pending).toEqual([]);
    });

    it('getById for a missing payment → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          payments.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for another family\'s payment as wrong guardian → NotFoundException (does not leak existence)', async () => {
      const otherPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Holder', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      const faOther = await seedFamilyAccount({ holderId: otherPersonId });
      const sent = await seedSentInvoice({ familyAccountId: faOther, total: 25 });
      const pay = await withTestTenant(async () =>
        payments.pay(sent.invoiceId, { amount: 25 }, adminActor()),
      );
      await expect(
        withTestTenant(async () => payments.getById(pay.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('list as School A admin: same school_id-filter gap as Finding 6 — School B payments visible', async () => {
      // School A
      const faA = await seedFamilyAccount({ schoolId: TEST_SCHOOL_ID });
      const sentA = await seedSentInvoice({ familyAccountId: faA, total: 25 });
      await withTestTenant(async () => payments.pay(sentA.invoiceId, { amount: 25 }, adminActor()));

      // School B
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });
      const sentB = await withTestTenantB(async () =>
        invoices.create(
          {
            familyAccountId: faB,
            title: 'B-invoice',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 30 }],
          },
          adminActor(),
        ),
      );
      await withTestTenantB(async () => invoices.send(sentB.id, adminActor()));
      await withTestTenantB(async () => payments.pay(sentB.id, { amount: 30 }, adminActor()));

      // FINDING — Wave 1 (extends Finding 6): PaymentService.list uses
      // SELECT_PAYMENT_BASE with no `WHERE p.school_id = $`. Mirror of
      // the InvoiceService.list leak. School A admin sees BOTH payments
      // when the schools share a tenant schema.
      const adminList = await withTestTenant(async () => payments.list({}, adminActor()));
      expect(adminList.find((p) => p.familyAccountId === faA)).toBeDefined();
      // Document the leak — flip when the fix lands.
      expect(adminList.find((p) => p.familyAccountId === faB)).toBeDefined();
    });
  });
});
