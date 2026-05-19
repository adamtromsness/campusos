import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { LockerService } from '@modules/m20-sis/lockers/locker.service';
import {
  decryptCombination,
  encryptCombination,
  generateCombination,
} from '@modules/m20-sis/lockers/locker-crypto';
import { TransferService } from '@modules/m20-sis/transfers/transfer.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  seedStudent,
  linkStudentGuardian,
  cleanupSeededIds,
  ensureGuardianForPerson,
} from './sis-helpers';

/**
 * Wave 4 — m20-sis LockerService + locker-crypto + TransferService
 *
 * Contracts:
 *   - locker-crypto: round-trip encrypt → decrypt; invalid wire → throws;
 *     null/empty plaintext rejected; generateCombination format
 *   - LockerService.create requires manager scope; UNIQUE(school_id, locker_number)
 *   - assign locks the row + flips status; combination returned exactly once
 *   - release / markOutOfService / markAvailable state-machine guards
 *   - bulkClear releases all ASSIGNED rows (optionally per academic_year)
 *   - getStudentLocker row-scope: STUDENT self, GUARDIAN linked, STAFF/admin
 *   - Cross-school locker UUID collapses to 404
 *   - TransferService: admin-only writes; INCOMING/OUTGOING shape enforcement;
 *     records-package patch + cross-school 404
 */
describe('integration:m20-sis/lockers-transfers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let lockerService: LockerService;
  let transferService: TransferService;

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
    lockerService = new LockerService(tenantPrisma, permCheck);
    transferService = new TransferService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    // Drop the platform_students row for TEST_STUDENT_PERSON_ID so a
    // following spec that re-creates the mapping doesn't hit a stale row.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN
         (SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_lockers`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_transfer_records`);
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

  async function mapStudentActorToRow(): Promise<string> {
    // platform_students.person_id is UNIQUE AND sis_students.platform_student_id
    // is UNIQUE. To remain deterministic across other specs that touch
    // TEST_STUDENT_PERSON_ID (e.g. attendance.spec.ts), nuke any prior
    // state for this person and re-seed fresh.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.sis_lockers SET status = 'AVAILABLE', assigned_to_student_id = NULL,
         assigned_at = NULL, academic_year = NULL, combination_encrypted = NULL
       WHERE assigned_to_student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN
         (SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );

    const platformStudentId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Self', 'Stud', true)`,
      platformStudentId,
      TEST_STUDENT_PERSON_ID,
    );
    platformStudentIds.push(platformStudentId);
    const studentId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '6', 'ENROLLED')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'SELF-' + studentId.slice(0, 8),
    );
    studentIds.push(studentId);
    return studentId;
  }

  // ============================================================
  // locker-crypto.ts
  // ============================================================
  describe('locker-crypto', () => {
    it('round-trip encrypt → decrypt restores plaintext', () => {
      const plaintext = '12-34-56';
      const wire = encryptCombination(plaintext);
      expect(wire.split('.')).toHaveLength(3);
      expect(decryptCombination(wire)).toBe(plaintext);
    });

    it('Empty plaintext → throws', () => {
      expect(() => encryptCombination('')).toThrow();
    });

    it('Null/empty wire → null', () => {
      expect(decryptCombination(null)).toBeNull();
      expect(decryptCombination('')).toBeNull();
      expect(decryptCombination(undefined)).toBeNull();
    });

    it('Invalid wire format → throws', () => {
      expect(() => decryptCombination('not-three-parts')).toThrow();
    });

    it('generateCombination produces NN-NN-NN with 00..49 segments', () => {
      for (let i = 0; i < 20; i += 1) {
        const c = generateCombination();
        expect(c).toMatch(/^\d{2}-\d{2}-\d{2}$/);
        for (const seg of c.split('-')) {
          const n = Number(seg);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(49);
        }
      }
    });
  });

  // ============================================================
  // LockerService
  // ============================================================
  describe('LockerService.create', () => {
    it('admin creates an AVAILABLE locker', async () => {
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-01', locationDescription: 'Hall A' }, adminActor()),
      );
      expect(locker.lockerNumber).toBe('A-01');
      expect(locker.status).toBe('AVAILABLE');
      expect(locker.hasCombination).toBe(false);
    });

    it('non-manager (parent) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          lockerService.create({ lockerNumber: 'A-02' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Empty lockerNumber → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => lockerService.create({ lockerNumber: '   ' }, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Duplicate locker_number for school → BadRequestException', async () => {
      await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'DUP-1' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.create({ lockerNumber: 'DUP-1' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('LockerService.list', () => {
    it('admin lists lockers in current school', async () => {
      await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'L-1' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'L-2' }, adminActor()),
      );
      const list = await withTestTenant(async () => lockerService.list({}, adminActor()));
      expect(list.map((l) => l.lockerNumber)).toEqual(expect.arrayContaining(['L-1', 'L-2']));
    });

    it('list filters by status', async () => {
      await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'L-X' }, adminActor()),
      );
      const list = await withTestTenant(async () =>
        lockerService.list({ status: 'AVAILABLE' }, adminActor()),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);
      const none = await withTestTenant(async () =>
        lockerService.list({ status: 'ASSIGNED' }, adminActor()),
      );
      expect(none).toHaveLength(0);
    });

    it('Invalid status → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          lockerService.list({ status: 'BOGUS' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => lockerService.list({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('LockerService.assign', () => {
    it('admin assigns a locker; combination returned exactly once', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-100' }, adminActor()),
      );
      const result = await withTestTenant(async () =>
        lockerService.assign(
          {
            lockerId: locker.id,
            studentId: s.studentId,
            academicYear: '2026-2027',
          },
          adminActor(),
        ),
      );
      expect(result.locker.status).toBe('ASSIGNED');
      expect(result.locker.assignedToStudentId).toBe(s.studentId);
      expect(result.combination).toMatch(/^\d{2}-\d{2}-\d{2}$/);
      expect(result.locker.hasCombination).toBe(true);
    });

    it('Assigning a provided combination round-trips through getStudentLocker', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-200' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          {
            lockerId: locker.id,
            studentId: s.studentId,
            academicYear: '2026-2027',
            combination: '11-22-33',
          },
          adminActor(),
        ),
      );
      const dto = await withTestTenant(async () =>
        lockerService.getStudentLocker(s.studentId, adminActor()),
      );
      expect(dto?.combination).toBe('11-22-33');
    });

    it('Already-ASSIGNED locker → BadRequestException', async () => {
      const s1 = await trackedStudent();
      const s2 = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-300' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: s1.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            { lockerId: locker.id, studentId: s2.studentId, academicYear: '2026' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OUT_OF_SERVICE locker cannot be assigned', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-301' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.markOutOfService(locker.id, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            { lockerId: locker.id, studentId: s.studentId, academicYear: '2026' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Missing academicYear → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            { lockerId: generateId(), studentId: s.studentId, academicYear: '' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Empty combination → BadRequestException', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-302' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            {
              lockerId: locker.id,
              studentId: s.studentId,
              academicYear: '2026',
              combination: '   ',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school student → BadRequestException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'A-X' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            { lockerId: locker.id, studentId: sB.studentId, academicYear: '2026' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school locker id → NotFoundException', async () => {
      const s = await trackedStudent();
      const lockerB = await withTestTenantB(async () =>
        lockerService.create({ lockerNumber: 'XS-B' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          lockerService.assign(
            { lockerId: lockerB.id, studentId: s.studentId, academicYear: '2026' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('LockerService.release', () => {
    it('admin releases an ASSIGNED locker', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'R-1' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: s.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      const released = await withTestTenant(async () =>
        lockerService.release(locker.id, adminActor()),
      );
      expect(released.status).toBe('AVAILABLE');
      expect(released.assignedToStudentId).toBeNull();
      expect(released.hasCombination).toBe(false);
    });

    it('Non-ASSIGNED locker release → BadRequestException', async () => {
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'R-2' }, adminActor()),
      );
      await expect(
        withTestTenant(async () => lockerService.release(locker.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => lockerService.release(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('LockerService.bulkClear', () => {
    it('bulkClear releases all ASSIGNED lockers', async () => {
      const s1 = await trackedStudent();
      const s2 = await trackedStudent();
      const l1 = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'BC-1' }, adminActor()),
      );
      const l2 = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'BC-2' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: l1.id, studentId: s1.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: l2.id, studentId: s2.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () => lockerService.bulkClear({}, adminActor()));
      expect(result.cleared).toBe(2);
      const list = await withTestTenant(async () =>
        lockerService.list({ status: 'AVAILABLE' }, adminActor()),
      );
      expect(list.length).toBeGreaterThanOrEqual(2);
    });

    it('bulkClear with academicYear narrows the scope', async () => {
      const s1 = await trackedStudent();
      const s2 = await trackedStudent();
      const l1 = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'BC-Y1' }, adminActor()),
      );
      const l2 = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'BC-Y2' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: l1.id, studentId: s1.studentId, academicYear: '2025-2026' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: l2.id, studentId: s2.studentId, academicYear: '2026-2027' },
          adminActor(),
        ),
      );
      const res = await withTestTenant(async () =>
        lockerService.bulkClear({ academicYear: '2025-2026' }, adminActor()),
      );
      expect(res.cleared).toBe(1);
    });

    it('bulkClear with no matches returns 0', async () => {
      const result = await withTestTenant(async () =>
        lockerService.bulkClear({ academicYear: '9999' }, adminActor()),
      );
      expect(result.cleared).toBe(0);
    });
  });

  describe('LockerService.markOutOfService / markAvailable', () => {
    it('admin marks AVAILABLE locker OUT_OF_SERVICE', async () => {
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'M-1' }, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        lockerService.markOutOfService(locker.id, adminActor()),
      );
      expect(updated.status).toBe('OUT_OF_SERVICE');
    });

    it('Cannot mark ASSIGNED locker OUT_OF_SERVICE', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'M-2' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: s.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => lockerService.markOutOfService(locker.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('markAvailable flips OUT_OF_SERVICE → AVAILABLE', async () => {
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'M-3' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.markOutOfService(locker.id, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        lockerService.markAvailable(locker.id, adminActor()),
      );
      expect(updated.status).toBe('AVAILABLE');
    });

    it('Cannot markAvailable a currently-ASSIGNED locker', async () => {
      const s = await trackedStudent();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'M-4' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: s.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => lockerService.markAvailable(locker.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('LockerService.getStudentLocker', () => {
    it('Student self-resolution returns the assigned locker with combination', async () => {
      const sid = await mapStudentActorToRow();
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'SL-1' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: sid, academicYear: '2026', combination: '07-14-21' },
          adminActor(),
        ),
      );
      const dto = await withTestTenant(
        async () => lockerService.getStudentLocker(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(dto?.combination).toBe('07-14-21');
    });

    it('Linked guardian sees own child locker', async () => {
      const s = await trackedStudent();
      const gid = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(gid);
      await linkStudentGuardian(rawClient, s.studentId, gid);
      const locker = await withTestTenant(async () =>
        lockerService.create({ lockerNumber: 'SL-G' }, adminActor()),
      );
      await withTestTenant(async () =>
        lockerService.assign(
          { lockerId: locker.id, studentId: s.studentId, academicYear: '2026' },
          adminActor(),
        ),
      );
      const dto = await withTestTenant(
        async () => lockerService.getStudentLocker(s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(dto?.lockerNumber).toBe('SL-G');
    });

    it('Unrelated student → NotFoundException', async () => {
      const other = await trackedStudent();
      await mapStudentActorToRow();
      await expect(
        withTestTenant(
          async () => lockerService.getStudentLocker(other.studentId, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Student with no assignment → null', async () => {
      const sid = await mapStudentActorToRow();
      const result = await withTestTenant(
        async () => lockerService.getStudentLocker(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(result).toBeNull();
    });
  });

  // ============================================================
  // TransferService
  // ============================================================
  describe('TransferService.create', () => {
    it('admin creates INCOMING transfer', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'Old School',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      expect(tr.transferDirection).toBe('INCOMING');
      expect(tr.recordsReceived).toBe(false);
      expect(tr.recordsSent).toBe(false);
    });

    it('admin creates OUTGOING transfer', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'OUTGOING',
            otherSchoolName: 'New School',
            transferDate: '2026-09-01',
            otherSchoolCountry: 'CA',
            otherSchoolContact: 'principal@new',
          },
          adminActor(),
        ),
      );
      expect(tr.transferDirection).toBe('OUTGOING');
    });

    it('non-staff → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transferService.create(
            {
              studentId: s.studentId,
              transferDirection: 'INCOMING',
              otherSchoolName: 'X',
              transferDate: '2026-09-01',
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Invalid direction → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          transferService.create(
            {
              studentId: s.studentId,
              transferDirection: 'SIDEWAYS' as 'INCOMING',
              otherSchoolName: 'X',
              transferDate: '2026-09-01',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school studentId → BadRequestException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          transferService.create(
            {
              studentId: sB.studentId,
              transferDirection: 'INCOMING',
              otherSchoolName: 'X',
              transferDate: '2026-09-01',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('TransferService.list / listForStudent / getById', () => {
    it('admin lists with direction + date filters', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'OldA',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'OUTGOING',
            otherSchoolName: 'NewB',
            transferDate: '2026-10-01',
          },
          adminActor(),
        ),
      );
      const incoming = await withTestTenant(async () =>
        transferService.list({ direction: 'INCOMING' }, adminActor()),
      );
      expect(incoming).toHaveLength(1);
      const inRange = await withTestTenant(async () =>
        transferService.list(
          { fromDate: '2026-09-15', toDate: '2026-10-31' },
          adminActor(),
        ),
      );
      expect(inRange).toHaveLength(1);
    });

    it('list rejects invalid direction value', async () => {
      await expect(
        withTestTenant(async () =>
          transferService.list({ direction: 'BAD' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listForStudent + getById succeed', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'X',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        transferService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(1);
      const dto = await withTestTenant(async () =>
        transferService.getById(tr.id, adminActor()),
      );
      expect(dto.id).toBe(tr.id);
    });

    it('getById unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => transferService.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('TransferService.patch', () => {
    it('Admin patches recordsReceived on INCOMING transfer', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'X',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        transferService.patch(
          tr.id,
          {
            recordsReceived: true,
            recordsPackageS3Key: 's3://records/x.pdf',
            notes: 'Got it',
          },
          adminActor(),
        ),
      );
      expect(patched.recordsReceived).toBe(true);
      expect(patched.recordsPackageS3Key).toBe('s3://records/x.pdf');
      expect(patched.notes).toBe('Got it');
    });

    it('INCOMING patch with recordsSent=true → BadRequestException', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'X',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          transferService.patch(tr.id, { recordsSent: true }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OUTGOING patch with recordsReceived=true → BadRequestException', async () => {
      const s = await trackedStudent();
      const tr = await withTestTenant(async () =>
        transferService.create(
          {
            studentId: s.studentId,
            transferDirection: 'OUTGOING',
            otherSchoolName: 'X',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          transferService.patch(tr.id, { recordsReceived: true }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Non-admin patch → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          transferService.patch(generateId(), { notes: 'x' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transferService.patch(generateId(), { notes: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('Cross-school transfer id → NotFoundException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const trB = await withTestTenantB(async () =>
        transferService.create(
          {
            studentId: sB.studentId,
            transferDirection: 'INCOMING',
            otherSchoolName: 'B',
            transferDate: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          transferService.patch(trB.id, { notes: 'fooA' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
