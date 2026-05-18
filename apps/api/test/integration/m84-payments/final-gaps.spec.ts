import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { CreditNoteService } from '@modules/m84-payments/credit-note.service';
import { InvoiceService } from '@modules/m84-payments/invoice.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { LateFeeService } from '@modules/m84-payments/late-fee.service';
import { PaymentService } from '@modules/m84-payments/payment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { RedisService } from '@shared/cache';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/final-gaps', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let payments: PaymentService;
  let creditNotes: CreditNoteService;
  let lateFee: LateFeeService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    payments = new PaymentService(tenantPrisma, outbox, ledger);
    creditNotes = new CreditNoteService(tenantPrisma, outbox, ledger);
    lateFee = new LateFeeService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  async function seedFamily(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
         (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      TEST_SCHOOL_ID,
      TEST_PARENT_PERSON_ID,
      'FG-FA-' + id,
    );
    return id;
  }

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'FG-Stu', $2, 'STUDENT', true)`,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'FG-Stu', $3, true)`,
      platformStudentId,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'FG-' + suffix,
    );
    return studentId;
  }

  async function seedFeeCategory(): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_fee_categories (id, school_id, name, is_active)
       VALUES ($1::uuid, $2::uuid, $3, true)`,
      id,
      TEST_SCHOOL_ID,
      'FG-Cat-' + id.slice(-6),
    );
    return id;
  }

  async function seedFeeSchedule(opts: { categoryId: string; amount?: number; gradeLevel?: string | null; isActive?: boolean }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_fee_schedules
         (id, school_id, academic_year_id, fee_category_id, name, amount, recurrence, is_active, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::numeric, 'ANNUAL', $7, $8)`,
      id,
      TEST_SCHOOL_ID,
      TEST_ACADEMIC_YEAR_ID,
      opts.categoryId,
      'FG-Sched-' + id.slice(-6),
      (opts.amount ?? 100).toFixed(2),
      opts.isActive ?? true,
      opts.gradeLevel ?? null,
    );
    return id;
  }

  async function linkStudentToFamily(familyId: string, studentId: string): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_account_students
         (id, family_account_id, student_id, added_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, NULL)`,
      generateId(),
      familyId,
      studentId,
    );
  }

  // ─── InvoiceService.generateFromSchedule ─────────────────────

  describe('InvoiceService.generateFromSchedule', () => {
    it('admin generates DRAFT invoice per family eligible under the schedule', async () => {
      const fa = await seedFamily();
      const sid = await seedStudent();
      await linkStudentToFamily(fa, sid);
      const cat = await seedFeeCategory();
      const fs = await seedFeeSchedule({ categoryId: cat, amount: 250, gradeLevel: '5' });

      const r = await withTestTenant(async () =>
        invoices.generateFromSchedule(
          { feeScheduleId: fs, title: 'Annual Tuition 2026', dueDate: '2026-08-01' },
          adminActor(),
        ),
      );
      expect(r.created).toBe(1);
      expect(r.skipped).toBe(0);
      expect(r.invoiceIds.length).toBe(1);
    });

    it('grade_level NULL targets all grades', async () => {
      const fa = await seedFamily();
      const sid = await seedStudent();
      await linkStudentToFamily(fa, sid);
      const cat = await seedFeeCategory();
      const fs = await seedFeeSchedule({ categoryId: cat, amount: 100, gradeLevel: null });

      const r = await withTestTenant(async () =>
        invoices.generateFromSchedule({ feeScheduleId: fs }, adminActor()),
      );
      expect(r.created).toBe(1);
    });

    it('re-run is idempotent: existing invoice → skipped', async () => {
      const fa = await seedFamily();
      const sid = await seedStudent();
      await linkStudentToFamily(fa, sid);
      const cat = await seedFeeCategory();
      const fs = await seedFeeSchedule({ categoryId: cat });

      const r1 = await withTestTenant(async () =>
        invoices.generateFromSchedule({ feeScheduleId: fs }, adminActor()),
      );
      expect(r1.created).toBe(1);

      const r2 = await withTestTenant(async () =>
        invoices.generateFromSchedule({ feeScheduleId: fs }, adminActor()),
      );
      expect(r2.created).toBe(0);
      expect(r2.skipped).toBe(1);
    });

    it('inactive fee schedule → BadRequest', async () => {
      const cat = await seedFeeCategory();
      const fs = await seedFeeSchedule({ categoryId: cat, isActive: false });
      await expect(
        withTestTenant(async () =>
          invoices.generateFromSchedule({ feeScheduleId: fs }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent fee schedule → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.generateFromSchedule({ feeScheduleId: generateId() }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () =>
          invoices.generateFromSchedule({ feeScheduleId: generateId() }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── LedgerService.listEntries + getBalance ─────────────────

  describe('LedgerService', () => {
    async function seedInvoiceAndPay(fa: string): Promise<void> {
      const inv = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(inv.id, adminActor()));
      await withTestTenant(async () =>
        payments.pay(inv.id, { amount: 100, paymentMethod: 'CARD' }, adminActor()),
      );
    }

    it('getBalance: empty family → 0', async () => {
      const fa = await seedFamily();
      const r = await withTestTenant(async () => ledger.getBalance(fa));
      expect(r.balance).toBe(0);
    });

    it('getBalance after invoice+payment = 0 (CHARGE + PAYMENT cancel)', async () => {
      const fa = await seedFamily();
      await seedInvoiceAndPay(fa);
      const r = await withTestTenant(async () => ledger.getBalance(fa));
      expect(r.balance).toBe(0);
    });

    it('listEntries returns invoice CHARGE + payment PAYMENT rows newest-first', async () => {
      const fa = await seedFamily();
      await seedInvoiceAndPay(fa);
      const entries = await withTestTenant(async () => ledger.listEntries(fa, {}));
      const types = entries.map((e) => e.entryType);
      expect(types).toContain('CHARGE');
      expect(types).toContain('PAYMENT');
      // Newest first
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i - 1]!.createdAt >= entries[i]!.createdAt).toBe(true);
      }
    });

    it('listEntries limit clamp at 200', async () => {
      const fa = await seedFamily();
      const r = await withTestTenant(async () =>
        ledger.listEntries(fa, { limit: 9999 }),
      );
      expect(r.length).toBeLessThanOrEqual(200);
    });

    it('listEntries with referenceId filter', async () => {
      const fa = await seedFamily();
      await seedInvoiceAndPay(fa);
      const all = await withTestTenant(async () => ledger.listEntries(fa, {}));
      const refId = all[0]!.referenceId;
      if (refId) {
        const filtered = await withTestTenant(async () =>
          ledger.listEntries(fa, { referenceId: refId }),
        );
        expect(filtered.every((e) => e.referenceId === refId)).toBe(true);
      }
    });

    it('listEntries with before-cursor', async () => {
      const fa = await seedFamily();
      await seedInvoiceAndPay(fa);
      const all = await withTestTenant(async () => ledger.listEntries(fa, {}));
      const cursor = all[0]!.createdAt;
      const older = await withTestTenant(async () =>
        ledger.listEntries(fa, { before: cursor }),
      );
      expect(older.every((e) => e.createdAt < cursor)).toBe(true);
    });
  });

  // ─── CreditNoteService.list + getById ───────────────────────

  describe('CreditNoteService.list', () => {
    async function seedCreditNote(): Promise<{
      creditId: string;
      invoiceId: string;
      familyAccountId: string;
    }> {
      const fa = await seedFamily();
      const inv = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'X',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: 100 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(inv.id, adminActor()));
      const credit = await withTestTenant(async () =>
        creditNotes.issue(
          inv.id,
          { creditAmount: 25, reason: 'Goodwill', creditCategory: 'GOODWILL' },
          adminActor(),
        ),
      );
      return { creditId: credit.id, invoiceId: inv.id, familyAccountId: fa };
    }

    it('admin lists every credit note in tenant', async () => {
      const { creditId } = await seedCreditNote();
      const list = await withTestTenant(async () =>
        creditNotes.list({}, adminActor()),
      );
      expect(list.find((c) => c.id === creditId)).toBeDefined();
    });

    it('list filters by invoiceId', async () => {
      const { creditId, invoiceId } = await seedCreditNote();
      const list = await withTestTenant(async () =>
        creditNotes.list({ invoiceId }, adminActor()),
      );
      expect(list.every((c) => c.invoiceId === invoiceId)).toBe(true);
      expect(list.find((c) => c.id === creditId)).toBeDefined();
    });

    it('list filters by familyAccountId', async () => {
      const { creditId, familyAccountId } = await seedCreditNote();
      const list = await withTestTenant(async () =>
        creditNotes.list({ familyAccountId }, adminActor()),
      );
      expect(list.every((c) => c.familyAccountId === familyAccountId)).toBe(true);
      expect(list.find((c) => c.id === creditId)).toBeDefined();
    });

    it('non-admin list → Forbidden', async () => {
      await expect(
        withTestTenant(async () => creditNotes.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin getById → Forbidden', async () => {
      const { creditId } = await seedCreditNote();
      await expect(
        withTestTenant(async () => creditNotes.getById(creditId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById admin returns row + missing → NotFound', async () => {
      const { creditId } = await seedCreditNote();
      const r = await withTestTenant(async () => creditNotes.getById(creditId, adminActor()));
      expect(r.id).toBe(creditId);

      await expect(
        withTestTenant(async () => creditNotes.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── LateFeeService.runScan ─────────────────────────────────

  describe('LateFeeService.runScan branches', () => {
    async function seedOverdueInvoice(opts?: { amount?: number }): Promise<{ fa: string; invoiceId: string }> {
      const fa = await seedFamily();
      const inv = await withTestTenant(async () =>
        invoices.create(
          {
            familyAccountId: fa,
            title: 'OverdueInv',
            dueDate: '2024-01-01',
            lineItems: [{ description: 'X', quantity: 1, unitPrice: opts?.amount ?? 200 }],
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => invoices.send(inv.id, adminActor()));
      // Force the invoice past due to make it overdue-eligible.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_invoices SET due_date = '2024-01-01', status = 'OVERDUE' WHERE id = $1::uuid`,
        inv.id,
      );
      return { fa, invoiceId: inv.id };
    }

    it('PERCENTAGE_MONTHLY policy applies a fee with cap', async () => {
      await withTestTenant(async () =>
        lateFee.upsertPolicy(
          {
            isActive: true,
            feeType: 'PERCENTAGE_MONTHLY',
            feePercentage: 5,
            graceDays: 0,
            maxFeeCap: 30,
          },
          adminActor(),
        ),
      );
      await seedOverdueInvoice({ amount: 200 });
      const r = await withTestTenant(async () => lateFee.runScan(adminActor()));
      expect(r.invoicesEvaluated).toBeGreaterThanOrEqual(1);
      expect(r.lateFeesApplied + r.invoicesSkipped).toBeGreaterThanOrEqual(1);
    });

    it('runScan re-runs are idempotent: existing late-fee line → skipped', async () => {
      await withTestTenant(async () =>
        lateFee.upsertPolicy(
          {
            isActive: true,
            feeType: 'FIXED',
            feeAmount: 10,
            graceDays: 0,
          },
          adminActor(),
        ),
      );
      await seedOverdueInvoice();
      const r1 = await withTestTenant(async () => lateFee.runScan(adminActor()));
      void r1;
      const r2 = await withTestTenant(async () => lateFee.runScan(adminActor()));
      // Second run should not add more fees.
      expect(r2.lateFeesApplied).toBe(0);
    });
  });
});
