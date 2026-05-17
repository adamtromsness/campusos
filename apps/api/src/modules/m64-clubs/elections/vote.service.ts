import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { CanVoteResponseDto, CastVoteDto } from '../clubs/dto/clubs.dto';

@Injectable()
export class VoteService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private async resolveStudentIdAndGrade(
    actor: ResolvedActor,
  ): Promise<{ id: string; gradeLevel: string | null } | null> {
    if (actor.personType !== 'STUDENT' || !actor.personId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.grade_level FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    })) as Array<{ id: string; grade_level: string | null }>;
    return rows.length === 0 ? null : { id: rows[0]!.id, gradeLevel: rows[0]!.grade_level };
  }

  /**
   * Evaluate the eligible_voters_filter JSON predicate against the
   * calling student. Shapes: {all:true} | {gradeLevels:[..]} |
   * {studentIds:[..]}. Future cycles can add yearGroups, classIds.
   */
  private isEligible(
    student: { id: string; gradeLevel: string | null },
    filter: Record<string, unknown>,
  ): boolean {
    if (filter['all'] === true) return true;
    if (Array.isArray(filter['gradeLevels'])) {
      const grades = filter['gradeLevels'] as unknown[];
      if (student.gradeLevel && grades.map(String).includes(String(student.gradeLevel))) {
        return true;
      }
    }
    if (Array.isArray(filter['studentIds'])) {
      const ids = filter['studentIds'] as unknown[];
      if (ids.map(String).includes(student.id)) return true;
    }
    return false;
  }

  /**
   * ANONYMITY KEYSTONE.
   *
   * Inside one tenant transaction:
   *   1. Lock the election + voter_check predicate.
   *   2. INSERT ext_election_voter_check with (election_id, student_id)
   *      — the primary key prevents double-vote.
   *   3. INSERT ext_votes with NO voter identity column. There is no
   *      JOIN path from this row back to the voter_check row.
   *
   * The two writes touch separate tables. There is no foreign key,
   * no surrogate audit row, no shared identifier between them. A
   * database administrator querying both tables cannot reconstruct
   * the (voter, vote) pairs.
   */
  async cast(
    electionId: string,
    input: CastVoteDto,
    actor: ResolvedActor,
  ): Promise<{ status: 'CAST'; votedAt: string }> {
    const student = await this.resolveStudentIdAndGrade(actor);
    if (!student) {
      throw new ForbiddenException('Only students can cast votes');
    }

    let votedAt = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const election = (await tx.$queryRawUnsafe(
        'SELECT id, status, voting_start, voting_end, eligible_voters_filter FROM ext_elections WHERE id = $1::uuid FOR UPDATE',
        electionId,
      )) as Array<{
        id: string;
        status: string;
        voting_start: Date;
        voting_end: Date;
        eligible_voters_filter: Record<string, unknown>;
      }>;
      if (election.length === 0) throw new NotFoundException('Election not found');
      const e = election[0]!;
      if (e.status !== 'OPEN') {
        throw new BadRequestException('Voting is not open. Current election status: ' + e.status);
      }
      const now = new Date();
      if (now < new Date(e.voting_start) || now > new Date(e.voting_end)) {
        throw new BadRequestException('Voting window is closed');
      }
      if (!this.isEligible(student, e.eligible_voters_filter)) {
        throw new ForbiddenException('You are not eligible to vote in this election');
      }

      // Validate the candidate is real, approved, and matches the
      // requested position
      const candidate = (await tx.$queryRawUnsafe(
        'SELECT id, position, is_approved FROM ext_candidates WHERE id = $1::uuid AND election_id = $2::uuid',
        input.candidateId,
        electionId,
      )) as Array<{ id: string; position: string; is_approved: boolean }>;
      if (candidate.length === 0) {
        throw new BadRequestException('Candidate not found in this election');
      }
      if (!candidate[0]!.is_approved) {
        throw new BadRequestException('Candidate is not approved');
      }
      if (candidate[0]!.position !== input.position) {
        throw new BadRequestException(
          'Candidate is registered for position "' +
            candidate[0]!.position +
            '" but ballot was for "' +
            input.position +
            '"',
        );
      }

      // Step 1: INSERT ext_election_voter_check (PK violation catches
      // double-vote)
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_election_voter_check (election_id, student_id) VALUES ($1::uuid, $2::uuid)',
          electionId,
          student.id,
        );
      } catch (eErr) {
        const err = eErr as { code?: string; meta?: { code?: string }; message?: string };
        const isDup =
          err.code === '23505' ||
          err.meta?.code === '23505' ||
          /duplicate key|already exists/i.test(err.message ?? '');
        if (isDup) {
          throw new BadRequestException('You have already voted in this election');
        }
        throw eErr;
      }

      // Step 2: INSERT ext_votes — NO voter identity column.
      // The two INSERTs touch separate tables. There is no JOIN path
      // between them.
      const voteId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO ext_votes (id, election_id, position, candidate_id, voted_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, now())',
        voteId,
        electionId,
        input.position,
        input.candidateId,
      );

      const ts = (await tx.$queryRawUnsafe(
        'SELECT TO_CHAR(now(), \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS ts',
      )) as Array<{ ts: string }>;
      votedAt = ts[0]!.ts;
    });
    return { status: 'CAST', votedAt };
  }

  async canVote(electionId: string, actor: ResolvedActor): Promise<CanVoteResponseDto> {
    const student = await this.resolveStudentIdAndGrade(actor);
    if (!student) {
      return {
        electionId,
        canVote: false,
        hasVoted: false,
        reason: 'Only students can vote',
      };
    }
    const election = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT status, voting_start, voting_end, eligible_voters_filter FROM ext_elections WHERE id = $1::uuid',
        electionId,
      );
    })) as Array<{
      status: string;
      voting_start: Date;
      voting_end: Date;
      eligible_voters_filter: Record<string, unknown>;
    }>;
    if (election.length === 0) {
      throw new NotFoundException('Election not found');
    }
    const e = election[0]!;
    const checked = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM ext_election_voter_check WHERE election_id = $1::uuid AND student_id = $2::uuid LIMIT 1',
        electionId,
        student.id,
      );
    })) as Array<unknown>;
    const hasVoted = checked.length > 0;
    if (hasVoted) {
      return { electionId, canVote: false, hasVoted: true, reason: 'You have already voted' };
    }
    if (e.status !== 'OPEN') {
      return {
        electionId,
        canVote: false,
        hasVoted: false,
        reason: 'Voting is not open. Current status: ' + e.status,
      };
    }
    const now = new Date();
    if (now < new Date(e.voting_start) || now > new Date(e.voting_end)) {
      return {
        electionId,
        canVote: false,
        hasVoted: false,
        reason: 'Voting window is closed',
      };
    }
    if (!this.isEligible(student, e.eligible_voters_filter)) {
      return {
        electionId,
        canVote: false,
        hasVoted: false,
        reason: 'You are not eligible to vote in this election',
      };
    }
    return { electionId, canVote: true, hasVoted: false, reason: 'Eligible' };
  }
}
