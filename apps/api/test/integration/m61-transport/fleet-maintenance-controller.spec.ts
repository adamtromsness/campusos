import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { FleetMaintenanceController } from '@modules/m61-transport/fleet-maintenance.controller';
import { RepairService } from '@modules/m61-transport/repair.service';
import { PartsService } from '@modules/m61-transport/parts.service';
import { ComponentService } from '@modules/m61-transport/component.service';
import { FuelLogService } from '@modules/m61-transport/fuel-log.service';
import { DriverHoursService } from '@modules/m61-transport/driver-hours.service';
import { VehicleLifecycleService } from '@modules/m61-transport/vehicle-lifecycle.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant } from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_VEHICLE_ID,
} from '../fixtures/transport';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m61-transport/fleet-maintenance-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: FleetMaintenanceController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();

    const repairs = new RepairService(tenantPrisma, permCheck);
    const parts = new PartsService(tenantPrisma, outbox, permCheck);
    const components = new ComponentService(tenantPrisma);
    const fuel = new FuelLogService(tenantPrisma);
    const hours = new DriverHoursService(tenantPrisma, outbox, permCheck);
    const lifecycle = new VehicleLifecycleService(tenantPrisma);

    ctl = new FleetMaintenanceController(
      repairs,
      parts,
      components,
      fuel,
      hours,
      lifecycle,
      new StubActorContext() as unknown as ActorContextService,
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
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
  });

  it('repair categories — list + create + patch', async () => {
    const cat = await withTestTenant(async () =>
      ctl.createCategory(req, { name: 'Engine', isSafetyCritical: true } as any),
    );
    expect(cat.name).toBe('Engine');

    const list = await withTestTenant(async () => ctl.listCategories());
    expect(list.map((x: any) => x.id)).toContain(cat.id);

    const patched = await withTestTenant(async () =>
      ctl.patchCategory(req, cat.id, { name: 'Engine Bay' } as any),
    );
    expect(patched.name).toBe('Engine Bay');
  });

  it('repairs — list + create + outstanding + patch', async () => {
    const r = await withTestTenant(async () =>
      ctl.createRepair(
        req,
        TEST_VEHICLE_ID,
        {
          repairDate: '2026-06-01',
          problemDescription: 'Test',
          workPerformed: 'Inspected',
          mileageAtRepair: 10000,
          performedByType: 'INTERNAL',
          totalCost: 50,
          status: 'IN_PROGRESS',
        } as any,
      ),
    );
    expect(r.problemDescription).toBe('Test');

    const list = await withTestTenant(async () => ctl.listRepairs(TEST_VEHICLE_ID));
    expect(list.map((x: any) => x.id)).toContain(r.id);

    const outstanding = await withTestTenant(async () => ctl.listOutstandingRepairs());
    expect(Array.isArray(outstanding)).toBe(true);

    const patched = await withTestTenant(async () =>
      ctl.patchRepair(req, r.id, { status: 'COMPLETED' } as any),
    );
    expect(patched.status).toBe('COMPLETED');
  });

  it('parts — list + create + patch + restock + lowStock', async () => {
    const p = await withTestTenant(async () =>
      ctl.createPart(
        req,
        { partName: 'Brake Pad', partNumber: 'BP-1', quantityOnHand: 10, minStockLevel: 3 } as any,
      ),
    );
    expect(p.partName).toBe('Brake Pad');

    const list = await withTestTenant(async () => ctl.listParts());
    expect(list.map((x: any) => x.id)).toContain(p.id);

    const patched = await withTestTenant(async () =>
      ctl.patchPart(req, p.id, { partName: 'Renamed' } as any),
    );
    expect(patched.partName).toBe('Renamed');

    const restocked = await withTestTenant(async () =>
      ctl.restockPart(req, p.id, { quantityDelta: 5 } as any),
    );
    expect(restocked.quantityOnHand).toBe(15);

    const low = await withTestTenant(async () => ctl.listLowStock());
    expect(Array.isArray(low)).toBe(true);
  });

  it('components — install + list + patch + approachingEol', async () => {
    const c = await withTestTenant(async () =>
      ctl.createComponent(
        req,
        TEST_VEHICLE_ID,
        {
          componentType: 'TYRE',
          description: 'Front-left',
          installedDate: '2026-06-01',
          installedMileage: 10000,
        } as any,
      ),
    );
    expect(c.componentType).toBe('TYRE');

    const list = await withTestTenant(async () => ctl.listComponents(TEST_VEHICLE_ID));
    expect(list.map((x: any) => x.id)).toContain(c.id);

    const patched = await withTestTenant(async () =>
      ctl.patchComponent(req, c.id, { status: 'FAILED' } as any),
    );
    expect(patched.status).toBe('FAILED');

    const eol = await withTestTenant(async () => ctl.approachingEndOfLife());
    expect(Array.isArray(eol)).toBe(true);
  });

  it('fuel — log + list + fleetSummary', async () => {
    const f = await withTestTenant(async () =>
      ctl.createFuel(
        req,
        TEST_VEHICLE_ID,
        {
          loggedBy: TEST_ADMIN_EMPLOYEE_ID,
          logDate: '2026-06-01',
          odometerReading: 50000,
          fuelQuantity: 30,
          fuelCost: 90,
          fuelType: 'DIESEL',
        } as any,
      ),
    );
    expect(f.fuelType).toBe('DIESEL');

    const list = await withTestTenant(async () => ctl.listFuel(TEST_VEHICLE_ID));
    expect(list.map((x: any) => x.id)).toContain(f.id);

    const summary = await withTestTenant(async () => ctl.fuelFleetSummary());
    expect(Array.isArray(summary)).toBe(true);
  });

  it('driver hours — limits + list + weekly summary + approaching', async () => {
    const limits = await withTestTenant(async () => ctl.getLimit());
    expect(limits.weeklyDrivingLimitMinutes).toBeGreaterThan(0);

    const updated = await withTestTenant(async () =>
      ctl.patchLimit(req, { weeklyDrivingLimitMinutes: 2400 } as any),
    );
    expect(updated.weeklyDrivingLimitMinutes).toBe(2400);

    const log = await withTestTenant(async () =>
      ctl.startDuty(
        req,
        TEST_ADMIN_EMPLOYEE_ID,
        {
          logDate: '2026-06-01',
          dutyStartAt: '2026-06-01T06:00:00Z',
        } as any,
      ),
    );
    expect(log.driverId).toBe(TEST_ADMIN_EMPLOYEE_ID);

    const list = await withTestTenant(async () =>
      ctl.listDriverHours(TEST_ADMIN_EMPLOYEE_ID),
    );
    expect(list.map((x: any) => x.id)).toContain(log.id);

    const weekly = await withTestTenant(async () =>
      ctl.weeklySummary(TEST_ADMIN_EMPLOYEE_ID),
    );
    expect(weekly.driverId).toBe(TEST_ADMIN_EMPLOYEE_ID);

    const approaching = await withTestTenant(async () => ctl.approachingLimit());
    expect(Array.isArray(approaching)).toBe(true);

    // Close out the duty
    const completed = await withTestTenant(async () =>
      ctl.completeDuty(
        req,
        log.id,
        {
          dutyEndAt: '2026-06-01T14:00:00Z',
          drivingMinutes: 360,
          breakMinutes: 60,
          notes: 'Done',
        } as any,
      ),
    );
    expect(completed.dutyEndAt).not.toBeNull();
  });

  it('vehicle lifecycle — patch + getForVehicle + replacementPlanning', async () => {
    const v = await withTestTenant(async () =>
      ctl.patchLifecycle(
        req,
        TEST_VEHICLE_ID,
        {
          purchaseDate: '2020-01-01',
          purchasePrice: 80000,
          expectedLifeYears: 12,
          depreciationMethod: 'STRAIGHT_LINE',
        } as any,
      ),
    );
    expect(v.vehicleId).toBe(TEST_VEHICLE_ID);

    const fetched = await withTestTenant(async () => ctl.getLifecycle(TEST_VEHICLE_ID));
    expect(fetched.vehicleId).toBe(TEST_VEHICLE_ID);

    const planning = await withTestTenant(async () => ctl.replacementPlanning());
    expect(Array.isArray(planning)).toBe(true);
  });
});
