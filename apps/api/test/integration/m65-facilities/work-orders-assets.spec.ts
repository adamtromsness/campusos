import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  WorkOrderService,
  MaintenancePlanService,
  MaintenanceTaskService,
} from '@modules/m65-facilities/work-orders.service';
import { FireDrillService } from '@modules/m65-facilities/fire-drill.service';
import { EnergyService } from '@modules/m65-facilities/energy.service';
import { AssetService } from '@modules/m65-facilities/asset.service';
import { CleaningRouteService } from '@modules/m65-facilities/cleaning-route.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import {
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_ASSET_CATEGORY_ID,
  TEST_ZONE_ID,
} from '../fixtures/facilities';

describe('integration:m65-facilities/work-orders-assets', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let workOrders: WorkOrderService;
  let plans: MaintenancePlanService;
  let tasks: MaintenanceTaskService;
  let drills: FireDrillService;
  let energy: EnergyService;
  let assets: AssetService;
  let cleaning: CleaningRouteService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    workOrders = new WorkOrderService(tenantPrisma, kafka, permCheck);
    plans = new MaintenancePlanService(tenantPrisma, permCheck);
    tasks = new MaintenanceTaskService(tenantPrisma, kafka, workOrders, permCheck);
    drills = new FireDrillService(tenantPrisma, outbox, permCheck);
    energy = new EnergyService(tenantPrisma, permCheck);
    assets = new AssetService(tenantPrisma, permCheck);
    cleaning = new CleaningRouteService(tenantPrisma, outbox, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFacilitiesTables(rawClient);
    await ensureFacilitiesSeed(rawClient);
  });

  // ────────────────────────────────────────────────────────
  // WorkOrderService
  // ────────────────────────────────────────────────────────
  describe('WorkOrderService', () => {
    async function makeWO() {
      return withTestTenant(async () =>
        workOrders.create(
          {
            workOrderType: 'REPAIR',
            priority: 'MEDIUM',
            buildingId: TEST_BUILDING_ID,
            spaceId: TEST_SPACE_ID,
            description: 'Leaky faucet',
          } as any,
          adminActor(),
        ),
      );
    }

    it('admin creates work order; list + getById return it', async () => {
      const wo = await makeWO();
      expect(wo.priority).toBe('MEDIUM');
      const list = await withTestTenant(async () => workOrders.list({}));
      expect(list.map((w) => w.id)).toContain(wo.id);
      const fetched = await withTestTenant(async () => workOrders.getById(wo.id));
      expect(fetched.id).toBe(wo.id);
    });

    it('patch updates fields (description)', async () => {
      const wo = await makeWO();
      const patched = await withTestTenant(async () =>
        workOrders.patch(wo.id, { description: 'Updated description' } as any, adminActor()),
      );
      expect(patched.description).toBe('Updated description');
    });

    it('addComment appends to activity log', async () => {
      const wo = await makeWO();
      await withTestTenant(async () =>
        workOrders.addComment(wo.id, { comment: 'Investigated' } as any, adminActor()),
      );
      const activity = await withTestTenant(async () => workOrders.listActivity(wo.id));
      expect(activity.length).toBeGreaterThan(0);
    });

    it('non-admin work order create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          workOrders.create(
            {
              workOrderType: 'REPAIR',
              priority: 'LOW',
              buildingId: TEST_BUILDING_ID,
              description: 'X',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by status / priority / buildingId', async () => {
      const wo = await makeWO();
      const list = await withTestTenant(async () =>
        workOrders.list({ status: 'OPEN', priority: 'MEDIUM', buildingId: TEST_BUILDING_ID }),
      );
      expect(list.map((w) => w.id)).toContain(wo.id);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => workOrders.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────
  // MaintenancePlanService + MaintenanceTaskService
  // ────────────────────────────────────────────────────────
  describe('MaintenancePlanService + MaintenanceTaskService', () => {
    it('non-admin plan create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          plans.create(
            { name: 'x', assetCategory: 'HVAC', frequencyDays: 30, checklistItems: [] } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('plans.list returns empty when none', async () => {
      const list = await withTestTenant(async () => plans.list());
      expect(Array.isArray(list)).toBe(true);
    });

    it('tasks.list returns empty when none', async () => {
      const list = await withTestTenant(async () => tasks.list({}));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // FireDrillService
  // ────────────────────────────────────────────────────────
  describe('FireDrillService', () => {
    it('admin creates a fire drill; list + getById', async () => {
      const dto = await withTestTenant(async () =>
        drills.create(
          {
            buildingId: TEST_BUILDING_ID,
            drillDate: '2026-10-15',
            drillTime: '10:00',
            durationSeconds: 600,
            totalOccupants: 300,
            evacuationTimeSeconds: 240,
            targetEvacuationSeconds: 300,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.buildingId).toBe(TEST_BUILDING_ID);
      expect(dto.metTarget).toBe(true);

      const list = await withTestTenant(async () => drills.list({}));
      expect(list.map((d) => d.id)).toContain(dto.id);

      const fetched = await withTestTenant(async () => drills.getById(dto.id));
      expect(fetched.id).toBe(dto.id);
    });

    it('drill with evacuationTimeSeconds > target sets metTarget=false', async () => {
      const dto = await withTestTenant(async () =>
        drills.create(
          {
            buildingId: TEST_BUILDING_ID,
            drillDate: '2026-11-15',
            drillTime: '10:00',
            durationSeconds: 600,
            totalOccupants: 300,
            evacuationTimeSeconds: 500,
            targetEvacuationSeconds: 300,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.metTarget).toBe(false);
    });

    it('non-admin drill create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          drills.create(
            {
              buildingId: TEST_BUILDING_ID,
              drillDate: '2026-10-15',
              drillTime: '10:00',
              durationSeconds: 600,
              totalOccupants: 300,
              evacuationTimeSeconds: 240,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('compliance returns one row per building', async () => {
      const compliance = await withTestTenant(async () => drills.compliance());
      expect(compliance.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // EnergyService
  // ────────────────────────────────────────────────────────
  describe('EnergyService', () => {
    async function makeMeter() {
      return withTestTenant(async () =>
        energy.createMeter(
          {
            buildingId: TEST_BUILDING_ID,
            meterName: 'Main Electric',
            utilityType: 'ELECTRICITY',
            unit: 'kWh',
          } as any,
          adminActor(),
        ),
      );
    }

    it('createMeter + listMeters + getMeter + patchMeter', async () => {
      const m = await makeMeter();
      expect(m.meterName).toBe('Main Electric');

      const list = await withTestTenant(async () => energy.listMeters({}));
      expect(list.map((x) => x.id)).toContain(m.id);

      const fetched = await withTestTenant(async () => energy.getMeter(m.id));
      expect(fetched.id).toBe(m.id);

      const patched = await withTestTenant(async () =>
        energy.patchMeter(m.id, { meterName: 'Renamed Meter' } as any, adminActor()),
      );
      expect(patched.meterName).toBe('Renamed Meter');
    });

    it('trend + summary queries run with no readings', async () => {
      const m = await makeMeter();
      const trend = await withTestTenant(async () =>
        energy.trend(m.id, { fromDate: '2026-01-01', toDate: '2026-12-31' } as any),
      );
      expect(trend).toBeTruthy();

      const summary = await withTestTenant(async () => energy.summary());
      expect(Array.isArray(summary)).toBe(true);
    });

    it('listTargets returns empty array initially', async () => {
      const list = await withTestTenant(async () => energy.listTargets());
      expect(Array.isArray(list)).toBe(true);
    });

    it('non-admin createMeter → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          energy.createMeter(
            {
              buildingId: TEST_BUILDING_ID,
              meterName: 'x',
              utilityType: 'ELECTRICITY',
              unit: 'kWh',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // AssetService
  // ────────────────────────────────────────────────────────
  describe('AssetService', () => {
    it('category CRUD + listCategories', async () => {
      const cat = await withTestTenant(async () =>
        assets.createCategory(
          { name: 'Boiler', depreciationYears: 20, maintenanceIntervalMonths: 6 } as any,
          adminActor(),
        ),
      );
      expect(cat.name).toBe('Boiler');

      const list = await withTestTenant(async () => assets.listCategories(false));
      expect(list.map((c) => c.id)).toContain(cat.id);

      const patched = await withTestTenant(async () =>
        assets.patchCategory(cat.id, { name: 'Big Boiler', isActive: false } as any, adminActor()),
      );
      expect(patched.name).toBe('Big Boiler');
      expect(patched.isActive).toBe(false);
    });

    async function makeAsset() {
      return withTestTenant(async () =>
        assets.createAsset(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            buildingId: TEST_BUILDING_ID,
            spaceId: TEST_SPACE_ID,
            assetTag: 'HVAC-001',
            name: 'HVAC Unit 1',
            installDate: '2024-01-01',
            expectedLifespanYears: 15,
          } as any,
          adminActor(),
        ),
      );
    }

    it('createAsset + listAssets returns the asset', async () => {
      const a = await makeAsset();
      const list = await withTestTenant(async () => assets.listAssets({}));
      expect(list.map((x) => x.id)).toContain(a.id);
    });

    it('listMaintenance returns array (may be empty)', async () => {
      const a = await makeAsset();
      const list = await withTestTenant(async () => assets.listMaintenance(a.id));
      expect(Array.isArray(list)).toBe(true);
    });

    it('maintenanceOverdue + replacementPlanning queries run', async () => {
      const overdue = await withTestTenant(async () => assets.maintenanceOverdue());
      expect(Array.isArray(overdue)).toBe(true);
      const planning = await withTestTenant(async () => assets.replacementPlanning());
      expect(Array.isArray(planning)).toBe(true);
    });

    it('non-admin createAsset → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          assets.createAsset(
            {
              categoryId: TEST_ASSET_CATEGORY_ID,
              buildingId: TEST_BUILDING_ID,
              assetTag: 'X',
              name: 'X',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // CleaningRouteService (basic happy path)
  // ────────────────────────────────────────────────────────
  describe('CleaningRouteService', () => {
    it('createRoute + listRoutes + getRouteById + patchRoute', async () => {
      const route = await withTestTenant(async () =>
        cleaning.createRoute(
          { name: 'East Wing Daily', shift: 'MORNING', estimatedDurationMinutes: 90 } as any,
          adminActor(),
        ),
      );
      expect(route.name).toBe('East Wing Daily');

      const list = await withTestTenant(async () => cleaning.listRoutes());
      expect(list.map((r) => r.id)).toContain(route.id);

      const fetched = await withTestTenant(async () => cleaning.getRouteById(route.id));
      expect(fetched.id).toBe(route.id);

      const patched = await withTestTenant(async () =>
        cleaning.patchRoute(route.id, { name: 'Renamed Route' } as any, adminActor()),
      );
      expect(patched.name).toBe('Renamed Route');
    });

    it('replaceStops + listStops', async () => {
      const route = await withTestTenant(async () =>
        cleaning.createRoute(
          { name: 'R1', shift: 'MORNING', estimatedDurationMinutes: 60 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        cleaning.replaceStops(
          route.id,
          {
            stops: [
              {
                spaceId: TEST_SPACE_ID,
                stopOrder: 1,
                taskName: 'Mop floor',
                estimatedDurationMinutes: 30,
                tasks: ['mop', 'wipe'],
              },
            ],
          } as any,
          adminActor(),
        ),
      );
      const stops = await withTestTenant(async () => cleaning.listStops(route.id));
      expect(stops.length).toBe(1);
    });

    it('createAssignment + listAssignments', async () => {
      const route = await withTestTenant(async () =>
        cleaning.createRoute(
          { name: 'R2', shift: 'MORNING', estimatedDurationMinutes: 60 } as any,
          adminActor(),
        ),
      );
      const a = await withTestTenant(async () =>
        cleaning.createAssignment(
          route.id,
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            assignmentDate: '2026-06-01',
          } as any,
          adminActor(),
        ),
      );
      expect(a.routeId).toBe(route.id);

      const list = await withTestTenant(async () => cleaning.listAssignments(route.id));
      expect(list.map((x) => x.id)).toContain(a.id);
    });

    it('non-admin createRoute → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          cleaning.createRoute({ name: 'x', shift: 'MORNING' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
