import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { IepPlanService } from '@modules/m23-health/iep/iep-plan.service';
import { ImmunisationComplianceService } from '@modules/m23-health/immunisation/immunisation-compliance.service';
import { ImmunisationRequirementService } from '@modules/m23-health/immunisation/immunisation-requirement.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 3 follow-up — Codex review FIX 2a. Belt-and-braces cross-
 * school isolation across the three m23-health read paths:
 *
 *   - HealthRecordService.getFullRecord
 *   - IepPlanService.getForStudent
 *   - ImmunisationComplianceService.getForStudent
 *
 * Production runs schema-per-school so the cross-school read is
 * impossible at the SQL layer. The integration harness deliberately
 * shares one tenant_test schema across School A and School B (rows
 * differentiated by school_id), so an admin running in School A's
 * tenant context that probes a School B student id must NOT return
 * the School B record. The service layer must enforce this with an
 * explicit `school_id = tenant.schoolId` predicate — schema-per-
 * school alone is insufficient defence-in-depth.
 *
 * The fixes that make this spec green:
 *   - HealthRecordService.studentExistsInTenant + getFullRecord now
 *     carry the school_id predicate (Wave 3 follow-up commit).
 *   - IepPlanService.studentExistsInTenant + getForStudent likewise.
 *   - ImmunisationComplianceService.getForStudent already filtered by
 *     school_id (Wave 3 covered, asserted here as a regression test).
 */
describe('integration:m23-health/cross-school', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let guardianAuthz: GuardianAuthorizationService;
  let accessLog: HealthAccessLogService;
  let outbox: OutboxService;
  let records: HealthRecordService;
  let iep: IepPlanService;
  let immunisation: ImmunisationComplianceService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    accessLog = new HealthAccessLogService(tenantPrisma);
    guardianAuthz = new GuardianAuthorizationService(tenantPrisma);
    records = new HealthRecordService(
      tenantPrisma,
      accessLog,
      permCheck,
      guardianAuthz,
      outbox,
    );
    iep = new IepPlanService(tenantPrisma, accessLog, records, outbox);
    const requirements = new ImmunisationRequirementService(tenantPrisma);
    const kafka = makeRecordingKafka() as unknown as KafkaProducerService;
    immunisation = new ImmunisationComplianceService(
      tenantPrisma,
      permCheck,
      requirements,
      kafka,
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
    // Wipe access log to keep audit-row counts deterministic per test
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
    );
    // Wipe any records/iep/immunisation rows tied to test-tagged
    // students from prior runs.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_iep_plans WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_student_health_records WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_immunisation_compliance WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
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
  });

  async function seedStudent(label: string, schoolId: string): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(studentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'XSch', $2, 'STUDENT', true)`,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'XSch', $3, true)`,
      platformStudentId,
      personId,
      label,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      schoolId,
      'XSCH-' + studentId.slice(-12),
    );
    return studentId;
  }

  // ────────────────────────────────────────────────────────────────────
  // HealthRecordService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('HealthRecordService.getFullRecord: School B record invisible to School A admin', async () => {
    // Seed the student + record in School B
    const studentBId = await seedStudent('Health', TEST_SCHOOL_B_ID);
    await withTestTenantB(async () =>
      records.create(
        studentBId,
        {
          allergies: [{ allergen: 'shellfish', severity: 'SEVERE' }],
          bloodType: 'O+',
        },
        adminActor(),
      ),
    );
    // Sanity: B can read its own
    const seenInB = await withTestTenantB(async () =>
      records.getFullRecord(studentBId, adminActor()),
    );
    expect(seenInB.studentId).toBe(studentBId);

    // School A admin probing the School B student id → NotFound.
    // The studentExistsInTenant check now filters by school_id so
    // the leak path is closed at the very first guard.
    await expect(
      withTestTenant(async () => records.getFullRecord(studentBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('HealthRecordService.update: School B record invisible to School A admin', async () => {
    const studentBId = await seedStudent('HealthUpd', TEST_SCHOOL_B_ID);
    await withTestTenantB(async () => records.create(studentBId, {}, adminActor()));
    await expect(
      withTestTenant(async () =>
        records.update(
          studentBId,
          { allergies: [{ allergen: 'peanut', severity: 'SEVERE' }] },
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ────────────────────────────────────────────────────────────────────
  // IepPlanService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('IepPlanService.getForStudent: School B plan invisible to School A admin', async () => {
    const studentBId = await seedStudent('IepB', TEST_SCHOOL_B_ID);
    // Seed an ACTIVE plan in School B via raw SQL so we don't need
    // to thread the entire IepPlanService.create surface; the row
    // shape matches what getForStudent reads.
    const planId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hlth_iep_plans
         (id, school_id, student_id, plan_type, status, start_date, review_date, case_manager_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'IEP', 'ACTIVE', '2025-09-01', '2026-09-01', $4::uuid)`,
      planId,
      TEST_SCHOOL_B_ID,
      studentBId,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () =>
      iep.getForStudent(studentBId, adminActor()),
    );
    expect(seenInB).not.toBeNull();
    expect(seenInB!.studentId).toBe(studentBId);

    // School A admin probing School B student → NotFoundException
    // (assertCanReadStudent's studentExistsInTenant now filters by
    // school_id, so admin-path fails BEFORE the plan SELECT).
    await expect(
      withTestTenant(async () => iep.getForStudent(studentBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ────────────────────────────────────────────────────────────────────
  // ImmunisationComplianceService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('ImmunisationComplianceService.getForStudent: School B record invisible to School A admin', async () => {
    const studentBId = await seedStudent('Imm', TEST_SCHOOL_B_ID);
    // Seed a compliance row for the School B student.
    const complianceId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
         (id, student_id, school_id, status, missing_vaccines)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLIANT', '[]'::jsonb)`,
      complianceId,
      studentBId,
      TEST_SCHOOL_B_ID,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () =>
      immunisation.getForStudent(studentBId, adminActor()),
    );
    expect(seenInB.studentId).toBe(studentBId);

    // School A admin probing → NotFound. The compliance service
    // already filtered by school_id (pre-Wave-3); this test locks
    // the contract in.
    await expect(
      withTestTenant(async () => immunisation.getForStudent(studentBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ────────────────────────────────────────────────────────────────────
  // ImmunisationComplianceService.list also filters by school_id
  // ────────────────────────────────────────────────────────────────────
  it('ImmunisationComplianceService.list: School B compliance rows do not appear in School A admin list', async () => {
    const studentBId = await seedStudent('ImmList', TEST_SCHOOL_B_ID);
    const complianceId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hlth_immunisation_compliance
         (id, student_id, school_id, status, missing_vaccines)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLIANT', '[]'::jsonb)`,
      complianceId,
      studentBId,
      TEST_SCHOOL_B_ID,
    );
    const fromA = await withTestTenant(async () =>
      immunisation.list({} as any),
    );
    expect(fromA.find((c) => c.id === complianceId)).toBeUndefined();
    const fromB = await withTestTenantB(async () => immunisation.list({} as any));
    expect(fromB.find((c) => c.id === complianceId)).toBeDefined();
  });
});
