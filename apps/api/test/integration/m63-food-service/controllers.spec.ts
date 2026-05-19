import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { FoodServiceController } from '@modules/m63-food-service/food-service.controller';
import { FoodServiceAdvancedController } from '@modules/m63-food-service/food-service-advanced.controller';
import {
  MenuCycleService,
  MenuItemService,
  DailyMenuService,
} from '@modules/m63-food-service/menu.service';
import {
  PosService,
  SessionService,
  TransactionService,
  ReconciliationService,
} from '@modules/m63-food-service/pos.service';
import {
  DietaryProfileService,
  DietaryUpdateRequestService,
  AllergenAlertService,
  EligibilityService,
  TemperatureLogService,
  ProductionRecordService,
} from '@modules/m63-food-service/dietary-eligibility.service';
import { RecipeService } from '@modules/m63-food-service/recipe.service';
import { InventoryService } from '@modules/m63-food-service/inventory.service';
import { TransferService } from '@modules/m63-food-service/transfer.service';
import { StaffMealService } from '@modules/m63-food-service/staff-meal.service';
import { PreorderService } from '@modules/m63-food-service/preorder.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant } from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
  TEST_MENU_CYCLE_ID,
  TEST_MENU_ITEM_ID,
  TEST_POS_DEVICE_ID,
} from '../fixtures/food-service';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m63-food-service/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: FoodServiceController;
  let advCtl: FoodServiceAdvancedController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const kafka = makeRecordingKafka();
    const outbox = new OutboxService();
    const stubCtx = new StubActorContext() as unknown as ActorContextService;

    const cycles = new MenuCycleService(tenantPrisma);
    const items = new MenuItemService(tenantPrisma);
    const daily = new DailyMenuService(tenantPrisma);
    const pos = new PosService(tenantPrisma);
    const sessions = new SessionService(tenantPrisma);
    const txns = new TransactionService(tenantPrisma, kafka);
    const recon = new ReconciliationService(tenantPrisma);
    const profiles = new DietaryProfileService(tenantPrisma);
    const dietaryUpdates = new DietaryUpdateRequestService(tenantPrisma, profiles);
    const alerts = new AllergenAlertService(tenantPrisma);
    const eligibility = new EligibilityService(tenantPrisma, profiles);
    const tempLogs = new TemperatureLogService(tenantPrisma);
    const production = new ProductionRecordService(tenantPrisma);
    const recipes = new RecipeService(tenantPrisma, permCheck);
    const inventory = new InventoryService(tenantPrisma, outbox, permCheck);
    const transfers = new TransferService(tenantPrisma, permCheck);
    const staffMeals = new StaffMealService(tenantPrisma, permCheck);
    const preorders = new PreorderService(tenantPrisma, permCheck);

    ctl = new FoodServiceController(
      cycles,
      items,
      daily,
      pos,
      sessions,
      txns,
      recon,
      profiles,
      dietaryUpdates,
      alerts,
      eligibility,
      tempLogs,
      production,
      stubCtx,
    );
    advCtl = new FoodServiceAdvancedController(
      recipes,
      inventory,
      transfers,
      staffMeals,
      preorders,
      stubCtx,
    );
    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
  });

  // ─── FoodServiceController endpoints (broad smoke) ─────────
  describe('FoodServiceController', () => {
    it('menu cycles endpoints', async () => {
      const list = await withTestTenant(async () => ctl.listCycles());
      expect(list.length).toBeGreaterThan(0);
      const created = await withTestTenant(async () =>
        ctl.createCycle({ name: 'Ctl Cycle', cycleLengthDays: 7 } as any, req),
      );
      const patched = await withTestTenant(async () =>
        ctl.patchCycle(created.id, { name: 'Renamed Cycle' } as any, req),
      );
      expect(patched.name).toBe('Renamed Cycle');
    });

    it('menu items endpoints', async () => {
      const list = await withTestTenant(async () => ctl.listItems());
      expect(list.length).toBeGreaterThan(0);
      const fetched = await withTestTenant(async () => ctl.getItem(TEST_MENU_ITEM_ID));
      expect(fetched.id).toBe(TEST_MENU_ITEM_ID);
      const allergen = await withTestTenant(async () => ctl.itemsAllergenCheck('peanut'));
      expect(Array.isArray(allergen)).toBe(true);

      const created = await withTestTenant(async () =>
        ctl.createItem(
          { name: 'Ctl Item', category: 'SIDE', allergenCodes: [] } as any,
          req,
        ),
      );
      const patched = await withTestTenant(async () =>
        ctl.patchItem(created.id, { name: 'Renamed Item' } as any, req),
      );
      expect(patched.name).toBe('Renamed Item');
    });

    it('daily menu + generateFromCycle endpoints', async () => {
      const dm = await withTestTenant(async () =>
        ctl.createDailyMenu(
          {
            menuDate: '2026-09-15',
            mealType: 'LUNCH',
            cycleId: TEST_MENU_CYCLE_ID,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () =>
        ctl.listDailyMenus('2026-09-01', '2026-09-30'),
      );
      expect(list.map((d: any) => d.id)).toContain(dm.id);

      const fetched = await withTestTenant(async () => ctl.getDailyMenu('2026-09-15', 'LUNCH'));
      expect(fetched?.id).toBe(dm.id);

      await withTestTenant(async () =>
        ctl.addDailyMenuItem(dm.id, { menuItemId: TEST_MENU_ITEM_ID, quantityPrepared: 100 } as any, req),
      );

      const gen = await withTestTenant(async () =>
        ctl.generateFromCycle(
          {
            cycleId: TEST_MENU_CYCLE_ID,
            startDate: '2026-09-20',
            endDate: '2026-09-21',
            mealType: 'BREAKFAST',
          } as any,
          req,
        ),
      );
      expect(gen).toBeTruthy();
    });

    it('pos + session endpoints', async () => {
      const posList = await withTestTenant(async () => ctl.listPos());
      expect(posList.length).toBeGreaterThan(0);
      const sess = await withTestTenant(async () =>
        ctl.openSession({ serviceDate: '2026-09-15', mealType: 'LUNCH' } as any, req),
      );
      const sessList = await withTestTenant(async () => ctl.listSessions());
      expect(sessList.map((s: any) => s.id)).toContain(sess.id);
      const sessGet = await withTestTenant(async () => ctl.getSession(sess.id));
      expect(sessGet.id).toBe(sess.id);
      const closed = await withTestTenant(async () => ctl.closeSession(sess.id, req));
      expect(closed.closedAt).not.toBeNull();
    });

    it('temp log + production endpoints', async () => {
      const log = await withTestTenant(async () =>
        ctl.createTempLog(
          {
            checkLocation: 'REFRIGERATOR',
            locationName: 'Cooler',
            temperatureCelsius: 4,
            safeRangeMin: 1,
            safeRangeMax: 5,
            isCompliant: true,
          } as any,
          req,
        ),
      );
      expect(log.checkLocation).toBe('REFRIGERATOR');

      const logs = await withTestTenant(async () => ctl.listTempLogs());
      expect(logs.map((x: any) => x.id)).toContain(log.id);

      const noncomp = await withTestTenant(async () => ctl.listNonCompliantTempLogs());
      expect(Array.isArray(noncomp)).toBe(true);

      const prodList = await withTestTenant(async () => ctl.listProductionRecords());
      expect(Array.isArray(prodList)).toBe(true);
    });

    it('usda claim endpoints', async () => {
      const claims = await withTestTenant(async () => ctl.listUsdaClaims());
      expect(Array.isArray(claims)).toBe(true);
    });

    it('reconciliation endpoints (no-op when no session)', async () => {
      const sess = await withTestTenant(async () =>
        ctl.openSession({ serviceDate: '2026-09-20', mealType: 'LUNCH' } as any, req),
      );
      const recon = await withTestTenant(async () =>
        ctl.getReconciliation(sess.id, TEST_POS_DEVICE_ID),
      );
      void recon;
    });
  });

  // ─── FoodServiceAdvancedController ──────────────────────
  describe('FoodServiceAdvancedController', () => {
    it('recipe endpoints', async () => {
      const r = await withTestTenant(async () =>
        advCtl.createRecipe(
          { name: 'Adv Recipe', category: 'SIDE', servingYield: 6 } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listRecipes());
      expect(list.map((x: any) => x.id)).toContain(r.id);
      const fetched = await withTestTenant(async () => advCtl.getRecipe(r.id));
      expect(fetched.id).toBe(r.id);
      const cost = await withTestTenant(async () => advCtl.getRecipeCost(r.id));
      expect(cost).toBeTruthy();
      const scaling = await withTestTenant(async () => advCtl.getRecipeScaling(r.id, 12));
      expect(scaling).toBeTruthy();
      const patched = await withTestTenant(async () =>
        advCtl.patchRecipe(r.id, { servingYield: 10 } as any, req),
      );
      expect(patched.servingYield).toBe(10);
    });

    it('inventory group/item endpoints', async () => {
      const g = await withTestTenant(async () =>
        advCtl.createInventoryGroup(
          { name: 'Adv Group', groupType: 'LUNCH', location: 'Main' } as any,
          req,
        ),
      );
      const groups = await withTestTenant(async () => advCtl.listInventoryGroups());
      expect(groups.map((x: any) => x.id)).toContain(g.id);
      const gPatched = await withTestTenant(async () =>
        advCtl.patchInventoryGroup(g.id, { name: 'Renamed Group' } as any, req),
      );
      expect(gPatched.name).toBe('Renamed Group');

      const item = await withTestTenant(async () =>
        advCtl.createInventoryItem(
          { name: 'Adv Item', unit: 'KG', category: 'GRAIN' } as any,
          req,
        ),
      );
      const items = await withTestTenant(async () => advCtl.listInventoryItems());
      expect(items.map((x: any) => x.id)).toContain(item.id);
      const iPatched = await withTestTenant(async () =>
        advCtl.patchInventoryItem(item.id, { unitCost: 4 } as any, req),
      );
      expect(Number(iPatched.unitCost)).toBe(4);

      // Receive + listLevels + listTransactions
      await withTestTenant(async () =>
        advCtl.receive(
          { groupId: g.id, itemId: item.id, quantity: 50 } as any,
          req,
        ),
      );
      const levels = await withTestTenant(async () => advCtl.listInventoryLevels(g.id));
      expect(levels.length).toBe(1);
      const txns = await withTestTenant(async () => advCtl.listTransactions());
      expect(txns.length).toBeGreaterThan(0);

      // Usage + waste + stocktake
      await withTestTenant(async () =>
        advCtl.usage(
          { groupId: g.id, itemId: item.id, quantity: 5 } as any,
          req,
        ),
      );
      await withTestTenant(async () =>
        advCtl.waste(
          { groupId: g.id, itemId: item.id, quantity: 2, reason: 'spoilage' } as any,
          req,
        ),
      );
      await withTestTenant(async () =>
        advCtl.stocktake(
          { groupId: g.id, itemId: item.id, countedQuantity: 40, notes: 'check' } as any,
          req,
        ),
      );
    });

    it('staff meal endpoints', async () => {
      const sm = await withTestTenant(async () =>
        advCtl.createStaffMeal(
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, deductionMethod: 'PREPAID', dailyLimit: 15 } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listStaffMeals());
      expect(list.map((x: any) => x.id)).toContain(sm.id);
      const byEmp = await withTestTenant(async () =>
        advCtl.getStaffMealByEmployee(TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(byEmp.id).toBe(sm.id);

      const patched = await withTestTenant(async () =>
        advCtl.patchStaffMeal(sm.id, { dailyLimit: 20 } as any, req),
      );
      expect(Number(patched.dailyLimit)).toBe(20);

      const deductions = await withTestTenant(async () => advCtl.payrollDeductions());
      expect(Array.isArray(deductions)).toBe(true);
    });
  });
});
