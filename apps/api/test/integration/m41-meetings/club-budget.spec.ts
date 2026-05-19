import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ClubBudgetService } from '@modules/m41-meetings/meetings/club-budget.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
} from '../helpers/actor';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_ACADEMIC_YEAR_B_ID } from '../fixtures/sis';

/**
 * Wave 5 — m41-meetings ClubBudgetService.
 *
 * Tests the atomic spent_amount adjustment keystone: each
 * ext_budget_transactions INSERT updates the parent ext_club_budgets
 * row's spent / allocated in the same tenant tx.
 */
describe('integration:m41-meetings/club-budget', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ClubBudgetService;

  // School A + School B activity rows (seeded per spec, since the
  // shared fixture doesn't cover ext_activities)
  let activityTypeId: string;
  let activityId: string;
  let activityTypeBId: string;
  let activityBId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ClubBudgetService(tenantPrisma);

    // Read-or-create ext_activity_types + ext_activities for both schools.
    async function readOrCreateActivity(
      schoolId: string,
      typeName: string,
      activityName: string,
      academicYearId: string,
    ): Promise<{ typeId: string; activityId: string }> {
      const existingType = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_activity_types
          WHERE school_id = $1::uuid AND name = $2 LIMIT 1`,
        schoolId,
        typeName,
      );
      const typeId = existingType.length > 0 ? existingType[0]!.id : generateId();
      if (existingType.length === 0) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.ext_activity_types (id, school_id, name, category)
           VALUES ($1::uuid, $2::uuid, $3, 'OTHER')`,
          typeId,
          schoolId,
          typeName,
        );
      }
      const existingAct = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_activities
          WHERE school_id = $1::uuid AND name = $2 LIMIT 1`,
        schoolId,
        activityName,
      );
      const actId = existingAct.length > 0 ? existingAct[0]!.id : generateId();
      if (existingAct.length === 0) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.ext_activities (id, school_id, activity_type_id, name, academic_year_id, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'ACTIVE')`,
          actId,
          schoolId,
          typeId,
          activityName,
          academicYearId,
        );
      }
      return { typeId, activityId: actId };
    }

    const a = await readOrCreateActivity(
      TEST_SCHOOL_ID,
      'Test Club Type A',
      'Chess Club',
      TEST_SIS_ACADEMIC_YEAR_ID,
    );
    activityTypeId = a.typeId;
    activityId = a.activityId;

    const b = await readOrCreateActivity(
      TEST_SCHOOL_B_ID,
      'Test Club Type B',
      'B Club',
      TEST_SIS_ACADEMIC_YEAR_B_ID,
    );
    activityTypeBId = b.typeId;
    activityBId = b.activityId;
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.ext_budget_transactions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.ext_club_budgets`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // create + auth gates
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates budget → row inserted with allocated=500, spent=0', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            activityId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            allocatedAmount: 500,
            notes: 'initial allocation',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.activityId).toBe(activityId);
      expect(dto.allocatedAmount).toBe(500);
      expect(dto.spentAmount).toBe(0);
      expect(dto.remainingAmount).toBe(500);
    });

    it('duplicate (activity, year) → BadRequestException (UNIQUE)', async () => {
      await withTestTenant(async () =>
        service.create(
          { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID, allocatedAmount: 100 } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.create(
            { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID, allocatedAmount: 200 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STUDENT cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school activityId → ForbiddenException via assertActivityInCurrentSchool', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              activityId: activityBId, // B-school activity
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              allocatedAmount: 100,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school academicYearId → ForbiddenException via assertAcademicYearInCurrentSchool', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              activityId,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
              allocatedAmount: 100,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // patch
  // ────────────────────────────────────────────────────────────────────
  describe('patch', () => {
    it('admin updates allocated_amount + notes', async () => {
      const b = await withTestTenant(async () =>
        service.create(
          { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID, allocatedAmount: 100 } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        service.patch(b.id, { allocatedAmount: 250, notes: 'bumped' } as any, adminActor()),
      );
      expect(patched.allocatedAmount).toBe(250);
      expect(patched.notes).toBe('bumped');
    });

    it('patch with empty body returns current row', async () => {
      const b = await withTestTenant(async () =>
        service.create(
          { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        service.patch(b.id, {} as any, adminActor()),
      );
      expect(after.id).toBe(b.id);
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(
            '00000000-0000-0000-0000-000000000000',
            { allocatedAmount: 1 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list / getById
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById', () => {
    it('list returns budgets for the school; activityId filter narrows', async () => {
      const b = await withTestTenant(async () =>
        service.create(
          { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID, allocatedAmount: 100 } as any,
          adminActor(),
        ),
      );
      const all = await withTestTenant(async () => service.list(adminActor()));
      expect(all.map((r) => r.id)).toContain(b.id);

      const filtered = await withTestTenant(async () =>
        service.list(adminActor(), activityId),
      );
      expect(filtered.map((r) => r.id)).toContain(b.id);

      const empty = await withTestTenant(async () =>
        service.list(adminActor(), '00000000-0000-0000-0000-000000000000'),
      );
      expect(empty).toHaveLength(0);
    });

    it('getById returns the budget; missing → NotFoundException', async () => {
      const b = await withTestTenant(async () =>
        service.create(
          { activityId, academicYearId: TEST_SIS_ACADEMIC_YEAR_ID } as any,
          adminActor(),
        ),
      );
      const fetched = await withTestTenant(async () =>
        service.getById(b.id, adminActor()),
      );
      expect(fetched.id).toBe(b.id);
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STUDENT cannot list → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => service.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // recordTransaction — KEYSTONE
  // ────────────────────────────────────────────────────────────────────
  describe('recordTransaction (KEYSTONE)', () => {
    async function newBudget(allocated = 500): Promise<string> {
      const b = await withTestTenant(async () =>
        service.create(
          {
            activityId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            allocatedAmount: allocated,
          } as any,
          adminActor(),
        ),
      );
      return b.id;
    }

    it('EXPENSE bumps spent_amount up atomically in same tx as the transaction INSERT', async () => {
      const id = await newBudget(500);
      const tx = await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'EXPENSE', amount: 80, description: 'snacks' } as any,
          adminActor(),
        ),
      );
      expect(tx.transactionType).toBe('EXPENSE');
      expect(tx.amount).toBe(80);

      const after = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(after.spentAmount).toBe(80);
      expect(after.remainingAmount).toBe(420);
    });

    it('REFUND bumps spent_amount down', async () => {
      const id = await newBudget(500);
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'EXPENSE', amount: 100, description: 'initial' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'REFUND', amount: 25, description: 'partial return' } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(after.spentAmount).toBe(75);
    });

    it('ALLOCATION bumps allocated_amount up', async () => {
      const id = await newBudget(500);
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'ALLOCATION', amount: 200, description: 'extra funding' } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(after.allocatedAmount).toBe(700);
      expect(after.spentAmount).toBe(0);
    });

    it('ADJUSTMENT records notes without mutating amounts', async () => {
      const id = await newBudget(500);
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'ADJUSTMENT', amount: 1, description: 'reclass note' } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(after.allocatedAmount).toBe(500);
      expect(after.spentAmount).toBe(0);
    });

    it('EXPENSE exceeding allocated → BadRequestException; row state unchanged', async () => {
      const id = await newBudget(100);
      await expect(
        withTestTenant(async () =>
          service.recordTransaction(
            id,
            { transactionType: 'EXPENSE', amount: 150, description: 'too much' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const after = await withTestTenant(async () => service.getById(id, adminActor()));
      expect(after.spentAmount).toBe(0);
    });

    it('REFUND larger than current spent → BadRequestException', async () => {
      const id = await newBudget(500);
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'EXPENSE', amount: 10, description: 'small' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.recordTransaction(
            id,
            { transactionType: 'REFUND', amount: 50, description: 'too much refund' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('recordTransaction on missing budget → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.recordTransaction(
            '00000000-0000-0000-0000-000000000000',
            { transactionType: 'EXPENSE', amount: 10, description: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listTransactions returns ordered DESC by created_at', async () => {
      const id = await newBudget(500);
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'EXPENSE', amount: 10, description: 'first' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.recordTransaction(
          id,
          { transactionType: 'EXPENSE', amount: 20, description: 'second' } as any,
          adminActor(),
        ),
      );
      const txList = await withTestTenant(async () =>
        service.listTransactions(id, adminActor()),
      );
      expect(txList).toHaveLength(2);
      // newest first
      expect(txList[0]!.description).toBe('second');
    });

    it('listTransactions on missing budget → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.listTransactions('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // cross-school
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot see a School B budget via getById', async () => {
      const bId = (await withTestTenantB(async () =>
        service.create(
          {
            activityId: activityBId,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_B_ID,
            allocatedAmount: 100,
          } as any,
          adminActor(),
        ),
      )).id;
      await expect(
        withTestTenant(async () => service.getById(bId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
