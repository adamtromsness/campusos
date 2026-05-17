import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { TimelineService } from './timeline.service';
import { AccountabilityService } from '../reunification/accountability.service';
import { ReunificationService } from '../reunification/reunification.service';
import { DrillService } from '../drills/drill.service';
import { IncidentService } from './incident.service';

/**
 * P2C2 keystone unit tests.
 *
 * Coverage strategy: each test asserts a single load-bearing
 * invariant from the cycle — schema-level lockstep, service-side
 * immutability, atomic state-machine transitions, idempotent
 * outbox stamping. The fake TenantPrismaService captures every
 * $queryRawUnsafe / $executeRawUnsafe so we can assert SQL shape
 * without a live DB.
 */

const SCHOOL_A: TenantInfo = {
  schoolId: '019e03f8-cf0b-7444-92d2-85e2c67b549a',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const SCHOOL_B: TenantInfo = {
  ...SCHOOL_A,
  schoolId: '019e03f8-cf0b-7444-92d2-85e2c67b549b',
};

const ACTOR_BASE = {
  accountId: '99999999-9999-9999-9999-999999999999',
  personId: '88888888-8888-8888-8888-888888888888',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};
const ADMIN_ACTOR = { ...ACTOR_BASE, isSchoolAdmin: true } as never;

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
  const permissions = { hasAnyPermissionInTenant: async () => true };
  return { capture, client, tenantPrisma, permissions };
}

describe('TimelineService — IMMUTABLE legal record (ADR-010)', () => {
  it('exposes only `append` and `listForIncident`', () => {
    const fake = makeFake(() => []);
    const svc = new TimelineService(fake.tenantPrisma as never, fake.permissions as never);
    const fns = Object.getOwnPropertyNames(Object.getPrototypeOf(svc)).filter(
      (n) => n !== 'constructor',
    );
    // Public API must NOT include any mutation method other than append.
    expect(fns.sort()).toEqual(['append', 'assertResponder', 'listForIncident', 'rowToDto'].sort());
    // Critical: no patch / update / delete / archive on the prototype.
    expect(fns).not.toContain('patch');
    expect(fns).not.toContain('update');
    expect(fns).not.toContain('delete');
    expect(fns).not.toContain('archive');
  });

  it('append throws NotFoundException when the incident is not in the calling tenant', async () => {
    const fake = makeFake((c) => {
      // No incident matches the SCHOOL_B/incidentId combination.
      if (c.sql.includes('FROM inc_incidents WHERE school_id')) return [];
      return [];
    });
    const svc = new TimelineService(fake.tenantPrisma as never, fake.permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL_B }, async () =>
        svc.append(
          '00000000-0000-0000-0000-000000000123',
          { eventType: 'TEST', description: 'hi' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('listForIncident JOIN scopes through inc_incidents.school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new TimelineService(fake.tenantPrisma as never, fake.permissions as never);
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.listForIncident('00000000-0000-0000-0000-000000000123'),
    );
    expect(fake.capture).toHaveLength(1);
    const sql = fake.capture[0]!.sql;
    expect(sql.toLowerCase()).toContain('join inc_incidents i on i.id = t.incident_id');
    expect(sql.toLowerCase()).toContain('and i.school_id = $1::uuid');
  });
});

describe('AccountabilityService — summary materialisation (ADR-018 in-tx)', () => {
  it('recomputeSummaryInTx UPSERTs all six counters from a single COUNT(*) FILTER query', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      if (stage === 1) {
        // The COUNT(*) FILTER aggregator returns one row.
        expect(c.sql.toLowerCase()).toContain("count(*) filter (where status='accounted_for')");
        return [
          {
            total: 12,
            accounted_for: 8,
            unknown: 2,
            evacuated: 1,
            medical_assistance: 1,
            missing: 0,
          },
        ];
      }
      if (stage === 2) {
        // The UPSERT must use ON CONFLICT (incident_id) DO UPDATE.
        expect(c.sql.toLowerCase()).toContain('on conflict (incident_id) do update');
        // All six counters bound through positional params.
        expect(c.args.length).toBeGreaterThanOrEqual(8);
      }
      return [];
    });
    const svc = new AccountabilityService(fake.tenantPrisma as never, fake.permissions as never);
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.recomputeSummaryInTx(fake.client as never, '00000000-0000-0000-0000-0000000000aa'),
    );
    // Two SQL calls expected — count, then upsert.
    expect(fake.capture).toHaveLength(2);
  });

  it('bulkUpdate runs a single CTE UPDATE bound to incident_id and recordIds[]', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      // 1: incident-tenant guard
      if (stage === 1) return [{ id: 'incident-id' }];
      // 2: WITH upd AS UPDATE … RETURNING
      if (stage === 2) {
        expect(c.sql.toLowerCase()).toContain('with upd as');
        expect(c.sql.toLowerCase()).toContain('update inc_accountability_records');
        return [{ n: 3 }];
      }
      // 3: recompute summary count
      if (stage === 3)
        return [
          {
            total: 0,
            accounted_for: 0,
            unknown: 0,
            evacuated: 0,
            medical_assistance: 0,
            missing: 0,
          },
        ];
      return [];
    });
    const svc = new AccountabilityService(fake.tenantPrisma as never, fake.permissions as never);
    const out = await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.bulkUpdate(
        'incident-id',
        {
          recordIds: [
            '00000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000002',
            '00000000-0000-0000-0000-000000000003',
          ],
          status: 'ACCOUNTED_FOR',
        },
        ADMIN_ACTOR,
      ),
    );
    expect(out.updated).toBe(3);
  });

  it('bulkUpdate rejects empty recordIds with BadRequestException', async () => {
    const fake = makeFake(() => []);
    const svc = new AccountabilityService(fake.tenantPrisma as never, fake.permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.bulkUpdate('incident-id', { recordIds: [], status: 'ACCOUNTED_FOR' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ReunificationService — identity-verified release (cross-cycle to P2C1 vis_sign_ins)', () => {
  it('rejects release when releasedToId is not currently signed in (active_signins=0)', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      // 1: incident lookup
      if (stage === 1) return [{ id: 'inc', status: 'ACTIVE' }];
      // 2: student lookup
      if (stage === 2) return [{ id: 'student' }];
      // 3: vis_visitors + active_signins COUNT (returns 0 — not signed in)
      if (stage === 3) {
        expect(c.sql.toLowerCase()).toContain('vis_sign_ins s');
        expect(c.sql.toLowerCase()).toContain('signed_out_at is null');
        return [{ id: 'visitor', school_id: SCHOOL_A.schoolId, active_signins: 0 }];
      }
      return [];
    });
    const svc = new ReunificationService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      undefined as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.create(
          'inc',
          {
            studentId: '00000000-0000-0000-0000-000000000001',
            releasedToId: '00000000-0000-0000-0000-0000000000aa',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/currently signed in/i);
  });

  it('rejects release when the incident is not ACTIVE', async () => {
    const fake = makeFake((c) => {
      if (c.sql.includes('FROM inc_incidents')) return [{ id: 'inc', status: 'RESOLVED' }];
      return [];
    });
    const svc = new ReunificationService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      undefined as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.create(
          'inc',
          {
            studentId: '00000000-0000-0000-0000-000000000001',
            releasedToId: '00000000-0000-0000-0000-0000000000aa',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/active incidents/i);
  });

  it('correct() rejects reasons shorter than 20 characters (cannot bypass an identity-verified release with a one-word "oops")', async () => {
    const fake = makeFake(() => []);
    const svc = new ReunificationService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      undefined as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.correct('reun-id', { correctionReason: 'wrong' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/at least 20 characters/i);
  });
});

describe('DrillService — overdue calculation (>90 days since last COMPLETED)', () => {
  it('overdue() emits a CTE last_done MAX(completed_at) joined to the regulatory-required types', async () => {
    const fake = makeFake((c) => {
      expect(c.sql.toLowerCase()).toContain('with last_done as');
      expect(c.sql.toLowerCase()).toContain("status = 'completed'");
      expect(c.sql.toLowerCase()).toContain("interval '90 days'");
      // The four regulatory-required types appear in the VALUES clause.
      expect(c.sql).toContain("'FIRE_EVACUATION'");
      expect(c.sql).toContain("'LOCKDOWN'");
      expect(c.sql).toContain("'SHELTER_IN_PLACE'");
      expect(c.sql).toContain("'MEDICAL_EMERGENCY'");
      return [{ procedure_type: 'LOCKDOWN', last_completed_at: null, days_since_last_drill: 9999 }];
    });
    const svc = new DrillService(fake.tenantPrisma as never, fake.permissions as never);
    const out = await runWithTenantContext({ tenant: SCHOOL_A }, async () => svc.overdue());
    expect(out).toHaveLength(1);
    expect(out[0]!.procedureType).toBe('LOCKDOWN');
    expect(out[0]!.daysSinceLastDrill).toBe(9999);
  });

  it('complete() rejects if the drill is not SCHEDULED', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('select status from inc_drills')) {
        return [{ status: 'COMPLETED' }];
      }
      return [];
    });
    const svc = new DrillService(fake.tenantPrisma as never, fake.permissions as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.complete(
          'drill-id',
          {
            completedAt: new Date().toISOString(),
            durationSeconds: 600,
            participationRate: 0.95,
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toThrow(/SCHEDULED/);
  });
});

describe('IncidentService — atomic declaration + lifecycle locks', () => {
  it('declare() inserts inc_incidents AND inc_declaration_outbox in the same tx', async () => {
    let stage = 0;
    const fake = makeFake((c) => {
      stage += 1;
      // 1: type lookup
      if (stage === 1 && c.sql.includes('FROM inc_incident_types'))
        return [{ id: 'type-1', is_active: true }];
      // 2: insert incident (execute)
      if (c.fn === 'execute' && c.sql.toLowerCase().includes('insert into inc_incidents')) {
        expect(c.sql.toLowerCase()).toContain('insert into inc_incidents');
        return 1;
      }
      // 3: insert outbox (execute) — same tx
      if (
        c.fn === 'execute' &&
        c.sql.toLowerCase().includes('insert into inc_declaration_outbox')
      ) {
        return 1;
      }
      // 4: SELECT_INCIDENT_BASE for the response
      if (c.sql.toLowerCase().includes('from inc_incidents i')) {
        return [
          {
            id: 'inc',
            school_id: SCHOOL_A.schoolId,
            incident_type_id: 'type-1',
            type_code: 'LOCKDOWN',
            type_name: 'Lockdown',
            severity: 'CRITICAL',
            requires_lockdown: true,
            declared_by: ACTOR_BASE.accountId,
            declared_by_first: 'Sarah',
            declared_by_last: 'Mitchell',
            declared_at: new Date().toISOString(),
            title: null,
            description: null,
            status: 'ACTIVE',
            resolved_at: null,
            resolved_by: null,
            resolution_notes: null,
            created_at: '2026-05-09T00:00:00Z',
            updated_at: '2026-05-09T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const kafka = { emit: async () => undefined };
    const svc = new IncidentService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      kafka as never,
    );
    const out = await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.declare({ incidentTypeId: 'type-1' }, ADMIN_ACTOR),
    );
    expect(out.status).toBe('ACTIVE');
    expect(out.incidentTypeCode).toBe('LOCKDOWN');
    // Confirm both inserts happened (incidents + outbox).
    const insertSqls = fake.capture
      .filter((c) => c.fn === 'execute')
      .map((c) => c.sql.toLowerCase());
    expect(insertSqls.some((s) => s.includes('insert into inc_incidents'))).toBe(true);
    expect(insertSqls.some((s) => s.includes('insert into inc_declaration_outbox'))).toBe(true);
  });

  it('resolve() throws if the incident is not ACTIVE', async () => {
    const fake = makeFake((c) => {
      if (c.sql.toLowerCase().includes('for update')) return [{ id: 'inc', status: 'RESOLVED' }];
      return [];
    });
    const kafka = { emit: async () => undefined };
    const svc = new IncidentService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.resolve('inc', { resolutionNotes: 'all clear, fully resolved.' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/ACTIVE/);
  });

  it('declare() rejects an inactive incident type with a friendly 400', async () => {
    const fake = makeFake((c) => {
      if (c.sql.includes('FROM inc_incident_types')) return [{ id: 'type-1', is_active: false }];
      return [];
    });
    const kafka = { emit: async () => undefined };
    const svc = new IncidentService(
      fake.tenantPrisma as never,
      fake.permissions as never,
      kafka as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.declare({ incidentTypeId: 'type-1' }, ADMIN_ACTOR),
      ),
    ).rejects.toThrow(/inactive/i);
  });
});

// ---------------------------------------------------------------------------
// REVIEW-P2C2 ROUND 1 — DeclarationOutboxWorker emit-first-stamp-after.
// ---------------------------------------------------------------------------
//
// The reviewer's BLOCKING #1: the prior worker stamped `alert_sent_at`
// inside the tx, then emitted Kafka outside the tx and swallowed
// failures. A broker outage left the outbox saying "alert sent" while
// the wire never carried the event. The fix: emit FIRST, stamp ONLY on
// success.
//
// These tests use a stubbed TenantPrismaService that captures every SQL
// shape. The asserts hinge on:
//
//   (a) On Kafka emit failure the column stays NULL and last_error is
//       recorded.
//   (b) On Kafka emit success the column is stamped and last_error is
//       cleared.
//   (c) Re-running after success does not re-emit (still-pending check
//       returns false → step is a no-op).
//   (d) The worker writes neither tsk_tasks (BLOCKING #2) nor
//       vis_emergency_muster (BLOCKING #3) — only emits events for
//       Cycle 7 / P2C1 to consume.
//
// The stub returns 0/[] for queries unless the test handler overrides.

import { DeclarationOutboxWorker, deterministicStepEventId } from '../emergency/declaration-outbox.worker';

interface FakeOutboxRow {
  id: string;
  incident_id: string;
  school_id: string;
  declared_at: string;
  tasks_created_at: string | null;
  muster_taken_at: string | null;
  alert_sent_at: string | null;
  attempt_count: number;
  incident_title: string | null;
  incident_type_code: string | null;
  procedure_type: string | null;
  primary_contact_id: string | null;
  secondary_contact_id: string | null;
  notification_template: string | null;
  severity: string | null;
}

function baseRow(overrides: Partial<FakeOutboxRow> = {}): FakeOutboxRow {
  return {
    id: 'outbox-id-12345',
    incident_id: 'incident-id-67890',
    school_id: SCHOOL_A.schoolId,
    declared_at: new Date().toISOString(),
    tasks_created_at: null,
    muster_taken_at: null,
    alert_sent_at: null,
    attempt_count: 0,
    incident_title: 'Test Lockdown',
    incident_type_code: 'LOCKDOWN',
    procedure_type: 'LOCKDOWN',
    primary_contact_id: 'contact-A',
    secondary_contact_id: 'contact-B',
    notification_template: 'A lockdown is in effect.',
    severity: 'CRITICAL',
    ...overrides,
  };
}

/** Build a fake worker + capture map keyed on column name. */
function makeWorkerFake(opts: {
  emitOk?: boolean;
  emitError?: string;
  // Initial column values so tests can simulate "step already stamped."
  tasksAt?: string | null;
  musterAt?: string | null;
  alertAt?: string | null;
  // For runStepMuster — the visitor count.
  visitorCount?: number;
}) {
  const sqlCalls: { sql: string; args: unknown[]; fn: 'q' | 'e' }[] = [];
  const emits: { topic: string; eventId: string; payload: unknown }[] = [];
  // Mutable column state — UPDATE handlers will mutate this.
  const cols = {
    tasks_created_at: opts.tasksAt ?? null,
    muster_taken_at: opts.musterAt ?? null,
    alert_sent_at: opts.alertAt ?? null,
    last_error: null as string | null,
    attempt_count: 0,
  };

  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      sqlCalls.push({ sql, args, fn: 'q' });
      const lower = sql.toLowerCase();
      // Lock + still-pending check: "SELECT id, <step> AS step_at FROM inc_declaration_outbox WHERE id ... FOR UPDATE"
      if (lower.includes('for update') && lower.includes('inc_declaration_outbox')) {
        let stepAt: string | null = null;
        if (lower.includes('tasks_created_at as step_at')) stepAt = cols.tasks_created_at;
        else if (lower.includes('muster_taken_at as step_at')) stepAt = cols.muster_taken_at;
        else if (lower.includes('alert_sent_at as step_at')) stepAt = cols.alert_sent_at;
        return [{ id: args[0], step_at: stepAt }];
      }
      // Visitor count for runStepMuster
      if (lower.includes('count(*)::int as n from vis_sign_ins')) {
        return [{ n: opts.visitorCount ?? 0 }];
      }
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      sqlCalls.push({ sql, args, fn: 'e' });
      const lower = sql.toLowerCase();
      // Stamp success — UPDATE inc_declaration_outbox SET <step> = now()
      if (lower.includes('update inc_declaration_outbox')) {
        if (lower.includes('tasks_created_at = now()')) cols.tasks_created_at = 'STAMPED';
        if (lower.includes('muster_taken_at = now()')) cols.muster_taken_at = 'STAMPED';
        if (lower.includes('alert_sent_at = now()')) cols.alert_sent_at = 'STAMPED';
        if (lower.includes('last_error = null')) cols.last_error = null;
        // Step-error path: SET last_error = $1 (no column stamp).
        if (lower.includes('last_error = $1')) cols.last_error = String(args[0]);
        cols.attempt_count += 1;
      }
      return 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  const kafka = {
    emit: async (opts2: { topic: string; eventId?: string; payload: unknown }) => {
      if (!opts.emitOk) {
        throw new Error(opts.emitError ?? 'broker unavailable');
      }
      emits.push({
        topic: opts2.topic,
        eventId: opts2.eventId ?? '<no-eventId>',
        payload: opts2.payload,
      });
    },
  };
  const worker = new DeclarationOutboxWorker(tenantPrisma as never, kafka as never);
  return { worker, sqlCalls, emits, cols };
}

describe('DeclarationOutboxWorker.runStepAlert — emit-first-stamp-after (BLOCKING #1)', () => {
  it('on Kafka emit FAILURE leaves alert_sent_at NULL and records last_error', async () => {
    const fake = makeWorkerFake({ emitOk: false, emitError: 'broker offline' });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepAlert(baseRow()),
    );
    // alert_sent_at MUST stay NULL so the next poll picks the row up.
    expect(fake.cols.alert_sent_at).toBeNull();
    expect(fake.cols.last_error).toContain('broker offline');
    expect(fake.emits).toHaveLength(0);
    // The row remains in the pending query result on the next tick.
  });

  it('on Kafka emit SUCCESS stamps alert_sent_at and clears last_error', async () => {
    const fake = makeWorkerFake({ emitOk: true });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepAlert(baseRow()),
    );
    expect(fake.cols.alert_sent_at).toBe('STAMPED');
    expect(fake.cols.last_error).toBeNull();
    expect(fake.emits).toHaveLength(1);
    expect(fake.emits[0]!.topic).toBe('inc.emergency.alert.dispatch');
    // Deterministic event_id for retry-idempotency
    expect(fake.emits[0]!.eventId).toBe(deterministicStepEventId('outbox-id-12345', 'alert'));
  });

  it('does NOT re-emit if alert_sent_at is already stamped (idempotent)', async () => {
    const fake = makeWorkerFake({ emitOk: true, alertAt: '2026-05-09T10:00:00Z' });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepAlert(baseRow({ alert_sent_at: '2026-05-09T10:00:00Z' })),
    );
    expect(fake.emits).toHaveLength(0);
  });
});

describe('DeclarationOutboxWorker.runStepTasks — no direct tsk_tasks INSERT (BLOCKING #2)', () => {
  it('emits inc.emergency.task.requested per contact and never INSERTs into tsk_tasks', async () => {
    const fake = makeWorkerFake({ emitOk: true });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepTasks(baseRow()),
    );
    // Two contacts → two emits, each with a distinct deterministic event_id.
    expect(fake.emits).toHaveLength(2);
    expect(fake.emits[0]!.topic).toBe('inc.emergency.task.requested');
    expect(fake.emits[1]!.topic).toBe('inc.emergency.task.requested');
    expect(fake.emits[0]!.eventId).toBe(deterministicStepEventId('outbox-id-12345', 'tasks-0'));
    expect(fake.emits[1]!.eventId).toBe(deterministicStepEventId('outbox-id-12345', 'tasks-1'));
    // CRITICAL: the worker never writes to tsk_tasks. ADR-011 says the
    // Task Worker is the sole writer.
    const inserts = fake.sqlCalls.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into tsk_tasks'),
    );
    expect(inserts).toHaveLength(0);
    expect(fake.cols.tasks_created_at).toBe('STAMPED');
  });

  it('on Kafka emit FAILURE for any contact leaves tasks_created_at NULL', async () => {
    const fake = makeWorkerFake({ emitOk: false, emitError: 'broker offline' });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepTasks(baseRow()),
    );
    expect(fake.cols.tasks_created_at).toBeNull();
    expect(fake.cols.last_error).toContain('emit task failed');
  });

  it('stamps tasks_created_at when no procedure contacts exist (no-op success path)', async () => {
    const fake = makeWorkerFake({ emitOk: true });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepTasks(baseRow({ primary_contact_id: null, secondary_contact_id: null })),
    );
    expect(fake.emits).toHaveLength(0);
    expect(fake.cols.tasks_created_at).toBe('STAMPED');
  });
});

describe('DeclarationOutboxWorker.runStepMuster — no direct vis_emergency_muster INSERT (BLOCKING #3)', () => {
  it('emits inc.emergency.muster.requested and never INSERTs into vis_emergency_muster', async () => {
    const fake = makeWorkerFake({ emitOk: true, visitorCount: 3 });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepMuster(baseRow()),
    );
    expect(fake.emits).toHaveLength(1);
    expect(fake.emits[0]!.topic).toBe('inc.emergency.muster.requested');
    expect(fake.emits[0]!.eventId).toBe(deterministicStepEventId('outbox-id-12345', 'muster'));
    const payload = fake.emits[0]!.payload as { totalOnSiteAtSnapshot: number; drillType: string };
    expect(payload.totalOnSiteAtSnapshot).toBe(3);
    expect(payload.drillType).toBe('LOCKDOWN');
    // CRITICAL: no INSERT INTO vis_emergency_muster anywhere — the
    // Visitor module owns that write via VisitorMusterConsumer.
    const visMusterInserts = fake.sqlCalls.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into vis_emergency_muster'),
    );
    expect(visMusterInserts).toHaveLength(0);
    // The M91-internal accountability + summary seeds DO run.
    const accInserts = fake.sqlCalls.filter(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into inc_accountability_records'),
    );
    expect(accInserts.length).toBeGreaterThan(0);
    expect(fake.cols.muster_taken_at).toBe('STAMPED');
  });

  it('on Kafka emit FAILURE leaves muster_taken_at NULL', async () => {
    const fake = makeWorkerFake({ emitOk: false, emitError: 'broker offline' });
    await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      fake.worker.runStepMuster(baseRow()),
    );
    expect(fake.cols.muster_taken_at).toBeNull();
    expect(fake.cols.last_error).toContain('emit muster failed');
  });
});

describe('deterministicStepEventId — retry-idempotency invariant', () => {
  it('produces the same v5-shaped UUID for the same (outboxId, step)', () => {
    const a = deterministicStepEventId('outbox-id', 'alert');
    const b = deterministicStepEventId('outbox-id', 'alert');
    expect(a).toBe(b);
    // RFC-4122 v5 marker: high nibble of byte 6 = 5
    expect(a[14]).toBe('5');
  });

  it('produces distinct IDs for different steps', () => {
    const tasks = deterministicStepEventId('outbox-id', 'tasks-0');
    const muster = deterministicStepEventId('outbox-id', 'muster');
    const alert = deterministicStepEventId('outbox-id', 'alert');
    expect(tasks).not.toBe(muster);
    expect(muster).not.toBe(alert);
    expect(tasks).not.toBe(alert);
  });

  it('produces distinct IDs for different outboxIds at the same step', () => {
    expect(deterministicStepEventId('aaa', 'alert')).not.toBe(
      deterministicStepEventId('bbb', 'alert'),
    );
  });
});
