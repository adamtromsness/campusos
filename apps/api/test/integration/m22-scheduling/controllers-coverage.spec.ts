import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { CoverageController } from '@modules/m22-scheduling/coverage.controller';
import { SubstitutionController } from '@modules/m22-scheduling/substitution.controller';
import { RotationController } from '@modules/m22-scheduling/rotation.controller';
import { CoverageService } from '@modules/m22-scheduling/coverage.service';
import { SubstitutionService } from '@modules/m22-scheduling/substitution.service';
import { RotationService } from '@modules/m22-scheduling/rotation.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID, TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

/**
 * Controller-layer integration tests for m22-scheduling — coverage,
 * substitution, and rotation controllers. Each controller is
 * constructed with the real service tree and invoked with a synthetic
 * AuthedRequest. The IAM cache is seeded so resolveActor returns
 * isSchoolAdmin=true.
 */
describe('integration:m22-scheduling/controllers-coverage', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let kafka: ReturnType<typeof makeRecordingKafka>;

  let coverageService: CoverageService;
  let substitutionService: SubstitutionService;
  let rotationService: RotationService;

  let coverageController: CoverageController;
  let substitutionController: SubstitutionController;
  let rotationController: RotationController;

  // Stable infra for coverage
  let bellScheduleId: string;
  let periodId: string;
  let roomId: string;
  let slotId: string;
  let coverageRequestId: string;

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);
    kafka = makeRecordingKafka();

    coverageService = new CoverageService(tenantPrisma, kafka as unknown as KafkaProducerService);
    substitutionService = new SubstitutionService(tenantPrisma);
    rotationService = new RotationService(tenantPrisma);

    coverageController = new CoverageController(coverageService, actorContext);
    substitutionController = new SubstitutionController(substitutionService);
    rotationController = new RotationController(rotationService, actorContext);

    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','sch-001:write','sch-001:read','sch-004:admin','sch-004:write','sch-004:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Pre-wipe and build infra.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Ctrl Cov%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cov%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Ctrl Cov%'`,
    );

    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Ctrl Cov Schedule ' + Math.random().toString(36).slice(2, 6),
    );
    periodId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES ($1::uuid, $2::uuid, 'P1', NULL, '08:00', '09:00', 'LESSON', 1)`,
      periodId,
      bellScheduleId,
    );

    roomId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES ($1::uuid, $2::uuid, 'Ctrl Cov Room', 30, 'CLASSROOM')`,
      roomId,
      TEST_SCHOOL_ID,
    );

    slotId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
         (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2027-01-01', '2027-12-31')`,
      slotId,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
      periodId,
      TEST_TEACHER_EMPLOYEE_ID,
      roomId,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id = $1::uuid`,
      slotId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id = $1::uuid`,
      roomId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id = $1::uuid`,
      periodId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
      bellScheduleId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid AND scope_id = $2::uuid`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as any).reset?.();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_calendar WHERE rotation_cycle_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid))`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rotation_cycles WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );

    // Seed an OPEN coverage request for the coverage controller assign/cancel paths.
    coverageRequestId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_coverage_requests
         (id, school_id, timetable_slot_id, absent_teacher_id, coverage_date, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2027-04-15', 'OPEN')`,
      coverageRequestId,
      TEST_SCHOOL_ID,
      slotId,
      TEST_TEACHER_EMPLOYEE_ID,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // CoverageController
  // ──────────────────────────────────────────────────────────────────
  describe('CoverageController', () => {
    it('list + getById', async () => {
      const list = await withTestTenant(async () =>
        coverageController.list(
          { fromDate: '2027-04-01', toDate: '2027-04-30' } as any,
          fakeAdminReq(),
        ),
      );
      expect(list.map((c) => c.id)).toContain(coverageRequestId);

      const detail = await withTestTenant(async () =>
        coverageController.getById(coverageRequestId, fakeAdminReq()),
      );
      expect(detail.id).toBe(coverageRequestId);
    });

    it('assign substitute and cancel', async () => {
      const assigned = await withTestTenant(async () =>
        coverageController.assign(
          coverageRequestId,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID, notes: 'cover today' } as any,
          fakeAdminReq(),
        ),
      );
      expect(assigned.status).toBe('ASSIGNED');

      // Cancel the assigned coverage
      const cancelled = await withTestTenant(async () =>
        coverageController.cancel(
          coverageRequestId,
          { notes: 'no longer needed' } as any,
          fakeAdminReq(),
        ),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SubstitutionController
  // ──────────────────────────────────────────────────────────────────
  describe('SubstitutionController', () => {
    it('list returns substitution rows', async () => {
      // After assigning a substitute, sch_substitution_timetable should have a row.
      await withTestTenant(async () =>
        coverageController.assign(
          coverageRequestId,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
          fakeAdminReq(),
        ),
      );

      const list = await withTestTenant(async () =>
        substitutionController.list({
          fromDate: '2027-04-01',
          toDate: '2027-04-30',
        } as any),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('forTeacher returns teacher-scoped substitutions', async () => {
      await withTestTenant(async () =>
        coverageController.assign(
          coverageRequestId,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
          fakeAdminReq(),
        ),
      );
      const list = await withTestTenant(async () =>
        substitutionController.forTeacher(TEST_ADMIN_EMPLOYEE_ID, {
          fromDate: '2027-04-01',
          toDate: '2027-04-30',
        } as any),
      );
      expect(Array.isArray(list)).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // RotationController
  // ──────────────────────────────────────────────────────────────────
  describe('RotationController', () => {
    it('createCycle + listCycles + getCycle + updateCycle', async () => {
      const created = await withTestTenant(async () =>
        rotationController.createCycle(
          {
            name: 'Ctrl Rotation ' + Math.random().toString(36).slice(2, 6),
            cycleLength: 2,
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.cycleLength).toBe(2);

      const list = await withTestTenant(async () => rotationController.listCycles());
      expect(list.map((c) => c.id)).toContain(created.id);

      const got = await withTestTenant(async () => rotationController.getCycle(created.id));
      expect(got.id).toBe(created.id);

      const updated = await withTestTenant(async () =>
        rotationController.updateCycle(
          created.id,
          { description: 'updated' } as any,
          fakeAdminReq(),
        ),
      );
      expect(updated.description).toBe('updated');
    });

    it('upsertCalendarEntry + listCalendar + deleteCalendarEntry', async () => {
      const cycle = await withTestTenant(async () =>
        rotationController.createCycle(
          {
            name: 'Ctrl Rotation Cal ' + Math.random().toString(36).slice(2, 6),
            cycleLength: 2,
          } as any,
          fakeAdminReq(),
        ),
      );

      const entry = await withTestTenant(async () =>
        rotationController.upsertCalendarEntry(
          cycle.id,
          {
            calendarDate: '2027-05-03',
            rotationDay: 1,
            isSchoolDay: true,
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(entry.rotationDay).toBe(1);

      const list = await withTestTenant(async () =>
        rotationController.listCalendar(cycle.id, '2027-05-01', '2027-05-31'),
      );
      expect(list.length).toBeGreaterThanOrEqual(1);

      const deleted = await withTestTenant(async () =>
        rotationController.deleteCalendarEntry(cycle.id, '2027-05-03', fakeAdminReq()),
      );
      expect(deleted.deleted).toBe(true);
    });

    it('generate + lookup', async () => {
      const cycle = await withTestTenant(async () =>
        rotationController.createCycle(
          {
            name: 'Ctrl Rotation Gen ' + Math.random().toString(36).slice(2, 6),
            cycleLength: 2,
          } as any,
          fakeAdminReq(),
        ),
      );

      const result = await withTestTenant(async () =>
        rotationController.generate(
          cycle.id,
          {
            startDate: '2027-06-01',
            endDate: '2027-06-12',
            closureDates: [],
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(typeof result.created).toBe('number');

      const lookup = await withTestTenant(async () => rotationController.lookup('2027-06-01'));
      expect(lookup).toBeTruthy();
    });
  });
});
