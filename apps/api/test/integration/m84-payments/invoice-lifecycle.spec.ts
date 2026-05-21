import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { InvoiceService } from '@modules/m84-payments/invoice.service';
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
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';

/**
 * Wave 1 — DB-backed integration tests for the m84-payments invoice
 * lifecycle (InvoiceService). Replaces apps/api/src/modules/m84-payments/
 * invoice.service.spec.ts.
 *
 * Headline contracts under test (from test strategy v3 Wave 1):
 *   - pay.invoice.created lands in platform_outbox in the SAME tx as the
 *     pay_invoices status flip to SENT (NOT on create — DRAFT does not emit)
 *   - pay.debt.written_off lands in platform_outbox when cancel() leaves
 *     an outstanding balance, in the same tx as the ADJUSTMENT ledger entry
 *   - Cross-school: list/getById as a School A actor sees no School B rows
 *   - Guardian access: GUARDIAN actor can only see invoices where they are
 *     the family account holder
 */

// Stub RedisService — LedgerService.recordEntry invokes
// invalidateLedgerBalance best-effort; safe to no-op for integration tests.
function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/invoice-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
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

  /**
   * Seed a family account for School A, optionally with a different
   * holderId. The default holder is the integration parent actor so the
   * GUARDIAN-access path can be exercised against the same row.
   */
  async function seedFamilyAccount(opts?: {
    schoolId?: string;
    holderId?: string;
    accountNumber?: string;
    status?: string;
  }): Promise<string> {
    const id = generateId();
    const schoolId = opts?.schoolId ?? TEST_SCHOOL_ID;
    const holderId = opts?.holderId ?? TEST_PARENT_PERSON_ID;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
      id,
      schoolId,
      holderId,
      opts?.accountNumber ?? 'FA-' + id,
      opts?.status ?? 'ACTIVE',
    );
    return id;
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
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('happy path: admin creates DRAFT invoice with line items and computed total', async () => {
      const fa = await seedFamilyAccount();

      const result = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Term 1 tuition',
            description: 'Q1 fees',
            lineItems: [
              { description: 'Tuition', quantity: 1, unitPrice: 1000 },
              { description: 'Tech fee', quantity: 1, unitPrice: 50 },
            ],
          },
          adminActor(),
        ),
      );

      expect(result.status).toBe('DRAFT');
      expect(result.totalAmount).toBe(1050);
      expect(result.balanceDue).toBe(1050);
      expect(result.sentAt).toBeNull();
      expect(result.lineItems).toHaveLength(2);

      // DB-state assertion
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, total_amount FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        result.id,
      )) as Array<{ status: string; total_amount: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
      expect(Number(rows[0]!.total_amount)).toBe(1050);

      // Creating a DRAFT does NOT emit pay.invoice.created
      const emits = await readOutboxFor('pay.invoice.created');
      expect(emits).toHaveLength(0);
    });

    it('rejects missing family account (NotFoundException)', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.create(
            {
              familyAccountId: '00000000-0000-0000-0000-000000000000',
              title: 'X',
              lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects suspended family account (BadRequestException)', async () => {
      const fa = await seedFamilyAccount({ status: 'SUSPENDED' });
      await expect(
        withTestTenant(async () =>
          invoices.create(
            {
              familyAccountId: fa,
              title: 'X',
              lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
            },
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
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      const fa = await seedFamilyAccount();
      await expect(
        withTestTenant(async () =>
          invoices.create(
            {
              familyAccountId: fa,
              title: 'X',
              lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
            },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('per-line total is computed (quantity × unitPrice) and the invoice total is SUM(lines)', async () => {
      const fa = await seedFamilyAccount();
      const result = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Bulk',
            lineItems: [
              { description: 'A', quantity: 3, unitPrice: 25 }, // 75
              { description: 'B', quantity: 2, unitPrice: 50 }, // 100
              { description: 'C', quantity: 1, unitPrice: 12.5 }, // 12.5
            ],
          },
          adminActor(),
        ),
      );
      expect(result.totalAmount).toBe(187.5);
      expect(result.lineItems.find((l) => l.description === 'A')!.total).toBe(75);
      expect(result.lineItems.find((l) => l.description === 'B')!.total).toBe(100);
      expect(result.lineItems.find((l) => l.description === 'C')!.total).toBe(12.5);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // send — KEYSTONE outbox-in-tx contract
  // ────────────────────────────────────────────────────────────────────
  describe('send (outbox-in-tx)', () => {
    it('flips DRAFT→SENT, stamps sent_at, writes CHARGE ledger entry, emits pay.invoice.created', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Send me',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
          },
          adminActor(),
        ),
      );

      const sent = await withTestTenant(async () => invoices.send(draft.id, adminActor()));
      expect(sent.status).toBe('SENT');
      expect(sent.sentAt).not.toBeNull();

      // DB-state assertions
      const invRows = (await rawClient.$queryRawUnsafe(
        `SELECT status, sent_at IS NOT NULL AS sent_at_set FROM ${TEST_SCHEMA}.pay_invoices WHERE id = $1::uuid`,
        draft.id,
      )) as Array<{ status: string; sent_at_set: boolean }>;
      expect(invRows[0]!.status).toBe('SENT');
      expect(invRows[0]!.sent_at_set).toBe(true);

      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        draft.id,
      )) as Array<{ entry_type: string; amount: string }>;
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]!.entry_type).toBe('CHARGE');
      expect(Number(ledgerRows[0]!.amount)).toBe(100);

      // The outbox row is the headline contract
      const emits = await readOutboxFor('pay.invoice.created');
      expect(emits).toHaveLength(1);
      expect(emits[0]!.message_key).toBe(draft.id);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('pay.invoice.created');
      expect(envelope.tenant_id).toBe(TEST_SCHOOL_ID);
      expect(envelope.payload.invoiceId).toBe(draft.id);
      expect(envelope.payload.familyAccountId).toBe(fa);
      expect(envelope.payload.totalAmount).toBe(100);
    });

    it('non-existent invoice → NotFoundException, no outbox row, no ledger entry', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.send('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const emits = await readOutboxFor('pay.invoice.created');
      expect(emits).toHaveLength(0);
    });

    it('SENT invoice cannot be re-sent (BadRequestException), no duplicate outbox row', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Once',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(draft.id, adminActor()));
      await expect(
        withTestTenant(async () => invoices.send(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Still only one outbox row
      const emits = await readOutboxFor('pay.invoice.created');
      expect(emits).toHaveLength(1);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('send as %s → ForbiddenException', async (_label, actor) => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => invoices.send(draft.id, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cancel — write-off contract on outstanding balance
  // ────────────────────────────────────────────────────────────────────
  describe('cancel', () => {
    it('DRAFT cancel: flips to CANCELLED, no ledger entry, no outbox event', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'D',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
          },
          adminActor(),
        ),
      );
      const cancelled = await withTestTenant(async () => invoices.cancel(draft.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');

      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid`,
        draft.id,
      )) as Array<{ n: number }>;
      expect(ledgerRows[0]!.n).toBe(0);

      const emits = await readOutboxFor('pay.debt.written_off');
      expect(emits).toHaveLength(0);
    });

    it('SENT cancel (no payments): ADJUSTMENT for full outstanding + pay.debt.written_off outbox', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'WriteOff',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 250 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(draft.id, adminActor()));
      await withTestTenant(async () => invoices.cancel(draft.id, adminActor()));

      const ledgerRows = (await rawClient.$queryRawUnsafe(
        `SELECT entry_type, amount::text AS amount FROM ${TEST_SCHEMA}.pay_ledger_entries WHERE reference_id = $1::uuid ORDER BY entry_type`,
        draft.id,
      )) as Array<{ entry_type: string; amount: string }>;
      // One CHARGE (+250) + one ADJUSTMENT (-250)
      expect(ledgerRows).toHaveLength(2);
      const adj = ledgerRows.find((r) => r.entry_type === 'ADJUSTMENT')!;
      expect(Number(adj.amount)).toBe(-250);

      const emits = await readOutboxFor('pay.debt.written_off');
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.invoiceId).toBe(draft.id);
      expect(envelope.payload.totalAmount).toBe(250);
      expect(envelope.payload.completedPayments).toBe(0);
      expect(envelope.payload.outstandingWritten).toBe(250);
    });

    it('cancel already-CANCELLED → BadRequestException', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.cancel(draft.id, adminActor()));
      await expect(
        withTestTenant(async () => invoices.cancel(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel a PAID invoice → BadRequestException (issue a refund instead)', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'Paid',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 50 }],
          },
          adminActor(),
        ),
      );
      // Flip to PAID directly to simulate a fully-paid invoice
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_invoices SET status='PAID', sent_at = now() WHERE id = $1::uuid`,
        draft.id,
      );
      await expect(
        withTestTenant(async () => invoices.cancel(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.cancel('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('cancel as %s → ForbiddenException', async (_label, actor) => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => invoices.cancel(draft.id, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list + getById — actor scoping
  // ────────────────────────────────────────────────────────────────────
  describe('list + getById (actor scoping)', () => {
    it('admin sees all school invoices; guardian sees only their own; student/teacher see none', async () => {
      // Parent owns family account A (using TEST_PARENT_PERSON_ID)
      const faParent = await seedFamilyAccount();
      const otherPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Holder', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      const faOther = await seedFamilyAccount({ holderId: otherPersonId });

      await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: faParent,
            title: 'For Parent',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: faOther,
            title: 'For Other',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );

      const adminList = await withTestTenant(async () => invoices.list({}, adminActor()));
      expect(adminList).toHaveLength(2);

      const parentList = await withTestTenant(async () => invoices.list({}, parentActor()));
      expect(parentList).toHaveLength(1);
      expect(parentList[0]!.familyAccountId).toBe(faParent);

      const teacherList = await withTestTenant(async () => invoices.list({}, teacherActor()));
      expect(teacherList).toEqual([]);

      const studentList = await withTestTenant(async () => invoices.list({}, studentActor()));
      expect(studentList).toEqual([]);
    });

    it('list filters by status and familyAccountId', async () => {
      const fa = await seedFamilyAccount();
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'D',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      const sent = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'S',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(sent.id, adminActor()));

      const draftList = await withTestTenant(async () =>
        invoices.list({ status: 'DRAFT' }, adminActor()),
      );
      expect(draftList.map((i) => i.id)).toEqual([draft.id]);

      const sentList = await withTestTenant(async () =>
        invoices.list({ status: 'SENT' }, adminActor()),
      );
      expect(sentList.map((i) => i.id)).toEqual([sent.id]);

      const byFa = await withTestTenant(async () =>
        invoices.list({ familyAccountId: fa }, adminActor()),
      );
      expect(byFa).toHaveLength(2);
    });

    it('getById for missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for an invoice owned by another family → NotFoundException for the wrong guardian', async () => {
      const otherPersonId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Holder', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        otherPersonId,
      );
      const faOther = await seedFamilyAccount({ holderId: otherPersonId });
      const draft = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: faOther,
            title: 'Other family',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 1 }],
          },
          adminActor(),
        ),
      );
      // parentActor's personId = TEST_PARENT_PERSON_ID, not the other holder
      await expect(
        withTestTenant(async () => invoices.getById(draft.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('admin in School A cannot see invoices created in School B via list', async () => {
      const faA = await seedFamilyAccount({ schoolId: TEST_SCHOOL_ID });
      const faB = await seedFamilyAccount({ schoolId: TEST_SCHOOL_B_ID });

      await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: faA,
            title: 'A invoice',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 10 }],
          },
          adminActor(),
        ),
      );
      await withTestTenantB(async () =>
        invoices.create(
          {
            familyAccountId: faB,
            title: 'B invoice',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 20 }],
          },
          adminActor(),
        ),
      );

      // Wave 1 Finding 6 FIXED: InvoiceService.list now filters by
      // tenant.schoolId, so a School A admin only sees School A's
      // invoices even though both schools share tenant_test.
      const adminList = await withTestTenant(async () => invoices.list({}, adminActor()));
      const hasA = adminList.find((i) => i.familyAccountId === faA);
      const hasB = adminList.find((i) => i.familyAccountId === faB);
      expect(hasA).toBeDefined();
      expect(hasB).toBeUndefined();
    });
  });
});
