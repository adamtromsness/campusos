import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { AttendanceService } from '@modules/m20-sis/attendance/attendance.service';
import { AbsenceRequestService } from '@modules/m20-sis/attendance/absence-request.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  seedStudent,
  enrollStudent,
  assignTeacherToClass,
  linkStudentGuardian,
  cleanupSeededIds,
  ensureGuardianForPerson,
} from './sis-helpers';
import { TEST_SIS_CLASS_ID, TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';
import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';

describe('integration:m20-sis/attendance', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let service: AttendanceService;
  let absenceService: AbsenceRequestService;

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
    service = new AttendanceService(tenantPrisma, kafka as unknown as KafkaProducerService);
    absenceService = new AbsenceRequestService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.sis_attendance_records CASCADE`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_absence_requests`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
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

  describe('AttendanceService', () => {
    it('admin: getClassAttendance auto pre-populates roster on first read with period', async () => {
      await assignTeacherToClass(rawClient);
      const s1 = await trackedStudent({ firstName: 'Att1', lastName: 'X' });
      const s2 = await trackedStudent({ firstName: 'Att2', lastName: 'Y' });
      await enrollStudent(rawClient, s1.studentId);
      await enrollStudent(rawClient, s2.studentId);

      const rows = await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-01', '1', adminActor()),
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.status).toBe('PRESENT');
        expect(r.confirmationStatus).toBe('PRE_POPULATED');
      }
    });

    it('admin: getClassAttendance with no period → returns existing rows without pre-populate', async () => {
      await assignTeacherToClass(rawClient);
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      // No prepopulate
      const rows = await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-02', undefined, adminActor()),
      );
      expect(rows).toHaveLength(0);
    });

    it('teacher who is class teacher: can read + pre-populate', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID, TEST_TEACHER_EMPLOYEE_ID);
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      const rows = await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-03', '1', teacherActor()),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.studentId).toBe(s.studentId);
    });

    it('teacher NOT in class: getClassAttendance → 404', async () => {
      // No sis_class_teachers row for this teacher
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await expect(
        withTestTenant(async () =>
          service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-04', '1', teacherActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unknown class id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getClassAttendance(
            '00000000-0000-0000-0000-000000000000',
            '2026-09-05',
            '1',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('batchSubmit by class teacher updates statuses + emits per-student events', async () => {
      await assignTeacherToClass(rawClient);
      const present = await trackedStudent({ firstName: 'Pre', lastName: 'Sent' });
      const tardy = await trackedStudent({ firstName: 'Tar', lastName: 'Dy' });
      const absent = await trackedStudent({ firstName: 'Ab', lastName: 'Sent' });
      await enrollStudent(rawClient, present.studentId);
      await enrollStudent(rawClient, tardy.studentId);
      await enrollStudent(rawClient, absent.studentId);

      const result = await withTestTenant(async () =>
        service.batchSubmit(
          TEST_SIS_CLASS_ID,
          '2026-09-06',
          '1',
          [
            { studentId: tardy.studentId, status: 'TARDY' } as any,
            { studentId: absent.studentId, status: 'ABSENT' } as any,
          ],
          teacherActor(),
        ),
      );
      expect(result.totalStudents).toBe(3);
      expect(result.presentCount).toBe(1);
      expect(result.tardyCount).toBe(1);
      expect(result.absentCount).toBe(1);

      const recorded = kafka as unknown as RecordingKafkaProducer;
      const tardyEmits = recorded.calls.filter((c) => c.topic === 'att.student.marked_tardy');
      const absentEmits = recorded.calls.filter((c) => c.topic === 'att.student.marked_absent');
      const confirmedEmits = recorded.calls.filter((c) => c.topic === 'att.attendance.confirmed');
      expect(tardyEmits).toHaveLength(1);
      expect(absentEmits).toHaveLength(1);
      expect(confirmedEmits).toHaveLength(1);

      // Confirmed row in DB
      const dbRow = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.sis_attendance_records WHERE student_id = $1::uuid AND date = '2026-09-06'::date`,
        tardy.studentId,
      );
      expect(dbRow[0]!.status).toBe('TARDY');
    });

    it('batchSubmit by non-class teacher → ForbiddenException', async () => {
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await expect(
        withTestTenant(async () =>
          service.batchSubmit(
            TEST_SIS_CLASS_ID,
            '2026-09-07',
            '1',
            [],
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('markIndividual updates status + emits events', async () => {
      await assignTeacherToClass(rawClient);
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      // Pre-populate via getClassAttendance
      await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-08', '1', adminActor()),
      );
      const recordRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.sis_attendance_records WHERE student_id = $1::uuid`,
        s.studentId,
      );
      const recordId = recordRow[0]!.id;
      (kafka as unknown as RecordingKafkaProducer).reset();
      const updated = await withTestTenant(async () =>
        service.markIndividual(
          recordId,
          { status: 'TARDY', parentExplanation: 'Late bus' } as any,
          teacherActor(),
        ),
      );
      expect(updated.status).toBe('TARDY');

      const emits = (kafka as unknown as RecordingKafkaProducer).calls;
      expect(emits.some((c) => c.topic === 'att.attendance.marked')).toBe(true);
      expect(emits.some((c) => c.topic === 'att.student.marked_tardy')).toBe(true);
    });

    it('markIndividual on unknown record → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.markIndividual(
            '00000000-0000-0000-0000-000000000000',
            { status: 'PRESENT' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('markIndividual by non-teacher → ForbiddenException', async () => {
      // Admin populates, then teacher (not assigned) tries to update
      await assignTeacherToClass(rawClient);
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-09', '1', adminActor()),
      );
      const recordRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.sis_attendance_records WHERE student_id = $1::uuid`,
        s.studentId,
      );
      // Reset teacher assignment so this teacher is not in the class
      await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_class_teachers`);
      await expect(
        withTestTenant(async () =>
          service.markIndividual(
            recordRow[0]!.id,
            { status: 'TARDY' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student persona: getClassAttendance only sees own row', async () => {
      // Register the calling student in the class
      await assignTeacherToClass(rawClient);
      // Map TEST_STUDENT_PERSON_ID to a sis_students row
      const studentRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES (gen_random_uuid(), $1::uuid, 'Self', 'Att', true)
         RETURNING id`,
        TEST_STUDENT_PERSON_ID,
      );
      const psId = studentRow[0]!.id;
      platformStudentIds.push(psId);
      const sisRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'SELF-ATT', '5')
         RETURNING id`,
        psId,
        TEST_SCHOOL_ID,
      );
      const selfStudentId = sisRow[0]!.id;
      studentIds.push(selfStudentId);
      await enrollStudent(rawClient, selfStudentId);
      // Another student in the same class — must not be visible to the calling student
      const peer = await trackedStudent({ firstName: 'Peer', lastName: 'Att' });
      await enrollStudent(rawClient, peer.studentId);

      // Pre-populate via admin so rows exist
      await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-10', '1', adminActor()),
      );

      // Student reads — should see only self
      const rows = await withTestTenant(
        async () =>
          service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-10', '1', studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.studentId).toBe(selfStudentId);
    });

    it('guardian persona: getClassAttendance shows only linked child', async () => {
      await assignTeacherToClass(rawClient);
      // Seed guardian for parentActor (idempotent across spec files)
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        '019e0cf8-aaaa-7777-8888-000000000051',
      );
      guardianIds.push(guardianId);
      const child = await trackedStudent({ firstName: 'MyChild', lastName: 'A' });
      const peer = await trackedStudent({ firstName: 'NotMine', lastName: 'B' });
      await linkStudentGuardian(rawClient, child.studentId, guardianId);
      await enrollStudent(rawClient, child.studentId);
      await enrollStudent(rawClient, peer.studentId);

      // Admin pre-populates
      await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-11', '1', adminActor()),
      );

      const rows = await withTestTenant(
        async () =>
          service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-11', '1', parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(rows.map((r) => r.studentId)).toContain(child.studentId);
      expect(rows.map((r) => r.studentId)).not.toContain(peer.studentId);
    });

    it('getStudentAttendance returns history for a student', async () => {
      await assignTeacherToClass(rawClient);
      const s = await trackedStudent();
      await enrollStudent(rawClient, s.studentId);
      await withTestTenant(async () =>
        service.getClassAttendance(TEST_SIS_CLASS_ID, '2026-09-12', '1', adminActor()),
      );
      const history = await withTestTenant(async () =>
        service.getStudentAttendance(s.studentId, '2026-09-01', '2026-09-30'),
      );
      expect(history).toHaveLength(1);
      expect(history[0]!.studentId).toBe(s.studentId);
    });
  });

  describe('AbsenceRequestService', () => {
    it('admin creates SAME_DAY_REPORT → status auto-approved', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        absenceService.create(
          TEST_ADMIN_ACCOUNT_ID,
          '019e0cf8-aaaa-7777-8888-000000000010',
          {
            studentId: s.studentId,
            absenceDateFrom: '2026-09-15',
            absenceDateTo: '2026-09-15',
            requestType: 'SAME_DAY_REPORT',
            reasonCategory: 'ILLNESS',
            reasonText: 'Fever',
          } as any,
          true,
        ),
      );
      expect(req.status).toBe('AUTO_APPROVED');
      expect(req.requestType).toBe('SAME_DAY_REPORT');
    });

    it('guardian-linked submitter creates ADVANCE_REQUEST → status PENDING', async () => {
      const s = await trackedStudent();
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      await linkStudentGuardian(rawClient, s.studentId, guardianId);

      const req = await withTestTenant(
        async () =>
          absenceService.create(
            TEST_PARENT_ACCOUNT_ID,
            TEST_PARENT_PERSON_ID,
            {
              studentId: s.studentId,
              absenceDateFrom: '2026-10-01',
              absenceDateTo: '2026-10-03',
              requestType: 'ADVANCE_REQUEST',
              reasonCategory: 'FAMILY_EMERGENCY',
              reasonText: 'Funeral',
            } as any,
            false,
          ),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(req.status).toBe('PENDING');
    });

    it('non-guardian non-admin → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(
          async () =>
            absenceService.create(
              TEST_PARENT_ACCOUNT_ID,
              TEST_PARENT_PERSON_ID,
              {
                studentId: s.studentId,
                absenceDateFrom: '2026-10-01',
                absenceDateTo: '2026-10-01',
                requestType: 'ADVANCE_REQUEST',
                reasonCategory: 'OTHER',
                reasonText: 'x',
              } as any,
              false,
            ),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('absenceDateTo before absenceDateFrom → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          absenceService.create(
            TEST_ADMIN_ACCOUNT_ID,
            '019e0cf8-aaaa-7777-8888-000000000010',
            {
              studentId: s.studentId,
              absenceDateFrom: '2026-10-05',
              absenceDateTo: '2026-10-03',
              requestType: 'ADVANCE_REQUEST',
              reasonCategory: 'OTHER',
              reasonText: 'x',
            } as any,
            true,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('admin reviews PENDING request → APPROVED', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        absenceService.create(
          TEST_ADMIN_ACCOUNT_ID,
          '019e0cf8-aaaa-7777-8888-000000000010',
          {
            studentId: s.studentId,
            absenceDateFrom: '2026-10-10',
            absenceDateTo: '2026-10-12',
            requestType: 'ADVANCE_REQUEST',
            reasonCategory: 'HOLIDAY',
            reasonText: 'Family trip',
          } as any,
          true,
        ),
      );
      const reviewed = await withTestTenant(async () =>
        absenceService.review(
          req.id,
          TEST_ADMIN_ACCOUNT_ID,
          { decision: 'APPROVED', reviewerNotes: 'ok' } as any,
        ),
      );
      expect(reviewed.status).toBe('APPROVED');
      const calls = (kafka as unknown as RecordingKafkaProducer).calls;
      expect(calls.some((c) => c.topic === 'att.absence.reviewed')).toBe(true);
    });

    it('reviewing already-reviewed request → BadRequestException', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        absenceService.create(
          TEST_ADMIN_ACCOUNT_ID,
          '019e0cf8-aaaa-7777-8888-000000000010',
          {
            studentId: s.studentId,
            absenceDateFrom: '2026-11-01',
            absenceDateTo: '2026-11-01',
            requestType: 'SAME_DAY_REPORT',
            reasonCategory: 'ILLNESS',
            reasonText: 'x',
          } as any,
          true,
        ),
      );
      // SAME_DAY_REPORT lands as AUTO_APPROVED; reviewing it should fail.
      await expect(
        withTestTenant(async () =>
          absenceService.review(req.id, TEST_ADMIN_ACCOUNT_ID, { decision: 'REJECTED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('review unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          absenceService.review(
            '00000000-0000-0000-0000-000000000000',
            TEST_ADMIN_ACCOUNT_ID,
            { decision: 'APPROVED' } as any,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list filters by studentId + status; non-admin restricted to own submissions', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        absenceService.create(
          TEST_ADMIN_ACCOUNT_ID,
          '019e0cf8-aaaa-7777-8888-000000000010',
          {
            studentId: s.studentId,
            absenceDateFrom: '2026-09-15',
            absenceDateTo: '2026-09-15',
            requestType: 'SAME_DAY_REPORT',
            reasonCategory: 'ILLNESS',
            reasonText: 'x',
          } as any,
          true,
        ),
      );
      const adminList = await withTestTenant(async () =>
        absenceService.list(
          TEST_ADMIN_ACCOUNT_ID,
          { studentId: s.studentId, status: 'AUTO_APPROVED' } as any,
          true,
        ),
      );
      expect(adminList).toHaveLength(1);

      // A parent (different submitter) sees zero, since the request was submitted by admin.
      const parentList = await withTestTenant(
        async () =>
          absenceService.list(TEST_PARENT_ACCOUNT_ID, { studentId: s.studentId } as any, false),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(parentList).toHaveLength(0);
    });

    it('getById: admin can see any; submitter can see own; other → 403', async () => {
      const s = await trackedStudent();
      const req = await withTestTenant(async () =>
        absenceService.create(
          TEST_ADMIN_ACCOUNT_ID,
          '019e0cf8-aaaa-7777-8888-000000000010',
          {
            studentId: s.studentId,
            absenceDateFrom: '2026-09-15',
            absenceDateTo: '2026-09-15',
            requestType: 'SAME_DAY_REPORT',
            reasonCategory: 'ILLNESS',
            reasonText: 'x',
          } as any,
          true,
        ),
      );
      const adminDto = await withTestTenant(async () =>
        absenceService.getById(req.id, TEST_ADMIN_ACCOUNT_ID, true),
      );
      expect(adminDto.id).toBe(req.id);

      await expect(
        withTestTenant(async () =>
          absenceService.getById(req.id, TEST_PARENT_ACCOUNT_ID, false),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          absenceService.getById(
            '00000000-0000-0000-0000-000000000000',
            TEST_ADMIN_ACCOUNT_ID,
            true,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Suppress unused-imports
  void TEST_SIS_ACADEMIC_YEAR_ID;
});
