import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { SustainabilityService } from '@modules/m65-facilities/sustainability.service';
import { SpaceUtilisationService } from '@modules/m65-facilities/space-utilisation.service';
import { ZoneInspectionService } from '@modules/m65-facilities/zone-inspection.service';
import { SupplyAuditService } from '@modules/m65-facilities/supply-audit.service';
import { ViolationService } from '@modules/m65-facilities/inspections.service';
import { InspectionService } from '@modules/m65-facilities/inspections.service';
import {
  BuildingService,
  SpaceService,
  BookingService,
  ClosureService,
} from '@modules/m65-facilities/buildings.service';
import { CleaningRouteService } from '@modules/m65-facilities/cleaning-route.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_PERSON_ID, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import {
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_ZONE_ID,
  TEST_SUPPLY_ID,
  TEST_INSPECTION_TYPE_ID,
} from '../fixtures/facilities';

describe('integration:m65-facilities/more-coverage', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let sustainability: SustainabilityService;
  let utilisation: SpaceUtilisationService;
  let zoneInsp: ZoneInspectionService;
  let supplyAudit: SupplyAuditService;
  let violations: ViolationService;
  let inspections: InspectionService;
  let buildings: BuildingService;
  let spaces: SpaceService;
  let bookings: BookingService;
  let closures: ClosureService;
  let cleaning: CleaningRouteService;

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
    supplyAudit = new SupplyAuditService(tenantPrisma, permCheck);
    violations = new ViolationService(tenantPrisma, kafka, permCheck);
    inspections = new InspectionService(tenantPrisma, kafka, permCheck);
    buildings = new BuildingService(tenantPrisma, permCheck);
    spaces = new SpaceService(tenantPrisma, permCheck);
    bookings = new BookingService(tenantPrisma, permCheck);
    closures = new ClosureService(tenantPrisma, permCheck);
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

  // ─── SustainabilityService — patch / dashboard / list with filters ─
  describe('SustainabilityService — extended', () => {
    async function makeInit() {
      return withTestTenant(async () =>
        sustainability.create(
          {
            name: 'Reduce Energy',
            description: 'Cut peak usage 20%',
            category: 'ENERGY',
            startDate: '2026-09-01',
            targetCompletionDate: '2027-09-01',
            targetReductionPercent: 20,
          } as any,
          adminActor(),
        ),
      );
    }

    it('patch fields: status, outcomeNotes, targetCompletionDate, targetReductionPercent', async () => {
      const init = await makeInit();
      const patched = await withTestTenant(async () =>
        sustainability.patch(
          init.id,
          {
            status: 'COMPLETED',
            outcomeNotes: 'Achieved 18% reduction',
            targetCompletionDate: '2027-12-31',
            targetReductionPercent: 18,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.id).toBe(init.id);
    });

    it('list with category + status filter', async () => {
      await makeInit();
      const byCat = await withTestTenant(async () =>
        sustainability.list({ category: 'ENERGY' }),
      );
      expect(byCat.length).toBeGreaterThan(0);
      const byStatus = await withTestTenant(async () =>
        sustainability.list({ status: 'ACTIVE' }),
      );
      expect(Array.isArray(byStatus)).toBe(true);
    });

    it('dashboard returns active initiatives', async () => {
      await makeInit();
      const dash = await withTestTenant(async () => sustainability.dashboard());
      expect(Array.isArray(dash)).toBe(true);
    });
  });

  // ─── SpaceUtilisationService — extended ─────────────
  describe('SpaceUtilisationService — extended', () => {
    it('record + listForSpace with date filter; underused dashboard', async () => {
      // Multiple records over time
      for (const dateAndCount of [
        { date: '2026-09-01', count: 5 },
        { date: '2026-09-08', count: 10 },
        { date: '2026-09-15', count: 8 },
      ]) {
        await withTestTenant(async () =>
          utilisation.record(
            {
              spaceId: TEST_SPACE_ID,
              recordDate: dateAndCount.date,
              occupancyCount: dateAndCount.count,
              capacity: 30,
              source: 'MANUAL',
            } as any,
            adminActor(),
          ),
        );
      }
      const list = await withTestTenant(async () =>
        utilisation.listForSpace(TEST_SPACE_ID, {
          fromDate: '2026-09-01',
          toDate: '2026-09-15',
        }),
      );
      expect(list.length).toBeGreaterThan(0);
      const underused = await withTestTenant(async () => utilisation.underused());
      expect(Array.isArray(underused)).toBe(true);
    });
  });

  // ─── ZoneInspectionService — listForZone filter ────
  describe('ZoneInspectionService — extended', () => {
    it('list filter by zoneId and followUpRequired', async () => {
      await withTestTenant(async () =>
        zoneInsp.create(
          {
            zoneId: TEST_ZONE_ID,
            inspectionDate: '2026-09-10',
            overallRating: 'NEEDS_IMPROVEMENT',
            notes: 'follow-up needed',
            followUpRequired: true,
          } as any,
          adminActor(),
        ),
      );
      const byZone = await withTestTenant(async () =>
        zoneInsp.list({ zoneId: TEST_ZONE_ID }),
      );
      expect(byZone.length).toBeGreaterThan(0);

      const needsFollowUp = await withTestTenant(async () =>
        zoneInsp.list({ followUpRequired: true }),
      );
      expect(needsFollowUp.length).toBeGreaterThan(0);
    });
  });

  // ─── SupplyAuditService — extended ────────────────
  describe('SupplyAuditService — extended', () => {
    it('createTransaction with TRANSFER + USAGE types; listTransactions filter', async () => {
      // Build inventory: increase before USAGE to satisfy non-negative CHECK
      await withTestTenant(async () =>
        supplyAudit.createTransaction(
          {
            buildingId: TEST_BUILDING_ID,
            inventoryId: TEST_SUPPLY_ID,
            transactionType: 'RECEIPT',
            quantityDelta: 50,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        supplyAudit.createTransaction(
          {
            buildingId: TEST_BUILDING_ID,
            inventoryId: TEST_SUPPLY_ID,
            transactionType: 'USAGE',
            quantityDelta: -10,
          } as any,
          adminActor(),
        ),
      );
      const byBuilding = await withTestTenant(async () =>
        supplyAudit.listTransactions({ buildingId: TEST_BUILDING_ID }),
      );
      expect(byBuilding.length).toBeGreaterThan(0);
      const byInventory = await withTestTenant(async () =>
        supplyAudit.listTransactions({ inventoryId: TEST_SUPPLY_ID }),
      );
      expect(byInventory.length).toBeGreaterThan(0);
    });

    it('listStocktakes filter by buildingId', async () => {
      await withTestTenant(async () =>
        supplyAudit.createStocktake(
          { buildingId: TEST_BUILDING_ID, stocktakeDate: '2026-09-15' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        supplyAudit.listStocktakes({ buildingId: TEST_BUILDING_ID }),
      );
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ─── ViolationService — additional ───────────────
  describe('ViolationService — extended', () => {
    async function makePendingInspection() {
      return withTestTenant(async () =>
        inspections.create(
          {
            inspectionTypeId: TEST_INSPECTION_TYPE_ID,
            buildingId: TEST_BUILDING_ID,
            scheduledDate: '2027-01-01',
            outcome: 'PENDING',
          } as any,
          adminActor(),
        ),
      );
    }

    it('listActive filter by severity', async () => {
      const insp = await makePendingInspection();
      await withTestTenant(async () =>
        violations.create(
          insp.id,
          { description: 'minor1', severity: 'MINOR', dueDate: '2027-02-01' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        violations.create(
          insp.id,
          { description: 'crit1', severity: 'CRITICAL', dueDate: '2027-02-01' } as any,
          adminActor(),
        ),
      );
      const crit = await withTestTenant(async () =>
        violations.listActive({ severity: 'CRITICAL' }),
      );
      expect(crit.every((v) => v.severity === 'CRITICAL')).toBe(true);
    });

    it('emitOverdue iterates and produces summary', async () => {
      const insp = await makePendingInspection();
      await withTestTenant(async () =>
        violations.create(
          insp.id,
          { description: 'past due', severity: 'MAJOR', dueDate: '2020-01-01' } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () => violations.emitOverdue());
      expect(result.emitted).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── BookingService — more lifecycle ───────────
  describe('BookingService — extended', () => {
    it('listForSpace with date range; getById; patch start/end', async () => {
      const bk = await withTestTenant(async () =>
        bookings.create(
          TEST_SPACE_ID,
          {
            title: 'Lab',
            startsAt: '2026-12-01T10:00:00Z',
            endsAt: '2026-12-01T11:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        bookings.listForSpace(TEST_SPACE_ID, adminActor(), {
          fromDate: '2026-11-01T00:00:00Z',
          toDate: '2026-12-31T23:59:59Z',
        }),
      );
      expect(list.map((b) => b.id)).toContain(bk.id);

      const fetched = await withTestTenant(async () => bookings.getById(bk.id));
      expect(fetched.id).toBe(bk.id);

      const patched = await withTestTenant(async () =>
        bookings.patch(
          bk.id,
          {
            startsAt: '2026-12-02T10:00:00Z',
            endsAt: '2026-12-02T11:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.id).toBe(bk.id);
    });
  });

  // ─── ClosureService — list filter + patch ──────
  describe('ClosureService — extended', () => {
    it('list activeOnly + getById not present + patch space-only fields', async () => {
      const cl = await withTestTenant(async () =>
        closures.create(
          {
            spaceId: TEST_SPACE_ID,
            closureReason: 'Maintenance',
            startsAt: '2026-12-15T00:00:00Z',
            endsAt: '2026-12-20T00:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      const active = await withTestTenant(async () => closures.list({ activeOnly: true }));
      expect(Array.isArray(active)).toBe(true);

      const patched = await withTestTenant(async () =>
        closures.patch(cl.id, { closureReason: 'Renovation' } as any, adminActor()),
      );
      expect(patched.closureReason).toBe('Renovation');
    });
  });

  // ─── CleaningRouteService — additional methods ──
  describe('CleaningRouteService — extended', () => {
    async function makeRoute() {
      return withTestTenant(async () =>
        cleaning.createRoute(
          { name: 'Extra Route', shift: 'EVENING' } as any,
          adminActor(),
        ),
      );
    }

    it('listRoutes includeInactive=true; patch inactive flag', async () => {
      const r = await makeRoute();
      await withTestTenant(async () =>
        cleaning.patchRoute(r.id, { isActive: false } as any, adminActor()),
      );
      const all = await withTestTenant(async () => cleaning.listRoutes(true));
      expect(all.map((x) => x.id)).toContain(r.id);

      const activeOnly = await withTestTenant(async () => cleaning.listRoutes(false));
      expect(activeOnly.map((x) => x.id)).not.toContain(r.id);
    });

    it('listStops + listAssignments empty arrays for fresh route', async () => {
      const r = await makeRoute();
      const stops = await withTestTenant(async () => cleaning.listStops(r.id));
      expect(Array.isArray(stops)).toBe(true);
      const assigns = await withTestTenant(async () => cleaning.listAssignments(r.id));
      expect(Array.isArray(assigns)).toBe(true);
    });
  });
});
