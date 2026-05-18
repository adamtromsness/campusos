import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { StudentNoteService } from '@modules/m20-sis/notes/student-note.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  studentActor,
  TEST_PARENT_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  cleanupSeededIds,
  ensureGuardianForPerson,
} from './sis-helpers';

/**
 * Wave 4 — m20-sis StudentNoteService DB-backed integration.
 *
 * Strategy doc spotlight (Codex defect area):
 *   "assertStudentExists includes school_id, listForStudent binds school_id,
 *    create validates studentId in same tx"
 *
 * Contracts:
 *   - Only STAFF + admins can create notes (gate via PermissionCheckService)
 *   - Admin sees every note in the school including CONFIDENTIAL
 *   - STAFF author sees own CONFIDENTIAL; non-author STAFF cannot
 *   - GUARDIAN sees only is_parent_visible=true AND is_confidential=false
 *     notes for own children
 *   - STUDENT sees no notes via this service
 *   - CONFIDENTIAL + is_visible_to_parent contradiction is rejected at write
 *   - assertStudentExists validates school_id (cross-school 404)
 *   - createForStudent validates studentId inside the SAME tx
 *   - Non-author non-admin staff cannot delete a peer's note
 *   - Cross-school: studentId from School B → NotFoundException
 */
describe('integration:m20-sis/student-notes', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let service: StudentNoteService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    service = new StudentNoteService(tenantPrisma, permCheck);

    // Seed the access-cache row that lets the teacher persona pass the
    // permission check inside StudentNoteService.isStaff().
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['stu-002:write']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_TEACHER_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_student_notes`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function trackedGuardian(opts: Parameters<typeof seedGuardian>[1] = {}) {
    const g = await seedGuardian(rawClient, opts);
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    return g;
  }

  describe('create', () => {
    it('admin creates a PASTORAL note', async () => {
      const s = await trackedStudent({ firstName: 'Note', lastName: 'Stu' });
      const note = await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'Made good progress today.' } as any,
          adminActor(),
        ),
      );
      expect(note.studentId).toBe(s.studentId);
      expect(note.noteType).toBe('PASTORAL');
      expect(note.isConfidential).toBe(false);
    });

    it('teacher with stu-002:write can author a note', async () => {
      const s = await trackedStudent();
      const note = await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'ACADEMIC', noteText: 'Strong in arithmetic.' } as any,
          teacherActor(),
        ),
      );
      expect(note.id).toBeDefined();
    });

    it('GUARDIAN cannot author a note → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(
          async () =>
            service.createForStudent(
              s.studentId,
              { noteType: 'PASTORAL', noteText: 'attempt' } as any,
              parentActor(),
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT cannot author a note → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          service.createForStudent(
            s.studentId,
            { noteType: 'PASTORAL', noteText: 'attempt' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invalid noteType → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          service.createForStudent(
            s.studentId,
            { noteType: 'NOPE', noteText: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CONFIDENTIAL + isVisibleToParent=true → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          service.createForStudent(
            s.studentId,
            {
              noteType: 'PASTORAL',
              noteText: 'x',
              isConfidential: true,
              isVisibleToParent: true,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school studentId → NotFoundException (Codex 1a)', async () => {
      const bStudent = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          service.createForStudent(
            bStudent.studentId,
            { noteType: 'PASTORAL', noteText: 'attempt' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listForStudent', () => {
    it('admin sees all notes including CONFIDENTIAL authored by anyone', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'visible' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'confidential', isConfidential: true } as any,
          teacherActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(2);
    });

    it('STAFF non-author sees non-confidential only', async () => {
      const s = await trackedStudent();
      // Admin authors a confidential note
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'priv', isConfidential: true } as any,
          adminActor(),
        ),
      );
      // Admin authors a non-confidential note
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'ACADEMIC', noteText: 'public' } as any,
          adminActor(),
        ),
      );

      const teacherList = await withTestTenant(async () =>
        service.listForStudent(s.studentId, teacherActor()),
      );
      expect(teacherList.map((n) => n.noteText)).toContain('public');
      expect(teacherList.map((n) => n.noteText)).not.toContain('priv');
    });

    it('STAFF author can see own CONFIDENTIAL', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'mine', isConfidential: true } as any,
          teacherActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForStudent(s.studentId, teacherActor()),
      );
      expect(list.map((n) => n.noteText)).toContain('mine');
    });

    it('GUARDIAN sees only is_parent_visible=true notes for own child', async () => {
      const s = await trackedStudent();
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        '019e0cf8-aaaa-7777-8888-000000000051',
      );
      guardianIds.push(guardianId);
      await linkStudentGuardian(rawClient, s.studentId, guardianId);

      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'GENERAL', noteText: 'open', isVisibleToParent: true } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'GENERAL', noteText: 'staff-only' } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(
        async () => service.listForStudent(s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(list.map((n) => n.noteText)).toContain('open');
      expect(list.map((n) => n.noteText)).not.toContain('staff-only');
    });

    it('STUDENT persona sees no notes', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'x' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForStudent(s.studentId, studentActor()),
      );
      expect(list).toHaveLength(0);
    });

    it('listForStudent with unknown studentId → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.listForStudent('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForStudent with cross-school studentId → NotFoundException (Codex 1a)', async () => {
      const bStudent = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => service.listForStudent(bStudent.studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('delete', () => {
    it('admin can delete any note', async () => {
      const s = await trackedStudent();
      const n = await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'x' } as any,
          teacherActor(),
        ),
      );
      await withTestTenant(async () => service.delete(n.id, adminActor()));
      const list = await withTestTenant(async () =>
        service.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(0);
    });

    it('non-author non-admin staff cannot delete → ForbiddenException', async () => {
      const s = await trackedStudent();
      const n = await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'mine' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.delete(n.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delete unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.delete('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('author can delete own note', async () => {
      const s = await trackedStudent();
      const n = await withTestTenant(async () =>
        service.createForStudent(
          s.studentId,
          { noteType: 'PASTORAL', noteText: 'mine' } as any,
          teacherActor(),
        ),
      );
      await withTestTenant(async () => service.delete(n.id, teacherActor()));
      const remaining = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.sis_student_notes WHERE id = $1::uuid`,
        n.id,
      );
      expect(remaining).toHaveLength(0);
    });
  });
});
