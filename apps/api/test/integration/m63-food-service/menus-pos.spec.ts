import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

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
  AllergenAlertService,
  TemperatureLogService,
  ProductionRecordService,
} from '@modules/m63-food-service/dietary-eligibility.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import {
  resetFoodServiceTables,
  ensureFoodServiceSeed,
  TEST_MENU_ITEM_ID,
  TEST_POS_DEVICE_ID,
} from '../fixtures/food-service';

describe('integration:m63-food-service/menus-pos', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let cycles: MenuCycleService;
  let items: MenuItemService;
  let daily: DailyMenuService;
  let pos: PosService;
  let sessions: SessionService;
  let txs: TransactionService;
  let recon: ReconciliationService;
  let dietary: DietaryProfileService;
  let allergens: AllergenAlertService;
  let temps: TemperatureLogService;
  let prod: ProductionRecordService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const kafka = makeRecordingKafka();
    cycles = new MenuCycleService(tenantPrisma);
    items = new MenuItemService(tenantPrisma);
    daily = new DailyMenuService(tenantPrisma);
    pos = new PosService(tenantPrisma);
    sessions = new SessionService(tenantPrisma);
    txs = new TransactionService(tenantPrisma, kafka);
    recon = new ReconciliationService(tenantPrisma);
    dietary = new DietaryProfileService(tenantPrisma);
    allergens = new AllergenAlertService(tenantPrisma);
    temps = new TemperatureLogService(tenantPrisma);
    prod = new ProductionRecordService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFoodServiceTables(rawClient);
    await ensureFoodServiceSeed(rawClient);
  });

  // ────────────────────────────────────────────────────────
  // MenuCycleService
  // ────────────────────────────────────────────────────────
  describe('MenuCycleService', () => {
    it('list returns school cycles', async () => {
      const list = await withTestTenant(async () => cycles.list());
      expect(list.length).toBeGreaterThan(0);
    });

    it('admin creates a cycle', async () => {
      const dto = await withTestTenant(async () =>
        cycles.create({ name: 'New 2-week', cycleLengthDays: 14 } as any, adminActor()),
      );
      expect(dto.name).toBe('New 2-week');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          cycles.create({ name: 'x', cycleLengthDays: 7 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // MenuItemService
  // ────────────────────────────────────────────────────────
  describe('MenuItemService', () => {
    it('list returns school items', async () => {
      const list = await withTestTenant(async () => items.list({}));
      expect(list.map((i) => i.id)).toContain(TEST_MENU_ITEM_ID);
    });

    it('admin creates item; getById returns', async () => {
      const dto = await withTestTenant(async () =>
        items.create({ name: 'Banana', category: 'SIDE', allergenCodes: [] } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () => items.getById(dto.id));
      expect(fetched.name).toBe('Banana');
    });

    it('allergenCheck filters by code', async () => {
      const list = await withTestTenant(async () => items.allergenCheck(['peanut']));
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((i) => i.allergenCodes.includes('peanut'))).toBe(true);
    });

    it('patch updates fields', async () => {
      const updated = await withTestTenant(async () =>
        items.patch(TEST_MENU_ITEM_ID, { name: 'Renamed' } as any, adminActor()),
      );
      expect(updated.name).toBe('Renamed');
    });
  });

  // ────────────────────────────────────────────────────────
  // PosService + SessionService + TransactionService
  // ────────────────────────────────────────────────────────
  describe('PosService', () => {
    it('list returns devices in school', async () => {
      const list = await withTestTenant(async () => pos.list());
      expect(list.map((d) => d.id)).toContain(TEST_POS_DEVICE_ID);
    });

    it('create + patch device', async () => {
      const d = await withTestTenant(async () =>
        pos.create({ deviceName: 'New Kiosk', deviceType: 'CASHIER_STAFFED' } as any, adminActor()),
      );
      expect(d.deviceName).toBe('New Kiosk');

      const patched = await withTestTenant(async () =>
        pos.patch(d.id, { deviceName: 'Renamed Kiosk' } as any, adminActor()),
      );
      expect(patched.deviceName).toBe('Renamed Kiosk');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          pos.create({ deviceName: 'x', deviceType: 'CASHIER_STAFFED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('SessionService', () => {
    it('open + close session lifecycle', async () => {
      const opened = await withTestTenant(async () =>
        sessions.open({ serviceDate: '2026-06-01', mealType: 'LUNCH' } as any, adminActor()),
      );
      expect(opened.closedAt).toBeNull();

      const list = await withTestTenant(async () => sessions.list({}));
      expect(list.map((s) => s.id)).toContain(opened.id);

      const fetched = await withTestTenant(async () => sessions.getById(opened.id));
      expect(fetched.id).toBe(opened.id);

      const closed = await withTestTenant(async () => sessions.close(opened.id, adminActor()));
      expect(closed.closedAt).not.toBeNull();
    });

    it('non-admin open → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.open({ serviceDate: '2026-06-01', mealType: 'LUNCH' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
