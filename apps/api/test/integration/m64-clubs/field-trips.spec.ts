import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { FieldTripService } from '@modules/m64-clubs/field-trips/field-trip.service';
import { ConsentService } from '@modules/m64-clubs/field-trips/consent.service';
import { ChaperoneService } from '@modules/m64-clubs/field-trips/chaperone.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { seedStudent, ensureGuardianForPerson, linkStudentGuardian } from '../m20-sis/sis-helpers';
import { resetClubsAndStudents, ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m64-clubs field-trips suite. Verifies:
 *   - CRUD + status transitions + max_participants cap.
 *   - PARENT CONSENT KEYSTONE end-to-end (guardian link validation,
 *     ext_field_trip_consent_records row, ext.consent.received Kafka).
 *   - Chaperone soft FK validation (hr_employees OR sis_guardians).
 *   - Guardian list row-scope + BLOCKING 3 visibility on participants
 *     and chaperones.
 *   - Cross-school isolation.
 */
describe('integration:m64-clubs/field-trips', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let fieldTrips: FieldTripService;
  let consent: ConsentService;
  let chaperones: ChaperoneService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const k = makeRecordingKafka();
    kafka = k as unknown as RecordingKafkaProducer;
    fieldTrips = new FieldTripService(tenantPrisma);
    consent = new ConsentService(tenantPrisma, k);
    chaperones = new ChaperoneService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetClubsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    kafka.reset();
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Create a fresh field trip seed using a raw insert so tests can
   * control status/max_participants/etc directly. Returns the id.
   */
  async function seedTrip(opts: {
    schoolId: string;
    status?: string;
    maxParticipants?: number | null;
    title?: string;
  }): Promise<string> {
    const rows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.ext_field_trips
         (id, school_id, title, description, destination, trip_date, max_participants, organiser_id, status, consent_deadline)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'D', 'Museum', '2027-06-01', $3, $4::uuid, $5, '2027-05-25')
       RETURNING id::text AS id`,
      opts.schoolId,
      opts.title ?? 'Spring Trip',
      opts.maxParticipants ?? null,
      TEST_ADMIN_EMPLOYEE_ID,
      opts.status ?? 'PLANNING',
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // FieldTripService CRUD + status transitions
  // ─────────────────────────────────────────────────────────────────
  describe('FieldTripService — CRUD', () => {
    it('create: admin succeeds', async () => {
      const dto = await withTestTenant(async () =>
        fieldTrips.create(
          {
            title: 'Zoo Trip',
            destination: 'Zoo',
            tripDate: '2027-05-10',
            departureTime: '09:00',
            returnTime: '15:00',
            gradeLevels: ['5', '6'],
            maxParticipants: 20,
            costPerStudent: 12.5,
            consentDeadline: '2027-05-01',
            description: 'Annual zoo trip',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Zoo Trip');
      expect(dto.costPerStudent).toBe(12.5);
      expect(dto.status).toBe('PLANNING');
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          fieldTrips.create(
            { title: 'X', destination: 'Y', tripDate: '2027-05-01' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: admin without employeeId → BadRequestException', async () => {
      const ghost: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () =>
          fieldTrips.create({ title: 'X', destination: 'Y', tripDate: '2027-05-01' } as any, ghost),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list: admin sees school A trips, not School B', async () => {
      const a = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const b = await seedTrip({ schoolId: TEST_SCHOOL_B_ID });
      const listA = await withTestTenant(async () => fieldTrips.list(adminActor()));
      expect(listA.map((t) => t.id)).toContain(a);
      expect(listA.map((t) => t.id)).not.toContain(b);
    });

    it('list: parent without children → []', async () => {
      await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const list = await withTestTenant(async () => fieldTrips.list(parentActor()));
      expect(list).toEqual([]);
    });

    it('list: parent sees trips containing their children only', async () => {
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const stu = await trackedSeedStudent({ firstName: 'Kid', lastName: 'X' });
      await linkStudentGuardian(rawClient, stu.studentId, guardianId);

      const tripWithChild = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const tripWithoutChild = await seedTrip({ schoolId: TEST_SCHOOL_ID, title: 'Other' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripWithChild,
        stu.studentId,
      );
      // Other trip — unrelated student
      const other = await trackedSeedStudent({ firstName: 'O' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripWithoutChild,
        other.studentId,
      );
      const list = await withTestTenant(async () => fieldTrips.list(parentActor()));
      const ids = list.map((t) => t.id);
      expect(ids).toContain(tripWithChild);
      expect(ids).not.toContain(tripWithoutChild);
    });

    it('list: student (non-staff non-guardian) → []', async () => {
      await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const list = await withTestTenant(async () => fieldTrips.list(studentActor()));
      expect(list).toEqual([]);
    });

    it('getById admin: returns trip with participants + chaperones inlined', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const stu = await trackedSeedStudent();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripId,
        stu.studentId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_chaperones (id, field_trip_id, person_id, role)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'CHAPERONE')`,
        tripId,
        TEST_PARENT_PERSON_ID,
      );
      // Ensure the parent person has a guardian row so the soft check works
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);

      const dto = await withTestTenant(async () => fieldTrips.getById(tripId, adminActor()));
      expect(dto.participants?.length).toBe(1);
      expect(dto.chaperones?.length).toBe(1);
    });

    it('getById: guardian sees own child only + no chaperones (BLOCKING 3)', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const ownKid = await trackedSeedStudent({ firstName: 'Mine' });
      await linkStudentGuardian(rawClient, ownKid.studentId, guardianId);
      const otherKid = await trackedSeedStudent({ firstName: 'Other' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid),
                (gen_random_uuid(), $1::uuid, $3::uuid)`,
        tripId,
        ownKid.studentId,
        otherKid.studentId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_chaperones (id, field_trip_id, person_id, role)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'CHAPERONE')`,
        tripId,
        TEST_PARENT_PERSON_ID,
      );
      const dto = await withTestTenant(async () => fieldTrips.getById(tripId, parentActor()));
      // Only own child visible
      expect(dto.participants?.length).toBe(1);
      expect(dto.participants![0]!.studentId).toBe(ownKid.studentId);
      // Chaperones stripped for guardians
      expect(dto.chaperones).toEqual([]);
    });

    it('getById: guardian without linked child on trip → NotFoundException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);
      await expect(
        withTestTenant(async () => fieldTrips.getById(tripId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: student (non-staff non-guardian) → NotFoundException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await expect(
        withTestTenant(async () => fieldTrips.getById(tripId, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          fieldTrips.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: admin updates status, title, destination, tripDate, maxParticipants, description', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID, status: 'PLANNING' });
      const dto = await withTestTenant(async () =>
        fieldTrips.patch(
          tripId,
          {
            status: 'APPROVED',
            title: 'New',
            destination: 'New Dest',
            tripDate: '2027-06-30',
            maxParticipants: 30,
            description: 'Updated',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('APPROVED');
      expect(dto.title).toBe('New');
      expect(dto.destination).toBe('New Dest');
    });

    it('patch: noop returns getById', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const dto = await withTestTenant(async () =>
        fieldTrips.patch(tripId, {} as any, adminActor()),
      );
      expect(dto.id).toBe(tripId);
    });

    it('patch: student → ForbiddenException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await expect(
        withTestTenant(async () =>
          fieldTrips.patch(tripId, { status: 'APPROVED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          fieldTrips.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'APPROVED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // FieldTripService.addParticipant — cap + uniqueness
  // ─────────────────────────────────────────────────────────────────
  describe('addParticipant', () => {
    it('admin adds participant', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const stu = await trackedSeedStudent();
      const part = await withTestTenant(async () =>
        fieldTrips.addParticipant(tripId, { studentId: stu.studentId } as any, adminActor()),
      );
      expect(part.studentId).toBe(stu.studentId);
      expect(part.attendanceStatus).toBe('REGISTERED');
    });

    it('student → ForbiddenException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          fieldTrips.addParticipant(tripId, { studentId: stu.studentId } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing trip → NotFoundException', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          fieldTrips.addParticipant(
            '00000000-0000-0000-0000-000000000000',
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('max cap → BadRequestException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID, maxParticipants: 1 });
      const stu1 = await trackedSeedStudent({ firstName: 'A' });
      const stu2 = await trackedSeedStudent({ firstName: 'B' });
      await withTestTenant(async () =>
        fieldTrips.addParticipant(tripId, { studentId: stu1.studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          fieldTrips.addParticipant(tripId, { studentId: stu2.studentId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate participant → BadRequestException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const stu = await trackedSeedStudent();
      await withTestTenant(async () =>
        fieldTrips.addParticipant(tripId, { studentId: stu.studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          fieldTrips.addParticipant(tripId, { studentId: stu.studentId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // FieldTripService.getConsentStatus — staff only
  // ─────────────────────────────────────────────────────────────────
  describe('getConsentStatus', () => {
    it('admin sees per-student consent state', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const stu = await trackedSeedStudent();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripId,
        stu.studentId,
      );
      const rows = await withTestTenant(async () =>
        fieldTrips.getConsentStatus(tripId, adminActor()),
      );
      expect(rows.length).toBe(1);
      expect(rows[0]!.studentId).toBe(stu.studentId);
      expect(rows[0]!.consentSigned).toBe(false);
    });

    it('parent → ForbiddenException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await expect(
        withTestTenant(async () => fieldTrips.getConsentStatus(tripId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ConsentService — PARENT CONSENT KEYSTONE
  // ─────────────────────────────────────────────────────────────────
  describe('ConsentService (PARENT CONSENT KEYSTONE)', () => {
    async function setupTripWithChild(): Promise<{
      tripId: string;
      studentId: string;
      guardianId: string;
    }> {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const stu = await trackedSeedStudent({ firstName: 'Mine' });
      await linkStudentGuardian(rawClient, stu.studentId, guardianId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripId,
        stu.studentId,
      );
      return { tripId, studentId: stu.studentId, guardianId };
    }

    it('sign: keystone end-to-end — writes consent + emits Kafka', async () => {
      const { tripId, studentId } = await setupTripWithChild();
      const dto = await withTestTenant(async () =>
        consent.sign(
          tripId,
          { studentId, consentGiven: true, notes: 'all good' } as any,
          '203.0.113.10',
          parentActor(),
        ),
      );
      expect(dto.consentGiven).toBe(true);
      expect(dto.guardianPersonId).toBe(TEST_PARENT_PERSON_ID);
      expect(dto.ipAddress).toBe('203.0.113.10');

      // Row exists
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT 1 FROM ${TEST_SCHEMA}.ext_field_trip_consent_records WHERE id = $1::uuid`,
        dto.id,
      )) as Array<unknown>;
      expect(rows.length).toBe(1);

      // Kafka emit
      const emits = kafka.callsForTopic('ext.consent.received');
      expect(emits.length).toBe(1);
      expect((emits[0]!.payload as any).fieldTripId).toBe(tripId);
      expect((emits[0]!.payload as any).studentId).toBe(studentId);
      expect((emits[0]!.payload as any).guardianPersonId).toBe(TEST_PARENT_PERSON_ID);
      expect((emits[0]!.payload as any).consentGiven).toBe(true);
    });

    it('sign: non-guardian → ForbiddenException', async () => {
      const { tripId, studentId } = await setupTripWithChild();
      await expect(
        withTestTenant(async () =>
          consent.sign(tripId, { studentId, consentGiven: true } as any, null, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('sign: trip missing → NotFoundException', async () => {
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);
      await expect(
        withTestTenant(async () =>
          consent.sign(
            '00000000-0000-0000-0000-000000000000',
            {
              studentId: '00000000-0000-0000-0000-000000000000',
              consentGiven: true,
            } as any,
            null,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sign: parent not linked to student → ForbiddenException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);
      const otherKid = await trackedSeedStudent({ firstName: 'NotMine' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_field_trip_participants (id, field_trip_id, student_id)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid)`,
        tripId,
        otherKid.studentId,
      );
      await expect(
        withTestTenant(async () =>
          consent.sign(
            tripId,
            { studentId: otherKid.studentId, consentGiven: true } as any,
            null,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('sign: student not a participant → BadRequestException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const stu = await trackedSeedStudent();
      await linkStudentGuardian(rawClient, stu.studentId, guardianId);
      // Note: not added as participant
      await expect(
        withTestTenant(async () =>
          consent.sign(
            tripId,
            { studentId: stu.studentId, consentGiven: true } as any,
            null,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sign: duplicate signature → BadRequestException via UNIQUE', async () => {
      const { tripId, studentId } = await setupTripWithChild();
      await withTestTenant(async () =>
        consent.sign(tripId, { studentId, consentGiven: true } as any, null, parentActor()),
      );
      await expect(
        withTestTenant(async () =>
          consent.sign(tripId, { studentId, consentGiven: false } as any, null, parentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sign: passes optional overrides + notes', async () => {
      const { tripId, studentId } = await setupTripWithChild();
      const dto = await withTestTenant(async () =>
        consent.sign(
          tripId,
          {
            studentId,
            consentGiven: true,
            emergencyContactOverride: 'Aunt Sue 555-0123',
            medicalNotesOverride: 'EpiPen in backpack',
            notes: 'all good',
          } as any,
          null,
          parentActor(),
        ),
      );
      expect(dto.emergencyContactOverride).toBe('Aunt Sue 555-0123');
      expect(dto.medicalNotesOverride).toBe('EpiPen in backpack');
      expect(dto.notes).toBe('all good');
    });

    it('getMyConsent: parent reads own', async () => {
      const { tripId, studentId } = await setupTripWithChild();
      await withTestTenant(async () =>
        consent.sign(tripId, { studentId, consentGiven: true } as any, null, parentActor()),
      );
      const got = await withTestTenant(async () =>
        consent.getMyConsent(tripId, studentId, parentActor()),
      );
      expect(got).not.toBeNull();
      expect(got!.consentGiven).toBe(true);
    });

    it('getMyConsent: no row → null', async () => {
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);
      const got = await withTestTenant(async () =>
        consent.getMyConsent(
          '00000000-0000-0000-0000-000000000000',
          '00000000-0000-0000-0000-000000000000',
          parentActor(),
        ),
      );
      expect(got).toBeNull();
    });

    it('getMyConsent: non-guardian → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          consent.getMyConsent(
            '00000000-0000-0000-0000-000000000000',
            '00000000-0000-0000-0000-000000000000',
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ChaperoneService — soft FK (hr_employees vs sis_guardians)
  // ─────────────────────────────────────────────────────────────────
  describe('ChaperoneService', () => {
    it('add: staff person id (admin employee) succeeds', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      // The admin actor has both an iam_person and an hr_employees row
      // — use that personId for the chaperone.
      const ap = (await rawClient.$queryRawUnsafe<Array<{ pid: string }>>(
        `SELECT person_id::text AS pid FROM ${TEST_SCHEMA}.hr_employees WHERE id = $1::uuid`,
        TEST_ADMIN_EMPLOYEE_ID,
      )) as Array<{ pid: string }>;
      const adminPersonId = ap[0]!.pid;
      const chap = await withTestTenant(async () =>
        chaperones.add(tripId, { personId: adminPersonId, role: 'LEAD' } as any, adminActor()),
      );
      expect(chap.role).toBe('LEAD');
      expect(chap.confirmed).toBe(false);
    });

    it('add: guardian person id succeeds via sis_guardians soft FK', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const chap = await withTestTenant(async () =>
        chaperones.add(
          tripId,
          { personId: TEST_PARENT_PERSON_ID, role: 'CHAPERONE' } as any,
          adminActor(),
        ),
      );
      expect(chap.role).toBe('CHAPERONE');
    });

    it('add: unknown personId (no hr_employees + no sis_guardians) → BadRequestException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      // Seed a person with no role in this tenant
      const orphanPerson = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES (gen_random_uuid(), 'Orphan', 'Person', 'STAFF', true)
         RETURNING id::text AS id`,
      )) as Array<{ id: string }>;
      personIds.push(orphanPerson[0]!.id);
      await expect(
        withTestTenant(async () =>
          chaperones.add(
            tripId,
            { personId: orphanPerson[0]!.id, role: 'CHAPERONE' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('add: student → ForbiddenException', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      await expect(
        withTestTenant(async () =>
          chaperones.add(
            tripId,
            { personId: TEST_PARENT_PERSON_ID, role: 'CHAPERONE' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('add: duplicate → BadRequestException via UNIQUE', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      await withTestTenant(async () =>
        chaperones.add(tripId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          chaperones.add(tripId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: admin updates background check + confirmed', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const chap = await withTestTenant(async () =>
        chaperones.add(tripId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      const patched = await withTestTenant(async () =>
        chaperones.patch(
          chap.id,
          { backgroundCheckStatus: 'CLEARED', confirmed: true } as any,
          adminActor(),
        ),
      );
      expect(patched.backgroundCheckStatus).toBe('CLEARED');
      expect(patched.confirmed).toBe(true);
    });

    it('patch: noop returns existing row', async () => {
      const tripId = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      const chap = await withTestTenant(async () =>
        chaperones.add(tripId, { personId: TEST_PARENT_PERSON_ID } as any, adminActor()),
      );
      const dto = await withTestTenant(async () =>
        chaperones.patch(chap.id, {} as any, adminActor()),
      );
      expect(dto.id).toBe(chap.id);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          chaperones.patch(
            '00000000-0000-0000-0000-000000000000',
            { confirmed: true } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          chaperones.patch(
            '00000000-0000-0000-0000-000000000000',
            { confirmed: true } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot list School B trips', async () => {
      const a = await seedTrip({ schoolId: TEST_SCHOOL_ID });
      const b = await seedTrip({ schoolId: TEST_SCHOOL_B_ID });
      const listA = await withTestTenant(async () => fieldTrips.list(adminActor()));
      expect(listA.map((t) => t.id)).toContain(a);
      expect(listA.map((t) => t.id)).not.toContain(b);
      const listB = await withTestTenantB(async () => fieldTrips.list(adminActor()));
      expect(listB.map((t) => t.id)).toContain(b);
      expect(listB.map((t) => t.id)).not.toContain(a);
    });
  });
});
