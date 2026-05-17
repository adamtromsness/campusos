import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { assertStudentOwnsRecord } from './student-owned.guard';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';

/**
 * P2-H4 test coverage uplift — student-owned.guard.ts (82 LOC, critical-path Tier 2 ≥95%).
 *
 * P2-H1 Step 4 keystone for IMP-11 (Student-Owned data enforcement).
 * assertStudentOwnsRecord is the canonical helper applied at the service
 * layer wherever a row's owning student must match the caller:
 *   - School admin → pass (unless allowAdminOverride=false)
 *   - STUDENT actor → resolve own sis_students.id via platform_students.person_id
 *     and require it to equal studentId
 *   - Coach delegation (recruiting profiles) → opt-in via allowCoachDelegation;
 *     STAFF actors with employeeId pass through (Phase 2 H2 tightens with the
 *     real iam_delegations table)
 *   - Everyone else → ForbiddenException
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

const OWNED_STUDENT_ID = '019e0cf8-bbb8-7556-8c81-stu0000000001';
const OTHER_STUDENT_ID = '019e0cf8-bbb8-7556-8c81-stu0000000002';

interface ActorOverrides {
  personType?: 'STUDENT' | 'GUARDIAN' | 'STAFF';
  isSchoolAdmin?: boolean;
  personId?: string;
  employeeId?: string | null;
}

function makeActor(overrides: ActorOverrides = {}) {
  return {
    accountId: 'acct-1',
    personId: overrides.personId ?? 'person-1',
    personType: overrides.personType ?? 'STUDENT',
    isSchoolAdmin: overrides.isSchoolAdmin ?? false,
    employeeId: overrides.employeeId ?? null,
  } as never;
}

interface CapturedSql {
  sql: string;
  args: unknown[];
}

function makeTenantPrisma(rows: Array<{ id: string }>) {
  const captures: CapturedSql[] = [];
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (client: unknown) => Promise<T>) =>
      fn({
        $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
          captures.push({ sql, args });
          return rows;
        },
      }),
  };
  return { tenantPrisma, captures };
}

describe('assertStudentOwnsRecord — admin override', () => {
  it('passes silently when actor.isSchoolAdmin (default allowAdminOverride=true)', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', isSchoolAdmin: true });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).resolves.toBeUndefined();
    });
    // Admin short-circuit happens BEFORE any DB query.
    expect(captures).toHaveLength(0);
  });

  it('refuses admin when allowAdminOverride=false', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', isSchoolAdmin: true });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never, {
          allowAdminOverride: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

describe('assertStudentOwnsRecord — STUDENT actor', () => {
  it('resolves own sis_students.id and passes when it equals studentId', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([{ id: OWNED_STUDENT_ID }]);
    const actor = makeActor({ personType: 'STUDENT', personId: 'person-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).resolves.toBeUndefined();
    });
    expect(captures).toHaveLength(1);
    // Resolution SQL must join platform_students by person_id and filter by school_id.
    expect(captures[0].sql).toContain('FROM sis_students s');
    expect(captures[0].sql).toContain('JOIN platform.platform_students ps');
    expect(captures[0].sql).toContain('ps.person_id = $1::uuid');
    expect(captures[0].sql).toContain('s.school_id = $2::uuid');
    expect(captures[0].args).toEqual(['person-1', TENANT.schoolId]);
  });

  it('throws when the STUDENT actor is not bridged to a sis_students row in this school', async () => {
    const { tenantPrisma } = makeTenantPrisma([]); // empty result
    const actor = makeActor({ personType: 'STUDENT', personId: 'person-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow('Student actor is not bridged to a student record in this school.');
    });
  });

  it('throws when STUDENT actor tries to act on a different student', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ id: OTHER_STUDENT_ID }]);
    const actor = makeActor({ personType: 'STUDENT', personId: 'person-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never, {
          capability: 'their portfolio',
        }),
      ).rejects.toThrow(
        'Students may only mutate their portfolio for themselves. Use the admin path to author on behalf of another student.',
      );
    });
  });

  it('uses default capability label "this record" when none supplied', async () => {
    const { tenantPrisma } = makeTenantPrisma([{ id: OTHER_STUDENT_ID }]);
    const actor = makeActor({ personType: 'STUDENT', personId: 'person-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow('this record');
    });
  });

  it('refuses a STUDENT actor with no personId (cannot resolve)', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    // personId blank → falls through to the final ForbiddenException branch
    const actor = makeActor({ personType: 'STUDENT', personId: '' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow('Only the owning student or a school admin may mutate this record.');
    });
  });
});

describe('assertStudentOwnsRecord — coach delegation', () => {
  it('passes for STAFF actor with employeeId when allowCoachDelegation=true', async () => {
    const { tenantPrisma, captures } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', employeeId: 'emp-coach-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never, {
          allowCoachDelegation: true,
        }),
      ).resolves.toBeUndefined();
    });
    // No DB lookup; the stub admits STAFF with employeeId straight through.
    expect(captures).toHaveLength(0);
  });

  it('refuses STAFF actor when allowCoachDelegation is omitted (default false)', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', employeeId: 'emp-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow('Only the owning student or a school admin may mutate this record.');
    });
  });

  it('refuses STAFF actor without employeeId even when allowCoachDelegation=true', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', employeeId: null });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never, {
          allowCoachDelegation: true,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});

describe('assertStudentOwnsRecord — non-STUDENT non-admin actors', () => {
  it('refuses GUARDIAN actor regardless of personId', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'GUARDIAN', personId: 'guardian-1' });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow('Only the owning student or a school admin may mutate this record.');
    });
  });

  it('refuses STAFF actor (non-admin, no coach delegation)', async () => {
    const { tenantPrisma } = makeTenantPrisma([]);
    const actor = makeActor({ personType: 'STAFF', isSchoolAdmin: false });
    await runWithTenantContext({ tenant: TENANT }, async () => {
      await expect(
        assertStudentOwnsRecord(actor, OWNED_STUDENT_ID, tenantPrisma as never),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
