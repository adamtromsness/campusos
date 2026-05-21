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
import { RefundService } from '@modules/m84-payments/refund.service';
import { CreditNoteService } from '@modules/m84-payments/credit-note.service';
import {
  ReversalService,
  deterministicReversalEventId,
} from '@modules/m84-payments/reversal.service';
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
 * Wave 1 — DB-backed integration tests for the refund / credit-note /
 * reversal surfaces in m84-payments. Replaces three mock specs:
 *   - refund.service.spec.ts
 *   - credit-note.service.spec.ts
 *   - reversal.service.spec.ts
 *
 * Headline strategy-doc contracts under test:
 *   - IMMUTABLE pay_credit_notes (INSERT ok, UPDATE/DELETE → SQLSTATE 23001)
 *   - IMMUTABLE pay_payment_reversals (same contract)
 *   - pay.refund.issued outbox-in-tx + REFUND ledger entry + invoice status
 *     recompute (PAID → SENT on full refund, PAID → PARTIAL on partial)
 *   - pay.credit_note.issued outbox-in-tx + CREDIT ledger entry
 *   - pay.payment.reversed outbox-in-tx with deterministic event_id +
 *     CHARGE ledger entry + payment status FAILED + invoice OVERDUE recompute
 *   - UNIQUE(pay_payment_reversals.payment_id) — second reversal rejected
 *   - Lock ordering: invoice FOR UPDATE first, then payment (deadlock
 *     avoidance with PaymentService.pay)
 */

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/refunds-reversals', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let payments: PaymentService;
  let refunds: RefundService;
  let credits: CreditNoteService;
  let reversals: ReversalService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    payments = new PaymentService(tenantPrisma, outbox, ledger);
    refunds = new RefundService(tenantPrisma, outbox, ledger);
    credits = new CreditNoteService(tenantPrisma, outbox, ledger);
    reversals = new ReversalService(tenantPrisma, outbox, ledger);
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
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      opts?.holderId ?? TEST_PARENT_PERSON_ID,
      'FA-' + id,
    );
    return id;
  }

  async function seedPaidInvoice(opts?: {
    familyAccountId?: string;
    total?: number;
  }): Promise<{ invoiceId: string; paymentId: string; familyAccountId: string; total: number }> {
    const fa = opts?.familyAccountId ?? (await seedFamilyAccount());
    const total = opts?.total ?? 100;
    const draft = await withTestTenant(async () =>
      invoices.create(
        {
          familyAccountId: fa,
          title: 'Paid',
          lineItems: [{ description: 'X', quantity: 1, unitPrice: total }],
        },
        adminActor(),
      ),
    );
    await withTestTenant(async () => invoices.send(draft.id, adminActor()));
    const pay = await withTestTenant(async () =>
      payments.pay(draft.id, { amount: total }, adminActor()),
    );
    return { invoiceId: draft.id, paymentId: pay.id, familyAccountId: fa, total };
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
  // RefundService.issue
  // ────────────────────────────────────────────────────────────────────
  describe('RefundService.issue', () => {
    it('full refund: REFUND ledger entry + payment → REFUNDED + invoice PAID → SENT + outbox', async () => {
      const { invoiceId, paymentId, familyAccountId, total } = await seedPaidInvoice({
        total: 100,
      });

      const refund = await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: total, refundCategory: 'OVERPAYMENT', reason: 'duplicate charge' },
          adminActor(),
        ),
      );

      expect(refund.amount).toBe(100);
      expect(refund.status).toBe('COMPLETED');
      expect(refund.stripeRefundId).toMatch(/^re_dev_/);
      expect(refund.familyAccountId).toBe(familyAccountId);

      // Payment flipped to REFUNDED, invoice back to SENT
      const stateRows = (await rawClient.$queryRawUnsafe(
        `SELECT p.status AS p_status, i.status AS i_status
           FROM ${TEST_SCHEMA}.pay_payments p JOIN ${TEST_SCHEMA}.pay_invoices i ON i.id = p.invoice_id
          WHERE p.id = $1::uuid`,
        paymentId,
      )) as Array<{ p_status: string; i_status: string }>;
      expect(stateRows[0]!.p_status).toBe('REFUNDED');
      expect(stateRows[0]!.i_status).toBe('SENT');

      // REFUND ledger entry: positive (restores balance owed)
      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        refund.id,
      )) as Array<{ entry_type: string; amount: string }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.entry_type).toBe('REFUND');
      expect(Number(ledgerRows[0]!.amount)).toBe(100);

      // Outbox: pay.refund.issued
      const emits = await readOutboxFor('pay.refund.issued');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.message_key).toBe(refund.id);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('pay.refund.issued');
      expect(envelope.payload.refundId).toBe(refund.id);
      expect(envelope.payload.paymentId).toBe(paymentId);
      expect(envelope.payload.familyAccountId).toBe(familyAccountId);
      expect(envelope.payload.amount).toBe(100);
      expect(envelope.payload.refundCategory).toBe('OVERPAYMENT');
      expect(envelope.payload.status).toBe('COMPLETED');
      // referenceId for the assertion: invoice id is on the invoice
      expect(invoiceId).toBeDefined();
    });

    it('partial refund: payment stays COMPLETED; invoice PAID → PARTIAL', async () => {
      const { invoiceId, paymentId } = await seedPaidInvoice({ total: 100 });

      await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: 30, refundCategory: 'GOODWILL', reason: 'partial' },
          adminActor(),
        ),
      );

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT p.status AS p_status, i.status AS i_status
           FROM ${TEST_SCHEMA}.pay_payments p JOIN ${TEST_SCHEMA}.pay_invoices i ON i.id = p.invoice_id
          WHERE p.id = $1::uuid`,
        paymentId,
      )) as Array<{ p_status: string; i_status: string }>;
      expect(rows[0]!.p_status).toBe('COMPLETED');
      expect(rows[0]!.i_status).toBe('PARTIAL');
      expect(invoiceId).toBeDefined();
    });

    it('two partial refunds that together net the invoice → final invoice status SENT', async () => {
      const { paymentId, invoiceId } = await seedPaidInvoice({ total: 100 });

      await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: 40, refundCategory: 'GOODWILL', reason: 'r1' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: 60, refundCategory: 'GOODWILL', reason: 'r2' },
          adminActor(),
        ),
      );

      const invRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        invoiceId,
      )) as Array<{ status: string }>;
      expect(invRows[0]!.status).toBe('SENT');

      const emits = await readOutboxFor('pay.refund.issued');
      expect(emits).toHaveLength(2);
    });

    it('over-refund across partials → BadRequest (exceeds remaining refundable)', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 100 });
      await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: 70, refundCategory: 'GOODWILL', reason: 'r1' },
          adminActor(),
        ),
      );
      // Remaining = 30; attempt 50
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            paymentId,
            { amount: 50, refundCategory: 'GOODWILL', reason: 'r2' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('amount ≤ 0 → BadRequest', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 50 });
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            paymentId,
            { amount: 0, refundCategory: 'OTHER', reason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refunding a non-COMPLETED payment → BadRequest', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 50 });
      // Flip payment to FAILED via direct SQL to simulate a state we cannot
      // refund
      // pay_payments_paid_chk requires paid_at IS NULL when status='FAILED'
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_payments SET status='FAILED', paid_at=NULL WHERE id = $1::uuid`,
        paymentId,
      );
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            paymentId,
            { amount: 50, refundCategory: 'OTHER', reason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refunding a non-existent payment → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            '00000000-0000-0000-0000-000000000000',
            { amount: 1, refundCategory: 'OTHER', reason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('issue as %s → ForbiddenException', async (_label, actor) => {
      const { paymentId } = await seedPaidInvoice({ total: 50 });
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            paymentId,
            { amount: 25, refundCategory: 'OTHER', reason: 'x' },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => refunds.list({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by paymentId / familyAccountId / status', async () => {
      const { paymentId, familyAccountId } = await seedPaidInvoice({ total: 100 });
      const r1 = await withTestTenant(async () =>
        refunds.issue(
          paymentId,
          { amount: 25, refundCategory: 'GOODWILL', reason: 'a' },
          adminActor(),
        ),
      );

      const byPayment = await withTestTenant(async () =>
        refunds.list({ paymentId }, adminActor()),
      );
      expect(byPayment).toHaveLength(1);
      expect(byPayment[0]!.id).toBe(r1.id);

      const byFa = await withTestTenant(async () =>
        refunds.list({ familyAccountId }, adminActor()),
      );
      expect(byFa).toHaveLength(1);

      const byStatus = await withTestTenant(async () =>
        refunds.list({ status: 'COMPLETED' }, adminActor()),
      );
      expect(byStatus).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CreditNoteService.issue
  // ────────────────────────────────────────────────────────────────────
  describe('CreditNoteService.issue', () => {
    it('happy path: pay_credit_notes row + CREDIT ledger entry + outbox', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'For credit',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 200 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(draft.id, adminActor()));

      const credit = await withTestTenant(async () =>
        credits.issue(
          draft.id,
          { creditAmount: 50, creditCategory: 'GOODWILL', reason: 'apology' },
          adminActor(),
        ),
      );
      expect(credit.creditAmount).toBe(50);
      expect(credit.creditCategory).toBe('GOODWILL');
      expect(credit.reason).toBe('apology');
      expect(credit.invoiceId).toBe(draft.id);
      expect(credit.familyAccountId).toBe(fa);

      // CREDIT ledger entry: negative (reduces balance owed)
      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        credit.id,
      )) as Array<{ entry_type: string; amount: string }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.entry_type).toBe('CREDIT');
      expect(Number(ledgerRows[0]!.amount)).toBe(-50);

      // Outbox: pay.credit_note.issued
      const emits = await readOutboxFor('pay.credit_note.issued');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.message_key).toBe(credit.id);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('pay.credit_note.issued');
      expect(envelope.payload.creditNoteId).toBe(credit.id);
      expect(envelope.payload.invoiceId).toBe(draft.id);
      expect(envelope.payload.creditAmount).toBe(50);
    });

    it('rejects creditAmount ≤ 0', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          credits.issue(draft.id, { creditAmount: 0, reason: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects empty reason', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          credits.issue(draft.id, { creditAmount: 10, reason: '   ' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects CANCELLED invoice', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.cancel(draft.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          credits.issue(draft.id, { creditAmount: 10, reason: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects missing invoice (school-scoped lookup → NotFound)', async () => {
      await expect(
        withTestTenant(async () =>
          credits.issue(
            '00000000-0000-0000-0000-000000000000',
            { creditAmount: 10, reason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A actor cannot issue credit against School B invoice (NotFound, not 403 — does not leak existence)', async () => {
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });
      const draftB = await withTestTenantB(async () =>
        invoices.create(
          {
            familyAccountId: faB,
            title: 'B',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await withTestTenantB(async () => invoices.send(draftB.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          credits.issue(draftB.id, { creditAmount: 10, reason: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects lineItemId that does not belong to this invoice', async () => {
      const fa = await seedFamilyAccount();
      const draft1 = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'I1',
            lineItems: [{ description: 'A', quantity: 1, unitPrice: 25 }],
          },
          adminActor(),
        ),
      );
      const draft2 = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'I2',
            lineItems: [{ description: 'B', quantity: 1, unitPrice: 25 }],
          },
          adminActor(),
        ),
      );
      // The wrong invoice's line item
      const otherLineId = draft2.lineItems[0]!.id;
      await expect(
        withTestTenant(async () =>
          credits.issue(
            draft1.id,
            { creditAmount: 5, reason: 'x', lineItemId: otherLineId },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('issue as %s → ForbiddenException', async (_label, actor) => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          credits.issue(draft.id, { creditAmount: 5, reason: 'x' }, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list / getById as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => credits.list({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          credits.getById('00000000-0000-0000-0000-000000000000', parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // IMMUTABLE pay_credit_notes (migration 177 prevent_mutation trigger)
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE pay_credit_notes', () => {
    async function seedCreditNote(): Promise<string> {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(draft.id, adminActor()));
      const c = await withTestTenant(async () =>
        credits.issue(draft.id, { creditAmount: 10, reason: 'x' }, adminActor()),
      );
      return c.id;
    }

    it('UPDATE pay_credit_notes.reason → SQLSTATE 23001', async () => {
      const id = await seedCreditNote();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pay_credit_notes SET reason = 'tampered' WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001') || msg.toLowerCase().includes('immutable')).toBe(
        true,
      );
    });

    it('UPDATE pay_credit_notes.credit_amount → SQLSTATE 23001', async () => {
      const id = await seedCreditNote();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pay_credit_notes SET credit_amount = 999 WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('DELETE FROM pay_credit_notes → SQLSTATE 23001', async () => {
      const id = await seedCreditNote();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.pay_credit_notes WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ReversalService.reverse
  // ────────────────────────────────────────────────────────────────────
  describe('ReversalService.reverse', () => {
    // FINDING — Wave 1 #7: ReversalService.reverse flips pay_payments
    // status to FAILED without nulling paid_at, violating
    // pay_payments_paid_chk (which requires paid_at IS NULL when status
    // IN ('PENDING','FAILED')). The 4 tests below that drive
    // reverse() to that UPDATE are deferred until the service is fixed
    // (one-line: `SET status='FAILED', paid_at=NULL, updated_at=now()`).
    // The IMMUTABLE pay_payment_reversals contract is still verified
    // via raw-SQL-seeded reversal rows below.
    it('happy path: pay_payment_reversals row + CHARGE ledger + payment FAILED + invoice OVERDUE-recompute (here: SENT) [Finding 7 FIXED]', async () => {
      const { paymentId, familyAccountId, invoiceId, total } = await seedPaidInvoice({
        total: 100,
      });

      const rev = await withTestTenant(async () =>
        reversals.reverse(
          paymentId,
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'cheque bounced' },
          adminActor(),
        ),
      );
      expect(rev.paymentId).toBe(paymentId);
      expect(rev.familyAccountId).toBe(familyAccountId);
      expect(rev.invoiceId).toBe(invoiceId);
      expect(rev.reversalType).toBe('BOUNCED_CHEQUE');
      expect(rev.reversedAmount).toBe(total);

      // Payment flipped to FAILED, invoice recomputed (PAID → SENT since
      // netPaid drops to 0)
      const state = (await rawClient.$queryRawUnsafe(
        `SELECT p.status AS p_status, i.status AS i_status
           FROM ${TEST_SCHEMA}.pay_payments p JOIN ${TEST_SCHEMA}.pay_invoices i ON i.id = p.invoice_id
          WHERE p.id = $1::uuid`,
        paymentId,
      )) as Array<{ p_status: string; i_status: string }>;
      expect(state[0]!.p_status).toBe('FAILED');
      expect(state[0]!.i_status).toBe('SENT');

      // CHARGE ledger entry: positive (restores balance owed)
      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        rev.id,
      )) as Array<{ entry_type: string; amount: string }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.entry_type).toBe('CHARGE');
      expect(Number(ledgerRows[0]!.amount)).toBe(100);

      // Outbox: pay.payment.reversed with deterministic event_id
      const emits = await readOutboxFor('pay.payment.reversed');
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('pay.payment.reversed');
      expect(envelope.event_id).toBe(deterministicReversalEventId(rev.id));
      expect(envelope.payload.reversalId).toBe(rev.id);
      expect(envelope.payload.paymentId).toBe(paymentId);
      expect(envelope.payload.invoiceId).toBe(invoiceId);
      expect(envelope.payload.familyAccountId).toBe(familyAccountId);
      expect(envelope.payload.reversalType).toBe('BOUNCED_CHEQUE');
      expect(envelope.payload.reversedAmount).toBe(100);
    });

    it('UNIQUE(payment_id): second reversal on same payment → BadRequest [Finding 7 FIXED]', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 100 });
      await withTestTenant(async () =>
        reversals.reverse(
          paymentId,
          { reversalType: 'CHARGEBACK', reversalReason: 'r1' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            paymentId,
            { reversalType: 'CHARGEBACK', reversalReason: 'r2' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reversal of a non-COMPLETED payment → BadRequest', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 100 });
      // pay_payments_paid_chk requires paid_at IS NULL when status='FAILED'
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_payments SET status='FAILED', paid_at=NULL WHERE id = $1::uuid`,
        paymentId,
      );
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            paymentId,
            { reversalType: 'OTHER', reversalReason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty reversalReason → BadRequest', async () => {
      const { paymentId } = await seedPaidInvoice({ total: 100 });
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            paymentId,
            { reversalType: 'OTHER', reversalReason: '   ' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing payment → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            '00000000-0000-0000-0000-000000000000',
            { reversalType: 'OTHER', reversalReason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school payment id → NotFoundException (school-scoped lookup)', async () => {
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });
      const draftB = await withTestTenantB(async () =>
        invoices.create(
          {
            familyAccountId: faB,
            title: 'B',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await withTestTenantB(async () => invoices.send(draftB.id, adminActor()));
      const payB = await withTestTenantB(async () =>
        payments.pay(draftB.id, { amount: 50 }, adminActor()),
      );
      // School A actor cannot reverse School B's payment
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            payB.id,
            { reversalType: 'OTHER', reversalReason: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('reverse as %s → ForbiddenException', async (_label, actor) => {
      const { paymentId } = await seedPaidInvoice({ total: 50 });
      await expect(
        withTestTenant(async () =>
          reversals.reverse(
            paymentId,
            { reversalType: 'OTHER', reversalReason: 'x' },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list / getById as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => reversals.list({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          reversals.getById('00000000-0000-0000-0000-000000000000', parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list as admin scopes to current school + filters by familyAccountId / invoiceId [Finding 7 FIXED]', async () => {
      const { paymentId, familyAccountId, invoiceId } = await seedPaidInvoice({ total: 50 });
      const rev = await withTestTenant(async () =>
        reversals.reverse(
          paymentId,
          { reversalType: 'OTHER', reversalReason: 'x' },
          adminActor(),
        ),
      );

      const byFa = await withTestTenant(async () =>
        reversals.list({ familyAccountId }, adminActor()),
      );
      expect(byFa).toHaveLength(1);
      expect(byFa[0]!.id).toBe(rev.id);

      const byInvoice = await withTestTenant(async () =>
        reversals.list({ invoiceId }, adminActor()),
      );
      expect(byInvoice).toHaveLength(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // IMMUTABLE pay_payment_reversals
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE pay_payment_reversals', () => {
    // Seed a pay_payment_reversals row via direct SQL — sidesteps
    // Finding 7 (ReversalService.reverse hits the pay_payments_paid_chk).
    // The IMMUTABLE trigger contract is a DB-level invariant on the
    // reversals table itself, so the seed doesn't need to go through
    // the service.
    async function seedReversal(): Promise<string> {
      const { paymentId, familyAccountId, invoiceId } = await seedPaidInvoice({
        total: 50,
      });
      const reversalId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_payment_reversals
           (id, school_id, payment_id, family_account_id, invoice_id, reversal_type, reversal_reason, reversed_amount, reversed_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'OTHER', 'seed', 50, $6::uuid)`,
        reversalId,
        TEST_SCHOOL_ID,
        paymentId,
        familyAccountId,
        invoiceId,
        '019e0cf8-aaaa-7777-8888-000000000011', // TEST_ADMIN_ACCOUNT_ID
      );
      return reversalId;
    }

    it('UPDATE pay_payment_reversals.reversal_reason → SQLSTATE 23001', async () => {
      const id = await seedReversal();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pay_payment_reversals SET reversal_reason = 'tampered' WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('UPDATE pay_payment_reversals.reversed_amount → SQLSTATE 23001', async () => {
      const id = await seedReversal();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pay_payment_reversals SET reversed_amount = 999 WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('DELETE FROM pay_payment_reversals → SQLSTATE 23001', async () => {
      const id = await seedReversal();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.pay_payment_reversals WHERE id = $1::uuid`,
          id,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });
  });
});
