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
  ChartOfAccountsService,
  FundService,
  PeriodService,
} from '@modules/m83-finance/chart.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
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
  TEST_FUND_ID,
  TEST_COA_CASH_ID,
  TEST_COA_AR_ID,
  TEST_COA_AP_ID,
  TEST_COA_REVENUE_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_PERIOD_ID,
  TEST_FUND_B_ID,
  TEST_COA_SUPPLIES_B_ID,
  TEST_PERIOD_B_ID,
} from '../fixtures/finance';

/**
 * Wave 1 — DB-backed integration tests for m83-finance chart of accounts.
 * Replaces apps/api/src/modules/m83-finance/chart.service.spec.ts.
 *
 * Surfaces under test: FundService, ChartOfAccountsService, PeriodService.
 *
 * Quality bar (test strategy v3):
 *   - Every test runs against the real tenant_test schema
 *   - Services are constructed directly (no NestJS test module)
 *   - Assertions query DB state via raw SQL where the service result
 *     doesn't already prove the contract
 *   - Cross-school tests seed School A + School B and confirm a School A
 *     actor cannot see / mutate School B rows (NotFoundException)
 */
describe('integration:m83-finance/chart-of-accounts', () => {
  let tenantPrisma: TenantPrismaService;
  let funds: FundService;
  let chart: ChartOfAccountsService;
  let periods: PeriodService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    funds = new FundService(tenantPrisma);
    chart = new ChartOfAccountsService(tenantPrisma);
    periods = new PeriodService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetFinanceTables(tenantPrisma);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // FundService
  // ────────────────────────────────────────────────────────────────────
  describe('FundService', () => {
    it('list returns the fixture General Fund for School A', async () => {
      const result = await withTestTenant(async () => funds.list());
      expect(result.length).toBeGreaterThanOrEqual(1);
      const general = result.find((f) => f.id === TEST_FUND_ID);
      expect(general).toBeDefined();
      expect(general?.fundCode).toBe('GENERAL');
      expect(general?.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('list scoped to School A does NOT return the School B fund', async () => {
      const result = await withTestTenant(async () => funds.list());
      const schoolBFund = result.find((f) => f.id === TEST_FUND_B_ID);
      expect(schoolBFund).toBeUndefined();
    });

    it('list scoped to School B returns ONLY the School B fund', async () => {
      const result = await withTestTenantB(async () => funds.list());
      expect(result.find((f) => f.id === TEST_FUND_B_ID)).toBeDefined();
      expect(result.find((f) => f.id === TEST_FUND_ID)).toBeUndefined();
    });

    it('getById returns the fixture fund', async () => {
      const f = await withTestTenant(async () => funds.getById(TEST_FUND_ID));
      expect(f.id).toBe(TEST_FUND_ID);
      expect(f.fundCode).toBe('GENERAL');
      expect(f.fundType).toBe('GENERAL');
      expect(f.isActive).toBe(true);
    });

    it('getById for a School B fund as a School A actor → NotFoundException', async () => {
      await expect(withTestTenant(async () => funds.getById(TEST_FUND_B_ID))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('getById for a non-existent id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => funds.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create as admin persists a new fund + DB-state assertion', async () => {
      const created = await withTestTenant(async () =>
        funds.create(adminActor(), {
          fundCode: 'CAP-IT',
          fundName: 'IT Capital Fund',
          fundType: 'CAPITAL_PROJECTS',
          description: 'For tech refresh',
        }),
      );
      expect(created.fundCode).toBe('CAP-IT');
      expect(created.fundType).toBe('CAPITAL_PROJECTS');
      expect(created.schoolId).toBe(TEST_SCHOOL_ID);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT fund_code, fund_type, description FROM tenant_test.fin_funds WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ fund_code: string; fund_type: string; description: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.fund_code).toBe('CAP-IT');
      expect(rows[0]!.fund_type).toBe('CAPITAL_PROJECTS');
      expect(rows[0]!.description).toBe('For tech refresh');
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          funds.create(actor(), {
            fundCode: 'X',
            fundName: 'X Fund',
            fundType: 'GENERAL',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with a duplicate fund_code → ConflictException', async () => {
      await expect(
        withTestTenant(async () =>
          funds.create(adminActor(), {
            fundCode: 'GENERAL', // already exists in fixture
            fundName: 'Dup',
            fundType: 'GENERAL',
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('patch as admin updates fund_name + description + is_active', async () => {
      const created = await withTestTenant(async () =>
        funds.create(adminActor(), {
          fundCode: 'PATCH-FUND',
          fundName: 'Original',
          fundType: 'SPECIAL_REVENUE',
        }),
      );
      const patched = await withTestTenant(async () =>
        funds.patch(adminActor(), created.id, {
          fundName: 'Renamed',
          description: 'now described',
          isActive: false,
        }),
      );
      expect(patched.fundName).toBe('Renamed');
      expect(patched.description).toBe('now described');
      expect(patched.isActive).toBe(false);
    });

    it('patch with no-op input returns the row unchanged', async () => {
      const created = await withTestTenant(async () =>
        funds.create(adminActor(), {
          fundCode: 'NOOP',
          fundName: 'Noop',
          fundType: 'GENERAL',
        }),
      );
      const patched = await withTestTenant(async () => funds.patch(adminActor(), created.id, {}));
      expect(patched.id).toBe(created.id);
      expect(patched.fundName).toBe('Noop');
    });

    it('patch as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => funds.patch(officerActor(), TEST_FUND_ID, { fundName: 'X' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ChartOfAccountsService
  // ────────────────────────────────────────────────────────────────────
  describe('ChartOfAccountsService', () => {
    it('list returns the seeded fixture accounts for School A', async () => {
      const result = await withTestTenant(async () => chart.list());
      // ASSET (Cash, AR), LIABILITY (AP), REVENUE (Tuition), EXPENSE (Supplies)
      expect(result.length).toBeGreaterThanOrEqual(5);
      const codes = result.map((a) => a.accountCode).sort();
      expect(codes).toEqual(expect.arrayContaining(['1000', '1100', '2000', '4000', '5000']));
    });

    it('list does not return inactive accounts by default', async () => {
      // Create an inactive account
      const created = await withTestTenant(async () =>
        chart.create(adminActor(), {
          accountCode: '5500',
          accountName: 'Decommissioned',
          accountType: 'EXPENSE',
          normalBalance: 'DEBIT',
        }),
      );
      await withTestTenant(async () =>
        chart.patch(adminActor(), created.id, { isActive: false }),
      );

      const visible = await withTestTenant(async () => chart.list());
      expect(visible.find((a) => a.id === created.id)).toBeUndefined();

      const includingInactive = await withTestTenant(async () => chart.list(true));
      expect(includingInactive.find((a) => a.id === created.id)).toBeDefined();
    });

    it('list scoped to School A does NOT return School B accounts', async () => {
      const result = await withTestTenant(async () => chart.list());
      expect(result.find((a) => a.id === TEST_COA_SUPPLIES_B_ID)).toBeUndefined();
    });

    it('list scoped to School B returns ONLY the School B account', async () => {
      const result = await withTestTenantB(async () => chart.list());
      expect(result.find((a) => a.id === TEST_COA_SUPPLIES_B_ID)).toBeDefined();
      expect(result.find((a) => a.id === TEST_COA_SUPPLIES_ID)).toBeUndefined();
    });

    it('getById returns the fixture Cash account with the fund join populated', async () => {
      const cash = await withTestTenant(async () => chart.getById(TEST_COA_CASH_ID));
      expect(cash.accountCode).toBe('1000');
      expect(cash.accountType).toBe('ASSET');
      expect(cash.normalBalance).toBe('DEBIT');
      expect(cash.fundCode).toBe('GENERAL');
      expect(cash.isSystem).toBe(true);
      expect(cash.runningBalance).toBe(0);
    });

    it('getById for a School B account as a School A actor → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => chart.getById(TEST_COA_SUPPLIES_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for a missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => chart.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create as admin persists a new EXPENSE account', async () => {
      const created = await withTestTenant(async () =>
        chart.create(adminActor(), {
          accountCode: '5100',
          accountName: 'Travel',
          accountType: 'EXPENSE',
          normalBalance: 'DEBIT',
          fundId: TEST_FUND_ID,
          description: 'For PD travel',
        }),
      );
      expect(created.accountCode).toBe('5100');
      expect(created.accountName).toBe('Travel');
      expect(created.fundCode).toBe('GENERAL');
      expect(created.isSystem).toBe(false);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT account_code, school_id::text AS school_id FROM tenant_test.fin_chart_of_accounts WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ account_code: string; school_id: string }>;
      expect(rows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          chart.create(actor(), {
            accountCode: '9999',
            accountName: 'X',
            accountType: 'EXPENSE',
            normalBalance: 'DEBIT',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with duplicate account_code in same school → ConflictException', async () => {
      await expect(
        withTestTenant(async () =>
          chart.create(adminActor(), {
            accountCode: '1000', // Cash already exists in fixture
            accountName: 'Dup',
            accountType: 'ASSET',
            normalBalance: 'DEBIT',
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('create with same account_code in DIFFERENT school is allowed', async () => {
      // School A already has 1000 (Cash). School B does NOT have 1000.
      const created = await withTestTenantB(async () =>
        chart.create(adminActor(), {
          accountCode: '1000',
          accountName: 'Cash B',
          accountType: 'ASSET',
          normalBalance: 'DEBIT',
        }),
      );
      expect(created.accountCode).toBe('1000');
    });

    it('patch as admin updates description on a non-system account', async () => {
      const tuition = await withTestTenant(async () =>
        chart.patch(adminActor(), TEST_COA_REVENUE_ID, { description: 'Per-pupil tuition' }),
      );
      expect(tuition.description).toBe('Per-pupil tuition');
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
    ])('patch as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          chart.patch(actor(), TEST_COA_REVENUE_ID, { description: 'X' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch of system account: description-only is allowed', async () => {
      const cash = await withTestTenant(async () =>
        chart.patch(adminActor(), TEST_COA_CASH_ID, { description: 'Operating cash' }),
      );
      expect(cash.description).toBe('Operating cash');
    });

    it.each([
      ['accountName', { accountName: 'Renamed Cash' }],
      ['isActive', { isActive: false }],
      ['parentAccountId', { parentAccountId: TEST_COA_AR_ID }],
      ['fundId', { fundId: TEST_FUND_ID }],
    ])('patch of system account: %s → BadRequestException', async (_label, input) => {
      await expect(
        withTestTenant(async () => chart.patch(adminActor(), TEST_COA_CASH_ID, input)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch of missing account → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          chart.patch(adminActor(), '00000000-0000-0000-0000-000000000000', { description: 'X' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch with no fields returns the row unchanged', async () => {
      const result = await withTestTenant(async () =>
        chart.patch(adminActor(), TEST_COA_REVENUE_ID, {}),
      );
      expect(result.id).toBe(TEST_COA_REVENUE_ID);
    });

    // Trial balance — exercises the running_balance + posted-only filter
    describe('trialBalance', () => {
      // Helper: insert a balanced POSTED batch of (account, amount) pairs.
      // Must be called inside a withTestTenant block so the tenant context
      // is available to executeInTenantTransaction.
      async function seedPostedBatch(entries: Array<{ accountId: string; debit?: number; credit?: number }>) {
        const batchId = generateId();
        await tenantPrisma.executeInTenantTransaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO fin_journal_batches
               (id, school_id, batch_number, description, batch_type, accounting_period_id, status, posted_at, posted_by)
             VALUES ($1::uuid, $2::uuid, $3, 'test', 'MANUAL', $4::uuid, 'POSTED', now(), $5::uuid)`,
            batchId,
            TEST_SCHOOL_ID,
            'BATCH-' + batchId.slice(0, 8),
            TEST_PERIOD_ID,
            TEST_ADMIN_EMPLOYEE_ID,
          );
          for (const e of entries) {
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)`,
              generateId(),
              batchId,
              e.accountId,
              TEST_FUND_ID,
              e.debit ?? 0,
              e.credit ?? 0,
            );
          }
        });
        return batchId;
      }

      it('with no posted entries: every line is zero, balanced=true', async () => {
        const tb = await withTestTenant(async () => chart.trialBalance());
        expect(tb.totalDebit).toBe(0);
        expect(tb.totalCredit).toBe(0);
        expect(tb.balanced).toBe(true);
        for (const line of tb.lines) {
          expect(line.debitTotal).toBe(0);
          expect(line.creditTotal).toBe(0);
          expect(line.balance).toBe(0);
        }
      });

      it('aggregates posted entries and computes signed balance per normal_balance', async () => {
        // Classic AR-side invoice posting: DR AR 100, CR Revenue 100
        await withTestTenant(async () =>
          seedPostedBatch([
            { accountId: TEST_COA_AR_ID, debit: 100 },
            { accountId: TEST_COA_REVENUE_ID, credit: 100 },
          ]),
        );

        const tb = await withTestTenant(async () => chart.trialBalance());
        const ar = tb.lines.find((l) => l.accountId === TEST_COA_AR_ID)!;
        const rev = tb.lines.find((l) => l.accountId === TEST_COA_REVENUE_ID)!;
        expect(ar.debitTotal).toBe(100);
        expect(ar.creditTotal).toBe(0);
        expect(ar.balance).toBe(100); // DEBIT-normal: dt - ct
        expect(rev.debitTotal).toBe(0);
        expect(rev.creditTotal).toBe(100);
        expect(rev.balance).toBe(100); // CREDIT-normal: ct - dt
        expect(tb.totalDebit).toBe(100);
        expect(tb.totalCredit).toBe(100);
        expect(tb.balanced).toBe(true);
      });

      it('excludes DRAFT batches from the aggregate', async () => {
        await withTestTenant(async () => {
          // POST one $50 DR-AR / CR-Revenue batch
          await seedPostedBatch([
            { accountId: TEST_COA_AR_ID, debit: 50 },
            { accountId: TEST_COA_REVENUE_ID, credit: 50 },
          ]);
          // Add a DRAFT batch — should NOT count
          const draftBatchId = generateId();
          await tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_journal_batches
                 (id, school_id, batch_number, description, batch_type, accounting_period_id, status)
               VALUES ($1::uuid, $2::uuid, $3, 'draft', 'MANUAL', $4::uuid, 'DRAFT')`,
              draftBatchId,
              TEST_SCHOOL_ID,
              'DRAFT-' + draftBatchId.slice(0, 8),
              TEST_PERIOD_ID,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 999, 0)`,
              generateId(),
              draftBatchId,
              TEST_COA_AR_ID,
              TEST_FUND_ID,
            );
          });
        });

        const tb = await withTestTenant(async () => chart.trialBalance());
        const ar = tb.lines.find((l) => l.accountId === TEST_COA_AR_ID)!;
        expect(ar.debitTotal).toBe(50); // only the POSTED batch counts
        expect(tb.totalDebit).toBe(50);
      });

      it('filters by accounting_period_id when periodId is supplied', async () => {
        // Two POSTED batches in the fixture period
        await withTestTenant(async () =>
          seedPostedBatch([
            { accountId: TEST_COA_CASH_ID, debit: 200 },
            { accountId: TEST_COA_REVENUE_ID, credit: 200 },
          ]),
        );

        // Create a second period + a POSTED batch in it
        const otherPeriod = await withTestTenant(async () =>
          periods.create(adminActor(), {
            fiscalYear: '2026',
            periodNumber: 2,
            periodName: 'Test FY26 Period 2',
            startDate: '2026-08-01',
            endDate: '2026-08-31',
          }),
        );
        await withTestTenant(async () => {
          const otherBatchId = generateId();
          await tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_journal_batches
                 (id, school_id, batch_number, description, batch_type, accounting_period_id, status, posted_at, posted_by)
               VALUES ($1::uuid, $2::uuid, $3, 'p2', 'MANUAL', $4::uuid, 'POSTED', now(), $5::uuid)`,
              otherBatchId,
              TEST_SCHOOL_ID,
              'P2-' + otherBatchId.slice(0, 8),
              otherPeriod.id,
              TEST_ADMIN_EMPLOYEE_ID,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 75, 0)`,
              generateId(),
              otherBatchId,
              TEST_COA_CASH_ID,
              TEST_FUND_ID,
            );
          });
        });

        const tbAll = await withTestTenant(async () => chart.trialBalance());
        const cashAll = tbAll.lines.find((l) => l.accountId === TEST_COA_CASH_ID)!;
        expect(cashAll.debitTotal).toBe(275); // 200 + 75

        const tbFixture = await withTestTenant(async () => chart.trialBalance(TEST_PERIOD_ID));
        const cashFixture = tbFixture.lines.find((l) => l.accountId === TEST_COA_CASH_ID)!;
        expect(cashFixture.debitTotal).toBe(200); // only the fixture-period batch
      });

      it('cross-school: trialBalance for School A excludes School B entries', async () => {
        // Seed a School A batch
        await withTestTenant(async () =>
          seedPostedBatch([
            { accountId: TEST_COA_CASH_ID, debit: 500 },
            { accountId: TEST_COA_REVENUE_ID, credit: 500 },
          ]),
        );

        // Seed a School B batch pointing at School B's supplies account.
        // Use withTestTenantB so the inner executeInTenantTransaction has
        // a valid tenant context.
        await withTestTenantB(async () => {
          const bBatchId = generateId();
          await tenantPrisma.executeInTenantTransaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_journal_batches
                 (id, school_id, batch_number, description, batch_type, accounting_period_id, status, posted_at, posted_by)
               VALUES ($1::uuid, $2::uuid, $3, 'B', 'MANUAL', $4::uuid, 'POSTED', now(), $5::uuid)`,
              bBatchId,
              // schoolId belongs to School B
              '019e0cf8-aaaa-7777-8888-00000000000b',
              'B-' + bBatchId.slice(0, 8),
              TEST_PERIOD_B_ID,
              TEST_ADMIN_EMPLOYEE_ID,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO fin_gl_entries (id, batch_id, account_id, fund_id, debit, credit)
               VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 999, 0)`,
              generateId(),
              bBatchId,
              TEST_COA_SUPPLIES_B_ID,
              TEST_FUND_B_ID,
            );
          });
        });

        const tbA = await withTestTenant(async () => chart.trialBalance());
        // School A trial balance must not contain the School B supplies row
        const suppliesB = tbA.lines.find((l) => l.accountId === TEST_COA_SUPPLIES_B_ID);
        expect(suppliesB).toBeUndefined();
        // School A's cash should be exactly the School A batch
        const cashA = tbA.lines.find((l) => l.accountId === TEST_COA_CASH_ID)!;
        expect(cashA.debitTotal).toBe(500);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PeriodService
  // ────────────────────────────────────────────────────────────────────
  describe('PeriodService', () => {
    it('list returns the fixture period for School A', async () => {
      const result = await withTestTenant(async () => periods.list());
      expect(result.find((p) => p.id === TEST_PERIOD_ID)).toBeDefined();
    });

    it('list filtered by fiscalYear', async () => {
      // The fixture period is fiscal_year='2026'. A non-matching year returns []
      const matching = await withTestTenant(async () => periods.list('2026'));
      expect(matching.find((p) => p.id === TEST_PERIOD_ID)).toBeDefined();
      const empty = await withTestTenant(async () => periods.list('1999'));
      expect(empty).toEqual([]);
    });

    it('list scoped to School A does NOT return the School B period', async () => {
      const result = await withTestTenant(async () => periods.list());
      expect(result.find((p) => p.id === TEST_PERIOD_B_ID)).toBeUndefined();
    });

    it('getById for a School B period as School A → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => periods.getById(TEST_PERIOD_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create as admin persists a period with status=FUTURE by default', async () => {
      const created = await withTestTenant(async () =>
        periods.create(adminActor(), {
          fiscalYear: '2026',
          periodNumber: 3,
          periodName: 'September 2026',
          startDate: '2026-09-01',
          endDate: '2026-09-30',
        }),
      );
      expect(created.fiscalYear).toBe('2026');
      expect(created.periodNumber).toBe(3);
      expect(created.status).toBe('FUTURE');
    });

    it('create with endDate < startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          periods.create(adminActor(), {
            fiscalYear: '2026',
            periodNumber: 9,
            periodName: 'Reversed',
            startDate: '2026-10-31',
            endDate: '2026-10-01',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with duplicate (fiscalYear, periodNumber) → ConflictException', async () => {
      // The fixture has fiscal_year='2026', period_number=1
      await expect(
        withTestTenant(async () =>
          periods.create(adminActor(), {
            fiscalYear: '2026',
            periodNumber: 1,
            periodName: 'Dup',
            startDate: '2026-09-01',
            endDate: '2026-09-30',
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () =>
          periods.create(actor(), {
            fiscalYear: '2026',
            periodNumber: 4,
            periodName: 'X',
            startDate: '2026-10-01',
            endDate: '2026-10-31',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('createSeries generates 12 monthly periods for a fiscal year', async () => {
      const created = await withTestTenant(async () =>
        periods.createSeries(adminActor(), {
          fiscalYear: '2027',
          yearStart: '2027-07-01',
        }),
      );
      expect(created).toHaveLength(12);
      expect(created[0]!.periodNumber).toBe(1);
      expect(created[11]!.periodNumber).toBe(12);
      // Period 1 spans 2027-07-01 → 2027-07-31
      expect(created[0]!.startDate.slice(0, 10)).toBe('2027-07-01');
      expect(created[0]!.endDate.slice(0, 10)).toBe('2027-07-31');
    });

    // FINDING — Wave 1: PeriodService.createSeries is NOT actually
    // idempotent on re-run. The loop catches ConflictException and
    // `continue`s, but the underlying Postgres tx is already aborted by
    // the 23505 duplicate-key violation, so every subsequent INSERT in
    // the same tx fails with 25P02 "current transaction is aborted".
    // Fix is to wrap each INSERT in a per-iteration SAVEPOINT or to
    // pre-check existence with a SELECT before INSERT.
    //
    // Skipping rather than xfailing so this is a visible test gap, not
    // a green test that hides the bug. Documented in commit message.
    it('createSeries is idempotent — re-running skips existing periods [Finding 2 FIXED]', async () => {
      const first = await withTestTenant(async () =>
        periods.createSeries(adminActor(), {
          fiscalYear: '2028',
          yearStart: '2028-07-01',
        }),
      );
      expect(first).toHaveLength(12);
      const second = await withTestTenant(async () =>
        periods.createSeries(adminActor(), {
          fiscalYear: '2028',
          yearStart: '2028-07-01',
        }),
      );
      expect(second).toHaveLength(0);
    });

    it('createSeries rejects invalid yearStart', async () => {
      await expect(
        withTestTenant(async () =>
          periods.createSeries(adminActor(), {
            fiscalYear: '2029',
            yearStart: 'not-a-date',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createSeries as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          periods.createSeries(officerActor(), {
            fiscalYear: '2030',
            yearStart: '2030-07-01',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // FINDING — Wave 1: PeriodService.patchStatus returns a STALE DTO.
    // The method runs the UPDATE inside executeInTenantTransaction, then
    // calls `this.getById(id)` to build the response. getById opens a
    // separate executeInTenantContext tx, which under READ COMMITTED can
    // not see the not-yet-committed UPDATE from the outer tx, so the
    // returned DTO reflects the pre-update state. The persisted row IS
    // correct — only the return value is wrong. Fix is to inline the
    // SELECT inside the tx callback (use `tx` instead of `this.getById`).
    //
    // These tests assert the persisted DB state directly to verify the
    // behaviour, working around the return-value bug. The bug surfaces
    // to API callers as a confusing response that lags one request behind.
    it('patchStatus OPEN→CLOSED persists status, closed_at, closed_by', async () => {
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'CLOSED' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, closed_at IS NOT NULL AS closed_at_set, closed_by::text AS closed_by
           FROM tenant_test.fin_accounting_periods WHERE id = $1::uuid`,
        TEST_PERIOD_ID,
      )) as Array<{ status: string; closed_at_set: boolean; closed_by: string }>;
      expect(rows[0]!.status).toBe('CLOSED');
      expect(rows[0]!.closed_at_set).toBe(true);
      expect(rows[0]!.closed_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('patchStatus CLOSED→LOCKED persists status, locked_at, locked_by + retains closed_at', async () => {
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'CLOSED' }),
      );
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'LOCKED' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, locked_at IS NOT NULL AS locked_at_set, locked_by::text AS locked_by,
                closed_at IS NOT NULL AS closed_at_set
           FROM tenant_test.fin_accounting_periods WHERE id = $1::uuid`,
        TEST_PERIOD_ID,
      )) as Array<{
        status: string;
        locked_at_set: boolean;
        locked_by: string;
        closed_at_set: boolean;
      }>;
      expect(rows[0]!.status).toBe('LOCKED');
      expect(rows[0]!.locked_at_set).toBe(true);
      expect(rows[0]!.locked_by).toBe(TEST_ADMIN_EMPLOYEE_ID);
      expect(rows[0]!.closed_at_set).toBe(true);
    });

    it('patchStatus LOCKED → anything → BadRequestException', async () => {
      // Get to LOCKED
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'CLOSED' }),
      );
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'LOCKED' }),
      );
      // Any attempt to leave LOCKED fails
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'CLOSED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'OPEN' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patchStatus OPEN→OPEN is a no-op (DB row unchanged)', async () => {
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'OPEN' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, closed_at, closed_by FROM tenant_test.fin_accounting_periods WHERE id = $1::uuid`,
        TEST_PERIOD_ID,
      )) as Array<{ status: string; closed_at: string | null; closed_by: string | null }>;
      expect(rows[0]!.status).toBe('OPEN');
      expect(rows[0]!.closed_at).toBeNull();
      expect(rows[0]!.closed_by).toBeNull();
    });

    it('patchStatus illegal transition FUTURE→CLOSED → BadRequestException', async () => {
      const future = await withTestTenant(async () =>
        periods.create(adminActor(), {
          fiscalYear: '2031',
          periodNumber: 1,
          periodName: 'July 2031',
          startDate: '2031-07-01',
          endDate: '2031-07-31',
        }),
      );
      expect(future.status).toBe('FUTURE');
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(adminActor(), future.id, { status: 'CLOSED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patchStatus OPEN→FUTURE is allowed (correction) — persists FUTURE', async () => {
      await withTestTenant(async () =>
        periods.patchStatus(adminActor(), TEST_PERIOD_ID, { status: 'FUTURE' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.fin_accounting_periods WHERE id = $1::uuid`,
        TEST_PERIOD_ID,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('FUTURE');
    });

    it('patchStatus on a missing period → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(adminActor(), '00000000-0000-0000-0000-000000000000', {
            status: 'CLOSED',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchStatus on a School B period as School A actor → NotFoundException', async () => {
      // The locked-row SELECT FOR UPDATE inside the tx filters by
      // school_id, so a School A actor cannot transition a School B period.
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(adminActor(), TEST_PERIOD_B_ID, { status: 'CLOSED' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchStatus as non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(officerActor(), TEST_PERIOD_ID, { status: 'CLOSED' }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patchStatus by an actor without employeeId → BadRequestException', async () => {
      // Build a synthetic admin actor that's missing employeeId (mirrors
      // the Platform Admin persona which has no hr_employees row).
      const platformAdmin = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          periods.patchStatus(platformAdmin, TEST_PERIOD_ID, { status: 'CLOSED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Reference the fixture LIABILITY and AP accounts (also exercises that
    // AP fixture is queryable) so the import does not get pruned. Anchors
    // a future ap-voucher.spec.ts that will key on this account.
    it('fixture sanity: AP account is queryable from the chart', async () => {
      const ap = await withTestTenant(async () => chart.getById(TEST_COA_AP_ID));
      expect(ap.accountType).toBe('LIABILITY');
      expect(ap.normalBalance).toBe('CREDIT');
      expect(ap.isSystem).toBe(true);
    });
  });
});
