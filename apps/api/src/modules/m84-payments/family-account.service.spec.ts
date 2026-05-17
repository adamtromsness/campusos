import { describe, it, expect } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { FamilyAccountService } from './family-account.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/family-account.service.ts
 * (190 LOC, Tier 1 Financial; the parent + admin family-billing
 * account read surface + the internal assertCanWriteAccount helper
 * used by InvoiceService.generateFromSchedule and PaymentService.pay).
 *
 * Tests cover:
 *   - list: admin sees all (no WHERE filter); guardian filters by
 *     account_holder_id; non-admin non-guardian short-circuits []
 *   - list returns [] when no rows
 *   - list inlines balance from LedgerService.getBalance per row
 *   - getById admin sees any row; guardian only own (else 404);
 *     non-admin non-guardian 404; row not found 404
 *   - listStudents row scope via getById + filters by family_account_id
 *   - assertCanWriteAccount admin bypass; not-found 404; wrong owner
 *     403; correct owner returns void
 *   - loadStudentsFor placeholder generation + multi-account batching
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

interface CapturedCall {
  sql: string;
  args: unknown[];
}

interface FakeOpts {
  rowsForAccountList?: unknown[];
  rowsForGetById?: unknown[];
  rowsForStudents?: unknown[];
  rowsForOwnerCheck?: unknown[];
  balance?: number;
}

function makeFake(opts: FakeOpts = {}) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      capture.push({ sql, args });
      const s = sql.toLowerCase();
      if (s.includes('from pay_family_accounts a') && s.includes('where 1=1')) {
        return opts.rowsForAccountList ?? [];
      }
      if (s.includes('from pay_family_accounts a') && s.includes('where a.id =')) {
        return opts.rowsForGetById ?? [];
      }
      if (s.includes('select account_holder_id from pay_family_accounts')) {
        return opts.rowsForOwnerCheck ?? [];
      }
      if (s.includes('from pay_family_account_students')) {
        return opts.rowsForStudents ?? [];
      }
      return [];
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  };
  const ledger = {
    getBalance: async (accountId: string) => ({
      familyAccountId: accountId,
      balance: opts.balance ?? 0,
      cached: false,
    }),
  };
  return { tenantPrisma, ledger, capture };
}

async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, fn);
}

const adminActor: ResolvedActor = {
  accountId: 'acc-admin',
  personId: 'pers-admin',
  personType: 'STAFF',
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
};

const guardianActor: ResolvedActor = {
  accountId: 'acc-david',
  personId: 'pers-david',
  personType: 'GUARDIAN',
  isSchoolAdmin: false,
  employeeId: null,
};

const studentActor: ResolvedActor = {
  accountId: 'acc-maya',
  personId: 'pers-maya',
  personType: 'STUDENT',
  isSchoolAdmin: false,
  employeeId: null,
};

const teacherActor: ResolvedActor = {
  accountId: 'acc-rivera',
  personId: 'pers-rivera',
  personType: 'STAFF',
  isSchoolAdmin: false,
  employeeId: 'emp-rivera',
};

const sampleAccount = {
  id: 'fa-1',
  school_id: SCHOOL.schoolId,
  school_name: 'Lincoln Elementary',
  shared_billing_group_id: null,
  account_holder_id: 'pers-david',
  account_holder_first_name: 'David',
  account_holder_last_name: 'Chen',
  account_holder_email: 'parent@demo.campusos.dev',
  account_number: 'FA-1001',
  status: 'ACTIVE',
  payment_authorisation_policy: 'ACCOUNT_HOLDER_ONLY',
  created_at: '2025-08-15T00:00:00Z',
  updated_at: '2026-04-28T00:00:00Z',
};

const sampleStudentLink = {
  family_account_id: 'fa-1',
  student_id: 'stu-maya',
  student_number: 'S-1001',
  first_name: 'Maya',
  last_name: 'Chen',
  grade_level: '9',
  added_at: '2025-08-15T00:00:00Z',
};

describe('FamilyAccountService.list', () => {
  it('admin sees all with no WHERE filter on holder_id', async () => {
    const { tenantPrisma, ledger, capture } = makeFake({
      rowsForAccountList: [sampleAccount],
      rowsForStudents: [sampleStudentLink],
      balance: 400,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let rows: Array<{ id: string; balance: number; students: Array<{ studentId: string }> }> = [];
    await inTenant(async () => {
      rows = await svc.list(adminActor);
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.balance).toBe(400);
    expect(rows[0]!.students).toHaveLength(1);
    expect(rows[0]!.students[0]!.studentId).toBe('stu-maya');
    // No account_holder_id filter for admins
    const listQuery = capture[0]!;
    expect(listQuery.sql.toLowerCase()).not.toContain('a.account_holder_id = $');
  });

  it('guardian filters by account_holder_id', async () => {
    const { tenantPrisma, ledger, capture } = makeFake({
      rowsForAccountList: [sampleAccount],
      rowsForStudents: [sampleStudentLink],
      balance: 400,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await svc.list(guardianActor);
    });
    const listQuery = capture[0]!;
    expect(listQuery.sql.toLowerCase()).toContain('a.account_holder_id = $1::uuid');
    expect(listQuery.args[0]).toBe('pers-david');
  });

  it('student short-circuits to empty list (no DB query)', async () => {
    const { tenantPrisma, ledger, capture } = makeFake();
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let rows: unknown[] = [];
    await inTenant(async () => {
      rows = await svc.list(studentActor);
    });
    expect(rows).toEqual([]);
    expect(capture.length).toBe(0);
  });

  it('teacher (STAFF, not admin) short-circuits to empty list', async () => {
    const { tenantPrisma, ledger, capture } = makeFake();
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let rows: unknown[] = [];
    await inTenant(async () => {
      rows = await svc.list(teacherActor);
    });
    expect(rows).toEqual([]);
    expect(capture.length).toBe(0);
  });

  it('returns [] when no accounts match', async () => {
    const { tenantPrisma, ledger } = makeFake({ rowsForAccountList: [] });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let rows: unknown[] = [];
    await inTenant(async () => {
      rows = await svc.list(adminActor);
    });
    expect(rows).toEqual([]);
  });

  it('filters students per-account inside accountRowToDto (cross-account link drops)', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForAccountList: [
        sampleAccount,
        { ...sampleAccount, id: 'fa-2', account_number: 'FA-1002' },
      ],
      rowsForStudents: [
        sampleStudentLink,
        {
          ...sampleStudentLink,
          family_account_id: 'fa-2',
          student_id: 'stu-ethan',
          first_name: 'Ethan',
        },
      ],
      balance: 0,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let rows: Array<{ id: string; students: Array<{ studentId: string }> }> = [];
    await inTenant(async () => {
      rows = await svc.list(adminActor);
    });
    const fa1 = rows.find((r) => r.id === 'fa-1');
    const fa2 = rows.find((r) => r.id === 'fa-2');
    expect(fa1?.students).toHaveLength(1);
    expect(fa1?.students[0]!.studentId).toBe('stu-maya');
    expect(fa2?.students).toHaveLength(1);
    expect(fa2?.students[0]!.studentId).toBe('stu-ethan');
  });
});

describe('FamilyAccountService.getById', () => {
  it('admin sees any account', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForStudents: [sampleStudentLink],
      balance: 400,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let dto: { accountHolderName: string; balance: number } | undefined;
    await inTenant(async () => {
      dto = await svc.getById('fa-1', adminActor);
    });
    expect(dto?.accountHolderName).toBe('David Chen');
    expect(dto?.balance).toBe(400);
  });

  it('404 when account not found', async () => {
    const { tenantPrisma, ledger } = makeFake({ rowsForGetById: [] });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('fa-missing', adminActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('guardian sees own account', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForStudents: [sampleStudentLink],
      balance: 400,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let dto: { id: string } | undefined;
    await inTenant(async () => {
      dto = await svc.getById('fa-1', guardianActor);
    });
    expect(dto?.id).toBe('fa-1');
  });

  it("guardian gets 404 on other family's account", async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [{ ...sampleAccount, account_holder_id: 'pers-other' }],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('fa-other', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });

  it("teacher gets 404 (don't-leak-existence)", async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [sampleAccount],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('fa-1', teacherActor)).rejects.toThrow(NotFoundException);
    });
  });

  it('student gets 404 (no STUDENT access to family billing)', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [sampleAccount],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.getById('fa-1', studentActor)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('FamilyAccountService.listStudents', () => {
  it('admin happy path returns linked students', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [sampleAccount],
      rowsForStudents: [sampleStudentLink],
      balance: 0,
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    let students: Array<{ studentId: string; studentNumber: string }> = [];
    await inTenant(async () => {
      students = await svc.listStudents('fa-1', adminActor);
    });
    expect(students).toHaveLength(1);
    expect(students[0]!.studentNumber).toBe('S-1001');
  });

  it('guardian 404 propagates from getById row-scope', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForGetById: [{ ...sampleAccount, account_holder_id: 'pers-other' }],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.listStudents('fa-other', guardianActor)).rejects.toThrow(NotFoundException);
    });
  });
});

describe('FamilyAccountService.assertCanWriteAccount', () => {
  it('admin bypass (no DB read)', async () => {
    const { tenantPrisma, ledger, capture } = makeFake();
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await svc.assertCanWriteAccount('fa-1', adminActor);
    });
    expect(capture.length).toBe(0);
  });

  it('404 when account not found', async () => {
    const { tenantPrisma, ledger } = makeFake({ rowsForOwnerCheck: [] });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.assertCanWriteAccount('fa-missing', guardianActor)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('Forbidden when guardian is not the account holder', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForOwnerCheck: [{ account_holder_id: 'pers-other' }],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.assertCanWriteAccount('fa-other', guardianActor)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  it('account holder happy path returns void', async () => {
    const { tenantPrisma, ledger } = makeFake({
      rowsForOwnerCheck: [{ account_holder_id: 'pers-david' }],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await expect(svc.assertCanWriteAccount('fa-1', guardianActor)).resolves.toBeUndefined();
    });
  });
});

describe('FamilyAccountService loadStudentsFor — placeholder generation', () => {
  it('generates one placeholder per account id', async () => {
    const { tenantPrisma, ledger, capture } = makeFake({
      rowsForAccountList: [
        sampleAccount,
        { ...sampleAccount, id: 'fa-2' },
        { ...sampleAccount, id: 'fa-3' },
      ],
      rowsForStudents: [],
    });
    const svc = new FamilyAccountService(tenantPrisma as never, ledger as never);
    await inTenant(async () => {
      await svc.list(adminActor);
    });
    const studentsQuery = capture.find((c) =>
      c.sql.toLowerCase().includes('from pay_family_account_students'),
    );
    expect(studentsQuery).toBeTruthy();
    expect(studentsQuery!.sql).toContain('$1::uuid,$2::uuid,$3::uuid');
    expect(studentsQuery!.args).toEqual(['fa-1', 'fa-2', 'fa-3']);
  });
});
