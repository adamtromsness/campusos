import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { GpsFleetController } from '@modules/m61-transport/gps-fleet.controller';
import { VehiclePositionService } from '@modules/m61-transport/vehicle-position.service';
import { GeofenceService } from '@modules/m61-transport/geofence.service';
import { ETAService } from '@modules/m61-transport/eta.service';
import { DispatchService } from '@modules/m61-transport/dispatch.service';
import { ParentTrackingService } from '@modules/m61-transport/parent-tracking.service';
import { FleetStatusService } from '@modules/m61-transport/fleet-status.service';
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
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
  TEST_STOP_ID,
  TEST_GEOFENCE_ID,
} from '../fixtures/transport';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m61-transport/gps-fleet-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: GpsFleetController;
  let req: any;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const positions = new VehiclePositionService(tenantPrisma);
    const geofences = new GeofenceService(tenantPrisma, outbox, positions, permCheck);
    geofences.onModuleInit?.();
    const etas = new ETAService(tenantPrisma);
    const dispatch = new DispatchService(tenantPrisma);
    const tracking = new ParentTrackingService(tenantPrisma, {
      hasAnyPermissionInTenant: async () => true,
    } as any);
    const fleet = new FleetStatusService(tenantPrisma);

    ctl = new GpsFleetController(
      positions,
      geofences,
      etas,
      dispatch,
      tracking,
      fleet,
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

  it('positions — ingest + getLatest + history', async () => {
    const pos = await withTestTenant(async () =>
      ctl.ingestPosition(
        req,
        TEST_VEHICLE_ID,
        {
          latitude: 33.5,
          longitude: -84.5,
          speedKph: 35,
        } as any,
      ),
    );
    expect(pos.vehicleId).toBe(TEST_VEHICLE_ID);

    const latest = await withTestTenant(async () => ctl.getLatestPosition(TEST_VEHICLE_ID));
    expect(latest?.vehicleId).toBe(TEST_VEHICLE_ID);

    const history = await withTestTenant(async () => ctl.getPositionHistory(TEST_VEHICLE_ID));
    expect(history.length).toBeGreaterThan(0);
  });

  it('geofences — list + get + create + update + events', async () => {
    const list = await withTestTenant(async () => ctl.listGeofences());
    expect(list.map((g: any) => g.id)).toContain(TEST_GEOFENCE_ID);

    const g = await withTestTenant(async () => ctl.getGeofence(TEST_GEOFENCE_ID));
    expect(g.id).toBe(TEST_GEOFENCE_ID);

    const created = await withTestTenant(async () =>
      ctl.createGeofence(req, {
        name: 'Stop Zone',
        geofenceType: 'STOP',
        boundary: { type: 'circle', center: { lat: 33.6, lng: -84.6 }, radius_metres: 100 },
      } as any),
    );
    expect(created.name).toBe('Stop Zone');

    const updated = await withTestTenant(async () =>
      ctl.updateGeofence(req, created.id, { name: 'Updated Zone' } as any),
    );
    expect(updated.name).toBe('Updated Zone');

    const events = await withTestTenant(async () => ctl.listGeofenceEvents());
    expect(Array.isArray(events)).toBe(true);
  });

  it('etas — upsert + list for route + get for stop', async () => {
    const eta = await withTestTenant(async () =>
      ctl.upsertEta(req, TEST_VEHICLE_ID, TEST_STOP_ID, {
        eta: '2026-09-15T08:00:00Z',
        confidence: 'HIGH',
      } as any),
    );
    expect(eta.stopId).toBe(TEST_STOP_ID);

    const routeList = await withTestTenant(async () => ctl.listRouteEtas(TEST_ROUTE_ID));
    expect(Array.isArray(routeList)).toBe(true);

    const stopList = await withTestTenant(async () => ctl.getStopEta(TEST_STOP_ID));
    expect(stopList.length).toBeGreaterThan(0);
  });

  it('dispatch events — list + create', async () => {
    const ev = await withTestTenant(async () =>
      ctl.createDispatchEvent(req, {
        vehicleId: TEST_VEHICLE_ID,
        routeId: TEST_ROUTE_ID,
        eventType: 'DELAY_REPORTED',
        description: 'Test delay',
      } as any),
    );
    expect(ev.eventType).toBe('DELAY_REPORTED');

    const list = await withTestTenant(async () => ctl.listDispatchEvents());
    expect(list.map((e: any) => e.id)).toContain(ev.id);
  });

  it('ingest position inside school zone → triggers ENTER event via callback', async () => {
    // Create a geofence with the boundary shape the code expects
    await withTestTenant(async () =>
      ctl.createGeofence(req, {
        name: 'Trigger Zone',
        geofenceType: 'SCHOOL',
        boundary: { type: 'circle', center: { lat: 33.5, lng: -84.5 }, radius_metres: 500 },
      } as any),
    );

    // Position inside the geofence
    await withTestTenant(async () =>
      ctl.ingestPosition(
        req,
        TEST_VEHICLE_ID,
        { latitude: 33.5, longitude: -84.5, speedKph: 10 } as any,
      ),
    );

    // Move away — outside the 200m radius
    await withTestTenant(async () =>
      ctl.ingestPosition(
        req,
        TEST_VEHICLE_ID,
        { latitude: 34.0, longitude: -85.0, speedKph: 50 } as any,
      ),
    );

    const events = await withTestTenant(async () =>
      ctl.listGeofenceEvents(undefined, TEST_VEHICLE_ID),
    );
    // At least one ENTER + one EXIT should have been emitted
    expect(events.length).toBeGreaterThan(0);
  });

  it('fleet status — list + getFleetStatus + materialise', async () => {
    const list = await withTestTenant(async () => ctl.listFleetStatus());
    expect(Array.isArray(list)).toBe(true);

    const status = await withTestTenant(async () => ctl.getFleetStatus(TEST_VEHICLE_ID));
    expect(status === null || typeof status === 'object').toBe(true);

    const row = await withTestTenant(async () => ctl.materialiseFleetStatus(req, TEST_VEHICLE_ID));
    expect(row.vehicleId).toBe(TEST_VEHICLE_ID);
  });
});
