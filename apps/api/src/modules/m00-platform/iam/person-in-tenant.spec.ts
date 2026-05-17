import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { assertPersonInTenant, assertAccountInTenant } from './person-in-tenant';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';

/**
 * P2-H4 test coverage uplift — person-in-tenant.ts (79 LOC, critical-path
 * Tier 2 ≥95%). P2-H1 Step 6 shared helper, critical for cross-tenant leak
 * prevention.
 *
 * assertPersonInTenant validates that an admin-supplied iam_person.id has
 * at least one projection (sis_students / sis_guardians / hr_employees)
 * in the calling tenant's school. assertAccountInTenant is the platform_users.id
 * variant — resolves account → person_id first.
 *
 * Both are gates against admin-on-behalf paths leaking cross-school identities.
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

function makeTenantPrisma(
  opts: {
    unionRows?: Array<{ source: string }>;
    platformUsers?: Array<{ id: string; personId: string | null }>;
  } = {},
) {
  const captures: Array<{ sql: string; args: unknown[]; client: 'tenant' | 'platform' }> = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args, client: 'tenant' });
          return opts.unionRows ?? [];
        },
      }),
    getPlatformClient: () => ({
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        captures.push({ sql, args, client: 'platform' });
        const id = args[0] as string;
        const row = (opts.platformUsers ?? []).find((u) => u.id === id);
        return row ? [{ person_id: row.personId }] : [];
      },
    }),
  };
  return { tenantPrisma, captures };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: TENANT }, fn);
}

describe('assertPersonInTenant', () => {
  it('passes silently when at least one projection resolves', async () => {
    const { tenantPrisma } = makeTenantPrisma({ unionRows: [{ source: 'student' }] });
    await inTenant(async () => {
      await expect(
        assertPersonInTenant(tenantPrisma as never, 'person-1', 'assignedToPersonId'),
      ).resolves.toBeUndefined();
    });
  });

  it('throws BadRequestException with fieldName-tagged message when no projection exists', async () => {
    const { tenantPrisma } = makeTenantPrisma({ unionRows: [] });
    await inTenant(async () => {
      await expect(
        assertPersonInTenant(tenantPrisma as never, 'ghost', 'assignedToPersonId'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        assertPersonInTenant(tenantPrisma as never, 'ghost', 'assignedToPersonId'),
      ).rejects.toThrow('assignedToPersonId does not match a person in this school');
    });
  });

  it('uses the supplied fieldName verbatim in the error message', async () => {
    const { tenantPrisma } = makeTenantPrisma({ unionRows: [] });
    await inTenant(async () => {
      await expect(assertPersonInTenant(tenantPrisma as never, 'p', 'createdBy')).rejects.toThrow(
        'createdBy does not match a person in this school',
      );
      await expect(assertPersonInTenant(tenantPrisma as never, 'p', 'studentId')).rejects.toThrow(
        'studentId does not match a person in this school',
      );
    });
  });

  it('issues a single UNION ALL query covering sis_students, sis_guardians, and hr_employees', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma({ unionRows: [{ source: 'guardian' }] });
    await inTenant(() => assertPersonInTenant(tenantPrisma as never, 'person-1', 'fieldX'));
    expect(captures).toHaveLength(1);
    expect(captures[0].client).toBe('tenant');
    const sql = captures[0].sql;
    expect(sql).toContain("'student' AS source FROM sis_students");
    expect(sql).toContain("'guardian' AS source FROM sis_guardians");
    expect(sql).toContain("'employee' AS source FROM hr_employees");
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('platform.platform_students');
    expect(captures[0].args).toEqual(['person-1', TENANT.schoolId]);
  });

  it('passes when ANY of the three projections matches (employee branch)', async () => {
    const { tenantPrisma } = makeTenantPrisma({ unionRows: [{ source: 'employee' }] });
    await inTenant(async () => {
      await expect(
        assertPersonInTenant(tenantPrisma as never, 'staff-person-1', 'createdBy'),
      ).resolves.toBeUndefined();
    });
  });

  it('throws when called outside a tenant context (no schoolId available)', async () => {
    const { tenantPrisma } = makeTenantPrisma({ unionRows: [{ source: 'student' }] });
    await expect(assertPersonInTenant(tenantPrisma as never, 'person-1', 'fieldX')).rejects.toThrow(
      'No tenant context',
    );
  });
});

describe('assertAccountInTenant', () => {
  it('passes when the account resolves to a person who has a tenant projection', async () => {
    const { tenantPrisma } = makeTenantPrisma({
      platformUsers: [{ id: 'acct-1', personId: 'person-1' }],
      unionRows: [{ source: 'student' }],
    });
    await inTenant(async () => {
      await expect(
        assertAccountInTenant(tenantPrisma as never, 'acct-1', 'invitedAccountId'),
      ).resolves.toBeUndefined();
    });
  });

  it('throws BadRequestException when the account id does not exist in platform_users', async () => {
    const { tenantPrisma } = makeTenantPrisma({ platformUsers: [] });
    await inTenant(async () => {
      await expect(
        assertAccountInTenant(tenantPrisma as never, 'ghost-acct', 'invitedAccountId'),
      ).rejects.toThrow('invitedAccountId does not match a known account');
    });
  });

  it('throws BadRequestException when the account has no person_id (corrupt row)', async () => {
    const { tenantPrisma } = makeTenantPrisma({
      platformUsers: [{ id: 'acct-1', personId: null }],
    });
    await inTenant(async () => {
      await expect(
        assertAccountInTenant(tenantPrisma as never, 'acct-1', 'invitedAccountId'),
      ).rejects.toThrow('invitedAccountId does not match a known account');
    });
  });

  it('chains into assertPersonInTenant — throws when the account exists but the person has no tenant projection (cross-school account)', async () => {
    const { tenantPrisma } = makeTenantPrisma({
      platformUsers: [{ id: 'acct-1', personId: 'person-other-school' }],
      unionRows: [], // person has no projection in this tenant
    });
    await inTenant(async () => {
      await expect(
        assertAccountInTenant(tenantPrisma as never, 'acct-1', 'invitedAccountId'),
      ).rejects.toThrow('invitedAccountId does not match a person in this school');
    });
  });

  it('makes the platform lookup BEFORE the tenant projection check', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma({
      platformUsers: [{ id: 'acct-1', personId: 'person-1' }],
      unionRows: [{ source: 'student' }],
    });
    await inTenant(() => assertAccountInTenant(tenantPrisma as never, 'acct-1', 'fieldX'));
    expect(captures[0].client).toBe('platform'); // platform_users lookup first
    expect(captures[0].sql).toContain('FROM platform_users');
    expect(captures[1].client).toBe('tenant'); // then tenant projection check
  });
});
