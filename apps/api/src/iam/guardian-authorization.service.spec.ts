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
  has_custody: boolean;
  is_emergency_contact: boolean;
  receives_reports: boolean;
  portal_access: boolean;
  portal_access_scope: string;
}

function makeTenantPrisma(rowsToReturn: LinkRow[] | null) {
  const captures: Array<{ sql: string; args: unknown[] }> = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args });
          return rowsToReturn ?? [];
        },
      }),
  };
  return { tenantPrisma, captures };
}

const FULL_CUSTODIAL_LINK: LinkRow = {
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
    expect(captures).toHaveLength(1);
    expect(captures[0].sql).toContain('FROM sis_student_guardians sg');
    expect(captures[0].sql).toContain('JOIN sis_guardians g');
    expect(captures[0].sql).toContain('JOIN sis_students s');
    expect(captures[0].sql).toContain('g.person_id = $1::uuid');
    expect(captures[0].sql).toContain('sg.student_id = $2::uuid');
    expect(captures[0].sql).toContain('s.school_id = $3::uuid');
    expect(captures[0].sql).toContain('g.school_id = $3::uuid');
    expect(captures[0].args).toEqual(['guardian-person-1', 'student-1', TENANT.schoolId]);
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

  it('accepts the optional familyAccountId argument (reserved for future binding)', async () => {
    const { tenantPrisma } = makeTenantPrisma([FULL_CUSTODIAL_LINK]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('g', 's', 'family-1'))).toBe(true);
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

describe('logAccessDecision', () => {
  it('does not throw (best-effort audit log)', () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new GuardianAuthorizationService(tenantPrisma as never);
    expect(() => svc.logAccessDecision('canViewHealthRecord', 'g-1', 's-1', true)).not.toThrow();
    expect(() => svc.logAccessDecision('canAuthorizePayment', 'g-1', 's-1', false)).not.toThrow();
  });
});
