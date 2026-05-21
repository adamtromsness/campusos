import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ProgrammeService } from '@modules/m66-athletics/programme.service';
import { SeasonService } from '@modules/m66-athletics/season.service';
import { RosterService } from '@modules/m66-athletics/roster.service';
import { GameService } from '@modules/m66-athletics/game.service';
import { GameProposalService } from '@modules/m66-athletics/game-proposal.service';
import { ResultService } from '@modules/m66-athletics/result.service';
import { OfficialService } from '@modules/m66-athletics/official.service';
import { CoachingService } from '@modules/m66-athletics/coaching.service';
import { InjuryService } from '@modules/m66-athletics/injury.service';
import { ConcussionProtocolService } from '@modules/m66-athletics/concussion-protocol.service';
import { MedicalClearanceService } from '@modules/m66-athletics/medical-clearance.service';
import { GameStreamService } from '@modules/m66-athletics/game-stream.service';
import { EquipmentService } from '@modules/m66-athletics/equipment.service';
import { SafetyEquipmentService } from '@modules/m66-athletics/safety-equipment.service';
import { ConferenceService } from '@modules/m66-athletics/conference.service';
import { StatsService } from '@modules/m66-athletics/stats.service';
import { TeamMediaService } from '@modules/m66-athletics/team-media.service';
import { RecruitingService } from '@modules/m66-athletics/recruiting.service';

import { ProgrammeController } from '@modules/m66-athletics/programme.controller';
import { SeasonController } from '@modules/m66-athletics/season.controller';
import { RosterController } from '@modules/m66-athletics/roster.controller';
import { GameController } from '@modules/m66-athletics/game.controller';
import { GameProposalController } from '@modules/m66-athletics/game-proposal.controller';
import { ResultController } from '@modules/m66-athletics/result.controller';
import { OfficialController } from '@modules/m66-athletics/official.controller';
import { CoachingController } from '@modules/m66-athletics/coaching.controller';
import { InjuryController } from '@modules/m66-athletics/injury.controller';
import { ConcussionProtocolController } from '@modules/m66-athletics/concussion-protocol.controller';
import { MedicalClearanceController } from '@modules/m66-athletics/medical-clearance.controller';
import { GameStreamController } from '@modules/m66-athletics/game-stream.controller';
import { EquipmentController } from '@modules/m66-athletics/equipment.controller';
import { SafetyEquipmentController } from '@modules/m66-athletics/safety-equipment.controller';
import { ConferenceController } from '@modules/m66-athletics/conference.controller';
import { StatsController } from '@modules/m66-athletics/stats.controller';
import { TeamMediaController } from '@modules/m66-athletics/team-media.controller';
import { RecruitingController } from '@modules/m66-athletics/recruiting.controller';

import { type ActorContextService, type ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  ensureOfficialProfile,
  TEST_ATH_PROGRAMME_A_ID,
  TEST_ATH_SEASON_A_ID,
  TEST_ATH_ROSTER_A_ID,
  TEST_ATH_OFFICIAL_PROFILE_ID,
} from '../fixtures/athletics';

/**
 * Wave 7 — m66-athletics controller surface.
 *
 * Exercises every controller endpoint with a stub ActorContextService that
 * returns the admin actor. The service-level branches are covered by the
 * sibling .spec files; this suite pushes request bodies through the
 * controller layer and asserts they thread to the service correctly.
 */
class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

describe('integration:m66-athletics/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let actorStub: SwitchingActorContext;

  // Controllers
  let progCtl: ProgrammeController;
  let seasCtl: SeasonController;
  let rostCtl: RosterController;
  let gameCtl: GameController;
  let propCtl: GameProposalController;
  let resCtl: ResultController;
  let offCtl: OfficialController;
  let coachCtl: CoachingController;
  let injCtl: InjuryController;
  let protCtl: ConcussionProtocolController;
  let clrCtl: MedicalClearanceController;
  let strmCtl: GameStreamController;
  let eqCtl: EquipmentController;
  let safetyCtl: SafetyEquipmentController;
  let confCtl: ConferenceController;
  let statsCtl: StatsController;
  let mediaCtl: TeamMediaController;
  let recCtl: RecruitingController;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();

    const programmes = new ProgrammeService(tenantPrisma, permCheck);
    const seasons = new SeasonService(tenantPrisma, programmes);
    const rosters = new RosterService(tenantPrisma, programmes);
    const games = new GameService(tenantPrisma, programmes);
    const proposals = new GameProposalService(tenantPrisma, programmes);
    const results = new ResultService(tenantPrisma, games, kafka as any);
    const officials = new OfficialService(tenantPrisma, permCheck, outbox);
    const coaching = new CoachingService(tenantPrisma, programmes);
    const injuries = new InjuryService(tenantPrisma, programmes);
    const protocol = new ConcussionProtocolService(tenantPrisma, programmes);
    const clearance = new MedicalClearanceService(tenantPrisma, programmes);
    const streams = new GameStreamService(tenantPrisma, permCheck, outbox);
    const equipment = new EquipmentService(tenantPrisma, permCheck, outbox);
    const safety = new SafetyEquipmentService(tenantPrisma, permCheck);
    const conferences = new ConferenceService(tenantPrisma, permCheck);
    const stats = new StatsService(tenantPrisma, games);
    const media = new TeamMediaService(tenantPrisma, permCheck);
    const recruiting = new RecruitingService(tenantPrisma, permCheck);

    actorStub = new SwitchingActorContext();
    const actorCtx = actorStub as unknown as ActorContextService;

    progCtl = new ProgrammeController(programmes, actorCtx);
    seasCtl = new SeasonController(seasons, actorCtx);
    rostCtl = new RosterController(rosters, actorCtx);
    gameCtl = new GameController(games, actorCtx);
    propCtl = new GameProposalController(proposals, actorCtx);
    resCtl = new ResultController(results, actorCtx);
    offCtl = new OfficialController(officials, actorCtx);
    coachCtl = new CoachingController(coaching, actorCtx);
    injCtl = new InjuryController(injuries, protocol, clearance, actorCtx);
    protCtl = new ConcussionProtocolController(protocol, actorCtx);
    clrCtl = new MedicalClearanceController(clearance, actorCtx);
    strmCtl = new GameStreamController(streams, actorCtx);
    eqCtl = new EquipmentController(equipment, actorCtx);
    safetyCtl = new SafetyEquipmentController(safety, actorCtx);
    confCtl = new ConferenceController(conferences, actorCtx);
    statsCtl = new StatsController(stats, actorCtx);
    mediaCtl = new TeamMediaController(media, actorCtx);
    recCtl = new RecruitingController(recruiting, actorCtx);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    if (studentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        studentIds.splice(0),
      );
    }
    if (platformStudentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        platformStudentIds.splice(0),
      );
    }
    if (personIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        personIds.splice(0),
      );
    }
    await ensureAthleticsSeed(rawClient);
    await ensureOfficialProfile(rawClient);
    actorStub.current = adminActor();
  });

  function adminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
      },
    };
  }

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  // ─────────────────────────────────────────────────────────────────
  // ProgrammeController
  // ─────────────────────────────────────────────────────────────────
  it('ProgrammeController: list + get + create + patch', async () => {
    const list = await withTestTenant(() => progCtl.list('FALL', 'Soccer', 'false'));
    expect(list.length).toBeGreaterThan(0);
    const got = await withTestTenant(() => progCtl.getById(TEST_ATH_PROGRAMME_A_ID));
    expect(got.id).toBe(TEST_ATH_PROGRAMME_A_ID);
    const created = await withTestTenant(() =>
      progCtl.create(adminReq(), {
        sportName: 'Hockey',
        season: 'WINTER',
        levelsOffered: ['VARSITY'],
      } as any),
    );
    expect(created.sportName).toBe('Hockey');
    const patched = await withTestTenant(() =>
      progCtl.patch(adminReq(), TEST_ATH_PROGRAMME_A_ID, { minGpa: 2.25 } as any),
    );
    expect(patched.minGpa).toBe(2.25);
  });

  // ─────────────────────────────────────────────────────────────────
  // SeasonController
  // ─────────────────────────────────────────────────────────────────
  it('SeasonController: list + get + create + patch', async () => {
    const list = await withTestTenant(() => seasCtl.listForProgramme(TEST_ATH_PROGRAMME_A_ID));
    expect(list.map((s) => s.id)).toContain(TEST_ATH_SEASON_A_ID);

    const got = await withTestTenant(() => seasCtl.getById(TEST_ATH_SEASON_A_ID));
    expect(got.id).toBe(TEST_ATH_SEASON_A_ID);

    const created = await withTestTenant(() =>
      seasCtl.create(adminReq(), TEST_ATH_PROGRAMME_A_ID, {
        academicYear: '2030-2031',
      } as any),
    );
    expect(created.academicYear).toBe('2030-2031');

    const patched = await withTestTenant(() =>
      seasCtl.patch(adminReq(), TEST_ATH_SEASON_A_ID, { status: 'POSTSEASON' } as any),
    );
    expect(patched.status).toBe('POSTSEASON');
  });

  // ─────────────────────────────────────────────────────────────────
  // RosterController
  // ─────────────────────────────────────────────────────────────────
  it('RosterController: full surface', async () => {
    const list = await withTestTenant(() => rostCtl.listForSeason(TEST_ATH_SEASON_A_ID));
    expect(list.map((r) => r.id)).toContain(TEST_ATH_ROSTER_A_ID);

    const got = await withTestTenant(() => rostCtl.getById(TEST_ATH_ROSTER_A_ID));
    expect(got.id).toBe(TEST_ATH_ROSTER_A_ID);

    const members = await withTestTenant(() => rostCtl.listMembers(TEST_ATH_ROSTER_A_ID));
    expect(members).toEqual([]);

    const created = await withTestTenant(() =>
      rostCtl.create(adminReq(), TEST_ATH_SEASON_A_ID, { level: 'JV' } as any),
    );
    expect(created.level).toBe('JV');

    const patched = await withTestTenant(() =>
      rostCtl.patch(adminReq(), created.id, { level: 'FRESHMAN' } as any),
    );
    expect(patched.id).toBe(created.id);

    const stu = await trackedSeedStudent();
    const added = await withTestTenant(() =>
      rostCtl.addMember(adminReq(), TEST_ATH_ROSTER_A_ID, { studentId: stu.studentId } as any),
    );
    expect(added.studentId).toBe(stu.studentId);

    const patchedMember = await withTestTenant(() =>
      rostCtl.patchMember(adminReq(), added.id, { jerseyNumber: '99' } as any),
    );
    expect(patchedMember.jerseyNumber).toBe('99');

    const certified = await withTestTenant(() => rostCtl.certify(adminReq(), TEST_ATH_ROSTER_A_ID));
    expect(certified.isCertified).toBe(true);

    const elig = await withTestTenant(() =>
      rostCtl.checkEligibility(adminReq(), TEST_ATH_ROSTER_A_ID),
    );
    expect(Array.isArray(elig)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // GameController + ResultController + StatsController
  // ─────────────────────────────────────────────────────────────────
  it('GameController + ResultController + StatsController', async () => {
    const all = await withTestTenant(() => gameCtl.list());
    expect(all).toEqual([]);
    const created = await withTestTenant(() =>
      gameCtl.create(adminReq(), {
        rosterId: TEST_ATH_ROSTER_A_ID,
        gameDate: '2026-09-10',
        gameTime: '15:00',
        opponentName: 'Foe',
        location: 'HOME',
      } as any),
    );
    expect(created.id).toBeDefined();

    const sched = await withTestTenant(() => gameCtl.schedule());
    expect(Array.isArray(sched)).toBe(true);

    const got = await withTestTenant(() => gameCtl.getById(created.id));
    expect(got.id).toBe(created.id);

    const patched = await withTestTenant(() =>
      gameCtl.patch(adminReq(), created.id, { notes: 'x' } as any),
    );
    expect(patched.id).toBe(created.id);

    // Filtered list (covers query branches)
    const filtered = await withTestTenant(() =>
      gameCtl.list(
        TEST_ATH_SEASON_A_ID,
        TEST_ATH_ROSTER_A_ID,
        'SCHEDULED',
        '2026-01-01',
        '2027-01-01',
      ),
    );
    expect(filtered.map((g) => g.id)).toContain(created.id);

    // Enter result
    const entered = await withTestTenant(() =>
      resCtl.enter(adminReq(), created.id, {
        homeScore: 2,
        awayScore: 1,
        outcome: 'WIN',
      } as any),
    );
    expect(entered.status).toBe('COMPLETED');

    const rec = await withTestTenant(() => resCtl.seasonRecord(TEST_ATH_ROSTER_A_ID));
    expect(rec.wins).toBe(1);

    // Patch result (no-op change)
    const resultRows = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.ath_game_results WHERE game_id = $1::uuid`,
      created.id,
    )) as Array<{ id: string }>;
    const r2 = await withTestTenant(() =>
      resCtl.patch(adminReq(), resultRows[0]!.id, { notes: 'corrected' } as any),
    );
    expect(r2.notes).toBe('corrected');

    // Stats — add roster member then enter stats
    const stu = await trackedSeedStudent();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, eligibility_status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ELIGIBLE')`,
      TEST_ATH_ROSTER_A_ID,
      stu.studentId,
    );
    const statRows = await withTestTenant(() =>
      statsCtl.bulkEnter(adminReq(), created.id, {
        stats: [{ studentId: stu.studentId, statCategory: 'GOALS', statValue: 2 }],
      } as any),
    );
    expect(statRows.length).toBe(1);

    const forGame = await withTestTenant(() => statsCtl.listForGame(created.id));
    expect(forGame.length).toBe(1);
    const forPlayer = await withTestTenant(() => statsCtl.listForPlayer(stu.studentId));
    expect(forPlayer.length).toBe(1);

    const allTime = await withTestTenant(() =>
      statsCtl.createAllTimeRecord(adminReq(), {
        sport: 'Soccer',
        recordType: 'SINGLE_GAME',
        statCategory: 'GOALS',
        recordValue: 4,
      } as any),
    );
    expect(allTime.recordValue).toBe(4);
    const allList = await withTestTenant(() => statsCtl.listAllTimeRecords());
    expect(allList.map((r) => r.id)).toContain(allTime.id);
  });

  // ─────────────────────────────────────────────────────────────────
  // GameProposalController
  // ─────────────────────────────────────────────────────────────────
  it('GameProposalController: create + transitions', async () => {
    const list = await withTestTenant(() => propCtl.list(adminReq()));
    expect(list).toEqual([]);
    const p = await withTestTenant(() =>
      propCtl.create(adminReq(), {
        receivingSchoolId: '019e0cf8-aaaa-7777-8888-00000000000b',
        sport: 'Soccer',
        level: 'VARSITY',
        proposedDate: '2026-10-01',
        proposedLocation: 'NEUTRAL',
      } as any),
    );
    expect(p.status).toBe('PROPOSED');
    const got = await withTestTenant(() => propCtl.getById(p.id));
    expect(got.id).toBe(p.id);

    const counter = await withTestTenant(() =>
      propCtl.counter(adminReq(), p.id, { counterProposalData: { date: '2026-10-08' } } as any),
    );
    expect(counter.status).toBe('COUNTER_PROPOSED');

    const p2 = await withTestTenant(() =>
      propCtl.create(adminReq(), {
        receivingSchoolId: '019e0cf8-aaaa-7777-8888-00000000000b',
        sport: 'Soccer',
        level: 'VARSITY',
        proposedDate: '2026-10-15',
        proposedLocation: 'HOME_PROPOSING',
      } as any),
    );
    const accepted = await withTestTenant(() => propCtl.accept(adminReq(), p2.id));
    expect(accepted.status).toBe('ACCEPTED');

    const p3 = await withTestTenant(() =>
      propCtl.create(adminReq(), {
        receivingSchoolId: '019e0cf8-aaaa-7777-8888-00000000000b',
        sport: 'Soccer',
        level: 'VARSITY',
        proposedDate: '2026-10-20',
        proposedLocation: 'HOME_RECEIVING',
      } as any),
    );
    const declined = await withTestTenant(() => propCtl.decline(adminReq(), p3.id));
    expect(declined.status).toBe('DECLINED');
  });

  // ─────────────────────────────────────────────────────────────────
  // OfficialController
  // ─────────────────────────────────────────────────────────────────
  it('OfficialController: profiles + assignments + ratings', async () => {
    const list = await withTestTenant(() => offCtl.listProfiles(adminReq()));
    expect(list.length).toBeGreaterThan(0);
    const got = await withTestTenant(() =>
      offCtl.getProfile(adminReq(), TEST_ATH_OFFICIAL_PROFILE_ID),
    );
    expect(got.id).toBe(TEST_ATH_OFFICIAL_PROFILE_ID);
    const avail = await withTestTenant(() => offCtl.listAvailability(TEST_ATH_OFFICIAL_PROFILE_ID));
    expect(avail).toEqual([]);

    // Filter branches
    const filtered = await withTestTenant(() =>
      offCtl.listProfiles(adminReq(), 'Soccer', true, '2026-09-15', 'Test'),
    );
    expect(Array.isArray(filtered)).toBe(true);

    // Game + assignment
    const game = await withTestTenant(() =>
      gameCtl.create(adminReq(), {
        rosterId: TEST_ATH_ROSTER_A_ID,
        gameDate: '2026-09-10',
        gameTime: '15:00',
        opponentName: 'X',
        location: 'HOME',
      } as any),
    );
    const ass = await withTestTenant(() =>
      offCtl.createAssignment(adminReq(), game.id, {
        officialProfileId: TEST_ATH_OFFICIAL_PROFILE_ID,
        role: 'HEAD_REFEREE',
        fee: 100,
      } as any),
    );
    expect(ass.status).toBe('POSTED');
    const assById = await withTestTenant(() => offCtl.getAssignment(ass.id));
    expect(assById.id).toBe(ass.id);
    const listForGame = await withTestTenant(() => offCtl.listAssignmentsForGame(game.id));
    expect(listForGame.map((x) => x.id)).toContain(ass.id);
    const listForOfficial = await withTestTenant(() =>
      offCtl.listAssignmentsForOfficial(TEST_ATH_OFFICIAL_PROFILE_ID),
    );
    expect(listForOfficial.map((x) => x.id)).toContain(ass.id);

    // Transition through COMPLETED
    await withTestTenant(() =>
      offCtl.transitionAssignment(adminReq(), ass.id, { status: 'ACCEPTED' } as any),
    );
    await withTestTenant(() =>
      offCtl.transitionAssignment(adminReq(), ass.id, { status: 'CONFIRMED' } as any),
    );
    await withTestTenant(() =>
      offCtl.transitionAssignment(adminReq(), ass.id, { status: 'COMPLETED' } as any),
    );

    // Rating
    const rating = await withTestTenant(() =>
      offCtl.createRating(adminReq(), ass.id, {
        raterType: 'SCHOOL_RATES_OFFICIAL',
        overall: 5,
      } as any),
    );
    expect(rating.overall).toBe(5);
    const ratings = await withTestTenant(() => offCtl.listRatings(ass.id));
    expect(ratings.map((r) => r.id)).toContain(rating.id);
  });

  // ─────────────────────────────────────────────────────────────────
  // CoachingController
  // ─────────────────────────────────────────────────────────────────
  it('CoachingController: create + list + patch', async () => {
    const created = await withTestTenant(() =>
      coachCtl.create(adminReq(), TEST_ATH_ROSTER_A_ID, {
        coachPersonId: TEST_ADMIN_PERSON_ID,
        role: 'HEAD_COACH',
      } as any),
    );
    expect(created.role).toBe('HEAD_COACH');
    const list = await withTestTenant(() => coachCtl.list(TEST_ATH_ROSTER_A_ID));
    expect(list.map((c) => c.id)).toContain(created.id);
    const patched = await withTestTenant(() =>
      coachCtl.patch(adminReq(), created.id, { role: 'ASSISTANT_COACH' } as any),
    );
    expect(patched.role).toBe('ASSISTANT_COACH');
  });

  // ─────────────────────────────────────────────────────────────────
  // InjuryController + ConcussionProtocolController + MedicalClearanceController
  // ─────────────────────────────────────────────────────────────────
  it('Injury / Concussion / Clearance controllers', async () => {
    const stu = await trackedSeedStudent();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, eligibility_status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ELIGIBLE')`,
      TEST_ATH_ROSTER_A_ID,
      stu.studentId,
    );
    const inj = await withTestTenant(() =>
      injCtl.create(adminReq(), {
        studentId: stu.studentId,
        injuryDate: '2026-09-01',
        bodyPart: 'Knee',
        injuryDescription: 'Strain',
        severity: 'MINOR',
        returnToPlayStatus: 'SIDELINED',
      } as any),
    );
    expect(inj.bodyPart).toBe('Knee');

    const list = await withTestTenant(() => injCtl.list(adminReq()));
    expect(list.map((i) => i.id)).toContain(inj.id);

    const got = await withTestTenant(() => injCtl.getById(adminReq(), inj.id));
    expect(got.id).toBe(inj.id);

    const patched = await withTestTenant(() =>
      injCtl.patch(adminReq(), inj.id, { severity: 'MODERATE' } as any),
    );
    expect(patched.severity).toBe('MODERATE');

    // List with filters branches
    const listFiltered = await withTestTenant(() =>
      injCtl.list(adminReq(), TEST_ATH_ROSTER_A_ID, 'SIDELINED', stu.studentId),
    );
    expect(Array.isArray(listFiltered)).toBe(true);

    // Concussion injury for protocol surface
    const concInj = await withTestTenant(() =>
      injCtl.create(adminReq(), {
        studentId: stu.studentId,
        injuryDate: '2026-09-05',
        bodyPart: 'Head',
        injuryDescription: 'C',
        severity: 'SEVERE',
        returnToPlayStatus: 'CONCUSSION_PROTOCOL',
      } as any),
    );
    const stepList = await withTestTenant(() => protCtl.list(concInj.id));
    expect(stepList).toEqual([]);

    const step = await withTestTenant(() =>
      protCtl.start(adminReq(), concInj.id, {
        stepNumber: 1,
        stepName: 'Rest',
        minimumDurationHours: 1,
      } as any),
    );
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.ath_concussion_protocol_steps SET started_at = now() - INTERVAL '2 hours' WHERE id = $1::uuid`,
      step.id,
    );
    const completed = await withTestTenant(() =>
      protCtl.complete(adminReq(), step.id, { symptomFree: true } as any),
    );
    expect(completed.completedAt).not.toBeNull();

    // Clearance
    const cInj = await withTestTenant(() =>
      injCtl.create(adminReq(), {
        studentId: stu.studentId,
        injuryDate: '2026-09-10',
        bodyPart: 'Ankle',
        injuryDescription: 'Sprain',
        severity: 'MINOR',
        returnToPlayStatus: 'SIDELINED',
      } as any),
    );
    const c = await withTestTenant(() =>
      clrCtl.upload(adminReq(), cInj.id, {
        documentS3Key: 'doc/x.pdf',
        clearanceDate: '2026-09-15',
      } as any),
    );
    const cList = await withTestTenant(() => clrCtl.list(cInj.id));
    expect(cList.map((x) => x.id)).toContain(c.id);

    const reviewed = await withTestTenant(() =>
      clrCtl.review(adminReq(), c.id, { decision: 'ACCEPTED' } as any),
    );
    expect(reviewed.reviewStatus).toBe('ACCEPTED');
  });

  // ─────────────────────────────────────────────────────────────────
  // GameStreamController
  // ─────────────────────────────────────────────────────────────────
  it('GameStreamController: streams + clips + recordings', async () => {
    const game = await withTestTenant(() =>
      gameCtl.create(adminReq(), {
        rosterId: TEST_ATH_ROSTER_A_ID,
        gameDate: '2026-09-10',
        gameTime: '15:00',
        opponentName: 'X',
        location: 'HOME',
      } as any),
    );
    const stream = await withTestTenant(() =>
      strmCtl.configure(adminReq(), game.id, { accessLevel: 'PUBLIC' } as any),
    );
    expect(stream.streamStatus).toBe('SCHEDULED');

    const got = await withTestTenant(() => strmCtl.getById(stream.id));
    expect(got.id).toBe(stream.id);
    const byGame = await withTestTenant(() => strmCtl.getByGame(game.id));
    expect(byGame?.id).toBe(stream.id);
    const live = await withTestTenant(() => strmCtl.listLive());
    expect(Array.isArray(live)).toBe(true);

    const patched = await withTestTenant(() =>
      strmCtl.patch(adminReq(), stream.id, { streamStatus: 'LIVE' } as any),
    );
    expect(patched.streamStatus).toBe('LIVE');

    // Clip
    const stu = await trackedSeedStudent();
    const clip = await withTestTenant(() =>
      strmCtl.createClip(adminReq(), stream.id, {
        studentId: stu.studentId,
        startTimeSeconds: 0,
        endTimeSeconds: 10,
        s3Key: 'c/1.mp4',
      } as any),
    );
    const clipList = await withTestTenant(() => strmCtl.listClipsForStream(stream.id));
    expect(clipList.map((x) => x.id)).toContain(clip.id);
    const studentClips = await withTestTenant(() => strmCtl.listClipsForStudent(stu.studentId));
    expect(studentClips.map((x) => x.id)).toContain(clip.id);
    const clipById = await withTestTenant(() => strmCtl.getClipById(clip.id));
    expect(clipById.id).toBe(clip.id);

    const consented = await withTestTenant(() =>
      strmCtl.recordConsent(adminReq(), clip.id, { consentStatus: 'CONSENTED' } as any),
    );
    expect(consented.consentStatus).toBe('CONSENTED');

    const portfolio = await withTestTenant(() => strmCtl.addToPortfolio(adminReq(), clip.id));
    expect(portfolio.addedToPortfolio).toBe(true);

    // Recording
    const rec = await withTestTenant(() =>
      strmCtl.createRecording(adminReq(), game.id, {
        recordingType: 'FULL_GAME',
        s3Key: 'r/1.mp4',
      } as any),
    );
    const recList = await withTestTenant(() => strmCtl.listRecordingsForGame(game.id));
    expect(recList.map((x) => x.id)).toContain(rec.id);
    const recGot = await withTestTenant(() => strmCtl.getRecordingById(rec.id));
    expect(recGot.id).toBe(rec.id);
  });

  // ─────────────────────────────────────────────────────────────────
  // EquipmentController + SafetyEquipmentController
  // ─────────────────────────────────────────────────────────────────
  it('Equipment + Safety equipment controllers', async () => {
    const e = await withTestTenant(() =>
      eqCtl.create(adminReq(), {
        programmeId: TEST_ATH_PROGRAMME_A_ID,
        itemType: 'UNIFORM',
        itemName: 'Jersey',
        quantity: 10,
        unitCost: 50,
      } as any),
    );
    const list = await withTestTenant(() => eqCtl.list(TEST_ATH_PROGRAMME_A_ID, 'UNIFORM', 'GOOD'));
    expect(list.map((x) => x.id)).toContain(e.id);
    const got = await withTestTenant(() => eqCtl.getById(e.id));
    expect(got.id).toBe(e.id);
    const patched = await withTestTenant(() =>
      eqCtl.patch(adminReq(), e.id, { quantity: 20 } as any),
    );
    expect(patched.quantity).toBe(20);

    const stu = await trackedSeedStudent();
    const c = await withTestTenant(() =>
      eqCtl.checkout(adminReq(), e.id, { assignedToPersonId: stu.personId } as any),
    );
    const checkoutList = await withTestTenant(() => eqCtl.listCheckouts(e.id, stu.personId, true));
    expect(checkoutList.map((x) => x.id)).toContain(c.id);
    const overdue = await withTestTenant(() => eqCtl.listOverdue());
    expect(Array.isArray(overdue)).toBe(true);
    const returned = await withTestTenant(() =>
      eqCtl.returnCheckout(adminReq(), c.id, { conditionAtReturn: 'GOOD' } as any),
    );
    expect(returned.returnedAt).not.toBeNull();

    const m = await withTestTenant(() =>
      eqCtl.addMaintenance(adminReq(), e.id, { maintenanceType: 'CLEANING' } as any),
    );
    const mList = await withTestTenant(() => eqCtl.listMaintenance(e.id));
    expect(mList.map((x) => x.id)).toContain(m.id);

    // Safety equipment
    const memberId = (
      await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, eligibility_status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ELIGIBLE') RETURNING id::text AS id`,
        TEST_ATH_ROSTER_A_ID,
        stu.studentId,
      )
    )[0]!.id;

    const s = await withTestTenant(() =>
      safetyCtl.create(adminReq(), {
        rosterMemberId: memberId,
        equipmentType: 'HELMET',
        issued: true,
      } as any),
    );
    const sList = await withTestTenant(() => safetyCtl.listForRoster(TEST_ATH_ROSTER_A_ID));
    expect(sList.map((x) => x.id)).toContain(s.id);
    const sGot = await withTestTenant(() => safetyCtl.getById(s.id));
    expect(sGot.id).toBe(s.id);
    const sPatched = await withTestTenant(() =>
      safetyCtl.patch(adminReq(), s.id, { recallStatus: true } as any),
    );
    expect(sPatched.recallStatus).toBe(true);
    const expired = await withTestTenant(() => safetyCtl.listExpired());
    expect(Array.isArray(expired)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // ConferenceController
  // ─────────────────────────────────────────────────────────────────
  it('ConferenceController: list + memberships + schedule', async () => {
    // Seed conference directly (catalogue admin auth needed for create)
    const cId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_conferences (id, name, sport, is_active) VALUES ($1::uuid, 'Ctl Conf', 'Soccer', true)`,
      cId,
    );
    const list = await withTestTenant(() => confCtl.list());
    expect(list.map((c) => c.id)).toContain(cId);
    const got = await withTestTenant(() => confCtl.getById(cId));
    expect(got.id).toBe(cId);
    const filterList = await withTestTenant(() => confCtl.list('Soccer', 'true'));
    expect(filterList.length).toBeGreaterThan(0);

    const m = await withTestTenant(() =>
      confCtl.addMembership(adminReq(), cId, { programmeId: TEST_ATH_PROGRAMME_A_ID } as any),
    );
    const mList = await withTestTenant(() => confCtl.listMemberships(cId));
    expect(mList.map((x) => x.id)).toContain(m.id);

    const sched = await withTestTenant(() =>
      confCtl.addScheduleEntry(adminReq(), cId, {
        homeSchoolId: TEST_SCHOOL_ID,
        awaySchoolId: '019e0cf8-aaaa-7777-8888-00000000000b',
        scheduledDate: '2026-09-15',
      } as any),
    );
    const sList = await withTestTenant(() => confCtl.listSchedule(cId));
    expect(sList.map((x) => x.id)).toContain(sched.id);
  });

  // ─────────────────────────────────────────────────────────────────
  // TeamMediaController
  // ─────────────────────────────────────────────────────────────────
  it('TeamMediaController: photos + media', async () => {
    const p = await withTestTenant(() =>
      mediaCtl.createPhoto(adminReq(), {
        rosterId: TEST_ATH_ROSTER_A_ID,
        photoType: 'TEAM_PHOTO',
        s3Key: 'team.jpg',
      } as any),
    );
    const list = await withTestTenant(() => mediaCtl.listForRoster(TEST_ATH_ROSTER_A_ID));
    expect(list.map((x) => x.id)).toContain(p.id);

    const m = await withTestTenant(() =>
      mediaCtl.createAsset(adminReq(), {
        programmeId: TEST_ATH_PROGRAMME_A_ID,
        assetType: 'PHOTO',
        s3Key: 'm/1.jpg',
      } as any),
    );
    const byProg = await withTestTenant(() => mediaCtl.listForProgramme(TEST_ATH_PROGRAMME_A_ID));
    expect(byProg.map((x) => x.id)).toContain(m.id);
    const all = await withTestTenant(() =>
      mediaCtl.listMedia(TEST_ATH_PROGRAMME_A_ID, 'PHOTO', TEST_ATH_SEASON_A_ID),
    );
    expect(Array.isArray(all)).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // RecruitingController
  // ─────────────────────────────────────────────────────────────────
  it('RecruitingController: profile + interest', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recCtl.createProfile(adminReq(), {
        studentId: stu.studentId,
        sport: 'Soccer',
        graduationYear: 2028,
      } as any),
    );
    const list = await withTestTenant(() => recCtl.listProfiles(adminReq()));
    expect(list.map((x) => x.id)).toContain(p.id);

    const got = await withTestTenant(() => recCtl.getProfile(adminReq(), p.id));
    expect(got.id).toBe(p.id);

    const byStu = await withTestTenant(() => recCtl.getProfileByStudent(adminReq(), stu.studentId));
    expect(byStu?.id).toBe(p.id);

    const patched = await withTestTenant(() =>
      recCtl.updateProfile(adminReq(), p.id, { coachRecommendation: 'Strong' } as any),
    );
    expect(patched.coachRecommendation).toBe('Strong');

    const i = await withTestTenant(() =>
      recCtl.createInterest(adminReq(), p.id, { collegeName: 'State U' } as any),
    );
    const iList = await withTestTenant(() => recCtl.listInterests(adminReq(), p.id));
    expect(iList.map((x) => x.id)).toContain(i.id);
    const iPatched = await withTestTenant(() =>
      recCtl.updateInterest(adminReq(), i.id, { interestLevel: 'APPLIED' } as any),
    );
    expect(iPatched.interestLevel).toBe('APPLIED');

    // Filter branches
    const filtered = await withTestTenant(() =>
      recCtl.listProfiles(adminReq(), 2028, 'Soccer', false),
    );
    expect(Array.isArray(filtered)).toBe(true);
  });
});
