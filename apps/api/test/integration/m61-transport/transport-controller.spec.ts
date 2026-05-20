import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { TransportController } from '@modules/m61-transport/transport.controller';
import { RouteService } from '@modules/m61-transport/route.service';
import { StopService } from '@modules/m61-transport/stop.service';
import { AssignmentService } from '@modules/m61-transport/assignment.service';
import { RouteChangeRequestService } from '@modules/m61-transport/route-change-request.service';
import { RouteChangeLogService } from '@modules/m61-transport/route-change-log.service';
import { VehicleService } from '@modules/m61-transport/vehicle.service';
import { InspectionService } from '@modules/m61-transport/inspection.service';
import { DriverCredentialService } from '@modules/m61-transport/driver-credential.service';
import { BusPassService } from '@modules/m61-transport/bus-pass.service';
import { RidershipService } from '@modules/m61-transport/ridership.service';
import { RunLogService } from '@modules/m61-transport/run-log.service';
import { NoShowService } from '@modules/m61-transport/no-show.service';
import { DelayReportService } from '@modules/m61-transport/delay-report.service';
import {
  type ActorContextService,
  type ResolvedActor,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
  TEST_STOP_ID,
} from '../fixtures/transport';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m61-transport/transport-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: TransportController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();

    const changeLog = new RouteChangeLogService(tenantPrisma);
    const routes = new RouteService(tenantPrisma, changeLog);
    const stops = new StopService(tenantPrisma, routes, changeLog);
    const assignments = new AssignmentService(tenantPrisma, routes, changeLog);
    const changeReqs = new RouteChangeRequestService(tenantPrisma, assignments);
    void outbox;
    const vehicles = new VehicleService(tenantPrisma);
    const inspections = new InspectionService(tenantPrisma);
    const driverCreds = new DriverCredentialService(tenantPrisma);
    const busPasses = new BusPassService(tenantPrisma);
    const ridership = new RidershipService(tenantPrisma, busPasses as any);
    const runLogs = new RunLogService(tenantPrisma, inspections);
    const noShows = new NoShowService(tenantPrisma, ridership as any, kafka);
    const delays = new DelayReportService(tenantPrisma, kafka);

    ctl = new TransportController(
      routes,
      stops,
      assignments,
      changeReqs,
      changeLog,
      vehicles,
      inspections,
      driverCreds,
      busPasses,
      ridership,
      runLogs,
      noShows,
      delays,
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
    void TEST_SCHOOL_ID;
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
  });

  it('routes — list + get + create + patch', async () => {
    const list = await withTestTenant(async () => ctl.listRoutes(req));
    expect(list.map((r: any) => r.id)).toContain(TEST_ROUTE_ID);

    const fetched = await withTestTenant(async () => ctl.getRoute(TEST_ROUTE_ID, req));
    expect(fetched.id).toBe(TEST_ROUTE_ID);

    const patched = await withTestTenant(async () =>
      ctl.patchRoute(TEST_ROUTE_ID, { status: 'INACTIVE' } as any, req),
    );
    expect(patched.status).toBe('INACTIVE');
  });

  it('stops — list for route + create + patch', async () => {
    const stops = await withTestTenant(async () => ctl.getStops(TEST_ROUTE_ID, req));
    expect(stops.map((s: any) => s.id)).toContain(TEST_STOP_ID);

    const created = await withTestTenant(async () =>
      ctl.createStop(
        TEST_ROUTE_ID,
        {
          name: 'Pine St & Hill',
          address: '300 Pine St',
          latitude: 33.7,
          longitude: -84.7,
          sequenceOrder: 2,
          scheduledTime: '07:40:00',
        } as any,
        req,
      ),
    );
    expect(created.name).toBe('Pine St & Hill');

    const patched = await withTestTenant(async () =>
      ctl.patchStop(created.id, { name: 'Renamed' } as any, req),
    );
    expect(patched.name).toBe('Renamed');
  });

  it('vehicle documents — list + add', async () => {
    const docs = await withTestTenant(async () => ctl.listVehicleDocs(TEST_VEHICLE_ID));
    expect(Array.isArray(docs)).toBe(true);

    const created = await withTestTenant(async () =>
      ctl.addVehicleDoc(
        TEST_VEHICLE_ID,
        {
          documentType: 'REGISTRATION',
          documentNumber: 'REG-001',
          expiryDate: '2027-09-01',
        } as any,
        req,
      ),
    );
    expect(created.documentType).toBe('REGISTRATION');

    const after = await withTestTenant(async () => ctl.listVehicleDocs(TEST_VEHICLE_ID));
    expect(after.map((d: any) => d.id)).toContain(created.id);
  });

  it('vehicles — list + get + create + patch + documents + inspections', async () => {
    const list = await withTestTenant(async () => ctl.listVehicles(req as any));
    expect(list.map((v: any) => v.id)).toContain(TEST_VEHICLE_ID);

    const v = await withTestTenant(async () => ctl.getVehicle(TEST_VEHICLE_ID));
    expect(v.id).toBe(TEST_VEHICLE_ID);

    const created = await withTestTenant(async () =>
      ctl.createVehicle(
        {
          registration: 'BUS-NEW',
          make: 'IC Bus',
          model: 'CE',
          year: 2024,
          capacity: 60,
          vehicleType: 'BUS',
        } as any,
        req,
      ),
    );
    expect(created.registration).toBe('BUS-NEW');

    const patched = await withTestTenant(async () =>
      ctl.patchVehicle(created.id, { status: 'MAINTENANCE' } as any, req),
    );
    expect(patched.status).toBe('MAINTENANCE');

    // Inspections
    const insp = await withTestTenant(async () =>
      ctl.createInspection(
        TEST_VEHICLE_ID,
        {
          inspectionDate: '2026-06-10',
          items: [{ itemName: 'Tyres', status: 'PASS' }],
        } as any,
        req,
      ),
    );
    expect(insp.overallStatus).toBe('PASS');
    const inspList = await withTestTenant(async () => ctl.listInspections(TEST_VEHICLE_ID));
    expect(inspList.map((x: any) => x.id)).toContain(insp.id);
    const inspGet = await withTestTenant(async () => ctl.getInspection(insp.id, req));
    expect(inspGet.id).toBe(insp.id);
  });

  it('drivers — list + credentials', async () => {
    const list = await withTestTenant(async () => ctl.listDrivers(req));
    expect(Array.isArray(list)).toBe(true);

    const cred = await withTestTenant(async () =>
      ctl.addDriverCred(
        TEST_ADMIN_EMPLOYEE_ID,
        {
          credentialType: 'CDL',
          credentialNumber: 'CDL-XYZ',
          issuedDate: '2024-01-01',
          expiryDate: '2027-01-01',
        } as any,
        req,
      ),
    );
    expect(cred.credentialType).toBe('CDL');

    const credList = await withTestTenant(async () =>
      ctl.listDriverCreds(TEST_ADMIN_EMPLOYEE_ID),
    );
    expect(credList.map((c: any) => c.id)).toContain(cred.id);

    const patched = await withTestTenant(async () =>
      ctl.patchDriverCred(cred.id, { credentialNumber: 'CDL-XYZ-2' } as any, req),
    );
    expect(patched.credentialNumber).toBe('CDL-XYZ-2');
  });

  it('bus-passes — list + my', async () => {
    const list = await withTestTenant(async () => ctl.listBusPasses(req));
    expect(Array.isArray(list)).toBe(true);

    const mine = await withTestTenant(async () => ctl.myBusPass(req));
    expect(Array.isArray(mine)).toBe(true);
  });

  it('no-shows — list + run-once', async () => {
    const list = await withTestTenant(async () => ctl.listNoShows(req));
    expect(Array.isArray(list)).toBe(true);

    const r = await withTestTenant(async () => ctl.runNoShowSweep({} as any));
    expect(r).toBeTruthy();
  });

  it('delays — list', async () => {
    const list = await withTestTenant(async () => ctl.listDelays(req));
    expect(Array.isArray(list)).toBe(true);
  });

  it('change-log + change-requests — list', async () => {
    const log = await withTestTenant(async () => ctl.getChangeLog(TEST_ROUTE_ID, req));
    expect(Array.isArray(log)).toBe(true);

    const reqs = await withTestTenant(async () => ctl.listChangeRequests(req));
    expect(Array.isArray(reqs)).toBe(true);
  });
});
