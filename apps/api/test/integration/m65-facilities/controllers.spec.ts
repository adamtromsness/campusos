import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { FacilitiesController } from '@modules/m65-facilities/facilities.controller';
import { FacilitiesAdvancedController } from '@modules/m65-facilities/facilities-advanced.controller';
import { FacilitiesAssetsController } from '@modules/m65-facilities/facilities-assets.controller';
import {
  BuildingService,
  SpaceService,
  BookingService,
  ClosureService,
} from '@modules/m65-facilities/buildings.service';
import {
  WorkOrderService,
  MaintenancePlanService,
  MaintenanceTaskService,
} from '@modules/m65-facilities/work-orders.service';
import {
  InspectionService,
  ViolationService,
  ZoneService,
  SupplyService,
} from '@modules/m65-facilities/inspections.service';
import { CleaningRouteService } from '@modules/m65-facilities/cleaning-route.service';
import { ZoneInspectionService } from '@modules/m65-facilities/zone-inspection.service';
import { SupplyAuditService } from '@modules/m65-facilities/supply-audit.service';
import { WorkOrderDepthService } from '@modules/m65-facilities/work-order-depth.service';
import { FireDrillService } from '@modules/m65-facilities/fire-drill.service';
import { AssetService } from '@modules/m65-facilities/asset.service';
import { EnergyService } from '@modules/m65-facilities/energy.service';
import { SpaceUtilisationService } from '@modules/m65-facilities/space-utilisation.service';
import { SustainabilityService } from '@modules/m65-facilities/sustainability.service';
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
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_INSPECTION_TYPE_ID,
  TEST_ZONE_ID,
  TEST_SUPPLY_ID,
  TEST_ASSET_CATEGORY_ID,
} from '../fixtures/facilities';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m65-facilities/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: FacilitiesController;
  let advCtl: FacilitiesAdvancedController;
  let assetsCtl: FacilitiesAssetsController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    const stubCtx = new StubActorContext() as unknown as ActorContextService;

    const buildings = new BuildingService(tenantPrisma, permCheck);
    const spaces = new SpaceService(tenantPrisma, permCheck);
    const bookings = new BookingService(tenantPrisma, permCheck);
    const closures = new ClosureService(tenantPrisma, permCheck);
    const workOrders = new WorkOrderService(tenantPrisma, kafka, permCheck);
    const plans = new MaintenancePlanService(tenantPrisma, permCheck);
    const tasks = new MaintenanceTaskService(tenantPrisma, kafka, workOrders, permCheck);
    const inspections = new InspectionService(tenantPrisma, kafka, permCheck);
    const violations = new ViolationService(tenantPrisma, kafka, permCheck);
    const zones = new ZoneService(tenantPrisma, permCheck);
    const supply = new SupplyService(tenantPrisma, kafka, permCheck);
    const cleaning = new CleaningRouteService(tenantPrisma, outbox, permCheck);
    const zoneInsp = new ZoneInspectionService(tenantPrisma, outbox, permCheck);
    const supplyAudit = new SupplyAuditService(tenantPrisma, permCheck);
    const woDepth = new WorkOrderDepthService(tenantPrisma, permCheck);
    const drills = new FireDrillService(tenantPrisma, outbox, permCheck);
    const assets = new AssetService(tenantPrisma, permCheck);
    const energy = new EnergyService(tenantPrisma, permCheck);
    const utilisation = new SpaceUtilisationService(tenantPrisma, permCheck);
    const sustainability = new SustainabilityService(tenantPrisma, permCheck);

    ctl = new FacilitiesController(
      buildings,
      spaces,
      bookings,
      closures,
      workOrders,
      plans,
      tasks,
      inspections,
      violations,
      zones,
      supply,
      stubCtx,
    );
    advCtl = new FacilitiesAdvancedController(
      cleaning,
      zoneInsp,
      supplyAudit,
      woDepth,
      stubCtx,
    );
    assetsCtl = new FacilitiesAssetsController(
      drills,
      assets,
      energy,
      utilisation,
      sustainability,
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
    await resetFacilitiesTables(rawClient);
    await ensureFacilitiesSeed(rawClient);
  });

  // ─── FacilitiesController ─────────────────────────
  describe('FacilitiesController', () => {
    it('buildings + spaces + bookings + closures endpoints', async () => {
      const buildings = await withTestTenant(async () => ctl.listBuildings());
      expect(buildings.length).toBeGreaterThan(0);
      const b = await withTestTenant(async () => ctl.getBuilding(TEST_BUILDING_ID));
      expect(b.id).toBe(TEST_BUILDING_ID);

      const newB = await withTestTenant(async () =>
        ctl.createBuilding({ name: 'Test Bldg' } as any, req),
      );
      const patchedB = await withTestTenant(async () =>
        ctl.patchBuilding(newB.id, { code: 'NEW' } as any, req),
      );
      expect(patchedB.code).toBe('NEW');

      const spaces = await withTestTenant(async () => ctl.listSpaces(TEST_BUILDING_ID));
      expect(Array.isArray(spaces)).toBe(true);
      const sp = await withTestTenant(async () => ctl.getSpace(TEST_SPACE_ID));
      expect(sp.id).toBe(TEST_SPACE_ID);
      const newSp = await withTestTenant(async () =>
        ctl.createSpace(TEST_BUILDING_ID, { name: 'Room X', spaceType: 'CLASSROOM' } as any, req),
      );
      await withTestTenant(async () => ctl.patchSpace(newSp.id, { floor: '2' } as any, req));

      const bk = await withTestTenant(async () =>
        ctl.createBooking(
          TEST_SPACE_ID,
          {
            title: 'meeting',
            startsAt: '2026-11-01T10:00:00Z',
            endsAt: '2026-11-01T11:00:00Z',
          } as any,
          req,
        ),
      );
      const myList = await withTestTenant(async () => ctl.listMyBookings(req));
      expect(myList.map((x: any) => x.id)).toContain(bk.id);
      const spaceList = await withTestTenant(async () =>
        ctl.listSpaceBookings(TEST_SPACE_ID, req),
      );
      expect(spaceList.length).toBeGreaterThan(0);
      await withTestTenant(async () =>
        ctl.patchBooking(bk.id, { status: 'CANCELLED' } as any, req),
      );

      const cl = await withTestTenant(async () =>
        ctl.createClosure(
          {
            spaceId: TEST_SPACE_ID,
            closureReason: 'Maintenance',
            startsAt: '2026-12-15T00:00:00Z',
          } as any,
          req,
        ),
      );
      const closures = await withTestTenant(async () => ctl.listClosures());
      expect(closures.map((c: any) => c.id)).toContain(cl.id);
      await withTestTenant(async () =>
        ctl.patchClosure(cl.id, { closureReason: 'Updated' } as any, req),
      );
    });

    it('inspections + violations + zones + supply endpoints', async () => {
      const types = await withTestTenant(async () => ctl.listInspectionTypes());
      expect(types.length).toBeGreaterThan(0);
      const ntype = await withTestTenant(async () =>
        ctl.createInspectionType(
          { name: 'New Inspection', authority: 'County', frequencyMonths: 6 } as any,
          req,
        ),
      );
      expect(ntype.name).toBe('New Inspection');

      const insp = await withTestTenant(async () =>
        ctl.createInspection(
          {
            inspectionTypeId: TEST_INSPECTION_TYPE_ID,
            buildingId: TEST_BUILDING_ID,
            scheduledDate: '2027-01-01',
            outcome: 'PENDING',
          } as any,
          req,
        ),
      );
      const inspList = await withTestTenant(async () => ctl.listInspections());
      expect(inspList.map((x: any) => x.id)).toContain(insp.id);
      const inspGot = await withTestTenant(async () => ctl.getInspection(insp.id));
      expect(inspGot.id).toBe(insp.id);

      // Violation
      const v = await withTestTenant(async () =>
        ctl.createViolation(
          insp.id,
          { description: 'V', severity: 'MINOR', dueDate: '2027-02-01' } as any,
          req,
        ),
      );
      const vList = await withTestTenant(async () => ctl.listInspectionViolations(insp.id));
      expect(vList.map((x: any) => x.id)).toContain(v.id);
      const vActive = await withTestTenant(async () => ctl.listActiveViolations());
      expect(Array.isArray(vActive)).toBe(true);
      await withTestTenant(async () =>
        ctl.resolveViolation(v.id, { resolutionNotes: 'Fixed' } as any, req),
      );

      // Zone
      const zones = await withTestTenant(async () => ctl.listZones());
      expect(zones.map((z: any) => z.id)).toContain(TEST_ZONE_ID);
      const nz = await withTestTenant(async () =>
        ctl.createZone({ name: 'West Wing Ctrl' } as any, req),
      );
      const za = await withTestTenant(async () =>
        ctl.createZoneAssignment(
          nz.id,
          {
            employeeId: TEST_ADMIN_EMPLOYEE_ID,
            effectiveFrom: '2026-09-01',
            shift: 'MORNING',
          } as any,
          req,
        ),
      );
      await withTestTenant(async () =>
        ctl.patchZoneAssignment(za.id, { effectiveTo: '2027-09-01' } as any, req),
      );

      // Supply
      const supplies = await withTestTenant(async () => ctl.listBuildingSupply(TEST_BUILDING_ID));
      expect(supplies.map((s: any) => s.id)).toContain(TEST_SUPPLY_ID);
      const ns = await withTestTenant(async () =>
        ctl.createSupply(
          {
            buildingId: TEST_BUILDING_ID,
            itemName: 'Cleaning Spray',
            unit: 'EA',
            currentQuantity: 10,
          } as any,
          req,
        ),
      );
      await withTestTenant(async () =>
        ctl.adjustSupply(ns.id, { currentQuantity: 5 } as any, req),
      );
    });

    it.skip('work orders + plans + tasks endpoints', async () => {
      const woList = await withTestTenant(async () => ctl.listWorkOrders());
      expect(Array.isArray(woList)).toBe(true);

      const wo = await withTestTenant(async () =>
        ctl.createWorkOrder(
          {
            workOrderType: 'REPAIR',
            priority: 'LOW',
            buildingId: TEST_BUILDING_ID,
            description: 'Ctl WO',
          } as any,
          req,
        ),
      );
      const woGot = await withTestTenant(async () => ctl.getWorkOrder(wo.id));
      expect(woGot.id).toBe(wo.id);
      const woAct = await withTestTenant(async () => ctl.listWorkOrderActivity(wo.id));
      expect(Array.isArray(woAct)).toBe(true);
      await withTestTenant(async () =>
        ctl.patchWorkOrder(wo.id, { description: 'Updated' } as any, req),
      );
      await withTestTenant(async () =>
        ctl.commentWorkOrder(wo.id, { comment: 'Investigated' } as any, req),
      );

      // Plans
      const plan = await withTestTenant(async () =>
        ctl.createPmPlan(
          {
            name: 'Plan A',
            assetCategory: 'HVAC',
            frequencyDays: 30,
            checklistItems: [{ itemText: 'Check', sortOrder: 0 }],
          } as any,
          req,
        ),
      );
      const planList = await withTestTenant(async () => ctl.listPmPlans());
      expect(planList.map((p: any) => p.id)).toContain(plan.id);
      const planGet = await withTestTenant(async () => ctl.getPmPlan(plan.id));
      expect(planGet.id).toBe(plan.id);
      await withTestTenant(async () =>
        ctl.patchPmPlan(plan.id, { name: 'Plan A v2' } as any, req),
      );

      const gen = await withTestTenant(async () =>
        ctl.generatePmTasks(plan.id, { count: 1 } as any, req),
      );
      expect(gen.length).toBe(1);
      const taskList = await withTestTenant(async () => ctl.listPmTasks());
      expect(taskList.length).toBeGreaterThan(0);
      const taskGet = await withTestTenant(async () => ctl.getPmTask(taskList[0]!.id));
      expect(taskGet.id).toBe(taskList[0]!.id);
    });
  });

  // ─── FacilitiesAdvancedController ─────────────────
  describe.skip('FacilitiesAdvancedController', () => {
    it('cleaning routes endpoints', async () => {
      const r = await withTestTenant(async () =>
        advCtl.createRoute({ name: 'Ctrl Route', shift: 'MORNING' } as any, req),
      );
      const list = await withTestTenant(async () => advCtl.listRoutes(req));
      expect(list.map((x: any) => x.id)).toContain(r.id);
      const fetched = await withTestTenant(async () => advCtl.getRoute(r.id));
      expect(fetched.id).toBe(r.id);
      await withTestTenant(async () =>
        advCtl.patchRoute(r.id, { name: 'Renamed' } as any, req),
      );

      const stops = await withTestTenant(async () => advCtl.listStops(r.id));
      expect(Array.isArray(stops)).toBe(true);
      await withTestTenant(async () =>
        advCtl.replaceStops(
          r.id,
          {
            stops: [
              {
                spaceId: TEST_SPACE_ID,
                stopOrder: 1,
                taskName: 'Mop',
                estimatedDurationMinutes: 10,
                tasks: ['mop'],
              },
            ],
          } as any,
          req,
        ),
      );

      const a = await withTestTenant(async () =>
        advCtl.createAssignment(
          r.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, assignmentDate: '2026-09-15' } as any,
          req,
        ),
      );
      const assignList = await withTestTenant(async () =>
        advCtl.listAssignments(r.id),
      );
      expect(assignList.map((x: any) => x.id)).toContain(a.id);

      const compList = await withTestTenant(async () => advCtl.listCompletions(req));
      expect(Array.isArray(compList)).toBe(true);
    });

    it('zone inspections endpoints', async () => {
      const insp = await withTestTenant(async () =>
        advCtl.createInspection(
          { zoneId: TEST_ZONE_ID, inspectionDate: '2026-09-15', overallRating: 'PASS' } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listInspections({}));
      expect(list.map((x: any) => x.id)).toContain(insp.id);
      const fetched = await withTestTenant(async () => advCtl.getInspection(insp.id));
      expect(fetched.id).toBe(insp.id);
    });

    it('supply audit endpoints', async () => {
      const t = await withTestTenant(async () =>
        advCtl.createSupplyTransaction(
          {
            buildingId: TEST_BUILDING_ID,
            inventoryId: TEST_SUPPLY_ID,
            transactionType: 'RECEIPT',
            quantityDelta: 5,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listSupplyTransactions({}));
      expect(list.map((x: any) => x.id)).toContain(t.id);

      const st = await withTestTenant(async () =>
        advCtl.createStocktake(
          { buildingId: TEST_BUILDING_ID, stocktakeDate: '2026-09-15' } as any,
          req,
        ),
      );
      const stList = await withTestTenant(async () => advCtl.listStocktakes({}));
      expect(stList.map((x: any) => x.id)).toContain(st.id);
      const stGet = await withTestTenant(async () => advCtl.getStocktake(st.id));
      expect(stGet.id).toBe(st.id);
    });
  });

  // ─── FacilitiesAssetsController ─────────────────
  describe.skip('FacilitiesAssetsController', () => {
    it('fire drill endpoints', async () => {
      const drill = await withTestTenant(async () =>
        assetsCtl.createDrill(
          {
            buildingId: TEST_BUILDING_ID,
            drillDate: '2026-10-15',
            drillTime: '10:00',
            durationSeconds: 600,
            totalOccupants: 300,
            evacuationTimeSeconds: 240,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => assetsCtl.listDrills({}));
      expect(list.map((x: any) => x.id)).toContain(drill.id);
      const fetched = await withTestTenant(async () => assetsCtl.getDrill(drill.id));
      expect(fetched.id).toBe(drill.id);
      const comp = await withTestTenant(async () => assetsCtl.drillCompliance());
      expect(Array.isArray(comp)).toBe(true);
    });

    it('asset category + asset endpoints', async () => {
      const list = await withTestTenant(async () => assetsCtl.listAssetCategories(false));
      expect(list.map((c: any) => c.id)).toContain(TEST_ASSET_CATEGORY_ID);
      const cat = await withTestTenant(async () =>
        assetsCtl.createAssetCategory({ name: 'Boiler', depreciationYears: 20 } as any, req),
      );
      await withTestTenant(async () =>
        assetsCtl.patchAssetCategory(cat.id, { name: 'Big Boiler' } as any, req),
      );

      const a = await withTestTenant(async () =>
        assetsCtl.createAsset(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            buildingId: TEST_BUILDING_ID,
            assetTag: 'CTL-001',
            name: 'Ctrl Asset',
          } as any,
          req,
        ),
      );
      const assetList = await withTestTenant(async () => assetsCtl.listAssets({}));
      expect(assetList.map((x: any) => x.id)).toContain(a.id);
      const assetGet = await withTestTenant(async () => assetsCtl.getAsset(a.id));
      expect(assetGet.id).toBe(a.id);
      await withTestTenant(async () =>
        assetsCtl.patchAsset(a.id, { name: 'Renamed Asset' } as any, req),
      );

      const overdue = await withTestTenant(async () => assetsCtl.maintenanceOverdue());
      expect(Array.isArray(overdue)).toBe(true);
      const planning = await withTestTenant(async () => assetsCtl.replacementPlanning());
      expect(Array.isArray(planning)).toBe(true);

      const maint = await withTestTenant(async () => assetsCtl.listMaintenance(a.id));
      expect(Array.isArray(maint)).toBe(true);
    });

    it('energy endpoints', async () => {
      const meter = await withTestTenant(async () =>
        assetsCtl.createMeter(
          {
            buildingId: TEST_BUILDING_ID,
            meterName: 'Main Electric',
            utilityType: 'ELECTRICITY',
            unit: 'kWh',
          } as any,
          req,
        ),
      );
      const meters = await withTestTenant(async () => assetsCtl.listMeters({}));
      expect(meters.map((m: any) => m.id)).toContain(meter.id);
      await withTestTenant(async () =>
        assetsCtl.patchMeter(meter.id, { meterName: 'Renamed Meter' } as any, req),
      );

      const trend = await withTestTenant(async () =>
        assetsCtl.energyTrend(meter.id, '2026-01-01', '2026-12-31'),
      );
      void trend;
      const summary = await withTestTenant(async () => assetsCtl.energySummary());
      expect(Array.isArray(summary)).toBe(true);

      const targets = await withTestTenant(async () => assetsCtl.listTargets());
      expect(Array.isArray(targets)).toBe(true);
      const t = await withTestTenant(async () =>
        assetsCtl.createTarget(
          {
            meterId: meter.id,
            periodStart: '2026-01-01',
            periodEnd: '2026-12-31',
            targetQuantity: 18000,
          } as any,
          req,
        ),
      );
      expect(t.meterId).toBe(meter.id);
    });
  });
});
