import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { SarService } from '@modules/m00-platform/governance/sar.service';
import { GovernanceAccess } from '@modules/m00-platform/governance/access.ts';
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
  studentActor,
  parentActor,
  teacherActor,
  TEST_STUDENT_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_OFFICER_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for SarService — GDPR Article 15 Subject
 * Access Requests + 30/45-day deadline tracking + age-18 keystone
 * (data_subject_is_self) + locked-row state machine.
 *
 * Coverage areas:
 *   - hasDpoScope: admin short-circuit, non-STAFF false, STAFF + perm
 *   - buildVisibility: GUARDIAN (via sis_student_guardians), STUDENT, DPO
 *   - create: admin DPO path, GUARDIAN-with-link, GUARDIAN refused at age-18,
 *     STUDENT for self, STUDENT for someone else (rejected), officer-no-perm
 *   - list: status filter, overdueOnly filter, visibility per persona
 *   - getById: cross-school NotFound
 *   - update: status transitions, terminal COMPLETED/DENIED rejection,
 *     locked-row state machine, completed_at stamp, non-DPO rejection
 *   - default deadline from dpo_compliance_dashboard_config
 */
describe('integration:m00-platform/governance-sar', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let access: GovernanceAccess;
  let service: SarService;

  // School A linked student + parent for the GUARDIAN test path. Uses the
  // canonical TEST_STUDENT_PERSON_ID / TEST_PARENT_PERSON_ID iam_person
  // rows seeded by employees fixtures.
  const STUDENT_PLATFORM_STUDENT_ID = '019e3a01-bbbb-7777-8888-000000000001';
  const SIS_STUDENT_ID = '019e3a01-bbbb-7777-8888-000000000002';
  const SIS_GUARDIAN_ID = '019e3a01-bbbb-7777-8888-000000000003';
  const SSG_ID = '019e3a01-bbbb-7777-8888-000000000004';

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    access = new GovernanceAccess(tenantPrisma);
    service = new SarService(tenantPrisma, permCheck, access);

    // Seed iam_person for student + parent (in case fixture didn't seed them)
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Test', 'Student', 'STUDENT', true)
       ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Test', 'Parent', 'GUARDIAN', true)
       ON CONFLICT (id) DO NOTHING`,
      TEST_PARENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, 'student@test.integration.local', 'Test Student', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_ACCOUNT_ID,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, 'parent@test.integration.local', 'Test Parent', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      TEST_PARENT_ACCOUNT_ID,
      TEST_PARENT_PERSON_ID,
    );

    // platform_students projection — defaults data_subject_is_self=false (age <18).
    // ON CONFLICT (person_id) DO UPDATE so we coexist with any platform_students
    // row a prior or concurrent test may have left for TEST_STUDENT_PERSON_ID.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active, data_subject_is_self)
       VALUES ($1::uuid, $2::uuid, 'Test', 'Student', true, false)
       ON CONFLICT (person_id) DO UPDATE SET data_subject_is_self = false, is_active = true`,
      STUDENT_PLATFORM_STUDENT_ID,
      TEST_STUDENT_PERSON_ID,
    );

    // Tenant-side projections (sis_students, sis_guardians, link). Use raw
    // client with schema-qualified inserts so we don't need tenant context.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, student_number, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'TEST-STU-001', 'ENROLLED')
       ON CONFLICT (id) DO NOTHING`,
      SIS_STUDENT_ID,
      TEST_SCHOOL_ID,
      STUDENT_PLATFORM_STUDENT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, relationship)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT')
       ON CONFLICT (id) DO NOTHING`,
      SIS_GUARDIAN_ID,
      TEST_SCHOOL_ID,
      TEST_PARENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians (id, student_id, guardian_id, has_custody)
       VALUES ($1::uuid, $2::uuid, $3::uuid, true)
       ON CONFLICT (id) DO NOTHING`,
      SSG_ID,
      SIS_STUDENT_ID,
      SIS_GUARDIAN_ID,
    );
  });

  afterAll(async () => {
    // Clean up so we don't poison the wellbeing/mtss/etc. specs that
    // also seed platform_students for TEST_STUDENT_PERSON_ID.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE id = $1::uuid`,
      SSG_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
      SIS_STUDENT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = $1::uuid`,
      SIS_GUARDIAN_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_subject_access_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // Reset platform_students.data_subject_is_self for the test student
    await rawClient.$executeRawUnsafe(
      `UPDATE platform.platform_students SET data_subject_is_self = false WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    // Reset officer permission cache so each test starts deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_OFFICER_ACCOUNT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      TEST_PARENT_ACCOUNT_ID,
      TEST_STUDENT_ACCOUNT_ID,
    );
    // Wipe per-school dashboard config so tests can seed their own
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.dpo_compliance_dashboard_config WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function grantDpoToOfficer(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_OFFICER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      ['dpo-004:write'],
    );
  }

  async function setAgeOfMajority(value: boolean): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `UPDATE platform.platform_students SET data_subject_is_self = $1 WHERE person_id = $2::uuid`,
      value,
      TEST_STUDENT_PERSON_ID,
    );
  }

  describe('hasDpoScope', () => {
    it('school admin → true', async () => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(adminActor())).toBe(true);
      });
    });

    it('non-STAFF persona → false (without DB hit)', async () => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(studentActor())).toBe(false);
        expect(await service.hasDpoScope(parentActor())).toBe(false);
      });
    });

    it('STAFF with dpo-004:write → true', async () => {
      await grantDpoToOfficer();
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(officerActor())).toBe(true);
      });
    });

    it('STAFF without dpo-004:write → false', async () => {
      await withTestTenant(async () => {
        expect(await service.hasDpoScope(officerActor())).toBe(false);
      });
    });
  });

  describe('create', () => {
    it('admin creates a SAR for student data subject (under 18) — RECEIVED status with default 30-day deadline', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
          requestDetails: 'GDPR Article 15 request',
        }),
      );
      expect(created.status).toBe('RECEIVED');
      expect(created.dataSubjectId).toBe(TEST_STUDENT_PERSON_ID);
      expect(created.requestType).toBe('ACCESS');
      expect(created.completedAt).toBeNull();
      expect(created.deadlineDate).toBeTruthy();
      // Verify in DB the deadline is around now + 30 days
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT deadline_date::text AS d FROM ${TEST_SCHEMA}.dpo_subject_access_requests WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ d: string }>;
      const deadlineMs = new Date(rows[0]!.d + 'T00:00:00Z').getTime();
      const now = Date.now();
      expect(deadlineMs).toBeGreaterThanOrEqual(now + 28 * 24 * 60 * 60 * 1000);
      expect(deadlineMs).toBeLessThanOrEqual(now + 32 * 24 * 60 * 60 * 1000);
    });

    it('uses sar_default_deadline_days from dpo_compliance_dashboard_config when present', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_compliance_dashboard_config
           (id, school_id, sar_default_deadline_days, breach_escalation_hours, dpia_review_reminder_days, retention_review_reminder_days)
         VALUES ($1::uuid, $2::uuid, 45, 70, 30, 30)`,
        generateId(),
        TEST_SCHOOL_ID,
      );
      const created = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT deadline_date::text AS d FROM ${TEST_SCHEMA}.dpo_subject_access_requests WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ d: string }>;
      const deadlineMs = new Date(rows[0]!.d + 'T00:00:00Z').getTime();
      const now = Date.now();
      expect(deadlineMs).toBeGreaterThanOrEqual(now + 43 * 24 * 60 * 60 * 1000);
      expect(deadlineMs).toBeLessThanOrEqual(now + 47 * 24 * 60 * 60 * 1000);
    });

    it('officer with dpo-004:write can create a SAR for any in-school subject', async () => {
      await grantDpoToOfficer();
      const created = await withTestTenant(async () =>
        service.create(officerActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'PORTABILITY',
        }),
      );
      expect(created.status).toBe('RECEIVED');
      expect(created.requestType).toBe('PORTABILITY');
    });

    it('officer without dpo-004:write → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            dataSubjectId: TEST_STUDENT_PERSON_ID,
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('teacher (STAFF, no DPO perm) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(teacherActor(), {
            dataSubjectId: TEST_STUDENT_PERSON_ID,
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('DPO-created SAR with cross-tenant dataSubjectId → BadRequest (no projection in current school)', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            dataSubjectId: generateId(),
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('GUARDIAN linked to student can submit a SAR for that student (data_subject_is_self=false)', async () => {
      const created = await withTestTenant(async () =>
        service.create(parentActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      expect(created.dataSubjectId).toBe(TEST_STUDENT_PERSON_ID);
      expect(created.requestedById).toBe(TEST_PARENT_ACCOUNT_ID);
    });

    it('GUARDIAN refused at age-18 keystone (data_subject_is_self=true)', async () => {
      await setAgeOfMajority(true);
      await expect(
        withTestTenant(async () =>
          service.create(parentActor(), {
            dataSubjectId: TEST_STUDENT_PERSON_ID,
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN without a linked student → ForbiddenException', async () => {
      // Use a random platform iam_person id that is NOT linked via sis_student_guardians
      const otherPersonId = generateId();
      const otherPlatformStudentId = generateId();
      const otherSisStudentId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Other', 'Student', 'STUDENT', true)`,
        otherPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active, data_subject_is_self)
         VALUES ($1::uuid, $2::uuid, 'Other', 'Student', true, false)`,
        otherPlatformStudentId,
        otherPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, student_number, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'OTHER-STU-002', 'ENROLLED')`,
        otherSisStudentId,
        TEST_SCHOOL_ID,
        otherPlatformStudentId,
      );

      await expect(
        withTestTenant(async () =>
          service.create(parentActor(), {
            dataSubjectId: otherPersonId,
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
        otherSisStudentId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
        otherPlatformStudentId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        otherPersonId,
      );
    });

    it('STUDENT can submit a SAR for their own data', async () => {
      const created = await withTestTenant(async () =>
        service.create(studentActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      expect(created.dataSubjectId).toBe(TEST_STUDENT_PERSON_ID);
      expect(created.requestedById).toBe(TEST_STUDENT_ACCOUNT_ID);
    });

    it('STUDENT cannot submit for someone else → ForbiddenException', async () => {
      const otherPersonId = generateId();
      await expect(
        withTestTenant(async () =>
          service.create(studentActor(), {
            dataSubjectId: otherPersonId,
            requestType: 'ACCESS',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('list + getById', () => {
    it('admin sees all SARs in current school; cross-school invisible', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      // Seed a SAR directly in School B for the same data subject
      const otherId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE + INTERVAL '30 days', 'RECEIVED')`,
        otherId,
        TEST_SCHOOL_B_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );

      const allA = await withTestTenant(async () => service.list(adminActor()));
      expect(allA.find((s) => s.id === created.id)).toBeDefined();
      expect(allA.find((s) => s.id === otherId)).toBeUndefined();

      const allB = await withTestTenantB(async () => service.list(adminActor()));
      expect(allB.find((s) => s.id === otherId)).toBeDefined();
      expect(allB.find((s) => s.id === created.id)).toBeUndefined();
    });

    it('status filter narrows results', async () => {
      const a = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const b = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'RECTIFICATION',
        }),
      );
      await withTestTenant(async () =>
        service.update(adminActor(), b.id, { status: 'IN_PROGRESS' }),
      );
      const received = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'RECEIVED' }),
      );
      expect(received.find((s) => s.id === a.id)).toBeDefined();
      expect(received.find((s) => s.id === b.id)).toBeUndefined();
      const inProgress = await withTestTenant(async () =>
        service.list(adminActor(), { status: 'IN_PROGRESS' }),
      );
      expect(inProgress.find((s) => s.id === b.id)).toBeDefined();
    });

    it('overdueOnly filter returns only non-terminal rows past deadline_date', async () => {
      // Directly seed an overdue row (deadline in the past, status RECEIVED)
      const overdueId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE - INTERVAL '5 days', 'IN_PROGRESS')`,
        overdueId,
        TEST_SCHOOL_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      // And one within deadline
      const okId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE + INTERVAL '20 days', 'RECEIVED')`,
        okId,
        TEST_SCHOOL_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );

      const overdue = await withTestTenant(async () =>
        service.list(adminActor(), { overdueOnly: true }),
      );
      expect(overdue.find((s) => s.id === overdueId)).toBeDefined();
      expect(overdue.find((s) => s.id === okId)).toBeUndefined();
    });

    it('overdue row is visible via overdueOnly list filter', async () => {
      const overdueId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE - INTERVAL '3 days', 'IN_PROGRESS')`,
        overdueId,
        TEST_SCHOOL_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      const overdues = await withTestTenant(async () =>
        service.list(adminActor(), { overdueOnly: true }),
      );
      expect(overdues.find((s) => s.id === overdueId)).toBeDefined();
    });

    it('isOverdue=false on terminal COMPLETED status even with past deadline', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status, completed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE - INTERVAL '5 days', 'COMPLETED', now())`,
        id,
        TEST_SCHOOL_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      const got = await withTestTenant(async () => service.getById(adminActor(), id));
      expect(got.status).toBe('COMPLETED');
      expect(got.isOverdue).toBe(false);
    });

    it('cross-school getById → NotFoundException', async () => {
      const created = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      await expect(
        withTestTenantB(async () => service.getById(adminActor(), created.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('missing SAR → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('GUARDIAN list only sees own children SARs and own submissions', async () => {
      // Parent's own submission for their child
      const own = await withTestTenant(async () =>
        service.create(parentActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      // Admin-created SAR for an unrelated data subject (officer person)
      // (officer is a staff with hr_employees → assertDataSubjectInCurrentTenant passes)
      const otherSar = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const parentSees = await withTestTenant(async () => service.list(parentActor()));
      expect(parentSees.find((s) => s.id === own.id)).toBeDefined();
      expect(parentSees.find((s) => s.id === otherSar.id)).toBeUndefined();
    });

    it('STUDENT list only sees own submissions', async () => {
      const own = await withTestTenant(async () =>
        service.create(studentActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const other = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_OFFICER_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const studentSees = await withTestTenant(async () => service.list(studentActor()));
      expect(studentSees.find((s) => s.id === own.id)).toBeDefined();
      expect(studentSees.find((s) => s.id === other.id)).toBeUndefined();
    });

    it('non-DPO STAFF (e.g. teacher) sees no SARs (visibility falls through to FALSE)', async () => {
      await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      const teacherSees = await withTestTenant(async () => service.list(teacherActor()));
      expect(teacherSees).toHaveLength(0);
    });
  });

  describe('update (DPO-only, locked-row state machine)', () => {
    async function seedSar(): Promise<string> {
      const sar = await withTestTenant(async () =>
        service.create(adminActor(), {
          dataSubjectId: TEST_STUDENT_PERSON_ID,
          requestType: 'ACCESS',
        }),
      );
      return sar.id;
    }

    it('RECEIVED → IN_PROGRESS', async () => {
      const id = await seedSar();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'IN_PROGRESS' }),
      );
      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.completedAt).toBeNull();
    });

    it('RECEIVED → COMPLETED stamps completed_at', async () => {
      const id = await seedSar();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, {
          status: 'COMPLETED',
          responseS3Key: 's3://bucket/response.zip',
        }),
      );
      expect(updated.status).toBe('COMPLETED');
      expect(updated.completedAt).not.toBeNull();
      expect(updated.responseS3Key).toBe('s3://bucket/response.zip');
    });

    it('RECEIVED → DENIED stamps completed_at + denial_reason', async () => {
      const id = await seedSar();
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, {
          status: 'DENIED',
          denialReason: 'Not the data subject',
        }),
      );
      expect(updated.status).toBe('DENIED');
      expect(updated.completedAt).not.toBeNull();
      expect(updated.denialReason).toBe('Not the data subject');
    });

    it('COMPLETED is terminal — further updates rejected with BadRequestException', async () => {
      const id = await seedSar();
      await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'COMPLETED' }),
      );
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), id, { status: 'IN_PROGRESS' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('DENIED is terminal — further updates rejected with BadRequestException', async () => {
      const id = await seedSar();
      await withTestTenant(async () =>
        service.update(adminActor(), id, { status: 'DENIED', denialReason: 'x' }),
      );
      await expect(
        withTestTenant(async () =>
          service.update(adminActor(), id, { notes: 'changed mind' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('extension_until + extension_reason can be applied', async () => {
      const id = await seedSar();
      const future = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const updated = await withTestTenant(async () =>
        service.update(adminActor(), id, {
          status: 'EXTENSION_REQUESTED',
          extensionUntil: future,
          extensionReason: 'Volume of records requires extension',
        }),
      );
      expect(updated.status).toBe('EXTENSION_REQUESTED');
      expect(updated.extensionUntil).toBeTruthy();
      expect(updated.extensionReason).toBe('Volume of records requires extension');
      // Verify the stored DATE is exactly the requested ISO date
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT extension_until::text AS d FROM ${TEST_SCHEMA}.dpo_subject_access_requests WHERE id = $1::uuid`,
        id,
      )) as Array<{ d: string }>;
      expect(rows[0]!.d).toBe(future);
    });

    it('empty patch is a no-op (no UPDATE issued, current row returned)', async () => {
      const id = await seedSar();
      const updated = await withTestTenant(async () => service.update(adminActor(), id, {}));
      expect(updated.id).toBe(id);
      expect(updated.status).toBe('RECEIVED');
    });

    it('missing SAR → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.update(adminActor(), generateId(), { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update as non-DPO → ForbiddenException', async () => {
      const id = await seedSar();
      await expect(
        withTestTenant(async () => service.update(officerActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.update(studentActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => service.update(parentActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school update → NotFoundException', async () => {
      const id = await seedSar();
      await expect(
        withTestTenantB(async () => service.update(adminActor(), id, { notes: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cross-school isolation', () => {
    it('SAR seeded in School B not visible to School A admin (list + getById)', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.dpo_subject_access_requests
           (id, school_id, data_subject_id, requested_by, request_type, deadline_date, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', CURRENT_DATE + INTERVAL '30 days', 'RECEIVED')`,
        id,
        TEST_SCHOOL_B_ID,
        TEST_STUDENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      const aList = await withTestTenant(async () => service.list(adminActor()));
      expect(aList.find((s) => s.id === id)).toBeUndefined();
      await expect(
        withTestTenant(async () => service.getById(adminActor(), id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
