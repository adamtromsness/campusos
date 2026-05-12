import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { FireDrillService } from './fire-drill.service';
import { AssetService } from './asset.service';
import { EnergyService } from './energy.service';
import { SpaceUtilisationService } from './space-utilisation.service';
import { SustainabilityService } from './sustainability.service';
import { FacilitiesAssetsController } from './facilities-assets.controller';
import {
  deterministicFireDrillOverdueEventId,
  deterministicRouteStopIssueNotedEventId,
} from './event-ids';

/**
 * P2-18b Facilities Assets + Energy vertical-slice spec.
 *
 * Coverage:
 *   S1  deterministicFireDrillOverdueEventId stable + v5-shape + (date)
 *       sensitivity.
 *   S2  FireDrillService.create computes met_target from
 *       targetEvacuationSeconds and stamps NULL when no target.
 *   S3  FireDrillService.compliance emits fac.fire_drill.overdue per
 *       overdue building and skips healthy buildings.
 *   S4  AssetService.dispose KEYSTONE — refuses non-DECOMMISSIONED.
 *   S5  AssetService.dispose ACCEPTS when status=DECOMMISSIONED.
 *   S6  AssetService.dispose refuses double-dispose via UNIQUE(asset_id)
 *       23505 translation.
 *   S7  AssetService.decommission stamps decommissioned_at +
 *       decommissioned_by in the same UPDATE (multi-column decom_chk
 *       satisfied atomically).
 *   S8  EnergyService.recordReading KEYSTONE auto-computes consumption
 *       from previous reading on the same meter; first reading → NULL.
 *   S9  EnergyService.recordReading refuses a reading_value lower than
 *       the prior reading (meter rollback).
 *   S10 EnergyService.recordReading 23505 UNIQUE(meter_id, reading_date)
 *       → friendly 409.
 *   S11 SpaceUtilisationService.record materialises utilisation_rate as
 *       occupancy/capacity at insert time + refuses occupancy>capacity.
 *   S12 SustainabilityService.create + UNIQUE(school,name) → 409.
 *   S13 Controller permission metadata pinned to FAC-004 / FAC-005.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e1c39-aaaa-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e1c39-aaaa-7556-8c81-000000000001',
  personId: '019e1c39-aaaa-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e1c39-aaaa-7556-8c81-000000000099',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e1c39-aaaa-7556-8c81-200000000001',
  personId: '019e1c39-aaaa-7556-8c81-200000000002',
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const BUILDING_ID = '019e1c39-aaaa-7556-8c81-900000000001';
const BUILDING_ID_2 = '019e1c39-aaaa-7556-8c81-900000000002';
const ASSET_ID = '019e1c39-aaaa-7556-8c81-a00000000001';
const METER_ID = '019e1c39-aaaa-7556-8c81-b00000000001';
const SPACE_ID = '019e1c39-aaaa-7556-8c81-c00000000001';
const CATEGORY_ID = '019e1c39-aaaa-7556-8c81-d00000000001';
const AUTH_ID = '019e1c39-aaaa-7556-8c81-e00000000001';

interface CapturedCall {
  sql: string;
  args: unknown[];
}

function makeFake(responder?: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...args: unknown[]): Promise<T> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      return (r ?? []) as T;
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]): Promise<number> => {
      capture.push({ sql, args });
      const r = responder?.({ sql, args });
      if (typeof r === 'number') return r;
      return 1;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
    executeInTenantTransaction: async <T = unknown>(fn: (c: unknown) => Promise<T>): Promise<T> =>
      fn(client),
    executeInExplicitSchema: async <T = unknown>(
      _schema: string,
      fn: (c: unknown) => Promise<T>,
    ): Promise<T> => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeKafka() {
  const emits: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  // REVIEW-P2C18 BLOCKING 1 — FireDrillService now takes an OutboxService
  // (not KafkaProducerService). The shared stub provides both
  // `emit` (legacy) and `enqueueInTx` (current) and routes both onto
  // the same emits array so the assertions in S3 keep matching.
  const stub = {
    emit: async (opts: {
      topic: string;
      key: string;
      sourceModule: string;
      eventId?: string;
      payload: Record<string, unknown>;
    }) => {
      emits.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
    enqueueInTx: async (
      _tx: unknown,
      opts: {
        topic: string;
        key: string;
        sourceModule: string;
        eventId?: string;
        payload: Record<string, unknown>;
      },
    ) => {
      emits.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    },
  };
  return {
    emits,
    kafka: stub,
  };
}

function makePerms(grant = true) {
  return { hasAnyPermissionInTenant: async () => grant };
}

describe('Facilities Assets + Energy — P2-18b', () => {
  // ─── S1: deterministic event-id helper ───
  it('S1: deterministicFireDrillOverdueEventId stable + v5-shape + (date) sensitivity', () => {
    const a = deterministicFireDrillOverdueEventId(BUILDING_ID, '2026-05-12');
    const b = deterministicFireDrillOverdueEventId(BUILDING_ID, '2026-05-12');
    expect(a).toBe(b);
    // v5 marker nibble
    expect(a[14]).toBe('5');
    // RFC-4122 variant
    expect(['8', '9', 'a', 'b']).toContain(a[19]);

    // Different building OR different date → different envelope id
    const c = deterministicFireDrillOverdueEventId(BUILDING_ID_2, '2026-05-12');
    expect(a).not.toBe(c);
    const d = deterministicFireDrillOverdueEventId(BUILDING_ID, '2026-05-13');
    expect(a).not.toBe(d);

    // Different from the P2-18a helper namespace
    const other = deterministicRouteStopIssueNotedEventId(BUILDING_ID);
    expect(a).not.toBe(other);
  });

  // ─── S2: FireDrill.create computes met_target ───
  it('S2: FireDrillService.create computes met_target from targetEvacuationSeconds', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_buildings WHERE id')) return [{ ok: 1 }];
      if (sql.includes('FROM fac_fire_drills')) return [];
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new FireDrillService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.create(
        {
          buildingId: BUILDING_ID,
          drillDate: '2026-05-01',
          drillTime: '10:15',
          durationSeconds: 600,
          totalOccupants: 420,
          evacuationTimeSeconds: 280,
          targetEvacuationSeconds: 300,
        },
        ADMIN_ACTOR,
      );
    });
    const insert = capture.find((c) => c.sql.includes('INSERT INTO fac_fire_drills'));
    expect(insert).toBeDefined();
    // met_target arg is position $10 — index 9 in zero-based args array
    expect(insert!.args[9]).toBe(true);
  });

  it('S2b: FireDrillService.create stamps met_target=null when no target', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_buildings WHERE id')) return [{ ok: 1 }];
      if (sql.includes('FROM fac_fire_drills')) return [];
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new FireDrillService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.create(
        {
          buildingId: BUILDING_ID,
          drillDate: '2026-05-01',
          drillTime: '10:15',
          durationSeconds: 600,
          totalOccupants: 420,
          evacuationTimeSeconds: 380,
        },
        ADMIN_ACTOR,
      );
    });
    const insert = capture.find((c) => c.sql.includes('INSERT INTO fac_fire_drills'));
    expect(insert!.args[9]).toBeNull();
  });

  // ─── S3: compliance emits per overdue building ───
  it('S3: compliance emits fac.fire_drill.overdue per overdue building', async () => {
    const overdueId = BUILDING_ID;
    const healthyId = BUILDING_ID_2;
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_buildings b')) {
        return [
          {
            building_id: overdueId,
            building_name: 'Main Building',
            last_drill_date: '2025-08-01',
            days_since_last_drill: 250,
            is_overdue: true,
          },
          {
            building_id: healthyId,
            building_name: 'Annex',
            last_drill_date: '2026-04-01',
            days_since_last_drill: 41,
            is_overdue: false,
          },
        ];
      }
      return [];
    });
    const { kafka, emits } = makeKafka();
    const svc = new FireDrillService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.compliance());
    expect(result).toHaveLength(2);
    // exactly one envelope for the overdue building, none for the healthy one
    expect(emits).toHaveLength(1);
    expect(emits[0]!.topic).toBe('fac.fire_drill.overdue');
    expect(emits[0]!.key).toBe(overdueId);
    expect(emits[0]!.sourceModule).toBe('facilities');
    expect(emits[0]!.eventId).toBeDefined();
    // deterministic envelope id
    expect(emits[0]!.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  });

  // ─── S4: Dispose KEYSTONE refuses non-DECOMMISSIONED ───
  it('S4: AssetService.dispose refuses non-DECOMMISSIONED asset', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('SELECT status, school_id::text AS school_id FROM fac_assets')) {
        return [{ status: 'ACTIVE', school_id: SCHOOL.schoolId }];
      }
      return [];
    });
    const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.dispose(
          ASSET_ID,
          {
            disposalMethod: 'SCRAP',
            disposalDate: '2026-05-01',
            authorisedById: AUTH_ID,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S5: Dispose accepts when DECOMMISSIONED ───
  it('S5: AssetService.dispose ACCEPTS when status=DECOMMISSIONED', async () => {
    let inserted = false;
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('SELECT status, school_id::text AS school_id FROM fac_assets')) {
        return [{ status: 'DECOMMISSIONED', school_id: SCHOOL.schoolId }];
      }
      if (sql.includes('INSERT INTO fac_asset_disposals')) {
        inserted = true;
        return 1;
      }
      if (sql.includes('FROM fac_asset_disposals d ')) {
        return [
          {
            id: 'disp-1',
            school_id: SCHOOL.schoolId,
            asset_id: ASSET_ID,
            asset_name: 'Old Elevator',
            disposal_method: 'SCRAP',
            disposal_date: '2026-05-01',
            value_recovered: 350,
            recipient_name: 'Midwest Metal',
            disposed_by: ADMIN_ACTOR.personId,
            disposed_by_name: 'Sarah Mitchell',
            authorised_by: AUTH_ID,
            authorised_by_name: 'Linda Park',
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.dispose(
        ASSET_ID,
        {
          disposalMethod: 'SCRAP',
          disposalDate: '2026-05-01',
          valueRecovered: 350,
          recipientName: 'Midwest Metal',
          authorisedById: AUTH_ID,
        },
        ADMIN_ACTOR,
      ),
    );
    expect(inserted).toBe(true);
    expect(result.disposalMethod).toBe('SCRAP');
  });

  // ─── S6: Double-dispose → 409 ───
  it('S6: AssetService.dispose translates UNIQUE(asset_id) 23505 → 409', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('SELECT status, school_id::text AS school_id FROM fac_assets')) {
        return [{ status: 'DECOMMISSIONED', school_id: SCHOOL.schoolId }];
      }
      if (sql.includes('INSERT INTO fac_asset_disposals')) {
        const e = new Error('duplicate key value violates unique constraint');
        (e as unknown as { code: string }).code = '23505';
        throw e;
      }
      return [];
    });
    const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.dispose(
          ASSET_ID,
          {
            disposalMethod: 'SCRAP',
            disposalDate: '2026-05-01',
            authorisedById: AUTH_ID,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── S7: Decommission stamps atomically ───
  it('S7: AssetService.decommission stamps decommissioned_at + decommissioned_by in same UPDATE', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('SELECT status FROM fac_assets')) {
        return [{ status: 'ACTIVE' }];
      }
      if (sql.includes('FROM fac_assets a')) {
        return [
          {
            id: ASSET_ID,
            school_id: SCHOOL.schoolId,
            category_id: CATEGORY_ID,
            category_name: 'HVAC',
            building_id: BUILDING_ID,
            building_name: 'Main',
            space_id: null,
            space_name: null,
            name: 'Unit 1',
            make: null,
            model: null,
            serial_number: null,
            install_date: null,
            warranty_expiry: null,
            expected_lifespan_years: null,
            replacement_cost_estimate: null,
            replacement_priority: null,
            status: 'DECOMMISSIONED',
            notes: null,
            decommissioned_at: new Date(),
            decommissioned_by: ADMIN_ACTOR.personId,
          },
        ];
      }
      return [];
    });
    const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.decommission(ASSET_ID, {}, ADMIN_ACTOR);
    });
    const upd = capture.find(
      (c) => c.sql.includes('UPDATE fac_assets SET') && c.sql.includes('DECOMMISSIONED'),
    );
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain('decommissioned_at = now()');
    expect(upd!.sql).toContain('decommissioned_by = $1::uuid');
  });

  // ─── S8: Energy KEYSTONE auto-compute ───
  it('S8a: EnergyService.recordReading auto-computes consumption from prior reading', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_utility_meters WHERE id')) {
        return [{ id: METER_ID }];
      }
      if (sql.includes('FROM fac_energy_readings ') && sql.includes('reading_date <')) {
        return [{ reading_value: 100 }];
      }
      return [];
    });
    const svc = new EnergyService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.recordReading(
        { meterId: METER_ID, readingDate: '2026-05-01', readingValue: 150 },
        ADMIN_ACTOR,
      );
    });
    const insert = capture.find((c) => c.sql.includes('INSERT INTO fac_energy_readings'));
    expect(insert).toBeDefined();
    // consumption is arg $5 (index 4 zero-based)
    expect(insert!.args[4]).toBe(50);
  });

  it('S8b: EnergyService.recordReading first reading → consumption=NULL', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_utility_meters WHERE id')) {
        return [{ id: METER_ID }];
      }
      if (sql.includes('FROM fac_energy_readings ') && sql.includes('reading_date <')) {
        return []; // no prior reading
      }
      return [];
    });
    const svc = new EnergyService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.recordReading(
        { meterId: METER_ID, readingDate: '2026-05-01', readingValue: 100 },
        ADMIN_ACTOR,
      );
    });
    const insert = capture.find((c) => c.sql.includes('INSERT INTO fac_energy_readings'));
    expect(insert!.args[4]).toBeNull();
  });

  // ─── S9: Meter rollback ───
  it('S9: EnergyService.recordReading rejects reading_value < prior', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_utility_meters WHERE id')) {
        return [{ id: METER_ID }];
      }
      if (sql.includes('FROM fac_energy_readings ') && sql.includes('reading_date <')) {
        return [{ reading_value: 1000 }];
      }
      return [];
    });
    const svc = new EnergyService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.recordReading(
          { meterId: METER_ID, readingDate: '2026-05-01', readingValue: 500 },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S10: UNIQUE(meter_id, reading_date) → 409 ───
  it('S10: EnergyService.recordReading UNIQUE 23505 → friendly 409', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_utility_meters WHERE id')) {
        return [{ id: METER_ID }];
      }
      if (sql.includes('FROM fac_energy_readings ') && sql.includes('reading_date <')) {
        return [{ reading_value: 100 }];
      }
      if (sql.includes('INSERT INTO fac_energy_readings')) {
        const e = new Error('duplicate key value violates unique constraint');
        (e as unknown as { code: string }).code = '23505';
        throw e;
      }
      return [];
    });
    const svc = new EnergyService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.recordReading(
          { meterId: METER_ID, readingDate: '2026-05-01', readingValue: 150 },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── S11: Space utilisation rate materialisation + over-capacity refusal ───
  it('S11a: SpaceUtilisationService.record materialises utilisation_rate as occupancy/capacity', async () => {
    const { tenantPrisma, capture } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_spaces WHERE id')) return [{ ok: 1 }];
      if (sql.includes('FROM fac_space_utilization_records r ')) {
        return [
          {
            id: 'rec-1',
            space_id: SPACE_ID,
            space_name: 'Room 101',
            record_date: '2026-05-01',
            period_id: null,
            occupancy_count: 24,
            capacity: 30,
            utilisation_rate: 0.8,
            source: 'MANUAL',
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new SpaceUtilisationService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.record(
        {
          spaceId: SPACE_ID,
          recordDate: '2026-05-01',
          occupancyCount: 24,
          capacity: 30,
        },
        ADMIN_ACTOR,
      );
    });
    const insert = capture.find((c) => c.sql.includes('INSERT INTO fac_space_utilization_records'));
    // utilisation_rate is $7 → index 6 zero-based
    expect(insert!.args[6]).toBe(0.8);
  });

  it('S11b: SpaceUtilisationService.record refuses occupancy > capacity', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_spaces WHERE id')) return [{ ok: 1 }];
      return [];
    });
    const svc = new SpaceUtilisationService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.record(
          {
            spaceId: SPACE_ID,
            recordDate: '2026-05-01',
            occupancyCount: 50,
            capacity: 30,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S12: Sustainability UNIQUE(school, name) → 409 ───
  it('S12: SustainabilityService.create UNIQUE 23505 → 409', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('INSERT INTO fac_sustainability_initiatives')) {
        const e = new Error('duplicate key value violates unique constraint');
        (e as unknown as { code: string }).code = '23505';
        throw e;
      }
      return [];
    });
    const svc = new SustainabilityService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            name: 'LED Retrofit',
            category: 'ENERGY',
            startDate: '2026-05-01',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── S13: Controller permission metadata ───
  it('S13: Controller permission metadata pinned to FAC-004 / FAC-005', () => {
    const proto = FacilitiesAssetsController.prototype as unknown as Record<string, unknown>;
    const drillRead: string[] | undefined = Reflect.getMetadata(
      PERMISSIONS_KEY,
      proto.listDrills as object,
    );
    const drillWrite: string[] | undefined = Reflect.getMetadata(
      PERMISSIONS_KEY,
      proto.createDrill as object,
    );
    const disposeMeta: string[] | undefined = Reflect.getMetadata(
      PERMISSIONS_KEY,
      proto.disposeAsset as object,
    );
    const recRead: string[] | undefined = Reflect.getMetadata(
      PERMISSIONS_KEY,
      proto.recordReading as object,
    );
    const energyTrend: string[] | undefined = Reflect.getMetadata(
      PERMISSIONS_KEY,
      proto.energyTrend as object,
    );
    expect(drillRead).toContain('fac-004:read');
    expect(drillWrite).toContain('fac-004:write');
    expect(disposeMeta).toContain('fac-004:write');
    expect(recRead).toContain('fac-005:write');
    expect(energyTrend).toContain('fac-005:read');
  });

  // ─── Bonus: Student denied at admin gate ───
  it('Student actor → ForbiddenException on AssetService.createAsset', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new AssetService(tenantPrisma as never, makePerms(false) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createAsset(
          {
            categoryId: CATEGORY_ID,
            buildingId: BUILDING_ID,
            name: 'New Asset',
          },
          STUDENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── Bonus: NotFoundException on missing asset ───
  it('AssetService.getAsset → 404 when not found', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.getAsset(ASSET_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
