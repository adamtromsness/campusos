import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { CleaningRouteService } from './cleaning-route.service';
import { ZoneInspectionService } from './zone-inspection.service';
import { AssetService } from './asset.service';
import { EnergyService } from './energy.service';
import { FireDrillService } from './fire-drill.service';
import { CleaningIssueTicketConsumer } from './cleaning-issue-ticket.consumer';
import {
  deterministicFireDrillOverdueEventId,
  deterministicRouteStopIssueNotedEventId,
  deterministicWorkOrderCreatedEventId,
} from './event-ids';

/**
 * REVIEW-P2C18 Round 1 — pinned regression tests for all 6 blocker fixes.
 *
 * BLOCKING 1 — durable outbox for 3 emits (route_stop / work_order / fire_drill_overdue)
 * BLOCKING 2 — CleaningIssueTicketConsumer envelope-vs-payload + school-scoped lookups
 * BLOCKING 3 — cleaning route helpers school-scoped (getRouteById, patchRoute, listStops, listStopCompletions)
 * BLOCKING 4 — zone inspection getById school-scoped
 * BLOCKING 5 — asset spaceId validated through current-school building
 * BLOCKING 6 — energy reading getReading school-scoped
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

const FOREIGN_SCHOOL = 'ffffffff-aaaa-7eee-aaaa-000000000099';

const ADMIN_ACTOR = {
  accountId: '019e1c39-aaaa-7556-8c81-000000000001',
  personId: '019e1c39-aaaa-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e1c39-aaaa-7556-8c81-000000000099',
} as never;

const ROUTE_ID = '019e1c39-aaaa-7556-8c81-300000000001';
const STOP_COMPL_ID = '019e1c39-aaaa-7556-8c81-700000000001';
const COMPLETION_ID = '019e1c39-aaaa-7556-8c81-600000000001';
const ZONE_INSP_ID = '019e1c39-aaaa-7556-8c81-810000000001';
const ASSET_ID = '019e1c39-aaaa-7556-8c81-a00000000001';
const BUILDING_ID = '019e1c39-aaaa-7556-8c81-900000000001';
const SPACE_ID = '019e1c39-aaaa-7556-8c81-c00000000001';
const READING_ID = '019e1c39-aaaa-7556-8c81-b10000000001';
const CATEGORY_ID = '019e1c39-aaaa-7556-8c81-d00000000001';
const FOREIGN_WORK_ORDER_ID = '019e1c39-aaaa-7556-8c81-cc0000000001';
const FOREIGN_BUILDING_ID = '019e1c39-aaaa-7556-8c81-cc0000000002';

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

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
    eventId?: string;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
        eventId: opts.eventId,
      });
      return 'outbox-id';
    }),
  };
  return { enqueued, outbox };
}

function makePerms(grant = true) {
  return { hasAnyPermissionInTenant: async () => grant };
}

describe('REVIEW-P2C18 ROUND 1 — BLOCKING regressions', () => {
  // ─── BLOCKING 1 — durable outbox for 3 emits ───

  describe('BLOCKING 1 — durable outbox', () => {
    it('R-B1a: CleaningRouteService.patchStopCompletion enqueues fac.route_stop.issue_noted via outbox INSIDE the tx', async () => {
      const { tenantPrisma, capture } = makeFake(({ sql }) => {
        if (sql.includes('FROM fac_cleaning_route_completions c')) {
          return [
            {
              id: COMPLETION_ID,
              route_id: ROUTE_ID,
              overall_status: 'IN_PROGRESS',
              employee_id: 'emp-1',
            },
          ];
        }
        if (sql.includes('FROM fac_cleaning_route_stop_completions sc')) {
          return [{ id: STOP_COMPL_ID, status: 'PENDING', stop_id: 'stop-1', space_id: 'space-1' }];
        }
        if (sql.includes("status = 'PENDING'")) {
          return [{ pending: 2, skipped: 0, total: 3 }];
        }
        if (sql.includes('FROM fac_cleaning_route_stop_completions') && sql.includes('ORDER BY')) {
          return [
            {
              id: STOP_COMPL_ID,
              completion_id: COMPLETION_ID,
              stop_id: 'stop-1',
              status: 'COMPLETED',
              completed_at: new Date(),
              skip_reason: null,
              tasks_completed: [],
              photo_s3_keys: [],
              issues_noted: 'Broken faucet',
            },
          ];
        }
        return [];
      });
      const { outbox, enqueued } = makeOutbox();
      const svc = new CleaningRouteService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await svc.patchStopCompletion(
          COMPLETION_ID,
          'stop-1',
          { status: 'COMPLETED', issuesNoted: 'Broken faucet' },
          ADMIN_ACTOR,
        );
      });
      // Outbox enqueue happens — emit shape verified including
      // deterministic event_id keyed on stop_completion id.
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.topic).toBe('fac.route_stop.issue_noted');
      expect(enqueued[0]!.key).toBe(STOP_COMPL_ID);
      expect(enqueued[0]!.sourceModule).toBe('facilities');
      expect(enqueued[0]!.eventId).toBe(deterministicRouteStopIssueNotedEventId(STOP_COMPL_ID));
      // School + scoping fields on the payload
      expect(enqueued[0]!.payload.schoolId).toBe(SCHOOL.schoolId);
      expect(enqueued[0]!.payload.sourceRefId).toBe(STOP_COMPL_ID);
      // The capture shows the parent-completion query was school-scoped
      const parentLoad = capture.find((c) =>
        c.sql.includes('FROM fac_cleaning_route_completions c'),
      );
      expect(parentLoad!.sql).toMatch(/r\.school_id = \$2::uuid/);
    });

    it('R-B1b: ZoneInspectionService.create on FAIL enqueues fac.work_order.created via outbox', async () => {
      const { tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM fac_zones WHERE id')) return [{ id: 'zone-1', name: 'Zone A' }];
        if (sql.includes('FROM fac_zone_inspections i')) {
          return [
            {
              id: ZONE_INSP_ID,
              zone_id: 'zone-1',
              zone_name: 'Zone A',
              inspector_id: ADMIN_ACTOR.personId,
              inspector_name: 'Sarah',
              inspection_date: '2026-05-01',
              overall_rating: 'FAIL',
              notes: 'Major',
              follow_up_required: true,
              follow_up_work_order_id: 'wo-1',
            },
          ];
        }
        return [];
      });
      const { outbox, enqueued } = makeOutbox();
      const svc = new ZoneInspectionService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await svc.create(
          { zoneId: 'zone-1', inspectionDate: '2026-05-01', overallRating: 'FAIL' },
          ADMIN_ACTOR,
        );
      });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.topic).toBe('fac.work_order.created');
      expect(enqueued[0]!.sourceModule).toBe('facilities');
      // deterministic event_id from the helper
      const expectedId = deterministicWorkOrderCreatedEventId(enqueued[0]!.key);
      expect(enqueued[0]!.eventId).toBe(expectedId);
      expect(enqueued[0]!.payload.schoolId).toBe(SCHOOL.schoolId);
    });

    it('R-B1b2: ZoneInspectionService.create on PASS does NOT enqueue any outbox row', async () => {
      const { tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM fac_zones WHERE id')) return [{ id: 'zone-1', name: 'Zone A' }];
        if (sql.includes('FROM fac_zone_inspections i')) {
          return [
            {
              id: ZONE_INSP_ID,
              zone_id: 'zone-1',
              zone_name: 'Zone A',
              inspector_id: ADMIN_ACTOR.personId,
              inspector_name: 'Sarah',
              inspection_date: '2026-05-01',
              overall_rating: 'PASS',
              notes: null,
              follow_up_required: false,
              follow_up_work_order_id: null,
            },
          ];
        }
        return [];
      });
      const { outbox, enqueued } = makeOutbox();
      const svc = new ZoneInspectionService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await svc.create(
          { zoneId: 'zone-1', inspectionDate: '2026-05-01', overallRating: 'PASS' },
          ADMIN_ACTOR,
        );
      });
      expect(enqueued).toHaveLength(0);
    });

    it('R-B1c: FireDrillService.compliance enqueues fac.fire_drill.overdue per overdue building', async () => {
      const overdueId = BUILDING_ID;
      const healthyId = FOREIGN_BUILDING_ID;
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
      const { outbox, enqueued } = makeOutbox();
      const svc = new FireDrillService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      const result = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.compliance());
      expect(result).toHaveLength(2);
      // Exactly one outbox row for the overdue building (deterministic per
      // (buildingId, today_iso)). Healthy building is silent.
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.topic).toBe('fac.fire_drill.overdue');
      expect(enqueued[0]!.key).toBe(overdueId);
      expect(enqueued[0]!.sourceModule).toBe('facilities');
      const todayIso = new Date().toISOString().slice(0, 10);
      expect(enqueued[0]!.eventId).toBe(deterministicFireDrillOverdueEventId(overdueId, todayIso));
    });

    it('R-B1d: deterministicWorkOrderCreatedEventId stable + v5-shape', () => {
      const a = deterministicWorkOrderCreatedEventId(FOREIGN_WORK_ORDER_ID);
      const b = deterministicWorkOrderCreatedEventId(FOREIGN_WORK_ORDER_ID);
      expect(a).toBe(b);
      expect(a[14]).toBe('5');
      expect(['8', '9', 'a', 'b']).toContain(a[19]);
      const c = deterministicWorkOrderCreatedEventId(FOREIGN_WORK_ORDER_ID.replace('1', '2'));
      expect(a).not.toBe(c);
      // Distinct namespace from other helpers
      const other = deterministicRouteStopIssueNotedEventId(FOREIGN_WORK_ORDER_ID);
      expect(a).not.toBe(other);
    });
  });

  // ─── BLOCKING 2 — CleaningIssueTicketConsumer hardening ───

  describe('BLOCKING 2 — CleaningIssueTicketConsumer cross-module hardening', () => {
    it('R-B2a: envelope-vs-payload tenant mismatch → claim + drop (no ticket insert)', async () => {
      let ticketsInserted = 0;
      const { tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('INSERT INTO tkt_tickets')) {
          ticketsInserted += 1;
          return 1;
        }
        return [];
      });
      const claim = vi.fn(async () => true);
      const idem = { isClaimed: async () => false, claim };
      const consumer = new CleaningIssueTicketConsumer(
        { subscribe: async () => undefined } as never,
        idem as never,
        tenantPrisma as never,
      );
      // Simulate the message with mismatched tenant in envelope vs payload
      const envelopeTenantId = SCHOOL.schoolId;
      const payloadTenantId = FOREIGN_SCHOOL;
      const msg = {
        topic: 'dev.fac.route_stop.issue_noted',
        key: STOP_COMPL_ID,
        payload: {
          event_id: '019e1c39-aaaa-7556-8c81-aaaa00000001',
          event_type: 'fac.route_stop.issue_noted',
          event_version: 1,
          tenant_id: envelopeTenantId,
          source_module: 'facilities',
          payload: {
            stopCompletionId: STOP_COMPL_ID,
            issuesNoted: 'Spoofed',
            schoolId: payloadTenantId,
            reportedByAccountId: 'r1',
          },
        },
        headers: { 'tenant-subdomain': 'demo' },
      };
      await (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle(msg);
      expect(ticketsInserted).toBe(0);
      expect(claim).toHaveBeenCalledTimes(1);
    });

    it('R-B2b: category lookup is school-scoped', async () => {
      // Capture the SQL that scans tkt_categories to assert the school_id
      // predicate. The test makes the lookup return zero rows so the
      // consumer throws NO_FACILITIES_CATEGORY — the SQL we want to
      // inspect was already issued before the throw, which is the
      // signal that the school-scoped query ran and matched nothing
      // in the foreign school.
      const { capture, tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM tkt_categories')) return [];
        return [];
      });
      const idem = { isClaimed: async () => false, claim: async () => true };
      const consumer = new CleaningIssueTicketConsumer(
        { subscribe: async () => undefined } as never,
        idem as never,
        tenantPrisma as never,
      );
      const msg = {
        topic: 'dev.fac.route_stop.issue_noted',
        key: STOP_COMPL_ID,
        payload: {
          event_id: '019e1c39-aaaa-7556-8c81-aaaa00000002',
          event_type: 'fac.route_stop.issue_noted',
          event_version: 1,
          tenant_id: SCHOOL.schoolId,
          source_module: 'facilities',
          payload: {
            stopCompletionId: STOP_COMPL_ID,
            issuesNoted: 'Broken faucet',
            schoolId: SCHOOL.schoolId,
            reportedByAccountId: 'r1',
          },
        },
        headers: { 'tenant-subdomain': 'demo' },
      };
      // Consumer is expected to throw NO_FACILITIES_CATEGORY so the
      // process-with-idempotency wrapper does NOT claim. The point of
      // this test is the SQL shape that was captured BEFORE the throw.
      await expect(
        (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle(msg),
      ).rejects.toThrow();
      const catLookup = capture.find((c) => c.sql.includes('FROM tkt_categories'));
      expect(catLookup).toBeDefined();
      expect(catLookup!.sql).toMatch(/school_id = \$1::uuid/);
      expect(catLookup!.args[0]).toBe(SCHOOL.schoolId);
    });

    it('R-B2c: school-admin requester fallback joins iam_scope_type filtered to envelope school', async () => {
      // Force the path: payload omits reportedByAccountId. Existing
      // ticket check returns []. Category lookup returns one row.
      // Admin fallback query is the one we inspect.
      const { capture, tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM tkt_categories')) {
          return [{ id: CATEGORY_ID, name: 'Facilities' }];
        }
        if (sql.includes('platform.iam_effective_access_cache')) {
          return [{ account_id: 'admin-account-1' }];
        }
        return [];
      });
      const idem = { isClaimed: async () => false, claim: async () => true };
      const consumer = new CleaningIssueTicketConsumer(
        { subscribe: async () => undefined } as never,
        idem as never,
        tenantPrisma as never,
      );
      const msg = {
        topic: 'dev.fac.route_stop.issue_noted',
        key: STOP_COMPL_ID,
        payload: {
          event_id: '019e1c39-aaaa-7556-8c81-aaaa00000003',
          event_type: 'fac.route_stop.issue_noted',
          event_version: 1,
          tenant_id: SCHOOL.schoolId,
          source_module: 'facilities',
          payload: {
            stopCompletionId: STOP_COMPL_ID,
            issuesNoted: 'Broken faucet',
            schoolId: SCHOOL.schoolId,
            // NO reportedByAccountId — forces the admin fallback path
          },
        },
        headers: { 'tenant-subdomain': 'demo' },
      };
      await (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle(msg);
      const adminLookup = capture.find((c) =>
        c.sql.includes('platform.iam_effective_access_cache'),
      );
      expect(adminLookup).toBeDefined();
      // Joins iam_scope + iam_scope_type with SCHOOL-scope + envelope school
      expect(adminLookup!.sql).toContain('platform.iam_scope sc');
      expect(adminLookup!.sql).toContain('platform.iam_scope_type st');
      expect(adminLookup!.sql).toMatch(/st\.code = 'SCHOOL'/);
      expect(adminLookup!.sql).toMatch(/sc\.entity_id = \$1::uuid/);
      expect(adminLookup!.args[0]).toBe(SCHOOL.schoolId);
    });

    it('R-B2d: ticket INSERT uses envelope schoolId, not payload schoolId', async () => {
      const { capture, tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM tkt_categories')) {
          return [{ id: CATEGORY_ID, name: 'Facilities' }];
        }
        return [];
      });
      const idem = { isClaimed: async () => false, claim: async () => true };
      const consumer = new CleaningIssueTicketConsumer(
        { subscribe: async () => undefined } as never,
        idem as never,
        tenantPrisma as never,
      );
      const msg = {
        topic: 'dev.fac.route_stop.issue_noted',
        key: STOP_COMPL_ID,
        payload: {
          event_id: '019e1c39-aaaa-7556-8c81-aaaa00000004',
          event_type: 'fac.route_stop.issue_noted',
          event_version: 1,
          tenant_id: SCHOOL.schoolId,
          source_module: 'facilities',
          payload: {
            stopCompletionId: STOP_COMPL_ID,
            issuesNoted: 'Broken faucet',
            schoolId: SCHOOL.schoolId,
            reportedByAccountId: 'r-1',
          },
        },
        headers: { 'tenant-subdomain': 'demo' },
      };
      await (consumer as unknown as { handle: (m: unknown) => Promise<void> }).handle(msg);
      const insertCall = capture.find((c) => c.sql.includes('INSERT INTO tkt_tickets'));
      expect(insertCall).toBeDefined();
      // arg $2 is the school_id binding — must be the envelope tenant id
      expect(insertCall!.args[1]).toBe(SCHOOL.schoolId);
    });
  });

  // ─── BLOCKING 3 — cleaning route helpers school-scoped ───

  describe('BLOCKING 3 — cleaning route helpers school-scoped', () => {
    it('R-B3a: getRouteById SQL carries r.school_id = $2::uuid + tenant arg', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const { outbox } = makeOutbox();
      const svc = new CleaningRouteService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(svc.getRouteById(ROUTE_ID)).rejects.toBeInstanceOf(NotFoundException);
      });
      const sel = capture.find((c) => c.sql.includes('FROM fac_cleaning_routes r WHERE r.id'));
      expect(sel!.sql).toMatch(/r\.school_id = \$2::uuid/);
      expect(sel!.args[1]).toBe(SCHOOL.schoolId);
    });

    it('R-B3b: patchRoute UPDATE carries id + school_id predicate', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const { outbox } = makeOutbox();
      const svc = new CleaningRouteService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(
          svc.patchRoute(ROUTE_ID, { name: 'New Name' }, ADMIN_ACTOR),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
      const upd = capture.find((c) => c.sql.startsWith('UPDATE fac_cleaning_routes SET'));
      expect(upd!.sql).toMatch(/AND school_id = \$\d+::uuid RETURNING id/);
      // Last 2 args are id + tenant.schoolId
      expect(upd!.args[upd!.args.length - 1]).toBe(SCHOOL.schoolId);
    });

    it('R-B3c: listStops JOINs fac_cleaning_routes with r.school_id predicate', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const { outbox } = makeOutbox();
      const svc = new CleaningRouteService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await svc.listStops(ROUTE_ID);
      });
      const sel = capture.find((c) => c.sql.includes('FROM fac_cleaning_route_stops s'));
      expect(sel!.sql).toMatch(/JOIN fac_cleaning_routes r ON r\.id = s\.route_id/);
      expect(sel!.sql).toMatch(/r\.school_id = \$2::uuid/);
    });

    it('R-B3d: listStopCompletions JOINs route + completion with school predicate', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const { outbox } = makeOutbox();
      const svc = new CleaningRouteService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      // listStopCompletions is private; reach through patchStopCompletion's
      // post-update reload by faking responses minimally:
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        const internal = (
          svc as unknown as {
            listStopCompletions: (id: string) => Promise<unknown[]>;
          }
        ).listStopCompletions;
        await internal.call(svc, COMPLETION_ID);
      });
      const sel = capture.find((c) =>
        c.sql.includes('FROM fac_cleaning_route_stop_completions sc'),
      );
      expect(sel!.sql).toMatch(
        /JOIN fac_cleaning_route_completions c ON c\.id = sc\.completion_id/,
      );
      expect(sel!.sql).toMatch(/JOIN fac_cleaning_routes r ON r\.id = c\.route_id/);
      expect(sel!.sql).toMatch(/r\.school_id = \$2::uuid/);
    });
  });

  // ─── BLOCKING 4 — zone inspection getById school-scoped ───

  describe('BLOCKING 4 — zone inspection getById school-scoped', () => {
    it('R-B4a: getById JOIN includes z.school_id + tenant arg', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const { outbox } = makeOutbox();
      const svc = new ZoneInspectionService(
        tenantPrisma as never,
        outbox as never,
        makePerms(true) as never,
      );
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(svc.getById(ZONE_INSP_ID)).rejects.toBeInstanceOf(NotFoundException);
      });
      const sel = capture.find((c) => c.sql.includes('FROM fac_zone_inspections i'));
      expect(sel!.sql).toMatch(/JOIN fac_zones z/);
      expect(sel!.sql).toMatch(/z\.school_id = \$2::uuid/);
      expect(sel!.args[1]).toBe(SCHOOL.schoolId);
    });
  });

  // ─── BLOCKING 5 — asset spaceId validated through current-school building ───

  describe('BLOCKING 5 — asset spaceId validated through building school', () => {
    it('R-B5a: createAsset spaceId validation JOINs fac_buildings with b.school_id + asset.buildingId', async () => {
      const { capture, tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('FROM fac_asset_categories')) return [{ ok: 1 }];
        if (sql.includes('FROM fac_buildings WHERE id')) return [{ ok: 1 }];
        // spaceId lookup returns 0 rows — service should throw 400
        return [];
      });
      const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(
          svc.createAsset(
            {
              categoryId: CATEGORY_ID,
              buildingId: BUILDING_ID,
              spaceId: SPACE_ID,
              name: 'New Asset',
            },
            ADMIN_ACTOR,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      const spLookup = capture.find(
        (c) =>
          c.sql.includes('FROM fac_spaces s') &&
          c.sql.includes('JOIN fac_buildings b ON b.id = s.building_id'),
      );
      expect(spLookup).toBeDefined();
      expect(spLookup!.sql).toMatch(/b\.school_id = \$2::uuid/);
      expect(spLookup!.sql).toMatch(/b\.id = \$3::uuid/);
      expect(spLookup!.args[1]).toBe(SCHOOL.schoolId);
      expect(spLookup!.args[2]).toBe(BUILDING_ID);
    });

    it('R-B5b: patchAsset spaceId validation reads asset.building_id + JOINs through fac_buildings', async () => {
      const { capture, tenantPrisma } = makeFake(({ sql }) => {
        if (sql.includes('SELECT building_id::text AS building_id FROM fac_assets')) {
          return [{ building_id: BUILDING_ID }];
        }
        if (
          sql.includes('FROM fac_spaces s') &&
          sql.includes('JOIN fac_buildings b ON b.id = s.building_id')
        ) {
          // spaceId lookup returns 0 rows — service should throw 400
          return [];
        }
        return [];
      });
      const svc = new AssetService(tenantPrisma as never, makePerms(true) as never);
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(
          svc.patchAsset(ASSET_ID, { spaceId: SPACE_ID }, ADMIN_ACTOR),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
      const spLookup = capture.find(
        (c) =>
          c.sql.includes('FROM fac_spaces s') &&
          c.sql.includes('JOIN fac_buildings b ON b.id = s.building_id'),
      );
      expect(spLookup).toBeDefined();
      expect(spLookup!.sql).toMatch(/b\.school_id = \$2::uuid/);
      expect(spLookup!.args[1]).toBe(SCHOOL.schoolId);
      expect(spLookup!.args[2]).toBe(BUILDING_ID);
    });
  });

  // ─── BLOCKING 6 — energy reading getReading school-scoped ───

  describe('BLOCKING 6 — energy reading getReading school-scoped', () => {
    it('R-B6a: getReading JOIN includes fac_utility_meters + m.school_id', async () => {
      const { capture, tenantPrisma } = makeFake(() => []);
      const svc = new EnergyService(tenantPrisma as never, makePerms(true) as never);
      await runWithTenantContext({ tenant: SCHOOL }, async () => {
        await expect(svc.getReading(READING_ID)).rejects.toBeInstanceOf(NotFoundException);
      });
      const sel = capture.find((c) => c.sql.includes('FROM fac_energy_readings r'));
      expect(sel!.sql).toMatch(/JOIN fac_utility_meters m ON m\.id = r\.meter_id/);
      expect(sel!.sql).toMatch(/m\.school_id = \$2::uuid/);
      expect(sel!.args[1]).toBe(SCHOOL.schoolId);
    });
  });
});
