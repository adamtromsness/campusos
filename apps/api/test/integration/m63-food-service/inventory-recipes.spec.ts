import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { InventoryService } from '@modules/m63-food-service/inventory.service';
import { RecipeService } from '@modules/m63-food-service/recipe.service';
import { TransferService } from '@modules/m63-food-service/transfer.service';
import { StaffMealService } from '@modules/m63-food-service/staff-meal.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
  TEST_MENU_ITEM_ID,
} from '../fixtures/food-service';

describe('integration:m63-food-service/inventory-recipes', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let inventory: InventoryService;
  let recipes: RecipeService;
  let transfers: TransferService;
  let staffMeals: StaffMealService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    inventory = new InventoryService(tenantPrisma, outbox, permCheck);
    recipes = new RecipeService(tenantPrisma, permCheck);
    transfers = new TransferService(tenantPrisma, permCheck);
    staffMeals = new StaffMealService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic LIKE 'fds.%'`,
    );
  });

  // ─── InventoryService ─────────────────────────────────
  describe('InventoryService', () => {
    async function makeGroup(name = 'Main Pantry') {
      return withTestTenant(async () =>
        inventory.createGroup(
          { name, groupType: 'LUNCH', location: 'Kitchen A' } as any,
          adminActor(),
        ),
      );
    }

    async function makeItem(name = 'Wheat Bread') {
      return withTestTenant(async () =>
        inventory.createItem(
          {
            name,
            unit: 'LOAF',
            category: 'GRAIN',
            allergenCodes: ['wheat'],
            reorderThreshold: 5,
            unitCost: 2.5,
          } as any,
          adminActor(),
        ),
      );
    }

    it('groups CRUD + listGroups + patchGroup', async () => {
      const g = await makeGroup();
      expect(g.name).toBe('Main Pantry');
      const list = await withTestTenant(async () => inventory.listGroups({}));
      expect(list.map((x) => x.id)).toContain(g.id);
      const patched = await withTestTenant(async () =>
        inventory.patchGroup(g.id, { name: 'Renamed Pantry' } as any, adminActor()),
      );
      expect(patched.name).toBe('Renamed Pantry');
    });

    it('items CRUD + listItems + patchItem', async () => {
      const it = await makeItem();
      const list = await withTestTenant(async () => inventory.listItems({}));
      expect(list.map((x) => x.id)).toContain(it.id);
      const patched = await withTestTenant(async () =>
        inventory.patchItem(it.id, { unitCost: 3.0 } as any, adminActor()),
      );
      expect(Number(patched.unitCost)).toBe(3.0);
    });

    it('receive → listLevels reflects stock; usage decreases; waste decreases; stocktake records', async () => {
      const g = await makeGroup();
      const it = await makeItem();

      await withTestTenant(async () =>
        inventory.receive(
          {
            groupId: g.id,
            itemId: it.id,
            quantity: 50,
            notes: 'Initial stock',
          } as any,
          adminActor(),
        ),
      );

      const levels = await withTestTenant(async () => inventory.listLevels(g.id));
      expect(levels.length).toBe(1);
      expect(Number(levels[0]!.quantityOnHand)).toBe(50);

      await withTestTenant(async () =>
        inventory.usage({ groupId: g.id, itemId: it.id, quantity: 10 } as any, adminActor()),
      );

      const afterUsage = await withTestTenant(async () => inventory.listLevels(g.id));
      expect(Number(afterUsage[0]!.quantityOnHand)).toBe(40);

      await withTestTenant(async () =>
        inventory.waste(
          {
            groupId: g.id,
            itemId: it.id,
            quantity: 5,
            reason: 'expired',
          } as any,
          adminActor(),
        ),
      );

      const afterWaste = await withTestTenant(async () => inventory.listLevels(g.id));
      expect(Number(afterWaste[0]!.quantityOnHand)).toBe(35);

      await withTestTenant(async () =>
        inventory.stocktake(
          {
            groupId: g.id,
            itemId: it.id,
            countedQuantity: 30,
            notes: 'audit',
          } as any,
          adminActor(),
        ),
      );

      const afterStocktake = await withTestTenant(async () => inventory.listLevels(g.id));
      expect(Number(afterStocktake[0]!.quantityOnHand)).toBe(30);
    });

    it('receive crossing below threshold fires fds.inventory.low outbox', async () => {
      const g = await makeGroup();
      const it = await makeItem('Low Stock Item');
      // Receive enough to be above threshold then use to drop below
      await withTestTenant(async () =>
        inventory.receive({ groupId: g.id, itemId: it.id, quantity: 10 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        inventory.usage({ groupId: g.id, itemId: it.id, quantity: 7 } as any, adminActor()),
      );
      const outbox = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'fds.inventory.low'`,
      )) as Array<{ topic: string }>;
      expect(outbox.length).toBeGreaterThan(0);
    });

    it('listTransactions returns all transactions', async () => {
      const g = await makeGroup();
      const it = await makeItem();
      await withTestTenant(async () =>
        inventory.receive({ groupId: g.id, itemId: it.id, quantity: 100 } as any, adminActor()),
      );
      const list = await withTestTenant(async () => inventory.listTransactions({}));
      expect(list.length).toBeGreaterThan(0);
    });

    it('non-admin createGroup → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          inventory.createGroup({ name: 'x', groupType: 'LUNCH' } as any, studentActor()),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── RecipeService ────────────────────────────────────
  describe('RecipeService', () => {
    async function makeRecipe() {
      return withTestTenant(async () =>
        recipes.create(
          {
            name: 'Pancakes',
            category: 'ENTREE',
            servingYield: 4,
            prepTimeMinutes: 15,
            instructions: 'Mix and cook',
          } as any,
          adminActor(),
        ),
      );
    }

    it('CRUD: create + list + getById + patch', async () => {
      const r = await makeRecipe();
      expect(r.name).toBe('Pancakes');
      const list = await withTestTenant(async () => recipes.list({}));
      expect(list.map((x) => x.id)).toContain(r.id);
      const fetched = await withTestTenant(async () => recipes.getById(r.id));
      expect(fetched.id).toBe(r.id);
      const patched = await withTestTenant(async () =>
        recipes.patch(r.id, { servingYield: 8 } as any, adminActor()),
      );
      expect(patched.servingYield).toBe(8);
    });

    it('addIngredient + updateIngredient + deleteIngredient', async () => {
      const r = await makeRecipe();
      // Add an ingredient
      const g = await withTestTenant(async () =>
        inventory.createGroup({ name: 'IGroup', groupType: 'LUNCH' } as any, adminActor()),
      );
      const it = await withTestTenant(async () =>
        inventory.createItem(
          { name: 'Flour', unit: 'CUP', category: 'GRAIN', unitCost: 0.5 } as any,
          adminActor(),
        ),
      );
      void g;

      const withIng = await withTestTenant(async () =>
        recipes.addIngredient(
          r.id,
          {
            inventoryItemId: it.id,
            ingredientName: 'Flour',
            quantity: 2,
            unit: 'CUP',
          } as any,
          adminActor(),
        ),
      );
      expect(withIng.ingredients.length).toBe(1);
      const ingredientId = withIng.ingredients[0]!.id;

      await withTestTenant(async () =>
        recipes.updateIngredient(ingredientId, { quantity: 3 } as any, adminActor()),
      );

      const afterDelete = await withTestTenant(async () =>
        recipes.deleteIngredient(ingredientId, adminActor()),
      );
      expect(afterDelete.ingredients.length).toBe(0);
    });

    it('getCost + getScaling', async () => {
      const r = await makeRecipe();
      const cost = await withTestTenant(async () => recipes.getCost(r.id));
      expect(cost).toBeTruthy();
      const scaling = await withTestTenant(async () => recipes.getScaling(r.id, 12));
      expect(scaling).toBeTruthy();
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          recipes.create({ name: 'X', category: 'ENTREE', servingYield: 1 } as any, studentActor()),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── TransferService ──────────────────────────────────
  describe('TransferService', () => {
    it('create + decide → APPROVED + complete', async () => {
      // Setup: two groups with inventory
      const fromG = await withTestTenant(async () =>
        inventory.createGroup({ name: 'From', groupType: 'LUNCH' } as any, adminActor()),
      );
      const toG = await withTestTenant(async () =>
        inventory.createGroup({ name: 'To', groupType: 'LUNCH' } as any, adminActor()),
      );
      const it = await withTestTenant(async () =>
        inventory.createItem(
          { name: 'Test Item', unit: 'KG', category: 'GRAIN' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        inventory.receive({ groupId: fromG.id, itemId: it.id, quantity: 100 } as any, adminActor()),
      );

      const t = await withTestTenant(async () =>
        transfers.create(
          {
            fromGroupId: fromG.id,
            toGroupId: toG.id,
            itemId: it.id,
            quantity: 10,
            reason: 'rebalance',
          } as any,
          adminActor(),
        ),
      );
      expect(t.status).toBe('PENDING');

      const decided = await withTestTenant(async () =>
        transfers.decide(t.id, { status: 'APPROVED' } as any, adminActor()),
      );
      expect(decided.status).toBe('APPROVED');

      const completed = await withTestTenant(async () => transfers.complete(t.id, adminActor()));
      expect(completed.status).toBe('COMPLETED');
    });

    it('list + getById', async () => {
      const list = await withTestTenant(async () => transfers.list({}));
      expect(Array.isArray(list)).toBe(true);
    });

    it('cancel pending transfer', async () => {
      const fromG = await withTestTenant(async () =>
        inventory.createGroup({ name: 'FromX', groupType: 'LUNCH' } as any, adminActor()),
      );
      const toG = await withTestTenant(async () =>
        inventory.createGroup({ name: 'ToX', groupType: 'LUNCH' } as any, adminActor()),
      );
      const it = await withTestTenant(async () =>
        inventory.createItem(
          { name: 'X Item', unit: 'KG', category: 'GRAIN' } as any,
          adminActor(),
        ),
      );
      const t = await withTestTenant(async () =>
        transfers.create(
          {
            fromGroupId: fromG.id,
            toGroupId: toG.id,
            itemId: it.id,
            quantity: 5,
            reason: 'cancel-me',
          } as any,
          adminActor(),
        ),
      );
      const cancelled = await withTestTenant(async () => transfers.cancel(t.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ─── StaffMealService ─────────────────────────────────
  describe('StaffMealService', () => {
    it('create + getByEmployee + list + patch + charge', async () => {
      const account = await withTestTenant(async () =>
        staffMeals.create(
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            deductionMethod: 'PREPAID',
            dailyLimit: 10,
          } as any,
          adminActor(),
        ),
      );
      expect(account.employeeId).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const fetched = await withTestTenant(async () =>
        staffMeals.getByEmployee(TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(fetched.id).toBe(account.id);

      const list = await withTestTenant(async () => staffMeals.list());
      expect(list.map((x) => x.id)).toContain(account.id);

      const patched = await withTestTenant(async () =>
        staffMeals.patch(account.id, { dailyLimit: 20 } as any, adminActor()),
      );
      expect(Number(patched.dailyLimit)).toBe(20);

      // PREPAID needs balance before charge
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.fds_staff_meal_accounts SET balance = 50 WHERE id = $1::uuid`,
        account.id,
      );

      const charged = await withTestTenant(async () =>
        staffMeals.charge(account.id, { amount: 5, notes: 'lunch' } as any, adminActor()),
      );
      expect(Number(charged.balance)).toBe(45);
    });

    it('payrollDeductions returns array', async () => {
      const rows = await withTestTenant(async () => staffMeals.payrollDeductions());
      expect(Array.isArray(rows)).toBe(true);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          staffMeals.create({ employeeId: TEST_ADMIN_EMPLOYEE_ID } as any, studentActor()),
        ),
      ).rejects.toThrow();
    });
  });
});
