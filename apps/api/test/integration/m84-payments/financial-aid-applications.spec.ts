import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FinancialAidService } from '@modules/m84-payments/financial-aid.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  teacherActor,
  studentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

/**
 * Wave 2 — DB-backed integration tests for the FinancialAidService
 * application surface (createApplication, getApplicationById,
 * listApplications, updateApplication, submitApplication,
 * withdrawApplication, listAwardsForStudent, getAwardById).
 *
 * The base financial-aid.spec.ts already covers programmes +
 * reviewApplication. This file fills the application-lifecycle gap.
 */
describe('integration:m84-payments/financial-aid-applications', () => {
  let tenantPrisma: TenantPrismaService;
  let service: FinancialAidService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    service = new FinancialAidService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdGuardianIds: string[] = [];

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'FAA-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'FAA-%'`,
    );
    // Sweep ALL guardians keyed to the TEST_PARENT_PERSON_ID. The
    // (school_id, person_id) UNIQUE makes the per-test seedGuardianForParent
    // fail unless leftover rows from a panicked test are removed first.
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

  async function seedStudent(schoolId = TEST_SCHOOL_ID): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'FAA-Stu', 'Test', 'STUDENT', true)`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'FAA-Stu', 'Test', true)`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      schoolId,
      platformStudentId,
      'FAA-' + studentId,
    );
    return studentId;
  }

  /**
   * Seed a guardian and link to student. Use TEST_PARENT_PERSON_ID as
   * the guardian's person_id so the parent actor's row-scope checks
   * resolve cleanly.
   */
  async function seedGuardianForParent(
    studentId: string,
    schoolId: string = TEST_SCHOOL_ID,
  ): Promise<string> {
    const guardianId = generateId();
    createdGuardianIds.push(guardianId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_guardians
         (id, person_id, school_id, relationship)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT')`,
      guardianId,
      TEST_PARENT_PERSON_ID,
      schoolId,
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

  async function seedProgram(opts?: {
    schoolId?: string;
    isActive?: boolean;
    totalFund?: number;
  }): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_financial_aid_programs
         (id, school_id, name, reduction_type, reduction_value, total_fund_amount, fund_remaining, is_active, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'FIXED_AMOUNT', 100, $4::numeric, $4::numeric, $5, $6::uuid)`,
      id,
      opts?.schoolId ?? TEST_SCHOOL_ID,
      'FAA-Prog-' + id.slice(-6),
      opts?.totalFund ? opts.totalFund.toFixed(2) : null,
      opts?.isActive ?? true,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ─── createApplication ──────────────────────────────────────

  describe('createApplication', () => {
    it('parent creates DRAFT application for own child', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          {
            studentId,
            programId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            householdIncomeBand: 'BAND_C',
            applicationStatement: 'Help requested',
          },
          parentActor(),
        ),
      );
      expect(r.status).toBe('DRAFT');
      expect(r.studentId).toBe(studentId);
      expect(r.householdIncomeBand).toBe('BAND_C');
    });

    it('parent creates SUBMITTED application when submit=true', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          {
            studentId,
            programId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            submit: true,
          },
          parentActor(),
        ),
      );
      expect(r.status).toBe('SUBMITTED');
      expect(r.submittedAt).not.toBeNull();
    });

    it('admin creates application for any student', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          {
            studentId,
            programId,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            supportingDocuments: [
              { documentName: 'tax_return.pdf', s3Key: 'docs/x' } as any,
            ],
          },
          adminActor(),
        ),
      );
      expect(r.id).toBeTruthy();
    });

    it('parent cannot create application for a child they are not linked to', async () => {
      const studentId = await seedStudent(); // No guardian link to parent
      const programId = await seedProgram();
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin: student with no guardian → BadRequest', async () => {
      const studentId = await seedStudent();
      const programId = await seedProgram();
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('actor without personId → BadRequest', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const noPerson = { ...adminActor(), personId: '' };
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
            noPerson,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inactive programme → BadRequest', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram({ isActive: false });
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent programme → BadRequest', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            {
              studentId,
              programId: generateId(),
              academicYearId: TEST_ACADEMIC_YEAR_ID,
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent student → BadRequest', async () => {
      const programId = await seedProgram();
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            {
              studentId: generateId(),
              programId,
              academicYearId: TEST_ACADEMIC_YEAR_ID,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-existent academic year → BadRequest', async () => {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      await expect(
        withTestTenant(async () =>
          service.createApplication(
            { studentId, programId, academicYearId: generateId() },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── getApplicationById ─────────────────────────────────────

  describe('getApplicationById', () => {
    async function setup(): Promise<{ id: string; studentId: string; programId: string }> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
          parentActor(),
        ),
      );
      return { id: r.id, studentId, programId };
    }

    it('admin can read any application', async () => {
      const { id } = await setup();
      const r = await withTestTenant(async () => service.getApplicationById(id, adminActor()));
      expect(r.id).toBe(id);
    });

    it('parent reads own child\'s application', async () => {
      const { id } = await setup();
      const r = await withTestTenant(async () => service.getApplicationById(id, parentActor()));
      expect(r.id).toBe(id);
    });

    it('teacher → NotFound (not admin or linked guardian)', async () => {
      const { id } = await setup();
      await expect(
        withTestTenant(async () => service.getApplicationById(id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('student → NotFound (not GUARDIAN persona)', async () => {
      const { id } = await setup();
      await expect(
        withTestTenant(async () => service.getApplicationById(id, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('missing id → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getApplicationById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A application invisible from School B', async () => {
      const { id } = await setup();
      await expect(
        withTestTenantB(async () => service.getApplicationById(id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── listApplications ───────────────────────────────────────

  describe('listApplications', () => {
    async function setup(): Promise<{ id: string; studentId: string }> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID, submit: true },
          parentActor(),
        ),
      );
      return { id: r.id, studentId };
    }

    it('admin lists every application in tenant', async () => {
      const { id } = await setup();
      const list = await withTestTenant(async () =>
        service.listApplications({}, adminActor()),
      );
      expect(list.find((x) => x.id === id)).toBeDefined();
    });

    it('parent lists own children\'s applications only', async () => {
      const { id, studentId } = await setup();
      void studentId;
      const list = await withTestTenant(async () =>
        service.listApplications({}, parentActor()),
      );
      expect(list.find((x) => x.id === id)).toBeDefined();
    });

    it('teacher → Forbidden', async () => {
      await expect(
        withTestTenant(async () => service.listApplications({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by status', async () => {
      const { id } = await setup();
      const submitted = await withTestTenant(async () =>
        service.listApplications({ status: 'SUBMITTED' }, adminActor()),
      );
      expect(submitted.every((a) => a.status === 'SUBMITTED')).toBe(true);
      expect(submitted.find((x) => x.id === id)).toBeDefined();

      const drafts = await withTestTenant(async () =>
        service.listApplications({ status: 'DRAFT' }, adminActor()),
      );
      expect(drafts.find((x) => x.id === id)).toBeUndefined();
    });

    it('list filters by academicYearId + studentId', async () => {
      const { id, studentId } = await setup();
      const filtered = await withTestTenant(async () =>
        service.listApplications(
          { academicYearId: TEST_ACADEMIC_YEAR_ID, studentId },
          adminActor(),
        ),
      );
      expect(filtered.find((x) => x.id === id)).toBeDefined();
    });
  });

  // ─── updateApplication ──────────────────────────────────────

  describe('updateApplication', () => {
    async function seedDraft(): Promise<string> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
          parentActor(),
        ),
      );
      return r.id;
    }

    it('parent updates own DRAFT application', async () => {
      const id = await seedDraft();
      const u = await withTestTenant(async () =>
        service.updateApplication(
          id,
          {
            householdIncomeBand: 'BAND_E',
            applicationStatement: 'updated',
            supportingDocuments: [],
          },
          parentActor(),
        ),
      );
      expect(u.householdIncomeBand).toBe('BAND_E');
      expect(u.applicationStatement).toBe('updated');
    });

    it('parent cannot update once SUBMITTED', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.submitApplication(id, parentActor()));
      await expect(
        withTestTenant(async () =>
          service.updateApplication(id, { applicationStatement: 'late edit' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin can update non-DRAFT', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.submitApplication(id, parentActor()));
      const u = await withTestTenant(async () =>
        service.updateApplication(
          id,
          { applicationStatement: 'admin override' },
          adminActor(),
        ),
      );
      expect(u.applicationStatement).toBe('admin override');
    });

    it('empty patch returns existing', async () => {
      const id = await seedDraft();
      const u = await withTestTenant(async () =>
        service.updateApplication(id, {}, parentActor()),
      );
      expect(u.id).toBe(id);
    });

    it('non-existent application → NotFound (via getById)', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateApplication(generateId(), {}, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── submitApplication ──────────────────────────────────────

  describe('submitApplication', () => {
    async function seedDraft(): Promise<string> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID },
          parentActor(),
        ),
      );
      return r.id;
    }

    it('DRAFT → SUBMITTED stamps submitted_at', async () => {
      const id = await seedDraft();
      const r = await withTestTenant(async () => service.submitApplication(id, parentActor()));
      expect(r.status).toBe('SUBMITTED');
      expect(r.submittedAt).not.toBeNull();
    });

    it('already-SUBMITTED → BadRequest', async () => {
      const id = await seedDraft();
      await withTestTenant(async () => service.submitApplication(id, parentActor()));
      await expect(
        withTestTenant(async () => service.submitApplication(id, parentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing id → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.submitApplication(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── withdrawApplication ────────────────────────────────────

  describe('withdrawApplication', () => {
    async function seedSubmitted(): Promise<string> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram();
      const r = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID, submit: true },
          parentActor(),
        ),
      );
      return r.id;
    }

    it('SUBMITTED → WITHDRAWN with reason', async () => {
      const id = await seedSubmitted();
      const r = await withTestTenant(async () =>
        service.withdrawApplication(id, { reason: 'Found other aid' }, parentActor()),
      );
      expect(r.status).toBe('WITHDRAWN');
    });

    it('withdraw without reason works', async () => {
      const id = await seedSubmitted();
      const r = await withTestTenant(async () =>
        service.withdrawApplication(id, {}, adminActor()),
      );
      expect(r.status).toBe('WITHDRAWN');
    });

    it('already-WITHDRAWN → BadRequest', async () => {
      const id = await seedSubmitted();
      await withTestTenant(async () => service.withdrawApplication(id, {}, parentActor()));
      await expect(
        withTestTenant(async () => service.withdrawApplication(id, {}, parentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── listAwardsForStudent + getAwardById ───────────────────

  describe('Awards', () => {
    async function seedAward(): Promise<{ awardId: string; studentId: string }> {
      const studentId = await seedStudent();
      await seedGuardianForParent(studentId);
      const programId = await seedProgram({ totalFund: 10000 });
      const appId = await withTestTenant(async () =>
        service.createApplication(
          { studentId, programId, academicYearId: TEST_ACADEMIC_YEAR_ID, submit: true },
          parentActor(),
        ),
      );
      // Approve via reviewApplication to create the award row.
      const approved = await withTestTenant(async () =>
        service.reviewApplication(
          appId.id,
          { action: 'APPROVE', awardAmount: 500, awardEffectiveFrom: '2026-01-01' },
          adminActor(),
        ),
      );
      return { awardId: approved.awardId!, studentId };
    }

    it('admin lists awards for a student', async () => {
      const { awardId, studentId } = await seedAward();
      const list = await withTestTenant(async () =>
        service.listAwardsForStudent(studentId, adminActor()),
      );
      expect(list.find((a) => a.id === awardId)).toBeDefined();
    });

    it('linked parent lists own child\'s awards', async () => {
      const { awardId, studentId } = await seedAward();
      const list = await withTestTenant(async () =>
        service.listAwardsForStudent(studentId, parentActor()),
      );
      expect(list.find((a) => a.id === awardId)).toBeDefined();
    });

    it('unlinked parent → Forbidden', async () => {
      const studentId = await seedStudent(); // No guardian link
      await expect(
        withTestTenant(async () =>
          service.listAwardsForStudent(studentId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher → Forbidden', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          service.listAwardsForStudent(studentId, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getAwardById returns the award', async () => {
      const { awardId } = await seedAward();
      const r = await withTestTenant(async () => service.getAwardById(awardId));
      expect(r.id).toBe(awardId);
    });

    it('getAwardById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getAwardById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A award invisible from School B', async () => {
      const { awardId } = await seedAward();
      await expect(
        withTestTenantB(async () => service.getAwardById(awardId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
