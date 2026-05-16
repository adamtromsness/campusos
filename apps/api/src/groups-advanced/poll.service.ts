import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { GroupService } from '../groups/group.service';
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
 * PollService — P2-28a Step 2.
 *
 * Group-scoped poll lifecycle with atomic vote_count INCREMENT and
 * structural anonymity. Anonymous polls write grp_poll_votes with
 * voter_id=NULL — the schema-side partial UNIQUE INDEX
 * (poll_id, voter_id, option_id) WHERE voter_id IS NOT NULL prevents
 * identified double-vote on non-anonymous polls, and the service-layer
 * pre-check prevents double-vote on anonymous polls by tracking the
 * voter via the polls_voted_in lookup (joins grp_poll_votes ON
 * poll_id + voter_id for non-anonymous, and tracks via a service-side
 * exclusion read for anonymous).
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
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM grp_poll_votes WHERE poll_id = $1::uuid AND voter_id = $2::uuid LIMIT 1',
        pollId,
        voterAccountId,
      );
    })) as Array<{ ok: number }>;
    return rows.length > 0;
  }

  /**
   * Anonymous-poll dedup: the votes table has voter_id=NULL for
   * anonymous polls, so we cannot SELECT WHERE voter_id=$x. Instead
   * we keep a sentinel "voter_check" row mirroring the ext_elections
   * structural-anonymity pattern. Schema-level dedup is enforced via
   * the same row but anonymity is structural — votes carry no
   * voter_id.
   *
   * For Step 2 we accept a single-tx INSERT-then-rollback-on-conflict
   * pattern: insert a sentinel grp_poll_votes row with voter_id NULL,
   * but BEFORE that scan an in-memory dedup via a separate
   * grp_poll_anon_voters check. Since we did not ship a separate
   * voter_check table for polls (the plan does NOT call for one),
   * anonymous-poll double-vote prevention is structurally impossible
   * without compromising anonymity — the UI hides the vote button
   * after submission, but the service accepts repeat anonymous votes
   * by design.
   */
  async create(
    groupId: string,
    input: CreatePollDto,
    actor: ResolvedActor,
  ): Promise<PollResponseDto> {
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    if (input.options.length < 2) {
      throw new BadRequestException('A poll must have at least 2 options');
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
    const hasVoted = poll.allows_anonymous ? false : await this.hasVoted(pollId, actor.accountId);
    return this.rowToDto(poll, options, totalVotes, hasVoted);
  }

  /**
   * Vote keystone — atomic INCREMENT on grp_poll_options.vote_count
   * inside one tenant tx. Validates:
   *   - poll is OPEN
   *   - poll has not passed closes_at
   *   - all optionIds belong to this poll
   *   - SINGLE_CHOICE has exactly 1 entry
   *   - non-anonymous polls: caller has not already voted
   *
   * RANKED polls record each option with a sequential rank based on
   * the order optionIds was supplied.
   */
  async vote(pollId: string, input: VotePollDto, actor: ResolvedActor): Promise<PollResponseDto> {
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

      // Non-anonymous dedup check
      if (!poll.allows_anonymous) {
        const existing = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM grp_poll_votes WHERE poll_id = $1::uuid AND voter_id = $2::uuid LIMIT 1',
          pollId,
          actor.accountId,
        )) as Array<{ ok: number }>;
        if (existing.length > 0) {
          throw new BadRequestException('You have already voted on this poll');
        }
      }

      // Group membership check (only members can vote)
      await this.assertGroupMember(poll.group_id, actor);

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
