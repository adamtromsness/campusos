import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { RepairService } from './repair.service';
import { PartsService } from './parts.service';
import { ComponentService } from './component.service';
import { FuelLogService } from './fuel-log.service';
import { DriverHoursService } from './driver-hours.service';
import { VehicleLifecycleService } from './vehicle-lifecycle.service';
import { FleetMaintenanceController } from './fleet-maintenance.controller';

const SCHOOL = { schoolId: '019e0e69-aaaa-7000-8000-aaaa00000001', subdomain: 'demo' } as never;

const ADMIN_ACTOR = {
  accountId: '019e0e69-aaaa-7000-8000-bbbb00000001',
  personId: '019e0e69-aaaa-7000-8000-bbbb00000002',
  employeeId: '019e0e69-aaaa-7000-8000-bbbb00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const STAFF_ACTOR = {
  accountId: '019e0e69-aaaa-7000-8000-cccc00000001',
  personId: '019e0e69-aaaa-7000-8000-cccc00000002',
  employeeId: '019e0e69-aaaa-7000-8000-cccc00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0e69-aaaa-7000-8000-dddd00000001',
  personId: '019e0e69-aaaa-7000-8000-dddd00000002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const VEHICLE_ID = '019e0e69-aaaa-7000-8000-eeee00000001';

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

/**
 * REVIEW-P2C11 ROUND 1 BLOCKING 3 — OutboxService stub that captures
 * every `enqueueInTx` call so specs can assert the durable emit
 * keystone fires inside the tx with the deterministic event_id.
 */
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

/**
 * REVIEW-P2C11 ROUND 1 BLOCKING 6 — PermissionCheckService stub.
 * The default allow=true reflects the seeded TRN-001..003 grants on
 * the Staff role; specs that exercise the denial path pass allow=false.
 */
function makePermCheck(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  return {
    hasAnyPermissionInTenant: vi.fn(async () => allow),
  };
}

// ============================================================
// RepairService — safety-critical blocking + lifecycle stamps
// ============================================================
describe('RepairService — safety-critical vehicle blocking', () => {
  it('create() flips trn_vehicles.status to MAINTENANCE when a safety-critical SCHEDULED repair is logged', async () => {
    const categoryId = '019e0e69-aaaa-7000-8000-ffff00000001';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status from trn_vehicles')) {
        return [{ id: VEHICLE_ID, status: 'ACTIVE' }];
      }
      if (sql.includes('is_safety_critical from trn_repair_categories')) {
        return [{ is_safety_critical: true }];
      }
      return [];
    });
    const svc = new RepairService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // Stub getById to skip the round-trip — read the captured INSERT instead.
      const insertCalls = fake.capture;
      try {
        await svc.create(
          VEHICLE_ID,
          {
            categoryId,
            repairDate: '2026-05-11',
            mileageAtRepair: 50000,
            problemDescription: 'p',
            workPerformed: 'w',
            totalCost: 100,
            performedByType: 'INTERNAL',
            status: 'SCHEDULED',
          },
          ADMIN_ACTOR,
        );
      } catch {
        // getById will throw because we stubbed empty rows; that is ok for this assertion.
      }
      const insertRepair = insertCalls.find((c) =>
        c.sql.toLowerCase().includes('insert into trn_vehicle_repairs'),
      );
      expect(insertRepair, 'INSERT into trn_vehicle_repairs').toBeTruthy();
      const flip = insertCalls.find((c) =>
        c.sql.toLowerCase().includes("update trn_vehicles set status = 'maintenance'"),
      );
      expect(flip, 'UPDATE trn_vehicles status to MAINTENANCE').toBeTruthy();
    });
  });

  it('create() refuses INTERNAL repair with vendor_account_id supplied (vendor_pair_chk mirror)', async () => {
    const fake = makeFake(() => []);
    const svc = new RepairService(fake.tenantPrisma as never, makePermCheck() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          VEHICLE_ID,
          {
            repairDate: '2026-05-11',
            mileageAtRepair: 50000,
            problemDescription: 'p',
            workPerformed: 'w',
            totalCost: 100,
            performedByType: 'INTERNAL',
            vendorAccountId: '019e0e69-aaaa-7000-8000-ffff00000099',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() refuses STUDENT actor at the service layer', async () => {
    const fake = makeFake(() => []);
    // REVIEW-P2C11 BLOCKING 6 — non-admin actor without trn-002:write is refused.
    const svc = new RepairService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          VEHICLE_ID,
          {
            repairDate: '2026-05-11',
            mileageAtRepair: 50000,
            problemDescription: 'p',
            workPerformed: 'w',
            totalCost: 100,
            performedByType: 'INTERNAL',
          },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ============================================================
// PartsService — low-stock emit on threshold crossing
// ============================================================
describe('PartsService — trn.parts.low emit on threshold crossing', () => {
  it('restock() emits trn.parts.low when consumption drives quantity to or below min_stock_level', async () => {
    const partId = '019e0e69-aaaa-7000-8000-aaa000000001';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select quantity_on_hand, min_stock_level')) {
        return [
          {
            quantity_on_hand: 10,
            min_stock_level: 5,
            part_name: 'Brake Pads',
            part_number: 'BP-FS-2020',
          },
        ];
      }
      if (
        sql.includes('select id::text as id, school_id::text as school_id, part_name') &&
        sql.includes('from trn_parts_inventory')
      ) {
        return [
          {
            id: partId,
            school_id: SCHOOL.schoolId,
            part_name: 'Brake Pads',
            part_number: 'BP-FS-2020',
            quantity_on_hand: 3,
            min_stock_level: 5,
            unit_cost: '64.00',
            supplier: null,
            last_restocked_at: null,
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new PartsService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.restock(partId, { quantityDelta: -7 }, ADMIN_ACTOR),
    );
    // REVIEW-P2C11 BLOCKING 3 — emit lands via outbox.enqueueInTx.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('trn.parts.low');
    expect(enqueued[0]!.sourceModule).toBe('transport');
    expect(enqueued[0]!.eventId, 'deterministic event_id present').toBeTruthy();
    expect(enqueued[0]!.payload.partId).toBe(partId);
    expect(enqueued[0]!.payload.quantityOnHand).toBe(3);
    expect(enqueued[0]!.payload.minStockLevel).toBe(5);
  });

  it('restock() does NOT emit when quantity remains above min_stock_level', async () => {
    const partId = '019e0e69-aaaa-7000-8000-aaa000000002';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select quantity_on_hand, min_stock_level')) {
        return [
          {
            quantity_on_hand: 20,
            min_stock_level: 5,
            part_name: 'Oil Filter',
            part_number: 'OF-STD',
          },
        ];
      }
      if (sql.includes('from trn_parts_inventory')) {
        return [
          {
            id: partId,
            school_id: SCHOOL.schoolId,
            part_name: 'Oil Filter',
            part_number: 'OF-STD',
            quantity_on_hand: 15,
            min_stock_level: 5,
            unit_cost: null,
            supplier: null,
            last_restocked_at: null,
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new PartsService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.restock(partId, { quantityDelta: -5 }, ADMIN_ACTOR),
    );
    expect(enqueued.length).toBe(0);
  });

  it('restock() rejects deltas that would drive on-hand quantity below zero', async () => {
    const partId = '019e0e69-aaaa-7000-8000-aaa000000003';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select quantity_on_hand, min_stock_level')) {
        return [{ quantity_on_hand: 2, min_stock_level: 5, part_name: 'Test', part_number: 'T-1' }];
      }
      return [];
    });
    const svc = new PartsService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.restock(partId, { quantityDelta: -3 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// FuelLogService — efficiency computation
// ============================================================
describe('FuelLogService — efficiency = (odo_now - odo_prev) / quantity', () => {
  it('listForVehicle() computes efficiency for rows that have a prior log + null for the first', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicle_fuel_logs f')) {
        return [
          {
            id: 'f2',
            vehicle_id: VEHICLE_ID,
            logged_by: null,
            logged_by_name: '',
            log_date: new Date('2026-05-10'),
            odometer_reading: '49500.0',
            fuel_quantity: '88.00',
            fuel_cost: '112.00',
            fuel_type: 'DIESEL',
            refuel_location: null,
            created_at: new Date(),
            prev_odometer: '48950.0',
          },
          {
            id: 'f1',
            vehicle_id: VEHICLE_ID,
            logged_by: null,
            logged_by_name: '',
            log_date: new Date('2026-05-03'),
            odometer_reading: '48950.0',
            fuel_quantity: '96.00',
            fuel_cost: '122.20',
            fuel_type: 'DIESEL',
            refuel_location: null,
            created_at: new Date(),
            prev_odometer: null,
          },
        ];
      }
      return [];
    });
    const svc = new FuelLogService(fake.tenantPrisma as never);
    const rows = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listForVehicle(VEHICLE_ID),
    );
    expect(rows.length).toBe(2);
    expect(rows[0]!.milesSincePrevious).toBeCloseTo(550, 1);
    expect(rows[0]!.efficiency).toBeCloseTo(6.25, 2);
    expect(rows[1]!.milesSincePrevious).toBeNull();
    expect(rows[1]!.efficiency).toBeNull();
  });
});

// ============================================================
// DriverHoursService — cumulative_weekly_minutes + approaching emit
// ============================================================
describe('DriverHoursService — cumulative + trn.driver.hours_approaching_limit', () => {
  it('complete() recomputes cumulative_weekly_minutes from ISO week + emits on threshold crossing', async () => {
    const driverId = '019e0e69-aaaa-7000-8000-eeee00000099';
    const hoursId = '019e0e69-aaaa-7000-8000-eeee00000100';
    const dutyStart = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const dutyEnd = new Date();
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select id::text as id, school_id::text as school_id, weekly_driving_limit_minutes',
        )
      ) {
        return [
          {
            id: 'L1',
            school_id: SCHOOL.schoolId,
            weekly_driving_limit_minutes: 2880,
            daily_driving_limit_minutes: 600,
            mandatory_break_after_minutes: 270,
            approaching_limit_threshold_pct: 90,
            jurisdiction: 'US_FEDERAL',
          },
        ];
      }
      if (sql.includes('select h.driver_id::text as driver_id, h.duty_start_at')) {
        return [
          {
            driver_id: driverId,
            duty_start_at: dutyStart,
            duty_end_at: null,
            cumulative_weekly_minutes: null,
          },
        ];
      }
      if (sql.includes('coalesce(sum(h.driving_minutes), 0)::int as s')) {
        // 90% of 2880 = 2592. Set prior cumulative below threshold,
        // adding 480 should cross 2592.
        return [{ s: 2160 }];
      }
      if (sql.includes('from trn_driver_hours_logs') && sql.includes('where h.id = ')) {
        // Final school-defensive read-back
        return [
          {
            id: hoursId,
            driver_id: driverId,
            run_id: null,
            log_date: new Date(dutyStart),
            duty_start_at: dutyStart,
            duty_end_at: dutyEnd,
            driving_minutes: 480,
            break_minutes: 60,
            cumulative_weekly_minutes: 2640,
            notes: null,
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.complete(
        hoursId,
        {
          dutyEndAt: dutyEnd.toISOString(),
          drivingMinutes: 480,
          breakMinutes: 60,
        },
        ADMIN_ACTOR,
      ),
    );
    // REVIEW-P2C11 BLOCKING 3 — emit lands via outbox.enqueueInTx, not kafka.emit.
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]!.topic).toBe('trn.driver.hours_approaching_limit');
    expect(enqueued[0]!.sourceModule).toBe('transport');
    expect(enqueued[0]!.eventId, 'deterministic event_id present').toBeTruthy();
    expect(enqueued[0]!.payload.driverId).toBe(driverId);
    expect(enqueued[0]!.payload.weeklyDrivingLimitMinutes).toBe(2880);
    expect(enqueued[0]!.payload.priorCumulativeMinutes).toBe(2160);
    expect(enqueued[0]!.payload.newCumulativeMinutes).toBe(2640);
    expect(enqueued[0]!.payload.jurisdiction).toBe('US_FEDERAL');
  });

  it('complete() does NOT emit when threshold was already crossed before this duty closed', async () => {
    const driverId = '019e0e69-aaaa-7000-8000-eeee00000099';
    const hoursId = '019e0e69-aaaa-7000-8000-eeee00000101';
    const dutyStart = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const dutyEnd = new Date();
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('weekly_driving_limit_minutes')) {
        return [
          {
            id: 'L1',
            school_id: SCHOOL.schoolId,
            weekly_driving_limit_minutes: 2880,
            daily_driving_limit_minutes: 600,
            mandatory_break_after_minutes: 270,
            approaching_limit_threshold_pct: 90,
            jurisdiction: 'US_FEDERAL',
          },
        ];
      }
      if (sql.includes('select h.driver_id::text as driver_id, h.duty_start_at')) {
        return [
          {
            driver_id: driverId,
            duty_start_at: dutyStart,
            duty_end_at: null,
            cumulative_weekly_minutes: null,
          },
        ];
      }
      if (sql.includes('coalesce(sum(h.driving_minutes), 0)::int as s')) {
        // Prior cumulative already above 2592 threshold.
        return [{ s: 2700 }];
      }
      if (sql.includes('from trn_driver_hours_logs') && sql.includes('where h.id = ')) {
        return [
          {
            id: hoursId,
            driver_id: driverId,
            run_id: null,
            log_date: new Date(dutyStart),
            duty_start_at: dutyStart,
            duty_end_at: dutyEnd,
            driving_minutes: 100,
            break_minutes: 0,
            cumulative_weekly_minutes: 2800,
            notes: null,
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.complete(hoursId, { dutyEndAt: dutyEnd.toISOString(), drivingMinutes: 100 }, ADMIN_ACTOR),
    );
    expect(enqueued.length).toBe(0);
  });

  it('complete() refuses a duty that is already closed', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('weekly_driving_limit_minutes')) {
        return [
          {
            id: 'L1',
            school_id: SCHOOL.schoolId,
            weekly_driving_limit_minutes: 2880,
            daily_driving_limit_minutes: 600,
            mandatory_break_after_minutes: 270,
            approaching_limit_threshold_pct: 90,
            jurisdiction: 'US_FEDERAL',
          },
        ];
      }
      if (sql.includes('select h.driver_id::text as driver_id, h.duty_start_at')) {
        return [
          {
            driver_id: 'd',
            duty_start_at: new Date('2026-05-11T08:00:00Z'),
            duty_end_at: new Date('2026-05-11T17:00:00Z'),
            cumulative_weekly_minutes: 540,
          },
        ];
      }
      return [];
    });
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.complete('h', { dutyEndAt: '2026-05-11T18:00:00Z', drivingMinutes: 100 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// VehicleLifecycleService — depreciation + disposal
// ============================================================
describe('VehicleLifecycleService — replacement planning + disposal', () => {
  it('recordDisposal() flips the vehicle to RETIRED in the same tx as the disposal write', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id, disposal_date from trn_vehicle_lifecycle')) {
        return [{ id: 'L1', disposal_date: null }];
      }
      if (sql.includes('from trn_vehicle_lifecycle l') && sql.includes('where l.vehicle_id =')) {
        return [
          {
            id: 'L1',
            vehicle_id: VEHICLE_ID,
            vehicle_registration: 'BUS-42',
            purchase_date: new Date('2021-05-11'),
            purchase_price: '95000.00',
            expected_life_years: 12,
            expected_life_miles: 250000,
            depreciation_method: 'STRAIGHT_LINE',
            current_book_value: '0.00',
            book_value_computed_at: new Date(),
            disposal_date: new Date('2026-05-11'),
            disposal_value: '5000.00',
            disposal_method: 'SOLD',
            disposal_notes: 'Auction',
          },
        ];
      }
      return [];
    });
    const svc = new VehicleLifecycleService(fake.tenantPrisma as never);
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.recordDisposal(
        VEHICLE_ID,
        { disposalDate: '2026-05-11', disposalMethod: 'SOLD', disposalValue: 5000 },
        ADMIN_ACTOR,
      ),
    );
    expect(out.disposalMethod).toBe('SOLD');
    const flip = fake.capture.find((c) =>
      c.sql.toLowerCase().includes("update trn_vehicles set status = 'retired'"),
    );
    expect(flip, 'UPDATE trn_vehicles status to RETIRED').toBeTruthy();
  });

  it('recordDisposal() refuses to re-dispose an already-disposed vehicle', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id, disposal_date from trn_vehicle_lifecycle')) {
        return [{ id: 'L1', disposal_date: new Date('2026-05-01') }];
      }
      return [];
    });
    const svc = new VehicleLifecycleService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.recordDisposal(
          VEHICLE_ID,
          { disposalDate: '2026-05-11', disposalMethod: 'SOLD' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// FleetMaintenanceController — @RequirePermission metadata
// ============================================================
describe('FleetMaintenanceController — @RequirePermission metadata', () => {
  it('Repairs + Parts + Components + Fuel + Lifecycle write paths are gated on trn-002:write', () => {
    const c = FleetMaintenanceController.prototype;
    const cases: Array<[string, string]> = [
      ['createCategory', 'trn-002:write'],
      ['patchCategory', 'trn-002:write'],
      ['createRepair', 'trn-002:write'],
      ['patchRepair', 'trn-002:write'],
      ['createPart', 'trn-002:write'],
      ['patchPart', 'trn-002:write'],
      ['restockPart', 'trn-002:write'],
      ['createComponent', 'trn-002:write'],
      ['patchComponent', 'trn-002:write'],
      ['createFuel', 'trn-002:write'],
      ['patchLifecycle', 'trn-002:write'],
      ['recordDisposal', 'trn-002:write'],
    ];
    for (const [method, code] of cases) {
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, c[method as keyof typeof c]) as string[];
      expect(perms, `${method} permission metadata`).toContain(code);
    }
  });

  it('Driver hours read endpoints are gated on trn-003:read, writes on trn-003:write, limit admin on trn-003:admin', () => {
    const c = FleetMaintenanceController.prototype;
    const cases: Array<[string, string]> = [
      ['listDriverHours', 'trn-003:read'],
      ['weeklySummary', 'trn-003:read'],
      ['startDuty', 'trn-003:write'],
      ['completeDuty', 'trn-003:write'],
      ['approachingLimit', 'trn-003:read'],
      ['getLimit', 'trn-003:read'],
      ['patchLimit', 'trn-003:admin'],
    ];
    for (const [method, code] of cases) {
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, c[method as keyof typeof c]) as string[];
      expect(perms, `${method} permission metadata`).toContain(code);
    }
  });

  it('All read-list endpoints gate on the right read code', () => {
    const c = FleetMaintenanceController.prototype;
    const cases: Array<[string, string]> = [
      ['listCategories', 'trn-002:read'],
      ['listRepairs', 'trn-002:read'],
      ['listOutstandingRepairs', 'trn-002:read'],
      ['listParts', 'trn-002:read'],
      ['listLowStock', 'trn-002:read'],
      ['listComponents', 'trn-002:read'],
      ['approachingEndOfLife', 'trn-002:read'],
      ['listFuel', 'trn-002:read'],
      ['fuelFleetSummary', 'trn-002:read'],
      ['getLifecycle', 'trn-002:read'],
      ['replacementPlanning', 'trn-002:read'],
    ];
    for (const [method, code] of cases) {
      const perms = Reflect.getMetadata(PERMISSIONS_KEY, c[method as keyof typeof c]) as string[];
      expect(perms, `${method} permission metadata`).toContain(code);
    }
  });
});

// ============================================================
// ComponentService — approaching end of life threshold
// ============================================================
describe('ComponentService — approaching end of life', () => {
  it('rowToDto marks a component approaching when installed age >= 90% of expected_life_months', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicle_components') && sql.includes('where id =')) {
        // installed 23 months ago, expected 24 months → ~95% → approaching
        const installed = new Date();
        installed.setMonth(installed.getMonth() - 23);
        return [
          {
            id: 'c1',
            vehicle_id: VEHICLE_ID,
            component_type: 'BATTERY',
            description: 'Bosch S5',
            installed_date: installed,
            installed_mileage: 30000,
            expected_life_miles: null,
            expected_life_months: 24,
            warranty_provider: null,
            warranty_expiry_date: null,
            status: 'ACTIVE',
            replaced_at: null,
            replaced_by_component_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new ComponentService(fake.tenantPrisma as never);
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('c1'));
    expect(out.approachingEndOfLife).toBe(true);
    expect(out.monthsRemaining).toBeLessThanOrEqual(2);
  });

  it('rowToDto does NOT mark a fresh component approaching', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_vehicle_components') && sql.includes('where id =')) {
        const installed = new Date();
        installed.setMonth(installed.getMonth() - 2);
        return [
          {
            id: 'c1',
            vehicle_id: VEHICLE_ID,
            component_type: 'BATTERY',
            description: 'Bosch S5',
            installed_date: installed,
            installed_mileage: 30000,
            expected_life_miles: null,
            expected_life_months: 24,
            warranty_provider: null,
            warranty_expiry_date: null,
            status: 'ACTIVE',
            replaced_at: null,
            replaced_by_component_id: null,
            notes: null,
          },
        ];
      }
      return [];
    });
    const svc = new ComponentService(fake.tenantPrisma as never);
    const out = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.getById('c1'));
    expect(out.approachingEndOfLife).toBe(false);
  });
});

// ============================================================
// REVIEW-P2C11 ROUND 1 — school-scoping + outbox + TRN-* perm checks
// ============================================================
describe('REVIEW-P2C11 ROUND 1 — BLOCKING regressions', () => {
  // BLOCKING 1 — RepairService school-scoping
  it('BLOCKING 1 — RepairService.listForVehicle SQL carries school_id predicate via JOIN', async () => {
    const fake = makeFake(() => []);
    const svc = new RepairService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listForVehicle(VEHICLE_ID));
    const select = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from trn_vehicle_repairs r'),
    );
    expect(select, 'SELECT joins trn_vehicles for school predicate').toBeTruthy();
    expect(select!.sql.toLowerCase()).toContain('join trn_vehicles v ');
    expect(select!.sql.toLowerCase()).toContain('v.school_id = $2::uuid');
  });

  it('BLOCKING 1 — RepairService.create vehicle lock carries school_id predicate', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status from trn_vehicles')) {
        return [{ id: VEHICLE_ID, status: 'ACTIVE' }];
      }
      return [];
    });
    const svc = new RepairService(fake.tenantPrisma as never, makePermCheck() as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      try {
        await svc.create(
          VEHICLE_ID,
          {
            repairDate: '2026-05-11',
            mileageAtRepair: 50000,
            problemDescription: 'p',
            workPerformed: 'w',
            totalCost: 100,
            performedByType: 'INTERNAL',
          },
          ADMIN_ACTOR,
        );
      } catch {
        // getById round-trip may throw — we only care about the lock SQL shape.
      }
    });
    const lock = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('select id::text as id, status from trn_vehicles') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lock, 'vehicle FOR UPDATE lock').toBeTruthy();
    expect(lock!.sql.toLowerCase()).toContain('school_id = $2::uuid');
  });

  it('BLOCKING 6 — RepairService refuses STAFF without trn-002:write', async () => {
    const fake = makeFake(() => []);
    const svc = new RepairService(
      fake.tenantPrisma as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          VEHICLE_ID,
          {
            repairDate: '2026-05-11',
            mileageAtRepair: 50000,
            problemDescription: 'p',
            workPerformed: 'w',
            totalCost: 100,
            performedByType: 'INTERNAL',
          },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // BLOCKING 2 — DriverHoursService school-scoping
  it('BLOCKING 2 — DriverHoursService.create validates driver via hr_employees.school_id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // Driver belongs to a different school — return empty
      if (sql.includes('from hr_employees where id = $1::uuid and school_id = $2::uuid')) return [];
      return [];
    });
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          '019e0e69-aaaa-7000-8000-ffff00009999',
          { logDate: '2026-05-11', dutyStartAt: '2026-05-11T08:00:00Z' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('BLOCKING 2 — DriverHoursService.complete lock joins through hr_employees.school_id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('weekly_driving_limit_minutes')) {
        return [
          {
            id: 'L1',
            school_id: SCHOOL.schoolId,
            weekly_driving_limit_minutes: 2880,
            daily_driving_limit_minutes: 600,
            mandatory_break_after_minutes: 270,
            approaching_limit_threshold_pct: 90,
            jurisdiction: 'US_FEDERAL',
          },
        ];
      }
      // Lock SQL returns empty — simulating cross-school hours row.
      if (
        sql.includes('select h.driver_id::text as driver_id, h.duty_start_at') &&
        sql.includes('for update')
      ) {
        return [];
      }
      return [];
    });
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.complete(
          'h-cross-school',
          { dutyEndAt: '2026-05-11T18:00:00Z', drivingMinutes: 100 },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    const lock = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('select h.driver_id::text as driver_id') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lock, 'driver hours FOR UPDATE lock').toBeTruthy();
    expect(lock!.sql.toLowerCase()).toContain('join hr_employees e ');
    expect(lock!.sql.toLowerCase()).toContain('e.school_id = $2::uuid');
  });

  it('BLOCKING 6 — DriverHoursService refuses STAFF without trn-003:write', async () => {
    const fake = makeFake(() => []);
    const svc = new DriverHoursService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          '019e0e69-aaaa-7000-8000-ffff00009999',
          { logDate: '2026-05-11', dutyStartAt: '2026-05-11T08:00:00Z' },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // BLOCKING 3 — Durable outbox emits with deterministic event ids
  it('BLOCKING 3 — deterministicPartsLowEventId is stable + v5-shaped', async () => {
    const { deterministicPartsLowEventId } = await import('./parts.service');
    const id = deterministicPartsLowEventId('part-1', '2026-05-11T08:00:00Z');
    const id2 = deterministicPartsLowEventId('part-1', '2026-05-11T08:00:00Z');
    const id3 = deterministicPartsLowEventId('part-2', '2026-05-11T08:00:00Z');
    expect(id).toBe(id2);
    expect(id).not.toBe(id3);
    // v5 marker — first nibble of byte 6 should be 5
    expect(id.charAt(14)).toBe('5');
  });

  it('BLOCKING 3 — deterministicDriverHoursApproachingEventId is stable + v5-shaped', async () => {
    const { deterministicDriverHoursApproachingEventId } = await import('./driver-hours.service');
    const a = deterministicDriverHoursApproachingEventId('hrs-1');
    const b = deterministicDriverHoursApproachingEventId('hrs-1');
    const c = deterministicDriverHoursApproachingEventId('hrs-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.charAt(14)).toBe('5');
  });
});
