import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ProgrammeService } from '@modules/m66-athletics/programme.service';
import { GameService } from '@modules/m66-athletics/game.service';
import { StatsService } from '@modules/m66-athletics/stats.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_ROSTER_A_ID,
} from '../fixtures/athletics';

describe('integration:m66-athletics/stats', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let games: GameService;
  let stats: StatsService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const programmes = new ProgrammeService(tenantPrisma, permCheck);
    games = new GameService(tenantPrisma, programmes);
    stats = new StatsService(tenantPrisma, games);
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
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function addRosterMember(studentId: string) {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_roster_members (id, roster_id, student_id, eligibility_status) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'ELIGIBLE')`,
      TEST_ATH_ROSTER_A_ID,
      studentId,
    );
  }

  async function createGame() {
    return withTestTenant(() =>
      games.create(
        {
          rosterId: TEST_ATH_ROSTER_A_ID,
          gameDate: '2026-09-10',
          gameTime: '15:00',
          opponentName: 'Rival',
          location: 'HOME',
        } as any,
        adminActor(),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // bulkEnter
  // ─────────────────────────────────────────────────────────────────
  it('bulkEnter: admin enters multi-row stats + listForGame + listForPlayer', async () => {
    const g = await createGame();
    const stu1 = await trackedSeedStudent({ firstName: 'A' });
    const stu2 = await trackedSeedStudent({ firstName: 'B' });
    await addRosterMember(stu1.studentId);
    await addRosterMember(stu2.studentId);

    const out = await withTestTenant(() =>
      stats.bulkEnter(
        g.id,
        {
          stats: [
            { studentId: stu1.studentId, statCategory: 'GOALS', statValue: 2 },
            { studentId: stu1.studentId, statCategory: 'ASSISTS', statValue: 1 },
            { studentId: stu2.studentId, statCategory: 'GOALS', statValue: 1 },
          ],
        } as any,
        adminActor(),
      ),
    );
    expect(out.length).toBe(3);

    const byGame = await withTestTenant(() => stats.listForGame(g.id));
    expect(byGame.length).toBe(3);

    const forPlayer = await withTestTenant(() => stats.listForPlayer(stu1.studentId));
    expect(forPlayer.length).toBe(2);
  });

  it('bulkEnter: missing game → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        stats.bulkEnter('00000000-0000-0000-0000-000000000000', { stats: [] } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('bulkEnter: empty stats array returns []', async () => {
    const g = await createGame();
    const out = await withTestTenant(() =>
      stats.bulkEnter(g.id, { stats: [] } as any, adminActor()),
    );
    expect(out).toEqual([]);
  });

  it('bulkEnter: student not in roster → BadRequestException', async () => {
    const g = await createGame();
    const stu = await trackedSeedStudent();
    // Do NOT add to roster
    await expect(
      withTestTenant(() =>
        stats.bulkEnter(
          g.id,
          {
            stats: [{ studentId: stu.studentId, statCategory: 'GOALS', statValue: 1 }],
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bulkEnter: duplicate (game, student, category) → BadRequestException', async () => {
    const g = await createGame();
    const stu = await trackedSeedStudent();
    await addRosterMember(stu.studentId);
    await withTestTenant(() =>
      stats.bulkEnter(
        g.id,
        { stats: [{ studentId: stu.studentId, statCategory: 'GOALS', statValue: 1 }] } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        stats.bulkEnter(
          g.id,
          { stats: [{ studentId: stu.studentId, statCategory: 'GOALS', statValue: 2 }] } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bulkEnter: student → ForbiddenException', async () => {
    const g = await createGame();
    await expect(
      withTestTenant(() => stats.bulkEnter(g.id, { stats: [] } as any, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('bulkEnter: actor without employeeId → ForbiddenException', async () => {
    const g = await createGame();
    const ghost: any = {
      accountId: '019e0cf8-aaaa-7777-8888-000000000099',
      personId: '019e0cf8-aaaa-7777-8888-000000000098',
      employeeId: null,
      personType: 'STAFF',
      isSchoolAdmin: true,
    };
    await expect(
      withTestTenant(() => stats.bulkEnter(g.id, { stats: [] } as any, ghost)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // All-time records
  // ─────────────────────────────────────────────────────────────────
  it('createAllTimeRecord + listAllTimeRecords', async () => {
    const dto = await withTestTenant(() =>
      stats.createAllTimeRecord(
        {
          sport: 'Soccer',
          recordType: 'SINGLE_GAME',
          statCategory: 'GOALS',
          recordValue: 5,
          holderNameSnapshot: 'Star Player',
          setDate: '2026-09-10',
          notes: 'historic',
        } as any,
        adminActor(),
      ),
    );
    expect(dto.recordValue).toBe(5);
    expect(dto.holderNameSnapshot).toBe('Star Player');

    const list = await withTestTenant(() => stats.listAllTimeRecords());
    expect(list.map((x) => x.id)).toContain(dto.id);
  });

  it('createAllTimeRecord: duplicate (school, sport, type, category) → BadRequestException', async () => {
    await withTestTenant(() =>
      stats.createAllTimeRecord(
        {
          sport: 'Soccer',
          recordType: 'SINGLE_GAME',
          statCategory: 'GOALS',
          recordValue: 5,
        } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        stats.createAllTimeRecord(
          {
            sport: 'Soccer',
            recordType: 'SINGLE_GAME',
            statCategory: 'GOALS',
            recordValue: 6,
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createAllTimeRecord: student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        stats.createAllTimeRecord(
          { sport: 'X', recordType: 'SINGLE_GAME', statCategory: 'Y', recordValue: 1 } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForPlayer: returns [] if no stats', async () => {
    const stu = await trackedSeedStudent();
    const list = await withTestTenant(() => stats.listForPlayer(stu.studentId));
    expect(list).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  it('cross-school: listAllTimeRecords scopes by school', async () => {
    const aId = generateId();
    const bId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_all_time_records (id, school_id, sport, record_type, stat_category, record_value) VALUES ($1::uuid, $2::uuid, 'Soccer', 'SINGLE_GAME', 'GOALS', 5)`,
      aId,
      TEST_SCHOOL_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_all_time_records (id, school_id, sport, record_type, stat_category, record_value) VALUES ($1::uuid, $2::uuid, 'Basketball', 'SINGLE_GAME', 'POINTS', 10)`,
      bId,
      TEST_SCHOOL_B_ID,
    );
    const aList = await withTestTenant(() => stats.listAllTimeRecords());
    expect(aList.map((r) => r.id)).toContain(aId);
    expect(aList.map((r) => r.id)).not.toContain(bId);
    const bList = await withTestTenantB(() => stats.listAllTimeRecords());
    expect(bList.map((r) => r.id)).toContain(bId);
  });
});
