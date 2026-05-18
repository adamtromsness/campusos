import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ScreeningService } from '@modules/m23-health/screenings/screening.service';
import { ScreeningReferralService } from '@modules/m23-health/screenings/screening-referral.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { HealthRecordService } from '@modules/m23-health/records/health-record.service';
import { GuardianAuthorizationService } from '@modules/m00-platform/iam/guardian-authorization.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

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
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

describe('integration:m23-health/screenings', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accessLog: HealthAccessLogService;
  let records: HealthRecordService;
  let screenings: ScreeningService;
  let referrals: ScreeningReferralService;

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
    screenings = new ScreeningService(tenantPrisma, accessLog, records);
    referrals = new ScreeningReferralService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_screening_referrals WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'SCR-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_screenings WHERE student_id IN
         (SELECT id FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'SCR-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'SCR-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'SCR-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'SCR-Stu'`,
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
       VALUES ($1::uuid, 'SCR-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'SCR-Stu', $3, true)`,
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
      'SCR-' + suffix,
    );
    return studentId;
  }

  // ─── ScreeningService — list / create / update / follow-up ─────

  describe('ScreeningService.create', () => {
    it('admin creates a screening', async () => {
      const studentId = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'PASS',
          },
          adminActor(),
        ),
      );
      expect(r.studentId).toBe(studentId);
      expect(r.result).toBe('PASS');
      expect(r.screenedById).toBe(TEST_ADMIN_EMPLOYEE_ID);
    });

    it('counsellor with hlt-001:write creates a screening', async () => {
      await grantOfficer(['hlt-001:write']);
      const studentId = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'HEARING',
            screeningDate: '2026-01-15',
            result: 'REFER',
            followUpRequired: true,
            resultNotes: 'Reduced acuity',
            referralNotes: 'Refer to ENT',
          },
          officerActor(),
        ),
      );
      expect(r.followUpRequired).toBe(true);
    });

    it('non-nurse (teacher / student / parent) → Forbidden', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          screenings.create(
            { studentId, screeningType: 'VISION', screeningDate: '2026-01-15' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          screenings.create(
            { studentId, screeningType: 'VISION', screeningDate: '2026-01-15' },
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          screenings.create(
            { studentId, screeningType: 'VISION', screeningDate: '2026-01-15' },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('actor without employeeId → Forbidden', async () => {
      const studentId = await seedStudent();
      const noEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          screenings.create(
            { studentId, screeningType: 'VISION', screeningDate: '2026-01-15' },
            noEmp,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ScreeningService.list', () => {
    it('admin lists screenings + VIEW_SCREENING audit row written per distinct student', async () => {
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'VISION', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        screenings.create(
          { studentId: s2, screeningType: 'VISION', screeningDate: '2026-02-15' },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => screenings.list({}, adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(2);

      const audit = (await rawClient.$queryRawUnsafe(
        `SELECT student_id::text AS sid, access_type FROM ${TEST_SCHEMA}.hlth_health_access_log
           WHERE access_type = 'VIEW_SCREENING'`,
      )) as Array<{ sid: string; access_type: string }>;
      const audited = new Set(audit.map((a) => a.sid));
      expect(audited.has(s1)).toBe(true);
      expect(audited.has(s2)).toBe(true);
    });

    it('filters by studentId', async () => {
      const s1 = await seedStudent();
      await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'VISION', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        screenings.list({ studentId: s1 }, adminActor()),
      );
      expect(list.every((s) => s.studentId === s1)).toBe(true);
    });

    it('filters by screeningType', async () => {
      const s1 = await seedStudent();
      await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'VISION', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'HEARING', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        screenings.list({ screeningType: 'VISION' }, adminActor()),
      );
      expect(r.every((s) => s.screeningType === 'VISION')).toBe(true);
    });

    it('filters by result + fromDate + toDate', async () => {
      const s1 = await seedStudent();
      await withTestTenant(async () =>
        screenings.create(
          {
            studentId: s1,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        screenings.list(
          { result: 'REFER', fromDate: '2026-01-01', toDate: '2026-01-31' },
          adminActor(),
        ),
      );
      expect(r.every((s) => s.result === 'REFER')).toBe(true);
    });

    it('limit clamp at 500', async () => {
      const r = await withTestTenant(async () =>
        screenings.list({ limit: 9999 }, adminActor()),
      );
      expect(r.length).toBeLessThanOrEqual(500);
    });

    it('non-nurse → Forbidden', async () => {
      await expect(
        withTestTenant(async () => screenings.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ScreeningService.update', () => {
    it('admin updates result + followUpCompleted', async () => {
      const s1 = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          {
            studentId: s1,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
            followUpRequired: true,
          },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () =>
        screenings.update(
          r.id,
          {
            result: 'PASS',
            followUpCompleted: true,
            resultNotes: 'Updated',
            referralNotes: 'closed',
          },
          adminActor(),
        ),
      );
      expect(u.result).toBe('PASS');
      expect(u.followUpCompleted).toBe(true);
    });

    it('empty patch returns existing', async () => {
      const s1 = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'VISION', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      const u = await withTestTenant(async () => screenings.update(r.id, {}, adminActor()));
      expect(u.id).toBe(r.id);
    });

    it('missing screening → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          screenings.update(generateId(), { result: 'PASS' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden', async () => {
      const s1 = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          { studentId: s1, screeningType: 'VISION', screeningDate: '2026-01-15' },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          screenings.update(r.id, { result: 'PASS' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ScreeningService.listFollowUp', () => {
    it('admin lists pending follow-up screenings only', async () => {
      const s1 = await seedStudent();
      const s2 = await seedStudent();
      const needFollowUp = await withTestTenant(async () =>
        screenings.create(
          {
            studentId: s1,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
            followUpRequired: true,
          },
          adminActor(),
        ),
      );
      const noFollowUp = await withTestTenant(async () =>
        screenings.create(
          {
            studentId: s2,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'PASS',
          },
          adminActor(),
        ),
      );
      const queue = await withTestTenant(async () => screenings.listFollowUp(adminActor()));
      expect(queue.find((q) => q.id === needFollowUp.id)).toBeDefined();
      expect(queue.find((q) => q.id === noFollowUp.id)).toBeUndefined();
    });

    it('non-admin → Forbidden', async () => {
      await expect(
        withTestTenant(async () => screenings.listFollowUp(officerActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─── ScreeningReferralService ────────────────────────────────

  describe('ScreeningReferralService.createFromScreening', () => {
    async function createScreening(): Promise<{ studentId: string; screeningId: string }> {
      const studentId = await seedStudent();
      const r = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
          },
          adminActor(),
        ),
      );
      return { studentId, screeningId: r.id };
    }

    it('admin creates a referral from a screening + flips parent follow_up_required=true', async () => {
      const { studentId, screeningId } = await createScreening();
      const r = await withTestTenant(async () =>
        referrals.createFromScreening(
          screeningId,
          {
            referralType: 'VISION',
            reason: 'Visual acuity 20/40 OD',
            referredTo: 'Local optometrist',
            referralDate: '2026-01-20',
            followUpDate: '2026-02-20',
          },
          adminActor(),
        ),
      );
      expect(r.referralType).toBe('VISION');
      expect(r.status).toBe('REFERRED');
      expect(r.studentId).toBe(studentId);

      const parent = (await rawClient.$queryRawUnsafe(
        `SELECT follow_up_required AS f FROM ${TEST_SCHEMA}.hlth_screenings WHERE id = $1::uuid`,
        screeningId,
      )) as Array<{ f: boolean }>;
      expect(parent[0]!.f).toBe(true);
    });

    it('counsellor with hlt-004:write can create referral', async () => {
      await grantOfficer(['hlt-004:write']);
      const { screeningId } = await createScreening();
      const r = await withTestTenant(async () =>
        referrals.createFromScreening(
          screeningId,
          {
            referralType: 'HEARING',
            reason: 'Failed pure-tone',
            referralDate: '2026-01-20',
          },
          officerActor(),
        ),
      );
      expect(r.id).toBeTruthy();
    });

    it('non-nurse → Forbidden', async () => {
      const { screeningId } = await createScreening();
      await expect(
        withTestTenant(async () =>
          referrals.createFromScreening(
            screeningId,
            { referralType: 'VISION', reason: 'x', referralDate: '2026-01-20' },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing screening → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          referrals.createFromScreening(
            generateId(),
            { referralType: 'VISION', reason: 'x', referralDate: '2026-01-20' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ScreeningReferralService.list / getById', () => {
    async function seedReferral(): Promise<string> {
      const studentId = await seedStudent();
      const s = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        referrals.createFromScreening(
          s.id,
          {
            referralType: 'VISION',
            reason: 'Test',
            referralDate: '2026-01-20',
            followUpDate: '2026-02-20',
          },
          adminActor(),
        ),
      );
      return r.id;
    }

    it('list returns referrals + filters by status/type/studentId', async () => {
      const refId = await seedReferral();
      const all = await withTestTenant(async () => referrals.list({}));
      expect(all.find((r) => r.id === refId)).toBeDefined();

      const referred = await withTestTenant(async () =>
        referrals.list({ status: 'REFERRED' }),
      );
      expect(referred.every((r) => r.status === 'REFERRED')).toBe(true);

      const vision = await withTestTenant(async () =>
        referrals.list({ referralType: 'VISION' }),
      );
      expect(vision.every((r) => r.referralType === 'VISION')).toBe(true);

      const dto = await withTestTenant(async () => referrals.getById(refId));
      expect(dto.id).toBe(refId);
    });

    it('list studentId filter', async () => {
      const refId = await seedReferral();
      const dto = await withTestTenant(async () => referrals.getById(refId));
      const filtered = await withTestTenant(async () =>
        referrals.list({ studentId: dto.studentId }),
      );
      expect(filtered.every((r) => r.studentId === dto.studentId)).toBe(true);
    });

    it('list limit clamp at 500', async () => {
      const r = await withTestTenant(async () => referrals.list({ limit: 9999 }));
      expect(r.length).toBeLessThanOrEqual(500);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => referrals.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school isolation: referral from School A invisible from School B', async () => {
      const refId = await seedReferral();
      await expect(
        withTestTenantB(async () => referrals.getById(refId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ScreeningReferralService.patch', () => {
    async function seedReferral(): Promise<string> {
      const studentId = await seedStudent();
      const s = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
          },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        referrals.createFromScreening(
          s.id,
          {
            referralType: 'VISION',
            reason: 'Test',
            referralDate: '2026-01-20',
            followUpDate: '2026-02-20',
          },
          adminActor(),
        ),
      );
      return r.id;
    }

    it('patches status + outcome + follow-up date', async () => {
      const id = await seedReferral();
      const u = await withTestTenant(async () =>
        referrals.patch(
          id,
          {
            status: 'FOLLOW_UP_COMPLETE',
            followUpOutcome: 'GLASSES_PRESCRIBED',
            followUpNotes: 'Patient picked up frames.',
            followUpDate: '2026-02-22',
            referredTo: 'Local optometrist',
          },
          adminActor(),
        ),
      );
      expect(u.status).toBe('FOLLOW_UP_COMPLETE');
      expect(u.followUpOutcome).toBe('GLASSES_PRESCRIBED');
    });

    it('FOLLOW_UP_COMPLETE without follow_up_date → BadRequest', async () => {
      const id = await seedReferral();
      await expect(
        withTestTenant(async () =>
          referrals.patch(
            id,
            { status: 'FOLLOW_UP_COMPLETE', followUpDate: null },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty patch returns existing', async () => {
      const id = await seedReferral();
      const u = await withTestTenant(async () => referrals.patch(id, {}, adminActor()));
      expect(u.id).toBe(id);
    });

    it('missing referral → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          referrals.patch(generateId(), { status: 'LOST_TO_FOLLOW_UP' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse → Forbidden', async () => {
      const id = await seedReferral();
      await expect(
        withTestTenant(async () =>
          referrals.patch(id, { status: 'LOST_TO_FOLLOW_UP' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ScreeningReferralService.overdue', () => {
    it('returns REFERRED with follow_up_date < today', async () => {
      const studentId = await seedStudent();
      const s = await withTestTenant(async () =>
        screenings.create(
          {
            studentId,
            screeningType: 'VISION',
            screeningDate: '2026-01-15',
            result: 'REFER',
          },
          adminActor(),
        ),
      );
      // Yesterday relative to today's runtime.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const r = await withTestTenant(async () =>
        referrals.createFromScreening(
          s.id,
          {
            referralType: 'VISION',
            reason: 'old',
            referralDate: '2026-01-20',
            followUpDate: yesterday,
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => referrals.overdue());
      expect(list.find((x) => x.id === r.id)).toBeDefined();
    });
  });
});
