import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { IepPlanService } from '@modules/m23-health/iep/iep-plan.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
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
 * Wave 3 — DB-backed integration tests for IepPlanService.
 *
 * Strategy doc Wave 3 headline contract:
 *   - `iep.accommodation.updated` outbox-in-tx: every accommodation
 *     INSERT/UPDATE/DELETE AND every plan UPDATE emits the snapshot in
 *     the SAME tenant transaction. Read model (sis_student_active_
 *     accommodations) cannot drift on a partial commit.
 *
 * Other strategy doc IEP contracts covered:
 *   - Auth gate: school admin OR hlt-001:write → allowed; others denied
 *   - Plan lifecycle: DRAFT default; UNIQUE non-EXPIRED per student
 *   - Accommodation shape: SPECIFIC requires specific_assignment_types,
 *     other applies_to values forbid them
 *   - EXPIRED plan → outbox snapshot has empty accommodations array
 *     (read model removes the rows)
 */
describe('integration:m23-health/iep-plans', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let guardianAuthz: GuardianAuthorizationService;
  let accessLog: HealthAccessLogService;
  let records: HealthRecordService;
  let service: IepPlanService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    accessLog = new HealthAccessLogService(tenantPrisma);
    records = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
    service = new IepPlanService(tenantPrisma, accessLog, records, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];

  beforeEach(async () => {
    // Wipe IEP rows (accommodations cascade delete from plans via FK)
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_iep_plans WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'IEP-TEST-%')`,
    );
    // Wipe access log rows so tests don't accumulate
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
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
    // Wipe outbox so per-test emit counts are deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    // Reset iam_effective_access_cache for the actors so auth seeding
    // is deterministic across tests
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      '019e0cf8-aaaa-7777-8888-000000000021', // TEST_OFFICER_ACCOUNT_ID
      '019e0cf8-aaaa-7777-8888-000000000031', // TEST_TEACHER_ACCOUNT_ID
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
       VALUES ($1::uuid, 'IEP', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'IEP', 'Student', true) ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'IEP-TEST-' + studentId,
    );
    return studentId;
  }

  async function readIepOutbox() {
    return rawClient.$queryRawUnsafe<
      Array<{ id: string; topic: string; message_key: string; envelope: string }>
    >(
      `SELECT id::text AS id, topic, message_key, envelope::text AS envelope
         FROM platform.platform_outbox
        WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid
        ORDER BY created_at`,
      TEST_SCHOOL_ID,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // create + getForStudent
  // ────────────────────────────────────────────────────────────────────
  describe('create + getForStudent', () => {
    it('admin creates DRAFT IEP plan + getForStudent returns it', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(
          studentId,
          { planType: 'IEP', startDate: '2026-09-01', reviewDate: '2027-03-01' },
          adminActor(),
        ),
      );
      expect(plan.status).toBe('DRAFT');
      expect(plan.planType).toBe('IEP');
      expect(plan.studentId).toBe(studentId);
      expect(plan.startDate).toBe('2026-09-01');

      const fetched = await withTestTenant(async () =>
        service.getForStudent(studentId, adminActor()),
      );
      expect(fetched?.id).toBe(plan.id);
    });

    it('create 504 plan', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: '504' }, adminActor()),
      );
      expect(plan.planType).toBe('504');
    });

    it('getForStudent returns null when no plan exists', async () => {
      const studentId = await seedStudent();
      const result = await withTestTenant(async () =>
        service.getForStudent(studentId, adminActor()),
      );
      expect(result).toBeNull();
    });

    it('UNIQUE: cannot create a second non-EXPIRED plan for the same student', async () => {
      const studentId = await seedStudent();
      await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.create(studentId, { planType: '504' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('after EXPIRING the first plan, a new plan CAN be created', async () => {
      const studentId = await seedStudent();
      const first = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      await withTestTenant(async () =>
        service.update(first.id, { status: 'EXPIRED' }, adminActor()),
      );
      const second = await withTestTenant(async () =>
        service.create(studentId, { planType: '504' }, adminActor()),
      );
      expect(second.planType).toBe('504');
      expect(second.id).not.toBe(first.id);
    });

    it('create against a non-existent student → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            '00000000-0000-0000-0000-000000000000',
            { planType: 'IEP' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['officer (no hlt-001:write)', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('create as %s → ForbiddenException', async (_label, actor) => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          service.create(studentId, { planType: 'IEP' }, actor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STAFF with hlt-001:write at SCHOOL scope can create', async () => {
      // Seed effective-access-cache row giving officer the nurse capability
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
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, officerActor()),
      );
      expect(plan.id).toBeDefined();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // KEYSTONE: iep.accommodation.updated outbox-in-tx
  // ────────────────────────────────────────────────────────────────────
  describe('iep.accommodation.updated outbox-in-tx (KEYSTONE Wave 3 contract)', () => {
    async function setupPlanForAccommodations(): Promise<{
      studentId: string;
      planId: string;
    }> {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      return { studentId, planId: plan.id };
    }

    it('addAccommodation: one outbox row emitted in the same tx; payload has the new row + plan context', async () => {
      const { studentId, planId } = await setupPlanForAccommodations();
      // No outbox row yet (create didn't emit; only plan UPDATE / accommodation mutations do)
      expect(await readIepOutbox()).toHaveLength(0);

      await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          {
            accommodationType: 'EXTRA_TIME',
            description: 'Time-and-a-half on tests',
            appliesTo: 'ALL_ASSESSMENTS',
          },
          adminActor(),
        ),
      );

      const emits = await readIepOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.event_type).toBe('iep.accommodation.updated');
      expect(envelope.payload.studentId).toBe(studentId);
      expect(envelope.payload.planId).toBe(planId);
      expect(envelope.payload.planType).toBe('IEP');
      expect(envelope.payload.planStatus).toBe('DRAFT');
      expect(envelope.payload.accommodations).toHaveLength(1);
      expect(envelope.payload.accommodations[0].accommodationType).toBe('EXTRA_TIME');
      expect(envelope.payload.accommodations[0].appliesTo).toBe('ALL_ASSESSMENTS');
    });

    it('updateAccommodation: emits a fresh snapshot reflecting the new value', async () => {
      const { planId } = await setupPlanForAccommodations();
      const acc = await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      // Reset outbox to focus on the UPDATE emit
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );

      await withTestTenant(async () =>
        service.updateAccommodation(
          acc.id,
          { description: 'Updated description' },
          adminActor(),
        ),
      );

      const emits = await readIepOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.accommodations[0].description).toBe('Updated description');
    });

    it('removeAccommodation: emits snapshot with the removed row absent (empty array)', async () => {
      const { planId } = await setupPlanForAccommodations();
      const acc = await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );

      await withTestTenant(async () => service.removeAccommodation(acc.id, adminActor()));

      const emits = await readIepOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.accommodations).toEqual([]);
    });

    it('plan UPDATE: emits snapshot (status change may affect read model visibility)', async () => {
      const { planId } = await setupPlanForAccommodations();
      await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          { accommodationType: 'PREFERENTIAL_SEATING', appliesTo: 'ALL_ASSIGNMENTS' },
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );

      // Flip ACTIVE — accommodation snapshot still emitted
      await withTestTenant(async () =>
        service.update(planId, { status: 'ACTIVE' }, adminActor()),
      );
      const emits = await readIepOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.planStatus).toBe('ACTIVE');
      expect(envelope.payload.accommodations).toHaveLength(1);
    });

    it('EXPIRED plan: snapshot has EMPTY accommodations (consumer drops the read model rows)', async () => {
      const { planId } = await setupPlanForAccommodations();
      await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_outbox WHERE topic = 'iep.accommodation.updated' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );

      await withTestTenant(async () =>
        service.update(planId, { status: 'EXPIRED' }, adminActor()),
      );
      const emits = await readIepOutbox();
      expect(emits).toHaveLength(1);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.payload.planStatus).toBe('EXPIRED');
      expect(envelope.payload.accommodations).toEqual([]);
    });

    it('outbox row tenant_id matches calling school + message_key = studentId', async () => {
      const { studentId, planId } = await setupPlanForAccommodations();
      await withTestTenant(async () =>
        service.addAccommodation(
          planId,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      const emits = await readIepOutbox();
      expect(emits[0]!.message_key).toBe(studentId);
      const envelope = JSON.parse(emits[0]!.envelope);
      expect(envelope.tenant_id).toBe(TEST_SCHOOL_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Accommodation shape validation
  // ────────────────────────────────────────────────────────────────────
  describe('accommodation shape validation', () => {
    it('SPECIFIC applies_to requires specific_assignment_types (non-empty)', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.addAccommodation(
            plan.id,
            {
              accommodationType: 'EXTRA_TIME',
              appliesTo: 'SPECIFIC',
              specificAssignmentTypes: null,
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ALL_ASSESSMENTS applies_to MUST NOT include specific_assignment_types', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.addAccommodation(
            plan.id,
            {
              accommodationType: 'EXTRA_TIME',
              appliesTo: 'ALL_ASSESSMENTS',
              specificAssignmentTypes: ['quiz'],
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SPECIFIC with non-empty list is accepted', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      const acc = await withTestTenant(async () =>
        service.addAccommodation(
          plan.id,
          {
            accommodationType: 'EXTRA_TIME',
            appliesTo: 'SPECIFIC',
            specificAssignmentTypes: ['exam', 'standardized_test'],
          },
          adminActor(),
        ),
      );
      expect(acc.appliesTo).toBe('SPECIFIC');
      expect(acc.specificAssignmentTypes).toEqual(['exam', 'standardized_test']);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Auth gates on accommodation mutations
  // ────────────────────────────────────────────────────────────────────
  describe('accommodation auth gates', () => {
    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['student', studentActor],
      ['parent', parentActor],
    ])('addAccommodation as %s → ForbiddenException', async (_label, actor) => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          service.addAccommodation(
            plan.id,
            { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
            actor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update accommodation as non-nurse → ForbiddenException', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      const acc = await withTestTenant(async () =>
        service.addAccommodation(
          plan.id,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.updateAccommodation(acc.id, { description: 'x' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove accommodation as non-nurse → ForbiddenException', async () => {
      const studentId = await seedStudent();
      const plan = await withTestTenant(async () =>
        service.create(studentId, { planType: 'IEP' }, adminActor()),
      );
      const acc = await withTestTenant(async () =>
        service.addAccommodation(
          plan.id,
          { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.removeAccommodation(acc.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // 404 / missing rows
  // ────────────────────────────────────────────────────────────────────
  describe('missing rows', () => {
    it('addAccommodation on missing plan → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.addAccommodation(
            '00000000-0000-0000-0000-000000000000',
            { accommodationType: 'EXTRA_TIME', appliesTo: 'ALL_ASSESSMENTS' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateAccommodation on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.updateAccommodation(
            '00000000-0000-0000-0000-000000000000',
            { description: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update plan with missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(
            '00000000-0000-0000-0000-000000000000',
            { status: 'ACTIVE' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
