import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { VisitorService, VisitorTypeService } from './visitor.service';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';

/**
 * REVIEW-P2C1 ROUND 2 BLOCKING — cross-school isolation regression test.
 *
 * Round 2 review found that VisitorService.loadInternal(id) used
 *
 *   WHERE v.id = $1::uuid
 *
 * with no school_id predicate. A School A reception user with
 * saf-002:write could attach a School B visitor record to a School A
 * sign-in / pre-reg / recurring row by guessing the UUID. The Round 3
 * fix scopes loadInternal to the calling tenant's schoolId via
 * getCurrentTenant() and adds AND v.school_id = s.school_id JOIN
 * defence-in-depth to the sign-in / pre-reg / recurring SELECT_BASE
 * templates.
 *
 * This test captures the SQL the service emits and verifies:
 *   1. loadInternal() WHERE clause includes BOTH school_id AND id.
 *   2. A cross-school lookup (visitor in school A, tenant bound to
 *      school B) returns the NotFoundException don't-leak shape.
 *   3. A same-school lookup returns the row.
 *
 * Uses a stubbed TenantPrismaService to capture the executed SQL so
 * the assertion is deterministic and does not require a live DB.
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

const VISITOR_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  school_id: SCHOOL_A.schoolId,
  visitor_type_id: 'tt-tt-tt-tt-tt',
  visitor_type_name: 'Parent',
  badge_color: 'blue',
  requires_safeguarding_check: false,
  first_name: 'David',
  last_name: 'Chen',
  company: null,
  email_encrypted: null,
  phone_encrypted: null,
  notes: null,
  created_at: '2026-05-09T00:00:00Z',
  updated_at: '2026-05-09T00:00:00Z',
};

describe('VisitorService cross-school isolation (REVIEW-P2C1 R2 BLOCKING)', () => {
  let svc: VisitorService;
  // Captured SQL + args from the most recent $queryRawUnsafe call.
  const capture: { sql: string; args: unknown[] }[] = [];
  // The fake table — keyed on (school_id, id).
  const visitors = new Map<string, typeof VISITOR_ROW>();

  beforeEach(() => {
    capture.length = 0;
    visitors.clear();
    visitors.set(SCHOOL_A.schoolId + ':' + VISITOR_ROW.id, VISITOR_ROW);

    const fakeClient = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args });
        // Honour the WHERE shape: matches only when school_id + id both present.
        const lower = sql.toLowerCase();
        const hasSchool = lower.includes('school_id');
        const hasId = lower.includes('v.id = $') || lower.includes('and v.id =');
        if (hasSchool && hasId) {
          const [schoolId, id] = args as [string, string];
          const row = visitors.get(schoolId + ':' + id);
          return row ? [row] : [];
        }
        // Unscoped lookup — historical buggy path.
        if (!hasSchool && hasId) {
          const id = args[0] as string;
          for (const v of visitors.values()) {
            if (v.id === id) return [v];
          }
          return [];
        }
        return [];
      },
    };
    const fakeTenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
    };
    const fakePermCheck = { hasAnyPermissionInTenant: async () => true };
    const fakeVisitorTypes = {
      loadOrFail: async () => ({ id: 'tt', requires_safeguarding_check: false }),
    } as unknown as VisitorTypeService;

    svc = new VisitorService(fakeTenantPrisma as never, fakePermCheck as never, fakeVisitorTypes);
  });

  it('loadInternal SQL includes BOTH school_id AND id predicates', async () => {
    await runWithTenantContext({ tenant: SCHOOL_A }, async () => {
      await svc.loadInternal(VISITOR_ROW.id);
    });
    expect(capture).toHaveLength(1);
    const { sql, args } = capture[0]!;
    // The SQL MUST include the school_id predicate (REVIEW-P2C1 R2 BLOCKING fix).
    expect(sql.toLowerCase()).toContain('school_id = $1');
    expect(sql.toLowerCase()).toContain('v.id = $2');
    // Args should be (schoolId, id) in that order.
    expect(args).toEqual([SCHOOL_A.schoolId, VISITOR_ROW.id]);
  });

  it('returns the visitor when called from the same school context', async () => {
    const row = await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.loadInternal(VISITOR_ROW.id),
    );
    expect(row.first_name).toBe('David');
    expect(row.school_id).toBe(SCHOOL_A.schoolId);
  });

  it("throws NotFoundException for a cross-school visitor UUID (don't-leak-existence)", async () => {
    // Visitor exists in School A — a kiosk user authenticated against
    // School B should NOT be able to resolve it. The collapsed 404
    // means the caller cannot tell "doesn't exist" from "exists in
    // another school".
    await expect(
      runWithTenantContext({ tenant: SCHOOL_B }, async () => svc.loadInternal(VISITOR_ROW.id)),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException for a UUID that does not exist anywhere', async () => {
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.loadInternal('99999999-9999-9999-9999-999999999999'),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * REVIEW-P2C1 ROUND 3 BLOCKING — cross-school visitor-type isolation
 * regression test.
 *
 * Round 3 review found that VisitorTypeService.loadOrFail(id) used
 *
 *   FROM vis_visitor_types WHERE id = $1::uuid
 *
 * with no school_id predicate. A School A reception user could attach
 * a School B visitorTypeId to a new visitor by passing the foreign
 * UUID through VisitorService.create / sign-in / pre-reg. The Round 4
 * fix scopes loadOrFail by current school + adds AND vt.school_id =
 * v.school_id JOIN defence-in-depth to every visitor-type JOIN.
 */
describe('VisitorTypeService cross-school isolation (REVIEW-P2C1 R3 BLOCKING)', () => {
  let svc: VisitorTypeService;
  const capture: { sql: string; args: unknown[] }[] = [];
  // Fake table — keyed on (school_id, id).
  const types = new Map<
    string,
    {
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      requires_safeguarding_check: boolean;
      badge_color: string;
      is_active: boolean;
      created_at: string;
      updated_at: string;
    }
  >();

  const TYPE_ROW = {
    id: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
    school_id: SCHOOL_A.schoolId,
    name: 'Parent',
    description: null,
    requires_safeguarding_check: false,
    badge_color: 'blue',
    is_active: true,
    created_at: '2026-05-09T00:00:00Z',
    updated_at: '2026-05-09T00:00:00Z',
  };

  beforeEach(() => {
    capture.length = 0;
    types.clear();
    types.set(SCHOOL_A.schoolId + ':' + TYPE_ROW.id, TYPE_ROW);

    const fakeClient = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        capture.push({ sql, args });
        const lower = sql.toLowerCase();
        const hasSchool = lower.includes('school_id = $1');
        const hasId = lower.includes('id = $2');
        if (hasSchool && hasId) {
          const [schoolId, id] = args as [string, string];
          const row = types.get(schoolId + ':' + id);
          return row ? [row] : [];
        }
        // Unscoped (historical buggy path) — id-only match.
        if (!hasSchool && lower.includes('id = $1')) {
          const id = args[0] as string;
          for (const t of types.values()) {
            if (t.id === id) return [t];
          }
        }
        return [];
      },
    };
    const fakeTenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(fakeClient),
    };
    const fakePermCheck = { hasAnyPermissionInTenant: async () => true };
    svc = new VisitorTypeService(fakeTenantPrisma as never, fakePermCheck as never);
  });

  it('loadOrFail SQL includes BOTH school_id AND id predicates', async () => {
    await runWithTenantContext({ tenant: SCHOOL_A }, async () => {
      await svc.loadOrFail(TYPE_ROW.id);
    });
    expect(capture).toHaveLength(1);
    const { sql, args } = capture[0]!;
    expect(sql.toLowerCase()).toContain('school_id = $1');
    expect(sql.toLowerCase()).toContain('id = $2');
    expect(args).toEqual([SCHOOL_A.schoolId, TYPE_ROW.id]);
  });

  it('returns the visitor type when called from the same school context', async () => {
    const row = await runWithTenantContext({ tenant: SCHOOL_A }, async () =>
      svc.loadOrFail(TYPE_ROW.id),
    );
    expect(row.name).toBe('Parent');
    expect(row.school_id).toBe(SCHOOL_A.schoolId);
  });

  it('throws NotFoundException for a cross-school visitor-type UUID', async () => {
    // The visitor type exists in school A. A kiosk user authenticated
    // against school B must not be able to attach this type to a new
    // school B visitor by replaying the UUID. Collapsed 404 means the
    // caller cannot tell "doesn't exist" from "exists in another school".
    await expect(
      runWithTenantContext({ tenant: SCHOOL_B }, async () => svc.loadOrFail(TYPE_ROW.id)),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException for a UUID that does not exist anywhere', async () => {
    await expect(
      runWithTenantContext({ tenant: SCHOOL_A }, async () =>
        svc.loadOrFail('99999999-9999-9999-9999-999999999999'),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
