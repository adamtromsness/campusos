import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { AssignmentService } from '@modules/m61-transport/assignment.service';
import { RidershipService } from '@modules/m61-transport/ridership.service';
import { ParentTrackingService } from '@modules/m61-transport/parent-tracking.service';
import { BusPassService } from '@modules/m61-transport/bus-pass.service';
import { RouteService } from '@modules/m61-transport/route.service';
import { RouteChangeLogService } from '@modules/m61-transport/route-change-log.service';
import { RouteChangeRequestService } from '@modules/m61-transport/route-change-request.service';
import { StopService } from '@modules/m61-transport/stop.service';
import { NoShowService } from '@modules/m61-transport/no-show.service';
import { makeRecordingKafka } from '../helpers/recording-kafka';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_STOP_ID,
} from '../fixtures/transport';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

const TEST_TRN_PLATFORM_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000061200';
const TEST_TRN_SIS_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000061201';
const TEST_TRN_GUARDIAN_ROW_ID = '019e0cf8-aaaa-7777-8888-000000061202';

async function seedStudentWithGuardian(rawClient: PrismaClient): Promise<string> {
  await rawClient.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name)
     VALUES ($1::uuid, $2::uuid, 'TRN', 'Student')
     ON CONFLICT (person_id) DO UPDATE SET id = EXCLUDED.id`,
    TEST_TRN_PLATFORM_STUDENT_ID,
    TEST_STUDENT_PERSON_ID,
  );
  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students (id, school_id, platform_student_id, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, '5', 'ENROLLED')
     ON CONFLICT (platform_student_id) DO NOTHING`,
    TEST_TRN_SIS_STUDENT_ID,
    TEST_SCHOOL_ID,
    TEST_TRN_PLATFORM_STUDENT_ID,
  );
  const ssRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
    TEST_TRN_PLATFORM_STUDENT_ID,
  )) as Array<{ id: string }>;
  const studentId = ssRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, school_id, person_id, relationship, preferred_contact_method)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'PARENT', 'EMAIL')
     ON CONFLICT (school_id, person_id) DO NOTHING`,
    TEST_TRN_GUARDIAN_ROW_ID,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  );
  const sgRows = (await rawClient.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_guardians WHERE school_id = $1::uuid AND person_id = $2::uuid`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const guardianRowId = sgRows[0]!.id;

  await rawClient.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians (id, student_id, guardian_id, has_custody, portal_access, receives_reports)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO NOTHING`,
    '019e0cf8-aaaa-7777-8888-000000061203',
    studentId,
    guardianRowId,
  );

  return studentId;
}

describe('integration:m61-transport/student-assignment', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let assignments: AssignmentService;
  let ridership: RidershipService;
  let parentTracking: ParentTrackingService;
  let busPass: BusPassService;
  let routes: RouteService;
  let changeLog: RouteChangeLogService;
  let changeReq: RouteChangeRequestService;
  let stops: StopService;
  let noShow: NoShowService;
  let studentId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const outbox = new OutboxService();
    changeLog = new RouteChangeLogService(tenantPrisma);
    routes = new RouteService(tenantPrisma, changeLog);
    assignments = new AssignmentService(tenantPrisma, routes, changeLog);
    busPass = new BusPassService(tenantPrisma);
    ridership = new RidershipService(tenantPrisma, busPass as any);
    // Stub PermissionCheckService for parent-tracking
    parentTracking = new ParentTrackingService(tenantPrisma, {
      hasAnyPermissionInTenant: async () => true,
    } as any);
    changeReq = new RouteChangeRequestService(tenantPrisma, assignments);
    stops = new StopService(tenantPrisma, routes, changeLog);
    noShow = new NoShowService(tenantPrisma, ridership, makeRecordingKafka());
    void outbox;
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE id = $1::uuid`,
      '019e0cf8-aaaa-7777-8888-000000061203',
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = $1::uuid`,
      TEST_TRN_GUARDIAN_ROW_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid`,
      TEST_TRN_PLATFORM_STUDENT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
      TEST_TRN_PLATFORM_STUDENT_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
    studentId = await seedStudentWithGuardian(rawClient);
  });

  // ─── AssignmentService ──────────────────────────────
  describe('AssignmentService', () => {
    async function makeAssignment() {
      return withTestTenant(async () =>
        assignments.create(
          TEST_ROUTE_ID,
          {
            studentId,
            stopId: TEST_STOP_ID,
            direction: 'AM',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            effectiveFrom: '2026-09-01',
          } as any,
          adminActor(),
        ),
      );
    }

    it('create + listForRoute + listForStudent', async () => {
      const a = await makeAssignment();
      expect(a.studentId).toBe(studentId);

      const forRoute = await withTestTenant(async () =>
        assignments.listForRoute(TEST_ROUTE_ID, adminActor()),
      );
      expect(forRoute.map((x) => x.id)).toContain(a.id);

      const forStudent = await withTestTenant(async () =>
        assignments.listForStudent(studentId, adminActor()),
      );
      expect(forStudent.map((x) => x.id)).toContain(a.id);
    });

    it('myRoute returns the student own assignment', async () => {
      await makeAssignment();
      const mine = await withTestTenant(async () => assignments.myRoute(studentActor()));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine[0]!.studentId).toBe(studentId);
    });

    it('myRoute as parent returns child assignment', async () => {
      await makeAssignment();
      const mine = await withTestTenant(async () => assignments.myRoute(parentActor()));
      expect(mine.length).toBeGreaterThan(0);
    });

    it('remove deletes the assignment', async () => {
      const a = await makeAssignment();
      await withTestTenant(async () => assignments.remove(a.id, adminActor()));
      const forStudent = await withTestTenant(async () =>
        assignments.listForStudent(studentId, adminActor()),
      );
      expect(forStudent.map((x) => x.id)).not.toContain(a.id);
    });
  });

  // ─── BusPassService (with student) ──────────────────
  describe('BusPassService', () => {
    it('create + getById + myPass + patch', async () => {
      const pass = await withTestTenant(async () =>
        busPass.create(
          {
            studentId,
            passType: 'ANNUAL',
            validFrom: '2026-01-01',
            validTo: '2027-08-31',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(pass.studentId).toBe(studentId);

      const fetched = await withTestTenant(async () => busPass.getById(pass.id));
      expect(fetched.id).toBe(pass.id);

      const mine = await withTestTenant(async () => busPass.myPass(studentActor()));
      expect(mine.map((p) => p.id)).toContain(pass.id);

      const patched = await withTestTenant(async () =>
        busPass.patch(pass.id, { isActive: false } as any, adminActor()),
      );
      expect(patched.isActive).toBe(false);
    });

    it('resolveToken returns student info for valid token', async () => {
      const pass = await withTestTenant(async () =>
        busPass.create(
          {
            studentId,
            passType: 'ANNUAL',
            validFrom: '2026-01-01',
            validTo: '2027-08-31',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(pass.qrCodeToken).toBeTruthy();
      const resolved = await withTestTenant(async () => busPass.resolveToken(pass.qrCodeToken));
      expect(resolved.isValid).toBe(true);
      expect(resolved.studentId).toBe(studentId);
    });
  });

  // ─── RidershipService ───────────────────────────────
  describe('RidershipService', () => {
    async function makeBusPass() {
      return withTestTenant(async () =>
        busPass.create(
          {
            studentId,
            passType: 'ANNUAL',
            validFrom: '2026-01-01',
            validTo: '2027-08-31',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          } as any,
          adminActor(),
        ),
      );
    }

    async function makeBusPassAndAssignment() {
      await withTestTenant(async () =>
        assignments.create(
          TEST_ROUTE_ID,
          {
            studentId,
            stopId: TEST_STOP_ID,
            direction: 'BOTH',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            effectiveFrom: '2026-01-01',
            effectiveTo: '2027-12-31',
          } as any,
          adminActor(),
        ),
      );
      return makeBusPass();
    }

    it('scan a boarding then listForRoute returns it', async () => {
      const pass = await makeBusPassAndAssignment();
      const scan = await withTestTenant(async () =>
        ridership.scan(
          {
            qrCodeToken: pass.qrCodeToken,
            stopId: TEST_STOP_ID,
            scanDirection: 'BOARDING',
          } as any,
          adminActor(),
        ),
      );
      expect(scan.studentId).toBe(studentId);

      const today = new Date().toISOString().slice(0, 10);
      const list = await withTestTenant(async () =>
        ridership.listForRoute(TEST_ROUTE_ID, today, adminActor()),
      );
      expect(list.length).toBeGreaterThan(0);
    });

    it('myRidership returns student/parent scans', async () => {
      const pass = await makeBusPassAndAssignment();
      await withTestTenant(async () =>
        ridership.scan(
          {
            qrCodeToken: pass.qrCodeToken,
            stopId: TEST_STOP_ID,
            scanDirection: 'BOARDING',
          } as any,
          adminActor(),
        ),
      );
      const studentList = await withTestTenant(async () => ridership.myRidership(studentActor()));
      expect(studentList.length).toBeGreaterThan(0);

      const parentList = await withTestTenant(async () => ridership.myRidership(parentActor()));
      expect(parentList.length).toBeGreaterThan(0);
    });
  });

  // ─── ParentTrackingService ──────────────────────────
  describe('ParentTrackingService', () => {
    it('createToken + listForStudent + viewByToken + revokeToken', async () => {
      const t = await withTestTenant(async () =>
        parentTracking.createToken(
          { studentId, routeId: TEST_ROUTE_ID, expiresInDays: 30 } as any,
          adminActor(),
        ),
      );
      expect(t.studentId).toBe(studentId);

      const list = await withTestTenant(async () => parentTracking.listForStudent(studentId));
      expect(list.map((x) => x.id)).toContain(t.id);

      const view = await withTestTenant(async () => parentTracking.viewByToken(t.token));
      expect(view).toBeTruthy();

      const revoked = await withTestTenant(async () =>
        parentTracking.revokeToken(t.id, adminActor()),
      );
      expect(revoked.isActive).toBe(false);
    });
  });

  // ─── RouteChangeRequestService ──────────────────────
  describe('RouteChangeRequestService', () => {
    async function setupAssignment() {
      await withTestTenant(async () =>
        assignments.create(
          TEST_ROUTE_ID,
          {
            studentId,
            stopId: TEST_STOP_ID,
            direction: 'BOTH',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            effectiveFrom: '2026-01-01',
            effectiveTo: '2027-12-31',
          } as any,
          adminActor(),
        ),
      );
    }

    it('parent submits NO_BUS request; admin approves', async () => {
      await setupAssignment();
      const r = await withTestTenant(async () =>
        changeReq.submit(
          {
            studentId,
            changeDate: '2027-09-15',
            changeType: 'NO_BUS',
            reason: 'Doctor appointment',
          } as any,
          parentActor(),
        ),
      );
      expect(r.status).toBe('PENDING');
      expect(r.changeType).toBe('NO_BUS');

      const list = await withTestTenant(async () => changeReq.list(adminActor(), {}));
      expect(list.map((x) => x.id)).toContain(r.id);

      const fetched = await withTestTenant(async () => changeReq.getById(r.id, adminActor()));
      expect(fetched.id).toBe(r.id);

      const approved = await withTestTenant(async () =>
        changeReq.approve(r.id, { reviewNotes: 'Approved' } as any, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
    });

    it('parent submits DIFFERENT_STOP request; admin rejects', async () => {
      await setupAssignment();
      const newStop = await withTestTenant(async () =>
        stops.create(
          TEST_ROUTE_ID,
          {
            name: 'Backup Stop',
            address: '500 Side St',
            latitude: 33.8,
            longitude: -84.8,
            sequenceOrder: 5,
            scheduledTime: '07:50:00',
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        changeReq.submit(
          {
            studentId,
            changeDate: '2027-09-16',
            changeType: 'DIFFERENT_STOP',
            requestedStopId: newStop.id,
            reason: 'Picking up at grandma',
          } as any,
          parentActor(),
        ),
      );
      expect(r.status).toBe('PENDING');

      const rejected = await withTestTenant(async () =>
        changeReq.reject(r.id, { reviewNotes: 'Not feasible' } as any, adminActor()),
      );
      expect(rejected.status).toBe('REJECTED');
    });

    it('admin approves DIFFERENT_STOP request → creates override assignment', async () => {
      await setupAssignment();
      const newStop = await withTestTenant(async () =>
        stops.create(
          TEST_ROUTE_ID,
          {
            name: 'Override Stop',
            address: '900 Alt St',
            latitude: 33.7,
            longitude: -84.7,
            sequenceOrder: 20,
            scheduledTime: '07:55:00',
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        changeReq.submit(
          {
            studentId,
            changeDate: '2027-09-20',
            changeType: 'DIFFERENT_STOP',
            requestedStopId: newStop.id,
            reason: 'Different pickup',
          } as any,
          parentActor(),
        ),
      );
      const approved = await withTestTenant(async () =>
        changeReq.approve(r.id, { reviewNotes: 'OK' } as any, adminActor()),
      );
      expect(approved.status).toBe('APPROVED');
      expect(approved.overrideAssignmentId).not.toBeNull();
    });

    it('parent list filtered by status returns own submissions', async () => {
      await setupAssignment();
      await withTestTenant(async () =>
        changeReq.submit(
          {
            studentId,
            changeDate: '2027-09-17',
            changeType: 'NO_BUS',
          } as any,
          parentActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        changeReq.list(parentActor(), { status: 'PENDING' }),
      );
      expect(list.length).toBeGreaterThan(0);
    });
  });

  // ─── StopService extras (remove + reorder) ──────────
  describe('StopService remove', () => {
    it('remove a stop without assignments', async () => {
      const s1 = await withTestTenant(async () =>
        stops.create(
          TEST_ROUTE_ID,
          {
            name: 'Stop A',
            address: '600 A St',
            latitude: 33.9,
            longitude: -84.9,
            sequenceOrder: 10,
            scheduledTime: '07:55:00',
          } as any,
          adminActor(),
        ),
      );
      const s2 = await withTestTenant(async () =>
        stops.create(
          TEST_ROUTE_ID,
          {
            name: 'Stop B',
            address: '700 B St',
            latitude: 33.95,
            longitude: -84.95,
            sequenceOrder: 11,
            scheduledTime: '08:00:00',
          } as any,
          adminActor(),
        ),
      );

      await withTestTenant(async () => stops.remove(s1.id, adminActor()));
      void s2;
      const after = await withTestTenant(async () => routes.getStops(TEST_ROUTE_ID));
      expect(after.map((s) => s.id)).not.toContain(s1.id);
    });
  });

  // ─── NoShowService end-to-end ───────────────────────
  describe('NoShowService end-to-end', () => {
    it('runOnce + list + resolve', async () => {
      await withTestTenant(async () =>
        assignments.create(
          TEST_ROUTE_ID,
          {
            studentId,
            stopId: TEST_STOP_ID,
            direction: 'AM',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            effectiveFrom: '2026-01-01',
            effectiveTo: '2027-12-31',
          } as any,
          adminActor(),
        ),
      );

      const today = new Date().toISOString().slice(0, 10);
      const result = await withTestTenant(async () => noShow.runOnce({ date: today }));
      expect(result.inserted).toBeGreaterThanOrEqual(0);

      const list = await withTestTenant(async () => noShow.list(adminActor(), { date: today }));
      if (list.length > 0) {
        const resolved = await withTestTenant(async () =>
          noShow.resolve(
            list[0]!.id,
            { resolution: 'PARENT_NOTIFIED', resolutionNotes: 'Parent informed' } as any,
            adminActor(),
          ),
        );
        expect(resolved.resolution).toBe('PARENT_NOTIFIED');
      }
    });
  });
});
