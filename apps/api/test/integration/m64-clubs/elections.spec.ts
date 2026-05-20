import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ElectionService } from '@modules/m64-clubs/elections/election.service';
import { VoteService } from '@modules/m64-clubs/elections/vote.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import { resetClubsAndStudents, ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m64-clubs elections suite. Verifies:
 *   - STRUCTURAL ANONYMITY: ext_votes has NO voter-identity column.
 *   - cast() writes to two separate tables in one tx with no JOIN path.
 *   - State machine DRAFT → OPEN → CLOSED → RESULTS_PUBLISHED.
 *   - Candidate impersonation prevention (BLOCKING 2).
 *   - Results suppression below min_votes_for_results (default 5).
 *   - Kafka emit on RESULTS_PUBLISHED.
 *   - Cross-school isolation.
 */
describe('integration:m64-clubs/elections', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: RecordingKafkaProducer;
  let elections: ElectionService;
  let votes: VoteService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const k = makeRecordingKafka();
    kafka = k as unknown as RecordingKafkaProducer;
    elections = new ElectionService(tenantPrisma, k);
    votes = new VoteService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetClubsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    kafka.reset();
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Link a SIS student to the supplied platform person id. Idempotent
   * across spec runs so the studentActor() persona always resolves to
   * the same sis_students row.
   */
  async function linkStudentToPerson(
    personId: string,
    gradeLevel: string = '5',
  ): Promise<string> {
    const platformStudentId = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      personId,
    )) as Array<{ id: string }>;
    let psId: string;
    if (platformStudentId.length > 0) {
      psId = platformStudentId[0]!.id;
    } else {
      const newPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES (gen_random_uuid(), $1::uuid, 'Linked', 'Student', true)
         RETURNING id::text AS id`,
        personId,
      )) as Array<{ id: string }>;
      psId = newPs[0]!.id;
      platformStudentIds.push(psId);
    }
    const existing = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid LIMIT 1`,
      psId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      // Force grade level in case prior spec set a different value
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.sis_students SET grade_level = $1 WHERE id = $2::uuid`,
        gradeLevel,
        existing[0]!.id,
      );
      return existing[0]!.id;
    }
    const stuRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, 'ENROLLED')
       RETURNING id::text AS id`,
      psId,
      TEST_SCHOOL_ID,
      'ELE-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      gradeLevel,
    )) as Array<{ id: string }>;
    const id = stuRows[0]!.id;
    studentIds.push(id);
    return id;
  }

  /**
   * Seed an election in the given school context. Voting window opens
   * 1 second from now and closes 1 hour later so cast() finds it open.
   */
  async function seedElection(opts: {
    schoolId: string;
    status?: string;
    filter?: Record<string, unknown>;
    minVotesForResults?: number;
  }): Promise<string> {
    const id = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.ext_elections
         (id, school_id, title, description, voting_start, voting_end, eligible_voters_filter, status, created_by, min_votes_for_results)
       VALUES (gen_random_uuid(), $1::uuid, 'Test Election', 'Desc',
               now() - interval '1 minute', now() + interval '1 hour',
               $2::jsonb, $3, $4::uuid, $5)
       RETURNING id::text AS id`,
      opts.schoolId,
      JSON.stringify(opts.filter ?? { all: true }),
      opts.status ?? 'OPEN',
      TEST_ADMIN_EMPLOYEE_ID,
      opts.minVotesForResults ?? 5,
    )) as Array<{ id: string }>;
    return id[0]!.id;
  }

  async function seedCandidate(opts: {
    electionId: string;
    studentId: string;
    position: string;
    approved?: boolean;
  }): Promise<string> {
    const rows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.ext_candidates
         (id, election_id, student_id, position, statement, is_approved)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, 'My platform', $4)
       RETURNING id::text AS id`,
      opts.electionId,
      opts.studentId,
      opts.position,
      opts.approved ?? true,
    )) as Array<{ id: string }>;
    return rows[0]!.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // STRUCTURAL ANONYMITY guarantee
  // ─────────────────────────────────────────────────────────────────
  describe('structural anonymity', () => {
    it('ext_votes table has NO voter-identity columns', async () => {
      const cols = (await rawClient.$queryRawUnsafe(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'ext_votes'`,
        TEST_SCHEMA,
      )) as Array<{ column_name: string }>;
      const names = cols.map((c) => c.column_name);
      // Sanity — table is reachable
      expect(names).toContain('id');
      expect(names).toContain('election_id');
      expect(names).toContain('candidate_id');
      expect(names).toContain('position');
      // The keystone: no voter linkage column allowed
      expect(names).not.toContain('voter_id');
      expect(names).not.toContain('student_id');
      expect(names).not.toContain('person_id');
      expect(names).not.toContain('voter');
      expect(names).not.toContain('voter_person_id');
      expect(names).not.toContain('account_id');
    });

    it('cast(): voter check row + vote row appear in separate tables, no JOIN path', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({
        electionId,
        studentId: stuId,
        position: 'President',
      });

      const cast = await withTestTenant(async () =>
        votes.cast(electionId, { position: 'President', candidateId: candId } as any, studentActor()),
      );
      expect(cast.status).toBe('CAST');
      expect(typeof cast.votedAt).toBe('string');

      // ext_election_voter_check has WHO voted
      const checks = (await rawClient.$queryRawUnsafe(
        `SELECT student_id::text AS sid FROM ${TEST_SCHEMA}.ext_election_voter_check WHERE election_id = $1::uuid`,
        electionId,
      )) as Array<{ sid: string }>;
      expect(checks.length).toBe(1);
      expect(checks[0]!.sid).toBe(stuId);

      // ext_votes records WHAT was voted, with no link back to voter
      const voteRows = (await rawClient.$queryRawUnsafe(
        `SELECT candidate_id::text AS cid, position FROM ${TEST_SCHEMA}.ext_votes WHERE election_id = $1::uuid`,
        electionId,
      )) as Array<{ cid: string; position: string }>;
      expect(voteRows.length).toBe(1);
      expect(voteRows[0]!.cid).toBe(candId);
      expect(voteRows[0]!.position).toBe('President');
    });

    it('cast(): double-vote → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({
        electionId,
        studentId: stuId,
        position: 'President',
      });
      await withTestTenant(async () =>
        votes.cast(electionId, { position: 'President', candidateId: candId } as any, studentActor()),
      );
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'President', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // cast() — validation paths
  // ─────────────────────────────────────────────────────────────────
  describe('cast() validation', () => {
    it('non-student → ForbiddenException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'X', candidateId: '00000000-0000-0000-0000-000000000000' } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing election → NotFoundException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await expect(
        withTestTenant(async () =>
          votes.cast(
            '00000000-0000-0000-0000-000000000000',
            { position: 'X', candidateId: '00000000-0000-0000-0000-000000000000' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('election not OPEN → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'P', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('voting window closed → BadRequestException', async () => {
      const stuId = await linkStudentToPerson(studentActor().personId!);
      // Voting window in the past
      const id = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.ext_elections
           (id, school_id, title, voting_start, voting_end, eligible_voters_filter, status, created_by)
         VALUES (gen_random_uuid(), $1::uuid, 'Past', now() - interval '2 hour', now() - interval '1 hour',
                 '{"all":true}'::jsonb, 'OPEN', $2::uuid)
         RETURNING id::text AS id`,
        TEST_SCHOOL_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      )) as Array<{ id: string }>;
      const electionId = id[0]!.id;
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'P', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ineligible (filter excludes voter) → ForbiddenException', async () => {
      const stuId = await linkStudentToPerson(studentActor().personId!, '5');
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        filter: { gradeLevels: ['12'] },
      });
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'P', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('eligible via gradeLevels filter → casts successfully', async () => {
      const stuId = await linkStudentToPerson(studentActor().personId!, '5');
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        filter: { gradeLevels: ['5'] },
      });
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      const cast = await withTestTenant(async () =>
        votes.cast(electionId, { position: 'P', candidateId: candId } as any, studentActor()),
      );
      expect(cast.status).toBe('CAST');
    });

    it('eligible via studentIds filter → casts successfully', async () => {
      const stuId = await linkStudentToPerson(studentActor().personId!, '5');
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        filter: { studentIds: [stuId] },
      });
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      const cast = await withTestTenant(async () =>
        votes.cast(electionId, { position: 'P', candidateId: candId } as any, studentActor()),
      );
      expect(cast.status).toBe('CAST');
    });

    it('candidate not found → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      await linkStudentToPerson(studentActor().personId!);
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'P', candidateId: '11111111-2222-3333-4444-555555555555' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('candidate not approved → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({
        electionId,
        studentId: stuId,
        position: 'P',
        approved: false,
      });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'P', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('candidate position mismatch → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({
        electionId,
        studentId: stuId,
        position: 'President',
      });
      await expect(
        withTestTenant(async () =>
          votes.cast(
            electionId,
            { position: 'VicePresident', candidateId: candId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // canVote()
  // ─────────────────────────────────────────────────────────────────
  describe('canVote()', () => {
    it('non-student → canVote=false', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const res = await withTestTenant(async () => votes.canVote(electionId, parentActor()));
      expect(res.canVote).toBe(false);
      expect(res.reason).toContain('Only students');
    });

    it('eligible student → canVote=true', async () => {
      await linkStudentToPerson(studentActor().personId!, '5');
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const res = await withTestTenant(async () => votes.canVote(electionId, studentActor()));
      expect(res.canVote).toBe(true);
      expect(res.hasVoted).toBe(false);
    });

    it('student already voted → hasVoted=true', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      await withTestTenant(async () =>
        votes.cast(electionId, { position: 'P', candidateId: candId } as any, studentActor()),
      );
      const res = await withTestTenant(async () => votes.canVote(electionId, studentActor()));
      expect(res.hasVoted).toBe(true);
      expect(res.canVote).toBe(false);
    });

    it('election DRAFT → canVote=false (status reason)', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const res = await withTestTenant(async () => votes.canVote(electionId, studentActor()));
      expect(res.canVote).toBe(false);
      expect(res.reason).toContain('Voting is not open');
    });

    it('voting window closed → canVote=false', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const id = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.ext_elections
           (id, school_id, title, voting_start, voting_end, eligible_voters_filter, status, created_by)
         VALUES (gen_random_uuid(), $1::uuid, 'Future', now() + interval '2 hour', now() + interval '3 hour',
                 '{"all":true}'::jsonb, 'OPEN', $2::uuid)
         RETURNING id::text AS id`,
        TEST_SCHOOL_ID,
        TEST_ADMIN_EMPLOYEE_ID,
      )) as Array<{ id: string }>;
      const res = await withTestTenant(async () => votes.canVote(id[0]!.id, studentActor()));
      expect(res.canVote).toBe(false);
      expect(res.reason).toContain('Voting window');
    });

    it('ineligible (filter excludes) → canVote=false', async () => {
      await linkStudentToPerson(studentActor().personId!, '5');
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        filter: { gradeLevels: ['12'] },
      });
      const res = await withTestTenant(async () => votes.canVote(electionId, studentActor()));
      expect(res.canVote).toBe(false);
      expect(res.reason).toContain('not eligible');
    });

    it('missing election → NotFoundException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await expect(
        withTestTenant(async () =>
          votes.canVote('00000000-0000-0000-0000-000000000000', studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ElectionService — list / getById / create
  // ─────────────────────────────────────────────────────────────────
  describe('ElectionService — list / getById / create', () => {
    it('list returns elections school-scoped', async () => {
      const a = await seedElection({ schoolId: TEST_SCHOOL_ID });
      await seedElection({ schoolId: TEST_SCHOOL_B_ID });
      const listA = await withTestTenant(async () => elections.list());
      expect(listA.map((e) => e.id)).toContain(a);
      // School B's election should not appear in School A list
      const allFromA = listA.map((e) => e.id);
      const listB = await withTestTenantB(async () => elections.list());
      const onlyB = listB.filter((e) => !allFromA.includes(e.id));
      expect(onlyB.length).toBeGreaterThan(0);
    });

    it('getById returns DTO with candidates', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      const dto = await withTestTenant(async () => elections.getById(electionId));
      expect(dto.id).toBe(electionId);
      expect(dto.candidates?.length).toBe(1);
      // Vote counts NOT inlined before RESULTS_PUBLISHED
      expect(dto.candidates![0]!.voteCount).toBeNull();
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => elections.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: admin succeeds', async () => {
      const dto = await withTestTenant(async () =>
        elections.create(
          {
            title: 'Spring Election',
            description: 'Vote!',
            votingStart: '2027-01-01T00:00:00Z',
            votingEnd: '2027-01-08T00:00:00Z',
            eligibleVotersFilter: { all: true },
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Spring Election');
    });

    it('create: non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          elections.create(
            {
              title: 'X',
              votingStart: '2027-01-01T00:00:00Z',
              votingEnd: '2027-01-02T00:00:00Z',
              eligibleVotersFilter: { all: true },
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: votingEnd <= votingStart → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          elections.create(
            {
              title: 'X',
              votingStart: '2027-01-05T00:00:00Z',
              votingEnd: '2027-01-01T00:00:00Z',
              eligibleVotersFilter: { all: true },
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: admin without employeeId → BadRequestException', async () => {
      const ghost: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () =>
          elections.create(
            {
              title: 'X',
              votingStart: '2027-01-01T00:00:00Z',
              votingEnd: '2027-01-02T00:00:00Z',
              eligibleVotersFilter: { all: true },
            } as any,
            ghost,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // patch() — state machine + Kafka emit
  // ─────────────────────────────────────────────────────────────────
  describe('patch() state machine', () => {
    it('non-admin → ForbiddenException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          elections.patch(electionId, { status: 'OPEN' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          elections.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'OPEN' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('DRAFT → OPEN is allowed', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        elections.patch(electionId, { status: 'OPEN', title: 'Renamed' } as any, adminActor()),
      );
      expect(dto.status).toBe('OPEN');
      expect(dto.title).toBe('Renamed');
    });

    it('DRAFT → CLOSED rejected (must be OPEN first)', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          elections.patch(electionId, { status: 'CLOSED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OPEN → CLOSED is allowed', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'OPEN' });
      const dto = await withTestTenant(async () =>
        elections.patch(electionId, { status: 'CLOSED' } as any, adminActor()),
      );
      expect(dto.status).toBe('CLOSED');
    });

    it('OPEN → OPEN rejected (already OPEN)', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'OPEN' });
      await expect(
        withTestTenant(async () =>
          elections.patch(electionId, { status: 'OPEN' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('OPEN → RESULTS_PUBLISHED rejected (must be CLOSED)', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'OPEN' });
      await expect(
        withTestTenant(async () =>
          elections.patch(electionId, { status: 'RESULTS_PUBLISHED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CLOSED → RESULTS_PUBLISHED emits Kafka', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'CLOSED' });
      const dto = await withTestTenant(async () =>
        elections.patch(electionId, { status: 'RESULTS_PUBLISHED' } as any, adminActor()),
      );
      expect(dto.status).toBe('RESULTS_PUBLISHED');
      const emits = kafka.callsForTopic('ext.election.results.published');
      expect(emits.length).toBe(1);
      expect((emits[0]!.payload as any).electionId).toBe(electionId);
    });

    it('patch with no fields → noop returns getById', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        elections.patch(electionId, {} as any, adminActor()),
      );
      expect(dto.id).toBe(electionId);
    });

    it('patch description only does not change status', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        elections.patch(electionId, { description: 'Updated desc' } as any, adminActor()),
      );
      expect(dto.description).toBe('Updated desc');
      expect(dto.status).toBe('DRAFT');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // registerCandidate — impersonation prevention (BLOCKING 2)
  // ─────────────────────────────────────────────────────────────────
  describe('registerCandidate', () => {
    it('student registers themselves — succeeds', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const cand = await withTestTenant(async () =>
        elections.registerCandidate(
          electionId,
          { studentId: stuId, position: 'P', statement: 'me' } as any,
          studentActor(),
        ),
      );
      expect(cand.studentId).toBe(stuId);
      // Student self-reg defaults to is_approved=false
      expect(cand.isApproved).toBe(false);
    });

    it('student tries to register a different student → ForbiddenException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      await linkStudentToPerson(studentActor().personId!);
      const other = await trackedSeedStudent({ firstName: 'Imp', lastName: 'Os' });
      await expect(
        withTestTenant(async () =>
          elections.registerCandidate(
            electionId,
            { studentId: other.studentId, position: 'P' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin registers on behalf — succeeds + is_approved=true', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const other = await trackedSeedStudent({ firstName: 'A', lastName: 'B' });
      const cand = await withTestTenant(async () =>
        elections.registerCandidate(
          electionId,
          { studentId: other.studentId, position: 'P' } as any,
          adminActor(),
        ),
      );
      expect(cand.isApproved).toBe(true);
    });

    it('non-admin non-student (parent) → ForbiddenException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const other = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          elections.registerCandidate(
            electionId,
            { studentId: other.studentId, position: 'P' } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate candidate for (election, student, position) → BadRequestException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      await withTestTenant(async () =>
        elections.registerCandidate(
          electionId,
          { studentId: stuId, position: 'P' } as any,
          studentActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          elections.registerCandidate(
            electionId,
            { studentId: stuId, position: 'P' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('student without personId → ForbiddenException', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'DRAFT' });
      const noPid: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: null,
        employeeId: null,
        personType: 'STUDENT',
        isSchoolAdmin: false,
      };
      await expect(
        withTestTenant(async () =>
          elections.registerCandidate(
            electionId,
            { studentId: '00000000-0000-0000-0000-000000000000', position: 'P' } as any,
            noPid,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // getResults — suppression + published path
  // ─────────────────────────────────────────────────────────────────
  describe('getResults', () => {
    it('status != RESULTS_PUBLISHED → empty results, not suppressed', async () => {
      const electionId = await seedElection({ schoolId: TEST_SCHOOL_ID, status: 'OPEN' });
      const res = await withTestTenant(async () => elections.getResults(electionId));
      expect(res.results).toEqual([]);
      expect(res.resultsSuppressed).toBe(false);
      expect(res.status).toBe('OPEN');
    });

    it('missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          elections.getResults('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('RESULTS_PUBLISHED with < min voters → suppressed', async () => {
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        status: 'RESULTS_PUBLISHED',
        minVotesForResults: 5,
      });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      // 2 votes only
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_election_voter_check (election_id, student_id) VALUES ($1::uuid, $2::uuid)`,
        electionId,
        stuId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_votes (id, election_id, position, candidate_id) VALUES (gen_random_uuid(), $1::uuid, 'P', $2::uuid)`,
        electionId,
        candId,
      );
      // Plus one more voter
      const other = await trackedSeedStudent();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_election_voter_check (election_id, student_id) VALUES ($1::uuid, $2::uuid)`,
        electionId,
        other.studentId,
      );

      const res = await withTestTenant(async () => elections.getResults(electionId));
      expect(res.totalVotersChecked).toBe(2);
      expect(res.minVotesForResults).toBe(5);
      expect(res.resultsSuppressed).toBe(true);
      expect(res.results).toEqual([]);
    });

    it('RESULTS_PUBLISHED with >= min voters → results returned', async () => {
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        status: 'RESULTS_PUBLISHED',
        minVotesForResults: 2,
      });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      // 3 voter checks + 3 vote rows
      const a = await trackedSeedStudent();
      const b = await trackedSeedStudent();
      for (const sid of [stuId, a.studentId, b.studentId]) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.ext_election_voter_check (election_id, student_id) VALUES ($1::uuid, $2::uuid)`,
          electionId,
          sid,
        );
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.ext_votes (id, election_id, position, candidate_id) VALUES (gen_random_uuid(), $1::uuid, 'P', $2::uuid)`,
          electionId,
          candId,
        );
      }
      const res = await withTestTenant(async () => elections.getResults(electionId));
      expect(res.resultsSuppressed).toBe(false);
      expect(res.totalVotersChecked).toBe(3);
      expect(res.results.length).toBe(1);
      expect(res.results[0]!.voteCount).toBe(3);
      expect(res.results[0]!.candidateId).toBe(candId);
    });

    it('getById on RESULTS_PUBLISHED inlines vote counts', async () => {
      const electionId = await seedElection({
        schoolId: TEST_SCHOOL_ID,
        status: 'RESULTS_PUBLISHED',
      });
      const stuId = await linkStudentToPerson(studentActor().personId!);
      const candId = await seedCandidate({ electionId, studentId: stuId, position: 'P' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_votes (id, election_id, position, candidate_id) VALUES (gen_random_uuid(), $1::uuid, 'P', $2::uuid)`,
        electionId,
        candId,
      );
      const dto = await withTestTenant(async () => elections.getById(electionId));
      expect(dto.candidates![0]!.voteCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('elections from School B not in School A list', async () => {
      const a = await seedElection({ schoolId: TEST_SCHOOL_ID });
      const b = await seedElection({ schoolId: TEST_SCHOOL_B_ID });
      const listA = await withTestTenant(async () => elections.list());
      expect(listA.map((e) => e.id)).toContain(a);
      expect(listA.map((e) => e.id)).not.toContain(b);
    });
  });
});
