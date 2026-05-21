import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { ClubsController } from '@modules/m64-clubs/clubs/clubs.controller';
import { ActivityService } from '@modules/m64-clubs/activities/activity.service';
import { ScheduleService } from '@modules/m64-clubs/activities/schedule.service';
import { ServiceProgrammeService } from '@modules/m64-clubs/activities/service-programme.service';
import { ServiceHourService } from '@modules/m64-clubs/activities/service-hour.service';
import { MembershipService } from '@modules/m64-clubs/clubs/membership.service';
import { FieldTripService } from '@modules/m64-clubs/field-trips/field-trip.service';
import { ConsentService } from '@modules/m64-clubs/field-trips/consent.service';
import { ChaperoneService } from '@modules/m64-clubs/field-trips/chaperone.service';
import { ElectionService } from '@modules/m64-clubs/elections/election.service';
import { VoteService } from '@modules/m64-clubs/elections/vote.service';
import { type ActorContextService, type ResolvedActor } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { seedStudent, ensureGuardianForPerson, linkStudentGuardian } from '../m20-sis/sis-helpers';
import {
  resetClubsAndStudents,
  ensureClubsSeed,
  TEST_ACTIVITY_TYPE_SPORT_ID,
  TEST_ACTIVITY_TYPE_ARTS_ID,
  TEST_ACTIVITY_A_ID,
  TEST_PROGRAMME_A_ID,
} from '../fixtures/clubs';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

/**
 * Wave 7 — m64-clubs controller surface.
 *
 * Exercises every ClubsController method using stub actor contexts so
 * each persona's path is touched. Service-level branches are covered
 * by the sibling clubs.spec.ts / elections.spec.ts / field-trips.spec.ts
 * suites; this file's job is to push request bodies through the
 * controller layer and assert it threads them to the service correctly.
 */
class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

describe('integration:m64-clubs/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: ClubsController;
  let actorStub: SwitchingActorContext;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const kafka = makeRecordingKafka();

    const activities = new ActivityService(tenantPrisma);
    const schedules = new ScheduleService(tenantPrisma, activities);
    const memberships = new MembershipService(tenantPrisma, activities);
    const fieldTrips = new FieldTripService(tenantPrisma);
    const consent = new ConsentService(tenantPrisma, kafka);
    const chaperones = new ChaperoneService(tenantPrisma);
    const elections = new ElectionService(tenantPrisma, kafka);
    const votes = new VoteService(tenantPrisma);
    const programmes = new ServiceProgrammeService(tenantPrisma);
    const hours = new ServiceHourService(tenantPrisma);

    actorStub = new SwitchingActorContext();
    ctl = new ClubsController(
      activities,
      memberships,
      schedules,
      fieldTrips,
      consent,
      chaperones,
      elections,
      votes,
      programmes,
      hours,
      actorStub as unknown as ActorContextService,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetClubsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    actorStub.current = adminActor();
  });

  function adminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
  }
  function studentReq(): any {
    return {
      user: {
        sub: TEST_STUDENT_ACCOUNT_ID,
        personId: TEST_STUDENT_PERSON_ID,
        email: 'student@test',
        displayName: 'Student',
        sessionId: 'sess',
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
  }
  function parentReq(): any {
    return {
      user: {
        sub: TEST_PARENT_ACCOUNT_ID,
        personId: TEST_PARENT_PERSON_ID,
        email: 'parent@test',
        displayName: 'Parent',
        sessionId: 'sess',
      },
      headers: { 'x-forwarded-for': '198.51.100.10, 10.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
  }

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Lazy: keep the same studentActor.personId tied to a real sis_students
   * row for tests that need self-service paths.
   */
  async function linkStudentToPerson(personId: string): Promise<string> {
    const existingPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      personId,
    )) as Array<{ id: string }>;
    let psId: string;
    if (existingPs.length > 0) {
      psId = existingPs[0]!.id;
    } else {
      const newPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES (gen_random_uuid(), $1::uuid, 'CL', 'Stu', true)
         RETURNING id::text AS id`,
        personId,
      )) as Array<{ id: string }>;
      psId = newPs[0]!.id;
      platformStudentIds.push(psId);
    }
    const existing = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      psId,
      TEST_SCHOOL_ID,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return existing[0]!.id;
    const stu = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '5', 'ENROLLED')
       RETURNING id::text AS id`,
      psId,
      TEST_SCHOOL_ID,
      'CTL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    )) as Array<{ id: string }>;
    studentIds.push(stu[0]!.id);
    return stu[0]!.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // Activity types + activities
  // ─────────────────────────────────────────────────────────────────
  it('activity types: list + create', async () => {
    const list = await withTestTenant(async () => ctl.listTypes());
    expect(list.map((t) => t.id)).toContain(TEST_ACTIVITY_TYPE_SPORT_ID);

    const incInactive = await withTestTenant(async () => ctl.listTypes('true'));
    expect(incInactive.length).toBeGreaterThanOrEqual(list.length);

    const created = await withTestTenant(async () =>
      ctl.createType({ name: 'New Cat', category: 'ACADEMIC' } as any, adminReq()),
    );
    expect(created.name).toBe('New Cat');
  });

  it('activities: list + getById + create + patch', async () => {
    const list = await withTestTenant(async () => ctl.listActivities());
    expect(list.map((a) => a.id)).toContain(TEST_ACTIVITY_A_ID);

    const filtered = await withTestTenant(async () =>
      ctl.listActivities('SPORT', 'ACTIVE', TEST_SIS_ACADEMIC_YEAR_ID),
    );
    expect(filtered.length).toBeGreaterThan(0);

    const got = await withTestTenant(async () => ctl.getActivity(TEST_ACTIVITY_A_ID));
    expect(got.id).toBe(TEST_ACTIVITY_A_ID);

    const created = await withTestTenant(async () =>
      ctl.createActivity(
        {
          activityTypeId: TEST_ACTIVITY_TYPE_ARTS_ID,
          name: 'New Drama Ctl',
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
        } as any,
        adminReq(),
      ),
    );
    expect(created.name).toBe('New Drama Ctl');

    const patched = await withTestTenant(async () =>
      ctl.patchActivity(
        TEST_ACTIVITY_A_ID,
        { name: 'New Name', status: 'INACTIVE' } as any,
        adminReq(),
      ),
    );
    expect(patched.name).toBe('New Name');
  });

  // ─────────────────────────────────────────────────────────────────
  // Membership endpoints
  // ─────────────────────────────────────────────────────────────────
  it('membership: join + add + patch + my-activities', async () => {
    const stuId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);

    // Self-join
    actorStub.current = studentActor();
    const joined = await withTestTenant(async () =>
      ctl.joinActivity(TEST_ACTIVITY_A_ID, { role: 'MEMBER' } as any, studentReq()),
    );
    expect(joined.studentId).toBe(stuId);

    const myAct = await withTestTenant(async () => ctl.listMyActivities(studentReq()));
    expect(myAct.length).toBe(1);

    // Admin add a different student
    actorStub.current = adminActor();
    const other = await trackedSeedStudent({ firstName: 'O' });
    const added = await withTestTenant(async () =>
      ctl.addMember(
        TEST_ACTIVITY_A_ID,
        { studentId: other.studentId, role: 'OFFICER' } as any,
        adminReq(),
      ),
    );
    expect(added.role).toBe('OFFICER');

    const patched = await withTestTenant(async () =>
      ctl.patchMember(added.id, { role: 'PRESIDENT' } as any, adminReq()),
    );
    expect(patched.role).toBe('PRESIDENT');
  });

  // ─────────────────────────────────────────────────────────────────
  // Schedule endpoints
  // ─────────────────────────────────────────────────────────────────
  it('schedule: list + create + patch + remove', async () => {
    const list = await withTestTenant(async () => ctl.listSchedule(TEST_ACTIVITY_A_ID));
    expect(list).toEqual([]);

    const created = await withTestTenant(async () =>
      ctl.createSchedule(
        TEST_ACTIVITY_A_ID,
        { dayOfWeek: 3, startTime: '15:00', endTime: '16:00', location: 'Field' } as any,
        adminReq(),
      ),
    );
    expect(created.dayOfWeek).toBe(3);

    const patched = await withTestTenant(async () =>
      ctl.patchSchedule(created.id, { location: 'Gym' } as any, adminReq()),
    );
    expect(patched.location).toBe('Gym');

    await withTestTenant(async () => ctl.removeSchedule(created.id, adminReq()));
    const after = await withTestTenant(async () => ctl.listSchedule(TEST_ACTIVITY_A_ID));
    expect(after.length).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Field trips endpoints
  // ─────────────────────────────────────────────────────────────────
  it('field trips: list + getById + create + patch + addParticipant + consent-status', async () => {
    actorStub.current = adminActor();
    const created = await withTestTenant(async () =>
      ctl.createFieldTrip(
        {
          title: 'Ctl Trip',
          destination: 'Zoo',
          tripDate: '2027-06-15',
          consentDeadline: '2027-06-01',
        } as any,
        adminReq(),
      ),
    );
    expect(created.title).toBe('Ctl Trip');

    const list = await withTestTenant(async () => ctl.listFieldTrips(adminReq()));
    expect(list.map((t) => t.id)).toContain(created.id);

    const got = await withTestTenant(async () => ctl.getFieldTrip(created.id, adminReq()));
    expect(got.id).toBe(created.id);

    const patched = await withTestTenant(async () =>
      ctl.patchFieldTrip(created.id, { status: 'APPROVED' } as any, adminReq()),
    );
    expect(patched.status).toBe('APPROVED');

    const stu = await trackedSeedStudent();
    const part = await withTestTenant(async () =>
      ctl.addParticipant(created.id, { studentId: stu.studentId } as any, adminReq()),
    );
    expect(part.studentId).toBe(stu.studentId);

    const consentRows = await withTestTenant(async () =>
      ctl.getConsentStatus(created.id, adminReq()),
    );
    expect(consentRows.length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Consent endpoints
  // ─────────────────────────────────────────────────────────────────
  it('consent: sign + getMyConsent (parent path)', async () => {
    // Set up trip + child + parent guardian
    actorStub.current = adminActor();
    const trip = await withTestTenant(async () =>
      ctl.createFieldTrip(
        { title: 'Consent Trip', destination: 'Park', tripDate: '2027-07-01' } as any,
        adminReq(),
      ),
    );
    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
    );
    guardianIds.push(guardianId);
    const stu = await trackedSeedStudent({ firstName: 'Kid' });
    await linkStudentGuardian(rawClient, stu.studentId, guardianId);
    await withTestTenant(async () =>
      ctl.addParticipant(trip.id, { studentId: stu.studentId } as any, adminReq()),
    );

    actorStub.current = parentActor();
    const consent = await withTestTenant(async () =>
      ctl.signConsent(
        trip.id,
        { studentId: stu.studentId, consentGiven: true } as any,
        parentReq(),
      ),
    );
    expect(consent.consentGiven).toBe(true);
    // x-forwarded-for parsed correctly
    expect(consent.ipAddress).toBe('198.51.100.10');

    const got = await withTestTenant(async () =>
      ctl.getMyConsent(trip.id, stu.studentId, parentReq()),
    );
    expect(got!.id).toBe(consent.id);
  });

  it('consent: sign with no x-forwarded-for falls back to socket', async () => {
    actorStub.current = adminActor();
    const trip = await withTestTenant(async () =>
      ctl.createFieldTrip(
        { title: 'IP Trip', destination: 'X', tripDate: '2027-07-02' } as any,
        adminReq(),
      ),
    );
    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
    );
    guardianIds.push(guardianId);
    const stu = await trackedSeedStudent({ firstName: 'Kid2' });
    await linkStudentGuardian(rawClient, stu.studentId, guardianId);
    await withTestTenant(async () =>
      ctl.addParticipant(trip.id, { studentId: stu.studentId } as any, adminReq()),
    );

    actorStub.current = parentActor();
    const req = parentReq();
    req.headers = {}; // remove x-forwarded-for
    const consent = await withTestTenant(async () =>
      ctl.signConsent(trip.id, { studentId: stu.studentId, consentGiven: false } as any, req),
    );
    expect(consent.ipAddress).toBe('127.0.0.1');
  });

  // ─────────────────────────────────────────────────────────────────
  // Chaperones
  // ─────────────────────────────────────────────────────────────────
  it('chaperones: add + patch', async () => {
    actorStub.current = adminActor();
    const trip = await withTestTenant(async () =>
      ctl.createFieldTrip(
        { title: 'Chap Trip', destination: 'X', tripDate: '2027-07-03' } as any,
        adminReq(),
      ),
    );
    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
    );
    guardianIds.push(guardianId);
    const chap = await withTestTenant(async () =>
      ctl.addChaperone(trip.id, { personId: TEST_PARENT_PERSON_ID } as any, adminReq()),
    );
    expect(chap.personId).toBe(TEST_PARENT_PERSON_ID);

    const patched = await withTestTenant(async () =>
      ctl.patchChaperone(
        chap.id,
        { confirmed: true, backgroundCheckStatus: 'CLEARED' } as any,
        adminReq(),
      ),
    );
    expect(patched.confirmed).toBe(true);
    expect(patched.backgroundCheckStatus).toBe('CLEARED');
  });

  // ─────────────────────────────────────────────────────────────────
  // Elections + voting endpoints
  // ─────────────────────────────────────────────────────────────────
  it('elections: list + getById + create + patch + registerCandidate + canVote + castVote + results', async () => {
    actorStub.current = adminActor();
    const election = await withTestTenant(async () =>
      ctl.createElection(
        {
          title: 'Ctl Election',
          votingStart: new Date(Date.now() - 60 * 1000).toISOString(),
          votingEnd: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          eligibleVotersFilter: { all: true },
        } as any,
        adminReq(),
      ),
    );

    const list = await withTestTenant(async () => ctl.listElections());
    expect(list.map((e) => e.id)).toContain(election.id);

    const got = await withTestTenant(async () => ctl.getElection(election.id));
    expect(got.id).toBe(election.id);

    // DRAFT → OPEN
    const opened = await withTestTenant(async () =>
      ctl.patchElection(election.id, { status: 'OPEN' } as any, adminReq()),
    );
    expect(opened.status).toBe('OPEN');

    // Self-register candidate
    const stuId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    actorStub.current = studentActor();
    const cand = await withTestTenant(async () =>
      ctl.registerCandidate(election.id, { studentId: stuId, position: 'P' } as any, studentReq()),
    );
    // Admin approves the candidate so the vote will succeed
    actorStub.current = adminActor();
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.ext_candidates SET is_approved = true WHERE id = $1::uuid`,
      cand.id,
    );

    actorStub.current = studentActor();
    const can = await withTestTenant(async () => ctl.canVote(election.id, studentReq()));
    expect(can.canVote).toBe(true);

    const voted = await withTestTenant(async () =>
      ctl.castVote(election.id, { position: 'P', candidateId: cand.id } as any, studentReq()),
    );
    expect(voted.status).toBe('CAST');

    // Close + publish results
    actorStub.current = adminActor();
    await withTestTenant(async () =>
      ctl.patchElection(election.id, { status: 'CLOSED' } as any, adminReq()),
    );
    await withTestTenant(async () =>
      ctl.patchElection(election.id, { status: 'RESULTS_PUBLISHED' } as any, adminReq()),
    );
    const results = await withTestTenant(async () => ctl.getResults(election.id));
    expect(results.status).toBe('RESULTS_PUBLISHED');
    // Only 1 voter, default min_votes_for_results=5 → suppressed
    expect(results.resultsSuppressed).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Service programmes + service hours
  // ─────────────────────────────────────────────────────────────────
  it('service programmes: list + getById + create + leaderboard', async () => {
    actorStub.current = adminActor();
    const list = await withTestTenant(async () => ctl.listProgrammes());
    expect(list.map((p) => p.id)).toContain(TEST_PROGRAMME_A_ID);
    const includeInactive = await withTestTenant(async () => ctl.listProgrammes('true'));
    expect(includeInactive.length).toBeGreaterThanOrEqual(list.length);

    const got = await withTestTenant(async () => ctl.getProgramme(TEST_PROGRAMME_A_ID));
    expect(got.id).toBe(TEST_PROGRAMME_A_ID);

    const created = await withTestTenant(async () =>
      ctl.createProgramme(
        {
          name: 'Ctl Prog',
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
          targetHours: 5,
        } as any,
        adminReq(),
      ),
    );
    expect(created.name).toBe('Ctl Prog');

    const leaderboard = await withTestTenant(async () =>
      ctl.leaderboard(TEST_PROGRAMME_A_ID, adminReq()),
    );
    expect(Array.isArray(leaderboard)).toBe(true);
  });

  it('service hours: list + log + review + my-progress', async () => {
    const stuId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);

    // Student logs hours via controller
    actorStub.current = studentActor();
    const logged = await withTestTenant(async () =>
      ctl.logHours(
        {
          programmeId: TEST_PROGRAMME_A_ID,
          organisation: 'Org',
          description: 'Help',
          serviceDate: '2026-05-01',
          hours: 3,
        } as any,
        studentReq(),
      ),
    );
    expect(logged.organisation).toBe('Org');

    // Student lists own hours
    const stuList = await withTestTenant(async () => ctl.listHours(studentReq()));
    expect(stuList.length).toBe(1);

    // My progress
    const progress = await withTestTenant(async () => ctl.myProgress(studentReq()));
    expect(progress.length).toBe(1);
    expect(progress[0]!.pendingHours).toBe(3);

    // Admin reviews approval
    actorStub.current = adminActor();
    const approvalRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_service_hour_approvals WHERE service_hour_id = $1::uuid`,
      logged.id,
    )) as Array<{ id: string }>;
    const reviewed = await withTestTenant(async () =>
      ctl.reviewApproval(approvalRows[0]!.id, { status: 'APPROVED' } as any, adminReq()),
    );
    expect(reviewed.approvalStatus).toBe('APPROVED');

    // Admin list (staff sees all)
    const adminList = await withTestTenant(async () => ctl.listHours(adminReq()));
    expect(adminList.length).toBe(1);
  });
});
