import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { GroupsController } from '@modules/m103-groups/groups/groups.controller';
import { GroupsAdvancedController } from '@modules/m103-groups/groups/groups-advanced.controller';
import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { InvitationService } from '@modules/m103-groups/groups/invitation.service';
import { OwnershipTransferService } from '@modules/m103-groups/groups/ownership-transfer.service';
import { GroupAnalyticsService } from '@modules/m103-groups/groups/analytics.service';
import { GroupAnnouncementService } from '@modules/m103-groups/groups/group-announcement.service';
import { GroupEventService } from '@modules/m103-groups/events/group-event.service';
import { GroupMeetupService } from '@modules/m103-groups/events/meetup.service';
import { PollService } from '@modules/m103-groups/polls/poll.service';
import { ResourceLibraryService } from '@modules/m103-groups/resources/resource-library.service';
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
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import {
  resetGroupsAndStudents,
  ensureGroupsSeed,
  TEST_GROUP_OPEN_A_ID,
  TEST_GROUP_APPROVAL_A_ID,
  TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
} from '../fixtures/groups';
import { ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m103-groups controller surface. Exercises every controller
 * method through stub ActorContextService and verifies it forwards
 * request bodies to the service correctly.
 */
class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

describe('integration:m103-groups/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: GroupsController;
  let advCtl: GroupsAdvancedController;
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
    const groups = new GroupService(tenantPrisma);
    const memberships = new MembershipService(tenantPrisma, groups);
    const invitations = new InvitationService(tenantPrisma, groups);
    const transfers = new OwnershipTransferService(tenantPrisma, groups);
    const analytics = new GroupAnalyticsService(tenantPrisma, groups);
    const announcements = new GroupAnnouncementService(tenantPrisma, groups, kafka);
    const events = new GroupEventService(tenantPrisma, groups, kafka);
    const meetups = new GroupMeetupService(tenantPrisma, groups);
    const polls = new PollService(tenantPrisma, groups);
    const resources = new ResourceLibraryService(tenantPrisma, groups);
    actorStub = new SwitchingActorContext();
    ctl = new GroupsController(
      groups,
      memberships,
      transfers,
      announcements,
      events,
      actorStub as unknown as ActorContextService,
    );
    advCtl = new GroupsAdvancedController(
      polls,
      meetups,
      resources,
      invitations,
      analytics,
      actorStub as unknown as ActorContextService,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetGroupsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    await ensureGroupsSeed(rawClient);
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
        displayName: 'Stu',
        sessionId: 'sess',
      },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
  }

  async function ensureStudentInSchoolA(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES (gen_random_uuid(), $1::uuid, 'Stu', 'Linked', true)
       ON CONFLICT (person_id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    const psRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      TEST_STUDENT_PERSON_ID,
    );
    platformStudentIds.push(psRow[0]!.id);
    const stuRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '5', 'ENROLLED')
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id`,
      psRow[0]!.id,
      TEST_SCHOOL_ID,
      'CTL-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    );
    if (stuRow.length > 0) studentIds.push(stuRow[0]!.id);
  }

  describe('GroupsController', () => {
    it('list returns admin-visible groups', async () => {
      actorStub.current = adminActor();
      const list = await withTestTenant(async () => ctl.list(adminReq()));
      expect(list.length).toBeGreaterThanOrEqual(3);
    });

    it('list with filters threads through', async () => {
      const list = await withTestTenant(async () =>
        ctl.list(adminReq(), 'false', 'ACTIVE', 'SCHOOL'),
      );
      expect(list.every((g) => g.status === 'ACTIVE')).toBe(true);
    });

    it('listMine forwards onlyMine=true', async () => {
      const list = await withTestTenant(async () => ctl.listMine(adminReq()));
      expect(list.length).toBeGreaterThanOrEqual(3);
    });

    it('getById admin reads OPEN group', async () => {
      const dto = await withTestTenant(async () => ctl.getById(TEST_GROUP_OPEN_A_ID, adminReq()));
      expect(dto.id).toBe(TEST_GROUP_OPEN_A_ID);
    });

    it('create + patch admin lifecycle', async () => {
      const dto = await withTestTenant(async () =>
        ctl.create({ name: 'Ctl', scopeType: 'SCHOOL' } as any, adminReq()),
      );
      expect(dto.name).toBe('Ctl');
      const patched = await withTestTenant(async () =>
        ctl.patch(dto.id, { name: 'Renamed' } as any, adminReq()),
      );
      expect(patched.name).toBe('Renamed');
    });

    it('listMembers + listMyMemberships', async () => {
      const list = await withTestTenant(async () =>
        ctl.listMembers(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const mine = await withTestTenant(async () => ctl.listMyMemberships(adminReq()));
      expect(mine.length).toBeGreaterThanOrEqual(3);
    });

    it('join + leave (student joins OPEN, then leaves)', async () => {
      actorStub.current = studentActor();
      const m = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_OPEN_A_ID, {} as any, studentReq()),
      );
      expect(m.status).toBe('ACTIVE');
      const r = await withTestTenant(async () => ctl.leave(TEST_GROUP_OPEN_A_ID, studentReq()));
      expect(r.ok).toBe(true);
    });

    it('invite + acceptInvite via controller', async () => {
      await ensureStudentInSchoolA();
      actorStub.current = adminActor();
      const m = await withTestTenant(async () =>
        ctl.invite(TEST_GROUP_OPEN_A_ID, { personId: TEST_STUDENT_ACCOUNT_ID } as any, adminReq()),
      );
      expect(m.status).toBe('INVITED');
      actorStub.current = studentActor();
      const accepted = await withTestTenant(async () => ctl.acceptInvite(m.id, studentReq()));
      expect(accepted.status).toBe('ACTIVE');
    });

    it('declineInvite path', async () => {
      await ensureStudentInSchoolA();
      actorStub.current = adminActor();
      const m = await withTestTenant(async () =>
        ctl.invite(TEST_GROUP_OPEN_A_ID, { personId: TEST_STUDENT_ACCOUNT_ID } as any, adminReq()),
      );
      actorStub.current = studentActor();
      const r = await withTestTenant(async () => ctl.declineInvite(m.id, studentReq()));
      expect(r.ok).toBe(true);
    });

    it('approveJoin + denyJoin via controller', async () => {
      actorStub.current = studentActor();
      const pending = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_APPROVAL_A_ID, {} as any, studentReq()),
      );
      expect(pending.status).toBe('PENDING_APPROVAL');
      actorStub.current = adminActor();
      const approved = await withTestTenant(async () =>
        ctl.approveJoin(pending.id, { role: 'MEMBER' } as any, adminReq()),
      );
      expect(approved.status).toBe('ACTIVE');

      // Second pending → deny path
      actorStub.current = studentActor();
      // can't rejoin actively — only one row per (group, person). Leave first.
      await withTestTenant(async () => ctl.leave(TEST_GROUP_APPROVAL_A_ID, studentReq()));
      const pending2 = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_APPROVAL_A_ID, {} as any, studentReq()),
      );
      actorStub.current = adminActor();
      const r = await withTestTenant(async () => ctl.denyJoin(pending2.id, adminReq()));
      expect(r.ok).toBe(true);
    });

    it('updateRole + suspend + unsuspend + removeMember controller', async () => {
      actorStub.current = studentActor();
      const m = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_OPEN_A_ID, {} as any, studentReq()),
      );
      actorStub.current = adminActor();
      const promoted = await withTestTenant(async () =>
        ctl.updateRole(m.id, { role: 'ADMIN' } as any, adminReq()),
      );
      expect(promoted.role).toBe('ADMIN');
      const suspended = await withTestTenant(async () =>
        ctl.suspendMember(m.id, { reason: 'X' } as any, adminReq()),
      );
      expect(suspended.status).toBe('SUSPENDED');
      const unsuspended = await withTestTenant(async () => ctl.unsuspendMember(m.id, adminReq()));
      expect(unsuspended.status).toBe('ACTIVE');
      const r = await withTestTenant(async () => ctl.removeMember(m.id, adminReq()));
      expect(r.ok).toBe(true);
    });

    it('getPrefs + updatePrefs controller', async () => {
      const prefs = await withTestTenant(async () =>
        ctl.getPrefs(TEST_GROUP_OPEN_A_OWNER_MEMBER_ID, adminReq()),
      );
      expect(prefs.notifyAnnouncements).toBe(true);
      const updated = await withTestTenant(async () =>
        ctl.updatePrefs(
          TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
          { notifyAnnouncements: false } as any,
          adminReq(),
        ),
      );
      expect(updated.notifyAnnouncements).toBe(false);
    });

    it('transfers — list + listMyPendingTransfers + initiate + accept', async () => {
      actorStub.current = studentActor();
      const m = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_OPEN_A_ID, {} as any, studentReq()),
      );
      actorStub.current = adminActor();
      const t = await withTestTenant(async () =>
        ctl.initiateTransfer(TEST_GROUP_OPEN_A_ID, { toMemberId: m.id } as any, adminReq()),
      );
      expect(t.status).toBe('PENDING');
      const list = await withTestTenant(async () =>
        ctl.listTransfers(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      actorStub.current = studentActor();
      const mine = await withTestTenant(async () => ctl.listMyPendingTransfers(studentReq()));
      expect(mine.length).toBe(1);
      const accepted = await withTestTenant(async () => ctl.acceptTransfer(t.id, studentReq()));
      expect(accepted.status).toBe('ACCEPTED');
    });

    it('transfers — decline + cancel', async () => {
      actorStub.current = studentActor();
      const m = await withTestTenant(async () =>
        ctl.join(TEST_GROUP_OPEN_A_ID, {} as any, studentReq()),
      );
      actorStub.current = adminActor();
      const t1 = await withTestTenant(async () =>
        ctl.initiateTransfer(TEST_GROUP_OPEN_A_ID, { toMemberId: m.id } as any, adminReq()),
      );
      actorStub.current = studentActor();
      const declined = await withTestTenant(async () => ctl.declineTransfer(t1.id, studentReq()));
      expect(declined.status).toBe('DECLINED');

      // Initiate another to test cancel
      actorStub.current = adminActor();
      const t2 = await withTestTenant(async () =>
        ctl.initiateTransfer(TEST_GROUP_OPEN_A_ID, { toMemberId: m.id } as any, adminReq()),
      );
      const cancelled = await withTestTenant(async () => ctl.cancelTransfer(t2.id, adminReq()));
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('announcements — create + list + get + patch + read + delete', async () => {
      const created = await withTestTenant(async () =>
        ctl.createAnnouncement(
          TEST_GROUP_OPEN_A_ID,
          { title: 'Welcome', body: 'Hi' } as any,
          adminReq(),
        ),
      );
      expect(created.title).toBe('Welcome');
      const list = await withTestTenant(async () =>
        ctl.listAnnouncements(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getAnnouncement(created.id, adminReq()));
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        ctl.patchAnnouncement(created.id, { title: 'Renamed' } as any, adminReq()),
      );
      expect(patched.title).toBe('Renamed');
      const read = await withTestTenant(async () => ctl.readAnnouncement(created.id, adminReq()));
      expect(read.ok).toBe(true);
      const deleted = await withTestTenant(async () =>
        ctl.deleteAnnouncement(created.id, adminReq()),
      );
      expect(deleted.ok).toBe(true);
    });

    it('events — create + list + get + patch + rsvp + listMyRsvps + delete', async () => {
      const inFuture = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
      const created = await withTestTenant(async () =>
        ctl.createEvent(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'X',
            startsAt: inFuture(24),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminReq(),
        ),
      );
      expect(created.title).toBe('X');
      const list = await withTestTenant(async () =>
        ctl.listEvents(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getEvent(created.id, adminReq()));
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        ctl.patchEvent(created.id, { title: 'Renamed' } as any, adminReq()),
      );
      expect(patched.title).toBe('Renamed');
      const rsvp = await withTestTenant(async () =>
        ctl.rsvpEvent(created.id, { status: 'GOING' } as any, adminReq()),
      );
      expect(rsvp.myRsvp).toBe('GOING');
      const mine = await withTestTenant(async () => ctl.listMyRsvps(adminReq()));
      expect(mine.length).toBe(1);
      const r = await withTestTenant(async () => ctl.deleteEvent(created.id, adminReq()));
      expect(r.ok).toBe(true);
    });
  });

  describe('GroupsAdvancedController', () => {
    it('polls — list + create + vote + close', async () => {
      const created = await withTestTenant(async () =>
        advCtl.createPoll(
          TEST_GROUP_OPEN_A_ID,
          { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
          adminReq(),
        ),
      );
      expect(created.question).toBe('Q');
      const list = await withTestTenant(async () =>
        advCtl.listPolls(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const voted = await withTestTenant(async () =>
        advCtl.vote(created.id, { optionIds: [created.options[0]!.id] } as any, adminReq()),
      );
      expect(voted.hasVoted).toBe(true);
      const closed = await withTestTenant(async () => advCtl.closePoll(created.id, adminReq()));
      expect(closed.status).toBe('CLOSED');
    });

    it('meetups — list + create + patch + delete + rsvp', async () => {
      const inFuture = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
      const created = await withTestTenant(async () =>
        advCtl.createMeetup(
          TEST_GROUP_OPEN_A_ID,
          { title: 'M', eventDate: inFuture(24) } as any,
          adminReq(),
        ),
      );
      expect(created.title).toBe('M');
      const list = await withTestTenant(async () =>
        advCtl.listMeetups(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const patched = await withTestTenant(async () =>
        advCtl.patchMeetup(created.id, { title: 'M2' } as any, adminReq()),
      );
      expect(patched.title).toBe('M2');
      const rsvp = await withTestTenant(async () =>
        advCtl.rsvpMeetup(created.id, { status: 'CONFIRMED' } as any, adminReq()),
      );
      expect(rsvp.confirmedCount).toBe(1);
      const r = await withTestTenant(async () => advCtl.deleteMeetup(created.id, adminReq()));
      expect(r.ok).toBe(true);
    });

    it('resources — list + create + patch + addVersion + listVersions + delete', async () => {
      const created = await withTestTenant(async () =>
        advCtl.createResource(
          TEST_GROUP_OPEN_A_ID,
          { title: 'R', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
          adminReq(),
        ),
      );
      expect(created.title).toBe('R');
      const list = await withTestTenant(async () =>
        advCtl.listResources(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      const patched = await withTestTenant(async () =>
        advCtl.patchResource(created.id, { title: 'R2' } as any, adminReq()),
      );
      expect(patched.title).toBe('R2');
      const v2 = await withTestTenant(async () =>
        advCtl.addResourceVersion(created.id, { s3Key: 'v2' } as any, adminReq()),
      );
      expect(v2.versionNumber).toBe(2);
      const vlist = await withTestTenant(async () =>
        advCtl.listResourceVersions(created.id, adminReq()),
      );
      expect(vlist.length).toBe(1);
      const r = await withTestTenant(async () => advCtl.deleteResource(created.id, adminReq()));
      expect(r.ok).toBe(true);
    });

    it('invitations — list + create + listMine + respond + cancel', async () => {
      await ensureStudentInSchoolA();
      actorStub.current = adminActor();
      const inv = await withTestTenant(async () =>
        advCtl.createInvitation(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminReq(),
        ),
      );
      expect(inv.status).toBe('PENDING');
      const list = await withTestTenant(async () =>
        advCtl.listInvitations(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
      actorStub.current = studentActor();
      const mine = await withTestTenant(async () => advCtl.listMyInvitations(studentReq()));
      expect(mine.length).toBe(1);
      const responded = await withTestTenant(async () =>
        advCtl.respondInvitation(inv.id, { status: 'DECLINED' } as any, studentReq()),
      );
      expect(responded.status).toBe('DECLINED');

      // Cancel path on a fresh invite
      await ensureStudentInSchoolA();
      actorStub.current = adminActor();
      // Delete the responded row first
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.grp_group_invitations WHERE id = $1::uuid`,
        inv.id,
      );
      const inv2 = await withTestTenant(async () =>
        advCtl.createInvitation(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminReq(),
        ),
      );
      const cancelled = await withTestTenant(async () =>
        advCtl.cancelInvitation(inv2.id, adminReq()),
      );
      expect(cancelled.ok).toBe(true);
    });

    it('analytics — list + recompute', async () => {
      const recomputed = await withTestTenant(async () =>
        advCtl.recomputeAnalytics(TEST_GROUP_OPEN_A_ID, {} as any, adminReq()),
      );
      expect(recomputed.groupId).toBe(TEST_GROUP_OPEN_A_ID);
      const list = await withTestTenant(async () =>
        advCtl.listAnalytics(TEST_GROUP_OPEN_A_ID, adminReq()),
      );
      expect(list.length).toBe(1);
    });
  });
});
