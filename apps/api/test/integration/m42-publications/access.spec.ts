import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  assertAccountInCurrentTenant,
  canApproveSection,
  canEditPublication,
  isStudentCollaborator,
  isUniqueViolation,
} from '@modules/m42-publications/access';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  teacherActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m42-publications access.ts helper coverage.
 */
describe('integration:m42-publications/access', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;

  const seededPubIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);

    // Ensure the student actor has a sis_students row so
    // assertAccountInCurrentTenant resolves.
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Acc', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Acc', 'Student', true) ON CONFLICT DO NOTHING`,
      psId,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'Acc Student', 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_ACCOUNT_ID,
      TEST_STUDENT_PERSON_ID,
      'acc-student-' + TEST_STUDENT_ACCOUNT_ID.slice(-6) + '@test.local',
    );
    const existing = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid`,
      TEST_STUDENT_PERSON_ID,
      TEST_SCHOOL_ID,
    )) as Array<{ n: number }>;
    if (existing[0]!.n === 0) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED') ON CONFLICT DO NOTHING`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'ACC-' + sid.slice(-6),
      );
    }
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_collaborators WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publications WHERE id = ANY($1::uuid[])`,
        seededPubIds.splice(0),
      );
    }
  });

  async function seedPublication(): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Access Test', 'NEWSLETTER', 'DRAFT', $3::uuid)`,
      id,
      TEST_SCHOOL_ID,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  async function seedCollaborator(
    publicationId: string,
    userId: string,
    role: 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER',
  ): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publication_collaborators
         (id, publication_id, user_id, role, invited_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
      generateId(),
      publicationId,
      userId,
      role,
      TEST_ADMIN_ACCOUNT_ID,
    );
  }

  describe('isUniqueViolation', () => {
    it('returns true for Prisma P2002 error', () => {
      expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    });

    it('returns true for Prisma P2010 with meta.code=23505', () => {
      expect(isUniqueViolation({ code: 'P2010', meta: { code: '23505' } })).toBe(true);
    });

    it('returns true when message contains 23505', () => {
      expect(isUniqueViolation({ message: 'duplicate key value (23505)' })).toBe(true);
    });

    it('returns false for unrelated error', () => {
      expect(isUniqueViolation({ code: 'P2003' })).toBe(false);
      expect(isUniqueViolation({})).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
    });
  });

  describe('canEditPublication', () => {
    it('admin returns true without DB lookup', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canEditPublication(tenantPrisma, permCheck, adminActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('student collaborator on the publication returns true', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'CONTRIBUTOR');
      const ok = await withTestTenant(async () =>
        canEditPublication(tenantPrisma, permCheck, studentActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('parent without collaborator role + without writer permission → false', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canEditPublication(tenantPrisma, permCheck, parentActor(), pubId),
      );
      expect(ok).toBe(false);
    });

    it('teacher (STAFF) without write permission + not a collaborator → false', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canEditPublication(tenantPrisma, permCheck, teacherActor(), pubId),
      );
      expect(ok).toBe(false);
    });
  });

  describe('canApproveSection', () => {
    it('admin → true', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, adminActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('publication.created_by user → true', async () => {
      // Admin actor is also the created_by — should still return true via
      // either path.
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, adminActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('EDITOR collaborator (non-admin) → true', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'EDITOR');
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('REVIEWER collaborator → true', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'REVIEWER');
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('CONTRIBUTOR collaborator → false (cannot approve, only edit)', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'CONTRIBUTOR');
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(false);
    });

    it('non-collaborator parent → false', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        canApproveSection(tenantPrisma, parentActor(), pubId),
      );
      expect(ok).toBe(false);
    });
  });

  describe('isStudentCollaborator', () => {
    it('STUDENT + EDITOR role → true', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'EDITOR');
      const ok = await withTestTenant(async () =>
        isStudentCollaborator(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('STUDENT + CONTRIBUTOR role → true', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'CONTRIBUTOR');
      const ok = await withTestTenant(async () =>
        isStudentCollaborator(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(true);
    });

    it('STUDENT + VIEWER role → false (only EDITOR/CONTRIBUTOR count)', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'VIEWER');
      const ok = await withTestTenant(async () =>
        isStudentCollaborator(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(false);
    });

    it('non-STUDENT actor → false (short-circuit)', async () => {
      const pubId = await seedPublication();
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'CONTRIBUTOR');
      const ok = await withTestTenant(async () =>
        isStudentCollaborator(tenantPrisma, adminActor(), pubId),
      );
      expect(ok).toBe(false);
    });

    it('STUDENT not a collaborator → false', async () => {
      const pubId = await seedPublication();
      const ok = await withTestTenant(async () =>
        isStudentCollaborator(tenantPrisma, studentActor(), pubId),
      );
      expect(ok).toBe(false);
    });
  });

  describe('assertAccountInCurrentTenant', () => {
    it('valid student accountId resolves silently', async () => {
      await withTestTenant(async () =>
        assertAccountInCurrentTenant(tenantPrisma, TEST_STUDENT_ACCOUNT_ID, 'userId'),
      );
    });

    it('empty accountId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => assertAccountInCurrentTenant(tenantPrisma, '', 'userId')),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown accountId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          assertAccountInCurrentTenant(tenantPrisma, generateId(), 'userId'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
