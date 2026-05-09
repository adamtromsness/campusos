import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { TimelineService } from './timeline.service';
import { AccountabilityService } from './accountability.service';
import { ReunificationService } from './reunification.service';
import { DrillService } from './drill.service';
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

const ACTOR = {
  accountId: '99999999-9999-9999-9999-999999999999',
  personId: '88888888-8888-8888-8888-888888888888',
  personType: 'STAFF',
  isSchoolAdmin: false,
} as never;

const ADMIN_ACTOR = { ...(ACTOR as never), isSchoolAdmin: true } as never;

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
            declared_by: ADMIN_ACTOR.accountId,
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
