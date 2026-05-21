import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FinanceController } from '@modules/m83-finance/finance.controller';
import { FinanceAdvancedController } from '@modules/m83-finance/finance-advanced.controller';
import {
  ChartOfAccountsService,
  FundService,
  PeriodService,
} from '@modules/m83-finance/chart.service';
import { PostingService } from '@modules/m83-finance/posting.service';
import {
  APPaymentService,
  APVoucherService,
  BoardReportService,
  BudgetService,
  GrantService,
  ReconciliationService,
  SupplierService,
} from '@modules/m83-finance/budgets.service';
import { DepartmentalBudgetService } from '@modules/m83-finance/departmental-budget.service';
import { BudgetTransferService } from '@modules/m83-finance/budget-transfer.service';
import { JournalBatchService } from '@modules/m83-finance/journal-batch.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { resetFinanceTables } from '../helpers/reset';
import {
  TEST_ACADEMIC_YEAR_ID,
  TEST_FUND_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_PERIOD_ID,
  TEST_BUDGET_ID,
  TEST_SUPPLIER_A_ID,
} from '../fixtures/finance';

/**
 * Wave 3+ — controller-level coverage of FinanceController and
 * FinanceAdvancedController. Drives each route handler with real
 * services + real DB so every controller line is exercised. Each
 * test asserts the response shape and verifies delegation worked.
 */
describe('integration:m83-finance/finance-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let controller: FinanceController;
  let advanced: FinanceAdvancedController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const permCheck = new PermissionCheckService(rawClient);
    const actors = new ActorContextService(rawClient, permCheck, tenantPrisma);
    const outbox = new OutboxService();
    const validation = new FinanceValidationService(tenantPrisma);

    const funds = new FundService(tenantPrisma);
    const chart = new ChartOfAccountsService(tenantPrisma);
    const periods = new PeriodService(tenantPrisma);
    const posting = new PostingService(tenantPrisma);
    const suppliers = new SupplierService(tenantPrisma);
    const budgets = new BudgetService(tenantPrisma, validation);
    const apVouchers = new APVoucherService(tenantPrisma, validation);
    const apPayments = new APPaymentService(tenantPrisma, posting);
    const reconciliation = new ReconciliationService(tenantPrisma, validation);
    const boardReports = new BoardReportService(tenantPrisma);
    const grants = new GrantService(tenantPrisma, validation);

    controller = new FinanceController(
      funds,
      chart,
      periods,
      posting,
      suppliers,
      budgets,
      apVouchers,
      apPayments,
      reconciliation,
      boardReports,
      grants,
      actors,
    );

    const deptBudgets = new DepartmentalBudgetService(tenantPrisma, permCheck);
    const transfers = new BudgetTransferService(tenantPrisma, permCheck, outbox);
    const journals = new JournalBatchService(tenantPrisma, permCheck, outbox);
    advanced = new FinanceAdvancedController(actors, deptBudgets, transfers, journals);

    // Grant the test admin sch-001:admin + finance perms so resolveActor
    // returns isSchoolAdmin=true and the FIN-005/006/007/008 admin gates pass.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'fin-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'fin-005:read',
        'fin-005:write',
        'fin-005:admin',
        'fin-006:read',
        'fin-006:write',
        'fin-006:admin',
        'fin-007:read',
        'fin-007:write',
        'fin-007:admin',
        'fin-008:read',
        'fin-008:write',
        'fin-008:admin',
      ],
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'fin-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetFinanceTables(tenantPrisma);
    });
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  function req(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
      },
    };
  }

  describe('FinanceController — Funds', () => {
    it('list + getById + create + patch', async () => {
      const list = await withTestTenant(() => controller.listFunds());
      expect(Array.isArray(list)).toBe(true);

      const got = await withTestTenant(() => controller.getFund(TEST_FUND_ID));
      expect(got.id).toBe(TEST_FUND_ID);

      const created = await withTestTenant(() =>
        controller.createFund(
          {
            fundCode: 'CC-FUND-' + generateId().slice(-6),
            fundName: 'CC Fund',
            fundType: 'CAPITAL_PROJECTS',
          } as any,
          req(),
        ),
      );
      expect(created.id).toBeTruthy();

      const patched = await withTestTenant(() =>
        controller.patchFund(created.id, { fundName: 'CC Fund Renamed' } as any, req()),
      );
      expect(patched.fundName).toBe('CC Fund Renamed');
    });
  });

  describe('FinanceController — Chart of Accounts', () => {
    it('list + getById + create + patch + trialBalance', async () => {
      const list = await withTestTenant(() => controller.listAccounts());
      expect(Array.isArray(list)).toBe(true);

      const listAll = await withTestTenant(() => controller.listAccounts('true'));
      expect(Array.isArray(listAll)).toBe(true);

      const got = await withTestTenant(() => controller.getAccount(TEST_COA_CASH_ID));
      expect(got.id).toBe(TEST_COA_CASH_ID);

      const created = await withTestTenant(() =>
        controller.createAccount(
          {
            accountCode: 'CC-ACC-' + generateId().slice(-4),
            accountName: 'CC Travel',
            accountType: 'EXPENSE',
            normalBalance: 'DEBIT',
          } as any,
          req(),
        ),
      );
      const patched = await withTestTenant(() =>
        controller.patchAccount(created.id, { accountName: 'Renamed Travel' } as any, req()),
      );
      expect(patched.accountName).toBe('Renamed Travel');

      const tb = await withTestTenant(() => controller.trialBalance(TEST_PERIOD_ID));
      expect(tb.lines).toBeDefined();
    });
  });

  describe('FinanceController — Periods', () => {
    it('list + getById + create + createSeries + patchStatus', async () => {
      const list = await withTestTenant(() => controller.listPeriods());
      expect(Array.isArray(list)).toBe(true);

      const filteredList = await withTestTenant(() => controller.listPeriods('2026'));
      expect(Array.isArray(filteredList)).toBe(true);

      const got = await withTestTenant(() => controller.getPeriod(TEST_PERIOD_ID));
      expect(got.id).toBe(TEST_PERIOD_ID);

      const series = await withTestTenant(() =>
        controller.createPeriodSeries(
          {
            fiscalYear: '2032',
            yearStart: '2032-07-01',
          } as any,
          req(),
        ),
      );
      expect(series.length).toBeGreaterThan(0);

      const created = await withTestTenant(() =>
        controller.createPeriod(
          {
            fiscalYear: '2033',
            periodNumber: 1,
            periodName: 'CC FY33 Period 1',
            startDate: '2033-07-01',
            endDate: '2033-07-31',
          } as any,
          req(),
        ),
      );
      const transitioned = await withTestTenant(() =>
        controller.patchPeriodStatus(created.id, { status: 'OPEN' } as any, req()),
      );
      expect(transitioned.status).toBe('OPEN');
    });
  });

  describe('FinanceController — Journal Batches', () => {
    it('list + getById + create + post + void', async () => {
      const batch = await withTestTenant(() =>
        controller.createBatch(
          {
            batchNumber: 'JB-CC-' + generateId().slice(0, 8),
            description: 'CC test',
            batchType: 'MANUAL',
            accountingPeriodId: TEST_PERIOD_ID,
            entries: [
              { accountId: TEST_COA_CASH_ID, fundId: TEST_FUND_ID, debit: 100, credit: 0 },
              { accountId: TEST_COA_REVENUE_ID, fundId: TEST_FUND_ID, debit: 0, credit: 100 },
            ],
          } as any,
          req(),
        ),
      );
      expect(batch.status).toBe('DRAFT');

      const list = await withTestTenant(() => controller.listBatches());
      expect(list.find((b: any) => b.id === batch.id)).toBeDefined();

      const filtered = await withTestTenant(() => controller.listBatches('DRAFT', TEST_PERIOD_ID));
      expect(filtered.find((b: any) => b.id === batch.id)).toBeDefined();

      // Smoke-test sourceModule filter (will likely be empty for our DRAFT batch).
      const emptySource = await withTestTenant(() =>
        controller.listBatches(undefined, undefined, 'manual'),
      );
      expect(Array.isArray(emptySource)).toBe(true);

      const got = await withTestTenant(() => controller.getBatch(batch.id));
      expect(got.id).toBe(batch.id);

      const posted = await withTestTenant(() => controller.postBatch(batch.id, req()));
      expect(posted.status).toBe('POSTED');

      const voided = await withTestTenant(() =>
        controller.voidBatch(batch.id, { reason: 'test' } as any, req()),
      );
      expect(voided.status).toBe('VOIDED');
    });
  });

  describe('FinanceController — Suppliers', () => {
    it('list + getById + create', async () => {
      const list = await withTestTenant(() => controller.listSuppliers());
      expect(Array.isArray(list)).toBe(true);

      const listAll = await withTestTenant(() => controller.listSuppliers('true'));
      expect(Array.isArray(listAll)).toBe(true);

      const got = await withTestTenant(() => controller.getSupplier(TEST_SUPPLIER_A_ID));
      expect(got.id).toBe(TEST_SUPPLIER_A_ID);

      const created = await withTestTenant(() =>
        controller.createSupplier(
          {
            supplierCode: 'CC-' + generateId().slice(-6),
            supplierName: 'CC Vendor',
            supplierType: 'VENDOR',
          } as any,
          req(),
        ),
      );
      expect(created.id).toBeTruthy();
    });
  });

  describe('FinanceController — Budgets', () => {
    it('list + getById + create + patch + addLine', async () => {
      const list = await withTestTenant(() => controller.listBudgets());
      expect(Array.isArray(list)).toBe(true);

      const fy = await withTestTenant(() => controller.listBudgets('2026'));
      expect(Array.isArray(fy)).toBe(true);

      const got = await withTestTenant(() => controller.getBudget(TEST_BUDGET_ID));
      expect(got.id).toBe(TEST_BUDGET_ID);

      const created = await withTestTenant(() =>
        controller.createBudget(
          {
            fiscalYear: '2028',
            fundId: TEST_FUND_ID,
            name: 'CC FY28 Operating',
            totalRevenue: 10000,
            totalExpense: 10000,
          } as any,
          req(),
        ),
      );
      const patched = await withTestTenant(() =>
        controller.patchBudget(created.id, { totalRevenue: 20000 } as any, req()),
      );
      expect(patched.totalRevenue).toBe(20000);

      const withLine = await withTestTenant(() =>
        controller.addBudgetLine(
          created.id,
          {
            accountId: TEST_COA_SUPPLIES_ID,
            budgetedAmount: 5000,
            lineType: 'EXPENSE',
          } as any,
          req(),
        ),
      );
      expect(withLine.lines.length).toBeGreaterThan(0);
    });
  });

  describe('FinanceController — AP Vouchers + Payments', () => {
    it('full AP flow: create voucher → transition → pay → list payments', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const voucher = await withTestTenant(() =>
        controller.createAPVoucher(
          {
            supplierId: TEST_SUPPLIER_A_ID,
            voucherNumber: 'V-CC-' + generateId().slice(-6),
            invoiceNumber: 'INV-CC-1',
            invoiceDate: today,
            dueDate: due,
            totalAmount: 500,
            description: 'CC AP voucher',
            glAccountId: TEST_COA_SUPPLIES_ID,
            fundId: TEST_FUND_ID,
          } as any,
          req(),
        ),
      );
      expect(voucher.status).toBe('PENDING');

      const list = await withTestTenant(() => controller.listAPVouchers());
      expect(list.find((v: any) => v.id === voucher.id)).toBeDefined();
      const filtered = await withTestTenant(() =>
        controller.listAPVouchers('PENDING', TEST_SUPPLIER_A_ID),
      );
      expect(filtered.find((v: any) => v.id === voucher.id)).toBeDefined();

      const got = await withTestTenant(() => controller.getAPVoucher(voucher.id));
      expect(got.id).toBe(voucher.id);

      const approved = await withTestTenant(() =>
        controller.transitionAPVoucher(voucher.id, { action: 'APPROVE' } as any, req()),
      );
      expect(approved.status).toBe('APPROVED');

      const payment = await withTestTenant(() =>
        controller.payAPVoucher(
          voucher.id,
          {
            paymentMethod: 'CHECK',
            amount: 500,
            paymentDate: today,
            cashAccountId: TEST_COA_CASH_ID,
            accountingPeriodId: TEST_PERIOD_ID,
            referenceNumber: 'CHK-CC-001',
          } as any,
          req(),
        ),
      );
      expect(payment.id).toBeTruthy();

      const payments = await withTestTenant(() => controller.listAPPayments(voucher.id));
      expect(payments.length).toBe(1);
    });
  });

  describe('FinanceController — Reconciliation', () => {
    it('list + getById + start + finalize', async () => {
      const r = await withTestTenant(() =>
        controller.startReconciliation(
          {
            accountId: TEST_COA_CASH_ID,
            periodId: TEST_PERIOD_ID,
            bankBalance: 0,
            outstandingItems: [],
          } as any,
          req(),
        ),
      );
      expect(r.status).toBe('IN_PROGRESS');

      const list = await withTestTenant(() => controller.listReconciliation());
      expect(list.find((x: any) => x.id === r.id)).toBeDefined();

      const got = await withTestTenant(() => controller.getReconciliation(r.id));
      expect(got.id).toBe(r.id);

      const finalized = await withTestTenant(() =>
        controller.finalizeReconciliation(
          r.id,
          { bankBalance: 0, outstandingItems: [], notes: 'closed' } as any,
          req(),
        ),
      );
      expect(finalized.status).toBe('RECONCILED');
    });
  });

  describe('FinanceController — Board Reports', () => {
    it('list + getById + generate', async () => {
      const r = await withTestTenant(() =>
        controller.generateBoardReport(
          { reportType: 'BALANCE_SHEET', periodId: TEST_PERIOD_ID } as any,
          req(),
        ),
      );
      expect(r.reportType).toBe('BALANCE_SHEET');

      const list = await withTestTenant(() => controller.listBoardReports());
      expect(list.find((b: any) => b.id === r.id)).toBeDefined();

      const got = await withTestTenant(() => controller.getBoardReport(r.id));
      expect(got.id).toBe(r.id);
    });
  });

  describe('FinanceController — Grants', () => {
    it('list + getById + create + patch', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const oneYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
      const created = await withTestTenant(() =>
        controller.createGrant(
          {
            fundId: TEST_FUND_ID,
            grantName: 'CC Grant',
            grantor: 'CC Funder',
            grantNumber: 'CC-GRANT-' + generateId().slice(-4),
            awardAmount: 10000,
            startDate: today,
            endDate: oneYear,
          } as any,
          req(),
        ),
      );

      const list = await withTestTenant(() => controller.listGrants());
      expect(list.find((g: any) => g.id === created.id)).toBeDefined();

      const got = await withTestTenant(() => controller.getGrant(created.id));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(() =>
        controller.patchGrant(created.id, { grantName: 'Renamed Grant' } as any, req()),
      );
      expect(patched.grantName).toBe('Renamed Grant');
    });
  });

  // ─── FinanceAdvancedController ────────────────────────────────────

  describe('FinanceAdvancedController — Departmental Budgets', () => {
    it('list + getById + create + patch', async () => {
      const list = await withTestTenant(() => advanced.listBudgets(req()));
      expect(Array.isArray(list)).toBe(true);

      const filtered = await withTestTenant(() =>
        advanced.listBudgets(req(), TEST_ACADEMIC_YEAR_ID, 'Athletics', 'EQUIPMENT'),
      );
      expect(Array.isArray(filtered)).toBe(true);

      const created = await withTestTenant(() =>
        advanced.createBudget(req(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department: 'CC-Dept-' + generateId().slice(-4),
          budgetCategory: 'EQUIPMENT',
          allocatedAmount: 5000,
        } as any),
      );

      const got = await withTestTenant(() => advanced.getBudget(req(), created.id));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(() =>
        advanced.patchBudget(req(), created.id, { allocatedAmount: 6000 } as any),
      );
      expect(patched.allocatedAmount).toBe(6000);
    });
  });

  describe('FinanceAdvancedController — Budget Transfers', () => {
    it('request + list + getById + approve + reject', async () => {
      const fromB = await withTestTenant(() =>
        advanced.createBudget(req(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department: 'CC-From-' + generateId().slice(-4),
          budgetCategory: 'SUPPLIES',
          allocatedAmount: 1000,
        } as any),
      );
      const toB = await withTestTenant(() =>
        advanced.createBudget(req(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department: 'CC-To-' + generateId().slice(-4),
          budgetCategory: 'SUPPLIES',
          allocatedAmount: 500,
        } as any),
      );

      const transfer = await withTestTenant(() =>
        advanced.requestTransfer(req(), {
          fromBudgetId: fromB.id,
          toBudgetId: toB.id,
          amount: 200,
          reason: 'CC reallocation',
        } as any),
      );
      expect(transfer.status).toBe('PENDING');

      const list = await withTestTenant(() => advanced.listTransfers(req()));
      expect(list.find((t: any) => t.id === transfer.id)).toBeDefined();
      const filtered = await withTestTenant(() => advanced.listTransfers(req(), 'PENDING'));
      expect(filtered.find((t: any) => t.id === transfer.id)).toBeDefined();

      const got = await withTestTenant(() => advanced.getTransfer(req(), transfer.id));
      expect(got.id).toBe(transfer.id);

      const approved = await withTestTenant(() => advanced.approveTransfer(req(), transfer.id));
      expect(approved.status).toBe('APPROVED');

      // Reject another
      const transfer2 = await withTestTenant(() =>
        advanced.requestTransfer(req(), {
          fromBudgetId: fromB.id,
          toBudgetId: toB.id,
          amount: 100,
          reason: 'CC retry',
        } as any),
      );
      const rejected = await withTestTenant(() =>
        advanced.rejectTransfer(req(), transfer2.id, { reason: 'no' } as any),
      );
      expect(rejected.status).toBe('REJECTED');
    });
  });

  describe('FinanceAdvancedController — Journal Entry Batches', () => {
    it('full flow: create → addLine → removeLine → addLines → post → void', async () => {
      const batch = await withTestTenant(() =>
        advanced.createJournalBatch(req(), {
          batchName: 'CC-JB-' + generateId().slice(-6),
          description: 'CC manual journal',
        } as any),
      );
      expect(batch.status).toBe('DRAFT');

      const list = await withTestTenant(() => advanced.listJournalBatches(req()));
      expect(list.find((b: any) => b.id === batch.id)).toBeDefined();
      const filtered = await withTestTenant(() => advanced.listJournalBatches(req(), 'DRAFT'));
      expect(filtered.find((b: any) => b.id === batch.id)).toBeDefined();

      const got = await withTestTenant(() => advanced.getJournalBatch(req(), batch.id));
      expect(got.id).toBe(batch.id);

      // Add a line, then remove it, then add a balanced pair
      const tempLine = await withTestTenant(() =>
        advanced.addLine(req(), batch.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 50,
          credit: 0,
          description: 'temp',
        } as any),
      );
      await withTestTenant(() => advanced.removeLine(req(), batch.id, tempLine.id));

      await withTestTenant(() =>
        advanced.addLine(req(), batch.id, {
          accountId: TEST_COA_CASH_ID,
          debit: 100,
          credit: 0,
        } as any),
      );
      await withTestTenant(() =>
        advanced.addLine(req(), batch.id, {
          accountId: TEST_COA_REVENUE_ID,
          debit: 0,
          credit: 100,
        } as any),
      );

      const posted = await withTestTenant(() => advanced.postJournalBatch(req(), batch.id));
      expect(posted.status).toBe('POSTED');

      const voided = await withTestTenant(() =>
        advanced.voidJournalBatch(req(), batch.id, { reason: 'CC test' } as any),
      );
      expect(voided.status).toBe('VOIDED');
    });
  });
});
