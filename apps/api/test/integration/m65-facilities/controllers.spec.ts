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
    advCtl = new FacilitiesAdvancedController(cleaning, zoneInsp, supplyAudit, woDepth, stubCtx);
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
      const spaceList = await withTestTenant(async () => ctl.listSpaceBookings(TEST_SPACE_ID, req));
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
      await withTestTenant(async () => ctl.adjustSupply(ns.id, { currentQuantity: 5 } as any, req));
    });
  });
});
