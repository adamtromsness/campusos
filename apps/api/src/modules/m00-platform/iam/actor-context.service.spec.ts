import { describe, it, expect } from 'vitest';
import { ActorContextService } from './actor-context.service';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';

/**
 * P2-H4 test coverage uplift — actor-context.service.ts (92 LOC,
 * critical-path Tier 2 ≥95%).
 *
 * ActorContextService.resolveActor is called by virtually every service
 * layer in the codebase to obtain the row-scope identity for a request.
 * It composes:
 *   - personType from iam_person (platform schema)
 *   - isSchoolAdmin from PermissionCheckService.hasAnyPermissionInTenant(['sch-001:admin'])
 *   - employeeId from hr_employees in the current tenant (ACTIVE | ON_LEAVE only)
 *
 * REVIEW-CYCLE4 MAJOR 1: ON_LEAVE employees keep access; TERMINATED + SUSPENDED
 * are excluded. The Platform Admin persona has no hr_employees row by design,
 * so employeeId resolves to null for that account.
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

function makePrisma(person: { personType: string } | null) {
  return {
    iamPerson: {
      findUnique: async (_args: { where: { id: string } }) => person,
    },
  };
}

function makePermCheck(hasSchoolAdmin: boolean) {
  return {
    hasAnyPermissionInTenant: async (
      _accountId: string,
      _schoolId: string,
      codes: string[],
    ): Promise<boolean> => {
      // The service calls this exclusively with ['sch-001:admin']. Assert that
      // and return the configured flag.
      if (codes.length === 1 && codes[0] === 'sch-001:admin') {
        return hasSchoolAdmin;
      }
      return false;
    },
  };
}

function makeTenantPrisma(employeeRows: Array<{ id: string }>) {
  const captures: Array<{ sql: string; args: unknown[] }> = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args });
          return employeeRows;
        },
      }),
  };
  return { tenantPrisma, captures };
}

describe('ActorContextService.resolveActor', () => {
  it('returns the full ResolvedActor for a STAFF persona with an ACTIVE hr_employees row', async () => {
    const prisma = makePrisma({ personType: 'STAFF' });
    const perm = makePermCheck(false);
    const { tenantPrisma, captures } = makeTenantPrisma([{ id: 'emp-1' }]);
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    const actor = await runWithTenantContext({ tenant: TENANT }, () =>
      svc.resolveActor('acct-1', 'person-1'),
    );
    expect(actor).toEqual({
      accountId: 'acct-1',
      personId: 'person-1',
      personType: 'STAFF',
      isSchoolAdmin: false,
      employeeId: 'emp-1',
    });
    // The hr_employees lookup must filter to ACTIVE or ON_LEAVE only.
    expect(captures[0].sql).toContain('FROM hr_employees');
    expect(captures[0].sql).toContain("'ACTIVE'");
    expect(captures[0].sql).toContain("'ON_LEAVE'");
    expect(captures[0].args).toEqual(['person-1']);
  });

  it('returns isSchoolAdmin=true when sch-001:admin resolves in the tenant scope chain', async () => {
    const prisma = makePrisma({ personType: 'STAFF' });
    const perm = makePermCheck(true);
    const { tenantPrisma } = makeTenantPrisma([{ id: 'emp-1' }]);
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    const actor = await runWithTenantContext({ tenant: TENANT }, () =>
      svc.resolveActor('acct-1', 'person-1'),
    );
    expect(actor.isSchoolAdmin).toBe(true);
  });

  it('returns employeeId=null when the person has no ACTIVE/ON_LEAVE hr_employees row', async () => {
    const prisma = makePrisma({ personType: 'STAFF' });
    const perm = makePermCheck(false);
    const { tenantPrisma } = makeTenantPrisma([]); // Empty result → e.g. TERMINATED or no row
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    const actor = await runWithTenantContext({ tenant: TENANT }, () =>
      svc.resolveActor('acct-1', 'person-1'),
    );
    expect(actor.employeeId).toBeNull();
  });

  it('returns employeeId=null for non-STAFF personas (parents, students)', async () => {
    for (const personType of ['GUARDIAN', 'STUDENT']) {
      const prisma = makePrisma({ personType });
      const perm = makePermCheck(false);
      // Parents + students naturally have no hr_employees row
      const { tenantPrisma } = makeTenantPrisma([]);
      const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
      const actor = await runWithTenantContext({ tenant: TENANT }, () =>
        svc.resolveActor('acct-1', 'person-1'),
      );
      expect(actor.employeeId, `${personType} should resolve to employeeId=null`).toBeNull();
      expect(actor.personType).toBe(personType);
    }
  });

  it('returns personType=null when the iam_person row is missing (deactivated user)', async () => {
    const prisma = makePrisma(null);
    const perm = makePermCheck(false);
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    const actor = await runWithTenantContext({ tenant: TENANT }, () =>
      svc.resolveActor('acct-1', 'person-1'),
    );
    expect(actor.personType).toBeNull();
  });

  it("passes the current tenant's schoolId to PermissionCheckService.hasAnyPermissionInTenant", async () => {
    const prisma = makePrisma({ personType: 'STAFF' });
    const captured: Array<{ accountId: string; schoolId: string; codes: string[] }> = [];
    const perm = {
      hasAnyPermissionInTenant: async (accountId: string, schoolId: string, codes: string[]) => {
        captured.push({ accountId, schoolId, codes });
        return false;
      },
    };
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    await runWithTenantContext({ tenant: TENANT }, () => svc.resolveActor('acct-X', 'person-X'));
    expect(captured).toHaveLength(1);
    expect(captured[0].accountId).toBe('acct-X');
    expect(captured[0].schoolId).toBe(TENANT.schoolId);
    expect(captured[0].codes).toEqual(['sch-001:admin']);
  });

  it('throws when called outside a tenant context (defence-in-depth)', async () => {
    const prisma = makePrisma({ personType: 'STAFF' });
    const perm = makePermCheck(false);
    const { tenantPrisma } = makeTenantPrisma([]);
    const svc = new ActorContextService(prisma as never, perm as never, tenantPrisma as never);
    await expect(svc.resolveActor('acct-1', 'person-1')).rejects.toThrow('No tenant context');
  });
});
