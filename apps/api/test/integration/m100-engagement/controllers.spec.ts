import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EngagementController } from '@modules/m100-engagement/engagement.controller';
import { ConferenceEventService } from '@modules/m100-engagement/conference-event.service';
import { ConferenceSlotService } from '@modules/m100-engagement/conference-slot.service';
import { ConferenceBookingService } from '@modules/m100-engagement/conference-booking.service';
import { EngagementScoreService } from '@modules/m100-engagement/engagement-score.service';
import { ParentSurveyService } from '@modules/m100-engagement/parent-survey.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { type ActorContextService, type ResolvedActor } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';
import { resetEngagementTables } from '../fixtures/engagement';
import {
  seedStudent,
  linkStudentGuardian,
  ensureGuardianForPerson,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 7 — m100-engagement controller surface. Exercises every handler
 * through stub ActorContextService and verifies it forwards request
 * bodies to the underlying service correctly. Bodies are minimal — the
 * deeper service contracts are exercised by the other three specs.
 */
class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

describe('integration:m100-engagement/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: EngagementController;
  let actorStub: SwitchingActorContext;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const guardianIds: string[] = [];
  const personIds: string[] = [];
  const accountIds: string[] = [];
  const familyAccountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const events = new ConferenceEventService(tenantPrisma, permCheck);
    const slots = new ConferenceSlotService(tenantPrisma, permCheck);
    const bookings = new ConferenceBookingService(tenantPrisma, permCheck);
    const scores = new EngagementScoreService(tenantPrisma, permCheck);
    const surveys = new ParentSurveyService(tenantPrisma, permCheck, outbox);
    actorStub = new SwitchingActorContext();
    ctl = new EngagementController(
      actorStub as unknown as ActorContextService,
      events,
      slots,
      bookings,
      scores,
      surveys,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEngagementTables(rawClient, {
      familyAccountIds: familyAccountIds.splice(0),
    });
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    actorStub.current = adminActor();
  });

  function isoFuture(hours: number): string {
    return new Date(Date.now() + hours * 3600_000).toISOString();
  }
  function isoPast(hours: number): string {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }
  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  function adminReq(): any {
    return {
      user: { accountId: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_PERSON_ID },
    };
  }
  function parentReq(): any {
    return {
      user: { accountId: TEST_PARENT_ACCOUNT_ID, personId: TEST_PARENT_PERSON_ID },
    };
  }

  async function seedFamilyAccount(): Promise<string> {
    const id = generateId();
    // pay_family_accounts.UNIQUE(school_id, account_holder_id) — mint a
    // fresh holder iam_person each time so re-runs in the same suite
    // don't collide.
    const holderId = generateId();
    personIds.push(holderId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Ctl', 'Holder', 'GUARDIAN', true)`,
      holderId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      TEST_SCHOOL_ID,
      holderId,
      'CTL-FA-' + id.slice(0, 8),
    );
    familyAccountIds.push(id);
    return id;
  }

  async function seedStudentForParent(): Promise<string> {
    const student = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
    personIds.push(student.personId);
    platformStudentIds.push(student.platformStudentId);
    studentIds.push(student.studentId);
    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
      TEST_SCHOOL_ID,
    );
    guardianIds.push(guardianId);
    await linkStudentGuardian(rawClient, student.studentId, guardianId, { hasCustody: true });
    return student.studentId;
  }

  // ────────────────────────────────────────────────────────────────────
  describe('Conference endpoints', () => {
    it('createConference + listConferences + getConference + patchConference', async () => {
      const dto = await withTestTenant(async () =>
        ctl.createConference(adminReq(), {
          title: 'Fall PTC',
          startDate: dateFuture(7),
          endDate: dateFuture(8),
          bookingOpensAt: isoFuture(24),
          bookingClosesAt: isoFuture(72),
        } as any),
      );
      expect(dto.status).toBe('DRAFT');

      const list = await withTestTenant(async () => ctl.listConferences(adminReq()));
      expect(list.length).toBe(1);

      const dto2 = await withTestTenant(async () => ctl.getConference(adminReq(), dto.id));
      expect(dto2.id).toBe(dto.id);

      const patched = await withTestTenant(async () =>
        ctl.patchConference(adminReq(), dto.id, { title: 'Renamed' } as any),
      );
      expect(patched.title).toBe('Renamed');
    });

    it('listConferences with status filter', async () => {
      await withTestTenant(async () =>
        ctl.createConference(adminReq(), {
          title: 'PTC',
          startDate: dateFuture(7),
          endDate: dateFuture(8),
          bookingOpensAt: isoFuture(24),
          bookingClosesAt: isoFuture(72),
        } as any),
      );
      const list = await withTestTenant(async () => ctl.listConferences(adminReq(), 'DRAFT'));
      expect(list.every((e) => e.status === 'DRAFT')).toBe(true);
    });

    it('generateSlots + listSlots + getSlot + patchSlot', async () => {
      const evt = await withTestTenant(async () =>
        ctl.createConference(adminReq(), {
          title: 'PTC',
          startDate: dateFuture(7),
          endDate: dateFuture(8),
          bookingOpensAt: isoPast(2),
          bookingClosesAt: isoFuture(72),
        } as any),
      );
      // Move it to BOOKING_OPEN so generateSlots is allowed
      await withTestTenant(async () =>
        ctl.patchConference(adminReq(), evt.id, { status: 'BOOKING_OPEN' } as any),
      );
      const generated = await withTestTenant(async () =>
        ctl.generateSlots(adminReq(), evt.id, {
          teacherId: TEST_TEACHER_EMPLOYEE_ID,
          slotDate: dateFuture(7),
          startTime: '09:00',
          endTime: '09:30',
        } as any),
      );
      expect(generated.length).toBe(2);

      const list = await withTestTenant(async () =>
        ctl.listSlots(adminReq(), evt.id, undefined, 'true'),
      );
      expect(list.every((s) => s.status === 'AVAILABLE')).toBe(true);

      const byTeacher = await withTestTenant(async () =>
        ctl.listSlots(adminReq(), evt.id, TEST_TEACHER_EMPLOYEE_ID),
      );
      expect(byTeacher.length).toBe(2);

      const single = await withTestTenant(async () =>
        ctl.getSlot(adminReq(), generated[0]!.id),
      );
      expect(single.id).toBe(generated[0]!.id);

      const patched = await withTestTenant(async () =>
        ctl.patchSlot(adminReq(), generated[0]!.id, { notes: 'reserved' } as any),
      );
      expect(patched.notes).toBe('reserved');
    });

    it('bookSlot + myBookings + listBookings + getBooking + patchBooking + cancelBooking', async () => {
      const evt = await withTestTenant(async () =>
        ctl.createConference(adminReq(), {
          title: 'PTC',
          startDate: dateFuture(7),
          endDate: dateFuture(8),
          bookingOpensAt: isoPast(2),
          bookingClosesAt: isoFuture(72),
        } as any),
      );
      await withTestTenant(async () =>
        ctl.patchConference(adminReq(), evt.id, { status: 'BOOKING_OPEN' } as any),
      );
      const slotList = await withTestTenant(async () =>
        ctl.generateSlots(adminReq(), evt.id, {
          teacherId: TEST_TEACHER_EMPLOYEE_ID,
          slotDate: dateFuture(7),
          startTime: '09:00',
          endTime: '09:10',
        } as any),
      );
      const slotId = slotList[0]!.id;
      const studentId = await seedStudentForParent();

      actorStub.current = parentActor();
      const booking = await withTestTenant(async () =>
        ctl.bookSlot(parentReq(), slotId, { studentId } as any),
      );
      expect(booking.slotId).toBe(slotId);

      const mine = await withTestTenant(async () => ctl.myBookings(parentReq()));
      expect(mine.length).toBe(1);

      const seen = await withTestTenant(async () => ctl.getBooking(parentReq(), booking.id));
      expect(seen.id).toBe(booking.id);

      actorStub.current = adminActor();
      const list = await withTestTenant(async () =>
        ctl.listBookings(adminReq(), slotId, TEST_PARENT_ACCOUNT_ID, studentId),
      );
      expect(list.length).toBe(1);

      const patched = await withTestTenant(async () =>
        ctl.patchBooking(adminReq(), booking.id, { attended: true } as any),
      );
      expect(patched.attended).toBe(true);

      const cancelled = await withTestTenant(async () =>
        ctl.cancelBooking(adminReq(), booking.id, {} as any),
      );
      expect(cancelled.cancelledAt).not.toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  describe('Engagement score endpoints', () => {
    it('listScores + scoreSummary + familyScore', async () => {
      const fa = await seedFamilyAccount();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.eng_family_engagement_scores
           (id, school_id, family_account_id, score_date, composite_score,
            attendance_component, communication_component, conference_component,
            volunteer_component, payment_component, engagement_level, component_weights, computed_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, CURRENT_DATE,
                 90, 90, 90, 90, 90, 90, 'HIGHLY_ENGAGED', '{}'::jsonb, now())`,
        TEST_SCHOOL_ID,
        fa,
      );
      const list = await withTestTenant(async () => ctl.listScores(adminReq()));
      expect(list.length).toBe(1);

      const summary = await withTestTenant(async () => ctl.scoreSummary(adminReq()));
      expect(summary.totalFamilies).toBe(1);

      const fam = await withTestTenant(async () => ctl.familyScore(adminReq(), fa));
      expect(fam.length).toBe(1);
    });

    it('getScoreConfig + patchScoreConfig', async () => {
      const cfg = await withTestTenant(async () => ctl.getScoreConfig(adminReq()));
      expect(cfg.weights).toBeDefined();
      expect(cfg.thresholds).toBeDefined();

      const updated = await withTestTenant(async () =>
        ctl.patchScoreConfig(adminReq(), {
          thresholds: { highlyEngaged: 78, engaged: 52, minimal: 22 },
        } as any),
      );
      expect(updated.thresholds.highlyEngaged).toBe(78);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  describe('Survey endpoints', () => {
    it('createSurvey + listSurveys + getSurvey + patchSurvey + respondToSurvey + surveyResults', async () => {
      const created = await withTestTenant(async () =>
        ctl.createSurvey(adminReq(), {
          title: 'Sat',
          questions: [
            { id: 'q1', question_text: 'Rate', question_type: 'RATING_1_5' },
          ],
        } as any),
      );
      expect(created.status).toBe('DRAFT');

      const opened = await withTestTenant(async () =>
        ctl.patchSurvey(adminReq(), created.id, { status: 'OPEN' } as any),
      );
      expect(opened.status).toBe('OPEN');

      const list = await withTestTenant(async () => ctl.listSurveys(adminReq()));
      expect(list.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getSurvey(adminReq(), created.id));
      expect(got.id).toBe(created.id);

      actorStub.current = parentActor();
      const ack = await withTestTenant(async () =>
        ctl.respondToSurvey(parentReq(), created.id, { answers: { q1: 4 } } as any),
      );
      expect(ack.submitted).toBe(true);
      expect(ack.totalResponses).toBe(1);

      actorStub.current = adminActor();
      const r = await withTestTenant(async () => ctl.surveyResults(adminReq(), created.id));
      expect(r.totalResponses).toBe(1);
    });
  });
});
