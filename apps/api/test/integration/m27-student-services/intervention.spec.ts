import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { InterventionService } from '@modules/m27-student-services/counselling/intervention.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

describe('integration:m27-student-services/intervention', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: InterventionService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new InterventionService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_intervention_progress WHERE intervention_id IN
         (SELECT id FROM ${TEST_SCHEMA}.svc_interventions)`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.svc_interventions`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'INT-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'INT-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'INT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name LIKE 'INT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name LIKE 'INT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
  });

  async function grantOfficer(codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'INT-Stu', $2, 'STUDENT', true)`,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'INT-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8', 'ENROLLED')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'INT-' + suffix,
    );
    return studentId;
  }

  async function seedTier(studentId: string): Promise<string> {
    const id = generateId();
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_mtss_tiers
         (id, school_id, student_id, academic_year_id, tier, domain, assigned_by,
          assigned_at, review_date, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TIER_2', 'ACADEMIC',
               $5::uuid, $6::date, $7::date, 'ACTIVE')`,
      id,
      TEST_SCHOOL_ID,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
      TEST_ADMIN_EMPLOYEE_ID,
      today,
      future,
    );
    return id;
  }

  async function seedCaseload(studentId: string, counselorId: string): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
         (id, school_id, counselor_id, student_id, academic_year_id, primary_concern,
          is_primary_counselor, status, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACADEMIC',
               true, 'ACTIVE', now()::date)`,
      id,
      TEST_SCHOOL_ID,
      counselorId,
      studentId,
      TEST_ACADEMIC_YEAR_ID,
    );
    return id;
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      interventionName: 'Daily Reading Practice',
      interventionType: 'ACADEMIC_SUPPORT' as const,
      description: '15 minutes of structured reading daily',
      frequency: 'DAILY',
      startDate: new Date().toISOString().slice(0, 10),
      ...overrides,
    };
  }

  describe('create', () => {
    it('admin creates an intervention; admin bypasses caseload check', async () => {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      const r = await withTestTenant(async () => service.create(tierId, baseInput(), adminActor()));
      expect(r.status).toBe('ACTIVE');
      expect(r.interventionName).toBe('Daily Reading Practice');
    });

    it('counsellor with cou-001:write AND owning the caseload can create', async () => {
      await grantOfficer(['cou-001:write']);
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      await seedCaseload(studentId, TEST_OFFICER_EMPLOYEE_ID);
      const r = await withTestTenant(async () =>
        service.create(tierId, baseInput(), officerActor()),
      );
      expect(r.id).toBeTruthy();
    });

    it('counsellor WITHOUT owning the caseload → Forbidden (assertActorOwnsTier)', async () => {
      await grantOfficer(['cou-001:write']);
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      // No caseload row for officer
      await expect(
        withTestTenant(async () => service.create(tierId, baseInput(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-counsellor scope (no cou-001:write) → Forbidden', async () => {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      await expect(
        withTestTenant(async () => service.create(tierId, baseInput(), officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(tierId, baseInput(), teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(tierId, baseInput(), studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.create(tierId, baseInput(), parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate before startDate → BadRequest', async () => {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      await expect(
        withTestTenant(async () =>
          service.create(
            tierId,
            baseInput({ startDate: '2026-06-01', endDate: '2026-01-01' }),
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('missing tier → BadRequest', async () => {
      await expect(
        withTestTenant(async () => service.create(generateId(), baseInput(), adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listForTier + getById', () => {
    async function seedIntervention(): Promise<{
      tierId: string;
      interventionId: string;
    }> {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      const created = await withTestTenant(async () =>
        service.create(tierId, baseInput(), adminActor()),
      );
      return { tierId, interventionId: created.id };
    }

    it('admin lists interventions for a tier', async () => {
      const { tierId, interventionId } = await seedIntervention();
      const list = await withTestTenant(async () => service.listForTier(tierId, adminActor()));
      expect(list.find((i) => i.id === interventionId)).toBeDefined();
    });

    it('admin getById returns intervention', async () => {
      const { interventionId } = await seedIntervention();
      const got = await withTestTenant(async () => service.getById(interventionId, adminActor()));
      expect(got.id).toBe(interventionId);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForTier as non-counsellor → Forbidden', async () => {
      const { tierId } = await seedIntervention();
      await expect(
        withTestTenant(async () => service.listForTier(tierId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('patch', () => {
    async function seedIntervention(): Promise<string> {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      const r = await withTestTenant(async () => service.create(tierId, baseInput(), adminActor()));
      return r.id;
    }

    it('admin patches frequency + description', async () => {
      const id = await seedIntervention();
      const updated = await withTestTenant(async () =>
        service.patch(id, { frequency: 'WEEKLY', description: 'Updated' }, adminActor()),
      );
      expect(updated.frequency).toBe('WEEKLY');
      expect(updated.description).toBe('Updated');
    });

    it('patch status', async () => {
      const id = await seedIntervention();
      const updated = await withTestTenant(async () =>
        service.patch(id, { status: 'COMPLETED' }, adminActor()),
      );
      expect(updated.status).toBe('COMPLETED');
    });

    it('empty patch returns existing', async () => {
      const id = await seedIntervention();
      const r = await withTestTenant(async () => service.patch(id, {}, adminActor()));
      expect(r.id).toBe(id);
    });

    it('patch as non-counsellor → Forbidden', async () => {
      const id = await seedIntervention();
      await expect(
        withTestTenant(async () => service.patch(id, { frequency: 'x' }, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('logProgress + listProgress', () => {
    async function seedIntervention(): Promise<string> {
      const studentId = await seedStudent();
      const tierId = await seedTier(studentId);
      const r = await withTestTenant(async () => service.create(tierId, baseInput(), adminActor()));
      return r.id;
    }

    it('admin logs a progress entry', async () => {
      const id = await seedIntervention();
      const p = await withTestTenant(async () =>
        service.logProgress(
          id,
          {
            recordedDate: new Date().toISOString().slice(0, 10),
            measureType: 'FLUENCY_WPM',
            score: 82,
            benchmark: 80,
            notes: 'Met goal',
          },
          adminActor(),
        ),
      );
      expect(p.score).toBe(82);
      expect(p.benchmark).toBe(80);
    });

    it('listProgress returns entries sorted by recorded_date ASC', async () => {
      const id = await seedIntervention();
      await withTestTenant(async () =>
        service.logProgress(
          id,
          { recordedDate: '2026-01-01', measureType: 'FLUENCY_WPM', score: 50 },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.logProgress(
          id,
          { recordedDate: '2026-02-01', measureType: 'FLUENCY_WPM', score: 60 },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => service.listProgress(id, adminActor()));
      expect(list.length).toBe(2);
    });

    it('logProgress as non-counsellor → Forbidden', async () => {
      const id = await seedIntervention();
      await expect(
        withTestTenant(async () =>
          service.logProgress(
            id,
            { recordedDate: '2026-01-01', measureType: 'FLUENCY_WPM', score: 50 },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listProgress as non-counsellor → Forbidden', async () => {
      const id = await seedIntervention();
      await expect(
        withTestTenant(async () => service.listProgress(id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
