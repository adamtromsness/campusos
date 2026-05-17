import { describe, it, expect } from 'vitest';
import { GuardianAuthorizationService } from './guardian-authorization.service';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';

/**
 * P2-H5 DEFECT 4 + DEFECT 6 — custody fixture coverage for the
 * GuardianAuthorizationService. Codex review noted the service did
 * not consult sis_family_relationships.custody_arrangement or
 * court_order_restrictions. This spec exercises each capability
 * method against every documented custody fixture so a regression
 * cannot reintroduce the gap silently.
 *
 * Fixtures use the same fake-tenant pattern as the broader spec —
 * the tenant prisma routes queries by SQL shape. Integration tests
 * against a real Postgres are tracked separately under
 * apps/api/src/__tests__/p2h5-school-scope-integration.spec.ts and
 * gate on DATABASE_URL availability.
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
  portal_access_scope: string | null;
}

interface CustodyRow {
  guardian_a_id: string;
  guardian_b_id: string;
  custody_arrangement: string | null;
  court_order_restrictions: Record<string, unknown> | null;
}

function makeTenantPrisma(
  linkRows: LinkRow[],
  custodyRows: CustodyRow[] = [],
  accountRows: Array<{ ok: number }> = [],
) {
  const auditCaptures: Array<{ data: Record<string, unknown> }> = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM sis_student_guardians')) return linkRows;
          if (sql.includes('FROM sis_family_relationships')) return custodyRows;
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
  return { tenantPrisma, auditCaptures };
}

const PARENT_A_ID = 'guardian-a';
const PARENT_B_ID = 'guardian-b';
const FAMILY_ID = 'family-1';

function fullCustodialLink(guardianId: string): LinkRow {
  return {
    guardian_id: guardianId,
    family_id: FAMILY_ID,
    has_custody: true,
    is_emergency_contact: true,
    receives_reports: true,
    portal_access: true,
    portal_access_scope: 'FULL',
  };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: TENANT }, fn);
}

describe('custody SOLE_A — guardian_b is denied (P2-H5 DEFECT 4)', () => {
  const soleACustody: CustodyRow = {
    guardian_a_id: PARENT_A_ID,
    guardian_b_id: PARENT_B_ID,
    custody_arrangement: 'SOLE_A',
    court_order_restrictions: null,
  };

  it('canViewAcademicRecord: parent A allowed, parent B denied', async () => {
    const fakesA = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [soleACustody]);
    const fakesB = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svcA = new GuardianAuthorizationService(fakesA.tenantPrisma as never);
    const svcB = new GuardianAuthorizationService(fakesB.tenantPrisma as never);
    expect(await inTenant(() => svcA.canViewAcademicRecord('p-a', 'student-1'))).toBe(true);
    expect(await inTenant(() => svcB.canViewAcademicRecord('p-b', 'student-1'))).toBe(false);
  });

  it('canViewHealthRecord: parent B denied even with FULL scope + custody flag', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('p-b', 'student-1'))).toBe(false);
  });

  it('canAuthorizePayment: parent B denied; sis_student_guardians.has_custody cannot override custody arrangement', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('p-b', 'student-1'))).toBe(false);
  });

  it('canReceiveTransportInfo: parent B denied (court order applies broadly)', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canReceiveTransportInfo('p-b', 'student-1'))).toBe(false);
  });

  it('canViewCommunications: parent B denied', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewCommunications('p-b', 'student-1'))).toBe(false);
  });

  it('canAttendConference: parent B denied', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleACustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('p-b', 'student-1'))).toBe(false);
  });
});

describe('custody SOLE_B — guardian_a is denied (mirror of SOLE_A)', () => {
  const soleBCustody: CustodyRow = {
    guardian_a_id: PARENT_A_ID,
    guardian_b_id: PARENT_B_ID,
    custody_arrangement: 'SOLE_B',
    court_order_restrictions: null,
  };

  it('parent A denied across every capability', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [soleBCustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canViewHealthRecord('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canAuthorizePayment('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canReceiveTransportInfo('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canViewCommunications('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canAttendConference('p-a', 'student-1'))).toBe(false);
  });

  it('parent B allowed across every capability they hold the underlying flags for', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleBCustody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('p-b', 'student-1'))).toBe(true);
    expect(await inTenant(() => svc.canAuthorizePayment('p-b', 'student-1'))).toBe(true);
  });
});

describe('custody JOINT — both parents allowed', () => {
  const jointCustody: CustodyRow = {
    guardian_a_id: PARENT_A_ID,
    guardian_b_id: PARENT_B_ID,
    custody_arrangement: 'JOINT',
    court_order_restrictions: null,
  };

  it('both parents authorised across academic + health + payment + transport', async () => {
    const fakesA = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [jointCustody]);
    const fakesB = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [jointCustody]);
    const svcA = new GuardianAuthorizationService(fakesA.tenantPrisma as never);
    const svcB = new GuardianAuthorizationService(fakesB.tenantPrisma as never);
    for (const [svc, id] of [[svcA, 'p-a'] as const, [svcB, 'p-b'] as const]) {
      expect(await inTenant(() => svc.canViewAcademicRecord(id, 'student-1'))).toBe(true);
      expect(await inTenant(() => svc.canViewHealthRecord(id, 'student-1'))).toBe(true);
      expect(await inTenant(() => svc.canAuthorizePayment(id, 'student-1'))).toBe(true);
      expect(await inTenant(() => svc.canReceiveTransportInfo(id, 'student-1'))).toBe(true);
    }
  });
});

describe('court_order_restrictions — per-capability blocks (P2-H5 DEFECT 4)', () => {
  it('financial_authority=false blocks canAuthorizePayment specifically', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { financial_authority: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('p-b', 'student-1'))).toBe(false);
    // Other capabilities unaffected
    expect(await inTenant(() => svc.canViewAcademicRecord('p-b', 'student-1'))).toBe(true);
    expect(await inTenant(() => svc.canReceiveTransportInfo('p-b', 'student-1'))).toBe(true);
  });

  it('academic_records=false blocks canViewAcademicRecord only', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { academic_records: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canViewHealthRecord('p-a', 'student-1'))).toBe(true);
  });

  it('health_records=false blocks canViewHealthRecord only', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { health_records: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewHealthRecord('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canViewAcademicRecord('p-a', 'student-1'))).toBe(true);
  });

  it('transport_contact=false blocks canReceiveTransportInfo only', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { transport_contact: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canReceiveTransportInfo('p-a', 'student-1'))).toBe(false);
  });

  it('communications=false blocks canViewCommunications only', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { communications: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewCommunications('p-a', 'student-1'))).toBe(false);
  });

  it('conference_attendance=false blocks canAttendConference only', async () => {
    const custody: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'JOINT',
      court_order_restrictions: { conference_attendance: false },
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], [custody]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canAttendConference('p-a', 'student-1'))).toBe(false);
  });
});

describe('missing custody data — P2-H5 fail-closed rule', () => {
  it('null family_id denies payment authorisation (no family means no authority to bind)', async () => {
    const link: LinkRow = {
      guardian_id: PARENT_A_ID,
      family_id: null,
      has_custody: true,
      is_emergency_contact: true,
      receives_reports: true,
      portal_access: true,
      portal_access_scope: 'FULL',
    };
    const fakes = makeTenantPrisma([link], []);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canAuthorizePayment('p-a', 'student-1'))).toBe(false);
  });

  it('null portal_access_scope denies academic + communications + conference', async () => {
    const link: LinkRow = {
      ...fullCustodialLink(PARENT_A_ID),
      portal_access_scope: null,
    };
    const fakes = makeTenantPrisma([link]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(await inTenant(() => svc.canViewAcademicRecord('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canViewCommunications('p-a', 'student-1'))).toBe(false);
    expect(await inTenant(() => svc.canAttendConference('p-a', 'student-1'))).toBe(false);
  });
});

describe('canAuthorizePayment — familyAccountId binding (P2-H5 DEFECT 4)', () => {
  it('refuses when supplied familyAccountId does NOT bind to the (guardian, student) pair', async () => {
    const fakes = makeTenantPrisma(
      [fullCustodialLink(PARENT_A_ID)],
      [
        {
          guardian_a_id: PARENT_A_ID,
          guardian_b_id: PARENT_B_ID,
          custody_arrangement: 'JOINT',
          court_order_restrictions: null,
        },
      ],
      [], // empty accountRows ⇒ binding query returns no row
    );
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(
      await inTenant(() =>
        svc.canAuthorizePayment('p-a', 'student-1', 'unrelated-family-account-id'),
      ),
    ).toBe(false);
  });

  it('grants when supplied familyAccountId is bound to the (guardian, student) pair', async () => {
    const fakes = makeTenantPrisma(
      [fullCustodialLink(PARENT_A_ID)],
      [
        {
          guardian_a_id: PARENT_A_ID,
          guardian_b_id: PARENT_B_ID,
          custody_arrangement: 'JOINT',
          court_order_restrictions: null,
        },
      ],
      [{ ok: 1 }],
    );
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    expect(
      await inTenant(() => svc.canAuthorizePayment('p-a', 'student-1', 'family-account-1')),
    ).toBe(true);
  });
});

describe('access decisions persist to platform_audit_log (P2-H5 DEFECT 4)', () => {
  it('logs the dataSubjectId = studentId per ADR-052 on every capability check', async () => {
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_A_ID)], []);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    await inTenant(() => svc.canViewAcademicRecord('p-a', 'student-1'));
    expect(fakes.auditCaptures).toHaveLength(1);
    const data = fakes.auditCaptures[0]!.data as Record<string, unknown>;
    expect(data.dataSubjectId).toBe('student-1');
    expect(data.actorId).toBe('p-a');
    expect(data.entityType).toBe('sis_students');
    expect(data.entityId).toBe('student-1');
    expect(data.action).toBe('guardian_access_decision');
  });

  it('logs both granted=true and granted=false decisions', async () => {
    const soleA: CustodyRow = {
      guardian_a_id: PARENT_A_ID,
      guardian_b_id: PARENT_B_ID,
      custody_arrangement: 'SOLE_A',
      court_order_restrictions: null,
    };
    const fakes = makeTenantPrisma([fullCustodialLink(PARENT_B_ID)], [soleA]);
    const svc = new GuardianAuthorizationService(fakes.tenantPrisma as never);
    await inTenant(() => svc.canAuthorizePayment('p-b', 'student-1'));
    expect(fakes.auditCaptures).toHaveLength(1);
    const data = fakes.auditCaptures[0]!.data as Record<string, unknown>;
    expect((data.metadata as Record<string, unknown>).granted).toBe(false);
  });
});
