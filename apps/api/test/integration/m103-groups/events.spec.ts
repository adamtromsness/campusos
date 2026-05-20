import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { GroupEventService } from '@modules/m103-groups/events/group-event.service';
import { GroupMeetupService } from '@modules/m103-groups/events/meetup.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  resetGroupsAndStudents,
  ensureGroupsSeed,
  TEST_GROUP_OPEN_A_ID,
  TEST_GROUP_B_ID,
} from '../fixtures/groups';
import { ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m103-groups events suite. Covers GroupEventService
 * (CRUD + RSVP + max_attendees cap under FOR UPDATE + rsvp_deadline
 * gate + start-time gate + public/private read scope + Kafka
 * grp.event.created emit) AND GroupMeetupService (informal meetups
 * with CONFIRMED cap and PENDING state). Cross-school isolation.
 */
describe('integration:m103-groups/events', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let groups: GroupService;
  let memberships: MembershipService;
  let events: GroupEventService;
  let meetups: GroupMeetupService;
  let kafka: RecordingKafkaProducer;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    groups = new GroupService(tenantPrisma);
    memberships = new MembershipService(tenantPrisma, groups);
    const k = makeRecordingKafka();
    kafka = k;
    events = new GroupEventService(tenantPrisma, groups, k);
    meetups = new GroupMeetupService(tenantPrisma, groups);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await resetGroupsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    await ensureGroupsSeed(rawClient);
  });

  function inFuture(hours: number): string {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }
  function inPast(hours: number): string {
    return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }

  describe('GroupEventService — CRUD', () => {
    it('create: admin creates event AND emits grp.event.created', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'Practice',
            startsAt: inFuture(48),
            eventType: 'PRACTICE',
            requiresRsvp: true,
            isPublic: false,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Practice');
      expect(dto.eventType).toBe('PRACTICE');
      const calls = kafka.callsForTopic('grp.event.created');
      expect(calls.length).toBe(1);
      expect(calls[0]!.payload).toMatchObject({
        eventId: dto.id,
        groupId: TEST_GROUP_OPEN_A_ID,
        title: 'Practice',
      });
    });

    it('create: endsAt before startsAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            TEST_GROUP_OPEN_A_ID,
            {
              title: 'Bad',
              startsAt: inFuture(48),
              endsAt: inFuture(24),
              eventType: 'MEETING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: rsvpDeadline after startsAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            TEST_GROUP_OPEN_A_ID,
            {
              title: 'Bad',
              startsAt: inFuture(24),
              rsvpDeadline: inFuture(48),
              eventType: 'MEETING',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: non-positive maxAttendees → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            TEST_GROUP_OPEN_A_ID,
            {
              title: 'Bad',
              startsAt: inFuture(48),
              eventType: 'MEETING',
              maxAttendees: 0,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            TEST_GROUP_OPEN_A_ID,
            {
              title: 'Stu',
              startsAt: inFuture(48),
              eventType: 'MEETING',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForGroup: admin sees all; non-member sees only public', async () => {
      await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'Public',
            startsAt: inFuture(48),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'Private',
            startsAt: inFuture(72),
            eventType: 'MEETING',
            isPublic: false,
          } as any,
          adminActor(),
        ),
      );
      const adminList = await withTestTenant(async () =>
        events.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(adminList.length).toBe(2);
      const stuList = await withTestTenant(async () =>
        events.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
      );
      expect(stuList.length).toBe(1);
      expect(stuList[0]!.title).toBe('Public');
    });

    it('listForGroup: actor without personId → []', async () => {
      const list = await withTestTenant(async () =>
        events.listForGroup(TEST_GROUP_OPEN_A_ID, {
          ...adminActor(),
          personId: null,
        } as any),
      );
      expect(list).toEqual([]);
    });

    it('getById: existing — admin sees', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'X',
            startsAt: inFuture(24),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      const got = await withTestTenant(async () => events.getById(dto.id, adminActor()));
      expect(got.id).toBe(dto.id);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: actor without personId → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'X',
            startsAt: inFuture(24),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          events.getById(dto.id, { ...adminActor(), personId: null } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: non-member viewing private → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'Private',
            startsAt: inFuture(24),
            eventType: 'MEETING',
            isPublic: false,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => events.getById(dto.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: admin updates fields', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'X',
            startsAt: inFuture(24),
            eventType: 'MEETING',
          } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        events.patch(
          dto.id,
          {
            title: 'Renamed',
            description: 'updated',
            location: 'Gym',
            startsAt: inFuture(48),
            endsAt: inFuture(50),
            eventType: 'PRACTICE',
            requiresRsvp: true,
            rsvpDeadline: inFuture(40),
            maxAttendees: 25,
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.title).toBe('Renamed');
      expect(patched.maxAttendees).toBe(25);
      expect(patched.isPublic).toBe(true);
    });

    it('patch: no-op input returns existing DTO', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', startsAt: inFuture(24), eventType: 'MEETING' } as any,
          adminActor(),
        ),
      );
      const noop = await withTestTenant(async () => events.patch(dto.id, {} as any, adminActor()));
      expect(noop.id).toBe(dto.id);
    });

    it('patch: non-manager non-author → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', startsAt: inFuture(24), eventType: 'MEETING' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          events.patch(dto.id, { title: 'X' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove: admin deletes', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', startsAt: inFuture(24), eventType: 'MEETING' } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => events.remove(dto.id, adminActor()));
      expect(r.ok).toBe(true);
    });

    it('remove: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove: non-manager non-author → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', startsAt: inFuture(24), eventType: 'MEETING' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => events.remove(dto.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('GroupEventService — RSVP', () => {
    it('rsvp: admin GOING (no cap)', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'P',
            startsAt: inFuture(48),
            eventType: 'PRACTICE',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'GOING' } as any, adminActor()),
      );
      expect(r.goingCount).toBe(1);
      expect(r.myRsvp).toBe('GOING');
    });

    it('rsvp: at-capacity GOING blocked', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'P',
            startsAt: inFuture(48),
            eventType: 'PRACTICE',
            isPublic: true,
            maxAttendees: 1,
          } as any,
          adminActor(),
        ),
      );
      // admin going first — fills cap
      await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'GOING' } as any, adminActor()),
      );
      // student also tries to go (cap = 1)
      await expect(
        withTestTenant(async () =>
          events.rsvp(dto.id, { status: 'GOING' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rsvp: switching GOING → NOT_GOING releases the slot', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'P',
            startsAt: inFuture(48),
            eventType: 'PRACTICE',
            isPublic: true,
            maxAttendees: 1,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'GOING' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'NOT_GOING' } as any, adminActor()),
      );
      const r = await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'GOING' } as any, studentActor()),
      );
      expect(r.goingCount).toBe(1);
    });

    it('rsvp: rsvp_deadline passed → BadRequestException', async () => {
      // Insert event manually with deadline in the past but starts in future,
      // because the check constraint requires deadline <= starts_at and the
      // create() service rejects a past deadline anyway.
      const id = '019e0cf8-aaaa-7777-8888-000000103900';
      const startsAt = new Date(Date.now() + 6 * 3600_000);
      const deadline = new Date(Date.now() - 3600_000);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.grp_events (id, group_id, created_by, title, starts_at, event_type, requires_rsvp, rsvp_deadline, is_public)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'P', $4::timestamptz, 'PRACTICE', true, $5::timestamptz, true)`,
        id,
        TEST_GROUP_OPEN_A_ID,
        '019e0cf8-aaaa-7777-8888-000000000010', // admin person id
        startsAt.toISOString(),
        deadline.toISOString(),
      );
      await expect(
        withTestTenant(async () =>
          events.rsvp(id, { status: 'GOING' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rsvp: event already started → BadRequestException', async () => {
      const id = '019e0cf8-aaaa-7777-8888-000000103901';
      const startsAt = new Date(Date.now() - 3600_000);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.grp_events (id, group_id, created_by, title, starts_at, event_type, is_public)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'P', $4::timestamptz, 'PRACTICE', true)`,
        id,
        TEST_GROUP_OPEN_A_ID,
        '019e0cf8-aaaa-7777-8888-000000000010',
        startsAt.toISOString(),
      );
      await expect(
        withTestTenant(async () =>
          events.rsvp(id, { status: 'GOING' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rsvp: missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.rsvp(
            '00000000-0000-0000-0000-000000000000',
            { status: 'GOING' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rsvp: actor without personId → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'P',
            startsAt: inFuture(24),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          events.rsvp(dto.id, { status: 'GOING' } as any, {
            ...adminActor(),
            personId: null,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listMyRsvps: returns my upcoming RSVPs', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'X',
            startsAt: inFuture(48),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        events.rsvp(dto.id, { status: 'GOING' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => events.listMyRsvps(adminActor()));
      expect(list.length).toBe(1);
    });

    it('listMyRsvps: no personId → []', async () => {
      const list = await withTestTenant(async () =>
        events.listMyRsvps({ ...adminActor(), personId: null } as any),
      );
      expect(list).toEqual([]);
    });
  });

  describe('cross-school isolation', () => {
    it('create event on School B group from School A context → ForbiddenException', async () => {
      // events.create now calls assertGroupInCurrentSchool — School A
      // admin attempting to create on School B group is rejected at the
      // school-scope gate.
      await expect(
        withTestTenant(async () =>
          events.create(
            TEST_GROUP_B_ID,
            {
              title: 'Hack',
              startsAt: inFuture(48),
              eventType: 'MEETING',
              isPublic: true,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // From School B context — admin can create normally
      const dto = await withTestTenantB(async () =>
        events.create(
          TEST_GROUP_B_ID,
          {
            title: 'Legit',
            startsAt: inFuture(48),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.id).toBeDefined();
      // From School A — listForGroup on School B group → NotFound via getById
      await expect(
        withTestTenant(async () => events.listForGroup(TEST_GROUP_B_ID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById on School B event from School A context → NotFoundException', async () => {
      const dto = await withTestTenantB(async () =>
        events.create(
          TEST_GROUP_B_ID,
          {
            title: 'X',
            startsAt: inFuture(48),
            eventType: 'MEETING',
            isPublic: true,
          } as any,
          adminActor(),
        ),
      );
      // Pulling by id from School A — assertCanRead -> getById on group -> NotFound
      await expect(
        withTestTenant(async () => events.getById(dto.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('GroupMeetupService', () => {
    it('create: admin succeeds', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          {
            title: 'Pizza Night',
            eventDate: inFuture(72),
            location: 'Cafeteria',
            maxAttendees: 10,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Pizza Night');
      expect(dto.maxAttendees).toBe(10);
    });

    it('create: maxAttendees < 1 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.create(
            TEST_GROUP_OPEN_A_ID,
            { title: 'X', eventDate: inFuture(24), maxAttendees: 0 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: cross-school → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.create(
            TEST_GROUP_B_ID,
            { title: 'X', eventDate: inFuture(24) } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForGroup: admin sees all', async () => {
      await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'B', eventDate: inFuture(48) } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        meetups.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(list.length).toBe(2);
    });

    it('listForGroup: non-member → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => meetups.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: admin updates; no-op returns existing', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        meetups.patch(
          dto.id,
          {
            title: 'Renamed',
            description: 'd',
            eventDate: inFuture(48),
            location: 'Loc',
            maxAttendees: 5,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.title).toBe('Renamed');
      expect(patched.maxAttendees).toBe(5);

      const noop = await withTestTenant(async () => meetups.patch(dto.id, {} as any, adminActor()));
      expect(noop.id).toBe(dto.id);
    });

    it('patch: maxAttendees < 1 → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          meetups.patch(dto.id, { maxAttendees: 0 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: non-manager non-creator → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      await expect(
        withTestTenant(async () =>
          meetups.patch(dto.id, { title: 'Y' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove: admin deletes', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => meetups.remove(dto.id, adminActor()));
      expect(r.ok).toBe(true);
    });

    it('remove: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove: non-manager non-creator → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      await expect(
        withTestTenant(async () => meetups.remove(dto.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rsvp: admin CONFIRMED → CONFIRMED count = 1', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24), maxAttendees: 10 } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, adminActor()),
      );
      expect(after.confirmedCount).toBe(1);
      expect(after.myRsvp).toBe('CONFIRMED');
    });

    it('rsvp: at-cap → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24), maxAttendees: 1 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      await withTestTenant(async () =>
        meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rsvp: switch CONFIRMED → PENDING releases slot (UPDATE branch)', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24), maxAttendees: 1 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, adminActor()),
      );
      // Set to PENDING via UPDATE branch
      const pending = await withTestTenant(async () =>
        meetups.rsvp(dto.id, { status: 'PENDING' } as any, adminActor()),
      );
      expect(pending.confirmedCount).toBe(0);
      expect(pending.pendingCount).toBe(1);
      // Re-confirm now works because slot is free
      const confirmed = await withTestTenant(async () =>
        meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, adminActor()),
      );
      expect(confirmed.confirmedCount).toBe(1);
    });

    it('rsvp: missing meetup → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetups.rsvp(
            '00000000-0000-0000-0000-000000000000',
            { status: 'CONFIRMED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rsvp: non-member → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        meetups.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'A', eventDate: inFuture(24) } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          meetups.rsvp(dto.id, { status: 'CONFIRMED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
