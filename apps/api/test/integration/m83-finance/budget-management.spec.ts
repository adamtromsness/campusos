import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { BudgetService } from '@modules/m83-finance/budgets.service';
import { DepartmentalBudgetService } from '@modules/m83-finance/departmental-budget.service';
import { BudgetTransferService } from '@modules/m83-finance/budget-transfer.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { resetFinanceTables } from '../helpers/reset';
import {
  TEST_ACADEMIC_YEAR_ID,
  TEST_FUND_ID,
  TEST_FUND_B_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_AR_ID,
  TEST_BUDGET_ID,
  TEST_BUDGET_B_ID,
} from '../fixtures/finance';

/**
 * Wave 1 — DB-backed integration tests for the m83-finance budget surfaces.
 * Replaces apps/api/src/modules/m83-finance/budgets.service.spec.ts.
 *
 * Three services in scope:
 *   - BudgetService: fin_budgets (line items, status transitions, school admin)
 *   - DepartmentalBudgetService: fin_departmental_budgets (per-department/category
 *     allocation rolled up across PERSONNEL/SUPPLIES/EQUIPMENT/etc.)
 *   - BudgetTransferService: fin_budget_transfers + KEYSTONE atomic
 *     approve path (from-decrement + to-increment + status flip + outbox
 *     emit ALL inside one tenant tx, with FOR UPDATE locks ordered by
 *     ascending id to avoid deadlock)
 *
 * Verifies outbox-in-tx atomicity: the durable fin.budget_transfer.approved
 * row lands in platform_outbox in the same tx as the budget mutations.
 */
describe('integration:m83-finance/budget-management', () => {
  let tenantPrisma: TenantPrismaService;
  let validation: FinanceValidationService;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let budgets: BudgetService;
  let deptBudgets: DepartmentalBudgetService;
  let transfers: BudgetTransferService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    validation = new FinanceValidationService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
    // Real PermissionCheckService. Tests with non-admin actors rely on
    // no iam_effective_access_cache rows existing for those accounts, so
    // hasAnyPermissionInTenant returns false. Admin actors short-circuit
    // via actor.isSchoolAdmin === true (no DB lookup).
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    budgets = new BudgetService(tenantPrisma, validation);
    deptBudgets = new DepartmentalBudgetService(tenantPrisma, permCheck);
    transfers = new BudgetTransferService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetFinanceTables(tenantPrisma);
    });
    // Also wipe outbox rows from prior tests so transfer-emit assertions
    // are clean. Outbox lives in platform schema, no fixture rows.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // BudgetService (fin_budgets)
  // ────────────────────────────────────────────────────────────────────
  describe('BudgetService', () => {
    it('list returns the fixture budget for School A', async () => {
      const result = await withTestTenant(async () => budgets.list());
      expect(result.find((b) => b.id === TEST_BUDGET_ID)).toBeDefined();
    });

    it('list filtered by fiscalYear', async () => {
      const matching = await withTestTenant(async () => budgets.list('2026'));
      expect(matching.find((b) => b.id === TEST_BUDGET_ID)).toBeDefined();
      const empty = await withTestTenant(async () => budgets.list('1999'));
      expect(empty.find((b) => b.id === TEST_BUDGET_ID)).toBeUndefined();
    });

    it('list scoped to School A does NOT return the School B budget', async () => {
      const result = await withTestTenant(async () => budgets.list());
      expect(result.find((b) => b.id === TEST_BUDGET_B_ID)).toBeUndefined();
    });

    it('getById returns the fixture budget with its line', async () => {
      const b = await withTestTenant(async () => budgets.getById(TEST_BUDGET_ID));
      expect(b.id).toBe(TEST_BUDGET_ID);
      expect(b.fiscalYear).toBe('2026');
      expect(b.fundCode).toBe('GENERAL');
      expect(b.status).toBe('APPROVED');
      expect(b.totalExpense).toBe(10000);
      expect(b.lines.length).toBeGreaterThanOrEqual(1);
    });

    it('getById for a School B budget as a School A actor → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => budgets.getById(TEST_BUDGET_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for a missing budget → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => budgets.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create as admin persists DRAFT budget with totals + zero approved', async () => {
      const created = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'FY27 Operating',
          totalRevenue: 50000,
          totalExpense: 50000,
        }),
      );
      expect(created.status).toBe('DRAFT');
      expect(created.fiscalYear).toBe('2027');
      expect(created.totalRevenue).toBe(50000);
      expect(created.approvedAt).toBeNull();
      expect(created.approvedBy).toBeNull();
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          budgets.create(actor(), {
            fiscalYear: '2027',
            fundId: TEST_FUND_ID,
            name: 'X',
            totalRevenue: 0,
            totalExpense: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with cross-school fundId → BadRequestException (FinanceValidationService)', async () => {
      // TEST_FUND_B_ID belongs to School B; School A actor cannot use it.
      await expect(
        withTestTenant(async () =>
          budgets.create(adminActor(), {
            fiscalYear: '2027',
            fundId: TEST_FUND_B_ID,
            name: 'X',
            totalRevenue: 0,
            totalExpense: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with duplicate (fiscalYear, fundId, name) → ConflictException', async () => {
      await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'Duplicate Name',
          totalRevenue: 0,
          totalExpense: 0,
        }),
      );
      await expect(
        withTestTenant(async () =>
          budgets.create(adminActor(), {
            fiscalYear: '2027',
            fundId: TEST_FUND_ID,
            name: 'Duplicate Name',
            totalRevenue: 0,
            totalExpense: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('patch DRAFT → APPROVED stamps approved_by + approved_at', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'FY27 Patch Target',
          totalRevenue: 1000,
          totalExpense: 1000,
        }),
      );
      const approved = await withTestTenant(async () =>
        budgets.patch(adminActor(), draft.id, { status: 'APPROVED' }),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(approved.approvedAt).not.toBeNull();
    });

    it('patch updates name + totals + status in one call', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'Original',
          totalRevenue: 0,
          totalExpense: 0,
        }),
      );
      const patched = await withTestTenant(async () =>
        budgets.patch(adminActor(), draft.id, {
          name: 'Renamed',
          totalRevenue: 100,
          totalExpense: 200,
        }),
      );
      expect(patched.name).toBe('Renamed');
      expect(patched.totalRevenue).toBe(100);
      expect(patched.totalExpense).toBe(200);
    });

    it('patch with empty input is a no-op (returns row unchanged)', async () => {
      const patched = await withTestTenant(async () =>
        budgets.patch(adminActor(), TEST_BUDGET_ID, {}),
      );
      expect(patched.id).toBe(TEST_BUDGET_ID);
    });

    it('patch as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => budgets.patch(officerActor(), TEST_BUDGET_ID, { name: 'X' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch by admin without employeeId → BadRequestException', async () => {
      const platformAdmin = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => budgets.patch(platformAdmin, TEST_BUDGET_ID, { name: 'X' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addLine appends a budget line for an active EXPENSE account', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'AddLineTarget',
          totalRevenue: 0,
          totalExpense: 5000,
        }),
      );
      const updated = await withTestTenant(async () =>
        budgets.addLine(adminActor(), draft.id, {
          accountId: TEST_COA_SUPPLIES_ID,
          budgetedAmount: 2500,
        }),
      );
      expect(updated.lines).toHaveLength(1);
      expect(updated.lines[0]!.accountCode).toBe('5000');
      expect(updated.lines[0]!.budgetedAmount).toBe(2500);
      expect(updated.lines[0]!.remainingAmount).toBe(2500);
    });

    it('addLine allows REVENUE accounts (REVIEW-CYCLE26 BLOCKING 5)', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'RevenueLines',
          totalRevenue: 1000,
          totalExpense: 0,
        }),
      );
      const updated = await withTestTenant(async () =>
        budgets.addLine(adminActor(), draft.id, {
          accountId: TEST_COA_REVENUE_ID,
          budgetedAmount: 1000,
        }),
      );
      expect(updated.lines[0]!.accountCode).toBe('4000');
    });

    it('addLine allows ASSET accounts (prepaid expense pattern)', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'AssetLines',
          totalRevenue: 0,
          totalExpense: 0,
        }),
      );
      const updated = await withTestTenant(async () =>
        budgets.addLine(adminActor(), draft.id, {
          accountId: TEST_COA_AR_ID,
          budgetedAmount: 500,
        }),
      );
      expect(updated.lines[0]!.accountCode).toBe('1100');
    });

    it('addLine with duplicate account on same budget → ConflictException', async () => {
      const draft = await withTestTenant(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_ID,
          name: 'DupLines',
          totalRevenue: 0,
          totalExpense: 0,
        }),
      );
      await withTestTenant(async () =>
        budgets.addLine(adminActor(), draft.id, {
          accountId: TEST_COA_SUPPLIES_ID,
          budgetedAmount: 100,
        }),
      );
      await expect(
        withTestTenant(async () =>
          budgets.addLine(adminActor(), draft.id, {
            accountId: TEST_COA_SUPPLIES_ID,
            budgetedAmount: 200,
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('addLine with cross-school accountId → BadRequestException', async () => {
      // TEST_COA_REVENUE_ID belongs to School A; an actor scoped to
      // School B cannot add a line to it.
      const draftB = await withTestTenantB(async () =>
        budgets.create(adminActor(), {
          fiscalYear: '2027',
          fundId: TEST_FUND_B_ID,
          name: 'B-Cross',
          totalRevenue: 0,
          totalExpense: 0,
        }),
      );
      await expect(
        withTestTenantB(async () =>
          budgets.addLine(adminActor(), draftB.id, {
            accountId: TEST_COA_REVENUE_ID,
            budgetedAmount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addLine as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          budgets.addLine(officerActor(), TEST_BUDGET_ID, {
            accountId: TEST_COA_SUPPLIES_ID,
            budgetedAmount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // DepartmentalBudgetService (fin_departmental_budgets)
  // ────────────────────────────────────────────────────────────────────
  describe('DepartmentalBudgetService', () => {
    async function seedBudget(department: string, category: string, allocated = 5000) {
      return withTestTenant(async () =>
        deptBudgets.create(adminActor(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department,
          budgetCategory: category as
            | 'PERSONNEL'
            | 'SUPPLIES'
            | 'EQUIPMENT'
            | 'CONTRACTED_SERVICES'
            | 'TRAVEL'
            | 'OTHER',
          allocatedAmount: allocated,
        }),
      );
    }

    it('list returns empty when no departmental budgets are seeded', async () => {
      const result = await withTestTenant(async () => deptBudgets.list(adminActor(), {}));
      expect(result).toEqual([]);
    });

    it('create + list returns a single budget with computed availableAmount', async () => {
      const created = await seedBudget('Athletics', 'EQUIPMENT', 8000);
      expect(created.allocatedAmount).toBe(8000);
      expect(created.committedAmount).toBe(0);
      expect(created.spentAmount).toBe(0);
      expect(created.availableAmount).toBe(8000);

      const all = await withTestTenant(async () => deptBudgets.list(adminActor(), {}));
      expect(all).toHaveLength(1);
      expect(all[0]!.id).toBe(created.id);
    });

    it('list filters by academicYearId / department / category', async () => {
      await seedBudget('Athletics', 'EQUIPMENT', 8000);
      await seedBudget('Athletics', 'TRAVEL', 2000);
      await seedBudget('Library', 'SUPPLIES', 1000);

      const byDept = await withTestTenant(async () =>
        deptBudgets.list(adminActor(), { department: 'Athletics' }),
      );
      expect(byDept).toHaveLength(2);

      const byCat = await withTestTenant(async () =>
        deptBudgets.list(adminActor(), { category: 'SUPPLIES' }),
      );
      expect(byCat).toHaveLength(1);
      expect(byCat[0]!.department).toBe('Library');

      const byYear = await withTestTenant(async () =>
        deptBudgets.list(adminActor(), { academicYearId: TEST_ACADEMIC_YEAR_ID }),
      );
      expect(byYear).toHaveLength(3);

      const otherYear = await withTestTenant(async () =>
        deptBudgets.list(adminActor(), {
          academicYearId: '00000000-0000-0000-0000-000000000000',
        }),
      );
      expect(otherYear).toEqual([]);
    });

    it('create rejects cross-school academicYearId', async () => {
      // School B has no academic_year row; the only fixture year belongs to
      // School A. Calling as School B actor must reject.
      await expect(
        withTestTenantB(async () =>
          deptBudgets.create(adminActor(), {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            department: 'Athletics',
            budgetCategory: 'EQUIPMENT',
            allocatedAmount: 1000,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          deptBudgets.create(actor(), {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            department: 'X',
            budgetCategory: 'OTHER',
            allocatedAmount: 0,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create rejects duplicate (department, category, year) for one school (ConflictException)', async () => {
      await seedBudget('Athletics', 'EQUIPMENT');
      await expect(seedBudget('Athletics', 'EQUIPMENT')).rejects.toBeInstanceOf(ConflictException);
    });

    it('admin-created budget is auto-approved (approved_by stamped)', async () => {
      const created = await seedBudget('Music', 'SUPPLIES');
      expect(created.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(created.approvedAt).not.toBeNull();
    });

    it('cross-school: getById for a different school → NotFoundException', async () => {
      const created = await seedBudget('Theatre', 'TRAVEL');
      // As School B, the row is invisible (it was seeded under School A)
      await expect(
        withTestTenantB(async () => deptBudgets.getById(adminActor(), created.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          deptBudgets.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch updates allocatedAmount + notes', async () => {
      const created = await seedBudget('Robotics', 'EQUIPMENT', 1000);
      const patched = await withTestTenant(async () =>
        deptBudgets.patch(adminActor(), created.id, {
          allocatedAmount: 5000,
          notes: 'Bumped for new kit',
        }),
      );
      expect(patched.allocatedAmount).toBe(5000);
      expect(patched.notes).toBe('Bumped for new kit');
    });

    it('patch with no input is a no-op (returns row)', async () => {
      const created = await seedBudget('Maintenance', 'CONTRACTED_SERVICES', 3000);
      const noop = await withTestTenant(async () =>
        deptBudgets.patch(adminActor(), created.id, {}),
      );
      expect(noop.id).toBe(created.id);
      expect(noop.allocatedAmount).toBe(3000);
    });

    it('patch as non-admin → ForbiddenException', async () => {
      const created = await seedBudget('Cafeteria', 'PERSONNEL', 100);
      await expect(
        withTestTenant(async () =>
          deptBudgets.patch(officerActor(), created.id, { allocatedAmount: 200 }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch missing budget → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          deptBudgets.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            allocatedAmount: 100,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // BudgetTransferService — KEYSTONE atomic transfer + outbox-in-tx
  // ────────────────────────────────────────────────────────────────────
  describe('BudgetTransferService', () => {
    async function seedTwoBudgets(a = 5000, b = 5000): Promise<{ fromId: string; toId: string }> {
      const from = await withTestTenant(async () =>
        deptBudgets.create(adminActor(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department: 'From-Dept',
          budgetCategory: 'SUPPLIES',
          allocatedAmount: a,
        }),
      );
      const to = await withTestTenant(async () =>
        deptBudgets.create(adminActor(), {
          academicYearId: TEST_ACADEMIC_YEAR_ID,
          department: 'To-Dept',
          budgetCategory: 'SUPPLIES',
          allocatedAmount: b,
        }),
      );
      return { fromId: from.id, toId: to.id };
    }

    // ─── request ───
    describe('request', () => {
      it('happy path: creates PENDING transfer with requested_by stamped', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'reallocation',
          }),
        );
        expect(created.status).toBe('PENDING');
        expect(created.requestedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
        expect(created.approvedBy).toBeNull();
        expect(created.transferredAt).toBeNull();
        expect(created.amount).toBe(100);
      });

      it('rejects same-budget self-transfer at the service layer', async () => {
        const { fromId } = await seedTwoBudgets();
        await expect(
          withTestTenant(async () =>
            transfers.request(adminActor(), {
              fromBudgetId: fromId,
              toBudgetId: fromId,
              amount: 50,
              reason: 'x',
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects request when either budget is missing or in another school', async () => {
        const { fromId } = await seedTwoBudgets();
        await expect(
          withTestTenant(async () =>
            transfers.request(adminActor(), {
              fromBudgetId: fromId,
              toBudgetId: '00000000-0000-0000-0000-000000000000',
              amount: 10,
              reason: 'x',
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects request by an actor without employeeId', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const platformAdmin = { ...adminActor(), employeeId: null };
        await expect(
          withTestTenant(async () =>
            transfers.request(platformAdmin, {
              fromBudgetId: fromId,
              toBudgetId: toId,
              amount: 10,
              reason: 'x',
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it.each([
        ['student', studentActor],
        ['parent', parentActor],
      ])('rejects request by %s', async (_label, actor) => {
        const { fromId, toId } = await seedTwoBudgets();
        await expect(
          withTestTenant(async () =>
            transfers.request(actor(), {
              fromBudgetId: fromId,
              toBudgetId: toId,
              amount: 10,
              reason: 'x',
            }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    // ─── approve — KEYSTONE ───
    describe('approve (atomic + outbox-in-tx)', () => {
      it('happy path: from-decrement + to-increment + status flip + outbox emit ALL in one tx', async () => {
        const { fromId, toId } = await seedTwoBudgets(5000, 5000);
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 1500,
            reason: 'reallocation',
          }),
        );

        const approved = await withTestTenant(async () =>
          transfers.approve(adminActor(), created.id),
        );
        expect(approved.status).toBe('APPROVED');
        expect(approved.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
        expect(approved.transferredAt).not.toBeNull();

        // Verify both budget rows mutated atomically
        const rows = (await rawClient.$queryRawUnsafe(
          `SELECT id::text AS id, allocated_amount FROM tenant_test.fin_departmental_budgets WHERE id IN ($1::uuid, $2::uuid) ORDER BY id`,
          fromId,
          toId,
        )) as Array<{ id: string; allocated_amount: string }>;
        const fromRow = rows.find((r) => r.id === fromId)!;
        const toRow = rows.find((r) => r.id === toId)!;
        expect(Number(fromRow.allocated_amount)).toBe(3500); // 5000 - 1500
        expect(Number(toRow.allocated_amount)).toBe(6500); // 5000 + 1500

        // Verify outbox row landed with the canonical envelope
        const outboxRows = (await rawClient.$queryRawUnsafe(
          `SELECT topic, message_key, envelope::text AS envelope, tenant_id::text AS tenant_id
             FROM platform.platform_outbox
            WHERE topic = 'fin.budget_transfer.approved' AND tenant_id = $1::uuid`,
          TEST_SCHOOL_ID,
        )) as Array<{ topic: string; message_key: string; envelope: string; tenant_id: string }>;
        expect(outboxRows).toHaveLength(1);
        expect(outboxRows[0]!.message_key).toBe(created.id);
        expect(outboxRows[0]!.tenant_id).toBe(TEST_SCHOOL_ID);
        const envelope = JSON.parse(outboxRows[0]!.envelope);
        expect(envelope.event_type).toBe('fin.budget_transfer.approved');
        expect(envelope.payload.transferId).toBe(created.id);
        expect(envelope.payload.fromBudgetId).toBe(fromId);
        expect(envelope.payload.toBudgetId).toBe(toId);
        expect(envelope.payload.amount).toBe(1500);
        expect(envelope.payload.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
      });

      it('rollback on insufficient balance leaves all rows untouched (no half-apply)', async () => {
        const { fromId, toId } = await seedTwoBudgets(100, 100);
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 500, // more than fromBudget has
            reason: 'too big',
          }),
        );

        await expect(
          withTestTenant(async () => transfers.approve(adminActor(), created.id)),
        ).rejects.toBeInstanceOf(BadRequestException);

        // Rows untouched
        const rows = (await rawClient.$queryRawUnsafe(
          `SELECT id::text AS id, allocated_amount FROM tenant_test.fin_departmental_budgets WHERE id IN ($1::uuid, $2::uuid)`,
          fromId,
          toId,
        )) as Array<{ id: string; allocated_amount: string }>;
        const fromRow = rows.find((r) => r.id === fromId)!;
        const toRow = rows.find((r) => r.id === toId)!;
        expect(Number(fromRow.allocated_amount)).toBe(100);
        expect(Number(toRow.allocated_amount)).toBe(100);

        // Transfer still PENDING
        const tRows = (await rawClient.$queryRawUnsafe(
          `SELECT status FROM tenant_test.fin_budget_transfers WHERE id = $1::uuid`,
          created.id,
        )) as Array<{ status: string }>;
        expect(tRows[0]!.status).toBe('PENDING');

        // No outbox row
        const outboxRows = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM platform.platform_outbox WHERE topic = 'fin.budget_transfer.approved' AND tenant_id = $1::uuid`,
          TEST_SCHOOL_ID,
        )) as Array<{ n: number }>;
        expect(outboxRows[0]!.n).toBe(0);
      });

      it('rejects approving a non-PENDING transfer (already APPROVED)', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        await withTestTenant(async () => transfers.approve(adminActor(), created.id));
        await expect(
          withTestTenant(async () => transfers.approve(adminActor(), created.id)),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejects approving a missing transfer (NotFoundException)', async () => {
        await expect(
          withTestTenant(async () =>
            transfers.approve(adminActor(), '00000000-0000-0000-0000-000000000000'),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('rejects approving as a non-admin actor', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        await expect(
          withTestTenant(async () => transfers.approve(officerActor(), created.id)),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('emits exactly one outbox row per approval (idempotent on event_id)', async () => {
        const { fromId, toId } = await seedTwoBudgets(10000, 10000);
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 50,
            reason: 'x',
          }),
        );
        await withTestTenant(async () => transfers.approve(adminActor(), created.id));

        const outboxRows = (await rawClient.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM platform.platform_outbox WHERE topic = 'fin.budget_transfer.approved' AND tenant_id = $1::uuid`,
          TEST_SCHOOL_ID,
        )) as Array<{ n: number }>;
        expect(outboxRows[0]!.n).toBe(1);
      });

      it('outbox event_id is deterministic per transferId (re-emit would be a duplicate)', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        await withTestTenant(async () => transfers.approve(adminActor(), created.id));

        const rows = (await rawClient.$queryRawUnsafe(
          `SELECT envelope::text AS envelope FROM platform.platform_outbox WHERE topic = 'fin.budget_transfer.approved' AND tenant_id = $1::uuid`,
          TEST_SCHOOL_ID,
        )) as Array<{ envelope: string }>;
        const envelope1 = JSON.parse(rows[0]!.envelope);
        const eventId1 = envelope1.event_id;

        // Re-derive the deterministic id from the same input
        const { deterministicBudgetTransferApprovedEventId } =
          await import('@modules/m83-finance/event-ids-advanced');
        const expected = deterministicBudgetTransferApprovedEventId(created.id);
        expect(eventId1).toBe(expected);
      });
    });

    // ─── reject ───
    describe('reject', () => {
      it('happy path: PENDING → REJECTED with rejection_reason + approved_by stamped', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        const rejected = await withTestTenant(async () =>
          transfers.reject(adminActor(), created.id, { rejectionReason: 'over budget' }),
        );
        expect(rejected.status).toBe('REJECTED');
        expect(rejected.rejectionReason).toBe('over budget');
        expect(rejected.approvedBy).toBe(TEST_ADMIN_EMPLOYEE_ID);
        expect(rejected.transferredAt).toBeNull();
      });

      it('rejecting a non-PENDING transfer fails', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        await withTestTenant(async () => transfers.approve(adminActor(), created.id));
        await expect(
          withTestTenant(async () =>
            transfers.reject(adminActor(), created.id, { rejectionReason: 'late' }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('rejecting a missing transfer → NotFoundException', async () => {
        await expect(
          withTestTenant(async () =>
            transfers.reject(adminActor(), '00000000-0000-0000-0000-000000000000', {
              rejectionReason: 'x',
            }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('rejecting as a non-admin → ForbiddenException', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const created = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );
        await expect(
          withTestTenant(async () =>
            transfers.reject(officerActor(), created.id, { rejectionReason: 'x' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    // ─── list + getById ───
    describe('list + getById', () => {
      it('list returns transfers scoped to the calling school', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const t = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 100,
            reason: 'x',
          }),
        );

        const list = await withTestTenant(async () => transfers.list(adminActor()));
        expect(list.find((row) => row.id === t.id)).toBeDefined();
      });

      it('list filtered by status', async () => {
        const { fromId, toId } = await seedTwoBudgets();
        const t1 = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 50,
            reason: 'r1',
          }),
        );
        const t2 = await withTestTenant(async () =>
          transfers.request(adminActor(), {
            fromBudgetId: fromId,
            toBudgetId: toId,
            amount: 60,
            reason: 'r2',
          }),
        );
        await withTestTenant(async () => transfers.approve(adminActor(), t1.id));

        const approved = await withTestTenant(async () => transfers.list(adminActor(), 'APPROVED'));
        expect(approved.find((row) => row.id === t1.id)).toBeDefined();
        expect(approved.find((row) => row.id === t2.id)).toBeUndefined();

        const pending = await withTestTenant(async () => transfers.list(adminActor(), 'PENDING'));
        expect(pending.find((row) => row.id === t2.id)).toBeDefined();
        expect(pending.find((row) => row.id === t1.id)).toBeUndefined();
      });

      it('getById for a missing transfer → NotFoundException', async () => {
        await expect(
          withTestTenant(async () =>
            transfers.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('getById for a School B transfer as School A → NotFoundException', async () => {
        // The fixture doesn't seed a sis_academic_years row for School B,
        // so we can't create a School B departmental budget via the service
        // (cross-school FK check rejects). Inject the rows directly via
        // SQL to assert the transfer-side school filter independently.
        const yearId = generateId();
        const fromB = generateId();
        const toB = generateId();
        const transferB = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO tenant_test.sis_academic_years (id, school_id, name, start_date, end_date, is_current) VALUES ($1::uuid, $2::uuid, '2025-2026 SchoolB', '2025-08-01', '2026-07-31', false)`,
          yearId,
          TEST_SCHOOL_B_ID,
        );
        await rawClient.$executeRawUnsafe(
          `INSERT INTO tenant_test.fin_departmental_budgets (id, school_id, academic_year_id, department, budget_category, allocated_amount) VALUES ($1::uuid, $2::uuid, $3::uuid, 'B-From', 'SUPPLIES', 500), ($4::uuid, $2::uuid, $3::uuid, 'B-To', 'SUPPLIES', 500)`,
          fromB,
          TEST_SCHOOL_B_ID,
          yearId,
          toB,
        );
        await rawClient.$executeRawUnsafe(
          `INSERT INTO tenant_test.fin_budget_transfers (id, school_id, from_budget_id, to_budget_id, amount, reason, requested_by) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100, 'B', $5::uuid)`,
          transferB,
          TEST_SCHOOL_B_ID,
          fromB,
          toB,
          TEST_ADMIN_EMPLOYEE_ID,
        );

        // School A actor cannot see it
        await expect(
          withTestTenant(async () => transfers.getById(adminActor(), transferB)),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });
  });
});
