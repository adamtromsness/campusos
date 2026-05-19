import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SisAdvancedController } from '@modules/m20-sis/students/sis-advanced.controller';
import { StudentProfileService } from '@modules/m20-sis/students/student-profile.service';
import { CustomFieldService } from '@modules/m20-sis/custom-fields/custom-field.service';
import { ParentUpdateService } from '@modules/m20-sis/guardians/parent-update.service';
import { StudentNoteService } from '@modules/m20-sis/notes/student-note.service';
import { FamilyRelationshipService } from '@modules/m20-sis/family/family-relationship.service';
import { AttendanceController } from '@modules/m20-sis/attendance/attendance.controller';
import { AttendanceService } from '@modules/m20-sis/attendance/attendance.service';
import { AbsenceRequestService } from '@modules/m20-sis/attendance/absence-request.service';
import { StudentService } from '@modules/m20-sis/students/student.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID, TEST_SIS_FAMILY_ID } from '../fixtures/sis';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  cleanupSeededIds,
} from './sis-helpers';
import { makeRecordingKafka } from '../helpers/recording-kafka';

/**
 * Wave 4 — m20-sis SisAdvancedController + AttendanceController.
 *
 * Drives every controller endpoint at least once so the controllers move
 * from 0% to ≥80% coverage. Service-level contracts remain covered by
 * student-profile.spec, custom-fields.spec, attendance.spec etc.
 */
describe('integration:m20-sis/sis-advanced-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let outbox: OutboxService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let profileService: StudentProfileService;
  let customFieldService: CustomFieldService;
  let parentUpdateService: ParentUpdateService;
  let studentNoteService: StudentNoteService;
  let familyRelService: FamilyRelationshipService;
  let attendanceService: AttendanceService;
  let absenceService: AbsenceRequestService;
  let studentService: StudentService;
  let sisAdvanced: SisAdvancedController;
  let attendanceController: AttendanceController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    outbox = new OutboxService();
    kafka = makeRecordingKafka();

    profileService = new StudentProfileService(tenantPrisma, permCheck, outbox);
    customFieldService = new CustomFieldService(tenantPrisma, permCheck);
    parentUpdateService = new ParentUpdateService(tenantPrisma, permCheck, outbox);
    studentNoteService = new StudentNoteService(tenantPrisma, permCheck);
    familyRelService = new FamilyRelationshipService(tenantPrisma, permCheck);
    attendanceService = new AttendanceService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    absenceService = new AbsenceRequestService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
    studentService = new StudentService(tenantPrisma);

    sisAdvanced = new SisAdvancedController(
      profileService,
      customFieldService,
      parentUpdateService,
      studentNoteService,
      familyRelService,
      actorContext,
    );
    attendanceController = new AttendanceController(
      attendanceService,
      absenceService,
      studentService,
      actorContext,
    );

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
               ARRAY['sch-001:admin','stu-001:read','stu-001:write','stu-002:read','stu-002:write','stu-002:admin','att-001:read','att-001:write','att-004:read','att-004:write','att-004:admin']::text[],
               now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe rows that this spec creates.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_custom_field_values`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_custom_field_definitions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_auto_approval_rules`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_parent_info_update_requests`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_notes`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_family_relationships`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_profiles`,
    );
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.sis_attendance_records CASCADE`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_absence_requests`,
    );
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

  // ─── SisAdvancedController: Student Profile ─────────────────────────

  describe('SisAdvanced — student profile', () => {
    it('getProfile creates an empty row on first read', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        sisAdvanced.getProfile(s.studentId, fakeAdminReq()),
      );
      expect(profile.studentId).toBe(s.studentId);
    });

    it('updateProfile sets editable fields', async () => {
      const s = await trackedStudent();
      const updated = await withTestTenant(async () =>
        sisAdvanced.updateProfile(
          s.studentId,
          { motto: 'Carpe Diem' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.motto).toBe('Carpe Diem');
    });

    it('uploadAvatar + listPendingAvatars + reviewAvatar round-trips', async () => {
      const s = await trackedStudent();
      const uploaded = await withTestTenant(async () =>
        sisAdvanced.uploadAvatar(
          s.studentId,
          { s3Key: 'avatars/foo.png' } as any,
          fakeAdminReq(),
        ),
      );
      expect(uploaded.avatarStatus).toBe('PENDING_APPROVAL');

      const pending = await withTestTenant(async () =>
        sisAdvanced.listPendingAvatars(fakeAdminReq()),
      );
      expect(pending.map((p) => p.studentId)).toContain(s.studentId);

      const reviewed = await withTestTenant(async () =>
        sisAdvanced.reviewAvatar(
          uploaded.id,
          { decision: 'APPROVED' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reviewed.avatarStatus).toBe('APPROVED');
    });
  });

  // ─── SisAdvanced: Custom Fields ─────────────────────────────────────

  describe('SisAdvanced — custom fields', () => {
    it('create + list + patch + value upsert + listValuesForEntity', async () => {
      const fieldName = 'extra_' + Date.now();
      const def = await withTestTenant(async () =>
        sisAdvanced.createCustomField(
          {
            entityType: 'STUDENT',
            fieldName,
            fieldLabel: 'Extra Field',
            fieldType: 'TEXT',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(def.fieldName).toBe(fieldName);

      const list = await withTestTenant(async () =>
        sisAdvanced.listCustomFields('STUDENT', undefined),
      );
      expect(list.map((d) => d.id)).toContain(def.id);

      const listInactive = await withTestTenant(async () =>
        sisAdvanced.listCustomFields('STUDENT', 'true'),
      );
      expect(Array.isArray(listInactive)).toBe(true);

      const patched = await withTestTenant(async () =>
        sisAdvanced.patchCustomField(
          def.id,
          { fieldLabel: 'Renamed Label' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.fieldLabel).toBe('Renamed Label');

      const student = await trackedStudent();
      const upserted = await withTestTenant(async () =>
        sisAdvanced.upsertCustomFieldValues(
          {
            entityType: 'STUDENT',
            entityId: student.studentId,
            values: [{ definitionId: def.id, value: 'hello world' }],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(Array.isArray(upserted)).toBe(true);

      const values = await withTestTenant(async () =>
        sisAdvanced.listCustomFieldValues('STUDENT', student.studentId, fakeAdminReq()),
      );
      expect(values.map((v) => v.definitionId)).toContain(def.id);
    });
  });

  // ─── SisAdvanced: Parent Update Requests ────────────────────────────

  describe('SisAdvanced — parent update requests', () => {
    it('submit + list + get + review round-trip (admin on behalf)', async () => {
      const s = await trackedStudent();
      const submitted = await withTestTenant(async () =>
        sisAdvanced.submitParentUpdate(
          {
            targetType: 'STUDENT_INFO',
            targetId: s.studentId,
            proposedChanges: { firstName: 'Updated' },
            changeReason: 'Test update',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(submitted.targetId).toBe(s.studentId);

      const list = await withTestTenant(async () =>
        sisAdvanced.listParentUpdates(fakeAdminReq(), undefined),
      );
      expect(list.map((r) => r.id)).toContain(submitted.id);

      const listFiltered = await withTestTenant(async () =>
        sisAdvanced.listParentUpdates(fakeAdminReq(), 'PENDING'),
      );
      expect(Array.isArray(listFiltered)).toBe(true);

      const single = await withTestTenant(async () =>
        sisAdvanced.getParentUpdate(submitted.id, fakeAdminReq()),
      );
      expect(single.id).toBe(submitted.id);

      const reviewed = await withTestTenant(async () =>
        sisAdvanced.reviewParentUpdate(
          submitted.id,
          { decision: 'REJECTED', reviewerNotes: 'No thanks' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reviewed.status).toBe('REJECTED');
    });

    it('listAutoApprovalRules + upsertAutoApprovalRule', async () => {
      const rule = await withTestTenant(async () =>
        sisAdvanced.upsertAutoApprovalRule(
          { targetType: 'STUDENT_INFO', fieldName: 'phone', autoApprove: true } as any,
          fakeAdminReq(),
        ),
      );
      expect(rule.fieldName).toBe('phone');

      const list = await withTestTenant(async () => sisAdvanced.listAutoApprovalRules());
      expect(list.map((r) => r.fieldName)).toContain('phone');
    });
  });

  // ─── SisAdvanced: Student Notes ─────────────────────────────────────

  describe('SisAdvanced — student notes', () => {
    it('list + create + delete a student note', async () => {
      const s = await trackedStudent();
      const note = await withTestTenant(async () =>
        sisAdvanced.createStudentNote(
          s.studentId,
          {
            noteType: 'ACADEMIC',
            noteText: 'A note',
            isVisibleToParent: false,
            isConfidential: false,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(note.studentId).toBe(s.studentId);

      const list = await withTestTenant(async () =>
        sisAdvanced.listStudentNotes(s.studentId, fakeAdminReq()),
      );
      expect(list.map((n) => n.id)).toContain(note.id);

      const deleted = await withTestTenant(async () =>
        sisAdvanced.deleteStudentNote(note.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });

  // ─── SisAdvanced: Family Relationships ──────────────────────────────

  describe('SisAdvanced — family relationships', () => {
    it('create + list + patch + delete a family relationship', async () => {
      // Two guardians in the same family for the relationship to span.
      const familyId = TEST_SIS_FAMILY_ID;
      const gA = await trackedGuardian({ familyId, firstName: 'A', lastName: 'One' });
      const gB = await trackedGuardian({ familyId, firstName: 'B', lastName: 'Two' });

      const created = await withTestTenant(async () =>
        sisAdvanced.createFamilyRelationship(
          {
            familyId,
            guardianAId: gA.guardianId,
            guardianBId: gB.guardianId,
            relationshipType: 'MARRIED',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.guardianAId).toBe(gA.guardianId);

      const list = await withTestTenant(async () =>
        sisAdvanced.listFamilyRelationships(familyId),
      );
      expect(list.map((r) => r.id)).toContain(created.id);

      const patched = await withTestTenant(async () =>
        sisAdvanced.patchFamilyRelationship(
          created.id,
          { notes: 'Updated note' } as any,
          fakeAdminReq(),
        ),
      );
      expect(patched.notes).toBe('Updated note');

      const deleted = await withTestTenant(async () =>
        sisAdvanced.deleteFamilyRelationship(created.id, fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });
  });

  // ─── AttendanceController ───────────────────────────────────────────

  describe('AttendanceController', () => {
    it('classAttendance (read empty), batchSubmit, markOne, studentAttendance', async () => {
      const student = await trackedStudent();
      // Active enrollment for the student in the test class.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        generateId(),
        student.studentId,
        TEST_SIS_CLASS_ID,
      );

      const date = '2026-09-14';
      // Read class attendance (admin sees all rows; period=null returns nothing yet).
      const empty = await withTestTenant(async () =>
        attendanceController.classAttendance(
          TEST_SIS_CLASS_ID,
          date,
          {} as any,
          fakeAdminReq(),
        ),
      );
      expect(Array.isArray(empty)).toBe(true);

      // Batch submit — pre-populates all roster rows + marks an exception.
      const result = await withTestTenant(async () =>
        attendanceController.batchSubmit(
          TEST_SIS_CLASS_ID,
          date,
          {
            period: 'P1',
            records: [
              { studentId: student.studentId, status: 'TARDY', note: 'Late bus' },
            ],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(typeof result.totalStudents).toBe('number');

      // After batch, the student now has a row. Mark individually.
      const rec = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.sis_attendance_records
           WHERE class_id = $1::uuid AND date = $2::date AND student_id = $3::uuid LIMIT 1`,
        TEST_SIS_CLASS_ID,
        date,
        student.studentId,
      )) as Array<{ id: string }>;
      if (rec.length > 0) {
        const marked = await withTestTenant(async () =>
          attendanceController.markOne(
            rec[0]!.id,
            { status: 'PRESENT' } as any,
            fakeAdminReq(),
          ),
        );
        expect(marked.status).toBe('PRESENT');
      }

      // Per-student attendance history.
      const history = await withTestTenant(async () =>
        attendanceController.studentAttendance(
          student.studentId,
          {} as any,
          fakeAdminReq(),
        ),
      );
      expect(Array.isArray(history)).toBe(true);
    });

    it('classAttendance with period parameter (lazy pre-populate)', async () => {
      const student = await trackedStudent();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')
         ON CONFLICT DO NOTHING`,
        generateId(),
        student.studentId,
        TEST_SIS_CLASS_ID,
      );
      const list = await withTestTenant(async () =>
        attendanceController.classAttendance(
          TEST_SIS_CLASS_ID,
          '2026-09-15',
          { period: 'P2' } as any,
          fakeAdminReq(),
        ),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('absence-request submit + list + get + review', async () => {
      const student = await trackedStudent();
      const submitted = await withTestTenant(async () =>
        attendanceController.submitAbsence(
          {
            studentId: student.studentId,
            absenceDateFrom: '2026-09-20',
            absenceDateTo: '2026-09-20',
            requestType: 'SAME_DAY_REPORT',
            reasonCategory: 'ILLNESS',
            reasonText: 'Cold',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(submitted.studentId).toBe(student.studentId);

      const list = await withTestTenant(async () =>
        attendanceController.listAbsences({} as any, fakeAdminReq()),
      );
      expect(list.map((r) => r.id)).toContain(submitted.id);

      const single = await withTestTenant(async () =>
        attendanceController.getAbsence(submitted.id, fakeAdminReq()),
      );
      expect(single.id).toBe(submitted.id);

      // Only PENDING requests can be reviewed; SAME_DAY_REPORT auto-approves.
      // Create an ADVANCE_REQUEST to exercise the review path.
      const pending = await withTestTenant(async () =>
        attendanceController.submitAbsence(
          {
            studentId: student.studentId,
            absenceDateFrom: '2026-10-05',
            absenceDateTo: '2026-10-06',
            requestType: 'ADVANCE_REQUEST',
            reasonCategory: 'FAMILY_EMERGENCY',
            reasonText: 'Wedding',
          } as any,
          fakeAdminReq(),
        ),
      );
      const reviewed = await withTestTenant(async () =>
        attendanceController.reviewAbsence(
          pending.id,
          { decision: 'APPROVED' } as any,
          fakeAdminReq(),
        ),
      );
      expect(reviewed.status).toBe('APPROVED');
    });
  });
});
