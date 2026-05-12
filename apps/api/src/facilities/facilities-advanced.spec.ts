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
import { CleaningRouteService } from './cleaning-route.service';
import { ZoneInspectionService } from './zone-inspection.service';
import { SupplyAuditService } from './supply-audit.service';
import { WorkOrderDepthService } from './work-order-depth.service';
import { FacilitiesAdvancedController } from './facilities-advanced.controller';
import { deterministicRouteStopIssueNotedEventId } from './event-ids';

/**
 * P2-18a Facilities Advanced vertical-slice spec.
 *
 * Coverage:
 *   S1  deterministicRouteStopIssueNotedEventId stable + v5-shape.
 *   S2  CleaningRouteService.createRoute admin-only.
 *   S3  CleaningRouteService.createRoute duplicate name → 409.
 *   S4  CleaningRouteService.createAssignment validates one-off vs
 *       recurring shape.
 *   S5  CleaningRouteService.startCompletion materialises one
 *       stop_completion row per stop in PENDING.
 *   S6  CleaningRouteService.patchStopCompletion emits
 *       fac.route_stop.issue_noted with deterministic eventId when
 *       issuesNoted is set.
 *   S7  patchStopCompletion does NOT emit when issuesNoted is absent.
 *   S8  patchStopCompletion SKIPPED requires non-empty skipReason.
 *   S9  ZoneInspectionService.create on FAIL inserts BOTH a work order
 *       AND the inspection in one tenant tx, in that order.
 *   S10 ZoneInspectionService.create on PASS does NOT create a work
 *       order.
 *   S11 SupplyAuditService.completeStocktake creates one ADJUSTMENT
 *       per discrepancy + updates current_quantity to actual.
 *   S12 SupplyAuditService.completeStocktake refuses double-completion
 *       on an already-COMPLETED stocktake.
 *   S13 SupplyAuditService.createTransaction rejects quantityDelta=0.
 *   S14 WorkOrderDepthService.getCostSummary SUMs parts + labour.
 *   S15 WorkOrderDepthService.addPart auto-computes total_cost when
 *       both unitCost + quantity are present.
 *   S16 Controller permission metadata pinned to FAC-001 / FAC-003.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e1875-aaaa-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e1875-aaaa-7556-8c81-000000000001',
  personId: '019e1875-aaaa-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e1875-aaaa-7556-8c81-000000000099',
} as never;

const CUSTODIAN_ACTOR = {
  accountId: '019e1875-aaaa-7556-8c81-100000000001',
  personId: '019e1875-aaaa-7556-8c81-100000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e1875-aaaa-7556-8c81-100000000099',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e1875-aaaa-7556-8c81-200000000001',
  personId: '019e1875-aaaa-7556-8c81-200000000002',
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

const ROUTE_ID = '019e1875-aaaa-7556-8c81-300000000001';
const SPACE_ID = '019e1875-aaaa-7556-8c81-400000000001';
const STOP_ID = '019e1875-aaaa-7556-8c81-500000000001';
const COMPLETION_ID = '019e1875-aaaa-7556-8c81-600000000001';
const STOP_COMPL_ID = '019e1875-aaaa-7556-8c81-700000000001';
const ZONE_ID = '019e1875-aaaa-7556-8c81-800000000001';
const BUILDING_ID = '019e1875-aaaa-7556-8c81-900000000001';
const INVENTORY_ID = '019e1875-aaaa-7556-8c81-a00000000001';
const STOCKTAKE_ID = '019e1875-aaaa-7556-8c81-b00000000001';
const WORK_ORDER_ID = '019e1875-aaaa-7556-8c81-c00000000001';
const ASSIGNMENT_ID = '019e1875-aaaa-7556-8c81-d00000000001';

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
  // REVIEW-P2C18 BLOCKING 1 — Cleaning + Zone services now take an
  // OutboxService (not KafkaProducerService). The shared stub returns
  // both the legacy `kafka.emit` shape (left in place for any
  // unmigrated path) and an `outbox.enqueueInTx` that pushes onto the
  // same emits array so existing assertions keep matching.
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

describe('Facilities Advanced — P2-18a', () => {
  // ─── S1: deterministic event-id helper ───
  it('S1: deterministicRouteStopIssueNotedEventId stable + v5-shape', () => {
    const a = deterministicRouteStopIssueNotedEventId(STOP_COMPL_ID);
    const b = deterministicRouteStopIssueNotedEventId(STOP_COMPL_ID);
    expect(a).toBe(b);
    // v5 marker nibble at byte 6
    expect(a[14]).toBe('5');
    // RFC-4122 variant nibble at byte 8 (8, 9, a or b)
    expect(['8', '9', 'a', 'b']).toContain(a[19]);

    const c = deterministicRouteStopIssueNotedEventId(STOP_COMPL_ID.replace('1', '2'));
    expect(a).not.toBe(c);
  });

  // ─── S2: CleaningRouteService.createRoute admin gate ───
  it('S2: createRoute denies non-admin without fac-003:admin', async () => {
    const { tenantPrisma } = makeFake();
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(false) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createRoute({ name: 'North Wing AM', shift: 'MORNING' }, CUSTODIAN_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── S3: createRoute duplicate name → ConflictException ───
  it('S3: createRoute duplicate name → 409', async () => {
    const { tenantPrisma } = makeFake(() => {
      const e = new Error('duplicate key value violates unique constraint');
      (e as unknown as { code: string }).code = '23505';
      throw e;
    });
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createRoute({ name: 'North Wing AM', shift: 'MORNING' }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── S4: createAssignment shape validation ───
  it('S4a: recurring assignment requires recurrenceDays + effectiveFrom', async () => {
    const { tenantPrisma } = makeFake();
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // Override assertEmployeeInCurrentTenant via the fake client
      // returning 1 row to pass the validation.
      const { tenantPrisma: tp2 } = makeFake(({ sql }) => {
        if (sql.includes('FROM hr_employees WHERE id')) return [{ ok: 1 }];
        return [];
      });
      const svc2 = new CleaningRouteService(tp2 as never, kafka as never, makePerms(true) as never);
      await expect(
        svc2.createAssignment(
          ROUTE_ID,
          { employeeId: CUSTODIAN_ACTOR.employeeId, isRecurring: true },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('S4b: one-off assignment requires assignmentDate', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM hr_employees WHERE id')) return [{ ok: 1 }];
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createAssignment(
          ROUTE_ID,
          { employeeId: CUSTODIAN_ACTOR.employeeId, isRecurring: false },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('S4c: one-off assignment cannot carry recurrenceDays', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM hr_employees WHERE id')) return [{ ok: 1 }];
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createAssignment(
          ROUTE_ID,
          {
            employeeId: CUSTODIAN_ACTOR.employeeId,
            isRecurring: false,
            assignmentDate: '2026-05-15',
            recurrenceDays: [1, 2, 3],
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S5: startCompletion materialises stops in PENDING ───
  it('S5: startCompletion inserts one stop_completion per stop, all PENDING', async () => {
    let stopsListed = false;
    let stopInsertCount = 0;
    let completionInserted = false;
    const { capture, tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_cleaning_routes WHERE id')) return [{ id: ROUTE_ID }];
      if (sql.includes('FROM fac_cleaning_route_assignments WHERE id'))
        return [{ id: ASSIGNMENT_ID }];
      if (sql.includes('FROM fac_cleaning_route_stops WHERE route_id')) {
        stopsListed = true;
        return [
          { id: STOP_ID },
          { id: STOP_ID.replace('1', '2') },
          { id: STOP_ID.replace('1', '3') },
        ];
      }
      if (sql.includes('INSERT INTO fac_cleaning_route_completions')) {
        completionInserted = true;
        return 1;
      }
      if (sql.includes('INSERT INTO fac_cleaning_route_stop_completions')) {
        stopInsertCount += 1;
        return 1;
      }
      // getCompletionById final read — return single row + no stops.
      if (sql.startsWith('SELECT c.id::text AS id')) {
        return [
          {
            id: COMPLETION_ID,
            route_id: ROUTE_ID,
            route_name: 'North Wing AM',
            assignment_id: ASSIGNMENT_ID,
            employee_id: CUSTODIAN_ACTOR.employeeId,
            completion_date: '2026-05-12',
            started_at: new Date('2026-05-12T08:00:00Z'),
            completed_at: null,
            overall_status: 'IN_PROGRESS',
            notes: null,
            employee_name: 'Jane Custodian',
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const result = await svc.startCompletion(
        { routeId: ROUTE_ID, assignmentId: ASSIGNMENT_ID, completionDate: '2026-05-12' },
        CUSTODIAN_ACTOR,
      );
      expect(result.overallStatus).toBe('IN_PROGRESS');
    });
    expect(stopsListed).toBe(true);
    expect(stopInsertCount).toBe(3);
    expect(completionInserted).toBe(true);
    // Every stop insert defaults to PENDING.
    const inserts = capture.filter((c) =>
      c.sql.startsWith('INSERT INTO fac_cleaning_route_stop_completions'),
    );
    expect(inserts).toHaveLength(3);
    for (const ins of inserts) {
      expect(ins.sql).toContain("'PENDING'");
    }
  });

  // ─── S6: patchStopCompletion with issuesNoted emits fac.route_stop.issue_noted ───
  it('S6: patchStopCompletion with issuesNoted emits the keystone Kafka envelope', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_cleaning_route_completions c'))
        return [
          {
            id: COMPLETION_ID,
            route_id: ROUTE_ID,
            overall_status: 'IN_PROGRESS',
            employee_id: CUSTODIAN_ACTOR.employeeId,
          },
        ];
      if (sql.includes('FROM fac_cleaning_route_stop_completions sc'))
        return [{ id: STOP_COMPL_ID, status: 'PENDING', stop_id: STOP_ID, space_id: SPACE_ID }];
      if (sql.includes("FILTER (WHERE status = 'PENDING')"))
        return [{ pending: 2, skipped: 0, total: 3 }];
      // Final listStopCompletions read.
      if (sql.startsWith('SELECT sc.id::text AS id'))
        return [
          {
            id: STOP_COMPL_ID,
            completion_id: COMPLETION_ID,
            stop_id: STOP_ID,
            status: 'COMPLETED',
            completed_at: new Date(),
            skip_reason: null,
            tasks_completed: ['Sweep', 'Mop'],
            photo_s3_keys: [],
            issues_noted: 'Broken soap dispenser',
          },
        ];
      return [];
    });
    const { kafka, emits } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.patchStopCompletion(
        COMPLETION_ID,
        STOP_ID,
        {
          status: 'COMPLETED',
          tasksCompleted: ['Sweep', 'Mop'],
          issuesNoted: 'Broken soap dispenser',
        },
        CUSTODIAN_ACTOR,
      );
    });
    expect(emits).toHaveLength(1);
    const e = emits[0]!;
    expect(e.topic).toBe('fac.route_stop.issue_noted');
    expect(e.sourceModule).toBe('facilities');
    expect(e.key).toBe(STOP_COMPL_ID);
    expect(e.eventId).toBe(deterministicRouteStopIssueNotedEventId(STOP_COMPL_ID));
    expect(e.payload).toMatchObject({
      sourceRefId: STOP_COMPL_ID,
      stopCompletionId: STOP_COMPL_ID,
      routeId: ROUTE_ID,
      stopId: STOP_ID,
      spaceId: SPACE_ID,
      issuesNoted: 'Broken soap dispenser',
      reportedByAccountId: CUSTODIAN_ACTOR.accountId,
      schoolId: SCHOOL.schoolId,
    });
  });

  // ─── S7: no issuesNoted → no emit ───
  it('S7: patchStopCompletion without issuesNoted does NOT emit', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_cleaning_route_completions c'))
        return [
          {
            id: COMPLETION_ID,
            route_id: ROUTE_ID,
            overall_status: 'IN_PROGRESS',
            employee_id: CUSTODIAN_ACTOR.employeeId,
          },
        ];
      if (sql.includes('FROM fac_cleaning_route_stop_completions sc'))
        return [{ id: STOP_COMPL_ID, status: 'PENDING', stop_id: STOP_ID, space_id: SPACE_ID }];
      if (sql.includes("FILTER (WHERE status = 'PENDING')"))
        return [{ pending: 2, skipped: 0, total: 3 }];
      if (sql.startsWith('SELECT sc.id::text AS id'))
        return [
          {
            id: STOP_COMPL_ID,
            completion_id: COMPLETION_ID,
            stop_id: STOP_ID,
            status: 'COMPLETED',
            completed_at: new Date(),
            skip_reason: null,
            tasks_completed: ['Sweep'],
            photo_s3_keys: [],
            issues_noted: null,
          },
        ];
      return [];
    });
    const { kafka, emits } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.patchStopCompletion(
        COMPLETION_ID,
        STOP_ID,
        { status: 'COMPLETED', tasksCompleted: ['Sweep'] },
        CUSTODIAN_ACTOR,
      );
    });
    expect(emits).toHaveLength(0);
  });

  // ─── S8: SKIPPED requires skipReason ───
  it('S8: patchStopCompletion SKIPPED without skipReason → 400', async () => {
    const { tenantPrisma } = makeFake();
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.patchStopCompletion(COMPLETION_ID, STOP_ID, { status: 'SKIPPED' }, CUSTODIAN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S9: ZoneInspectionService FAIL creates work order + inspection in same tx ───
  it('S9: zone inspection FAIL inserts work order + inspection with follow_up_work_order_id', async () => {
    const inserts: string[] = [];
    const { tenantPrisma } = makeFake(({ sql }) => {
      // Order matters — more specific matches first. The INSP_SELECT
      // contains an inline subquery `(SELECT name FROM fac_zones
      // WHERE id = i.zone_id)` so the generic `FROM fac_zones WHERE
      // id` filter would otherwise swallow the getById read.
      if (sql.startsWith('SELECT i.id::text AS id'))
        return [
          {
            id: 'fake-inspection-id',
            zone_id: ZONE_ID,
            zone_name: 'Zone A — North Wing',
            inspector_id: ADMIN_ACTOR.personId,
            inspector_name: 'Admin User',
            inspection_date: '2026-05-12',
            overall_rating: 'FAIL',
            notes: 'Floors dirty, soap empty',
            follow_up_required: true,
            follow_up_work_order_id: 'fake-wo-id',
          },
        ];
      if (sql.includes('FROM fac_zones WHERE id'))
        return [{ id: ZONE_ID, name: 'Zone A — North Wing' }];
      if (sql.startsWith('INSERT INTO fac_work_orders')) {
        inserts.push('work_order');
        return 1;
      }
      if (sql.startsWith('INSERT INTO fac_zone_inspections')) {
        inserts.push('inspection');
        return 1;
      }
      return [];
    });
    const { kafka, emits } = makeKafka();
    const svc = new ZoneInspectionService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const result = await svc.create(
        {
          zoneId: ZONE_ID,
          inspectionDate: '2026-05-12',
          overallRating: 'FAIL',
          notes: 'Floors dirty, soap empty',
        },
        ADMIN_ACTOR,
      );
      expect(result.overallRating).toBe('FAIL');
      expect(result.followUpWorkOrderId).toBe('fake-wo-id');
    });
    expect(inserts).toEqual(['work_order', 'inspection']);
    // Kafka emit for the auto-created work order.
    expect(emits).toHaveLength(1);
    expect(emits[0]!.topic).toBe('fac.work_order.created');
    expect(emits[0]!.payload).toMatchObject({
      workOrderType: 'DEEP_CLEAN',
      priority: 'HIGH',
      status: 'OPEN',
    });
  });

  // ─── S10: PASS does NOT create work order ───
  it('S10: zone inspection PASS does NOT create a work order', async () => {
    const inserts: string[] = [];
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.startsWith('SELECT i.id::text AS id'))
        return [
          {
            id: 'x',
            zone_id: ZONE_ID,
            zone_name: 'Zone A',
            inspector_id: ADMIN_ACTOR.personId,
            inspector_name: 'Admin',
            inspection_date: '2026-05-12',
            overall_rating: 'PASS',
            notes: null,
            follow_up_required: false,
            follow_up_work_order_id: null,
          },
        ];
      if (sql.includes('FROM fac_zones WHERE id')) return [{ id: ZONE_ID, name: 'Zone A' }];
      if (sql.startsWith('INSERT INTO fac_work_orders')) {
        inserts.push('work_order');
        return 1;
      }
      if (sql.startsWith('INSERT INTO fac_zone_inspections')) {
        inserts.push('inspection');
        return 1;
      }
      return [];
    });
    const { kafka, emits } = makeKafka();
    const svc = new ZoneInspectionService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.create(
        { zoneId: ZONE_ID, inspectionDate: '2026-05-12', overallRating: 'PASS' },
        ADMIN_ACTOR,
      );
    });
    expect(inserts).toEqual(['inspection']);
    expect(emits).toHaveLength(0);
  });

  // ─── S11: stocktake completion creates ADJUSTMENT per discrepancy ───
  it('S11: completeStocktake creates ADJUSTMENT transactions for discrepancies + updates inventory', async () => {
    const adjustments: Array<{ inventoryId: string; delta: number }> = [];
    const inventoryUpdates: Array<{ inventoryId: string; newQty: number }> = [];
    let statusFlipped = false;
    const { tenantPrisma } = makeFake(({ sql, args }) => {
      if (sql.includes('FROM fac_supply_stocktakes WHERE id') && sql.includes('FOR UPDATE'))
        return [{ id: STOCKTAKE_ID, status: 'IN_PROGRESS', building_id: BUILDING_ID }];
      if (sql.includes('expected_quantity <> actual_quantity'))
        return [
          { inventory_id: INVENTORY_ID, expected_quantity: 10, actual_quantity: 8 },
          {
            inventory_id: INVENTORY_ID.replace('1', '2'),
            expected_quantity: 5,
            actual_quantity: 7,
          },
        ];
      if (sql.startsWith('UPDATE fac_supply_inventory SET current_quantity')) {
        inventoryUpdates.push({
          inventoryId: args[1] as string,
          newQty: args[0] as number,
        });
        return 1;
      }
      if (sql.startsWith('INSERT INTO fac_supply_transactions') && sql.includes("'ADJUSTMENT'")) {
        adjustments.push({
          inventoryId: args[2] as string,
          delta: args[3] as number,
        });
        return 1;
      }
      if (sql.includes("UPDATE fac_supply_stocktakes SET status = 'COMPLETED'")) {
        statusFlipped = true;
        return 1;
      }
      // Final getStocktakeById read.
      if (sql.startsWith('SELECT s.id::text AS id'))
        return [
          {
            id: STOCKTAKE_ID,
            school_id: SCHOOL.schoolId,
            building_id: BUILDING_ID,
            building_name: 'Main Building',
            conducted_by: ADMIN_ACTOR.personId,
            conducted_by_name: 'Admin',
            stocktake_date: '2026-05-12',
            status: 'COMPLETED',
            completed_at: new Date(),
            notes: null,
          },
        ];
      return [];
    });
    const svc = new SupplyAuditService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const result = await svc.completeStocktake(STOCKTAKE_ID, ADMIN_ACTOR);
      expect(result.adjustmentsCreated).toBe(2);
      expect(result.stocktake.status).toBe('COMPLETED');
    });
    expect(statusFlipped).toBe(true);
    expect(adjustments).toHaveLength(2);
    expect(adjustments[0]!.delta).toBe(-2); // 8 - 10
    expect(adjustments[1]!.delta).toBe(2); // 7 - 5
    expect(inventoryUpdates).toHaveLength(2);
    expect(inventoryUpdates[0]!.newQty).toBe(8);
    expect(inventoryUpdates[1]!.newQty).toBe(7);
  });

  // ─── S12: double-complete on COMPLETED → 400 ───
  it('S12: completeStocktake on already-COMPLETED stocktake → 400', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_supply_stocktakes WHERE id'))
        return [{ id: STOCKTAKE_ID, status: 'COMPLETED', building_id: BUILDING_ID }];
      return [];
    });
    const svc = new SupplyAuditService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.completeStocktake(STOCKTAKE_ID, ADMIN_ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ─── S13: createTransaction rejects 0 delta ───
  it('S13: createSupplyTransaction rejects quantityDelta=0', async () => {
    const { tenantPrisma } = makeFake();
    const svc = new SupplyAuditService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.createTransaction(
          {
            buildingId: BUILDING_ID,
            inventoryId: INVENTORY_ID,
            transactionType: 'USAGE',
            quantityDelta: 0,
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── S14: WorkOrderDepthService.getCostSummary SUMs parts + labour ───
  it('S14: getCostSummary returns partsTotal + labourCost + grandTotal', async () => {
    const { tenantPrisma } = makeFake(({ sql }) => {
      if (sql.includes('FROM fac_work_orders WHERE id') && sql.includes('AND school_id'))
        return [{ ok: 1 }];
      if (sql.includes('FROM fac_work_order_parts p WHERE p.work_order_id'))
        return [{ parts_total: 75.5, parts_line_count: 4, labour_cost: 100 }];
      return [];
    });
    const svc = new WorkOrderDepthService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const sum = await svc.getCostSummary(WORK_ORDER_ID);
      expect(sum.partsTotal).toBe(75.5);
      expect(sum.partsLineCount).toBe(4);
      expect(sum.labourCost).toBe(100);
      expect(sum.grandTotal).toBe(175.5);
    });
  });

  // ─── S15: addPart auto-computes total_cost when unitCost + quantity present ───
  it('S15: addPart auto-computes total_cost from unit_cost * quantity', async () => {
    let insertedTotal: number | null | undefined;
    let insertedId: string | undefined;
    const { tenantPrisma } = makeFake(({ sql, args }) => {
      if (sql.includes('FROM fac_work_orders WHERE id')) return [{ ok: 1 }];
      if (sql.startsWith('INSERT INTO fac_work_order_parts')) {
        // args order: id, wo_id, part_name, quantity, unit, unit_cost, total_cost, supplier, notes
        insertedId = args[0] as string;
        insertedTotal = args[6] as number | null;
        return 1;
      }
      // Final listParts read — reflect the just-inserted id so the
      // service's `all.find(p => p.id === id)` succeeds.
      if (sql.startsWith('SELECT p.id::text AS id'))
        return [
          {
            id: insertedId ?? 'new-part-id',
            work_order_id: WORK_ORDER_ID,
            part_name: 'Bearing',
            quantity: 3,
            unit: 'EA',
            unit_cost: 12.5,
            total_cost: 37.5,
            supplier: 'Acme',
            notes: null,
          },
        ];
      return [];
    });
    const svc = new WorkOrderDepthService(tenantPrisma as never, makePerms(true) as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const r = await svc.addPart(
        WORK_ORDER_ID,
        { partName: 'Bearing', quantity: 3, unit: 'EA', unitCost: 12.5, supplier: 'Acme' },
        ADMIN_ACTOR,
      );
      expect(r.totalCost).toBe(37.5);
    });
    expect(insertedTotal).toBe(37.5);
  });

  // ─── S16: Controller permission metadata pinned to FAC-001 / FAC-003 ───
  it('S16: Controller permission metadata pinned to FAC-001 / FAC-003', () => {
    const proto = FacilitiesAdvancedController.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const pairs: Array<[string, string[]]> = [
      ['listRoutes', ['fac-003:read']],
      ['getRoute', ['fac-003:read']],
      ['createRoute', ['fac-003:admin']],
      ['patchRoute', ['fac-003:admin']],
      ['replaceStops', ['fac-003:admin']],
      ['createAssignment', ['fac-003:admin']],
      ['startCompletion', ['fac-003:write']],
      ['patchStopCompletion', ['fac-003:write']],
      ['createInspection', ['fac-003:admin']],
      ['listInspections', ['fac-003:read']],
      ['createSupplyTransaction', ['fac-003:write']],
      ['createStocktake', ['fac-003:admin']],
      ['recordStocktakeItem', ['fac-003:write']],
      ['completeStocktake', ['fac-003:admin']],
      ['listAttachments', ['fac-001:read']],
      ['addAttachment', ['fac-001:write']],
      ['listParts', ['fac-001:read']],
      ['addPart', ['fac-001:write']],
      ['getCostSummary', ['fac-001:read']],
    ];
    for (const [method, expected] of pairs) {
      const handler = proto[method];
      expect(handler).toBeDefined();
      const meta = Reflect.getMetadata(PERMISSIONS_KEY, handler);
      expect(meta).toEqual(expected);
    }
  });

  // ─── Bonus: a NotFound smoke for getCompletionById ───
  it('Bonus: getCompletionById missing → 404', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.getCompletionById(COMPLETION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── Bonus: STUDENT cannot start completion (no employeeId) ───
  it('Bonus: STUDENT actor cannot startCompletion (no employeeId)', async () => {
    const { tenantPrisma } = makeFake();
    const { kafka } = makeKafka();
    const svc = new CleaningRouteService(
      tenantPrisma as never,
      kafka as never,
      makePerms(true) as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.startCompletion({ routeId: ROUTE_ID, assignmentId: ASSIGNMENT_ID }, STUDENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
