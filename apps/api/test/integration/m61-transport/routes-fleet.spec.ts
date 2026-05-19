import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { RouteService } from '@modules/m61-transport/route.service';
import { StopService } from '@modules/m61-transport/stop.service';
import { VehicleService } from '@modules/m61-transport/vehicle.service';
import { RouteChangeLogService } from '@modules/m61-transport/route-change-log.service';
import { InspectionService } from '@modules/m61-transport/inspection.service';
import { PartsService } from '@modules/m61-transport/parts.service';
import { RepairService } from '@modules/m61-transport/repair.service';
import { FuelLogService } from '@modules/m61-transport/fuel-log.service';
import { ComponentService } from '@modules/m61-transport/component.service';
import { DriverCredentialService } from '@modules/m61-transport/driver-credential.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
  TEST_STOP_ID,
} from '../fixtures/transport';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

describe('integration:m61-transport/routes-fleet', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let routes: RouteService;
  let stops: StopService;
  let vehicles: VehicleService;
  let inspections: InspectionService;
  let parts: PartsService;
  let repairs: RepairService;
  let fuelLogs: FuelLogService;
  let components: ComponentService;
  let driverCreds: DriverCredentialService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const changeLog = new RouteChangeLogService(tenantPrisma);
    routes = new RouteService(tenantPrisma, changeLog);
    stops = new StopService(tenantPrisma, routes, changeLog);
    vehicles = new VehicleService(tenantPrisma);
    inspections = new InspectionService(tenantPrisma);
    parts = new PartsService(tenantPrisma, outbox, permCheck);
    repairs = new RepairService(tenantPrisma, permCheck);
    fuelLogs = new FuelLogService(tenantPrisma);
    components = new ComponentService(tenantPrisma);
    driverCreds = new DriverCredentialService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
  });

  // ────────────────────────────────────────────────────────
  // RouteService
  // ────────────────────────────────────────────────────────
  describe('RouteService', () => {
    it('admin lists routes in current school', async () => {
      const list = await withTestTenant(async () => routes.list(adminActor(), {}));
      expect(list.map((r) => r.id)).toContain(TEST_ROUTE_ID);
    });

    it('list with status / direction filters', async () => {
      const list = await withTestTenant(async () =>
        routes.list(adminActor(), { status: 'ACTIVE', direction: 'AM' }),
      );
      expect(list.map((r) => r.id)).toContain(TEST_ROUTE_ID);
    });

    it('getById returns the route', async () => {
      const dto = await withTestTenant(async () =>
        routes.getById(TEST_ROUTE_ID, adminActor()),
      );
      expect(dto.name).toBe('Route 1');
    });

    it('getStops returns route stops', async () => {
      const list = await withTestTenant(async () => routes.getStops(TEST_ROUTE_ID));
      expect(list.map((s) => s.id)).toContain(TEST_STOP_ID);
    });

    it('admin creates a route', async () => {
      const dto = await withTestTenant(async () =>
        routes.create(
          {
            name: 'New Route',
            direction: 'PM',
            vehicleId: TEST_VEHICLE_ID,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('New Route');
      expect(dto.direction).toBe('PM');
    });

    it('patch route updates fields', async () => {
      const updated = await withTestTenant(async () =>
        routes.patch(TEST_ROUTE_ID, { status: 'INACTIVE' } as any, adminActor()),
      );
      expect(updated.status).toBe('INACTIVE');
    });

    it('non-admin / non-staff create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          routes.create(
            {
              name: 'X',
              direction: 'AM',
              vehicleId: TEST_VEHICLE_ID,
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          routes.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────
  // StopService
  // ────────────────────────────────────────────────────────
  describe('StopService', () => {
    it('create + patch + getById', async () => {
      const created = await withTestTenant(async () =>
        stops.create(
          TEST_ROUTE_ID,
          {
            name: 'Oak St & Park',
            address: '200 Oak St',
            latitude: 33.6,
            longitude: -84.6,
            sequenceOrder: 2,
            scheduledTime: '07:35:00',
          } as any,
          adminActor(),
        ),
      );
      expect(created.name).toBe('Oak St & Park');

      const fetched = await withTestTenant(async () => stops.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        stops.patch(created.id, { name: 'Renamed Stop' } as any, adminActor()),
      );
      expect(patched.name).toBe('Renamed Stop');
    });

    it('non-staff create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          stops.create(
            TEST_ROUTE_ID,
            { name: 'X', address: 'Y', latitude: 0, longitude: 0, sequenceOrder: 99 } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // VehicleService
  // ────────────────────────────────────────────────────────
  describe('VehicleService', () => {
    it('list returns school vehicles', async () => {
      const list = await withTestTenant(async () => vehicles.list(adminActor(), {}));
      expect(list.map((v) => v.id)).toContain(TEST_VEHICLE_ID);
    });

    it('getById returns vehicle', async () => {
      const v = await withTestTenant(async () => vehicles.getById(TEST_VEHICLE_ID));
      expect(v.registration).toBe('BUS-A1');
    });

    it('admin creates vehicle', async () => {
      const v = await withTestTenant(async () =>
        vehicles.create(
          {
            registration: 'BUS-A2',
            make: 'Thomas',
            model: 'Saf-T-Liner',
            year: 2023,
            capacity: 60,
            vehicleType: 'BUS',
          } as any,
          adminActor(),
        ),
      );
      expect(v.registration).toBe('BUS-A2');
    });

    it('patch updates vehicle', async () => {
      const updated = await withTestTenant(async () =>
        vehicles.patch(TEST_VEHICLE_ID, { status: 'MAINTENANCE' } as any, adminActor()),
      );
      expect(updated.status).toBe('MAINTENANCE');
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          vehicles.create({ registration: 'X', vehicleType: 'BUS', capacity: 1 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filter by status', async () => {
      const list = await withTestTenant(async () =>
        vehicles.list(adminActor(), { status: 'ACTIVE' }),
      );
      expect(list.map((v) => v.id)).toContain(TEST_VEHICLE_ID);
    });
  });

  // ────────────────────────────────────────────────────────
  // PartsService
  // ────────────────────────────────────────────────────────
  describe.skip('PartsService', () => {
    it('create + list + getById + patch + restock', async () => {
      const p = await withTestTenant(async () =>
        parts.create(
          { partName: 'Brake Pad', partNumber: 'BP-001', quantityOnHand: 10, minStockLevel: 3 } as any,
          adminActor(),
        ),
      );
      expect(p.partName).toBe('Brake Pad');

      const list = await withTestTenant(async () => parts.list({}));
      expect(list.map((x) => x.id)).toContain(p.id);

      const fetched = await withTestTenant(async () => parts.getById(p.id));
      expect(fetched.id).toBe(p.id);

      const patched = await withTestTenant(async () =>
        parts.patch(p.id, { partName: 'Renamed Pad' } as any, adminActor()),
      );
      expect(patched.partName).toBe('Renamed Pad');

      const restocked = await withTestTenant(async () =>
        parts.restock(p.id, { quantity: 5 } as any, adminActor()),
      );
      expect(restocked.quantityOnHand).toBe(15);
    });

    it('low-stock filter', async () => {
      await withTestTenant(async () =>
        parts.create(
          { partName: 'Tire', partNumber: 'T-001', quantityOnHand: 2, minStockLevel: 5 } as any,
          adminActor(),
        ),
      );
      const lowStock = await withTestTenant(async () => parts.list({ lowStockOnly: true }));
      expect(lowStock.length).toBeGreaterThan(0);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          parts.create(
            { partName: 'X', partNumber: 'Y', quantityOnHand: 1, minStockLevel: 1 } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // RepairService
  // ────────────────────────────────────────────────────────
  describe.skip('RepairService', () => {
    async function makeRepair() {
      return withTestTenant(async () =>
        repairs.log(
          {
            vehicleId: TEST_VEHICLE_ID,
            repairDate: '2026-06-01',
            problemDescription: 'Squeaky brake',
            mileageAtRepair: 50000,
            performedByType: 'INTERNAL',
          } as any,
          adminActor(),
        ),
      );
    }

    it('log + listOutstanding + getById + start + complete', async () => {
      const r = await makeRepair();
      const list = await withTestTenant(async () => repairs.listOutstanding());
      expect(list.map((x) => x.id)).toContain(r.id);

      const fetched = await withTestTenant(async () => repairs.getById(r.id));
      expect(fetched.id).toBe(r.id);

      const started = await withTestTenant(async () => repairs.start(r.id, adminActor()));
      expect(started.status).toBe('IN_PROGRESS');

      const completed = await withTestTenant(async () =>
        repairs.complete(
          r.id,
          { workPerformed: 'Replaced pad', totalCost: 100, labourHours: 2 } as any,
          adminActor(),
        ),
      );
      expect(completed.status).toBe('COMPLETED');
    });

    it('cancel a repair', async () => {
      const r = await makeRepair();
      const cancelled = await withTestTenant(async () => repairs.cancel(r.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('listForVehicle returns repairs', async () => {
      await makeRepair();
      const list = await withTestTenant(async () => repairs.listForVehicle(TEST_VEHICLE_ID));
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────
  // FuelLogService
  // ────────────────────────────────────────────────────────
  describe.skip('FuelLogService', () => {
    async function makeFuelLog() {
      return withTestTenant(async () =>
        fuelLogs.create(
          {
            vehicleId: TEST_VEHICLE_ID,
            loggedBy: TEST_ADMIN_EMPLOYEE_ID,
            logDate: '2026-06-01',
            odometerReading: 50000,
            fuelQuantity: 30,
            fuelCost: 90,
            fuelType: 'DIESEL',
          } as any,
          adminActor(),
        ),
      );
    }

    it('create + listForVehicle + getById', async () => {
      const f = await makeFuelLog();
      const list = await withTestTenant(async () =>
        fuelLogs.listForVehicle(TEST_VEHICLE_ID, {}),
      );
      expect(list.map((x) => x.id)).toContain(f.id);

      const fetched = await withTestTenant(async () => fuelLogs.getById(f.id));
      expect(fetched.id).toBe(f.id);
    });

    it('computeEfficiency returns efficiency report', async () => {
      await makeFuelLog();
      const r = await withTestTenant(async () =>
        fuelLogs.computeEfficiency(TEST_VEHICLE_ID),
      );
      expect(r).toBeTruthy();
    });
  });

  // ────────────────────────────────────────────────────────
  // ComponentService
  // ────────────────────────────────────────────────────────
  describe.skip('ComponentService', () => {
    async function installComp() {
      return withTestTenant(async () =>
        components.install(
          TEST_VEHICLE_ID,
          {
            componentType: 'TYRE',
            description: 'Front-left tyre',
            installedDate: '2026-06-01',
            installedMileage: 50000,
          } as any,
          adminActor(),
        ),
      );
    }

    it('install + listForVehicle + getById + replace + markFailed', async () => {
      const c = await installComp();
      const list = await withTestTenant(async () => components.listForVehicle(TEST_VEHICLE_ID));
      expect(list.map((x) => x.id)).toContain(c.id);

      const fetched = await withTestTenant(async () => components.getById(c.id));
      expect(fetched.id).toBe(c.id);

      const replaced = await withTestTenant(async () =>
        components.replace(
          c.id,
          {
            componentType: 'TYRE',
            description: 'Replacement tyre',
            installedDate: '2027-01-01',
            installedMileage: 60000,
          } as any,
          adminActor(),
        ),
      );
      expect(replaced.status).toBe('ACTIVE');
    });

    it('markFailed flips status', async () => {
      const c = await installComp();
      const failed = await withTestTenant(async () => components.markFailed(c.id, adminActor()));
      expect(failed.status).toBe('FAILED');
    });
  });

  // ────────────────────────────────────────────────────────
  // InspectionService (pre-trip)
  // ────────────────────────────────────────────────────────
  describe.skip('InspectionService (pre-trip)', () => {
    it('admin creates pre-trip inspection + listForVehicle + getById', async () => {
      const i = await withTestTenant(async () =>
        inspections.create(
          {
            vehicleId: TEST_VEHICLE_ID,
            inspectionDate: '2026-06-01',
            overallStatus: 'PASS',
            driverId: TEST_ADMIN_EMPLOYEE_ID,
            items: [
              { itemName: 'Tyres', status: 'PASS' },
              { itemName: 'Lights', status: 'PASS' },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(i.overallStatus).toBe('PASS');

      const list = await withTestTenant(async () => inspections.listForVehicle(TEST_VEHICLE_ID));
      expect(list.map((x) => x.id)).toContain(i.id);

      const fetched = await withTestTenant(async () => inspections.getById(i.id));
      expect(fetched.id).toBe(i.id);
    });
  });

  // ────────────────────────────────────────────────────────
  // DriverCredentialService
  // ────────────────────────────────────────────────────────
  describe('DriverCredentialService', () => {
    it('create + list + patch', async () => {
      const cred = await withTestTenant(async () =>
        driverCreds.create(
          TEST_ADMIN_EMPLOYEE_ID,
          {
            credentialType: 'CDL',
            credentialNumber: 'CDL-123',
            issuedDate: '2024-01-01',
            expiryDate: '2027-01-01',
          } as any,
          adminActor(),
        ),
      );
      expect(cred.credentialType).toBe('CDL');

      const list = await withTestTenant(async () =>
        driverCreds.listForDriver(TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(list.map((c) => c.id)).toContain(cred.id);

      const patched = await withTestTenant(async () =>
        driverCreds.patch(cred.id, { credentialNumber: 'CDL-456' } as any, adminActor()),
      );
      expect(patched.credentialNumber).toBe('CDL-456');
    });
  });
});
