import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { PollService } from '@modules/m103-groups/polls/poll.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
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
 * Wave 7 — m103-groups poll suite. Covers PollService (create atomic
 * options INSERT + listForGroup + getById hydrate + vote with atomic
 * vote_count increment + grp_poll_voter_checks PK dedup for both anon
 * and identified + RANKED rank order + close + OPEN/CLOSED gate +
 * voter_id=NULL anonymity + member-only gate + cross-school).
 */
describe('integration:m103-groups/polls', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let groups: GroupService;
  let memberships: MembershipService;
  let polls: PollService;

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
    polls = new PollService(tenantPrisma, groups);
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
  });

  it('create: admin creates SINGLE_CHOICE poll with 3 options atomically', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Lunch?',
          pollType: 'SINGLE_CHOICE',
          options: ['Pizza', 'Salad', 'Burger'],
        } as any,
        adminActor(),
      ),
    );
    expect(dto.question).toBe('Lunch?');
    expect(dto.status).toBe('OPEN');
    expect(dto.options.length).toBe(3);
    expect(dto.options.map((o) => o.optionText)).toEqual(['Pizza', 'Salad', 'Burger']);
    expect(dto.totalVotes).toBe(0);
  });

  it('create: needs at least 2 options', async () => {
    await expect(
      withTestTenant(async () =>
        polls.create(
          TEST_GROUP_OPEN_A_ID,
          { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['only'] } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: more than 50 options → BadRequestException', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `opt-${i}`);
    await expect(
      withTestTenant(async () =>
        polls.create(
          TEST_GROUP_OPEN_A_ID,
          { question: 'Q', pollType: 'SINGLE_CHOICE', options: tooMany } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: closesAt in the past → BadRequestException', async () => {
    await expect(
      withTestTenant(async () =>
        polls.create(
          TEST_GROUP_OPEN_A_ID,
          {
            question: 'Q',
            pollType: 'SINGLE_CHOICE',
            options: ['A', 'B'],
            closesAt: new Date(Date.now() - 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: cross-school → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        polls.create(
          TEST_GROUP_B_ID,
          { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: non-manager → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        polls.create(
          TEST_GROUP_OPEN_A_ID,
          { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('vote: identified vote increments vote_count and records voter_id', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
          allowsAnonymous: false,
        } as any,
        adminActor(),
      ),
    );
    const optA = dto.options[0]!.id;
    const r = await withTestTenant(async () =>
      polls.vote(dto.id, { optionIds: [optA] } as any, adminActor()),
    );
    expect(r.totalVotes).toBe(1);
    expect(r.hasVoted).toBe(true);
    expect(r.options.find((o) => o.id === optA)!.voteCount).toBe(1);

    // voter_id present in grp_poll_votes
    const rows = await rawClient.$queryRawUnsafe<Array<{ voter_id: string | null }>>(
      `SELECT voter_id::text AS voter_id FROM ${TEST_SCHEMA}.grp_poll_votes WHERE poll_id = $1::uuid`,
      dto.id,
    );
    expect(rows[0]!.voter_id).toBe(TEST_ADMIN_ACCOUNT_ID);
  });

  it('vote: anonymous poll writes voter_id=NULL on grp_poll_votes', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Anon?',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
          allowsAnonymous: true,
        } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, adminActor()),
    );
    const rows = await rawClient.$queryRawUnsafe<Array<{ voter_id: string | null }>>(
      `SELECT voter_id::text AS voter_id FROM ${TEST_SCHEMA}.grp_poll_votes WHERE poll_id = $1::uuid`,
      dto.id,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.voter_id).toBeNull();
    // grp_poll_voter_checks still records WHO voted
    const checks = await rawClient.$queryRawUnsafe<Array<{ voter_id: string }>>(
      `SELECT voter_id::text AS voter_id FROM ${TEST_SCHEMA}.grp_poll_voter_checks WHERE poll_id = $1::uuid`,
      dto.id,
    );
    expect(checks.length).toBe(1);
    expect(checks[0]!.voter_id).toBe(TEST_ADMIN_ACCOUNT_ID);
  });

  it('vote: repeat vote blocked by grp_poll_voter_checks PK (identified)', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
        } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, adminActor()),
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: [dto.options[1]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('vote: repeat vote blocked even for anonymous polls', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Anon?',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
          allowsAnonymous: true,
        } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, adminActor()),
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: [dto.options[1]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('vote: SINGLE_CHOICE with >1 option → BadRequestException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
        } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(
          dto.id,
          { optionIds: [dto.options[0]!.id, dto.options[1]!.id] } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vote: optionIds > 50 → BadRequestException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'MULTIPLE_CHOICE',
          options: ['A', 'B'],
        } as any,
        adminActor(),
      ),
    );
    const tooMany = Array.from({ length: 51 }, () => dto.options[0]!.id);
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: tooMany } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vote: option from another poll → BadRequestException', async () => {
    const dto1 = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q1', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    const dto2 = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q2', pollType: 'SINGLE_CHOICE', options: ['X', 'Y'] } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(dto1.id, { optionIds: [dto2.options[0]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vote: missing poll → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        polls.vote(
          '00000000-0000-0000-0000-000000000000',
          { optionIds: ['00000000-0000-0000-0000-000000000001'] } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('vote: closed poll → BadRequestException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () => polls.close(dto.id, adminActor()));
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vote: closes_at expired → BadRequestException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'SINGLE_CHOICE',
          options: ['A', 'B'],
          closesAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        } as any,
        adminActor(),
      ),
    );
    // Roll closes_at back into the past
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.grp_group_polls SET closes_at = now() - INTERVAL '1 minute' WHERE id = $1::uuid`,
      dto.id,
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('vote: MULTIPLE_CHOICE selects multiple options', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'MULTIPLE_CHOICE',
          options: ['A', 'B', 'C'],
        } as any,
        adminActor(),
      ),
    );
    const r = await withTestTenant(async () =>
      polls.vote(
        dto.id,
        { optionIds: [dto.options[0]!.id, dto.options[2]!.id] } as any,
        adminActor(),
      ),
    );
    expect(r.totalVotes).toBe(2);
  });

  it('vote: RANKED records rank ordinal', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        {
          question: 'Q',
          pollType: 'RANKED',
          options: ['A', 'B', 'C'],
        } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      polls.vote(
        dto.id,
        { optionIds: [dto.options[2]!.id, dto.options[0]!.id, dto.options[1]!.id] } as any,
        adminActor(),
      ),
    );
    const rows = await rawClient.$queryRawUnsafe<Array<{ option_id: string; rank: number }>>(
      `SELECT option_id::text AS option_id, rank FROM ${TEST_SCHEMA}.grp_poll_votes WHERE poll_id = $1::uuid ORDER BY rank`,
      dto.id,
    );
    expect(rows.map((r) => r.option_id)).toEqual([
      dto.options[2]!.id,
      dto.options[0]!.id,
      dto.options[1]!.id,
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('vote: non-member → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        polls.vote(dto.id, { optionIds: [dto.options[0]!.id] } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForGroup: admin sees polls; non-member → ForbiddenException', async () => {
    await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q1', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q2', pollType: 'SINGLE_CHOICE', options: ['X', 'Y'] } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(async () =>
      polls.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
    );
    expect(list.length).toBe(2);

    await expect(
      withTestTenant(async () => polls.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        polls.getById('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('close: admin closes OPEN poll', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    const closed = await withTestTenant(async () => polls.close(dto.id, adminActor()));
    expect(closed.status).toBe('CLOSED');
    expect(closed.closedAt).not.toBeNull();
  });

  it('close: already closed → BadRequestException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () => polls.close(dto.id, adminActor()));
    await expect(
      withTestTenant(async () => polls.close(dto.id, adminActor())),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('close: non-manager → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      polls.create(
        TEST_GROUP_OPEN_A_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    await expect(
      withTestTenant(async () => polls.close(dto.id, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('close: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () => polls.close('00000000-0000-0000-0000-000000000000', adminActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cross-school: vote on School B poll from School A context → ForbiddenException', async () => {
    const dtoB = await withTestTenantB(async () =>
      polls.create(
        TEST_GROUP_B_ID,
        { question: 'Q', pollType: 'SINGLE_CHOICE', options: ['A', 'B'] } as any,
        adminActor(),
      ),
    );
    // vote() now calls assertGroupInCurrentSchool after the FOR UPDATE
    // lock — School A admin attempting to vote on a School B poll is
    // rejected.
    await expect(
      withTestTenant(async () =>
        polls.vote(dtoB.id, { optionIds: [dtoB.options[0]!.id] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cross-school: listForGroup on School B from School A context → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () => polls.listForGroup(TEST_GROUP_B_ID, adminActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
