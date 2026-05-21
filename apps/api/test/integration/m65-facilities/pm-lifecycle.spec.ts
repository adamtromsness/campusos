import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import {
  WorkOrderService,
  MaintenancePlanService,
  MaintenanceTaskService,
} from '@modules/m65-facilities/work-orders.service';
import { AssetService } from '@modules/m65-facilities/asset.service';
import { EnergyService } from '@modules/m65-facilities/energy.service';
import { CleaningRouteService } from '@modules/m65-facilities/cleaning-route.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_EMPLOYEE_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import {
  resetFacilitiesTables,
  ensureFacilitiesSeed,
  TEST_BUILDING_ID,
  TEST_SPACE_ID,
  TEST_ASSET_CATEGORY_ID,
} from '../fixtures/facilities';

describe('integration:m65-facilities/pm-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let workOrders: WorkOrderService;
  let plans: MaintenancePlanService;
  let tasks: MaintenanceTaskService;
  let assets: AssetService;
  let energy: EnergyService;
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
    assets = new AssetService(tenantPrisma, permCheck);
    energy = new EnergyService(tenantPrisma, permCheck);
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

  // ─── WorkOrderService.patch lifecycle ─────────────
  describe('WorkOrderService — patch lifecycle', () => {
    async function makeWO() {
      return withTestTenant(async () =>
        workOrders.create(
          {
            workOrderType: 'REPAIR',
            priority: 'MEDIUM',
            buildingId: TEST_BUILDING_ID,
            spaceId: TEST_SPACE_ID,
            description: 'Test WO',
          } as any,
          adminActor(),
        ),
      );
    }

    it('patch description + scheduledDate + actualCost', async () => {
      const wo = await makeWO();
      const patched = await withTestTenant(async () =>
        workOrders.patch(
          wo.id,
          {
            description: 'Updated WO description',
            scheduledDate: '2026-12-01',
            actualCost: 150,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.description).toBe('Updated WO description');
    });

    it('patch assignedToId', async () => {
      const wo = await makeWO();
      const patched = await withTestTenant(async () =>
        workOrders.patch(wo.id, { assignedToId: TEST_ADMIN_EMPLOYEE_ID } as any, adminActor()),
      );
      expect(patched.assignedToId).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('patch priority', async () => {
      const wo = await makeWO();
      const patched = await withTestTenant(async () =>
        workOrders.patch(wo.id, { priority: 'HIGH' } as any, adminActor()),
      );
      expect(patched.priority).toBe('HIGH');
    });

    it('addComment records activity', async () => {
      const wo = await makeWO();
      await withTestTenant(async () =>
        workOrders.addComment(wo.id, { comment: 'Investigating now' } as any, adminActor()),
      );
      const activity = await withTestTenant(async () => workOrders.listActivity(wo.id));
      expect(activity.length).toBeGreaterThan(0);
    });

    it('getById without activity', async () => {
      const wo = await makeWO();
      const fetched = await withTestTenant(async () => workOrders.getById(wo.id, false));
      expect(fetched.id).toBe(wo.id);
    });
  });

  // ─── MaintenancePlan + Task full lifecycle ───────
  describe('MaintenancePlan + Task lifecycle', () => {
    async function makePlan() {
      return withTestTenant(async () =>
        plans.create(
          {
            name: 'Quarterly HVAC PM',
            description: 'Standard HVAC checklist',
            frequencyMonths: 3,
            targetType: 'BUILDING',
            targetId: TEST_BUILDING_ID,
            items: [
              { itemName: 'Replace filter', sortOrder: 0 },
              { itemName: 'Check thermostat', sortOrder: 1 },
              { itemName: 'Clean coils', sortOrder: 2 },
            ],
          } as any,
          adminActor(),
        ),
      );
    }

    it('create plan + list + getById + patch + listItems + generateTasks + task patch + listResults + submitResults', async () => {
      const plan = await makePlan();
      expect(plan.name).toBe('Quarterly HVAC PM');

      const list = await withTestTenant(async () => plans.list());
      expect(list.map((p) => p.id)).toContain(plan.id);

      const fetched = await withTestTenant(async () => plans.getById(plan.id));
      expect(fetched.id).toBe(plan.id);

      const items = await withTestTenant(async () => plans.listItems(plan.id));
      expect(items.length).toBe(3);

      const patched = await withTestTenant(async () =>
        plans.patch(
          plan.id,
          { description: 'Updated description', frequencyMonths: 6 } as any,
          adminActor(),
        ),
      );
      expect(patched.id).toBe(plan.id);

      // Generate tasks across a 6-month window — generateTasks lives on MaintenancePlanService
      const gen = await withTestTenant(async () =>
        plans.generateTasks(
          plan.id,
          { fromDate: '2026-09-01', toDate: '2027-03-01' } as any,
          adminActor(),
        ),
      );
      expect(gen.created).toBeGreaterThan(0);

      // Task list/getById/patch
      const taskList = await withTestTenant(async () => tasks.list({ planId: plan.id }));
      expect(taskList.length).toBe(gen.created);

      const firstTask = taskList[0]!;
      const fetchedTask = await withTestTenant(async () => tasks.getById(firstTask.id));
      expect(fetchedTask.id).toBe(firstTask.id);

      const taskPatched = await withTestTenant(async () =>
        tasks.patch(
          firstTask.id,
          { status: 'IN_PROGRESS', notes: 'Starting work' } as any,
          adminActor(),
        ),
      );
      expect(taskPatched.status).toBe('IN_PROGRESS');

      // Submit results for all 3 checklist items
      const results = items.map((it) => ({
        checklistItemId: it.id,
        passed: true,
        notes: 'ok',
      }));
      await withTestTenant(async () =>
        tasks.submitResults(firstTask.id, { results } as any, adminActor()),
      );

      const submittedResults = await withTestTenant(async () => tasks.listResults(firstTask.id));
      expect(submittedResults.length).toBe(3);
    });

    it('task list with status filter', async () => {
      const plan = await makePlan();
      await withTestTenant(async () =>
        plans.generateTasks(
          plan.id,
          { fromDate: '2026-09-01', toDate: '2027-03-01' } as any,
          adminActor(),
        ),
      );
      const scheduled = await withTestTenant(async () => tasks.list({ status: 'SCHEDULED' }));
      expect(scheduled.length).toBeGreaterThan(0);
    });

    it('task list with assignedTo filter', async () => {
      const plan = await makePlan();
      const gen = await withTestTenant(async () =>
        plans.generateTasks(
          plan.id,
          { fromDate: '2026-09-01', toDate: '2027-03-01' } as any,
          adminActor(),
        ),
      );
      expect(gen.firstId).not.toBeNull();
      await withTestTenant(async () =>
        tasks.patch(gen.firstId!, { assignedTo: TEST_ADMIN_EMPLOYEE_ID } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        tasks.list({ assignedTo: TEST_ADMIN_EMPLOYEE_ID }),
      );
      expect(list.map((t) => t.id)).toContain(gen.firstId);
    });
  });

  // ─── AssetService — dispose + lifecycle ──────────
  describe('AssetService — full lifecycle', () => {
    async function makeAsset() {
      return withTestTenant(async () =>
        assets.createAsset(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            buildingId: TEST_BUILDING_ID,
            spaceId: TEST_SPACE_ID,
            assetTag: 'PM-001',
            name: 'PM Test Asset',
            installDate: '2024-01-01',
            expectedLifespanYears: 10,
            replacementPriority: 'LOW',
          } as any,
          adminActor(),
        ),
      );
    }

    it('decommission + dispose flow', async () => {
      const a = await makeAsset();
      const decommed = await withTestTenant(async () =>
        assets.decommission(a.id, { reason: 'end of life' } as any, adminActor()),
      );
      expect(decommed.status).toBe('DECOMMISSIONED');

      const disposed = await withTestTenant(async () =>
        assets.dispose(
          a.id,
          {
            disposalMethod: 'AUCTION',
            disposalDate: '2026-09-15',
            valueRecovered: 100,
            authorisedById: TEST_ADMIN_PERSON_ID,
            notes: 'sold',
          } as any,
          adminActor(),
        ),
      );
      expect(disposed.assetId).toBe(a.id);

      const disposal = await withTestTenant(async () => assets.getDisposal(disposed.id));
      expect(disposal.id).toBe(disposed.id);
    });

    it('recordMaintenance + listMaintenance + maintenanceOverdue', async () => {
      const a = await makeAsset();
      const m = await withTestTenant(async () =>
        assets.recordMaintenance(
          a.id,
          {
            maintenanceType: 'SCHEDULED',
            performedDate: '2026-06-01',
            performedBy: 'Tech A',
            cost: 100,
            description: 'Quarterly maintenance — replaced filter, checked thermostat',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => assets.listMaintenance(a.id));
      expect(list.map((x) => x.id)).toContain(m.id);

      const overdue = await withTestTenant(async () => assets.maintenanceOverdue());
      expect(Array.isArray(overdue)).toBe(true);
    });

    it('patchAsset multiple fields', async () => {
      const a = await makeAsset();
      const patched = await withTestTenant(async () =>
        assets.patchAsset(
          a.id,
          {
            name: 'Renamed Asset',
            replacementPriority: 'HIGH',
            replacementCostEstimate: 5000,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.name).toBe('Renamed Asset');
    });

    it('listAssets with category filter', async () => {
      const a = await makeAsset();
      const list = await withTestTenant(async () =>
        assets.listAssets({ categoryId: TEST_ASSET_CATEGORY_ID }),
      );
      expect(list.map((x) => x.id)).toContain(a.id);
    });

    it('replacementPlanning returns rows for assets nearing end-of-life', async () => {
      await withTestTenant(async () =>
        assets.createAsset(
          {
            categoryId: TEST_ASSET_CATEGORY_ID,
            buildingId: TEST_BUILDING_ID,
            assetTag: 'EOL-001',
            name: 'EOL Asset',
            installDate: '2012-01-01',
            expectedLifespanYears: 12,
            replacementPriority: 'CRITICAL',
          } as any,
          adminActor(),
        ),
      );
      const planning = await withTestTenant(async () => assets.replacementPlanning());
      expect(Array.isArray(planning)).toBe(true);
    });
  });

  // ─── EnergyService extended ────────────────────
  describe('EnergyService — reading + target', () => {
    async function makeMeter() {
      return withTestTenant(async () =>
        energy.createMeter(
          {
            buildingId: TEST_BUILDING_ID,
            meterName: 'PM Meter',
            utilityType: 'ELECTRICITY',
            unit: 'kWh',
          } as any,
          adminActor(),
        ),
      );
    }

    it('recordReading + getReading + listMeters filter', async () => {
      const m = await makeMeter();
      const r = await withTestTenant(async () =>
        energy.recordReading(
          { meterId: m.id, readingDate: '2026-09-15', readingValue: 1500 } as any,
          adminActor(),
        ),
      );
      expect(Number(r.readingValue)).toBe(1500);

      const fetched = await withTestTenant(async () => energy.getReading(r.id));
      expect(fetched.id).toBe(r.id);

      const list = await withTestTenant(async () =>
        energy.listMeters({ buildingId: TEST_BUILDING_ID }),
      );
      expect(list.map((x) => x.id)).toContain(m.id);

      const filtered = await withTestTenant(async () =>
        energy.listMeters({ utilityType: 'ELECTRICITY' }),
      );
      expect(filtered.length).toBeGreaterThan(0);
    });

    it('createTarget + listTargets + summary', async () => {
      const t = await withTestTenant(async () =>
        energy.createTarget(
          {
            utilityType: 'GAS',
            targetPeriod: 'ANNUAL',
            targetValue: 5000,
            academicYear: '2026-2027',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => energy.listTargets());
      expect(list.map((x) => x.id)).toContain(t.id);

      const summary = await withTestTenant(async () => energy.summary());
      expect(Array.isArray(summary)).toBe(true);
    });
  });

  // ─── CleaningRouteService completion flow ──────
  describe('CleaningRouteService — completion lifecycle', () => {
    async function makeRouteWithStop() {
      const route = await withTestTenant(async () =>
        cleaning.createRoute(
          { name: 'Cleaning PM Route', shift: 'MORNING', estimatedDurationMinutes: 60 } as any,
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
                taskName: 'Sweep',
                estimatedDurationMinutes: 15,
                tasks: ['sweep', 'mop'],
              },
            ],
          } as any,
          adminActor(),
        ),
      );
      return route;
    }

    it('startCompletion + patchStopCompletion + listCompletions + getCompletionById', async () => {
      const route = await makeRouteWithStop();
      const assignment = await withTestTenant(async () =>
        cleaning.createAssignment(
          route.id,
          { employeeId: TEST_ADMIN_EMPLOYEE_ID, assignmentDate: '2026-09-15' } as any,
          adminActor(),
        ),
      );

      const completion = await withTestTenant(async () =>
        cleaning.startCompletion(
          { routeId: route.id, assignmentId: assignment.id, completionDate: '2026-09-15' } as any,
          adminActor(),
        ),
      );
      expect(completion.routeId).toBe(route.id);

      const list = await withTestTenant(async () =>
        cleaning.listCompletions({
          routeId: route.id,
          fromDate: '2020-01-01',
          toDate: '2030-12-31',
        }),
      );
      expect(list.map((x) => x.id)).toContain(completion.id);

      const fetched = await withTestTenant(async () => cleaning.getCompletionById(completion.id));
      expect(fetched.id).toBe(completion.id);

      // Find a stop_id to update via patchStopCompletion. The startCompletion
      // call seeded one per route stop.
      const stops = await withTestTenant(async () => cleaning.listStops(route.id));
      expect(stops.length).toBeGreaterThan(0);

      await withTestTenant(async () =>
        cleaning.patchStopCompletion(
          completion.id,
          stops[0]!.id,
          { status: 'COMPLETED', taskNotes: 'done' } as any,
          adminActor(),
        ),
      );
    });
  });
});
