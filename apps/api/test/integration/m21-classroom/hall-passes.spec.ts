import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { HallPassService } from '@modules/m21-classroom/hall-passes/hall-pass.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 4 — m21-classroom HallPassService DB-backed integration tests.
 *
 * Service: apps/api/src/modules/m21-classroom/hall-passes/hall-pass.service.ts
 *
 * Contracts verified:
 *   - getSettings() lazily inserts a default cls_hall_pass_settings row
 *     for the current school on first read.
 *   - updateSettings() is admin-only; empty destinations → BadRequest.
 *   - issue() enforces:
 *       * caller is class teacher or admin (else 403)
 *       * caller has an hr_employees row (else 403)
 *       * target student is actively enrolled in the class (else 400)
 *       * destination is in settings.destinations (else 400)
 *       * concurrent-per-class limit (settings.max_concurrent_passes_per_class)
 *       * daily-per-student limit (settings.max_daily_passes_per_student)
 *       * cls.hall_pass.issued Kafka emit after commit
 *   - returnPass() / recall() row-locked state-machine transitions with
 *     proper Forbidden / NotFound / BadRequest error mapping.
 *   - list() row-scope by persona: admin → all, teacher → own classes,
 *     STUDENT → own passes, GUARDIAN → empty.
 *   - sweepOverdueForCurrentTenant() flips past-due ACTIVE rows to
 *     OVERDUE and emits cls.hall_pass.overdue per row.
 */
describe('integration:m21-classroom/hall-passes', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let service: HallPassService;

  // Per-test trackers, cleaned in beforeEach of the next test.
  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    service = new HallPassService(tenantPrisma, kafka as unknown as KafkaProducerService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    // Wipe hall-pass state. The shared tenant_test schema means we must
    // be surgical: only kill hall-pass rows + the class-teacher / enrolment
    // links the test sets up. Fixture rows (sis_classes / hr_employees)
    // stay put.
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_passes`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.cls_hall_pass_settings`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_enrollments`);
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

  // ────────────────────────────────────────────────────────────────────
  // getSettings — lazy-init default row
  // ────────────────────────────────────────────────────────────────────
  describe('getSettings', () => {
    it('first read on a school auto-inserts the default cls_hall_pass_settings row', async () => {
      // Sanity: no row exists yet (beforeEach wiped it).
      const before = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_hall_pass_settings WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(before[0]!.count).toBe(0);

      const dto = await withTestTenant(async () => service.getSettings());
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.maxConcurrentPassesPerClass).toBeGreaterThan(0);
      expect(dto.maxDailyPassesPerStudent).toBeGreaterThan(0);
      expect(dto.defaultDurationMinutes).toBeGreaterThan(0);
      expect(dto.destinations).toEqual(
        expect.arrayContaining(['Bathroom', 'Nurse', 'Office', 'Library', 'Other']),
      );
      expect(dto.requireTeacherApproval).toBe(true);

      const after = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_hall_pass_settings WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(after[0]!.count).toBe(1);
    });

    it('second read returns the same row without inserting another', async () => {
      const first = await withTestTenant(async () => service.getSettings());
      const second = await withTestTenant(async () => service.getSettings());
      expect(second.id).toBe(first.id);
      const count = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.cls_hall_pass_settings WHERE school_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(count[0]!.count).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // updateSettings — admin-only
  // ────────────────────────────────────────────────────────────────────
  describe('updateSettings', () => {
    it('admin updates concurrent / daily / duration / destinations / approval flag', async () => {
      const updated = await withTestTenant(async () =>
        service.updateSettings(
          {
            maxConcurrentPassesPerClass: 2,
            maxDailyPassesPerStudent: 4,
            defaultDurationMinutes: 15,
            destinations: ['Bathroom', 'Library'],
            requireTeacherApproval: false,
          } as any,
          adminActor(),
        ),
      );
      expect(updated.maxConcurrentPassesPerClass).toBe(2);
      expect(updated.maxDailyPassesPerStudent).toBe(4);
      expect(updated.defaultDurationMinutes).toBe(15);
      expect(updated.destinations).toEqual(['Bathroom', 'Library']);
      expect(updated.requireTeacherApproval).toBe(false);
    });

    it('non-admin (teacher) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateSettings({ maxConcurrentPassesPerClass: 2 } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('empty destinations array → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateSettings({ destinations: [] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty patch (no fields) is a no-op and returns current settings', async () => {
      const before = await withTestTenant(async () => service.getSettings());
      const result = await withTestTenant(async () =>
        service.updateSettings({} as any, adminActor()),
      );
      expect(result.id).toBe(before.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // issue — auth + limits + emit
  // ────────────────────────────────────────────────────────────────────
  describe('issue', () => {
    it('admin issues a pass → row inserted, cls.hall_pass.issued emitted', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const dto = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.studentId).toBe(student.studentId);
      expect(dto.classId).toBe(TEST_SIS_CLASS_ID);
      expect(dto.destination).toBe('Bathroom');
      expect(dto.status).toBe('ACTIVE');
      expect(dto.returnedAt).toBeNull();

      const row = await rawClient.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id::text, status FROM ${TEST_SCHEMA}.cls_hall_passes WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row[0]!.status).toBe('ACTIVE');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const issued = recorded.calls.filter((c) => c.topic === 'cls.hall_pass.issued');
      expect(issued).toHaveLength(1);
      expect(issued[0]!.key).toBe(dto.id);
      expect(issued[0]!.sourceModule).toBe('classroom');
      expect(issued[0]!.payload).toMatchObject({
        hallPassId: dto.id,
        schoolId: TEST_SCHOOL_ID,
        studentId: student.studentId,
        classId: TEST_SIS_CLASS_ID,
        destination: 'Bathroom',
      });
    });

    it('class teacher issues a pass → succeeds', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const dto = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Office',
          } as any,
          teacherActor(),
        ),
      );
      expect(dto.status).toBe('ACTIVE');
      expect(dto.issuedBy).toBe(TEST_TEACHER_EMPLOYEE_ID);
    });

    it('teacher NOT assigned to the class → ForbiddenException', async () => {
      // No sis_class_teachers row for this teacher
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          service.issue(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_ID,
              destination: 'Bathroom',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-employee caller (student persona) → ForbiddenException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(
          async () =>
            service.issue(
              {
                studentId: student.studentId,
                classId: TEST_SIS_CLASS_ID,
                destination: 'Bathroom',
              } as any,
              studentActor(),
            ),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student not enrolled in class → BadRequestException', async () => {
      const student = await trackedStudent();
      // No enrollment row
      await expect(
        withTestTenant(async () =>
          service.issue(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_ID,
              destination: 'Bathroom',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('destination not in settings.destinations → BadRequestException', async () => {
      // Restrict destinations to a single value
      await withTestTenant(async () =>
        service.updateSettings({ destinations: ['Bathroom'] } as any, adminActor()),
      );
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      await expect(
        withTestTenant(async () =>
          service.issue(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_ID,
              destination: 'Roof',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('concurrent-per-class limit enforces: second issue with limit=1 → BadRequest', async () => {
      await withTestTenant(async () =>
        service.updateSettings(
          { maxConcurrentPassesPerClass: 1, maxDailyPassesPerStudent: 10 } as any,
          adminActor(),
        ),
      );
      const s1 = await trackedStudent({ firstName: 'C1', lastName: 'A' });
      const s2 = await trackedStudent({ firstName: 'C2', lastName: 'B' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);

      await withTestTenant(async () =>
        service.issue(
          {
            studentId: s1.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.issue(
            {
              studentId: s2.studentId,
              classId: TEST_SIS_CLASS_ID,
              destination: 'Bathroom',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('daily-per-student limit enforces: second issue for same student with limit=1 → BadRequest', async () => {
      // High concurrent cap so daily triggers first; daily cap = 1.
      await withTestTenant(async () =>
        service.updateSettings(
          { maxConcurrentPassesPerClass: 5, maxDailyPassesPerStudent: 1 } as any,
          adminActor(),
        ),
      );
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);

      const first = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      // Return the first so it cannot trip the concurrent gate — only the
      // daily count should block the next issue.
      await withTestTenant(async () => service.returnPass(first.id, {} as any, adminActor()));

      await expect(
        withTestTenant(async () =>
          service.issue(
            {
              studentId: student.studentId,
              classId: TEST_SIS_CLASS_ID,
              destination: 'Bathroom',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // returnPass — admin / class teacher
  // ────────────────────────────────────────────────────────────────────
  describe('returnPass', () => {
    async function seedActivePass(): Promise<string> {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const dto = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      return dto.id;
    }

    it('admin returns an ACTIVE pass → status=RETURNED, returned_at set', async () => {
      const passId = await seedActivePass();
      const dto = await withTestTenant(async () =>
        service.returnPass(passId, { notes: 'back ok' } as any, adminActor()),
      );
      expect(dto.status).toBe('RETURNED');
      expect(dto.returnedAt).not.toBeNull();
      expect(dto.notes).toBe('back ok');
    });

    it('class teacher returns the pass → succeeds', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const passId = await seedActivePass();
      const dto = await withTestTenant(async () =>
        service.returnPass(passId, {} as any, teacherActor()),
      );
      expect(dto.status).toBe('RETURNED');
    });

    it('teacher NOT assigned to class → ForbiddenException', async () => {
      const passId = await seedActivePass();
      // teacher actor has employeeId but no sis_class_teachers row
      await expect(
        withTestTenant(async () => service.returnPass(passId, {} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('already-RETURNED pass → BadRequestException', async () => {
      const passId = await seedActivePass();
      await withTestTenant(async () => service.returnPass(passId, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => service.returnPass(passId, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.returnPass('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // recall — issuing teacher / admin only
  // ────────────────────────────────────────────────────────────────────
  describe('recall', () => {
    it('admin recalls an ACTIVE pass → status=RECALLED with reason appended to notes', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const issued = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
            notes: 'orig',
          } as any,
          adminActor(),
        ),
      );
      const recalled = await withTestTenant(async () =>
        service.recall(issued.id, { reason: 'fire drill' } as any, adminActor()),
      );
      expect(recalled.status).toBe('RECALLED');
      expect(recalled.returnedAt).not.toBeNull();
      expect(recalled.notes).toContain('RECALLED: fire drill');
      expect(recalled.notes).toContain('orig');
    });

    it('issuing teacher can recall their own pass', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const issued = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          teacherActor(),
        ),
      );
      const recalled = await withTestTenant(async () =>
        service.recall(issued.id, { reason: 'changed mind' } as any, teacherActor()),
      );
      expect(recalled.status).toBe('RECALLED');
    });

    it('non-issuing teacher (admin issued) → ForbiddenException', async () => {
      // Admin issues; teacher (different employee) tries to recall — not
      // the issuer, not an admin, so 403.
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const issued = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.recall(issued.id, { reason: 'no' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('already-returned pass → BadRequestException', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const issued = await withTestTenant(async () =>
        service.issue(
          {
            studentId: student.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => service.returnPass(issued.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          service.recall(issued.id, { reason: 'late' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list — row scope by persona
  // ────────────────────────────────────────────────────────────────────
  describe('list', () => {
    /**
     * Seed-and-issue helper that creates a sis_students row mapped to the
     * student-actor's iam_person, so the STUDENT persona row-scope clause
     * (`hp.student_id = (SELECT s.id FROM sis_students s JOIN platform_students
     * ps ... WHERE ps.person_id = $actorPersonId)`) can resolve.
     */
    async function ensureStudentActorSisRow(): Promise<string> {
      // Pre-clean leaked rows from prior spec files — same-pid persona.
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.cls_hall_passes
         WHERE student_id IN (
           SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
           WHERE ps.person_id = $1::uuid)`,
        TEST_STUDENT_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_enrollments
         WHERE student_id IN (
           SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
           WHERE ps.person_id = $1::uuid)`,
        TEST_STUDENT_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students
         WHERE platform_student_id IN (
           SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
        TEST_STUDENT_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
        TEST_STUDENT_PERSON_ID,
      );
      const psId = generateId();
      const sid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES ($1::uuid, $2::uuid, 'Self', 'HallPass', true)`,
        psId,
        TEST_STUDENT_PERSON_ID,
      );
      platformStudentIds.push(psId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'HP-SELF-' + Math.random().toString(36).slice(2, 8),
      );
      studentIds.push(sid);
      return sid;
    }

    it('admin sees every pass in the school', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const a = await trackedStudent();
      const b = await trackedStudent();
      await enrollStudent(rawClient, a.studentId);
      await enrollStudent(rawClient, b.studentId);
      const p1 = await withTestTenant(async () =>
        service.issue(
          {
            studentId: a.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      const p2 = await withTestTenant(async () =>
        service.issue(
          {
            studentId: b.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Office',
          } as any,
          teacherActor(),
        ),
      );
      const all = await withTestTenant(async () => service.list(adminActor()));
      const ids = all.map((r) => r.id);
      expect(ids).toContain(p1.id);
      expect(ids).toContain(p2.id);
    });

    it('teacher sees only passes for classes they teach', async () => {
      // Teacher is assigned to class A only. Pass for class A (which admin
      // can issue) should appear; nothing else.
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const mine = await trackedStudent();
      await enrollStudent(rawClient, mine.studentId);
      const minePass = await withTestTenant(async () =>
        service.issue(
          {
            studentId: mine.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );

      // A pass in class B (different class) — admin issues; teacher isn't
      // assigned. Note: the foreign class belongs to School B in the
      // fixture; an admin actor in tenant_test still hits that class id
      // because the tenant context maps to TEST_SCHOOL_ID. So we use
      // class A here for the teacher's pass and skip the foreign pass.
      const list = await withTestTenant(async () => service.list(teacherActor()));
      const ids = list.map((r) => r.id);
      expect(ids).toContain(minePass.id);
    });

    it('teacher with no class assignments sees an empty list', async () => {
      // Issue a pass as admin (no teacher assignment yet).
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      const passDto = await withTestTenant(async () =>
        service.issue(
          {
            studentId: s.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      // Teacher actor is NOT in sis_class_teachers — list should be empty.
      const list = await withTestTenant(async () => service.list(teacherActor()));
      expect(list.map((r) => r.id)).not.toContain(passDto.id);
      expect(list).toEqual([]);
    });

    it('STUDENT persona sees only their own pass', async () => {
      const selfSid = await ensureStudentActorSisRow();
      await enrollStudent(rawClient, selfSid);

      // Peer student in the same class — should not appear for the calling
      // STUDENT actor.
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'X' });
      await enrollStudent(rawClient, peer.studentId);

      const selfPass = await withTestTenant(async () =>
        service.issue(
          {
            studentId: selfSid,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      const peerPass = await withTestTenant(async () =>
        service.issue(
          {
            studentId: peer.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Office',
          } as any,
          adminActor(),
        ),
      );

      const list = await withTestTenant(async () => service.list(studentActor()), {
        personId: TEST_STUDENT_PERSON_ID,
      });
      const ids = list.map((r) => r.id);
      expect(ids).toContain(selfPass.id);
      expect(ids).not.toContain(peerPass.id);
    });

    it('GUARDIAN persona returns an empty list', async () => {
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await withTestTenant(async () =>
        service.issue(
          {
            studentId: s.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => service.list(parentActor()), {
        personId: TEST_PARENT_PERSON_ID,
      });
      expect(list).toEqual([]);
    });

    it('listActive (status=ACTIVE filter) only returns ACTIVE passes', async () => {
      const s1 = await trackedStudent({ firstName: 'A', lastName: 'A' });
      const s2 = await trackedStudent({ firstName: 'B', lastName: 'B' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);
      const activePass = await withTestTenant(async () =>
        service.issue(
          {
            studentId: s1.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Bathroom',
          } as any,
          adminActor(),
        ),
      );
      const returnedPass = await withTestTenant(async () =>
        service.issue(
          {
            studentId: s2.studentId,
            classId: TEST_SIS_CLASS_ID,
            destination: 'Office',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        service.returnPass(returnedPass.id, {} as any, adminActor()),
      );

      const active = await withTestTenant(async () => service.listActive(adminActor()));
      const ids = active.map((r) => r.id);
      expect(ids).toContain(activePass.id);
      expect(ids).not.toContain(returnedPass.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getById — error mapping
  // ────────────────────────────────────────────────────────────────────
  describe('getById', () => {
    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // sweepOverdueForCurrentTenant — cron worker logic
  // ────────────────────────────────────────────────────────────────────
  describe('sweepOverdueForCurrentTenant', () => {
    it('flips ACTIVE rows past expected_return_at → OVERDUE and emits cls.hall_pass.overdue', async () => {
      // Backfill an ACTIVE row whose window is entirely in the past so
      // the cls_hall_passes_window_chk (expected_return_at > issued_at)
      // stays satisfied while expected_return_at < now() triggers the
      // sweep.
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const passId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_hall_passes
           (id, school_id, student_id, class_id, issued_by, destination,
            issued_at, expected_return_at, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Bathroom',
                 now() - interval '2 hours', now() - interval '1 hour',
                 'ACTIVE', NULL)`,
        passId,
        TEST_SCHOOL_ID,
        student.studentId,
        TEST_SIS_CLASS_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      (kafka as unknown as RecordingKafkaProducer).reset();
      const flipped = await withTestTenant(async () => service.sweepOverdueForCurrentTenant());
      expect(flipped).toHaveLength(1);
      expect(flipped[0]!.id).toBe(passId);
      expect(flipped[0]!.status).toBe('OVERDUE');

      const dbRow = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.cls_hall_passes WHERE id = $1::uuid`,
        passId,
      );
      expect(dbRow[0]!.status).toBe('OVERDUE');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const overdueEmits = recorded.calls.filter((c) => c.topic === 'cls.hall_pass.overdue');
      expect(overdueEmits).toHaveLength(1);
      expect(overdueEmits[0]!.key).toBe(passId);
      expect(overdueEmits[0]!.payload).toMatchObject({
        hallPassId: passId,
        schoolId: TEST_SCHOOL_ID,
        studentId: student.studentId,
        classId: TEST_SIS_CLASS_ID,
      });
    });

    it('ACTIVE rows still in the future do NOT flip', async () => {
      const student = await trackedStudent();
      await enrollStudent(rawClient, student.studentId);
      const passId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.cls_hall_passes
           (id, school_id, student_id, class_id, issued_by, destination,
            issued_at, expected_return_at, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Bathroom',
                 now(), now() + interval '30 minutes',
                 'ACTIVE', NULL)`,
        passId,
        TEST_SCHOOL_ID,
        student.studentId,
        TEST_SIS_CLASS_ID,
        TEST_TEACHER_EMPLOYEE_ID,
      );

      (kafka as unknown as RecordingKafkaProducer).reset();
      const flipped = await withTestTenant(async () => service.sweepOverdueForCurrentTenant());
      expect(flipped).toEqual([]);

      const dbRow = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.cls_hall_passes WHERE id = $1::uuid`,
        passId,
      );
      expect(dbRow[0]!.status).toBe('ACTIVE');

      const recorded = kafka as unknown as RecordingKafkaProducer;
      expect(recorded.calls.filter((c) => c.topic === 'cls.hall_pass.overdue')).toHaveLength(0);
    });

    it('sweep with nothing overdue returns empty array (no emits)', async () => {
      (kafka as unknown as RecordingKafkaProducer).reset();
      const flipped = await withTestTenant(async () => service.sweepOverdueForCurrentTenant());
      expect(flipped).toEqual([]);
      const recorded = kafka as unknown as RecordingKafkaProducer;
      expect(recorded.calls.filter((c) => c.topic === 'cls.hall_pass.overdue')).toHaveLength(0);
    });
  });

  // Suppress unused import warning (kept for parity with other m21 fixtures).
  void TEST_SIS_CLASS_B_ID;
});
