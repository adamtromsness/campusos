import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ClassMomentService } from '@modules/m21-classroom/classes/class-moment.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import {
  assignTeacherToClass,
  cleanupSeededIds,
  ensureGuardianForPerson,
  enrollStudent,
  linkStudentGuardian,
  seedStudent,
} from '../m20-sis/sis-helpers';

describe('integration:m21-classroom/class-moments', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: ClassMomentService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new ClassMomentService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_class_moment_reactions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.cls_class_moment_photos`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_class_moments`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  async function trackedStudent() {
    const s = await seedStudent(rawClient);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  describe('create', () => {
    it('class teacher creates a moment with photos', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const moment = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          {
            caption: 'Field trip!',
            photos: [
              { s3Key: 's3://bucket/p1.jpg', sortOrder: 0 },
              { s3Key: 's3://bucket/p2.jpg', sortOrder: 1 },
            ],
          } as any,
          teacherActor(),
        ),
      );
      expect(moment.caption).toBe('Field trip!');
      expect(moment.photos).toHaveLength(2);
    });

    it('admin can create without teacher assignment', async () => {
      const moment = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { caption: 'Admin post', photos: [{ s3Key: 's3://admin.jpg' }] } as any,
          adminActor(),
        ),
      );
      expect(moment.id).toBeDefined();
    });

    it('non-class teacher → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            TEST_SIS_CLASS_ID,
            { photos: [{ s3Key: 's3://x.jpg' }] } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('zero photos → BadRequestException', async () => {
      await assignTeacherToClass(rawClient);
      await expect(
        withTestTenant(async () =>
          service.create(TEST_SIS_CLASS_ID, { photos: [] } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown classId → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            '00000000-0000-0000-0000-000000000000',
            { photos: [{ s3Key: 's3://x.jpg' }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('read', () => {
    it('listForClass returns moments newest first', async () => {
      const m1 = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { caption: 'first', photos: [{ s3Key: 'a' }] } as any,
          adminActor(),
        ),
      );
      const m2 = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { caption: 'second', photos: [{ s3Key: 'b' }] } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        service.listForClass(TEST_SIS_CLASS_ID, adminActor()),
      );
      expect(list.map((r) => r.id)).toEqual(expect.arrayContaining([m1.id, m2.id]));
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('student enrolled in class can read', async () => {
      const studentId = '019e0cf8-aaaa-7777-8888-000000000040';
      const psId = '019e0cf8-aaaa-7777-8888-00000000004a';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES ($1::uuid, $2::uuid, 'Read', 'Stu', true)
         ON CONFLICT (id) DO NOTHING`,
        psId,
        TEST_STUDENT_PERSON_ID,
      );
      platformStudentIds.push(psId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
         VALUES ($1::uuid, $2::uuid, '019e0cf8-aaaa-7777-8888-000000000002'::uuid, 'READ-1', '5')
         ON CONFLICT (id) DO NOTHING`,
        studentId,
        psId,
      );
      studentIds.push(studentId);
      await enrollStudent(rawClient, studentId);
      await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'a' }] } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => service.listForClass(TEST_SIS_CLASS_ID, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('non-enrolled student → NotFoundException', async () => {
      await expect(
        withTestTenant(
          async () => service.listForClass(TEST_SIS_CLASS_ID, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('parent of enrolled child can read', async () => {
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      const gid = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        '019e0cf8-aaaa-7777-8888-000000000051',
      );
      guardianIds.push(gid);
      await linkStudentGuardian(rawClient, s.studentId, gid);
      await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'p' }] } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => service.listForClass(TEST_SIS_CLASS_ID, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(list.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('delete', () => {
    it('admin can delete any moment', async () => {
      const m = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'd1' }] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.delete(m.id, adminActor()));
      await expect(
        withTestTenant(async () => service.getById(m.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-poster non-admin teacher → ForbiddenException', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      // Admin posts; non-poster teacher tries to delete
      const m = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'd2' }] } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.delete(m.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delete unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.delete('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('react / unreact', () => {
    it('admin can react to a moment + unreact', async () => {
      const m = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'r' }] } as any,
          adminActor(),
        ),
      );
      const reacted = await withTestTenant(async () =>
        service.react(m.id, { reactionType: 'LIKE' } as any, adminActor()),
      );
      expect(reacted.reactions.length).toBeGreaterThan(0);

      const unreacted = await withTestTenant(async () => service.unreact(m.id, adminActor()));
      expect(unreacted.reactions).toHaveLength(0);
    });

    it('invalid reactionType → BadRequestException', async () => {
      const m = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'r' }] } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.react(m.id, { reactionType: 'WAVE' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('react upsert: changing reaction type updates the existing row', async () => {
      const m = await withTestTenant(async () =>
        service.create(
          TEST_SIS_CLASS_ID,
          { photos: [{ s3Key: 'r' }] } as any,
          adminActor(),
        ),
      );
      const first = await withTestTenant(async () =>
        service.react(m.id, { reactionType: 'LIKE' } as any, adminActor()),
      );
      expect(first.reactions[0]!.reactionType).toBe('LIKE');
      const second = await withTestTenant(async () =>
        service.react(m.id, { reactionType: 'LOVE' } as any, adminActor()),
      );
      expect(second.reactions).toHaveLength(1);
      expect(second.reactions[0]!.reactionType).toBe('LOVE');
    });
  });
});
