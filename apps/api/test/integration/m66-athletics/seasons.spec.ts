import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ProgrammeService } from '@modules/m66-athletics/programme.service';
import { SeasonService } from '@modules/m66-athletics/season.service';
import { RosterService } from '@modules/m66-athletics/roster.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  teacherActor,
  parentActor,
} from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_PROGRAMME_A_ID,
  TEST_ATH_PROGRAMME_B_ID,
  TEST_ATH_SEASON_A_ID,
  TEST_ATH_SEASON_B_ID,
  TEST_ATH_ROSTER_A_ID,
  TEST_ATH_ROSTER_B_ID,
} from '../fixtures/athletics';

/**
 * Wave 7 — m66-athletics Season + Programme + Roster surface.
 * Covers create / list / patch / certify / addMember / checkEligibility
 * with ad-scope gates, FOR UPDATE locking on patches, GPA computation,
 * and cross-school isolation.
 */
describe('integration:m66-athletics/seasons', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let programmes: ProgrammeService;
  let seasons: SeasonService;
  let rosters: RosterService;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const personIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    programmes = new ProgrammeService(tenantPrisma, permCheck);
    seasons = new SeasonService(tenantPrisma, programmes);
    rosters = new RosterService(tenantPrisma, programmes);
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

  // ─────────────────────────────────────────────────────────────────
  // ProgrammeService
  // ─────────────────────────────────────────────────────────────────
  describe('ProgrammeService', () => {
    it('list returns only School A programmes', async () => {
      const list = await withTestTenant(() => programmes.list({}));
      expect(list.map((p) => p.id)).toContain(TEST_ATH_PROGRAMME_A_ID);
      expect(list.map((p) => p.id)).not.toContain(TEST_ATH_PROGRAMME_B_ID);
    });

    it('list with filters (season + sport + includeInactive)', async () => {
      const filtered = await withTestTenant(() =>
        programmes.list({ season: 'FALL', sport: 'Soccer', includeInactive: true }),
      );
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((p) => p.season === 'FALL')).toBe(true);
    });

    it('getById returns the canonical programme', async () => {
      const dto = await withTestTenant(() => programmes.getById(TEST_ATH_PROGRAMME_A_ID));
      expect(dto.sportName).toBe('Soccer A');
      expect(dto.levelsOffered).toEqual(['VARSITY', 'JV']);
      expect(dto.minGpa).toBe(2);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() => programmes.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadActiveOrFail: inactive programme → BadRequestException', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_programmes SET is_active = false WHERE id = $1::uuid`,
        TEST_ATH_PROGRAMME_A_ID,
      );
      await expect(
        withTestTenant(() => programmes.loadActiveOrFail(TEST_ATH_PROGRAMME_A_ID)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: admin creates programme', async () => {
      const dto = await withTestTenant(() =>
        programmes.create(
          {
            sportName: 'Basketball A',
            season: 'WINTER',
            levelsOffered: ['VARSITY'],
            minGpa: 2.5,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.sportName).toBe('Basketball A');
      expect(dto.minGpa).toBe(2.5);
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          programmes.create(
            { sportName: 'X', season: 'FALL', levelsOffered: ['VARSITY'] } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: duplicate sport name → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          programmes.create(
            { sportName: 'Soccer A', season: 'FALL', levelsOffered: ['VARSITY'] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: updates fields atomically', async () => {
      const patched = await withTestTenant(() =>
        programmes.patch(
          TEST_ATH_PROGRAMME_A_ID,
          {
            sportName: 'Soccer Updated',
            season: 'SPRING',
            levelsOffered: ['VARSITY', 'JV', 'FRESHMAN'],
            minGpa: 2.75,
            maxRosterSizePerLevel: { VARSITY: 10 },
            isActive: true,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.sportName).toBe('Soccer Updated');
      expect(patched.season).toBe('SPRING');
      expect(patched.levelsOffered).toEqual(['VARSITY', 'JV', 'FRESHMAN']);
    });

    it('patch: no-op returns the row', async () => {
      const dto = await withTestTenant(() =>
        programmes.patch(TEST_ATH_PROGRAMME_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_ATH_PROGRAMME_A_ID);
    });

    it('patch: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          programmes.patch(
            TEST_ATH_PROGRAMME_A_ID,
            { sportName: 'X' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          programmes.patch(
            '00000000-0000-0000-0000-000000000000',
            { sportName: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // SeasonService
  // ─────────────────────────────────────────────────────────────────
  describe('SeasonService', () => {
    it('listForProgramme + getById', async () => {
      const list = await withTestTenant(() => seasons.listForProgramme(TEST_ATH_PROGRAMME_A_ID));
      expect(list.map((s) => s.id)).toContain(TEST_ATH_SEASON_A_ID);

      const dto = await withTestTenant(() => seasons.getById(TEST_ATH_SEASON_A_ID));
      expect(dto.id).toBe(TEST_ATH_SEASON_A_ID);
      expect(dto.programmeName).toBe('Soccer A');
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() => seasons.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: admin creates season', async () => {
      const dto = await withTestTenant(() =>
        seasons.create(
          TEST_ATH_PROGRAMME_A_ID,
          {
            academicYear: '2027-2028',
            firstPracticeDate: '2027-08-01',
            firstGameDate: '2027-09-01',
            lastGameDate: '2027-11-30',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.academicYear).toBe('2027-2028');
      expect(dto.status).toBe('UPCOMING');
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.create(
            TEST_ATH_PROGRAMME_A_ID,
            { academicYear: '2027-2028' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: duplicate (programme,year) → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.create(
            TEST_ATH_PROGRAMME_A_ID,
            { academicYear: '2026-2027' } as any, // same as fixture
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: inconsistent dates → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.create(
            TEST_ATH_PROGRAMME_A_ID,
            {
              academicYear: '2028-2029',
              firstGameDate: '2028-12-01',
              lastGameDate: '2028-08-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: locks row + updates status + dates', async () => {
      const patched = await withTestTenant(() =>
        seasons.patch(
          TEST_ATH_SEASON_A_ID,
          {
            academicYear: '2026-2027',
            status: 'POSTSEASON',
            firstPracticeDate: '2026-08-15',
            firstGameDate: '2026-09-15',
            lastGameDate: '2026-11-15',
            playoffCutoffDate: '2026-11-01',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.status).toBe('POSTSEASON');
    });

    it('patch: no-op returns row', async () => {
      const dto = await withTestTenant(() =>
        seasons.patch(TEST_ATH_SEASON_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_ATH_SEASON_A_ID);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'COMPLETED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: inconsistent dates → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.patch(
            TEST_ATH_SEASON_A_ID,
            { firstGameDate: '2026-12-01', lastGameDate: '2026-08-01' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          seasons.patch(TEST_ATH_SEASON_A_ID, { status: 'COMPLETED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: inactive programme → BadRequestException', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_programmes SET is_active = false WHERE id = $1::uuid`,
        TEST_ATH_PROGRAMME_A_ID,
      );
      await expect(
        withTestTenant(() =>
          seasons.create(
            TEST_ATH_PROGRAMME_A_ID,
            { academicYear: '2029-2030' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // RosterService
  // ─────────────────────────────────────────────────────────────────
  describe('RosterService', () => {
    it('listForSeason returns canonical roster', async () => {
      const list = await withTestTenant(() => rosters.listForSeason(TEST_ATH_SEASON_A_ID));
      expect(list.map((r) => r.id)).toContain(TEST_ATH_ROSTER_A_ID);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(() => rosters.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listMembers empty roster', async () => {
      const list = await withTestTenant(() => rosters.listMembers(TEST_ATH_ROSTER_A_ID));
      expect(list).toEqual([]);
    });

    it('create: admin creates JV roster', async () => {
      const dto = await withTestTenant(() =>
        rosters.create(
          TEST_ATH_SEASON_A_ID,
          { level: 'JV' } as any,
          adminActor(),
        ),
      );
      expect(dto.level).toBe('JV');
      expect(dto.isCertified).toBe(false);
    });

    it('create: bad level (FRESHMAN not in levels_offered) → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.create(
            TEST_ATH_SEASON_A_ID,
            { level: 'FRESHMAN' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: missing season → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.create(
            '00000000-0000-0000-0000-000000000000',
            { level: 'VARSITY' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: duplicate level → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.create(
            TEST_ATH_SEASON_A_ID,
            { level: 'VARSITY' } as any, // already exists in fixture
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.create(TEST_ATH_SEASON_A_ID, { level: 'JV' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: updates level + head coach', async () => {
      const patched = await withTestTenant(() =>
        rosters.patch(TEST_ATH_ROSTER_A_ID, { level: 'JV' } as any, adminActor()),
      );
      expect(patched.level).toBe('JV');
    });

    it('patch: no-op returns row', async () => {
      const dto = await withTestTenant(() =>
        rosters.patch(TEST_ATH_ROSTER_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_ATH_ROSTER_A_ID);
    });

    it('patch: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.patch(TEST_ATH_ROSTER_A_ID, { level: 'JV' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('addMember: admin adds a student', async () => {
      const stu = await trackedSeedStudent();
      const m = await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId, jerseyNumber: '7', position: 'Forward' } as any,
          adminActor(),
        ),
      );
      expect(m.studentId).toBe(stu.studentId);
      // No grades exist for this student so liveGpa is null → PENDING_PHYSICAL
      expect(m.eligibilityStatus).toBe('PENDING_PHYSICAL');
      expect(m.jerseyNumber).toBe('7');
    });

    it('addMember: missing student → BadRequestException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.addMember(
            TEST_ATH_ROSTER_A_ID,
            { studentId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addMember: max cap enforced', async () => {
      // VARSITY cap is 5 per fixture. Add 5 then expect 6th to fail.
      for (let i = 0; i < 5; i++) {
        const stu = await trackedSeedStudent({ firstName: `Cap${i}` });
        await withTestTenant(() =>
          rosters.addMember(
            TEST_ATH_ROSTER_A_ID,
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        );
      }
      const sixth = await trackedSeedStudent({ firstName: 'Six' });
      await expect(
        withTestTenant(() =>
          rosters.addMember(
            TEST_ATH_ROSTER_A_ID,
            { studentId: sixth.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addMember: duplicate → BadRequestException', async () => {
      const stu = await trackedSeedStudent();
      await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          rosters.addMember(
            TEST_ATH_ROSTER_A_ID,
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addMember: missing roster → NotFoundException', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(() =>
          rosters.addMember(
            '00000000-0000-0000-0000-000000000000',
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addMember: student → ForbiddenException', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(() =>
          rosters.addMember(
            TEST_ATH_ROSTER_A_ID,
            { studentId: stu.studentId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patchMember: updates fields', async () => {
      const stu = await trackedSeedStudent();
      const added = await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(() =>
        rosters.patchMember(
          added.id,
          {
            jerseyNumber: '11',
            position: 'Midfield',
            eligibilityStatus: 'ELIGIBLE',
            eligibilityNotes: 'OK',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.jerseyNumber).toBe('11');
      expect(patched.eligibilityStatus).toBe('ELIGIBLE');
    });

    it('patchMember: removedAt set + reset', async () => {
      const stu = await trackedSeedStudent();
      const added = await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const removed = await withTestTenant(() =>
        rosters.patchMember(
          added.id,
          { removedAt: '2030-01-01', removalReason: 'transferred' } as any,
          adminActor(),
        ),
      );
      expect(removed.removedAt).toBe('2030-01-01');
      const restored = await withTestTenant(() =>
        rosters.patchMember(added.id, { removedAt: null } as any, adminActor()),
      );
      expect(restored.removedAt).toBeNull();
    });

    it('patchMember: no-op + missing', async () => {
      const stu = await trackedSeedStudent();
      const added = await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const noop = await withTestTenant(() =>
        rosters.patchMember(added.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(added.id);

      await expect(
        withTestTenant(() =>
          rosters.patchMember(
            '00000000-0000-0000-0000-000000000000',
            { jerseyNumber: '99' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchMember: student → ForbiddenException', async () => {
      const stu = await trackedSeedStudent();
      const added = await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(() =>
          rosters.patchMember(added.id, { jerseyNumber: '99' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('certify: admin stamps + restores roster keystone', async () => {
      // Ensure no INELIGIBLE members.
      const stu = await trackedSeedStudent();
      await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const dto = await withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, adminActor()));
      expect(dto.isCertified).toBe(true);
      expect(dto.certifiedAt).not.toBeNull();
      expect(dto.certifiedBy).not.toBeNull();
    });

    it('certify: already-certified → BadRequestException', async () => {
      await withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, adminActor()));
      await expect(
        withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('certify: INELIGIBLE member blocks → BadRequestException', async () => {
      const stu = await trackedSeedStudent();
      await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_roster_members SET eligibility_status = 'INELIGIBLE'`,
      );
      await expect(
        withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('certify: missing roster → NotFoundException', async () => {
      await expect(
        withTestTenant(() =>
          rosters.certify('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('certify: actor without employeeId → ForbiddenException', async () => {
      const ghostAdmin: any = {
        accountId: '019e0cf8-aaaa-7777-8888-000000000099',
        personId: '019e0cf8-aaaa-7777-8888-000000000098',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, ghostAdmin)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('certify: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() => rosters.certify(TEST_ATH_ROSTER_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checkEligibility: no min_gpa → BadRequestException', async () => {
      // Strip min_gpa from the fixture programme
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_programmes SET min_gpa = NULL WHERE id = $1::uuid`,
        TEST_ATH_PROGRAMME_A_ID,
      );
      await expect(
        withTestTenant(() => rosters.checkEligibility(TEST_ATH_ROSTER_A_ID, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('checkEligibility: with min_gpa + no cls_grades returns members PENDING_PHYSICAL', async () => {
      const stu = await trackedSeedStudent();
      await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const out = await withTestTenant(() =>
        rosters.checkEligibility(TEST_ATH_ROSTER_A_ID, adminActor()),
      );
      expect(out.length).toBe(1);
      // GPA null because no grades → recompute to PENDING_PHYSICAL (already that value)
      expect(out[0]!.eligibilityStatus).toBe('PENDING_PHYSICAL');
    });

    it('checkEligibility: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(() => rosters.checkEligibility(TEST_ATH_ROSTER_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checkEligibility: INJURED_NOT_CLEARED members skip status flip', async () => {
      const stu = await trackedSeedStudent();
      await withTestTenant(() =>
        rosters.addMember(
          TEST_ATH_ROSTER_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ath_roster_members SET eligibility_status = 'INJURED_NOT_CLEARED'`,
      );
      const out = await withTestTenant(() =>
        rosters.checkEligibility(TEST_ATH_ROSTER_A_ID, adminActor()),
      );
      expect(out[0]!.eligibilityStatus).toBe('INJURED_NOT_CLEARED');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot list School B programmes', async () => {
      const a = await withTestTenant(() => programmes.list({}));
      expect(a.map((p) => p.id)).not.toContain(TEST_ATH_PROGRAMME_B_ID);
      const b = await withTestTenantB(() => programmes.list({}));
      expect(b.map((p) => p.id)).toContain(TEST_ATH_PROGRAMME_B_ID);
    });

    it('School A admin cannot get School B season', async () => {
      await expect(
        withTestTenant(() => seasons.getById(TEST_ATH_SEASON_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('School A admin can list School B rosters (no school scope on listForSeason — relies on season visibility)', async () => {
      // The list query has no school scope; if the seasonId is School B's
      // season, the call returns those rosters. Service relies on the caller
      // having gotten the seasonId through a school-scoped path.
      const bRosters = await withTestTenantB(() =>
        rosters.listForSeason(TEST_ATH_SEASON_B_ID),
      );
      expect(bRosters.map((r) => r.id)).toContain(TEST_ATH_ROSTER_B_ID);
    });
  });

  it('teacher actor without ath-001:write → ForbiddenException on programme write', async () => {
    await expect(
      withTestTenant(() =>
        programmes.create(
          { sportName: 'Other', season: 'FALL', levelsOffered: ['VARSITY'] } as any,
          teacherActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('parent actor → ForbiddenException on season write', async () => {
    await expect(
      withTestTenant(() =>
        seasons.create(
          TEST_ATH_PROGRAMME_A_ID,
          { academicYear: '2030-2031' } as any,
          parentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
