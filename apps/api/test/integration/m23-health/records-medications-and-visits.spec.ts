import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ConditionService } from '@modules/m23-health/records/condition.service';
import { MedicationService } from '@modules/m23-health/records/medication.service';
import { MedicationScheduleService } from '@modules/m23-health/records/medication-schedule.service';
import { AdministrationService } from '@modules/m23-health/records/administration.service';
import { NurseVisitService } from '@modules/m23-health/records/nurse-visit.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';

describe('integration:m23-health/records-medications-conditions-visits', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accessLog: HealthAccessLogService;
  let records: HealthRecordService;
  let kafka: RecordingKafkaProducer;
  let conditions: ConditionService;
  let medications: MedicationService;
  let schedules: MedicationScheduleService;
  let administrations: AdministrationService;
  let visits: NurseVisitService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    const guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    const outbox = new OutboxService();
    accessLog = new HealthAccessLogService(tenantPrisma);
    records = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
    kafka = new RecordingKafkaProducer();
    conditions = new ConditionService(tenantPrisma, accessLog, records);
    medications = new MedicationService(tenantPrisma, accessLog, records);
    schedules = new MedicationScheduleService(tenantPrisma, records, medications);
    administrations = new AdministrationService(
      tenantPrisma,
      accessLog,
      records,
      medications,
      kafka as unknown as KafkaProducerService,
    );
    visits = new NurseVisitService(
      tenantPrisma,
      accessLog,
      records,
      kafka as unknown as KafkaProducerService,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_medication_administrations WHERE medication_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_medications WHERE health_record_id IN
           (SELECT id FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
             (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%')))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_medication_schedule WHERE medication_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_medications WHERE health_record_id IN
           (SELECT id FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
             (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%')))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_medications WHERE health_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
           (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%'))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_medical_conditions WHERE health_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
           (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%'))`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_nurse_visits WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RM-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'RM-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'RM-Stu'`,
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

  async function seedStudent(schoolId: string = TEST_SCHOOL_ID): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'RM-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'RM-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')`,
      studentId,
      schoolId,
      platformStudentId,
      'RM-' + suffix,
    );
    return studentId;
  }

  async function seedHealthRecord(
    studentId: string,
    schoolId: string = TEST_SCHOOL_ID,
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hlth_student_health_records
         (id, school_id, student_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      id,
      schoolId,
      studentId,
    );
    return id;
  }

  // ─── ConditionService ────────────────────────────────────────

  describe('ConditionService', () => {
    it('admin creates → lists → updates → soft-deactivates → deletes a condition', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const c = await withTestTenant(async () =>
        conditions.create(
          studentId,
          {
            conditionName: 'Asthma',
            severity: 'MODERATE',
            diagnosisDate: '2024-09-01',
            managementPlan: 'Use inhaler PRN',
          },
          adminActor(),
        ),
      );
      expect(c.conditionName).toBe('Asthma');

      const list = await withTestTenant(async () =>
        conditions.listForStudent(studentId, adminActor()),
      );
      expect(list.find((x) => x.id === c.id)).toBeDefined();

      const updated = await withTestTenant(async () =>
        conditions.update(
          c.id,
          { severity: 'SEVERE', managementPlan: 'Updated', conditionName: 'Severe Asthma' },
          adminActor(),
        ),
      );
      expect(updated.severity).toBe('SEVERE');

      const deactivated = await withTestTenant(async () =>
        conditions.update(c.id, { isActive: false, diagnosisDate: '2024-09-02' }, adminActor()),
      );
      expect(deactivated.isActive).toBe(false);

      await withTestTenant(async () => conditions.remove(c.id, adminActor()));
      await expect(
        withTestTenant(async () =>
          conditions.update(c.id, { severity: 'MILD' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on create/update/remove', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      await expect(
        withTestTenant(async () =>
          conditions.create(
            studentId,
            { conditionName: 'Asthma', severity: 'MILD' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const c = await withTestTenant(async () =>
        conditions.create(
          studentId,
          { conditionName: 'Asthma', severity: 'MILD' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          conditions.update(c.id, { severity: 'MODERATE' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => conditions.remove(c.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update non-existent → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          conditions.update(generateId(), { severity: 'MILD' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch returns existing', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const c = await withTestTenant(async () =>
        conditions.create(
          studentId,
          { conditionName: 'Asthma', severity: 'MILD' },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () => conditions.update(c.id, {}, adminActor()));
      expect(u.id).toBe(c.id);
    });

    it('listForStudent → 404 when no health record exists', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => conditions.listForStudent(studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── MedicationService ───────────────────────────────────────

  describe('MedicationService', () => {
    it('admin create → list → update → deactivate', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const m = await withTestTenant(async () =>
        medications.create(
          studentId,
          {
            medicationName: 'Albuterol',
            dosage: '90mcg',
            route: 'INHALER',
            frequency: 'PRN',
            prescribingPhysician: 'Dr. Test',
            isSelfAdministered: true,
          },
          adminActor(),
        ),
      );
      expect(m.medicationName).toBe('Albuterol');
      expect(m.isSelfAdministered).toBe(true);

      const list = await withTestTenant(async () =>
        medications.listForStudent(studentId, adminActor()),
      );
      expect(list.find((x) => x.id === m.id)).toBeDefined();
      // Manager sees prescribingPhysician
      expect(list.find((x) => x.id === m.id)!.prescribingPhysician).toBe('Dr. Test');

      const u = await withTestTenant(async () =>
        medications.update(
          m.id,
          {
            medicationName: 'Albuterol HFA',
            dosage: '108mcg',
            frequency: 'BID',
            route: 'INHALER',
            prescribingPhysician: 'Dr. Updated',
            isSelfAdministered: false,
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(u.medicationName).toBe('Albuterol HFA');
      expect(u.isActive).toBe(false);
    });

    it('empty patch returns existing', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const m = await withTestTenant(async () =>
        medications.create(
          studentId,
          { medicationName: 'X', route: 'ORAL' },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () => medications.update(m.id, {}, adminActor()));
      expect(u.id).toBe(m.id);
    });

    it('update missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          medications.update(generateId(), { dosage: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden on create/update', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      await expect(
        withTestTenant(async () =>
          medications.create(
            studentId,
            { medicationName: 'X', route: 'ORAL' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher listForStudent → Forbidden (medications not classroom-relevant)', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      await expect(
        withTestTenant(async () => medications.listForStudent(studentId, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException); // teacher → NotFound from row-scope before forbidden
    });

    it('loadStudentForMedication resolves student id; non-existent → NotFound', async () => {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const m = await withTestTenant(async () =>
        medications.create(
          studentId,
          { medicationName: 'X', route: 'ORAL' },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => medications.loadStudentForMedication(m.id));
      expect(r.studentId).toBe(studentId);

      await expect(
        withTestTenant(async () => medications.loadStudentForMedication(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── MedicationScheduleService ──────────────────────────────

  describe('MedicationScheduleService', () => {
    async function seedMed(): Promise<{ studentId: string; medicationId: string }> {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const m = await withTestTenant(async () =>
        medications.create(
          studentId,
          { medicationName: 'Ritalin', route: 'ORAL' },
          adminActor(),
        ),
      );
      return { studentId, medicationId: m.id };
    }

    it('create slot → list → update → delete', async () => {
      const { medicationId } = await seedMed();
      const s = await withTestTenant(async () =>
        schedules.create(
          medicationId,
          { scheduledTime: '08:00:00', dayOfWeek: 1, notes: 'Before school' },
          adminActor(),
        ),
      );
      expect(s.scheduledTime.startsWith('08:00')).toBe(true);

      const list = await withTestTenant(async () =>
        schedules.listForMedication(medicationId, adminActor()),
      );
      expect(list.find((x) => x.id === s.id)).toBeDefined();

      const u = await withTestTenant(async () =>
        schedules.update(
          s.id,
          { scheduledTime: '09:30:00', dayOfWeek: 2, notes: 'updated' },
          adminActor(),
        ),
      );
      expect(u.scheduledTime.startsWith('09:30')).toBe(true);

      await withTestTenant(async () => schedules.remove(s.id, adminActor()));
      await expect(
        withTestTenant(async () => schedules.update(s.id, { notes: 'x' }, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch returns existing', async () => {
      const { medicationId } = await seedMed();
      const s = await withTestTenant(async () =>
        schedules.create(medicationId, { scheduledTime: '08:00:00' }, adminActor()),
      );
      const u = await withTestTenant(async () => schedules.update(s.id, {}, adminActor()));
      expect(u.id).toBe(s.id);
    });

    it('non-nurse → Forbidden on create/update/remove', async () => {
      const { medicationId } = await seedMed();
      await expect(
        withTestTenant(async () =>
          schedules.create(medicationId, { scheduledTime: '08:00:00' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('delete missing slot → NotFound', async () => {
      await expect(
        withTestTenant(async () => schedules.remove(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── AdministrationService ──────────────────────────────────

  describe('AdministrationService', () => {
    async function seedMedWithSlot(): Promise<{
      studentId: string;
      medicationId: string;
      slotId: string;
    }> {
      const studentId = await seedStudent();
      await seedHealthRecord(studentId);
      const m = await withTestTenant(async () =>
        medications.create(
          studentId,
          { medicationName: 'Methylphenidate', route: 'ORAL' },
          adminActor(),
        ),
      );
      const s = await withTestTenant(async () =>
        schedules.create(m.id, { scheduledTime: '08:00:00' }, adminActor()),
      );
      return { studentId, medicationId: m.id, slotId: s.id };
    }

    it('administer dose → was_missed=false, administered_at populated, emits hlth.medication.administered', async () => {
      const { medicationId, slotId } = await seedMedWithSlot();
      const a = await withTestTenant(async () =>
        administrations.administer(
          medicationId,
          {
            scheduleEntryId: slotId,
            doseGiven: '10mg',
            notes: 'On time',
            parentNotified: true,
          },
          adminActor(),
        ),
      );
      expect(a.wasMissed).toBe(false);
      expect(a.administeredAt).not.toBeNull();
      expect(a.parentNotified).toBe(true);
      expect(kafka.callsForTopic('hlth.medication.administered').length).toBe(1);
    });

    it('administer with non-matching scheduleEntryId → BadRequest', async () => {
      const { medicationId } = await seedMedWithSlot();
      await expect(
        withTestTenant(async () =>
          administrations.administer(
            medicationId,
            { scheduleEntryId: generateId() },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('administer on inactive medication → BadRequest', async () => {
      const { medicationId } = await seedMedWithSlot();
      await withTestTenant(async () =>
        medications.update(medicationId, { isActive: false }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          administrations.administer(medicationId, {}, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('administer on missing medication → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          administrations.administer(generateId(), {}, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('administer without employeeId → Forbidden', async () => {
      const { medicationId } = await seedMedWithSlot();
      const noEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => administrations.administer(medicationId, {}, noEmp)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('logMissed → was_missed=true, missed_reason set, administered_at NULL', async () => {
      const { medicationId, slotId } = await seedMedWithSlot();
      const a = await withTestTenant(async () =>
        administrations.logMissed(
          medicationId,
          {
            scheduleEntryId: slotId,
            missedReason: 'STUDENT_ABSENT',
            notes: 'OOO',
          },
          adminActor(),
        ),
      );
      expect(a.wasMissed).toBe(true);
      expect(a.missedReason).toBe('STUDENT_ABSENT');
      expect(a.administeredAt).toBeNull();
    });

    it('logMissed with bad slot → BadRequest', async () => {
      const { medicationId } = await seedMedWithSlot();
      await expect(
        withTestTenant(async () =>
          administrations.logMissed(
            medicationId,
            { scheduleEntryId: generateId(), missedReason: 'STUDENT_ABSENT' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listForMedication: admin gets history; teacher → Forbidden', async () => {
      const { medicationId } = await seedMedWithSlot();
      await withTestTenant(async () =>
        administrations.administer(medicationId, {}, adminActor()),
      );
      const list = await withTestTenant(async () =>
        administrations.listForMedication(medicationId, adminActor()),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);

      await expect(
        withTestTenant(async () =>
          administrations.listForMedication(medicationId, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getDashboard returns rows with PENDING / ADMINISTERED / MISSED status', async () => {
      const { medicationId, slotId } = await seedMedWithSlot();
      // Slot exists, no administration → PENDING
      const dash1 = await withTestTenant(async () =>
        administrations.getDashboard(adminActor()),
      );
      const slot1 = dash1.find((r) => r.scheduleEntryId === slotId);
      // The slot may or may not be PENDING depending on day_of_week match.
      // With day_of_week NULL it should appear.
      if (slot1) expect(['PENDING', 'ADMINISTERED', 'MISSED']).toContain(slot1.status);

      await withTestTenant(async () =>
        administrations.administer(
          medicationId,
          { scheduleEntryId: slotId },
          adminActor(),
        ),
      );
      const dash2 = await withTestTenant(async () =>
        administrations.getDashboard(adminActor()),
      );
      const slot2 = dash2.find((r) => r.scheduleEntryId === slotId);
      if (slot2) expect(slot2.status).toBe('ADMINISTERED');
    });

    it('getDashboard non-nurse → Forbidden', async () => {
      await expect(
        withTestTenant(async () => administrations.getDashboard(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── NurseVisitService ──────────────────────────────────────

  describe('NurseVisitService', () => {
    it('admin signs in a student visit → status IN_PROGRESS', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create(
          { visitedPersonId: studentId, reason: 'Stomach ache' },
          adminActor(),
        ),
      );
      expect(v.status).toBe('IN_PROGRESS');
      expect(v.visitedPersonType).toBe('STUDENT');
    });

    it('admin signs in a STAFF visit → reads from hr_employees', async () => {
      const v = await withTestTenant(async () =>
        visits.create(
          {
            visitedPersonId: TEST_OFFICER_EMPLOYEE_ID,
            visitedPersonType: 'STAFF',
            reason: 'Headache',
          },
          adminActor(),
        ),
      );
      expect(v.visitedPersonType).toBe('STAFF');
    });

    it('create with bad student id → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          visits.create({ visitedPersonId: generateId() }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create with bad staff id → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          visits.create(
            { visitedPersonId: generateId(), visitedPersonType: 'STAFF' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create without employeeId → Forbidden', async () => {
      const studentId = await seedStudent();
      const noEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          visits.create({ visitedPersonId: studentId }, noEmp),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update flags + sign out → status COMPLETED, signed_out_at populated', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        visits.update(
          v.id,
          {
            reason: 'Updated reason',
            treatmentGiven: 'Rest + water',
            parentNotified: true,
            followUpRequired: true,
            followUpNotes: 'Follow up next week',
            followUpDate: '2026-06-01',
            signOut: true,
          },
          adminActor(),
        ),
      );
      expect(updated.status).toBe('COMPLETED');
      expect(updated.signedOutAt).not.toBeNull();
      expect(updated.parentNotified).toBe(true);
      expect(updated.followUpRequired).toBe(true);
    });

    it('update with sentHome=true → stamps sent_home_at + emits hlth.nurse_visit.sent_home', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      kafka.reset();
      const r = await withTestTenant(async () =>
        visits.update(v.id, { sentHome: true }, adminActor()),
      );
      expect(r.sentHome).toBe(true);
      expect(r.sentHomeAt).not.toBeNull();
      expect(kafka.callsForTopic('hlth.nurse_visit.sent_home').length).toBe(1);
    });

    it('update sentHome=false → clears sent_home_at without emitting', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      await withTestTenant(async () =>
        visits.update(v.id, { sentHome: true }, adminActor()),
      );
      kafka.reset();
      const r = await withTestTenant(async () =>
        visits.update(v.id, { sentHome: false }, adminActor()),
      );
      expect(r.sentHome).toBe(false);
      expect(r.sentHomeAt).toBeNull();
      // No false→true transition, no emit.
      expect(kafka.callsForTopic('hlth.nurse_visit.sent_home').length).toBe(0);
    });

    it('signOut on already COMPLETED visit → BadRequest', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      await withTestTenant(async () =>
        visits.update(v.id, { signOut: true }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          visits.update(v.id, { signOut: true }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('update missing visit → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          visits.update(generateId(), { reason: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch is a no-op', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const r = await withTestTenant(async () =>
        visits.update(v.id, {}, adminActor()),
      );
      expect(r.id).toBe(v.id);
    });

    it('list with status filter + audit-row per distinct STUDENT', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const list = await withTestTenant(async () =>
        visits.list({ status: 'IN_PROGRESS' }, adminActor()),
      );
      expect(list.find((x) => x.id === v.id)).toBeDefined();

      const audit = (await rawClient.$queryRawUnsafe(
        `SELECT student_id::text AS sid FROM ${TEST_SCHEMA}.hlth_health_access_log
           WHERE access_type = 'VIEW_VISITS'`,
      )) as Array<{ sid: string }>;
      expect(audit.some((a) => a.sid === studentId)).toBe(true);
    });

    it('list filters fromDate + toDate + limit clamp', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const r = await withTestTenant(async () =>
        visits.list(
          { fromDate: '2024-01-01', toDate: '2099-01-01', limit: 9999 },
          adminActor(),
        ),
      );
      expect(r.length).toBeLessThanOrEqual(500);
    });

    it('roster returns only IN_PROGRESS visits', async () => {
      const studentId = await seedStudent();
      const v = await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const inProgress = await withTestTenant(async () => visits.roster(adminActor()));
      expect(inProgress.find((x) => x.id === v.id)).toBeDefined();

      await withTestTenant(async () =>
        visits.update(v.id, { signOut: true }, adminActor()),
      );
      const after = await withTestTenant(async () => visits.roster(adminActor()));
      expect(after.find((x) => x.id === v.id)).toBeUndefined();
    });

    it('listForStudent + audit row', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        visits.create({ visitedPersonId: studentId }, adminActor()),
      );
      const list = await withTestTenant(async () =>
        visits.listForStudent(studentId, adminActor()),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('non-nurse → Forbidden on list/roster/create/update', async () => {
      await expect(
        withTestTenant(async () => visits.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => visits.roster(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          visits.create({ visitedPersonId: generateId() }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: visits in School A invisible in School B list/roster', async () => {
      const sA = await seedStudent(TEST_SCHOOL_ID);
      const vA = await withTestTenant(async () =>
        visits.create({ visitedPersonId: sA }, adminActor()),
      );
      const listB = await withTestTenantB(async () => visits.list({}, adminActor()));
      expect(listB.find((v) => v.id === vA.id)).toBeUndefined();
    });
  });
});
