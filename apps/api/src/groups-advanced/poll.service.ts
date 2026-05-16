import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { GroupService } from '../groups/group.service';
import { assertGroupInCurrentSchool } from './access';
import {
  CreatePollDto,
  PollOptionResponseDto,
  PollResponseDto,
  PollStatus,
  PollType,
  VotePollDto,
} from './dto/groups-advanced.dto';

interface PollRow {
  id: string;
  group_id: string;
  question: string;
  poll_type: string;
  allows_anonymous: boolean;
  status: string;
  closes_at: Date | null;
  closed_at: Date | null;
  created_by: string;
  created_at: Date;
}

interface OptionRow {
  id: string;
  poll_id: string;
  option_text: string;
  sort_order: number;
  vote_count: number;
}

/**
 * PollService — P2-28a Step 2 (REVIEW-P2C28 Round 1 BLOCKING 1 + 2
 * fixes applied).
 *
 * Group-scoped poll lifecycle with atomic vote_count INCREMENT and
 * structural anonymity. Anonymous polls write grp_poll_votes with
 * voter_id=NULL — the schema-side partial UNIQUE INDEX
 * (poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL prevents
 * identified double-vote on non-anonymous polls. For anonymous
 * polls, the new grp_poll_voter_checks PK(poll_id, voter_id) records
 * WHO voted without linking to HOW — repeat anonymous ballots are
 * rejected at the schema layer. The voter-check row is inserted in
 * the same tx as the vote rows, so a duplicate hits the PK and
 * rolls the entire vote back without ever revealing how the user
 * voted.
 *
 * School-admin override paths still validate the target group
 * belongs to the current school via assertGroupInCurrentSchool —
 * the GroupService.assertCanManageGroup short-circuits for school
 * admins without checking the group is in the current school, so
 * a School A admin with a School B group UUID would otherwise
 * succeed.
 *
 * Group OWNER / ADMIN can create polls. Active members can vote.
 * Group OWNER / ADMIN / school admin can close.
 */
@Injectable()
export class PollService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  private async assertGroupMember(groupId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const group = await this.groups.getById(groupId, actor);
    if (!group.myMembership || group.myMembership.status !== 'ACTIVE') {
      throw new ForbiddenException('Only active group members can use this poll');
    }
  }

  private async loadPollOrFail(pollId: string): Promise<PollRow> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, question, poll_type, ' +
          'allows_anonymous, status, closes_at, closed_at, created_by::text AS created_by, created_at ' +
          'FROM grp_group_polls WHERE id = $1::uuid LIMIT 1',
        pollId,
      );
    })) as PollRow[];
    if (rows.length === 0) throw new NotFoundException('Poll not found');
    return rows[0]!;
  }

  private async loadOptions(pollId: string): Promise<OptionRow[]> {
    return (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, poll_id::text AS poll_id, option_text, sort_order, vote_count ' +
          'FROM grp_poll_options WHERE poll_id = $1::uuid ORDER BY sort_order ASC',
        pollId,
      );
    })) as OptionRow[];
  }

  private async hasVoted(pollId: string, voterAccountId: string): Promise<boolean> {
    // REVIEW-P2C28 BLOCKING 1 — voter-check is the canonical
    // "has this user voted?" signal for both anonymous and
    // identified polls. The grp_poll_votes table no longer needs
    // a voter_id read on the anonymous path.
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM grp_poll_voter_checks WHERE poll_id = $1::uuid AND voter_id = $2::uuid LIMIT 1',
        pollId,
        voterAccountId,
      );
    })) as Array<{ ok: number }>;
    return rows.length > 0;
  }

  /**
   * Create a new poll. REVIEW-P2C28 Round 1 BLOCKING 2 — school
   * admins still validate the target group belongs to the current
   * school before the INSERT lands.
   */
  async create(
    groupId: string,
    input: CreatePollDto,
    actor: ResolvedActor,
  ): Promise<PollResponseDto> {
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    if (input.options.length < 2) {
      throw new BadRequestException('A poll must have at least 2 options');
    }
    if (input.options.length > 50) {
      throw new BadRequestException('A poll cannot have more than 50 options');
    }
    if (input.closesAt && new Date(input.closesAt).getTime() <= Date.now()) {
      throw new BadRequestException('closesAt must be in the future');
    }

    const pollId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO grp_group_polls (id, group_id, question, poll_type, allows_anonymous, closes_at, status, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, 'OPEN', $7::uuid)",
        pollId,
        groupId,
        input.question,
        input.pollType,
        input.allowsAnonymous ?? false,
        input.closesAt ?? null,
        actor.accountId,
      );
      for (let i = 0; i < input.options.length; i++) {
        await tx.$executeRawUnsafe(
          'INSERT INTO grp_poll_options (id, poll_id, option_text, sort_order, vote_count) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, 0)',
          generateId(),
          pollId,
          input.options[i]!,
          i,
        );
      }
    });
    return this.getById(pollId, actor);
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<PollResponseDto[]> {
    await this.assertGroupMember(groupId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id FROM grp_group_polls WHERE group_id = $1::uuid ORDER BY created_at DESC LIMIT 200',
        groupId,
      );
    })) as Array<{ id: string }>;
    const polls: PollResponseDto[] = [];
    for (const r of rows) {
      polls.push(await this.getById(r.id, actor));
    }
    return polls;
  }

  async getById(pollId: string, actor: ResolvedActor): Promise<PollResponseDto> {
    const poll = await this.loadPollOrFail(pollId);
    await this.assertGroupMember(poll.group_id, actor);
    const options = await this.loadOptions(pollId);
    const totalVotes = options.reduce((s, o) => s + o.vote_count, 0);
    const hasVoted = await this.hasVoted(pollId, actor.accountId);
    return this.rowToDto(poll, options, totalVotes, hasVoted);
  }

  /**
   * Vote keystone — atomic INCREMENT on grp_poll_options.vote_count
   * inside one tenant tx. Validates:
   *   - poll is OPEN
   *   - poll has not passed closes_at
   *   - all optionIds belong to this poll
   *   - SINGLE_CHOICE has exactly 1 entry
   *   - voter has not already voted (anonymous OR identified) — the
   *     grp_poll_voter_checks PK(poll_id, voter_id) is the schema-
   *     side dedup gate, the service inserts the voter-check row
   *     first inside the tx so a duplicate vote rolls everything
   *     back without revealing how the user voted on the anonymous
   *     poll.
   *
   * RANKED polls record each option with a sequential rank based on
   * the order optionIds was supplied.
   *
   * REVIEW-P2C28 Round 1 BLOCKING 1 fix — anonymous repeat-vote
   * prevention via the new grp_poll_voter_checks PK.
   */
  async vote(pollId: string, input: VotePollDto, actor: ResolvedActor): Promise<PollResponseDto> {
    if (input.optionIds.length > 50) {
      throw new BadRequestException('Cannot submit more than 50 options in one ballot');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const pollRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, poll_type, allows_anonymous, status, closes_at ' +
          'FROM grp_group_polls WHERE id = $1::uuid FOR UPDATE',
        pollId,
      )) as Array<{
        id: string;
        group_id: string;
        poll_type: string;
        allows_anonymous: boolean;
        status: string;
        closes_at: Date | null;
      }>;
      if (pollRows.length === 0) throw new NotFoundException('Poll not found');
      const poll = pollRows[0]!;

      if (poll.status !== 'OPEN') {
        throw new BadRequestException('Poll is not open for voting');
      }
      if (poll.closes_at && poll.closes_at.getTime() <= Date.now()) {
        throw new BadRequestException('Poll has closed');
      }

      if (poll.poll_type === 'SINGLE_CHOICE' && input.optionIds.length !== 1) {
        throw new BadRequestException('SINGLE_CHOICE polls accept exactly one option');
      }

      // Validate options belong to the poll
      const optionRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM grp_poll_options WHERE poll_id = $1::uuid AND id = ANY($2::uuid[])',
        pollId,
        input.optionIds,
      )) as Array<{ id: string }>;
      if (optionRows.length !== input.optionIds.length) {
        throw new BadRequestException('One or more optionIds do not belong to this poll');
      }

      // Group membership check (only members can vote)
      await this.assertGroupMember(poll.group_id, actor);

      // REVIEW-P2C28 BLOCKING 1 — voter-check INSERT first. PK on
      // (poll_id, voter_id) makes repeat ballots impossible for both
      // identified and anonymous polls. Anonymous polls still write
      // grp_poll_votes with voter_id=NULL — structural anonymity is
      // preserved on the votes table.
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO grp_poll_voter_checks (poll_id, voter_id, voted_at) ' +
            'VALUES ($1::uuid, $2::uuid, now())',
          pollId,
          actor.accountId,
        );
      } catch (e) {
        const err = e as { code?: string; meta?: { code?: string } };
        if (err.code === '23505' || err.meta?.code === '23505') {
          throw new ConflictException('You have already voted on this poll');
        }
        throw e;
      }

      // Atomic INSERT votes + INCREMENT vote_count
      for (let i = 0; i < input.optionIds.length; i++) {
        const optionId = input.optionIds[i]!;
        const voteId = generateId();
        const rank = poll.poll_type === 'RANKED' ? i + 1 : null;
        await tx.$executeRawUnsafe(
          'INSERT INTO grp_poll_votes (id, poll_id, option_id, voter_id, rank) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
          voteId,
          pollId,
          optionId,
          poll.allows_anonymous ? null : actor.accountId,
          rank,
        );
        await tx.$executeRawUnsafe(
          'UPDATE grp_poll_options SET vote_count = vote_count + 1 WHERE id = $1::uuid AND poll_id = $2::uuid',
          optionId,
          pollId,
        );
      }
    });
    return this.getById(pollId, actor);
  }

  async close(pollId: string, actor: ResolvedActor): Promise<PollResponseDto> {
    const poll = await this.loadPollOrFail(pollId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(poll.group_id, actor);
    }
    if (poll.status !== 'OPEN') {
      throw new BadRequestException('Poll is already closed or cancelled');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE grp_group_polls SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE id = $1::uuid",
        pollId,
      );
    });
    return this.getById(pollId, actor);
  }

  private rowToDto(
    poll: PollRow,
    options: OptionRow[],
    totalVotes: number,
    hasVoted: boolean,
  ): PollResponseDto {
    const optionDtos: PollOptionResponseDto[] = options.map((o) => ({
      id: o.id,
      optionText: o.option_text,
      sortOrder: o.sort_order,
      voteCount: o.vote_count,
    }));
    return {
      id: poll.id,
      groupId: poll.group_id,
      question: poll.question,
      pollType: poll.poll_type as PollType,
      allowsAnonymous: poll.allows_anonymous,
      status: poll.status as PollStatus,
      closesAt: poll.closes_at ? poll.closes_at.toISOString() : null,
      closedAt: poll.closed_at ? poll.closed_at.toISOString() : null,
      createdBy: poll.created_by,
      options: optionDtos,
      totalVotes,
      hasVoted,
      createdAt: poll.created_at.toISOString(),
    };
  }
}
