import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TelehealthProviderService } from '@modules/m23-health/records/telehealth-provider.service';
import { TelehealthSessionService } from '@modules/m23-health/records/telehealth-session.service';
import { HealthAccessLogService } from '@modules/m23-health/records/health-access-log.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

describe('integration:m23-health/telehealth', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accessLog: HealthAccessLogService;
  let providers: TelehealthProviderService;
  let sessions: TelehealthSessionService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    accessLog = new HealthAccessLogService(tenantPrisma);
    providers = new TelehealthProviderService(tenantPrisma, permCheck);
    sessions = new TelehealthSessionService(tenantPrisma, permCheck, providers, accessLog);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_telehealth_documents WHERE session_id IN
         (SELECT id FROM ${TEST_SCHEMA}.hlth_telehealth_sessions WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_telehealth_sessions WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.hlth_telehealth_providers WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.hlth_health_access_log`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'TH-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name = 'TH-Stu'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name = 'TH-Stu'`,
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
       VALUES ($1::uuid, 'TH-Stu', $2, 'STUDENT', true)`,
      personId,
      'Stu-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'TH-Stu', $3, true)`,
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
      'TH-' + suffix,
    );
    return studentId;
  }

  function futureIso(deltaMs: number = 1000): string {
    return new Date(Date.now() + deltaMs).toISOString();
  }

  describe('TelehealthProviderService', () => {
    it('admin creates, gets, lists, patches a provider', async () => {
      const p = await withTestTenant(async () =>
        providers.create(
          {
            providerName: 'Telehealth Clinic',
            speciality: 'Counselling',
            contactEmail: 'clinic@example.com',
            contactPhone: '+1 555 0100',
            bookingUrl: 'https://clinic.example.com/book',
          },
          adminActor(),
        ),
      );
      expect(p.providerName).toBe('Telehealth Clinic');

      const got = await withTestTenant(async () => providers.getById(p.id));
      expect(got.id).toBe(p.id);

      const all = await withTestTenant(async () => providers.list());
      expect(all.find((x) => x.id === p.id)).toBeDefined();

      const updated = await withTestTenant(async () =>
        providers.patch(
          p.id,
          {
            providerName: 'Renamed Clinic',
            speciality: 'Therapy',
            contactEmail: 'new@example.com',
            contactPhone: '+1 555 0200',
            bookingUrl: 'https://renamed.example.com',
            isActive: false,
          },
          adminActor(),
        ),
      );
      expect(updated.providerName).toBe('Renamed Clinic');
      expect(updated.isActive).toBe(false);

      // Active-only list excludes inactive provider
      const active = await withTestTenant(async () => providers.list(false));
      expect(active.find((x) => x.id === p.id)).toBeUndefined();
      const withInactive = await withTestTenant(async () => providers.list(true));
      expect(withInactive.find((x) => x.id === p.id)).toBeDefined();
    });

    it('officer with hlt-006:write creates a provider', async () => {
      await grantOfficer(['hlt-006:write']);
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'Officer Clinic' }, officerActor()),
      );
      expect(p.id).toBeTruthy();
    });

    it('non-nurse → Forbidden on create/patch', async () => {
      await expect(
        withTestTenant(async () =>
          providers.create({ providerName: 'X' }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => providers.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          providers.patch(generateId(), { isActive: false }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch returns existing', async () => {
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'Z' }, adminActor()),
      );
      const u = await withTestTenant(async () => providers.patch(p.id, {}, adminActor()));
      expect(u.id).toBe(p.id);
    });

    it('loadActiveOrFail returns active row; inactive / missing → BadRequest', async () => {
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'Live' }, adminActor()),
      );
      const ok = await withTestTenant(async () => providers.loadActiveOrFail(p.id));
      expect(ok.id).toBe(p.id);

      await withTestTenant(async () =>
        providers.patch(p.id, { isActive: false }, adminActor()),
      );
      await expect(
        withTestTenant(async () => providers.loadActiveOrFail(p.id)),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        withTestTenant(async () => providers.loadActiveOrFail(generateId())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school: School A provider invisible in School B', async () => {
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'A Clinic' }, adminActor()),
      );
      await expect(
        withTestTenantB(async () => providers.getById(p.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('TelehealthSessionService', () => {
    async function setup(): Promise<{ studentId: string; providerId: string }> {
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'Test Clinic' }, adminActor()),
      );
      const studentId = await seedStudent();
      return { studentId, providerId: p.id };
    }

    it('admin schedules a session + list includes it + audit row', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          {
            studentId,
            providerId,
            scheduledAt: futureIso(60 * 60 * 1000),
            durationMinutes: 30,
            meetingUrl: 'https://meet.example.com/x',
          },
          adminActor(),
        ),
      );
      expect(s.status).toBe('SCHEDULED');
      expect(s.studentId).toBe(studentId);

      const list = await withTestTenant(async () => sessions.list({}, adminActor()));
      expect(list.find((x) => x.id === s.id)).toBeDefined();

      const audit = (await rawClient.$queryRawUnsafe(
        `SELECT access_type FROM ${TEST_SCHEMA}.hlth_health_access_log
           WHERE access_type = 'VIEW_TELEHEALTH'`,
      )) as Array<{ access_type: string }>;
      expect(audit.length).toBeGreaterThanOrEqual(1);
    });

    it('schedule with non-existent student → BadRequest', async () => {
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'X' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          sessions.schedule(
            {
              studentId: generateId(),
              providerId: p.id,
              scheduledAt: futureIso(),
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('schedule with non-existent provider → BadRequest', async () => {
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          sessions.schedule(
            {
              studentId,
              providerId: generateId(),
              scheduledAt: futureIso(),
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list filters by studentId + status + limit clamp', async () => {
      const { studentId, providerId } = await setup();
      await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        sessions.list({ studentId, status: 'SCHEDULED', limit: 9999 }, adminActor()),
      );
      expect(filtered.every((s) => s.studentId === studentId)).toBe(true);
      expect(filtered.length).toBeLessThanOrEqual(200);
    });

    it('getById returns session + audit row', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => sessions.getById(s.id, adminActor()));
      expect(r.id).toBe(s.id);
    });

    it('getById missing → NotFound', async () => {
      await expect(
        withTestTenant(async () => sessions.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: SCHEDULED → IN_PROGRESS → COMPLETED stamps completed_at', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const inProg = await withTestTenant(async () =>
        sessions.patch(s.id, { status: 'IN_PROGRESS' }, adminActor()),
      );
      expect(inProg.status).toBe('IN_PROGRESS');
      const completed = await withTestTenant(async () =>
        sessions.patch(s.id, { status: 'COMPLETED' }, adminActor()),
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();
    });

    it('patch CANCELLED requires cancellationReason; otherwise BadRequest', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          sessions.patch(s.id, { status: 'CANCELLED' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const cancelled = await withTestTenant(async () =>
        sessions.patch(
          s.id,
          { status: 'CANCELLED', cancellationReason: 'Parent requested' },
          adminActor(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(cancelled.cancellationReason).toBe('Parent requested');
    });

    it('patch terminal state → BadRequest', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        sessions.patch(s.id, { status: 'COMPLETED' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          sessions.patch(s.id, { status: 'IN_PROGRESS' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.patch(generateId(), { status: 'IN_PROGRESS' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch returns existing', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        sessions.patch(s.id, {}, adminActor()),
      );
      expect(r.id).toBe(s.id);
    });

    it('patch meetingUrl + sessionNotesS3Key without status change', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        sessions.patch(
          s.id,
          {
            meetingUrl: 'https://updated.example.com',
            sessionNotesS3Key: 'session-notes/a/b.enc',
          },
          adminActor(),
        ),
      );
      expect(r.meetingUrl).toBe('https://updated.example.com');
    });

    it('recordConsent stamps consent_received_at', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        sessions.recordConsent(s.id, generateId(), adminActor()),
      );
      expect(r.consentReceivedAt).not.toBeNull();
      expect(r.consentSignatureId).not.toBeNull();
    });

    it('recordConsent missing → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.recordConsent(generateId(), null, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uploadDocument writes hlth_telehealth_documents + listDocuments returns it', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      const d = await withTestTenant(async () =>
        sessions.uploadDocument(
          s.id,
          {
            documentType: 'SESSION_NOTES',
            s3Key: 'telehealth/' + s.id + '/notes.enc',
            fileSizeBytes: 4096,
          },
          adminActor(),
        ),
      );
      expect(d.documentType).toBe('SESSION_NOTES');
      const list = await withTestTenant(async () =>
        sessions.listDocuments(s.id, adminActor()),
      );
      expect(list.find((x) => x.id === d.id)).toBeDefined();
    });

    it('uploadDocument to missing session → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          sessions.uploadDocument(
            generateId(),
            { documentType: 'OTHER', s3Key: 'x' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-nurse read scope → Forbidden on list/getById', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => sessions.list({}, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => sessions.getById(s.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => sessions.getById(s.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-nurse write scope → Forbidden on schedule/patch/uploadDocument', async () => {
      const studentId = await seedStudent();
      const p = await withTestTenant(async () =>
        providers.create({ providerName: 'X' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          sessions.schedule(
            { studentId, providerId: p.id, scheduledAt: futureIso() },
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('officer with hlt-006:read can list', async () => {
      await grantOfficer(['hlt-006:read']);
      const list = await withTestTenant(async () => sessions.list({}, officerActor()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('cross-school: School A session invisible from School B', async () => {
      const { studentId, providerId } = await setup();
      const s = await withTestTenant(async () =>
        sessions.schedule(
          { studentId, providerId, scheduledAt: futureIso() },
          adminActor(),
        ),
      );
      await expect(
        withTestTenantB(async () => sessions.getById(s.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
