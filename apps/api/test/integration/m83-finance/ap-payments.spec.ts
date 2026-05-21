import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { APVoucherService, APPaymentService } from '@modules/m83-finance/budgets.service';
import { PostingService } from '@modules/m83-finance/posting.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import { adminActor, officerActor, teacherActor, studentActor } from '../helpers/actor';
import {
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
  TEST_FUND_ID,
  TEST_FUND_B_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_SUPPLIES_B_ID,
} from '../fixtures/finance';
import { resetFinanceTables } from '../helpers/reset';

/**
 * DB-backed integration tests for APPaymentService.pay — the atomic
 * AP payment flow that locks the voucher, validates status + balance,
 * posts the GL batch, INSERTs the fin_ap_payments row, and flips the
 * voucher to PAID when balance hits zero. All inside ONE tenant tx
 * per REVIEW-CYCLE26 BLOCKING 2 + 4.
 */
describe('integration:m83-finance/ap-payments', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let validation: FinanceValidationService;
  let posting: PostingService;
  let apVouchers: APVoucherService;
  let apPayments: APPaymentService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    validation = new FinanceValidationService(tenantPrisma);
    posting = new PostingService(tenantPrisma);
    apVouchers = new APVoucherService(tenantPrisma, validation);
    apPayments = new APPaymentService(tenantPrisma, posting);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_ap_payments WHERE voucher_id IN
         (SELECT id FROM ${TEST_SCHEMA}.fin_ap_vouchers WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_ap_vouchers WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await withTestTenant(async () => resetFinanceTables(tenantPrisma));
  });

  async function seedApprovedVoucher(opts?: { totalAmount?: number }): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const v = await withTestTenant(async () =>
      apVouchers.create(adminActor(), {
        supplierId: TEST_SUPPLIER_A_ID,
        voucherNumber: 'AP-PAY-' + generateId().slice(-8),
        invoiceNumber: 'INV-' + generateId().slice(-6),
        invoiceDate: today,
        dueDate: due,
        totalAmount: opts?.totalAmount ?? 500,
        description: 'AP payment spec voucher',
        glAccountId: TEST_COA_SUPPLIES_ID,
        fundId: TEST_FUND_ID,
      }),
    );
    await withTestTenant(async () =>
      apVouchers.transition(adminActor(), v.id, { action: 'APPROVE' }),
    );
    return v.id;
  }

  describe('pay', () => {
    it('happy path: full payment posts GL + INSERTs payment + flips voucher to PAID', async () => {
      const voucherId = await seedApprovedVoucher({ totalAmount: 250 });
      const payment = await withTestTenant(async () =>
        apPayments.pay(adminActor(), voucherId, {
          paymentMethod: 'CHECK',
          paymentReference: 'CHK-12345',
          amount: 250,
          notes: 'Full payment',
        }),
      );
      expect(payment.amount).toBe(250);
      expect(payment.paymentMethod).toBe('CHECK');
      expect(payment.journalBatchId).not.toBeNull();

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.fin_ap_vouchers WHERE id = $1::uuid`,
        voucherId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('PAID');

      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.fin_journal_batches WHERE id = $1::uuid`,
        payment.journalBatchId,
      )) as Array<{ status: string }>;
      expect(batches[0]!.status).toBe('POSTED');
    });

    it('partial payment: voucher stays APPROVED, balance reduced', async () => {
      const voucherId = await seedApprovedVoucher({ totalAmount: 1000 });
      const first = await withTestTenant(async () =>
        apPayments.pay(adminActor(), voucherId, {
          paymentMethod: 'ACH',
          amount: 400,
        }),
      );
      expect(first.amount).toBe(400);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.fin_ap_vouchers WHERE id = $1::uuid`,
        voucherId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('APPROVED');

      // Second payment closes the balance.
      const second = await withTestTenant(async () =>
        apPayments.pay(adminActor(), voucherId, {
          paymentMethod: 'WIRE',
          amount: 600,
        }),
      );
      expect(second.amount).toBe(600);

      const after = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.fin_ap_vouchers WHERE id = $1::uuid`,
        voucherId,
      )) as Array<{ status: string }>;
      expect(after[0]!.status).toBe('PAID');
    });

    it('listForVoucher returns payments newest-first', async () => {
      const voucherId = await seedApprovedVoucher({ totalAmount: 300 });
      await withTestTenant(async () =>
        apPayments.pay(adminActor(), voucherId, {
          paymentMethod: 'CHECK',
          amount: 100,
        }),
      );
      await withTestTenant(async () =>
        apPayments.pay(adminActor(), voucherId, {
          paymentMethod: 'CHECK',
          amount: 200,
        }),
      );
      const list = await withTestTenant(async () => apPayments.listForVoucher(voucherId));
      expect(list).toHaveLength(2);
      // newest-first
      expect(list[0]!.amount).toBe(200);
      expect(list[1]!.amount).toBe(100);
    });

    it('over-payment → BadRequestException', async () => {
      const voucherId = await seedApprovedVoucher({ totalAmount: 100 });
      await expect(
        withTestTenant(async () =>
          apPayments.pay(adminActor(), voucherId, {
            paymentMethod: 'CHECK',
            amount: 150,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('voucher not APPROVED → BadRequestException', async () => {
      // Create a PENDING voucher (no transition).
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const v = await withTestTenant(async () =>
        apVouchers.create(adminActor(), {
          supplierId: TEST_SUPPLIER_A_ID,
          voucherNumber: 'AP-PND-' + generateId().slice(-8),
          invoiceDate: today,
          dueDate: due,
          totalAmount: 100,
          glAccountId: TEST_COA_SUPPLIES_ID,
          fundId: TEST_FUND_ID,
        }),
      );
      await expect(
        withTestTenant(async () =>
          apPayments.pay(adminActor(), v.id, {
            paymentMethod: 'CHECK',
            amount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('voucher missing gl_account_id → BadRequestException', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const v = await withTestTenant(async () =>
        apVouchers.create(adminActor(), {
          supplierId: TEST_SUPPLIER_A_ID,
          voucherNumber: 'AP-NoGL-' + generateId().slice(-8),
          invoiceDate: today,
          dueDate: due,
          totalAmount: 100,
        }),
      );
      await withTestTenant(async () =>
        apVouchers.transition(adminActor(), v.id, { action: 'APPROVE' }),
      );
      await expect(
        withTestTenant(async () =>
          apPayments.pay(adminActor(), v.id, {
            paymentMethod: 'CHECK',
            amount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent voucher → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          apPayments.pay(adminActor(), generateId(), {
            paymentMethod: 'CHECK',
            amount: 50,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school voucher (under School B) → NotFoundException from School A', async () => {
      const voucherIdB = await withTestTenantB(async () => {
        const today = new Date().toISOString().slice(0, 10);
        const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const v = await apVouchers.create(adminActor(), {
          supplierId: TEST_SUPPLIER_B_SCHOOL_ID,
          voucherNumber: 'AP-B-' + generateId().slice(-8),
          invoiceDate: today,
          dueDate: due,
          totalAmount: 100,
          glAccountId: TEST_COA_SUPPLIES_B_ID,
          fundId: TEST_FUND_B_ID,
        });
        await apVouchers.transition(adminActor(), v.id, { action: 'APPROVE' });
        return v.id;
      });
      await expect(
        withTestTenant(async () =>
          apPayments.pay(adminActor(), voucherIdB, {
            paymentMethod: 'CHECK',
            amount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → ForbiddenException', async () => {
      const voucherId = await seedApprovedVoucher();
      await expect(
        withTestTenant(async () =>
          apPayments.pay(officerActor(), voucherId, {
            paymentMethod: 'CHECK',
            amount: 50,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          apPayments.pay(teacherActor(), voucherId, {
            paymentMethod: 'CHECK',
            amount: 50,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          apPayments.pay(studentActor(), voucherId, {
            paymentMethod: 'CHECK',
            amount: 50,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('actor without employeeId → BadRequestException', async () => {
      const voucherId = await seedApprovedVoucher();
      const noEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          apPayments.pay(noEmp, voucherId, {
            paymentMethod: 'CHECK',
            amount: 50,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
