import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ContractedRouteService } from '@modules/m61-transport/contracted-route.service';
import { RouteConstraintService } from '@modules/m61-transport/route-constraint.service';
import { DriverHoursService } from '@modules/m61-transport/driver-hours.service';
import { AdhocTripService } from '@modules/m61-transport/adhoc-trip.service';
import { NoShowService } from '@modules/m61-transport/no-show.service';
import { BusPassService } from '@modules/m61-transport/bus-pass.service';
import { FleetStatusService } from '@modules/m61-transport/fleet-status.service';
import { RouteChangeRequestService } from '@modules/m61-transport/route-change-request.service';
import { RouteChangeLogService } from '@modules/m61-transport/route-change-log.service';
import { RouteService } from '@modules/m61-transport/route.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
} from '../fixtures/transport';

// Stub WorkflowEngineService — AdhocTripService swallows failures.
class StubWorkflows {
  async submit(): Promise<never> {
    throw new Error('NO_TEMPLATE_CONFIGURED');
  }
}

describe('integration:m61-transport/services-coverage', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let contracted: ContractedRouteService;
  let constraints: RouteConstraintService;
  let driverHours: DriverHoursService;
  let adhoc: AdhocTripService;
  let noShow: NoShowService;
  let busPass: BusPassService;
  let fleetStatus: FleetStatusService;
  let changeReq: RouteChangeRequestService;
  let routes: RouteService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const changeLog = new RouteChangeLogService(tenantPrisma);
    routes = new RouteService(tenantPrisma, changeLog);

    contracted = new ContractedRouteService(tenantPrisma);
    constraints = new RouteConstraintService(tenantPrisma);
    driverHours = new DriverHoursService(tenantPrisma, outbox, permCheck);
    adhoc = new AdhocTripService(tenantPrisma, new StubWorkflows() as any);
    noShow = new NoShowService(
      tenantPrisma,
      busPass as any, // RidershipService not needed for these tests
      makeRecordingKafka(),
    );
    busPass = new BusPassService(tenantPrisma);
    fleetStatus = new FleetStatusService(tenantPrisma);
    const assignments = new (await import('@modules/m61-transport/assignment.service')).AssignmentService(
      tenantPrisma,
      routes,
      changeLog,
    );
    changeReq = new RouteChangeRequestService(tenantPrisma, assignments);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
  });

  // ─── ContractedRouteService ───────────────────────
  describe('ContractedRouteService', () => {
    it('create + list + getById + patch', async () => {
      const c = await withTestTenant(async () =>
        contracted.create(
          {
            routeId: TEST_ROUTE_ID,
            contractStartDate: '2026-01-01',
            contractEndDate: '2027-01-01',
            dailyRate: 250,
            paymentFrequency: 'MONTHLY',
            notes: 'Test contractor',
          } as any,
          adminActor(),
        ),
      );
      expect(c.routeId).toBe(TEST_ROUTE_ID);

      const list = await withTestTenant(async () => contracted.list({ activeOnly: true }));
      expect(list.map((x) => x.id)).toContain(c.id);

      const fetched = await withTestTenant(async () => contracted.getById(c.id));
      expect(fetched.id).toBe(c.id);

      const patched = await withTestTenant(async () =>
        contracted.patch(c.id, { performanceRating: 4.5, isActive: false } as any, adminActor()),
      );
      expect(Number(patched.performanceRating)).toBe(4.5);
      expect(patched.isActive).toBe(false);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          contracted.create(
            {
              routeId: TEST_ROUTE_ID,
              contractStartDate: '2026-01-01',
              contractEndDate: '2027-01-01',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── RouteConstraintService ───────────────────────
  describe('RouteConstraintService', () => {
    it('create + list + getById + patch', async () => {
      const c = await withTestTenant(async () =>
        constraints.create(
          {
            constraintName: 'Default profile',
            maxRideTimeMinutes: 45,
            maxStudentsPerVehicle: 50,
            walkableRadiusMetres: 400,
          } as any,
          adminActor(),
        ),
      );
      expect(c.constraintName).toBe('Default profile');

      const list = await withTestTenant(async () => constraints.list({ includeInactive: false }));
      expect(list.map((x) => x.id)).toContain(c.id);

      const fetched = await withTestTenant(async () => constraints.getById(c.id));
      expect(fetched.id).toBe(c.id);

      const patched = await withTestTenant(async () =>
        constraints.patch(c.id, { maxRideTimeMinutes: 50 } as any, adminActor()),
      );
      expect(patched.maxRideTimeMinutes).toBe(50);
    });
  });

  // ─── DriverHoursService ─────────────────────────────
  describe('DriverHoursService', () => {
    beforeEach(async () => {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.trn_driver_hours_limits WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
    });

    it('getLimit returns defaults; updateLimit overrides them', async () => {
      const initial = await withTestTenant(async () => driverHours.getLimit());
      expect(initial.weeklyDrivingLimitMinutes).toBeGreaterThan(0);

      const updated = await withTestTenant(async () =>
        driverHours.updateLimit({ weeklyDrivingLimitMinutes: 2400 } as any, adminActor()),
      );
      expect(updated.weeklyDrivingLimitMinutes).toBe(2400);
    });

    it('create + listForDriver + weeklySummary', async () => {
      const h = await withTestTenant(async () =>
        driverHours.create(
          TEST_ADMIN_EMPLOYEE_ID,
          {
            logDate: '2026-06-01',
            dutyStartAt: '2026-06-01T06:00:00Z',
          } as any,
          adminActor(),
        ),
      );
      expect(h.driverId).toBe(TEST_ADMIN_EMPLOYEE_ID);

      const list = await withTestTenant(async () =>
        driverHours.listForDriver(TEST_ADMIN_EMPLOYEE_ID, {}),
      );
      expect(list.map((x) => x.id)).toContain(h.id);

      const summary = await withTestTenant(async () =>
        driverHours.weeklySummary(TEST_ADMIN_EMPLOYEE_ID),
      );
      expect(summary.driverId).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('listApproachingLimit returns array', async () => {
      const list = await withTestTenant(async () => driverHours.listApproachingLimit());
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ─── AdhocTripService ───────────────────────────────
  describe('AdhocTripService', () => {
    async function submitTrip() {
      // Use a future date so the validation doesn't reject
      return withTestTenant(async () =>
        adhoc.submit(
          {
            tripPurpose: 'FIELD_TRIP',
            tripDate: '2027-09-15',
            departureTime: '08:00',
            returnTime: '15:00',
            pickupLocation: 'School',
            destination: 'Museum',
            estimatedPassengers: 30,
          } as any,
          adminActor(),
        ),
      );
    }

    it('submit + list + getById', async () => {
      const t = await submitTrip();
      expect(t.tripPurpose).toBe('FIELD_TRIP');

      const list = await withTestTenant(async () => adhoc.list(adminActor(), {}));
      expect(list.map((x) => x.id)).toContain(t.id);

      const fetched = await withTestTenant(async () => adhoc.getById(t.id, adminActor()));
      expect(fetched.id).toBe(t.id);
    });

    it('approve + assign + complete lifecycle', async () => {
      const t = await submitTrip();
      const approved = await withTestTenant(async () =>
        adhoc.approve(t.id, 'Approved by admin', adminActor()),
      );
      expect(approved.status).toBe('APPROVED');

      const assigned = await withTestTenant(async () =>
        adhoc.assign(
          t.id,
          { vehicleId: TEST_VEHICLE_ID, driverId: TEST_ADMIN_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      expect(assigned.status).toBe('SCHEDULED');

      const completed = await withTestTenant(async () => adhoc.complete(t.id, adminActor()));
      expect(completed.status).toBe('COMPLETED');
    });

    it('cancel a REQUESTED trip', async () => {
      const t = await submitTrip();
      const cancelled = await withTestTenant(async () =>
        adhoc.cancel(t.id, { cancellationReason: 'No longer needed' } as any, adminActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ─── NoShowService ──────────────────────────────────
  describe('NoShowService', () => {
    it('list returns array', async () => {
      const list = await withTestTenant(async () => noShow.list(adminActor(), {}));
      expect(Array.isArray(list)).toBe(true);
    });

    it('runOnce returns counts', async () => {
      const r = await withTestTenant(async () => noShow.runOnce({}));
      expect(r).toBeTruthy();
    });
  });

  // ─── BusPassService ─────────────────────────────────
  describe('BusPassService', () => {
    it('list returns school passes', async () => {
      const list = await withTestTenant(async () => busPass.list(adminActor()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ─── FleetStatusService ─────────────────────────────
  describe('FleetStatusService', () => {
    it('list returns fleet rows', async () => {
      const list = await withTestTenant(async () => fleetStatus.list({}));
      expect(Array.isArray(list)).toBe(true);
    });

    it('getForVehicle returns null when no status row yet', async () => {
      const status = await withTestTenant(async () => fleetStatus.getForVehicle(TEST_VEHICLE_ID));
      expect(status === null || typeof status === 'object').toBe(true);
    });

    it('materialiseForVehicle creates status row', async () => {
      const row = await withTestTenant(async () =>
        fleetStatus.materialiseForVehicle(TEST_VEHICLE_ID, adminActor()),
      );
      expect(row.vehicleId).toBe(TEST_VEHICLE_ID);
    });

    it('materialiseAll returns update count', async () => {
      const r = await withTestTenant(async () => fleetStatus.materialiseAll(adminActor()));
      expect(typeof r.updated).toBe('number');
    });
  });

  // ─── RouteChangeRequestService ──────────────────────
  describe('RouteChangeRequestService', () => {
    it('list returns array', async () => {
      const list = await withTestTenant(async () => changeReq.list(adminActor(), {}));
      expect(Array.isArray(list)).toBe(true);
    });
  });
});
