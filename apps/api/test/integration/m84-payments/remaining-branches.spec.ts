import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FinancialAidService } from '@modules/m84-payments/financial-aid.service';
import { FamilyAccountService } from '@modules/m84-payments/family-account.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { RedisService } from '@shared/cache';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

/**
 * Final small-branch coverage to push m84-payments above the 95% target.
 *
 *   - LedgerService.getBalance cache-hit path (Redis returns a value)
 *   - FinancialAidService.reviewApplication UNDER_REVIEW path +
 *     SUBMITTED→UNDER_REVIEW + double-award (UNIQUE on
 *     student+program+year) BadRequest
 *   - FinancialAidService applicationRowToDto: supportingDocuments
 *     parsed when JSONB returns a string
 *   - FamilyAccountService.listStudents returns the student-array slice
 *     for an account with linked students
 */
describe('integration:m84-payments/remaining-branches', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let financialAid: FinancialAidService;
  let familyAccounts: FamilyAccountService;
  let ledger: LedgerService;
  let cachedBalance: string | null = null;

  function stubRedis(): RedisService {
    return {
      invalidateLedgerBalance: async () => undefined,
      getLedgerBalance: async () => cachedBalance,
      setLedgerBalance: async (_id: string, v: string) => {
        cachedBalance = v;
      },
    } as unknown as RedisService;
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    financialAid = new FinancialAidService(tenantPrisma);
    ledger = new LedgerService(tenantPrisma, stubRedis());
    familyAccounts = new FamilyAccountService(tenantPrisma, ledger);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdGuardianIds: string[] = [];

  beforeEach(async () => {
    cachedBalance = null;
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RB-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RB-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid`,
      TEST_PARENT_PERSON_ID,
    );
    if (createdGuardianIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
        createdGuardianIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
  });

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'RB-Stu', $2, 'STUDENT', true)`,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'RB-Stu', $3, true)`,
      platformStudentId,
      personId,
      'S-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'RB-' + suffix,
    );
    return studentId;
  }

  async function seedGuardian(studentId: string): Promise<string> {
    const guardianId = generateId();
    createdGuardianIds.push(guardianId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_guardians
         (id, person_id, school_id, relationship)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT')`,
      guardianId,
      TEST_PARENT_PERSON_ID,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
         (id, student_id, guardian_id, has_custody)
       VALUES ($1::uuid, $2::uuid, $3::uuid, true)`,
      generateId(),
      studentId,
      guardianId,
    );
    return guardianId;
  }

  async function seedProgram(opts?: { totalFund?: number }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_financial_aid_programs
         (id, school_id, name, reduction_type, reduction_value, total_fund_amount, fund_remaining, is_active, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'FIXED_AMOUNT', 100, $4::numeric, $4::numeric, true, $5::uuid)`,
      id,
      TEST_SCHOOL_ID,
      'RB-Prog-' + id.slice(-6),
      opts?.totalFund ? opts.totalFund.toFixed(2) : null,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ─── LedgerService cache-hit path ────────────────────────────

  describe('LedgerService.getBalance cache-hit', () => {
    it('returns cached value when Redis has it', async () => {
      cachedBalance = '125.50';
      const r = await withTestTenant(async () => ledger.getBalance(generateId()));
      expect(r.cached).toBe(true);
      expect(r.balance).toBe(125.5);
    });
  });

  // ─── FinancialAid review branches ────────────────────────────

  describe('FinancialAidService.reviewApplication branches', () => {
    async function seedSubmitted(): Promise<{
      appId: string;
      programId: string;
      studentId: string;
    }> {
      const studentId = await seedStudent();
      await seedGuardian(studentId);
      const programId = await seedProgram({ totalFund: 5000 });
      const r = await withTestTenant(async () =>
        financialAid.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID, submit: true },
          parentActor(),
        ),
      );
      return { appId: r.id, programId, studentId };
    }

    it('UNDER_REVIEW: SUBMITTED → UNDER_REVIEW', async () => {
      const { appId } = await seedSubmitted();
      const r = await withTestTenant(async () =>
        financialAid.reviewApplication(
          appId,
          { action: 'UNDER_REVIEW', reviewerNotes: 'pending docs' },
          adminActor(),
        ),
      );
      expect(r.status).toBe('UNDER_REVIEW');
    });

    it('UNDER_REVIEW: UNDER_REVIEW → UNDER_REVIEW (no-op)', async () => {
      const { appId } = await seedSubmitted();
      await withTestTenant(async () =>
        financialAid.reviewApplication(appId, { action: 'UNDER_REVIEW' }, adminActor()),
      );
      const r = await withTestTenant(async () =>
        financialAid.reviewApplication(appId, { action: 'UNDER_REVIEW' }, adminActor()),
      );
      expect(r.status).toBe('UNDER_REVIEW');
    });

    it('UNDER_REVIEW: DRAFT → BadRequest', async () => {
      const studentId = await seedStudent();
      await seedGuardian(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        financialAid.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
          parentActor(),
        ),
      );
      // r.status is DRAFT — reviewApplication should bounce on the
      // terminal-status guard.
      await expect(
        withTestTenant(async () =>
          financialAid.reviewApplication(r.id, { action: 'UNDER_REVIEW' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REJECT: SUBMITTED → REJECTED with reviewer notes', async () => {
      const { appId } = await seedSubmitted();
      const r = await withTestTenant(async () =>
        financialAid.reviewApplication(
          appId,
          { action: 'REJECT', reviewerNotes: 'Income too high' },
          adminActor(),
        ),
      );
      expect(r.status).toBe('REJECTED');
    });

    it('APPROVE duplicate (student + program + year) → BadRequest from UNIQUE', async () => {
      const { studentId, programId } = await seedSubmitted();
      // Approve the first application
      const firstAppId = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.pay_financial_aid_applications
           WHERE student_id = $1::uuid LIMIT 1`,
        studentId,
      )) as Array<{ id: string }>;
      await withTestTenant(async () =>
        financialAid.reviewApplication(
          firstAppId[0]!.id,
          { action: 'APPROVE', awardAmount: 500, awardEffectiveFrom: '2026-01-01' },
          adminActor(),
        ),
      );

      // Create + submit a SECOND application targeting the same student
      // + program + year, then attempt to approve again.
      const secondAppId = generateId();
      const guardianRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid LIMIT 1`,
        TEST_PARENT_PERSON_ID,
      )) as Array<{ id: string }>;
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_financial_aid_applications
           (id, school_id, student_id, program_id, guardian_id, academic_year_id, status, submitted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'SUBMITTED', now())`,
        secondAppId,
        TEST_SCHOOL_ID,
        studentId,
        programId,
        guardianRows[0]!.id,
        TEST_ACADEMIC_YEAR_ID,
      );
      await expect(
        withTestTenant(async () =>
          financialAid.reviewApplication(
            secondAppId,
            { action: 'APPROVE', awardAmount: 100, awardEffectiveFrom: '2026-01-01' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── applicationRowToDto: stringified JSONB path ─────────────

  describe('applicationRowToDto supportingDocuments parsing', () => {
    it('reads JSONB array of documents back through getApplicationById', async () => {
      const studentId = await seedStudent();
      await seedGuardian(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        financialAid.createApplication(
          {
            studentId,
            programId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            supportingDocuments: [{ s3Key: 'docs/x.pdf', label: 'tax_return.pdf' } as any],
          },
          parentActor(),
        ),
      );
      const fetched = await withTestTenant(async () =>
        financialAid.getApplicationById(r.id, adminActor()),
      );
      expect(fetched.supportingDocuments.length).toBe(1);
    });
  });

  // ─── FamilyAccount listStudents with actual link ────────────

  describe('FamilyAccountService.listStudents echoes linked students', () => {
    it('returns the linked student summary', async () => {
      const studentId = await seedStudent();
      // Seed family + link.
      const faId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
           (id, school_id, account_holder_id, account_number, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
        faId,
        TEST_SCHOOL_ID,
        TEST_PARENT_PERSON_ID,
        'RB-FA-' + faId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pay_family_account_students
           (id, family_account_id, student_id, added_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, NULL)`,
        generateId(),
        faId,
        studentId,
      );
      const list = await withTestTenant(async () =>
        familyAccounts.listStudents(faId, adminActor()),
      );
      expect(list.length).toBe(1);
      expect(list[0]!.studentId).toBe(studentId);
    });
  });
});
