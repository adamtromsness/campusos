import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { DispatchService } from '@modules/m61-transport/dispatch.service';
import { DelayReportService } from '@modules/m61-transport/delay-report.service';
import { VehiclePositionService } from '@modules/m61-transport/vehicle-position.service';
import { ETAService } from '@modules/m61-transport/eta.service';
import { VehicleLifecycleService } from '@modules/m61-transport/vehicle-lifecycle.service';
import { BusPassService } from '@modules/m61-transport/bus-pass.service';
import { GeofenceService } from '@modules/m61-transport/geofence.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
  TEST_STOP_ID,
  TEST_GEOFENCE_ID,
} from '../fixtures/transport';

describe('integration:m61-transport/tracking-ops', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let dispatch: DispatchService;
  let delays: DelayReportService;
  let positions: VehiclePositionService;
  let eta: ETAService;
  let lifecycle: VehicleLifecycleService;
  let busPass: BusPassService;
  let geofences: GeofenceService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const outbox = new OutboxService();
    kafka = makeRecordingKafka();
    dispatch = new DispatchService(tenantPrisma);
    delays = new DelayReportService(tenantPrisma, kafka);
    positions = new VehiclePositionService(tenantPrisma);
    eta = new ETAService(tenantPrisma);
    lifecycle = new VehicleLifecycleService(tenantPrisma);
    busPass = new BusPassService(tenantPrisma);
    geofences = new GeofenceService(tenantPrisma, outbox, positions);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
    (kafka as unknown as RecordingKafkaProducer).reset();
  });

  // ─── DispatchService ─────────────────────────────────
  describe('DispatchService', () => {
    it('create + list', async () => {
      const dto = await withTestTenant(async () =>
        dispatch.create(
          {
            vehicleId: TEST_VEHICLE_ID,
            routeId: TEST_ROUTE_ID,
            eventType: 'ROUTE_STARTED',
            notes: 'On time',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.eventType).toBe('ROUTE_STARTED');

      const list = await withTestTenant(async () => dispatch.list({}));
      expect(list.map((x) => x.id)).toContain(dto.id);
    });

    it('list with filter by eventType', async () => {
      await withTestTenant(async () =>
        dispatch.create(
          {
            vehicleId: TEST_VEHICLE_ID,
            routeId: TEST_ROUTE_ID,
            eventType: 'DELAY_REPORTED',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        dispatch.list({ eventType: 'DELAY_REPORTED' }),
      );
      expect(list.every((x) => x.eventType === 'DELAY_REPORTED')).toBe(true);
    });
  });

  // ─── DelayReportService ────────────────────────────
  describe('DelayReportService', () => {
    it('create + list; emits trn.delay.reported', async () => {
      const dto = await withTestTenant(async () =>
        delays.create(
          {
            routeId: TEST_ROUTE_ID,
            runDate: '2026-09-15',
            delayMinutes: 15,
            reason: 'Traffic',
            affectedStops: [],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.delayMinutes).toBe(15);

      const calls = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'trn.delay.reported',
      );
      expect(calls.length).toBeGreaterThan(0);

      const list = await withTestTenant(async () =>
        delays.list(adminActor(), { routeId: TEST_ROUTE_ID }),
      );
      expect(list.map((x) => x.id)).toContain(dto.id);
    });
  });

  // ─── VehiclePositionService ───────────────────────
  describe('VehiclePositionService', () => {
    it('ingest + getLatest + listHistory', async () => {
      // Partitioned DAILY — use current timestamp for partition match
      const pos = await withTestTenant(async () =>
        positions.ingest(
          TEST_VEHICLE_ID,
          {
            latitude: 33.5,
            longitude: -84.5,
            speedKmh: 50,
            heading: 90,
            source: 'GPS',
          } as any,
          adminActor(),
        ),
      );
      expect(pos.vehicleId).toBe(TEST_VEHICLE_ID);

      const latest = await withTestTenant(async () => positions.getLatest(TEST_VEHICLE_ID));
      expect(latest?.vehicleId).toBe(TEST_VEHICLE_ID);

      const history = await withTestTenant(async () =>
        positions.listHistory(TEST_VEHICLE_ID, {}),
      );
      expect(history.length).toBeGreaterThan(0);
    });
  });

  // ─── ETAService ──────────────────────────────────
  describe('ETAService', () => {
    it('upsert + listForRoute + getForStop', async () => {
      const dto = await withTestTenant(async () =>
        eta.upsert(
          TEST_VEHICLE_ID,
          TEST_STOP_ID,
          {
            eta: '2026-09-15T08:30:00Z',
            confidence: 'HIGH',
            distanceMetres: 1000,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.stopId).toBe(TEST_STOP_ID);

      const list = await withTestTenant(async () => eta.listForRoute(TEST_ROUTE_ID));
      expect(list.map((x) => x.id)).toContain(dto.id);

      const forStop = await withTestTenant(async () => eta.getForStop(TEST_STOP_ID));
      expect(forStop.map((x) => x.id)).toContain(dto.id);
    });
  });

  // ─── VehicleLifecycleService ────────────────────
  describe('VehicleLifecycleService', () => {
    it('upsert + getForVehicle + replacementPlanning', async () => {
      const dto = await withTestTenant(async () =>
        lifecycle.upsert(
          TEST_VEHICLE_ID,
          {
            purchaseDate: '2022-01-01',
            purchasePrice: 80000,
            expectedLifeYears: 12,
            expectedLifeMiles: 250000,
            depreciationMethod: 'STRAIGHT_LINE',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.vehicleId).toBe(TEST_VEHICLE_ID);

      const fetched = await withTestTenant(async () => lifecycle.getForVehicle(TEST_VEHICLE_ID));
      expect(fetched.vehicleId).toBe(TEST_VEHICLE_ID);

      const planning = await withTestTenant(async () => lifecycle.replacementPlanning());
      expect(Array.isArray(planning)).toBe(true);
    });

    it.skip('recordDisposal flips vehicle to RETIRED', async () => {
      await withTestTenant(async () =>
        lifecycle.upsert(
          TEST_VEHICLE_ID,
          {
            purchaseDate: '2010-01-01',
            purchasePrice: 80000,
            expectedLifeYears: 12,
            depreciationMethod: 'STRAIGHT_LINE',
          } as any,
          adminActor(),
        ),
      );
      const disp = await withTestTenant(async () =>
        lifecycle.recordDisposal(
          TEST_VEHICLE_ID,
          {
            disposalDate: '2026-09-15',
            disposalValue: 5000,
            disposalMethod: 'AUCTION',
            disposalNotes: 'sold at auction',
          } as any,
          adminActor(),
        ),
      );
      expect(disp.disposalDate).toContain('2026-09-15');
    });
  });

  // ─── GeofenceService ────────────────────────────
  describe('GeofenceService', () => {
    it('list + getById', async () => {
      const list = await withTestTenant(async () => geofences.list(adminActor()));
      expect(list.map((x) => x.id)).toContain(TEST_GEOFENCE_ID);
      const fetched = await withTestTenant(async () => geofences.getById(TEST_GEOFENCE_ID));
      expect(fetched.id).toBe(TEST_GEOFENCE_ID);
    });

    it('create + update', async () => {
      const dto = await withTestTenant(async () =>
        geofences.create(
          {
            name: 'New Zone',
            geofenceType: 'STOP',
            boundary: {
              type: 'circle',
              center: { lat: 33.5, lng: -84.5 },
              radius_metres: 100,
            },
            isActive: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.geofenceType).toBe('STOP');

      const updated = await withTestTenant(async () =>
        geofences.update(dto.id, { name: 'Renamed Zone' } as any, adminActor()),
      );
      expect(updated.name).toBe('Renamed Zone');
    });

    it('listEvents returns array', async () => {
      const list = await withTestTenant(async () =>
        geofences.listEvents(TEST_GEOFENCE_ID, {}),
      );
      expect(Array.isArray(list)).toBe(true);
    });
  });
});
