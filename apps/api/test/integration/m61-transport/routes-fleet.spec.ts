import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
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
      const dto = await withTestTenant(async () => routes.getById(TEST_ROUTE_ID, adminActor()));
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
          vehicles.create(
            { registration: 'X', vehicleType: 'BUS', capacity: 1 } as any,
            studentActor(),
          ),
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
  describe('PartsService', () => {
    it('create + list + getById + patch + restock', async () => {
      const p = await withTestTenant(async () =>
        parts.create(
          {
            partName: 'Brake Pad',
            partNumber: 'BP-001',
            quantityOnHand: 10,
            minStockLevel: 3,
          } as any,
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
        parts.restock(p.id, { quantityDelta: 5 } as any, adminActor()),
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
  describe('RepairService', () => {
    async function makeRepair(status: string = 'SCHEDULED') {
      return withTestTenant(async () =>
        repairs.create(
          TEST_VEHICLE_ID,
          {
            repairDate: '2026-06-01',
            problemDescription: 'Squeaky brake',
            workPerformed: 'Inspected and ordered new pads',
            mileageAtRepair: 50000,
            performedByType: 'INTERNAL',
            totalCost: 100,
            status,
          } as any,
          adminActor(),
        ),
      );
    }

    it('create + getById + patch through status lifecycle', async () => {
      const r = await makeRepair('SCHEDULED');
      const fetched = await withTestTenant(async () => repairs.getById(r.id));
      expect(fetched.id).toBe(r.id);

      const started = await withTestTenant(async () =>
        repairs.patch(r.id, { status: 'IN_PROGRESS' } as any, adminActor()),
      );
      expect(started.status).toBe('IN_PROGRESS');

      const completed = await withTestTenant(async () =>
        repairs.patch(
          r.id,
          { status: 'COMPLETED', workPerformed: 'Replaced pad', labourHours: 2 } as any,
          adminActor(),
        ),
      );
      expect(completed.status).toBe('COMPLETED');
    });

    it('patch to CANCELLED', async () => {
      const r = await makeRepair('SCHEDULED');
      const cancelled = await withTestTenant(async () =>
        repairs.patch(r.id, { status: 'CANCELLED' } as any, adminActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('listForVehicle returns repairs', async () => {
      await makeRepair('SCHEDULED');
      const list = await withTestTenant(async () => repairs.listForVehicle(TEST_VEHICLE_ID));
      expect(list.length).toBeGreaterThan(0);
    });

    it('listOutstandingSafetyCritical returns array', async () => {
      const list = await withTestTenant(async () => repairs.listOutstandingSafetyCritical());
      expect(Array.isArray(list)).toBe(true);
    });

    it('repair category create + list + patch', async () => {
      const cat = await withTestTenant(async () =>
        repairs.createCategory({ name: 'Brakes', isSafetyCritical: true } as any, adminActor()),
      );
      expect(cat.isSafetyCritical).toBe(true);
      const list = await withTestTenant(async () => repairs.listCategories());
      expect(list.map((c) => c.id)).toContain(cat.id);
      const patched = await withTestTenant(async () =>
        repairs.patchCategory(cat.id, { name: 'Renamed Brakes' } as any, adminActor()),
      );
      expect(patched.name).toBe('Renamed Brakes');
    });
  });

  // ────────────────────────────────────────────────────────
  // FuelLogService
  // ────────────────────────────────────────────────────────
  describe('FuelLogService', () => {
    async function makeFuelLog() {
      return withTestTenant(async () =>
        fuelLogs.create(
          TEST_VEHICLE_ID,
          {
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

    it('create + listForVehicle', async () => {
      const f = await makeFuelLog();
      const list = await withTestTenant(async () => fuelLogs.listForVehicle(TEST_VEHICLE_ID));
      expect(list.map((x) => x.id)).toContain(f.id);
    });

    it('fleetSummary returns summary rows', async () => {
      await makeFuelLog();
      const r = await withTestTenant(async () => fuelLogs.fleetSummary());
      expect(Array.isArray(r)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // ComponentService
  // ────────────────────────────────────────────────────────
  describe('ComponentService', () => {
    async function installComp() {
      return withTestTenant(async () =>
        components.create(
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

    it('create + listForVehicle + getById', async () => {
      const c = await installComp();
      const list = await withTestTenant(async () => components.listForVehicle(TEST_VEHICLE_ID));
      expect(list.map((x) => x.id)).toContain(c.id);

      const fetched = await withTestTenant(async () => components.getById(c.id));
      expect(fetched.id).toBe(c.id);
    });

    it('patch flips status to FAILED', async () => {
      const c = await installComp();
      const failed = await withTestTenant(async () =>
        components.patch(c.id, { status: 'FAILED' } as any, adminActor()),
      );
      expect(failed.status).toBe('FAILED');
    });

    it('listApproachingEndOfLife returns array', async () => {
      await installComp();
      const list = await withTestTenant(async () => components.listApproachingEndOfLife());
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // InspectionService (pre-trip)
  // ────────────────────────────────────────────────────────
  describe('InspectionService (pre-trip)', () => {
    it('admin creates pre-trip inspection + listForVehicle + getById', async () => {
      const i = await withTestTenant(async () =>
        inspections.create(
          TEST_VEHICLE_ID,
          {
            inspectionDate: '2026-06-01',
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

    it('FAIL item → overallStatus FAIL', async () => {
      const i = await withTestTenant(async () =>
        inspections.create(
          TEST_VEHICLE_ID,
          {
            inspectionDate: '2026-06-02',
            items: [
              { itemName: 'Tyres', status: 'PASS' },
              { itemName: 'Brakes', status: 'FAIL', notes: 'Worn brake pads' },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(i.overallStatus).toBe('FAIL');
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
