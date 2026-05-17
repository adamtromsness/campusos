import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { VehiclePositionService } from './vehicle-position.service';
import {
  GeofenceService,
  haversineMetres,
  isPointInBoundary,
  pointInPolygon,
} from './geofence.service';
import { ETAService } from './eta.service';
import { DispatchService } from './dispatch.service';
import { ParentTrackingService } from './parent-tracking.service';
import { FleetStatusService } from './fleet-status.service';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { GpsFleetController } from './gps-fleet.controller';

const SCHOOL = {
  schoolId: '019e0f00-cccc-7000-8000-aaaa00000001',
  subdomain: 'demo',
} as never;

const ADMIN_ACTOR = {
  accountId: '019e0f00-cccc-7000-8000-bbbb00000001',
  personId: '019e0f00-cccc-7000-8000-bbbb00000002',
  employeeId: '019e0f00-cccc-7000-8000-bbbb00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const STAFF_ACTOR = {
  accountId: '019e0f00-cccc-7000-8000-cccc00000001',
  personId: '019e0f00-cccc-7000-8000-cccc00000002',
  employeeId: '019e0f00-cccc-7000-8000-cccc00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0f00-cccc-7000-8000-dddd00000001',
  personId: '019e0f00-cccc-7000-8000-dddd00000002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const GUARDIAN_ACTOR = {
  accountId: '019e0f00-cccc-7000-8000-eeee00000001',
  personId: '019e0f00-cccc-7000-8000-eeee00000002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;

const VEHICLE_ID = '019e0f00-cccc-7000-8000-ff0000000001';
const ROUTE_ID = '019e0f00-cccc-7000-8000-ff0000000002';
const STOP_ID = '019e0f00-cccc-7000-8000-ff0000000003';
const STUDENT_ID = '019e0f00-cccc-7000-8000-ff0000000004';
const GEOFENCE_ID = '019e0f00-cccc-7000-8000-ff0000000005';
const TOKEN_ID = '019e0f00-cccc-7000-8000-ff0000000006';

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'query' | 'execute';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'query' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'execute' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule?: string;
    key?: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    }),
  };
  return { outbox, enqueued };
}

function makePermCheck(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  return {
    hasAnyPermissionInTenant: vi.fn(async () => allow),
  };
}

// ============================================================
// Geofence math helpers
// ============================================================
describe('GeofenceService math — haversine + point-in-polygon', () => {
  it('haversineMetres — same point is zero', () => {
    expect(haversineMetres(39.7, -89.6, 39.7, -89.6)).toBeLessThan(0.001);
  });

  it('haversineMetres — 1 degree of latitude is ~111 km', () => {
    const d = haversineMetres(39.0, -89.6, 40.0, -89.6);
    expect(d).toBeGreaterThan(111000 - 200);
    expect(d).toBeLessThan(111200);
  });

  it('pointInPolygon — square boundary', () => {
    const square = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ];
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(5, 15, square)).toBe(false);
  });

  it('isPointInBoundary — circle hits center, misses far away', () => {
    const circle = {
      type: 'circle' as const,
      center: { lat: 39.7, lng: -89.6 },
      radius_metres: 200,
    };
    expect(isPointInBoundary(39.7, -89.6, circle)).toBe(true);
    // ~100m due north — well within 200m radius
    expect(isPointInBoundary(39.70091, -89.6, circle)).toBe(true);
    // ~500m due north — outside
    expect(isPointInBoundary(39.7045, -89.6, circle)).toBe(false);
  });

  it('isPointInBoundary — polygon hits inside, misses outside', () => {
    const poly = {
      type: 'polygon' as const,
      coordinates: [
        [39.698, -89.602],
        [39.702, -89.602],
        [39.702, -89.598],
        [39.698, -89.598],
        [39.698, -89.602],
      ],
    };
    expect(isPointInBoundary(39.7, -89.6, poly)).toBe(true);
    expect(isPointInBoundary(39.71, -89.6, poly)).toBe(false);
  });

  it('isPointInBoundary — unknown shape returns false', () => {
    expect(isPointInBoundary(0, 0, { type: 'bogus' as never })).toBe(false);
  });
});

// ============================================================
// VehiclePositionService — permission gate + ingest contract
// ============================================================
describe('VehiclePositionService — permission gate', () => {
  it('ingest() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new VehiclePositionService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.ingest(VEHICLE_ID, { latitude: 39.7, longitude: -89.6 }, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ingest() refuses GUARDIAN actors', async () => {
    const fake = makeFake(() => []);
    const svc = new VehiclePositionService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.ingest(VEHICLE_ID, { latitude: 39.7, longitude: -89.6 }, GUARDIAN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ingest() refuses bogus vehicleId not in current school', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id')) return [];
      return [];
    });
    const svc = new VehiclePositionService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.ingest(VEHICLE_ID, { latitude: 39.7, longitude: -89.6 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ingest() INSERTs a row and triggers geofence check', async () => {
    let calledCallback = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id')) return [{ ok: 1 }];
      return [];
    });
    const svc = new VehiclePositionService(fake.tenantPrisma as never);
    svc.setGeofenceCheckCallback(async () => {
      calledCallback = true;
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.ingest(VEHICLE_ID, { latitude: 39.7, longitude: -89.6, speedKmh: 25 }, ADMIN_ACTOR),
    );
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_vehicle_positions'),
    );
    expect(insert, 'INSERT into trn_vehicle_positions').toBeTruthy();
    expect(calledCallback).toBe(true);
  });

  it('ingest() — geofence check callback failure does NOT roll back the position', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id')) return [{ ok: 1 }];
      return [];
    });
    const svc = new VehiclePositionService(fake.tenantPrisma as never);
    svc.setGeofenceCheckCallback(async () => {
      throw new Error('boundary computation blew up');
    });
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.ingest(VEHICLE_ID, { latitude: 39.7, longitude: -89.6 }, ADMIN_ACTOR),
    );
    expect(result.id).toBeTruthy();
    // Position INSERT still happened
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_vehicle_positions'),
    );
    expect(insert).toBeTruthy();
  });
});

// ============================================================
// GeofenceService — boundary check + Kafka emit keystone
// ============================================================
describe('GeofenceService — boundary check + emit keystone', () => {
  it('create() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    // REVIEW-P2C11 BLOCKING 6 — non-admin without trn-002:write is refused.
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      positions,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            name: 'X',
            geofenceType: 'SCHOOL',
            boundary: {
              type: 'circle',
              center: { lat: 39.7, lng: -89.6 },
              radius_metres: 100,
            },
          },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create() validates polygon coordinate shape', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      positions,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            name: 'Bad',
            geofenceType: 'SPEED_ZONE',
            boundary: { type: 'polygon', coordinates: [[1, 2]] },
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() catches UNIQUE 23505 and translates to friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('insert into trn_geofences')) {
        const err: any = new Error('Unique constraint failed (23505)');
        err.meta = { code: '23505' };
        throw err;
      }
      return [];
    });
    const { kafka } = makeKafka();
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      positions,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            name: 'Dup',
            geofenceType: 'STOP',
            boundary: {
              type: 'circle',
              center: { lat: 39.7, lng: -89.6 },
              radius_metres: 100,
            },
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checkAndEmitEvents() — vehicle entering a circle geofence emits trn.geofence.entered', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_geofences') && sql.includes('is_active = true')) {
        return [
          {
            id: GEOFENCE_ID,
            school_id: SCHOOL.schoolId,
            name: 'Test SCHOOL',
            geofence_type: 'SCHOOL',
            boundary: {
              type: 'circle',
              center: { lat: 39.7, lng: -89.6 },
              radius_metres: 200,
            },
            speed_limit_kmh: null,
            is_active: true,
            description: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (
        sql.includes('from trn_geofence_events') &&
        sql.includes('order by recorded_at desc limit 1')
      ) {
        // No prior event — vehicle starts outside
        return [];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      outbox as never,
      positions,
      makePermCheck() as never,
    );

    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.checkAndEmitEvents(VEHICLE_ID, 39.7, -89.6, 25),
    );

    const insertEvent = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_geofence_events'),
    );
    expect(insertEvent, 'INSERT into trn_geofence_events').toBeTruthy();
    // REVIEW-P2C11 BLOCKING 3 — emit lands via outbox.enqueueInTx
    // inside the same tx as the geofence event INSERT.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('trn.geofence.entered');
    expect(enqueued[0]!.sourceModule).toBe('transport');
    expect(enqueued[0]!.eventId, 'deterministic event_id present').toBeTruthy();
    expect(enqueued[0]!.payload.eventType).toBe('ENTER');
    expect(enqueued[0]!.payload.vehicleId).toBe(VEHICLE_ID);
    expect(enqueued[0]!.payload.schoolId).toBe(SCHOOL.schoolId);
  });

  it('checkAndEmitEvents() — vehicle still inside emits nothing (no transition)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_geofences') && sql.includes('is_active = true')) {
        return [
          {
            id: GEOFENCE_ID,
            school_id: SCHOOL.schoolId,
            name: 'Test',
            geofence_type: 'SCHOOL',
            boundary: {
              type: 'circle',
              center: { lat: 39.7, lng: -89.6 },
              radius_metres: 200,
            },
            speed_limit_kmh: null,
            is_active: true,
            description: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (
        sql.includes('from trn_geofence_events') &&
        sql.includes('order by recorded_at desc limit 1')
      ) {
        // Prior event was ENTER — already inside
        return [{ event_type: 'ENTER' }];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      outbox as never,
      positions,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.checkAndEmitEvents(VEHICLE_ID, 39.7, -89.6, 25),
    );
    expect(enqueued).toHaveLength(0);
    const insertEvent = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_geofence_events'),
    );
    expect(insertEvent).toBeUndefined();
  });

  it('checkAndEmitEvents() — vehicle exits geofence emits trn.geofence.exited', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_geofences') && sql.includes('is_active = true')) {
        return [
          {
            id: GEOFENCE_ID,
            school_id: SCHOOL.schoolId,
            name: 'Test',
            geofence_type: 'SCHOOL',
            boundary: {
              type: 'circle',
              center: { lat: 39.7, lng: -89.6 },
              radius_metres: 200,
            },
            speed_limit_kmh: null,
            is_active: true,
            description: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (
        sql.includes('from trn_geofence_events') &&
        sql.includes('order by recorded_at desc limit 1')
      ) {
        return [{ event_type: 'ENTER' }];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const positions = new VehiclePositionService(fake.tenantPrisma as never);
    const svc = new GeofenceService(
      fake.tenantPrisma as never,
      outbox as never,
      positions,
      makePermCheck() as never,
    );
    // Move 1km away — far outside the 200m radius
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.checkAndEmitEvents(VEHICLE_ID, 39.71, -89.59, 35),
    );
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('trn.geofence.exited');
    expect(enqueued[0]!.eventId, 'deterministic event_id present').toBeTruthy();
    expect(enqueued[0]!.payload.eventType).toBe('EXIT');
  });
});

// ============================================================
// ETAService — UPSERT keystone + tenant validation
// ============================================================
describe('ETAService — UPSERT + permission gate', () => {
  it('upsert() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new ETAService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsert(VEHICLE_ID, STOP_ID, { eta: '2026-05-11T08:30:00Z' }, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('upsert() refuses bogus vehicleId or stopId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select') && sql.includes('v_ok')) {
        return [{ v_ok: null, s_ok: 1 }];
      }
      return [];
    });
    const svc = new ETAService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.upsert(VEHICLE_ID, STOP_ID, { eta: '2026-05-11T08:30:00Z' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upsert() emits an INSERT ... ON CONFLICT (vehicle_id, stop_id) DO UPDATE statement', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select') && sql.includes('v_ok')) {
        return [{ v_ok: 1, s_ok: 1 }];
      }
      if (sql.includes('from trn_vehicle_eta')) {
        return [
          {
            id: 'eta-1',
            vehicle_id: VEHICLE_ID,
            vehicle_registration: 'BUS-42',
            stop_id: STOP_ID,
            stop_name: 'A',
            eta: new Date('2026-05-11T08:30:00Z'),
            computed_at: new Date(),
            confidence: 'HIGH',
            distance_metres: '1200',
          },
        ];
      }
      return [];
    });
    const svc = new ETAService(fake.tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.upsert(VEHICLE_ID, STOP_ID, { eta: '2026-05-11T08:30:00Z' }, ADMIN_ACTOR),
    );
    const upsert = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('insert into trn_vehicle_eta') &&
        c.sql.toLowerCase().includes('on conflict (vehicle_id, stop_id)'),
    );
    expect(upsert, 'INSERT ... ON CONFLICT (vehicle_id, stop_id) DO UPDATE').toBeTruthy();
  });
});

// ============================================================
// DispatchService — 8-value event_type + ref validation
// ============================================================
describe('DispatchService — permission gate + validation', () => {
  it('create() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new DispatchService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ eventType: 'ROUTE_STARTED' }, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create() refuses bogus vehicleId not in school', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id')) return [];
      return [];
    });
    const svc = new DispatchService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ eventType: 'DELAY_REPORTED', vehicleId: VEHICLE_ID }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() — happy path INSERTs with event_data JSONB', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id')) return [{ ok: 1 }];
      if (sql.includes('from trn_routes where id')) return [{ ok: 1 }];
      if (sql.includes('from trn_dispatch_events') && sql.includes('where e.id')) {
        return [
          {
            id: 'evt-1',
            school_id: SCHOOL.schoolId,
            vehicle_id: VEHICLE_ID,
            vehicle_registration: 'BUS-42',
            route_id: ROUTE_ID,
            route_name: 'Route 7',
            driver_id: null,
            event_type: 'DELAY_REPORTED',
            event_data: { minutes_delayed: 5 },
            recorded_at: new Date(),
            recorded_by: ADMIN_ACTOR.accountId,
            notes: null,
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new DispatchService(fake.tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.create(
        {
          eventType: 'DELAY_REPORTED',
          vehicleId: VEHICLE_ID,
          routeId: ROUTE_ID,
          eventData: { minutes_delayed: 5 },
        },
        ADMIN_ACTOR,
      ),
    );
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_dispatch_events'),
    );
    expect(insert, 'INSERT into trn_dispatch_events').toBeTruthy();
  });
});

// ============================================================
// ParentTrackingService — TOKEN KEYSTONE: unauth, scoped, revoke
// ============================================================
describe('ParentTrackingService — token keystone', () => {
  it('createToken() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    // REVIEW-P2C11 BLOCKING 6 — non-admin without trn-001:write is refused.
    const svc = new ParentTrackingService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createToken({ studentId: STUDENT_ID, routeId: ROUTE_ID }, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createToken() refuses bogus studentId', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select') && sql.includes('s_ok')) {
        return [{ s_ok: null, r_ok: 1 }];
      }
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.createToken({ studentId: STUDENT_ID, routeId: ROUTE_ID }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createToken() revokes prior active tokens for the same (student, route) pair', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select') && sql.includes('s_ok')) {
        return [{ s_ok: 1, r_ok: 1 }];
      }
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    const token = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createToken({ studentId: STUDENT_ID, routeId: ROUTE_ID, expiresInDays: 14 }, ADMIN_ACTOR),
    );
    expect(token.token).toHaveLength(64); // 32 random bytes hex-encoded
    expect(token.isActive).toBe(true);
    const revoke = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('update trn_parent_tracking_tokens') &&
        c.sql.toLowerCase().includes('is_active = false'),
    );
    expect(revoke, 'UPDATE prior active tokens to is_active=false').toBeTruthy();
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_parent_tracking_tokens'),
    );
    expect(insert, 'INSERT new token').toBeTruthy();
  });

  it('viewByToken() — UNAUTH path returns 404 for unknown token', async () => {
    const fake = makeFake(() => []);
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.viewByToken('bogus-token-not-in-db'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('viewByToken() — refuses revoked token with 403', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_parent_tracking_tokens t')) {
        return [
          {
            student_id: STUDENT_ID,
            route_id: ROUTE_ID,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            is_active: false,
            route_name: 'R',
            route_direction: 'AM',
            vehicle_id: null,
            vehicle_registration: null,
          },
        ];
      }
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.viewByToken('revoked-token')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('viewByToken() — refuses expired token with 403', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_parent_tracking_tokens t')) {
        return [
          {
            student_id: STUDENT_ID,
            route_id: ROUTE_ID,
            expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
            is_active: true,
            route_name: 'R',
            route_direction: 'AM',
            vehicle_id: null,
            vehicle_registration: null,
          },
        ];
      }
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.viewByToken('expired-token')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('viewByToken() — active token surfaces vehicle position + scoped stop ETA, NO student PII', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_parent_tracking_tokens t')) {
        return [
          {
            student_id: STUDENT_ID,
            route_id: ROUTE_ID,
            expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            is_active: true,
            route_name: 'Route 7 — Elm Street AM',
            route_direction: 'AM',
            vehicle_id: VEHICLE_ID,
            vehicle_registration: 'BUS-42',
          },
        ];
      }
      if (sql.includes('from trn_vehicle_positions')) {
        return [
          {
            lat: '39.7',
            lng: '-89.6',
            speed_kmh: '25',
            heading: '180',
            recorded_at: new Date('2026-05-11T08:00:00Z'),
          },
        ];
      }
      if (sql.includes('from trn_student_assignments')) {
        return [
          {
            stop_id: STOP_ID,
            stop_name: 'Elm Street Stop 1',
            eta: new Date(Date.now() + 8 * 60 * 1000),
            confidence: 'HIGH',
          },
        ];
      }
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    const view = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.viewByToken('active-token-x'),
    );
    expect(view.routeName).toBe('Route 7 — Elm Street AM');
    expect(view.vehicle?.registration).toBe('BUS-42');
    expect(view.stopEta?.stopName).toBe('Elm Street Stop 1');
    expect(view.stopEta?.confidence).toBe('HIGH');
    // VERIFY NO student PII leaks into the public payload
    // The DTO shape doesn't expose studentId or studentName.
    expect((view as Record<string, unknown>).studentId).toBeUndefined();
    expect((view as Record<string, unknown>).studentName).toBeUndefined();
  });
});

// ============================================================
// FleetStatusService — materialise + admin-only
// ============================================================
describe('FleetStatusService — materialiser + admin gate', () => {
  it('materialiseForVehicle() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new FleetStatusService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.materialiseForVehicle(VEHICLE_ID, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('materialiseAll() refuses STAFF without admin', async () => {
    const fake = makeFake(() => []);
    const svc = new FleetStatusService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.materialiseAll(STAFF_ACTOR)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('materialiseForVehicle() — UPSERT keystone runs ON CONFLICT (vehicle_id) DO UPDATE', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicles where id = $1::uuid and school_id')) {
        return [{ id: VEHICLE_ID, registration: 'BUS-42', status: 'ACTIVE' }];
      }
      if (sql.includes('from trn_vehicle_documents')) return [];
      if (sql.includes('from trn_routes r')) return [];
      if (sql.includes('from trn_vehicle_repairs')) return [{ n: 0 }];
      if (sql.includes('max(recorded_at)')) return [{ last_at: null }];
      if (sql.includes('from trn_routes where vehicle_id')) return [];
      if (sql.includes('sum(fuel_quantity)')) {
        return [{ total_fuel: null, max_odo: null, min_odo: null, n: 0 }];
      }
      if (sql.includes('from rpt_fleet_status')) {
        return [
          {
            id: 'fs-1',
            vehicle_id: VEHICLE_ID,
            school_id: SCHOOL.schoolId,
            vehicle_registration: 'BUS-42',
            vehicle_status: 'ACTIVE',
            days_until_insurance_expiry: null,
            days_until_registration_expiry: null,
            days_until_mot_expiry: null,
            days_until_licence_expiry: null,
            maintenance_overdue: false,
            last_incident_date: null,
            total_incidents_this_year: 0,
            current_route_assignment: null,
            current_route_id: null,
            last_position_at: null,
            fuel_efficiency_last_month: null,
            open_safety_critical_repair_count: 0,
            materialised_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new FleetStatusService(fake.tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.materialiseForVehicle(VEHICLE_ID, ADMIN_ACTOR),
    );
    const upsert = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('insert into rpt_fleet_status') &&
        c.sql.toLowerCase().includes('on conflict (vehicle_id) do update'),
    );
    expect(upsert, 'UPSERT into rpt_fleet_status ON CONFLICT (vehicle_id)').toBeTruthy();
  });
});

// ============================================================
// GpsFleetController — @Public on parent tracking + permission metadata
// ============================================================
describe('GpsFleetController — permission metadata', () => {
  it('viewByToken() is @Public()', () => {
    const ctrl = GpsFleetController.prototype as never;
    const meta = Reflect.getMetadata('isPublic', (ctrl as any).viewByToken);
    expect(meta).toBe(true);
  });

  it('ingestPosition() requires trn-002:write', () => {
    const ctrl = GpsFleetController.prototype as never;
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, (ctrl as any).ingestPosition);
    expect(perms).toEqual(['trn-002:write']);
  });

  it('listGeofences() requires trn-002:read', () => {
    const ctrl = GpsFleetController.prototype as never;
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, (ctrl as any).listGeofences);
    expect(perms).toEqual(['trn-002:read']);
  });

  it('createTrackingToken() requires trn-001:write', () => {
    const ctrl = GpsFleetController.prototype as never;
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, (ctrl as any).createTrackingToken);
    expect(perms).toEqual(['trn-001:write']);
  });

  it('materialiseAll() requires trn-002:admin', () => {
    const ctrl = GpsFleetController.prototype as never;
    const perms = Reflect.getMetadata(PERMISSIONS_KEY, (ctrl as any).materialiseAll);
    expect(perms).toEqual(['trn-002:admin']);
  });
});

// ============================================================
// REVIEW-P2C11 ROUND 1 — parent token school-defence + outbox
// ============================================================
describe('REVIEW-P2C11 ROUND 1 — ParentTrackingService school-defensive', () => {
  it('BLOCKING 4 — viewByToken lookup filters on school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () => svc.viewByToken('cross-school-token')),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The SQL must contain school_id predicate on the token lookup.
    const lookup = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from trn_parent_tracking_tokens t'),
    );
    expect(lookup, 'viewByToken lookup SQL').toBeTruthy();
    expect(lookup!.sql.toLowerCase()).toContain('t.school_id = $2::uuid');
  });

  it('BLOCKING 4 — revokeToken UPDATE filters on school_id', async () => {
    const fake = makeFake(() => 0);
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.revokeToken('019e0f00-cccc-7000-8000-aaaa11110000', ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const update = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('update trn_parent_tracking_tokens set is_active = false') &&
        c.sql.toLowerCase().includes('school_id = $2::uuid'),
    );
    expect(update, 'revoke UPDATE carries school_id').toBeTruthy();
  });

  it('BLOCKING 4 — listForStudent SELECT filters on school_id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from sis_students where id')) return [{ ok: 1 }];
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listForStudent(STUDENT_ID));
    const list = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('from trn_parent_tracking_tokens') &&
        c.sql.toLowerCase().includes('order by created_at desc'),
    );
    expect(list, 'listForStudent SELECT').toBeTruthy();
    expect(list!.sql.toLowerCase()).toContain('school_id = $1::uuid');
  });

  it('BLOCKING 4 — createToken INSERT carries school_id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('s_ok') && sql.includes('r_ok')) return [{ s_ok: 1, r_ok: 1 }];
      return [];
    });
    const svc = new ParentTrackingService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.createToken({ studentId: STUDENT_ID, routeId: ROUTE_ID }, ADMIN_ACTOR),
    );
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_parent_tracking_tokens'),
    );
    expect(insert, 'token INSERT').toBeTruthy();
    // Columns include school_id — the new migration 139 column.
    expect(insert!.sql.toLowerCase()).toContain('school_id');
  });
});

describe('REVIEW-P2C11 ROUND 1 — Geofence deterministic event id', () => {
  it('BLOCKING 3 — deterministicGeofenceEventEventId is stable + v5-shaped per ENTER/EXIT', async () => {
    const { deterministicGeofenceEventEventId } = await import('./geofence.service');
    const enterA = deterministicGeofenceEventEventId('gfe-1', 'ENTER');
    const enterB = deterministicGeofenceEventEventId('gfe-1', 'ENTER');
    const exitC = deterministicGeofenceEventEventId('gfe-1', 'EXIT');
    expect(enterA).toBe(enterB);
    expect(enterA).not.toBe(exitC);
    expect(enterA.charAt(14)).toBe('5');
    expect(exitC.charAt(14)).toBe('5');
  });
});
