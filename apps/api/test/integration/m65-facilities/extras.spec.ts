import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { SustainabilityService } from '@modules/m65-facilities/sustainability.service';
import { SpaceUtilisationService } from '@modules/m65-facilities/space-utilisation.service';
import { ZoneInspectionService } from '@modules/m65-facilities/zone-inspection.service';
import { WorkOrderDepthService } from '@modules/m65-facilities/work-order-depth.service';
import { SupplyAuditService } from '@modules/m65-facilities/supply-audit.service';
import { WorkOrderService } from '@modules/m65-facilities/work-orders.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_ZONE_ID,
  TEST_SUPPLY_ID,
} from '../fixtures/facilities';

describe('integration:m65-facilities/extras', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let sustainability: SustainabilityService;
  let utilisation: SpaceUtilisationService;
  let zoneInsp: ZoneInspectionService;
  let workDepth: WorkOrderDepthService;
  let supplyAudit: SupplyAuditService;
  let workOrders: WorkOrderService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();
    sustainability = new SustainabilityService(tenantPrisma, permCheck);
    utilisation = new SpaceUtilisationService(tenantPrisma, permCheck);
    zoneInsp = new ZoneInspectionService(tenantPrisma, outbox, permCheck);
    workDepth = new WorkOrderDepthService(tenantPrisma, permCheck);
    supplyAudit = new SupplyAuditService(tenantPrisma, permCheck);
    workOrders = new WorkOrderService(tenantPrisma, kafka, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFacilitiesTables(rawClient);
    await ensureFacilitiesSeed(rawClient);
  });

  // ─── SustainabilityService ─────────────────────────
  describe('SustainabilityService', () => {
    it('CRUD + dashboard', async () => {
      const init = await withTestTenant(async () =>
        sustainability.create(
          {
            name: 'Solar Panels',
            description: 'Install rooftop solar',
            category: 'ENERGY',
            startDate: '2026-09-01',
            targetCompletionDate: '2027-09-01',
            progressPct: 25,
          } as any,
          adminActor(),
        ),
      );
      expect(init.name).toBe('Solar Panels');

      const list = await withTestTenant(async () => sustainability.list({}));
      expect(list.map((x) => x.id)).toContain(init.id);

      const fetched = await withTestTenant(async () => sustainability.getById(init.id));
      expect(fetched.id).toBe(init.id);

      const patched = await withTestTenant(async () =>
        sustainability.patch(init.id, { progressPct: 50 } as any, adminActor()),
      );
      expect(patched.id).toBe(init.id);

      const dash = await withTestTenant(async () => sustainability.dashboard());
      expect(Array.isArray(dash)).toBe(true);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          sustainability.create(
            { name: 'x', category: 'ENERGY', startDate: '2026-01-01' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── SpaceUtilisationService ───────────────────────
  describe('SpaceUtilisationService', () => {
    it('record + getRecord + listForSpace + underused', async () => {
      const rec = await withTestTenant(async () =>
        utilisation.record(
          {
            spaceId: TEST_SPACE_ID,
            recordDate: '2026-09-15',
            occupancyCount: 25,
            capacity: 30,
            source: 'MANUAL',
          } as any,
          adminActor(),
        ),
      );
      expect(rec.spaceId).toBe(TEST_SPACE_ID);

      const fetched = await withTestTenant(async () => utilisation.getRecord(rec.id));
      expect(fetched.id).toBe(rec.id);

      const list = await withTestTenant(async () =>
        utilisation.listForSpace(TEST_SPACE_ID, {}),
      );
      expect(list.map((x) => x.id)).toContain(rec.id);

      const under = await withTestTenant(async () => utilisation.underused());
      expect(Array.isArray(under)).toBe(true);
    });

    it('non-admin record → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          utilisation.record(
            { spaceId: TEST_SPACE_ID, recordDate: '2026-09-15', occupancyCount: 10, capacity: 30 } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── ZoneInspectionService ─────────────────────────
  describe('ZoneInspectionService', () => {
    it('create + list + getById', async () => {
      const insp = await withTestTenant(async () =>
        zoneInsp.create(
          {
            zoneId: TEST_ZONE_ID,
            inspectionDate: '2026-09-15',
            overallRating: 'PASS',
            notes: 'Routine check',
          } as any,
          adminActor(),
        ),
      );
      expect(insp.overallRating).toBe('PASS');

      const list = await withTestTenant(async () => zoneInsp.list({}));
      expect(list.map((x) => x.id)).toContain(insp.id);

      const fetched = await withTestTenant(async () => zoneInsp.getById(insp.id));
      expect(fetched.id).toBe(insp.id);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          zoneInsp.create(
            { zoneId: TEST_ZONE_ID, inspectionDate: '2026-09-15', overallRating: 'PASS' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  // ─── WorkOrderDepthService ─────────────────────────
  describe('WorkOrderDepthService', () => {
    async function makeWO() {
      return withTestTenant(async () =>
        workOrders.create(
          {
            workOrderType: 'REPAIR',
            priority: 'LOW',
            buildingId: TEST_BUILDING_ID,
            description: 'For depth test',
          } as any,
          adminActor(),
        ),
      );
    }

    it('addAttachment + listAttachments', async () => {
      const wo = await makeWO();
      const att = await withTestTenant(async () =>
        workDepth.addAttachment(
          wo.id,
          { s3Key: 's3://bucket/photo.jpg', filename: 'photo.jpg', attachmentType: 'PHOTO_BEFORE' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => workDepth.listAttachments(wo.id));
      expect(list.map((x) => x.id)).toContain(att.id);
    });

    it('addPart + listParts + getCostSummary', async () => {
      const wo = await makeWO();
      const part = await withTestTenant(async () =>
        workDepth.addPart(
          wo.id,
          { partName: 'Pipe', quantity: 2, unit: 'EA', unitCost: 5 } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => workDepth.listParts(wo.id));
      expect(list.map((x) => x.id)).toContain(part.id);

      const summary = await withTestTenant(async () => workDepth.getCostSummary(wo.id));
      expect(summary).toBeTruthy();
    });
  });

  // ─── SupplyAuditService ────────────────────────────
  describe('SupplyAuditService', () => {
    it('createTransaction + listTransactions', async () => {
      const t = await withTestTenant(async () =>
        supplyAudit.createTransaction(
          {
            buildingId: TEST_BUILDING_ID,
            inventoryId: TEST_SUPPLY_ID,
            transactionType: 'RECEIPT',
            quantityDelta: 10,
            notes: 'received',
          } as any,
          adminActor(),
        ),
      );
      expect(t.transactionType).toBe('RECEIPT');

      const list = await withTestTenant(async () => supplyAudit.listTransactions({}));
      expect(list.map((x) => x.id)).toContain(t.id);
    });

    it('createStocktake + listStocktakes + getStocktakeById + completeStocktake', async () => {
      const st = await withTestTenant(async () =>
        supplyAudit.createStocktake(
          { buildingId: TEST_BUILDING_ID, stocktakeDate: '2026-09-15', notes: 'audit' } as any,
          adminActor(),
        ),
      );
      const stList = await withTestTenant(async () => supplyAudit.listStocktakes({}));
      expect(stList.map((x) => x.id)).toContain(st.id);

      const fetched = await withTestTenant(async () => supplyAudit.getStocktakeById(st.id));
      expect(fetched.id).toBe(st.id);

      const completed = await withTestTenant(async () =>
        supplyAudit.completeStocktake(st.id, adminActor()),
      );
      expect(completed).toBeTruthy();
    });

    it('non-admin createTransaction → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          supplyAudit.createTransaction(
            {
              buildingId: TEST_BUILDING_ID,
              inventoryId: TEST_SUPPLY_ID,
              transactionType: 'RECEIPT',
              quantityDelta: 1,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });
});
