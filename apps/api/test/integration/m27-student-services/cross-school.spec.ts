import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ReferralService } from '@modules/m27-student-services/referrals/referral.service';
import { ReferralTypeService } from '@modules/m27-student-services/referrals/referral-type.service';
import { ReferralActivityService } from '@modules/m27-student-services/referrals/referral-activity.service';
import { SessionService } from '@modules/m27-student-services/counselling/session.service';
import { CheckinService } from '@modules/m27-student-services/wellbeing/checkin.service';
import { MtssTierService } from '@modules/m27-student-services/mtss/mtss-tier.service';
import { CaseloadService } from '@modules/m27-student-services/caseload/caseload.service';
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
import { adminActor, TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

/**
 * Wave 3 follow-up — Codex review FIX 2b. Belt-and-braces cross-
 * school isolation across the four m27-student-services read paths:
 *
 *   - ReferralService.getById         (loadOrFail → SELECT_REFERRAL_BASE)
 *   - SessionService.getById / list   (loadOrFail / list → SELECT_SESSION_BASE)
 *   - CheckinService.getById          (loadOrFail → SELECT_CHECKIN_BASE, pre-existing school filter)
 *   - MtssTierService.getById / list  (SELECT_TIER_BASE)
 *
 * Production runs schema-per-school so the cross-school read is
 * impossible at the SQL layer. The integration harness shares one
 * tenant_test schema across School A and School B (rows differentiated
 * by school_id), so an admin running in School A's tenant context that
 * probes a School B row id must NOT return the foreign row.
 *
 * The fixes that make this spec green:
 *   - ReferralService.loadOrFail / loadOrFailNoAuth now carry
 *     `r.school_id = $X::uuid` predicates (Wave 3 follow-up commit).
 *   - SessionService.loadOrFail / list ditto.
 *   - MtssTierService.list / getById ditto.
 *   - CheckinService.loadOrFail already filtered by school_id
 *     (Wave 3 covered, asserted here as a regression test).
 */
describe('integration:m27-student-services/cross-school', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let referrals: ReferralService;
  let sessions: SessionService;
  let checkins: CheckinService;
  let mtss: MtssTierService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    kafka = makeRecordingKafka();
    const activity = new ReferralActivityService(tenantPrisma);
    const types = new ReferralTypeService(tenantPrisma);
    const caseloads = new CaseloadService(tenantPrisma, permCheck);
    referrals = new ReferralService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      activity,
      types,
      caseloads,
      permCheck,
    );
    sessions = new SessionService(tenantPrisma, permCheck);
    checkins = new CheckinService(tenantPrisma, permCheck, outbox);
    mtss = new MtssTierService(tenantPrisma, kafka as unknown as KafkaProducerService, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];
  const createdStudentIds: string[] = [];
  const createdReferralTypeIds: string[] = [];

  beforeEach(async () => {
    // svc_referral_activity is IMMUTABLE — TRUNCATE bypasses trigger
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.svc_referral_activity`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_mtss_tiers WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_alerts WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_session_participants WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referrals WHERE student_id IN (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'XSCH-%')`,
    );
    if (createdReferralTypeIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE id = ANY($1::uuid[])`,
        createdReferralTypeIds.splice(0),
      );
    }
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
  // ReferralService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('ReferralService.getById: School B referral invisible to School A admin', async () => {
    const studentBId = await seedStudent('Ref', TEST_SCHOOL_B_ID);
    // Seed a referral row directly under School B (avoid threading
    // referral types + service signatures for a lean cross-school test).
    const referralTypeId = generateId();
    createdReferralTypeIds.push(referralTypeId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referral_types
         (id, school_id, name, default_priority, is_active)
       VALUES ($1::uuid, $2::uuid, $3, 'MEDIUM', true)`,
      referralTypeId,
      TEST_SCHOOL_B_ID,
      'XSch type ' + referralTypeId.slice(-6),
    );
    const refBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referrals
         (id, school_id, student_id, referred_by, referral_type_id, priority, status, reason)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'MEDIUM', 'SUBMITTED', 'cross-school test')`,
      refBId,
      TEST_SCHOOL_B_ID,
      studentBId,
      TEST_ADMIN_EMPLOYEE_ID,
      referralTypeId,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () => referrals.getById(refBId, adminActor()));
    expect(seenInB.id).toBe(refBId);
    // School A admin probing → NotFound (loadOrFail now carries r.school_id predicate)
    await expect(
      withTestTenant(async () => referrals.getById(refBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ────────────────────────────────────────────────────────────────────
  // SessionService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('SessionService.getById + list: School B session invisible to School A admin', async () => {
    const sessBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_sessions
         (id, school_id, counselor_id, session_date, session_type, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-05-12', 'CRISIS', 'SCHEDULED')`,
      sessBId,
      TEST_SCHOOL_B_ID,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () => sessions.getById(sessBId, adminActor()));
    expect(seenInB.id).toBe(sessBId);
    // School A probe → NotFound
    await expect(
      withTestTenant(async () => sessions.getById(sessBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
    // list under School A → does not include School B session
    const listA = await withTestTenant(async () => sessions.list({}, adminActor()));
    expect(listA.find((s) => s.id === sessBId)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────
  // CheckinService cross-school — pre-existing school filter contract
  // ────────────────────────────────────────────────────────────────────
  it('CheckinService.getById: School B check-in invisible to School A admin', async () => {
    const studentBId = await seedStudent('WB', TEST_SCHOOL_B_ID);
    // Seed a wellbeing template + check-in under School B
    const templateBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_survey_templates
         (id, school_id, name, frequency_recommendation, created_by)
       VALUES ($1::uuid, $2::uuid, 'XSch-Template', 'WEEKLY', $3::uuid)`,
      templateBId,
      TEST_SCHOOL_B_ID,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    const checkinBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_wellbeing_checkins
         (id, school_id, student_id, template_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      checkinBId,
      TEST_SCHOOL_B_ID,
      studentBId,
      templateBId,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () => checkins.getById(checkinBId, adminActor()));
    expect(seenInB.id).toBe(checkinBId);
    // School A probe → NotFound
    await expect(
      withTestTenant(async () => checkins.getById(checkinBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Cleanup template (no tracker for it, FK from checkin)
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_checkins WHERE id = $1::uuid`,
      checkinBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_wellbeing_survey_templates WHERE id = $1::uuid`,
      templateBId,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // MtssTierService cross-school
  // ────────────────────────────────────────────────────────────────────
  it('MtssTierService.getById + list: School B tier invisible to School A admin', async () => {
    const studentBId = await seedStudent('Mt', TEST_SCHOOL_B_ID);
    const tierBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_mtss_tiers
         (id, school_id, student_id, academic_year_id, tier, domain,
          assigned_by, assigned_at, review_date, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TIER_2', 'ACADEMIC',
               $5::uuid, '2025-09-01', '2025-12-01', 'ACTIVE')`,
      tierBId,
      TEST_SCHOOL_B_ID,
      studentBId,
      TEST_ACADEMIC_YEAR_ID,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    // Sanity: B sees it
    const seenInB = await withTestTenantB(async () => mtss.getById(tierBId, adminActor()));
    expect(seenInB.id).toBe(tierBId);
    // School A probe → NotFound
    await expect(
      withTestTenant(async () => mtss.getById(tierBId, adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
    // list under School A → does not include School B tier
    const listA = await withTestTenant(async () => mtss.list({} as any, adminActor()));
    expect(listA.find((t) => t.id === tierBId)).toBeUndefined();
  });
});
