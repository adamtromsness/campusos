import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ReferralService } from '@modules/m27-student-services/referrals/referral.service';
import { ReferralTypeService } from '@modules/m27-student-services/referrals/referral-type.service';
import { ReferralActivityService } from '@modules/m27-student-services/referrals/referral-activity.service';
import { CaseloadService } from '@modules/m27-student-services/caseload/caseload.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  adminActor,
  officerActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';

/**
 * Deep coverage of ReferralService.list (filter + visibility branches)
 * and ReferralService.accept with openCaseload=true (caseload
 * auto-creation + inferConcern). The base referral-lifecycle.spec.ts
 * already covers the SUBMITTED → COMPLETED state machine.
 */
describe('integration:m27-student-services/referral-list-and-open-caseload', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let activity: ReferralActivityService;
  let types: ReferralTypeService;
  let caseloads: CaseloadService;
  let kafka: RecordingKafkaProducer;
  let service: ReferralService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    activity = new ReferralActivityService(tenantPrisma);
    types = new ReferralTypeService(tenantPrisma);
    caseloads = new CaseloadService(tenantPrisma, permCheck);
    kafka = new RecordingKafkaProducer();
    service = new ReferralService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      activity,
      types,
      caseloads,
      permCheck,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.svc_referral_activity`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_caseloads WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RFL-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referrals WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RFL-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.svc_referral_types WHERE name LIKE 'RFL-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'RFL-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'RFL-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'RFL-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      TEST_OFFICER_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
    );
  });

  async function grantScope(accountId: string, codes: string[]): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      accountId,
      TEST_SCHOOL_SCOPE_ID,
      codes,
    );
  }

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'RFL-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'RFL-Stu', $3, true)`,
      platformStudentId,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '8', 'ENROLLED')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'RFL-' + suffix,
    );
    return studentId;
  }

  async function seedType(
    name: string,
    defaultPriority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' = 'MEDIUM',
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.svc_referral_types
         (id, school_id, name, default_priority, is_active)
       VALUES ($1::uuid, $2::uuid, $3, $4, true)`,
      id,
      TEST_SCHOOL_ID,
      'RFL-' + name + '-' + id.slice(-6),
      defaultPriority,
    );
    return id;
  }

  async function submit(
    typeName: string,
    actor = officerActor(),
    options?: { studentId?: string; priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' },
  ): Promise<{ id: string; studentId: string; typeId: string }> {
    const studentId = options?.studentId ?? (await seedStudent());
    const typeId = await seedType(typeName);
    const r = await withTestTenant(async () =>
      service.create(
        {
          studentId,
          referralTypeId: typeId,
          reason: 'Test reason for ' + typeName,
          priority: options?.priority,
        },
        actor,
      ),
    );
    return { id: r.id, studentId, typeId };
  }

  // ─── list — admin filters ────────────────────────────────────

  describe('list — admin filters and priority sort', () => {
    it('admin sees referrals + URGENT priority sorts first', async () => {
      await grantScope(TEST_OFFICER_ACCOUNT_ID, ['cou-001:write']);
      const a = await submit('Academic', officerActor(), { priority: 'LOW' });
      const b = await submit('Behavioural', officerActor(), { priority: 'URGENT' });
      const list = await withTestTenant(async () => service.list({}, adminActor()));
      const idxA = list.findIndex((r) => r.id === a.id);
      const idxB = list.findIndex((r) => r.id === b.id);
      expect(idxB).toBeLessThan(idxA);
    });

    it('list filters by status', async () => {
      const r = await submit('Academic');
      const submitted = await withTestTenant(async () =>
        service.list({ status: 'SUBMITTED' }, adminActor()),
      );
      expect(submitted.find((x) => x.id === r.id)).toBeDefined();
      const completed = await withTestTenant(async () =>
        service.list({ status: 'COMPLETED' }, adminActor()),
      );
      expect(completed.find((x) => x.id === r.id)).toBeUndefined();
    });

    it('list filters by priority', async () => {
      const r = await submit('Academic', officerActor(), { priority: 'HIGH' });
      const high = await withTestTenant(async () =>
        service.list({ priority: 'HIGH' }, adminActor()),
      );
      expect(high.every((x) => x.priority === 'HIGH')).toBe(true);
      expect(high.find((x) => x.id === r.id)).toBeDefined();
    });

    it('list filters by referralTypeId', async () => {
      const r = await submit('Academic');
      const filtered = await withTestTenant(async () =>
        service.list({ referralTypeId: r.typeId }, adminActor()),
      );
      expect(filtered.every((x) => x.referralTypeId === r.typeId)).toBe(true);
    });

    it('list filters by studentId', async () => {
      const r = await submit('Academic');
      const filtered = await withTestTenant(async () =>
        service.list({ studentId: r.studentId }, adminActor()),
      );
      expect(filtered.every((x) => x.studentId === r.studentId)).toBe(true);
    });

    it('list filters by assignedCounselorId', async () => {
      await grantScope(TEST_OFFICER_ACCOUNT_ID, ['cou-001:write']);
      const r = await submit('Academic');
      await withTestTenant(async () =>
        service.triage(r.id, { assignedCounselorId: TEST_OFFICER_EMPLOYEE_ID }, officerActor()),
      );
      const filtered = await withTestTenant(async () =>
        service.list({ assignedCounselorId: TEST_OFFICER_EMPLOYEE_ID }, adminActor()),
      );
      expect(filtered.find((x) => x.id === r.id)).toBeDefined();
    });

    it('list custom limit (capped at 200)', async () => {
      await submit('Academic');
      const small = await withTestTenant(async () => service.list({ limit: 1 }, adminActor()));
      expect(small.length).toBeLessThanOrEqual(1);
      const big = await withTestTenant(async () => service.list({ limit: 9999 }, adminActor()));
      expect(big.length).toBeLessThanOrEqual(200);
    });
  });

  // ─── list — visibility ───────────────────────────────────────

  describe('list — counsellor + non-counsellor STAFF visibility', () => {
    it('counsellor sees own assigned + triage-queue + own-submitted', async () => {
      await grantScope(TEST_OFFICER_ACCOUNT_ID, ['cou-001:write']);
      const own = await submit('Academic', officerActor());
      // Triage queue: unassigned + SUBMITTED. Submit one as admin (admin has
      // no employee record path — but adminActor has TEST_ADMIN_EMPLOYEE_ID
      // so this will land as referred_by=admin, no triage assignment yet).
      const triageQueueRow = await submit('Behavioural', adminActor());
      const list = await withTestTenant(async () => service.list({}, officerActor()));
      expect(list.find((r) => r.id === own.id)).toBeDefined(); // own-submitted
      expect(list.find((r) => r.id === triageQueueRow.id)).toBeDefined(); // triage queue
    });

    it('non-counsellor STAFF (teacher) sees only own-submitted', async () => {
      // Teacher submits a referral (has employeeId, cou-002:write is
      // typical but no cou-001:write).
      const teacherSubmitted = await submit('Academic', teacherActor());
      // Admin submits one teacher does NOT own — should be hidden.
      const adminSubmitted = await submit('Academic', adminActor());

      const list = await withTestTenant(async () => service.list({}, teacherActor()));
      expect(list.find((r) => r.id === teacherSubmitted.id)).toBeDefined();
      expect(list.find((r) => r.id === adminSubmitted.id)).toBeUndefined();
    });

    it('student / parent → empty list (FALSE visibility)', async () => {
      await submit('Academic', officerActor());
      const studentList = await withTestTenant(async () => service.list({}, studentActor()));
      expect(studentList).toEqual([]);
      const parentList = await withTestTenant(async () => service.list({}, parentActor()));
      expect(parentList).toEqual([]);
    });
  });

  // ─── accept with openCaseload ────────────────────────────────

  describe('accept with openCaseload=true', () => {
    async function submitAndTriage(typeName: string): Promise<{ id: string; studentId: string }> {
      await grantScope(TEST_OFFICER_ACCOUNT_ID, ['cou-001:write']);
      const r = await submit(typeName, officerActor());
      await withTestTenant(async () =>
        service.triage(r.id, { assignedCounselorId: TEST_OFFICER_EMPLOYEE_ID }, officerActor()),
      );
      return r;
    }

    it('happy path: opens caseload, infers concern from "academic" type name', async () => {
      const { id, studentId } = await submitAndTriage('Academic');
      const r = await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      expect(r.status).toBe('ACCEPTED');
      const caseloadRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, primary_concern AS concern, counselor_id::text AS counselor_id
           FROM ${TEST_SCHEMA}.svc_caseloads WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ id: string; concern: string; counselor_id: string }>;
      expect(caseloadRows).toHaveLength(1);
      expect(caseloadRows[0]!.concern).toBe('ACADEMIC');
      expect(caseloadRows[0]!.counselor_id).toBe(TEST_OFFICER_EMPLOYEE_ID);
    });

    it('inferConcern → SOCIAL_EMOTIONAL for "social"/"emotional" type name', async () => {
      const { id, studentId } = await submitAndTriage('Social Emotional');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('SOCIAL_EMOTIONAL');
    });

    it('inferConcern → BEHAVIORAL for "behaviour"/"conduct" type name', async () => {
      const { id, studentId } = await submitAndTriage('Behavioural Conduct');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('BEHAVIORAL');
    });

    it('inferConcern → ATTENDANCE for "attendance"/"truancy" type name', async () => {
      const { id, studentId } = await submitAndTriage('Attendance Truancy');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('ATTENDANCE');
    });

    it('inferConcern → CRISIS for "crisis" type name', async () => {
      const { id, studentId } = await submitAndTriage('Crisis');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('CRISIS');
    });

    it('inferConcern → TRANSITION for "transition" type name', async () => {
      const { id, studentId } = await submitAndTriage('Transition Support');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('TRANSITION');
    });

    it('inferConcern → GENERAL for unknown type name', async () => {
      const { id, studentId } = await submitAndTriage('Whatever');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('GENERAL');
    });

    it('explicit caseloadConcern overrides inference', async () => {
      const { id, studentId } = await submitAndTriage('Academic'); // would infer ACADEMIC
      await withTestTenant(async () =>
        service.accept(
          id,
          {
            openCaseload: true,
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            caseloadConcern: 'CRISIS',
          },
          officerActor(),
        ),
      );
      const c = (await rawClient.$queryRawUnsafe(
        `SELECT primary_concern AS concern FROM ${TEST_SCHEMA}.svc_caseloads
           WHERE student_id = $1::uuid AND status = 'ACTIVE'`,
        studentId,
      )) as Array<{ concern: string }>;
      expect(c[0]!.concern).toBe('CRISIS');
    });

    it('openCaseload=true without academicYearId → BadRequest', async () => {
      const { id } = await submitAndTriage('Academic');
      await expect(
        withTestTenant(async () => service.accept(id, { openCaseload: true }, officerActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('NOTE_ADDED activity row appended after caseload creation', async () => {
      const { id } = await submitAndTriage('Academic');
      await withTestTenant(async () =>
        service.accept(
          id,
          { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
          officerActor(),
        ),
      );
      const acts = await withTestTenant(async () => activity.listForReferral(id));
      expect(acts.find((a) => a.activityType === 'NOTE_ADDED')).toBeDefined();
    });

    it('duplicate primary caseload (same student + year) → BadRequest from createInternal pre-flight', async () => {
      const { id, studentId } = await submitAndTriage('Academic');
      // Pre-seed an ACTIVE primary caseload for this student + year.
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.svc_caseloads
           (id, school_id, counselor_id, student_id, academic_year_id, primary_concern,
            is_primary_counselor, status, opened_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'GENERAL',
                 true, 'ACTIVE', now()::date)`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_ADMIN_EMPLOYEE_ID,
        studentId,
        TEST_ACADEMIC_YEAR_ID,
      );
      await expect(
        withTestTenant(async () =>
          service.accept(
            id,
            { openCaseload: true, academicYearId: TEST_ACADEMIC_YEAR_ID },
            officerActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── forbidden lifecycle paths ───────────────────────────────

  describe('forbidden lifecycle paths', () => {
    async function submitOne(): Promise<string> {
      const r = await submit('Academic', officerActor());
      return r.id;
    }

    it('accept by non-counsellor → Forbidden', async () => {
      const id = await submitOne();
      await expect(
        withTestTenant(async () => service.accept(id, {}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('start by non-counsellor → Forbidden', async () => {
      const id = await submitOne();
      await expect(
        withTestTenant(async () => service.start(id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('complete by non-counsellor → Forbidden', async () => {
      const id = await submitOne();
      await expect(
        withTestTenant(async () => service.complete(id, { outcome: 'closed' }, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decline by non-counsellor → Forbidden', async () => {
      const id = await submitOne();
      await expect(
        withTestTenant(async () => service.decline(id, { reason: 'No' }, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accept on non-existent referral → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.accept(generateId(), {}, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('accept on referral with no assigned counsellor (skip triage) → BadRequest', async () => {
      const id = await submitOne();
      // Skip triage — accept directly without assigning.
      await expect(
        withTestTenant(async () => service.accept(id, {}, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
