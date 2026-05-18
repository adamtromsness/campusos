import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHOOL_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * Wave 3 — DB-backed integration tests for HealthRecordService.
 *
 * Strategy doc Wave 3 headline contracts:
 *   - `hlth.allergy_alert.changed` outbox-in-tx: every health-record
 *     write that includes allergies emits the canonical envelope in the
 *     same tenant tx as the JSONB UPDATE (P2-H6 FIX 4 — safety-critical
 *     allergy alert cannot be dropped on a broker outage)
 *   - VIEW_RECORD audit log: every successful getFullRecord writes one
 *     hlth_health_access_log row in the same tx as the SELECT
 *   - Tenant + row scope: nurse/admin → all students; STAFF (teacher)
 *     → only students in their classes; GUARDIAN → only their own
 *     children via GuardianAuthorizationService.canViewHealthRecord
 *
 * Codex review FIX 7 disposition: `msg.message.posted` is owned
 * exclusively by m40-communications (MessageService.create — see
 * `apps/api/src/modules/m40-communications/messaging/message.service.ts:212`).
 * No m23-health service emits this event. `grep -rn
 * "msg\.message\.posted" apps/api/src/modules/m23-health/` returns
 * zero matches, and the surrounding m40 emit + consumer pair
 * (MessageNotificationConsumer, TranslationConsumer, ModerationConsumer)
 * all belong to Wave 5 (communications). The fix Codex flagged
 * therefore lands when Wave 5 builds m40 coverage; it is intentionally
 * skipped here per their own guidance:
 *   "If this event only belongs to m40-communications (Wave 5),
 *    skip this fix and add a comment noting it's Wave 5 scope."
 */
describe('integration:m23-health/health-records', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let guardianAuthz: GuardianAuthorizationService;
  let accessLog: HealthAccessLogService;
  let service: HealthRecordService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    accessLog = new HealthAccessLogService(tenantPrisma);
    service = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'HR-TEST-%')`,
    );
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'hlth.allergy_alert.changed' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      '019e0cf8-aaaa-7777-8888-000000000021', // TEST_OFFICER_ACCOUNT_ID
    );
  });

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'HR', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'HR', 'Student', true) ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'HR-TEST-' + studentId,
    );
    return studentId;
  }

  async function readAllergyOutbox() {
    return rawClient.$queryRawUnsafe<
      Array<{ topic: string; message_key: string; envelope: string }>
    >(
      `SELECT topic, message_key, envelope::text AS envelope
         FROM platform.platform_outbox
        WHERE topic = 'hlth.allergy_alert.changed' AND tenant_id = $1::uuid
        ORDER BY created_at`,
      TEST_SCHOOL_ID,
    );
  }

  async function readAccessLog(studentId: string) {
    return rawClient.$queryRawUnsafe<
      Array<{ accessed_by: string; access_type: string; student_id: string }>
    >(
      `SELECT accessed_by::text AS accessed_by, access_type, student_id::text AS student_id
         FROM ${TEST_SCHEMA}.hlth_health_access_log
        WHERE student_id = $1::uuid ORDER BY accessed_at`,
      studentId,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // create — nurse/admin only; UNIQUE per student
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates record with NO allergies → no outbox emit', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () => service.create(studentId, {}, adminActor()));
      const emits = await readAllergyOutbox();
      expect(emits).toHaveLength(0);
    });

    it('admin creates record WITH allergies → emits hlth.allergy_alert.changed in same tx', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        service.create(
          studentId,
          {
            allergies: [
              { allergen: 'peanut', severity: 'SEVERE', reaction: 'anaphylaxis' },
              { allergen: 'dairy', severity: 'MODERATE' },
            ],
          },
          adminActor(),
        ),
      );
      const emits = await readAllergyOutbox();
      expect(emits).toHaveLength(1);
      expect(emits[0]!.message_key).toBe(studentId);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('hlth.allergy_alert.changed');
      expect(envelope.payload.studentId).toBe(studentId);
      expect(envelope.payload.allergies).toHaveLength(2);
      expect(envelope.payload.allergies[0].allergen).toBe('peanut');
      expect(envelope.payload.allergies[0].severity).toBe('SEVERE');
      expect(envelope.payload.allergies[0].reaction).toBe('anaphylaxis');
      expect(envelope.payload.allergies[1].reaction).toBeNull();
    });

    it('create with empty allergies array → no outbox emit (length check)', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        service.create(studentId, { allergies: [] }, adminActor()),
      );
      expect(await readAllergyOutbox()).toHaveLength(0);
    });

    it('STAFF with hlt-001:write can create', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        '019e0cf8-aaaa-7777-8888-000000000021', // TEST_OFFICER_ACCOUNT_ID
        TEST_SCHOOL_SCOPE_ID,
        ['hlt-001:write'],
      );
      const studentId = await seedStudent();
      const result = await withTestTenant(async () =>
        service.create(studentId, {}, officerActor()),
      );
      expect(result.studentId).toBe(studentId);
    });

    it.each([
      ['officer (no hlt-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => service.create(studentId, {}, actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create against missing student → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            '00000000-0000-0000-0000-000000000000',
            {},
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('UNIQUE(student_id): second create rejected with BadRequest (use update)', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () => service.create(studentId, {}, adminActor()));
      await expect(
        withTestTenant(async () => service.create(studentId, {}, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update — hlth.allergy_alert.changed outbox-in-tx (KEYSTONE)
  // ────────────────────────────────────────────────────────────────────
  describe('update (allergy alert outbox-in-tx)', () => {
    async function seedRecord(): Promise<string> {
      const studentId = await seedStudent();
      await withTestTenant(async () => service.create(studentId, {}, adminActor()));
      return studentId;
    }

    it('update with allergies → emits hlth.allergy_alert.changed; payload contains the new list', async () => {
      const studentId = await seedRecord();
      await withTestTenant(async () =>
        service.update(
          studentId,
          { allergies: [{ allergen: 'shellfish', severity: 'SEVERE' }] },
          adminActor(),
        ),
      );
      const emits = await readAllergyOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.studentId).toBe(studentId);
      expect(envelope.payload.allergies[0].allergen).toBe('shellfish');
    });

    it('update with EMPTY allergies array → STILL emits (explicit reset, consumer needs to clear)', async () => {
      const studentId = await seedRecord();
      // Seed initial allergies
      await withTestTenant(async () =>
        service.update(
          studentId,
          { allergies: [{ allergen: 'peanut', severity: 'SEVERE' }] },
          adminActor(),
        ),
      );
      // Clear outbox + update with empty array
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_outbox WHERE topic = 'hlth.allergy_alert.changed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      await withTestTenant(async () =>
        service.update(studentId, { allergies: [] }, adminActor()),
      );
      const emits = await readAllergyOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.allergies).toEqual([]);
    });

    it('update WITHOUT allergies field → no outbox emit (only the touched fields update)', async () => {
      const studentId = await seedRecord();
      await withTestTenant(async () =>
        service.update(
          studentId,
          { bloodType: 'O+', emergencyMedicalNotes: 'asthmatic' },
          adminActor(),
        ),
      );
      const emits = await readAllergyOutbox();
      expect(emits).toHaveLength(0);
    });

    it('update non-existent record → NotFoundException rolls back the outbox row', async () => {
      // No record exists for this student yet
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          service.update(
            studentId,
            { allergies: [{ allergen: 'x', severity: 'MILD' }] },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // No outbox row should have landed (tx rolled back)
      expect(await readAllergyOutbox()).toHaveLength(0);
    });

    it('empty patch is a no-op (no outbox, no error)', async () => {
      const studentId = await seedRecord();
      const result = await withTestTenant(async () =>
        service.update(studentId, {}, adminActor()),
      );
      expect(result.studentId).toBe(studentId);
      expect(await readAllergyOutbox()).toHaveLength(0);
    });

    it.each([
      ['officer (no hlt-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('update as %s → ForbiddenException', async (_label, actor) => {
      const studentId = await seedRecord();
      await expect(
        withTestTenant(async () =>
          service.update(studentId, { bloodType: 'A+' }, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('outbox envelope tenant_id matches calling school + message_key = studentId', async () => {
      const studentId = await seedRecord();
      await withTestTenant(async () =>
        service.update(
          studentId,
          { allergies: [{ allergen: 'latex', severity: 'MODERATE' }] },
          adminActor(),
        ),
      );
      const emits = await readAllergyOutbox();
      expect(emits[0]!.message_key).toBe(studentId);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.tenant_id).toBe(TEST_SCHOOL_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getFullRecord — VIEW_RECORD audit log in same tx as the SELECT
  // ────────────────────────────────────────────────────────────────────
  describe('getFullRecord (VIEW_RECORD audit log)', () => {
    async function seedRecordWithAllergies(): Promise<string> {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        service.create(
          studentId,
          {
            bloodType: 'O+',
            allergies: [{ allergen: 'peanut', severity: 'SEVERE', reaction: 'anaphylaxis' }],
            emergencyMedicalNotes: 'EpiPen in nurse office',
          },
          adminActor(),
        ),
      );
      return studentId;
    }

    it('admin getFullRecord returns the record + writes VIEW_RECORD audit row', async () => {
      const studentId = await seedRecordWithAllergies();
      const result = await withTestTenant(async () =>
        service.getFullRecord(studentId, adminActor()),
      );
      expect(result.studentId).toBe(studentId);
      expect(result.bloodType).toBe('O+');
      expect(result.allergies).toHaveLength(1);
      expect(result.allergies[0]!.allergen).toBe('peanut');

      // Audit log row written
      const logs = await readAccessLog(studentId);
      const viewLogs = logs.filter((l) => l.access_type === 'VIEW_RECORD');
      expect(viewLogs.length).toBeGreaterThanOrEqual(1);
      expect(viewLogs[0]!.student_id).toBe(studentId);
    });

    it('getFullRecord with no record → 404', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () => service.getFullRecord(studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getFullRecord with non-existent student → 404', async () => {
      await expect(
        withTestTenant(async () =>
          service.getFullRecord('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['student', studentActor],
      ['teacher (no class link)', teacherActor],
    ])('getFullRecord as %s without class link → 404 (don\'t-leak-existence)', async (_label, actor) => {
      const studentId = await seedRecordWithAllergies();
      await expect(
        withTestTenant(async () => service.getFullRecord(studentId, actor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('every successful read writes a VIEW_RECORD audit row (multiple reads → multiple rows)', async () => {
      const studentId = await seedRecordWithAllergies();
      // service.create returns getFullRecord which writes one VIEW_RECORD row.
      // Truncate so we count only the explicit reads below.
      await rawClient.$executeRawUnsafe(
        `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
      );
      await withTestTenant(async () => service.getFullRecord(studentId, adminActor()));
      await withTestTenant(async () => service.getFullRecord(studentId, adminActor()));
      await withTestTenant(async () => service.getFullRecord(studentId, adminActor()));
      const logs = await readAccessLog(studentId);
      expect(logs.filter((l) => l.access_type === 'VIEW_RECORD').length).toBe(3);
    });

    it('audit row records the actor accountId', async () => {
      const studentId = await seedRecordWithAllergies();
      await withTestTenant(async () => service.getFullRecord(studentId, adminActor()));
      const logs = await readAccessLog(studentId);
      // TEST_ADMIN_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000011'
      expect(logs[0]!.accessed_by).toBe('019e0cf8-aaaa-7777-8888-000000000011');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getImmunisationCompliance — admin only
  // ────────────────────────────────────────────────────────────────────
  describe('getImmunisationCompliance (admin-only)', () => {
    it('admin can read', async () => {
      const result = await withTestTenant(async () =>
        service.getImmunisationCompliance(adminActor()),
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('non-admin %s → ForbiddenException', async (_label, actor) => {
      await expect(
        withTestTenant(async () => service.getImmunisationCompliance(actor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // hasNurseScope — auth probe surface
  // ────────────────────────────────────────────────────────────────────
  describe('hasNurseScope', () => {
    it('admin → true', async () => {
      await withTestTenant(async () => {
        expect(await service.hasNurseScope(adminActor())).toBe(true);
      });
    });

    it.each([
      ['officer (no hlt-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('%s → false', async (_label, actor) => {
      await withTestTenant(async () => {
        expect(await service.hasNurseScope(actor())).toBe(false);
      });
    });

    it('STAFF with hlt-001:write at SCHOOL scope → true', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_effective_access_cache
           (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
         ON CONFLICT (account_id, scope_id) DO UPDATE
           SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
        generateId(),
        '019e0cf8-aaaa-7777-8888-000000000021', // TEST_OFFICER_ACCOUNT_ID
        TEST_SCHOOL_SCOPE_ID,
        ['hlt-001:write'],
      );
      await withTestTenant(async () => {
        expect(await service.hasNurseScope(officerActor())).toBe(true);
      });
    });
  });
});
