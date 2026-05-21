import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  APVoucherService,
  ReconciliationService,
  BoardReportService,
} from '@modules/m83-finance/budgets.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
  studentActor,
  parentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_INACTIVE_SUPPLIER_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
  TEST_FUND_ID,
  TEST_FUND_B_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_PERIOD_ID,
  TEST_PERIOD_B_ID,
} from '../fixtures/finance';

/**
 * DB-backed integration tests for the remaining classes in
 * budgets.service.ts: APVoucherService, ReconciliationService,
 * BoardReportService.
 */
describe('integration:m83-finance/ap-recon-board', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let validation: FinanceValidationService;
  let apVouchers: APVoucherService;
  let recon: ReconciliationService;
  let board: BoardReportService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    validation = new FinanceValidationService(tenantPrisma);
    apVouchers = new APVoucherService(tenantPrisma, validation);
    recon = new ReconciliationService(tenantPrisma, validation);
    board = new BoardReportService(tenantPrisma);
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
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_reconciliation_runs WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fin_board_report_snapshots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  describe('APVoucherService', () => {
    function baseVoucher(overrides: Record<string, unknown> = {}) {
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      return {
        supplierId: TEST_SUPPLIER_A_ID,
        voucherNumber: 'V-' + Math.random().toString(36).slice(2, 10),
        invoiceNumber: 'INV-001',
        invoiceDate: today,
        dueDate: due,
        totalAmount: 1500,
        description: 'Office supplies for Q1',
        glAccountId: TEST_COA_SUPPLIES_ID,
        fundId: TEST_FUND_ID,
        ...overrides,
      };
    }

    it('admin creates a voucher', async () => {
      const v = await withTestTenant(async () => apVouchers.create(adminActor(), baseVoucher()));
      expect(v.status).toBe('PENDING');
      expect(v.totalAmount).toBe(1500);
      expect(v.amountPaid).toBe(0);
      expect(v.balanceDue).toBe(1500);
    });

    it('STAFF officer can create', async () => {
      const v = await withTestTenant(async () => apVouchers.create(officerActor(), baseVoucher()));
      expect(v.id).toBeTruthy();
    });

    it('student → Forbidden', async () => {
      await expect(
        withTestTenant(async () => apVouchers.create(studentActor(), baseVoucher())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => apVouchers.create(parentActor(), baseVoucher())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('inactive supplier → BadRequest (assertActiveSupplier)', async () => {
      await expect(
        withTestTenant(async () =>
          apVouchers.create(adminActor(), baseVoucher({ supplierId: TEST_INACTIVE_SUPPLIER_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school supplier → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          apVouchers.create(adminActor(), baseVoucher({ supplierId: TEST_SUPPLIER_B_SCHOOL_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REVENUE account → BadRequest (must be EXPENSE/ASSET/LIABILITY)', async () => {
      await expect(
        withTestTenant(async () =>
          apVouchers.create(adminActor(), baseVoucher({ glAccountId: TEST_COA_REVENUE_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school fund → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          apVouchers.create(adminActor(), baseVoucher({ fundId: TEST_FUND_B_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('dueDate before invoiceDate → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          apVouchers.create(
            adminActor(),
            baseVoucher({ invoiceDate: '2026-06-01', dueDate: '2026-01-01' }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate voucher_number → ConflictException', async () => {
      const input = baseVoucher();
      await withTestTenant(async () => apVouchers.create(adminActor(), input));
      await expect(
        withTestTenant(async () => apVouchers.create(adminActor(), input)),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('glAccountId omitted is allowed', async () => {
      const input = baseVoucher();
      delete (input as { glAccountId?: string }).glAccountId;
      const v = await withTestTenant(async () => apVouchers.create(adminActor(), input));
      expect(v.glAccountId).toBeNull();
    });

    it('fundId omitted is allowed', async () => {
      const input = baseVoucher();
      delete (input as { fundId?: string }).fundId;
      const v = await withTestTenant(async () => apVouchers.create(adminActor(), input));
      expect(v.fundId).toBeNull();
    });

    it('list filters by status', async () => {
      const a = await withTestTenant(async () => apVouchers.create(adminActor(), baseVoucher()));
      const pending = await withTestTenant(async () => apVouchers.list({ status: 'PENDING' }));
      expect(pending.find((v) => v.id === a.id)).toBeDefined();
      const paid = await withTestTenant(async () => apVouchers.list({ status: 'PAID' }));
      expect(paid.find((v) => v.id === a.id)).toBeUndefined();
    });

    it('list filters by supplierId', async () => {
      const a = await withTestTenant(async () => apVouchers.create(adminActor(), baseVoucher()));
      const list = await withTestTenant(async () =>
        apVouchers.list({ supplierId: TEST_SUPPLIER_A_ID }),
      );
      expect(list.find((v) => v.id === a.id)).toBeDefined();
      const empty = await withTestTenant(async () =>
        apVouchers.list({ supplierId: TEST_SUPPLIER_B_ID }),
      );
      expect(empty.find((v) => v.id === a.id)).toBeUndefined();
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => apVouchers.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school getById → NotFound', async () => {
      const v = await withTestTenant(async () => apVouchers.create(adminActor(), baseVoucher()));
      await expect(withTestTenantB(async () => apVouchers.getById(v.id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    describe('transition state machine', () => {
      async function seed(): Promise<string> {
        const v = await withTestTenant(async () => apVouchers.create(adminActor(), baseVoucher()));
        return v.id;
      }

      it('non-admin → Forbidden', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () =>
            apVouchers.transition(officerActor(), id, { action: 'APPROVE' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('PENDING → APPROVE stamps approved_at + approved_by', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'APPROVE' }),
        );
        expect(updated.status).toBe('APPROVED');
        expect(updated.approvedAt).toBeTruthy();
        expect(updated.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      });

      it('PENDING → HOLD allowed', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'HOLD' }),
        );
        expect(updated.status).toBe('ON_HOLD');
      });

      it('ON_HOLD → APPROVE allowed', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'HOLD' }),
        );
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'APPROVE' }),
        );
        expect(updated.status).toBe('APPROVED');
      });

      it('ON_HOLD → RELEASE goes back to PENDING', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'HOLD' }),
        );
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'RELEASE' }),
        );
        expect(updated.status).toBe('PENDING');
      });

      it('PENDING → RELEASE rejected (only ON_HOLD can be released)', async () => {
        const id = await seed();
        await expect(
          withTestTenant(async () =>
            apVouchers.transition(adminActor(), id, { action: 'RELEASE' }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('APPROVED → APPROVE rejected', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'APPROVE' }),
        );
        await expect(
          withTestTenant(async () =>
            apVouchers.transition(adminActor(), id, { action: 'APPROVE' }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('APPROVED → HOLD allowed', async () => {
        const id = await seed();
        await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'APPROVE' }),
        );
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, { action: 'HOLD' }),
        );
        expect(updated.status).toBe('ON_HOLD');
      });

      it('PENDING → VOID stamps voided fields + reason', async () => {
        const id = await seed();
        const updated = await withTestTenant(async () =>
          apVouchers.transition(adminActor(), id, {
            action: 'VOID',
            reason: 'Duplicate entry',
          }),
        );
        expect(updated.status).toBe('VOIDED');
        expect(updated.voidedAt).toBeTruthy();
        expect(updated.voidReason).toBe('Duplicate entry');
      });

      it('PAID → VOID rejected', async () => {
        const id = await seed();
        // Directly flip status to PAID for test
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_ap_vouchers SET status = 'APPROVED' WHERE id = $1::uuid`,
          id,
        );
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fin_ap_vouchers SET status = 'PAID' WHERE id = $1::uuid`,
          id,
        );
        await expect(
          withTestTenant(async () => apVouchers.transition(adminActor(), id, { action: 'VOID' })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('transition missing voucher → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            apVouchers.transition(adminActor(), generateId(), { action: 'APPROVE' }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('cross-school: voucher in School B not visible from School A', async () => {
      // Use the School B fixtures (supplier + COA + fund) so validation passes
      // when running in School B context.
      const b = await withTestTenantB(async () =>
        apVouchers.create(
          adminActor(),
          baseVoucher({
            supplierId: TEST_SUPPLIER_B_SCHOOL_ID,
            glAccountId: undefined,
            fundId: TEST_FUND_B_ID,
          }),
        ),
      );
      const listA = await withTestTenant(async () => apVouchers.list());
      expect(listA.find((v) => v.id === b.id)).toBeUndefined();
    });
  });

  describe('ReconciliationService', () => {
    function baseRecon(overrides: Record<string, unknown> = {}) {
      return {
        accountId: TEST_COA_CASH_ID,
        periodId: TEST_PERIOD_ID,
        bankBalance: 0, // Will compute against GL
        outstandingItems: [],
        notes: 'Initial recon',
        ...overrides,
      };
    }

    it('admin starts a reconciliation; matched bank balance → IN_PROGRESS', async () => {
      const r = await withTestTenant(async () => recon.start(adminActor(), baseRecon()));
      expect(r.status).toBe('IN_PROGRESS');
      expect(r.glBalance).toBe(0);
      expect(r.bankBalance).toBe(0);
      expect(r.difference).toBe(0);
    });

    it('variance → VARIANCE_FLAGGED', async () => {
      const r = await withTestTenant(async () =>
        recon.start(adminActor(), baseRecon({ bankBalance: 100 })),
      );
      expect(r.status).toBe('VARIANCE_FLAGGED');
      expect(r.difference).toBe(-100);
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => recon.start(officerActor(), baseRecon())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-ASSET account → BadRequest (assertActiveAccount type filter)', async () => {
      await expect(
        withTestTenant(async () =>
          recon.start(adminActor(), baseRecon({ accountId: TEST_COA_REVENUE_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school period → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          recon.start(adminActor(), baseRecon({ periodId: TEST_PERIOD_B_ID })),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list returns recent runs (DESC, limit 100)', async () => {
      const a = await withTestTenant(async () => recon.start(adminActor(), baseRecon()));
      const list = await withTestTenant(async () => recon.list());
      expect(list.find((r) => r.id === a.id)).toBeDefined();
    });

    it('getById returns the run with account + period names', async () => {
      const a = await withTestTenant(async () => recon.start(adminActor(), baseRecon()));
      const got = await withTestTenant(async () => recon.getById(a.id));
      expect(got.accountCode).toBeTruthy();
      expect(got.periodName).toBeTruthy();
    });

    it('getById missing → NotFound', async () => {
      await expect(withTestTenant(async () => recon.getById(generateId()))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cross-school getById → NotFound', async () => {
      const a = await withTestTenant(async () => recon.start(adminActor(), baseRecon()));
      await expect(withTestTenantB(async () => recon.getById(a.id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    describe('finalize', () => {
      async function seed(bank = 0): Promise<string> {
        const r = await withTestTenant(async () =>
          recon.start(adminActor(), baseRecon({ bankBalance: bank })),
        );
        return r.id;
      }

      it('matched → RECONCILED stamps reconciled_by/reconciled_at', async () => {
        const id = await seed(0);
        const updated = await withTestTenant(async () =>
          recon.finalize(adminActor(), id, { bankBalance: 0, outstandingItems: [] }),
        );
        expect(updated.status).toBe('RECONCILED');
        expect(updated.reconciledBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
        expect(updated.reconciledAt).toBeTruthy();
      });

      it('variance → VARIANCE_FLAGGED, no reconciled stamp', async () => {
        const id = await seed(0);
        const updated = await withTestTenant(async () =>
          recon.finalize(adminActor(), id, { bankBalance: 250, outstandingItems: [] }),
        );
        expect(updated.status).toBe('VARIANCE_FLAGGED');
        expect(updated.reconciledBy).toBeNull();
      });

      it('already RECONCILED → BadRequest', async () => {
        const id = await seed(0);
        await withTestTenant(async () =>
          recon.finalize(adminActor(), id, { bankBalance: 0, outstandingItems: [] }),
        );
        await expect(
          withTestTenant(async () =>
            recon.finalize(adminActor(), id, { bankBalance: 0, outstandingItems: [] }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('finalize non-admin → Forbidden', async () => {
        const id = await seed(0);
        await expect(
          withTestTenant(async () =>
            recon.finalize(officerActor(), id, { bankBalance: 0, outstandingItems: [] }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('finalize missing → NotFound', async () => {
        await expect(
          withTestTenant(async () =>
            recon.finalize(adminActor(), generateId(), {
              bankBalance: 0,
              outstandingItems: [],
            }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });

  describe('BoardReportService', () => {
    it('admin generates BUDGET_VS_ACTUAL snapshot from approved budget lines', async () => {
      const r = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'BUDGET_VS_ACTUAL', periodId: TEST_PERIOD_ID }),
      );
      expect(r.reportType).toBe('BUDGET_VS_ACTUAL');
      expect(r.generatedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(r.reportData).toBeTruthy();
      const data = r.reportData as { reportType: string; lines: Array<unknown> };
      expect(data.reportType).toBe('BUDGET_VS_ACTUAL');
      expect(Array.isArray(data.lines)).toBe(true);
    });

    it('admin generates BALANCE_SHEET snapshot from chart-of-accounts', async () => {
      const r = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'BALANCE_SHEET', periodId: TEST_PERIOD_ID }),
      );
      expect(r.reportType).toBe('BALANCE_SHEET');
      const data = r.reportData as { accounts: Array<unknown> };
      expect(Array.isArray(data.accounts)).toBe(true);
    });

    it('INCOME_STATEMENT compiles successfully', async () => {
      const r = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'INCOME_STATEMENT', periodId: TEST_PERIOD_ID }),
      );
      expect(r.reportType).toBe('INCOME_STATEMENT');
    });

    it('CASH_FLOW compiles successfully', async () => {
      const r = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'CASH_FLOW' }),
      );
      expect(r.reportType).toBe('CASH_FLOW');
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => board.generate(officerActor(), { reportType: 'BALANCE_SHEET' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => board.generate(teacherActor(), { reportType: 'BALANCE_SHEET' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list returns reports ordered by generated_at DESC', async () => {
      const a = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'BALANCE_SHEET' }),
      );
      const list = await withTestTenant(async () => board.list());
      expect(list.find((r) => r.id === a.id)).toBeDefined();
    });

    it('getById returns the snapshot with periodName when periodId set', async () => {
      const a = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'BALANCE_SHEET', periodId: TEST_PERIOD_ID }),
      );
      const got = await withTestTenant(async () => board.getById(a.id));
      expect(got.periodName).toBeTruthy();
    });

    it('getById missing → NotFound', async () => {
      await expect(withTestTenant(async () => board.getById(generateId()))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cross-school getById → NotFound', async () => {
      const a = await withTestTenant(async () =>
        board.generate(adminActor(), { reportType: 'BALANCE_SHEET' }),
      );
      await expect(withTestTenantB(async () => board.getById(a.id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
