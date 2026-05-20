import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { GroupAnnouncementService } from '@modules/m103-groups/groups/group-announcement.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
} from '../helpers/actor';
import {
  resetGroupsAndStudents,
  ensureGroupsSeed,
  TEST_GROUP_OPEN_A_ID,
} from '../fixtures/groups';
import { ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m103-groups announcements suite. Covers GroupAnnouncementService
 * (assertCanRead + assertCanAuthor + listForGroup + getById + create +
 * Kafka grp.announcement.posted emit + patch + markRead idempotent
 * (INSERT ON CONFLICT DO NOTHING) + remove + row-scope active-member /
 * admin gate).
 */
describe('integration:m103-groups/announcements', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let groups: GroupService;
  let memberships: MembershipService;
  let announcements: GroupAnnouncementService;
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
    announcements = new GroupAnnouncementService(tenantPrisma, groups, k);
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

  it('create: admin posts announcement AND emits grp.announcement.posted', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'Welcome', body: 'Hello team', pinned: true } as any,
        adminActor(),
      ),
    );
    expect(dto.title).toBe('Welcome');
    expect(dto.pinned).toBe(true);
    expect(dto.iHaveRead).toBe(false);

    const calls = kafka.callsForTopic('grp.announcement.posted');
    expect(calls.length).toBe(1);
    expect(calls[0]!.payload).toMatchObject({
      groupId: TEST_GROUP_OPEN_A_ID,
      title: 'Welcome',
      pinned: true,
    });
  });

  it('create: with attachments + expiresAt', async () => {
    const expires = new Date(Date.now() + 86400_000).toISOString();
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        {
          title: 'X',
          body: 'Y',
          attachments: [{ name: 'note.pdf' }, { name: 'photo.png' }],
          expiresAt: expires,
        } as any,
        adminActor(),
      ),
    );
    expect(dto.attachments).toEqual([{ name: 'note.pdf' }, { name: 'photo.png' }]);
    expect(dto.expiresAt).toBeTruthy();
  });

  it('create: non-author (student) → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', body: 'Y' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: actor without personId → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', body: 'Y' } as any,
          { ...adminActor(), personId: null } as any,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForGroup: admin sees pinned-first; non-member of OPEN → ForbiddenException', async () => {
    await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'Pinned', body: 'X', pinned: true } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'Plain', body: 'X', pinned: false } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(async () =>
      announcements.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
    );
    expect(list.length).toBe(2);
    expect(list[0]!.pinned).toBe(true);

    // Non-member (student) — assertCanRead requires ACTIVE membership
    await expect(
      withTestTenant(async () =>
        announcements.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForGroup: active member can see; suspended member cannot', async () => {
    await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    // Join student
    const m = await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    expect(m.status).toBe('ACTIVE');
    const stuList = await withTestTenant(async () =>
      announcements.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
    );
    expect(stuList.length).toBe(1);

    // Suspend the student
    await withTestTenant(async () =>
      memberships.suspend(m.id, { reason: 'TOS' } as any, adminActor()),
    );
    await expect(
      withTestTenant(async () =>
        announcements.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForGroup: actor without personId → []', async () => {
    await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(async () =>
      announcements.listForGroup(TEST_GROUP_OPEN_A_ID, {
        ...adminActor(),
        personId: null,
      } as any),
    );
    expect(list).toEqual([]);
  });

  it('getById: admin reads existing', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    const got = await withTestTenant(async () => announcements.getById(dto.id, adminActor()));
    expect(got.id).toBe(dto.id);
  });

  it('getById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.getById('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getById: actor without personId → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.getById('00000000-0000-0000-0000-000000000000', {
          ...adminActor(),
          personId: null,
        } as any),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: admin updates fields', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    const patched = await withTestTenant(async () =>
      announcements.patch(
        dto.id,
        {
          title: 'Renamed',
          body: 'Updated body',
          pinned: true,
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        } as any,
        adminActor(),
      ),
    );
    expect(patched.title).toBe('Renamed');
    expect(patched.pinned).toBe(true);
    expect(patched.expiresAt).toBeTruthy();
  });

  it('patch: no-op input returns existing DTO', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    const noop = await withTestTenant(async () =>
      announcements.patch(dto.id, {} as any, adminActor()),
    );
    expect(noop.id).toBe(dto.id);
  });

  it('patch: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.patch(
          '00000000-0000-0000-0000-000000000000',
          { title: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('patch: non-author non-manager → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    // join student as ACTIVE member but not OWNER/ADMIN
    await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    await expect(
      withTestTenant(async () =>
        announcements.patch(dto.id, { title: 'Y' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('markRead: idempotent ON CONFLICT DO NOTHING', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    const r1 = await withTestTenant(async () => announcements.markRead(dto.id, adminActor()));
    expect(r1.ok).toBe(true);
    const r2 = await withTestTenant(async () => announcements.markRead(dto.id, adminActor()));
    expect(r2.ok).toBe(true);

    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ${TEST_SCHEMA}.grp_announcement_reads WHERE announcement_id = $1::uuid`,
      dto.id,
    );
    expect(rows.length).toBe(1);
  });

  it('markRead: missing announcement → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.markRead('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('markRead: actor without personId → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.markRead('00000000-0000-0000-0000-000000000000', {
          ...adminActor(),
          personId: null,
        } as any),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('markRead: non-member of OPEN group → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () => announcements.markRead(dto.id, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('remove: admin deletes; cascades reads', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () => announcements.markRead(dto.id, adminActor()));
    const r = await withTestTenant(async () => announcements.remove(dto.id, adminActor()));
    expect(r.ok).toBe(true);
    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ${TEST_SCHEMA}.grp_announcement_reads WHERE announcement_id = $1::uuid`,
      dto.id,
    );
    expect(rows.length).toBe(0);
  });

  it('remove: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        announcements.remove('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove: non-author non-manager → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      announcements.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', body: 'Y' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    await expect(
      withTestTenant(async () => announcements.remove(dto.id, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
