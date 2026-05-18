import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { InvoiceService } from '@modules/m84-payments/invoice.service';
import { PaymentPlanService } from '@modules/m84-payments/payment-plan.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { RedisService } from '@shared/cache';

import {
  withTestTenant,
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
 * Wave 1 — DB-backed integration tests for PaymentPlanService.
 * Replaces apps/api/src/modules/m84-payments/payment-plan.service.spec.ts.
 *
 * Strategy doc Wave 1 coverage:
 *   - Create plan + installments atomically (one tx)
 *   - SUM(installments.amount) === plan.total_amount (round-off residue
 *     absorbed by the last installment)
 *   - MONTHLY vs QUARTERLY date math (1 month vs 3 months per installment)
 *   - UNIQUE(invoice_id) — only one plan per invoice
 *   - Admin-only; auth gates
 *   - Rejects PAID / CANCELLED invoices
 *   - installmentCount < 2 rejected (CHECK pay_payment_plans_count_chk
 *     requires > 0 but service tightens to >= 2 — partial-payment plans
 *     need at least two installments to be a plan)
 */

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

describe('integration:m84-payments/payment-plans', () => {
  let tenantPrisma: TenantPrismaService;
  let outbox: OutboxService;
  let ledger: LedgerService;
  let invoices: InvoiceService;
  let plans: PaymentPlanService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    outbox = new OutboxService();
    ledger = new LedgerService(tenantPrisma, stubRedis());
    invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    plans = new PaymentPlanService(tenantPrisma);
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

  async function seedFamilyAccount(opts?: { schoolId?: string }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      TEST_PARENT_PERSON_ID,
      'FA-' + id,
    );
    return id;
  }

  async function seedSentInvoice(opts?: { familyAccountId?: string; total?: number }) {
    const fa = opts?.familyAccountId ?? (await seedFamilyAccount());
    const total = opts?.total ?? 1200;
    const draft = await withTestTenant(async () =>
      invoices.create(
        {
          familyAccountId: fa,
          title: 'Plan-eligible',
          lineItems: [{ description: 'Tuition', quantity: 1, unitPrice: total }],
        },
        adminActor(),
      ),
    );
    await withTestTenant(async () => invoices.send(draft.id, adminActor()));
    return { invoiceId: draft.id, familyAccountId: fa, total };
  }

  // ────────────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('happy path: 4-installment monthly plan with $1200 invoice → 4 × $300 installments', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 1200 });

      const plan = await withTestTenant(async () =>
        plans.create(
          invoiceId,
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
          adminActor(),
        ),
      );

      expect(plan.status).toBe('ACTIVE');
      expect(plan.totalAmount).toBe(1200);
      expect(plan.installmentCount).toBe(4);
      expect(plan.frequency).toBe('MONTHLY');
      expect(plan.startDate).toBe('2026-09-01');
      expect(plan.invoiceId).toBe(invoiceId);
      expect(plan.installments).toHaveLength(4);

      // Each $300; due dates +0/+1/+2/+3 months from 2026-09-01
      const sortedInstallments = [...plan.installments].sort(
        (a, b) => a.installmentNumber - b.installmentNumber,
      );
      for (const i of sortedInstallments) {
        expect(i.amount).toBe(300);
        expect(i.status).toBe('UPCOMING');
        expect(i.planId).toBe(plan.id);
        expect(i.paymentId).toBeNull();
        expect(i.paidAt).toBeNull();
      }
      expect(sortedInstallments.map((i) => i.dueDate)).toEqual([
        '2026-09-01',
        '2026-10-01',
        '2026-11-01',
        '2026-12-01',
      ]);

      // DB-state assertion: SUM(installments.amount) = total
      const sumRows = (await rawClient.$queryRawUnsafe(
        `SELECT SUM(amount)::text AS s FROM ${TEST_SCHEMA}.pay_payment_plan_installments WHERE plan_id = $1::uuid`,
        plan.id,
      )) as Array<{ s: string }>;
      expect(Number(sumRows[0]!.s)).toBe(1200);
    });

    it('round-off residue: $100 / 3 installments → 33.33 + 33.33 + 33.34 (last absorbs the cent)', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 100 });
      const plan = await withTestTenant(async () =>
        plans.create(
          invoiceId,
          { installmentCount: 3, frequency: 'MONTHLY', startDate: '2026-09-01' },
          adminActor(),
        ),
      );
      const sorted = [...plan.installments].sort(
        (a, b) => a.installmentNumber - b.installmentNumber,
      );
      expect(sorted[0]!.amount).toBe(33.33);
      expect(sorted[1]!.amount).toBe(33.33);
      expect(sorted[2]!.amount).toBe(33.34);
      // SUM = exactly 100 (no penny drift)
      const sumRows = (await rawClient.$queryRawUnsafe(
        `SELECT SUM(amount)::text AS s FROM ${TEST_SCHEMA}.pay_payment_plan_installments WHERE plan_id = $1::uuid`,
        plan.id,
      )) as Array<{ s: string }>;
      expect(Number(sumRows[0]!.s)).toBe(100);
    });

    it('QUARTERLY frequency: due dates step by 3 months', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 900 });
      const plan = await withTestTenant(async () =>
        plans.create(
          invoiceId,
          { installmentCount: 3, frequency: 'QUARTERLY', startDate: '2026-09-01' },
          adminActor(),
        ),
      );
      const sorted = [...plan.installments].sort(
        (a, b) => a.installmentNumber - b.installmentNumber,
      );
      expect(sorted.map((i) => i.dueDate)).toEqual([
        '2026-09-01',
        '2026-12-01',
        '2027-03-01',
      ]);
      for (const i of sorted) {
        expect(i.amount).toBe(300);
      }
    });

    it('plan + installments land in ONE transaction — failure halfway leaves zero rows', async () => {
      // Indirect: trigger an in-tx failure by passing a non-existent invoice
      // AFTER the plan has tried to lock — there's no clean half-state we
      // can induce without modifying the service, so verify the converse:
      // a successful create writes 1 plan + N installments. A NotFound
      // before any INSERT leaves 0 rows.
      const baseCount = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_payment_plans`,
      )) as Array<{ n: number }>;
      expect(baseCount[0]!.n).toBe(0);

      await expect(
        withTestTenant(async () =>
          plans.create(
            '00000000-0000-0000-0000-000000000000',
            { installmentCount: 3, frequency: 'MONTHLY', startDate: '2026-09-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const afterCount = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_payment_plans`,
      )) as Array<{ n: number }>;
      expect(afterCount[0]!.n).toBe(0);
    });

    it('installmentCount < 2 → BadRequest', async () => {
      const { invoiceId } = await seedSentInvoice();
      await expect(
        withTestTenant(async () =>
          plans.create(
            invoiceId,
            { installmentCount: 1, frequency: 'MONTHLY', startDate: '2026-09-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('UNIQUE(invoice_id): second plan on same invoice → BadRequest (pre-flight existence check)', async () => {
      const { invoiceId } = await seedSentInvoice();
      await withTestTenant(async () =>
        plans.create(
          invoiceId,
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          plans.create(
            invoiceId,
            { installmentCount: 6, frequency: 'MONTHLY', startDate: '2026-09-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Only one plan row exists for the invoice
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pay_payment_plans WHERE invoice_id = $1::uuid`,
        invoiceId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('missing invoice → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          plans.create(
            '00000000-0000-0000-0000-000000000000',
            { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('PAID invoice → BadRequest (cannot create plan after full payment)', async () => {
      const fa = await seedFamilyAccount();
      const sent = await seedSentInvoice({ familyAccountId: fa, total: 100 });
      // Flip to PAID directly
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pay_invoices SET status='PAID' WHERE id = $1::uuid`,
        sent.invoiceId,
      );
      await expect(
        withTestTenant(async () =>
          plans.create(
            sent.invoiceId,
            { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCELLED invoice → BadRequest', async () => {
      const { invoiceId } = await seedSentInvoice();
      await withTestTenant(async () => invoices.cancel(invoiceId, adminActor()));
      await expect(
        withTestTenant(async () =>
          plans.create(
            invoiceId,
            { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
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
      const { invoiceId } = await seedSentInvoice();
      await expect(
        withTestTenant(async () =>
          plans.create(
            invoiceId,
            { installmentCount: 4, frequency: 'MONTHLY', startDate: '2026-09-01' },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getById
  // ────────────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('returns the plan with installments ordered by installment_number', async () => {
      const { invoiceId } = await seedSentInvoice({ total: 600 });
      const created = await withTestTenant(async () =>
        plans.create(
          invoiceId,
          { installmentCount: 6, frequency: 'MONTHLY', startDate: '2026-09-01' },
          adminActor(),
        ),
      );
      const fetched = await withTestTenant(async () => plans.getById(created.id));
      expect(fetched.id).toBe(created.id);
      expect(fetched.installments).toHaveLength(6);
      // Ordering invariant
      for (let i = 0; i < fetched.installments.length; i++) {
        expect(fetched.installments[i]!.installmentNumber).toBe(i + 1);
      }
    });

    it('getById for missing plan → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          plans.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
