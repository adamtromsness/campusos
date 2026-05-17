import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CandidateDto,
  CreateElectionDto,
  ElectionResponseDto,
  ElectionResultsResponseDto,
  ElectionStatus,
  RegisterCandidateDto,
  UpdateElectionDto,
  VoteResultDto,
} from './dto/clubs.dto';

interface ElectionRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  voting_start: string;
  voting_end: string;
  eligible_voters_filter: Record<string, unknown>;
  status: string;
  created_by: string;
  created_by_name: string | null;
}

const SELECT_ELECTION =
  'SELECT e.id::text AS id, e.school_id::text AS school_id, e.title, e.description, ' +
  'TO_CHAR(e.voting_start, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS voting_start, ' +
  'TO_CHAR(e.voting_end, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS voting_end, ' +
  'e.eligible_voters_filter, e.status, e.created_by::text AS created_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees emp " +
  '  JOIN platform.iam_person ip ON ip.id = emp.person_id ' +
  '  WHERE emp.id = e.created_by) AS created_by_name ' +
  'FROM ext_elections e ';

function electionRowToDto(r: ElectionRow): ElectionResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    votingStart: r.voting_start,
    votingEnd: r.voting_end,
    eligibleVotersFilter: r.eligible_voters_filter,
    status: r.status as ElectionStatus,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
  };
}

@Injectable()
export class ElectionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(): Promise<ElectionResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ELECTION + 'WHERE e.school_id = $1::uuid ORDER BY e.voting_start DESC',
        tenant.schoolId,
      );
    })) as ElectionRow[];
    return rows.map(electionRowToDto);
  }

  async getById(id: string): Promise<ElectionResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ELECTION + 'WHERE e.id = $1::uuid', id);
    })) as ElectionRow[];
    if (rows.length === 0) throw new NotFoundException('Election not found');
    const dto = electionRowToDto(rows[0]!);

    // Inline candidates. Vote counts only when status = RESULTS_PUBLISHED.
    const includeCounts = dto.status === 'RESULTS_PUBLISHED';
    const candidates = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.election_id::text AS election_id, ' +
          'c.student_id::text AS student_id, ' +
          "(SELECT (p.first_name || ' ' || p.last_name) FROM sis_students s " +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person p ON p.id = ps.person_id ' +
          '  WHERE s.id = c.student_id) AS student_name, ' +
          'c.position, c.statement, c.photo_s3_key, c.is_approved, ' +
          'TO_CHAR(c.registered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS registered_at, ' +
          (includeCounts
            ? '(SELECT COUNT(*)::int FROM ext_votes v WHERE v.candidate_id = c.id) AS vote_count '
            : 'NULL::int AS vote_count ') +
          'FROM ext_candidates c WHERE c.election_id = $1::uuid ORDER BY c.position, c.registered_at',
        id,
      );
    })) as Array<{
      id: string;
      election_id: string;
      student_id: string;
      student_name: string | null;
      position: string;
      statement: string | null;
      photo_s3_key: string | null;
      is_approved: boolean;
      registered_at: string;
      vote_count: number | null;
    }>;
    dto.candidates = candidates.map((c) => ({
      id: c.id,
      electionId: c.election_id,
      studentId: c.student_id,
      studentName: c.student_name,
      position: c.position,
      statement: c.statement,
      photoS3Key: c.photo_s3_key,
      isApproved: c.is_approved,
      registeredAt: c.registered_at,
      voteCount: c.vote_count,
    }));
    return dto;
  }

  async create(input: CreateElectionDto, actor: ResolvedActor): Promise<ElectionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create elections');
    }
    if (!actor.employeeId) {
      throw new BadRequestException('Election must be created by a staff employee');
    }
    if (new Date(input.votingEnd) <= new Date(input.votingStart)) {
      throw new BadRequestException('votingEnd must be after votingStart');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ext_elections (id, school_id, title, description, voting_start, voting_end, eligible_voters_filter, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb, $8::uuid)',
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.votingStart,
        input.votingEnd,
        JSON.stringify(input.eligibleVotersFilter),
        actor.employeeId,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateElectionDto,
    actor: ResolvedActor,
  ): Promise<ElectionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update elections');
    }
    let resultsPublished = false;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM ext_elections WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Election not found');
      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.title !== undefined) {
        params.push(input.title);
        sets.push('title = $' + params.length);
      }
      if (input.description !== undefined) {
        params.push(input.description);
        sets.push('description = $' + params.length);
      }
      if (input.status !== undefined) {
        if (input.status === 'RESULTS_PUBLISHED' && lock[0]!.status !== 'CLOSED') {
          throw new BadRequestException(
            'Election must be CLOSED before publishing results. Current status: ' + lock[0]!.status,
          );
        }
        if (input.status === 'OPEN' && lock[0]!.status !== 'DRAFT') {
          throw new BadRequestException(
            'Election must be DRAFT before opening. Current status: ' + lock[0]!.status,
          );
        }
        if (input.status === 'CLOSED' && lock[0]!.status !== 'OPEN') {
          throw new BadRequestException(
            'Election must be OPEN before closing. Current status: ' + lock[0]!.status,
          );
        }
        if (input.status === 'RESULTS_PUBLISHED') resultsPublished = true;
        params.push(input.status);
        sets.push('status = $' + params.length);
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE ext_elections SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );
    });

    if (resultsPublished) {
      try {
        await this.kafka.emit({
          topic: 'ext.election.results.published',
          key: id,
          sourceModule: 'clubs',
          payload: {
            electionId: id,
            publishedAt: new Date().toISOString(),
            publishedBy: actor.accountId,
          },
        });
      } catch {
        // best-effort emit
      }
    }
    return this.getById(id);
  }

  async registerCandidate(
    electionId: string,
    input: RegisterCandidateDto,
    actor: ResolvedActor,
  ): Promise<CandidateDto> {
    // Either a student registers themselves OR an admin registers on
    // behalf of a student (typical for the candidate-approval flow).
    if (!actor.isSchoolAdmin && actor.personType !== 'STUDENT') {
      throw new ForbiddenException(
        'Only students can register themselves as candidates, or admins can register on behalf',
      );
    }
    // REVIEW-CYCLE17 BLOCKING 2 — candidate impersonation prevention.
    // Non-admin students must register themselves only. Resolve the
    // caller's sis_students.id from actor.personId via the
    // platform_students bridge and reject any submission that
    // names a different student. Admin still registers on behalf.
    if (!actor.isSchoolAdmin) {
      if (!actor.personId) {
        throw new ForbiddenException('Cannot resolve calling student');
      }
      const own = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT s.id::text AS id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $1::uuid LIMIT 1',
          actor.personId,
        );
      })) as Array<{ id: string }>;
      if (own.length === 0 || own[0]!.id !== input.studentId) {
        throw new ForbiddenException('Students can only register themselves as candidates');
      }
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_candidates (id, election_id, student_id, position, statement, photo_s3_key, is_approved) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
          id,
          electionId,
          input.studentId,
          input.position,
          input.statement ?? null,
          input.photoS3Key ?? null,
          actor.isSchoolAdmin,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException(
          'Student is already registered for this position in this election',
        );
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT c.id::text AS id, c.election_id::text AS election_id, ' +
          'c.student_id::text AS student_id, ' +
          "(SELECT (p.first_name || ' ' || p.last_name) FROM sis_students s " +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person p ON p.id = ps.person_id ' +
          '  WHERE s.id = c.student_id) AS student_name, ' +
          'c.position, c.statement, c.photo_s3_key, c.is_approved, ' +
          'TO_CHAR(c.registered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS registered_at ' +
          'FROM ext_candidates c WHERE c.id = $1::uuid',
        id,
      );
    })) as Array<{
      id: string;
      election_id: string;
      student_id: string;
      student_name: string | null;
      position: string;
      statement: string | null;
      photo_s3_key: string | null;
      is_approved: boolean;
      registered_at: string;
    }>;
    const c = rows[0]!;
    return {
      id: c.id,
      electionId: c.election_id,
      studentId: c.student_id,
      studentName: c.student_name,
      position: c.position,
      statement: c.statement,
      photoS3Key: c.photo_s3_key,
      isApproved: c.is_approved,
      registeredAt: c.registered_at,
    };
  }

  /**
   * Election results — aggregate vote counts per (position, candidate).
   * Only available after status = RESULTS_PUBLISHED. Never exposes
   * any vote-to-voter linkage because no such linkage exists at the
   * schema level (see ext_votes / ext_election_voter_check ANONYMITY
   * KEYSTONE).
   */
  async getResults(id: string): Promise<ElectionResultsResponseDto> {
    const election = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id, status, min_votes_for_results FROM ext_elections WHERE id = $1::uuid',
        id,
      );
    })) as Array<{ id: string; status: string; min_votes_for_results: number }>;
    if (election.length === 0) throw new NotFoundException('Election not found');
    const status = election[0]!.status as ElectionStatus;
    const minVotesForResults = election[0]!.min_votes_for_results ?? 5;
    if (status !== 'RESULTS_PUBLISHED') {
      return {
        electionId: id,
        status,
        results: [],
        totalVotersChecked: 0,
        minVotesForResults,
        resultsSuppressed: false,
      };
    }
    const results = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT v.position, v.candidate_id::text AS candidate_id, ' +
          "(SELECT (p.first_name || ' ' || p.last_name) FROM ext_candidates c " +
          '  JOIN sis_students s ON s.id = c.student_id ' +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person p ON p.id = ps.person_id ' +
          '  WHERE c.id = v.candidate_id) AS candidate_name, ' +
          'COUNT(*)::int AS vote_count ' +
          'FROM ext_votes v WHERE v.election_id = $1::uuid ' +
          'GROUP BY v.position, v.candidate_id ' +
          'ORDER BY v.position, vote_count DESC',
        id,
      );
    })) as Array<{
      position: string;
      candidate_id: string;
      candidate_name: string | null;
      vote_count: number;
    }>;
    const checks = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM ext_election_voter_check WHERE election_id = $1::uuid',
        id,
      );
    })) as Array<{ c: number }>;
    const totalVotersChecked = checks[0]!.c;
    // P2-H4 ADV-04 — suppress per-candidate counts in small cohorts.
    // Below the threshold the public results endpoint hides the tally;
    // admins still see the truth via direct SQL on ext_votes.
    if (totalVotersChecked < minVotesForResults) {
      return {
        electionId: id,
        status,
        results: [],
        totalVotersChecked,
        minVotesForResults,
        resultsSuppressed: true,
      };
    }
    const dtoResults: VoteResultDto[] = results.map((r) => ({
      position: r.position,
      candidateId: r.candidate_id,
      candidateName: r.candidate_name,
      voteCount: r.vote_count,
    }));
    return {
      electionId: id,
      status,
      results: dtoResults,
      totalVotersChecked,
      minVotesForResults,
      resultsSuppressed: false,
    };
  }
}
