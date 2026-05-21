import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ReunificationService } from '@modules/m87-safety/reunification/reunification.service';
import { AccountabilityService } from '@modules/m87-safety/reunification/accountability.service';
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
  TEST_OFFICER_ACCOUNT_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';

/**
 * DB-backed integration tests for ReunificationService — student
 * release-to-verified-adult workflow during active incidents.
 *
 * NOTE: The service's SELECT_REUN_BASE references `sis_students.first_name`,
 * a column the tenant migration set does NOT add (sis_students sources
 * student names from platform_students via platform_student_id). The
 * happy-path / reload-after-write tests therefore exercise a SQL
 * `column does not exist` error in the current service. The tests below
 * cover the validation paths that fail BEFORE the broken SELECT is
 * reached, plus assertReceptionStaff. Fixing the JOIN is a separate
 * service change.
 */
describe('integration:m87-safety/reunification', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let accountability: AccountabilityService;
  let service: ReunificationService;

  // Reusable test student + visitor + visitor_type
  const visitorTypeId = '019e3ad0-1234-5678-9abc-def000000001';

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    accountability = new AccountabilityService(tenantPrisma, permCheck);
    service = new ReunificationService(tenantPrisma, permCheck, accountability);

    // Visitor type used by all seeded visitors
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
         (id, school_id, name, requires_safeguarding_check, badge_color, is_active)
       VALUES ($1::uuid, $2::uuid, 'TEST-Parent', false, 'green', true)
       ON CONFLICT (id) DO NOTHING`,
      visitorTypeId,
      TEST_SCHOOL_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_visitor_types WHERE id = $1::uuid`,
      visitorTypeId,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe in FK-respecting order
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_corrections WHERE reunification_record_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_reunification_records)`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_reunification_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_summary WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_accountability_records WHERE incident_id IN
         (SELECT id FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // inc_incident_timeline is IMMUTABLE — TRUNCATE bypasses the
    // prevent_mutation trigger, which is the only safe per-test reset.
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.inc_incident_timeline`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_declaration_outbox WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.inc_incidents WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_sign_ins WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.vis_visitors WHERE school_id IN ($1::uuid, $2::uuid) AND first_name LIKE 'Reun-%'`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'REUN-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE first_name LIKE 'ReunStu%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE first_name LIKE 'ReunStu%'`,
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

  async function seedIncident(
    school = TEST_SCHOOL_ID,
    status: 'ACTIVE' | 'RESOLVED' = 'ACTIVE',
  ): Promise<string> {
    const id = generateId();
    const typeRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.inc_incident_types WHERE school_id IS NULL AND is_active = true LIMIT 1`,
    )) as Array<{ id: string }>;
    let typeId = typeRows[0]?.id;
    if (!typeId) {
      typeId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_incident_types (id, school_id, code, name, severity, is_active)
         VALUES ($1::uuid, NULL, 'TST-REUN', 'Test', 'HIGH', true)
         ON CONFLICT DO NOTHING`,
        typeId,
      );
    }
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.inc_incidents
         (id, school_id, incident_type_id, title, declared_by, declared_at, status, description)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Test', $4::uuid, now(), $5, 'Test')`,
      id,
      school,
      typeId,
      TEST_ADMIN_ACCOUNT_ID,
      status,
    );
    return id;
  }

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'ReunStu', $2, 'STUDENT', true)`,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'ReunStu', $3, true)`,
      platformStudentId,
      personId,
      'Test-' + suffix,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, school_id, platform_student_id, student_number, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ENROLLED')`,
      studentId,
      TEST_SCHOOL_ID,
      platformStudentId,
      'REUN-' + suffix,
    );
    return studentId;
  }

  async function seedVisitor(opts: { signedIn?: boolean; school?: string } = {}): Promise<{
    visitorId: string;
    signInId: string | null;
  }> {
    const visitorId = generateId();
    const school = opts.school ?? TEST_SCHOOL_ID;
    const suffix = generateId().slice(-8);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.vis_visitors
         (id, school_id, visitor_type_id, first_name, last_name, email_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Reun-V', $4, $5)`,
      visitorId,
      school,
      visitorTypeId,
      'Test-' + suffix,
      'hash-' + suffix,
    );
    let signInId: string | null = null;
    if (opts.signedIn !== false) {
      signInId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.vis_sign_ins
           (id, school_id, visitor_id, signed_in_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
        signInId,
        school,
        visitorId,
      );
    }
    return { visitorId, signInId };
  }

  describe('create — happy paths', () => {
    it('happy path: releases student, flips accountability to ACCOUNTED_FOR, appends timeline', async () => {
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();
      // Seed UNKNOWN accountability record so we test the UPDATE branch
      const accRecordId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.inc_accountability_records
           (id, incident_id, person_id, person_type, status, last_updated_by, last_updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'STUDENT', 'UNKNOWN', $4::uuid, now())`,
        accRecordId,
        incidentId,
        studentId,
        TEST_ADMIN_ACCOUNT_ID,
      );

      const result = await withTestTenant(async () =>
        service.create(
          incidentId,
          { studentId, releasedToId: visitorId, notes: 'Parent collected at 14:30' },
          adminActor(),
        ),
      );
      expect(result.studentId).toBe(studentId);
      expect(result.releasedToId).toBe(visitorId);

      // Accountability flipped to ACCOUNTED_FOR
      const accRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.inc_accountability_records WHERE id = $1::uuid`,
        accRecordId,
      )) as Array<{ status: string }>;
      expect(accRows[0]!.status).toBe('ACCOUNTED_FOR');

      // Timeline appended
      const timelineRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.inc_incident_timeline
          WHERE incident_id = $1::uuid AND event_type = 'REUNIFICATION'`,
        incidentId,
      )) as Array<{ n: number }>;
      expect(timelineRows[0]!.n).toBe(1);
    });

    it('happy path: creates ACCOUNTED_FOR record when no prior accountability row exists', async () => {
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();

      await withTestTenant(async () =>
        service.create(incidentId, { studentId, releasedToId: visitorId }, adminActor()),
      );

      // A new accountability record was inserted by the service
      const accRows = (await rawClient.$queryRawUnsafe(
        `SELECT status, person_type FROM ${TEST_SCHEMA}.inc_accountability_records
          WHERE incident_id = $1::uuid AND person_id = $2::uuid`,
        incidentId,
        studentId,
      )) as Array<{ status: string; person_type: string }>;
      expect(accRows.length).toBeGreaterThanOrEqual(1);
      expect(accRows[0]!.status).toBe('ACCOUNTED_FOR');
    });

    it('officer with saf-001:write can create', async () => {
      await grantOfficer(['saf-001:write']);
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();
      const result = await withTestTenant(async () =>
        service.create(incidentId, { studentId, releasedToId: visitorId }, officerActor()),
      );
      expect(result.id).toBeTruthy();
    });
  });

  describe('create — validation paths', () => {
    it('non-reception staff → Forbidden', async () => {
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: visitorId }, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: visitorId }, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: visitorId }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing incident → NotFound', async () => {
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();
      await expect(
        withTestTenant(async () =>
          service.create(generateId(), { studentId, releasedToId: visitorId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-ACTIVE incident → BadRequest', async () => {
      // Seed an incident then explicitly flip status to RESOLVED.
      const incidentId = await seedIncident();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.inc_incidents SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2::uuid WHERE id = $1::uuid`,
        incidentId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor();
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: visitorId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('student not in tenant → BadRequest', async () => {
      const incidentId = await seedIncident();
      const { visitorId } = await seedVisitor();
      await expect(
        withTestTenant(async () =>
          service.create(
            incidentId,
            { studentId: generateId(), releasedToId: visitorId },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('releasedToId not a visitor in this school → BadRequest', async () => {
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: generateId() }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('visitor signed out (no active sign-in) → BadRequest', async () => {
      const incidentId = await seedIncident();
      const studentId = await seedStudent();
      const { visitorId } = await seedVisitor({ signedIn: false });
      await expect(
        withTestTenant(async () =>
          service.create(incidentId, { studentId, releasedToId: visitorId }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('correct — validation paths', () => {
    // The correct() path's reload also hits the broken SELECT, so the
    // happy-path tests are blocked. The validation paths below fail
    // before the reload.
    it('missing reunification → NotFound', async () => {
      await expect(
        withTestTenant(async () =>
          service.correct(
            generateId(),
            {
              correctionReason: 'A perfectly long enough correction reason for this test.',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-reception staff → Forbidden (asserted before NotFound)', async () => {
      await expect(
        withTestTenant(async () =>
          service.correct(
            generateId(),
            {
              correctionReason: 'A perfectly long enough correction reason for this test.',
            },
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('correction reason < 20 chars → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.correct(generateId(), { correctionReason: 'too short' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('empty correction reason → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          service.correct(generateId(), { correctionReason: '' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('listForIncident', () => {
    it('missing incident → NotFound', async () => {
      await expect(
        withTestTenant(async () => service.listForIncident(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school incident → NotFound', async () => {
      const incidentBId = await seedIncident(TEST_SCHOOL_B_ID);
      await expect(
        withTestTenant(async () => service.listForIncident(incidentBId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
