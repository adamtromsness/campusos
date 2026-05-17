import { describe, it, expect } from 'vitest';
import { GuardianAuthorizationService } from './guardian-authorization.service';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';

/**
 * P2-H4 test coverage uplift — guardian-authorization.service.ts (213 LOC,
 * critical-path Tier 2 ≥95%). KEYSTONE for Phase 2 IMP-01 (Custody-Aware
 * Parent Access).
 *
 * Six capability gates resolve against the sis_student_guardians link row:
 *   - canViewAcademicRecord     portal_access + (FULL | ACADEMIC_ONLY)
 *   - canViewHealthRecord       portal_access + FULL + (receives_reports | is_emergency | has_custody)
 *   - canAuthorizePayment       has_custody=true (custodial only)
 *   - canReceiveTransportInfo   portal_access + (receives_reports | has_custody | is_emergency)
 *   - canViewCommunications     portal_access + (FULL | COMMUNICATIONS_ONLY)
 *   - canAttendConference       portal_access + scope <> 'ACADEMIC_ONLY'
 *
 * Resolution: loadLink JOINs sis_student_guardians → sis_guardians → sis_students
 * filtered to the current tenant's schoolId (both g.school_id AND s.school_id).
 * Missing link → false. Foreign-school guardian → false (school predicate).
 */

const TENANT: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface LinkRow {
  guardian_id: string;
  family_id: string | null;
  has_custody: boolean;
  is_emergency_contact: boolean;
  receives_reports: boolean;
  portal_access: boolean;
  portal_access_scope: string;
}

interface CustodyRow {
  guardian_a_id: string;
  guardian_b_id: string;
  custody_arrangement: string | null;
  court_order_restrictions: Record<string, unknown> | null;
}

/**
 * P2-H5 DEFECT 4 + P2-H6 FIX 1 — fake tenant prisma that returns different
 * rows by query shape. Link query (FROM sis_student_guardians) → linkRows.
 * Custody query (FROM sis_family_relationships) → custodyRows. Account
 * binding (FROM pay_family_accounts) → accountRows. getPlatformClient
 * returns an auditLog stub that records each access decision.
 *
 * P2-H6 FIX 1: when `custodyRows` is omitted, the default is a JOINT
 * relationship row that matches the first linkRow's guardian_id. This
 * preserves the happy-path semantics of the existing tests (which all
 * exercise the demo-seed shape where every guardian has full JOINT custody)
 * while the new contract — empty `custodyRows` is fail-closed — is verified
 * by passing an explicit `[]`. Tests that need to exercise the fail-closed
 * contract pass an empty array directly.
 */
function makeTenantPrisma(
  linkRows: LinkRow[],
  custodyRows?: CustodyRow[],
  accountRows: Array<{ ok: number }> = [],
) {
  const captures: Array<{ sql: string; args: unknown[] }> = [];
  const auditCaptures: Array<{ data: Record<string, unknown> }> = [];
  const effectiveCustody: CustodyRow[] =
    custodyRows !== undefined
      ? custodyRows
      : linkRows.length > 0
        ? [
            {
              guardian_a_id: linkRows[0]!.guardian_id,
              guardian_b_id: 'guardian-other-id',
              custody_arrangement: 'JOINT',
              court_order_restrictions: null,
            },
          ]
        : [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args });
          if (sql.includes('FROM sis_student_guardians')) return linkRows;
          if (sql.includes('FROM sis_family_relationships')) return effectiveCustody;
          if (sql.includes('FROM pay_family_accounts')) return accountRows;
          return [];
        },
      }),
    getPlatformClient: () => ({
      auditLog: {
        create: async (args: { data: Record<string, unknown> }) => {
          auditCaptures.push(args);
        },
      },
    }),
  };
  return { tenantPrisma, captures, auditCaptures };
}

const FULL_CUSTODIAL_LINK: LinkRow = {
  guardian_id: 'guardian-1-id',
  family_id: 'family-1-id',
  has_custody: true,
  is_emergency_contact: true,
  receives_reports: true,
  portal_access: true,
  portal_access_scope: 'FULL',
};

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: TENANT }, fn);
}

describe('GuardianAuthorizationService.loadLink (via canViewAcademicRecord)', () => {
  it('SQL joins through sis_guardians + sis_students and filters by current tenant schoolId', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    await inTenant(() => svc.canViewAcademicRecord('guardian-person-1', 'student-1'));
    // P2-H5 DEFECT 4 — service now runs 2 queries on the link path: link
    // resolution + family-relationship custody context. The first capture is
    // the link query (the one this test asserts on).
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const linkCapture = captures[0]!;
    expect(linkCapture.sql).toContain('FROM sis_student_guardians sg');
    expect(linkCapture.sql).toContain('JOIN sis_guardians g');
    expect(linkCapture.sql).toContain('JOIN sis_students s');
    expect(linkCapture.sql).toContain('g.person_id = $1::uuid');
    expect(linkCapture.sql).toContain('sg.student_id = $2::uuid');
    expect(linkCapture.sql).toContain('s.school_id = $3::uuid');
    expect(linkCapture.sql).toContain('g.school_id = $3::uuid');
    expect(linkCapture.args).toEqual(['guardian-person-1', 'student-1', TENANT.schoolId]);
  });

  it('returns false when there is no link row (cross-school or unlinked guardian)', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    const result = await inTenant(() => svc.canViewAcademicRecord('guardian-1', 'student-1'));
    expect(result).toBe(false);
  });
});

describe('canViewAcademicRecord — academic record gate', () => {
  it('grants when portal_access=true and scope=FULL', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(true);
  });

  it('grants when portal_access=true and scope=ACADEMIC_ONLY', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'ACADEMIC_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(true);
  });

  it('refuses when portal_access=false', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...FULL_CUSTODIAL_LINK, portal_access: false }]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(false);
  });

  it('refuses when scope=COMMUNICATIONS_ONLY (not academic-eligible)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'COMMUNICATIONS_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(false);
  });
});

describe('canViewHealthRecord — FERPA-sensitive PHI gate', () => {
  it('grants for custodial guardian with FULL scope', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(true);
  });

  it('grants for non-custodial emergency contact with FULL scope (school-day medical events)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: true,
        receives_reports: false,
        portal_access: true,
        portal_access_scope: 'FULL',
      },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(true);
  });

  it('grants for receives_reports guardian with FULL scope', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: false,
        receives_reports: true,
        portal_access: true,
        portal_access_scope: 'FULL',
      },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(true);
  });

  it('refuses when scope is not FULL (health is PHI; ACADEMIC_ONLY/COMMUNICATIONS_ONLY are insufficient)', async () => {
    for (const scope of ['ACADEMIC_ONLY', 'COMMUNICATIONS_ONLY']) {
      const { tenantPrisma } = makeTenantPrisma([
        { ...FULL_CUSTODIAL_LINK, portal_access_scope: scope },
      ]);
      const svc = new GuardianAuthorizationService(tenantPrisma as never);
      expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
    }
  });

  it('refuses when FULL scope but none of (custody | emergency | receives_reports) is true', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: false,
        receives_reports: false,
        portal_access: true,
        portal_access_scope: 'FULL',
      },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
  });

  it('refuses when no link exists', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
  });

  it('refuses when portal_access=false (even if all other flags are true)', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...FULL_CUSTODIAL_LINK, portal_access: false }]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
  });
});

describe('canAuthorizePayment — custodial-only gate', () => {
  it('grants when has_custody=true', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's'))).toBe(true);
  });

  it('refuses non-custodial guardian even with portal access + emergency + receives_reports', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: true,
        receives_reports: true,
        portal_access: true,
        portal_access_scope: 'FULL',
      },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's'))).toBe(false);
  });

  it('accepts the optional familyAccountId argument when it binds to (guardian, student)', async () => {
    // P2-H5 DEFECT 4 — familyAccountId is now validated. accountRows
    // = [{ ok: 1 }] simulates the pay_family_accounts row resolving in
    // the binding query. P2-H6 FIX 1 — custody arrangement is now
    // load-bearing for the upstream predicate, so we supply a JOINT row
    // explicitly to keep the test focused on the binding behaviour.
    const { tenantPrisma } = makeTenantPrisma(
      [FULL_CUSTODIAL_LINK],
      [
        {
          guardian_a_id: FULL_CUSTODIAL_LINK.guardian_id,
          guardian_b_id: 'guardian-other-id',
          custody_arrangement: 'JOINT',
          court_order_restrictions: null,
        },
      ],
      [{ ok: 1 }],
    );
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's', 'family-1'))).toBe(true);
  });

  it('rejects a familyAccountId that does NOT bind to (guardian, student) — P2-H5 DEFECT 4', async () => {
    // P2-H6 FIX 1 — supply JOINT custody so the upstream gate passes and the
    // binding check is the only thing the test exercises.
    const { tenantPrisma } = makeTenantPrisma(
      [FULL_CUSTODIAL_LINK],
      [
        {
          guardian_a_id: FULL_CUSTODIAL_LINK.guardian_id,
          guardian_b_id: 'guardian-other-id',
          custody_arrangement: 'JOINT',
          court_order_restrictions: null,
        },
      ],
      [],
    );
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's', 'unrelated-family'))).toBe(false);
  });

  it('refuses when no link exists', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's'))).toBe(false);
  });
});

describe('canReceiveTransportInfo — bus pass + ETA + geofence gate', () => {
  it('grants when receives_reports OR has_custody OR is_emergency_contact', async () => {
    for (const flag of ['receives_reports', 'has_custody', 'is_emergency_contact'] as const) {
      const link: LinkRow = {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: false,
        receives_reports: false,
        portal_access: true,
        portal_access_scope: 'COMMUNICATIONS_ONLY',
        [flag]: true,
      };
      const { tenantPrisma } = makeTenantPrisma([link]);
      const svc = new GuardianAuthorizationService(tenantPrisma as never);
      expect(await inTenant(() => svc.canReceiveTransportInfo('g', 's'))).toBe(true);
    }
  });

  it('refuses when none of the three relevant flags is true', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      {
        guardian_id: 'guardian-x',
        family_id: 'family-x',
        has_custody: false,
        is_emergency_contact: false,
        receives_reports: false,
        portal_access: true,
        portal_access_scope: 'FULL',
      },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canReceiveTransportInfo('g', 's'))).toBe(false);
  });

  it('refuses when portal_access=false (suspended guardian)', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...FULL_CUSTODIAL_LINK, portal_access: false }]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canReceiveTransportInfo('g', 's'))).toBe(false);
  });
});

describe('canViewCommunications — announcements/messages/notifications gate', () => {
  it('grants for FULL scope', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewCommunications('g', 's'))).toBe(true);
  });

  it('grants for COMMUNICATIONS_ONLY scope (the dedicated communications band)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'COMMUNICATIONS_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewCommunications('g', 's'))).toBe(true);
  });

  it('refuses for ACADEMIC_ONLY scope (academic-band guardian gets transcripts, not messages)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'ACADEMIC_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewCommunications('g', 's'))).toBe(false);
  });
});

describe('canAttendConference — parent-teacher meeting booking gate', () => {
  it('grants for FULL scope', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('g', 's'))).toBe(true);
  });

  it('grants for COMMUNICATIONS_ONLY (conferences are an academic-adjacent communication event)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'COMMUNICATIONS_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('g', 's'))).toBe(true);
  });

  it('refuses for ACADEMIC_ONLY scope (academic transcripts only — no in-person meeting binding)', async () => {
    const { tenantPrisma } = makeTenantPrisma([
      { ...FULL_CUSTODIAL_LINK, portal_access_scope: 'ACADEMIC_ONLY' },
    ]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('g', 's'))).toBe(false);
  });

  it('refuses when portal_access=false', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ ...FULL_CUSTODIAL_LINK, portal_access: false }]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('g', 's'))).toBe(false);
  });
});

describe('resolveLink — capability-snapshot helper', () => {
  it('returns the link snapshot as camelCase DTO', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    const snapshot = await inTenant(() => svc.resolveLink('g', 's'));
    expect(snapshot).toEqual({
      hasCustody: true,
      isEmergencyContact: true,
      receivesReports: true,
      portalAccess: true,
      portalAccessScope: 'FULL',
    });
  });

  it('returns null when no link exists', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.resolveLink('g', 's'))).toBeNull();
  });
});

describe('P2-H6 FIX 1 — loadCustodyContext fail-closed contract', () => {
  it('refuses access when sis_family_relationships returns zero rows (unknown custody is not permissive)', async () => {
    // Demo seed link with FULL custody flags, but NO custody row recorded
    // in sis_family_relationships. Pre-fix this returned permissive; the
    // P2-H6 contract is fail-closed.
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK], []);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canReceiveTransportInfo('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canViewCommunications('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canAttendConference('g', 's'))).toBe(false);
  });

  it('refuses access when custody_arrangement IS NULL on the relationship row (unknown arrangement)', async () => {
    const { tenantPrisma } = makeTenantPrisma(
      [FULL_CUSTODIAL_LINK],
      [
        {
          guardian_a_id: FULL_CUSTODIAL_LINK.guardian_id,
          guardian_b_id: 'guardian-other-id',
          custody_arrangement: null, // ← unknown, not JOINT
          court_order_restrictions: null,
        },
      ],
    );
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canViewHealthRecord('g', 's'))).toBe(false);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's'))).toBe(false);
  });

  it('grants access when custody_arrangement = JOINT (explicit allow)', async () => {
    const { tenantPrisma } = makeTenantPrisma(
      [FULL_CUSTODIAL_LINK],
      [
        {
          guardian_a_id: FULL_CUSTODIAL_LINK.guardian_id,
          guardian_b_id: 'guardian-other-id',
          custody_arrangement: 'JOINT',
          court_order_restrictions: null,
        },
      ],
    );
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(true);
  });

  it('refuses access when familyId on the link row is null (cannot resolve custody chain)', async () => {
    const { tenantPrisma } = makeTenantPrisma(
      [{ ...FULL_CUSTODIAL_LINK, family_id: null }],
      undefined,
    );
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('g', 's'))).toBe(false);
  });
});

describe('logAccessDecision', () => {
  it('persists each decision to platform_audit_log with data_subject_id = studentId (ADR-052)', async () => {
    const { tenantPrisma, auditCaptures } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    await inTenant(() => svc.logAccessDecision('canViewHealthRecord', 'g-1', 's-1', true));
    expect(auditCaptures).toHaveLength(1);
    const data = auditCaptures[0]!.data as Record<string, unknown>;
    expect(data.action).toBe('guardian_access_decision');
    expect(data.actorId).toBe('g-1');
    expect(data.dataSubjectId).toBe('s-1');
    expect(data.entityType).toBe('sis_students');
    expect(data.entityId).toBe('s-1');
    expect(data.tenantId).toBe(TENANT.schoolId);
    expect((data.metadata as Record<string, unknown>).capability).toBe('canViewHealthRecord');
    expect((data.metadata as Record<string, unknown>).granted).toBe(true);
  });

  it('captures both granted and denied decisions', async () => {
    const { tenantPrisma, auditCaptures } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    await inTenant(() => svc.logAccessDecision('canAuthorizePayment', 'g-1', 's-1', false));
    expect(auditCaptures).toHaveLength(1);
    const data = auditCaptures[0]!.data as Record<string, unknown>;
    expect((data.metadata as Record<string, unknown>).granted).toBe(false);
  });
});
