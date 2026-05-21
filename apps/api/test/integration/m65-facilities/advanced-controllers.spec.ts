import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { FacilitiesAdvancedController } from '@modules/m65-facilities/facilities-advanced.controller';
import { CleaningRouteService } from '@modules/m65-facilities/cleaning-route.service';
import { ZoneInspectionService } from '@modules/m65-facilities/zone-inspection.service';
import { SupplyAuditService } from '@modules/m65-facilities/supply-audit.service';
import { WorkOrderDepthService } from '@modules/m65-facilities/work-order-depth.service';
import { WorkOrderService } from '@modules/m65-facilities/work-orders.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
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
  TEST_ZONE_ID,
  TEST_SUPPLY_ID,
} from '../fixtures/facilities';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m65-facilities/advanced-controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let advCtl: FacilitiesAdvancedController;
  let req: any;
  let workOrders: WorkOrderService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    const stubCtx = new StubActorContext() as unknown as ActorContextService;

    const cleaning = new CleaningRouteService(tenantPrisma, outbox, permCheck);
    const zoneInsp = new ZoneInspectionService(tenantPrisma, outbox, permCheck);
    const supplyAudit = new SupplyAuditService(tenantPrisma, permCheck);
    const woDepth = new WorkOrderDepthService(tenantPrisma, permCheck);
    workOrders = new WorkOrderService(tenantPrisma, kafka, permCheck);

    advCtl = new FacilitiesAdvancedController(cleaning, zoneInsp, supplyAudit, woDepth, stubCtx);

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

  describe('FacilitiesAdvancedController — cleaning routes', () => {
    it('createRoute + listRoutes + getRoute + patchRoute + listStops + listAssignments', async () => {
      const r = await withTestTenant(async () =>
        advCtl.createRoute({ name: 'ACtl Route', shift: 'MORNING' } as any, req),
      );
      const list = await withTestTenant(async () => advCtl.listRoutes(req));
      expect(list.map((x: any) => x.id)).toContain(r.id);
      const fetched = await withTestTenant(async () => advCtl.getRoute(r.id));
      expect(fetched.id).toBe(r.id);
      await withTestTenant(async () =>
        advCtl.patchRoute(r.id, { name: 'Renamed Route' } as any, req),
      );
      const stops = await withTestTenant(async () => advCtl.listStops(r.id));
      expect(Array.isArray(stops)).toBe(true);
      const assignments = await withTestTenant(async () => advCtl.listAssignments(r.id));
      expect(Array.isArray(assignments)).toBe(true);
    });

    it('createAssignment + listCompletions + startCompletion + patchStopCompletion', async () => {
      const r = await withTestTenant(async () =>
        advCtl.createRoute({ name: 'Adv Route 2', shift: 'EVENING' } as any, req),
      );
      // Add a stop so startCompletion has something to track
      await withTestTenant(async () =>
        advCtl.replaceStops(
          r.id,
          {
            stops: [
              {
                spaceId: TEST_SPACE_ID,
                stopOrder: 1,
                taskName: 'Sweep',
                estimatedDurationMinutes: 10,
                tasks: ['sweep'],
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

      const completion = await withTestTenant(async () =>
        advCtl.startCompletion(
          { routeId: r.id, assignmentId: a.id, completionDate: '2026-09-15' } as any,
          req,
        ),
      );

      const list = await withTestTenant(async () =>
        advCtl.listCompletions('2020-01-01', '2030-12-31', r.id),
      );
      expect(list.map((x: any) => x.id)).toContain(completion.id);

      const fetched = await withTestTenant(async () => advCtl.getCompletion(completion.id));
      expect(fetched.id).toBe(completion.id);

      const stops = await withTestTenant(async () => advCtl.listStops(r.id));
      await withTestTenant(async () =>
        advCtl.patchStopCompletion(
          completion.id,
          stops[0]!.id,
          { status: 'COMPLETED', taskNotes: 'done' } as any,
          req,
        ),
      );
    });
  });

  describe('FacilitiesAdvancedController — zone inspections', () => {
    it('createInspection + listInspections + getInspection', async () => {
      const insp = await withTestTenant(async () =>
        advCtl.createInspection(
          {
            zoneId: TEST_ZONE_ID,
            inspectionDate: '2026-09-15',
            overallRating: 'PASS',
            notes: 'controller test',
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listInspections(TEST_ZONE_ID));
      expect(list.map((x: any) => x.id)).toContain(insp.id);
      const fetched = await withTestTenant(async () => advCtl.getInspection(insp.id));
      expect(fetched.id).toBe(insp.id);
    });
  });

  describe('FacilitiesAdvancedController — supply audit', () => {
    it('createSupplyTransaction + listSupplyTransactions + createStocktake + listStocktakes + getStocktake', async () => {
      const t = await withTestTenant(async () =>
        advCtl.createSupplyTransaction(
          {
            buildingId: TEST_BUILDING_ID,
            inventoryId: TEST_SUPPLY_ID,
            transactionType: 'RECEIPT',
            quantityDelta: 25,
          } as any,
          req,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listSupplyTransactions(TEST_SUPPLY_ID));
      expect(list.map((x: any) => x.id)).toContain(t.id);

      const st = await withTestTenant(async () =>
        advCtl.createStocktake(
          { buildingId: TEST_BUILDING_ID, stocktakeDate: '2026-09-15' } as any,
          req,
        ),
      );
      const stList = await withTestTenant(async () => advCtl.listStocktakes(TEST_BUILDING_ID));
      expect(stList.map((x: any) => x.id)).toContain(st.id);
      const stGet = await withTestTenant(async () => advCtl.getStocktake(st.id));
      expect(stGet.id).toBe(st.id);
    });
  });

  describe('FacilitiesAdvancedController — work order depth', () => {
    async function makeWO() {
      return withTestTenant(async () =>
        workOrders.create(
          {
            workOrderType: 'REPAIR',
            priority: 'LOW',
            buildingId: TEST_BUILDING_ID,
            description: 'For depth-controller test',
          } as any,
          adminActor(),
        ),
      );
    }

    it('listAttachments + addAttachment + listParts + addPart + getCostSummary', async () => {
      const wo = await makeWO();
      await withTestTenant(async () =>
        advCtl.addAttachment(
          wo.id,
          {
            s3Key: 's3://bucket/photo.jpg',
            filename: 'photo.jpg',
            attachmentType: 'PHOTO_BEFORE',
          } as any,
          req,
        ),
      );
      const attachments = await withTestTenant(async () => advCtl.listAttachments(wo.id));
      expect(attachments.length).toBe(1);

      await withTestTenant(async () =>
        advCtl.addPart(
          wo.id,
          { partName: 'Bracket', quantity: 1, unit: 'EA', unitCost: 10 } as any,
          req,
        ),
      );
      const parts = await withTestTenant(async () => advCtl.listParts(wo.id));
      expect(parts.length).toBe(1);

      const cost = await withTestTenant(async () => advCtl.getCostSummary(wo.id));
      expect(cost).toBeTruthy();
    });
  });
});
