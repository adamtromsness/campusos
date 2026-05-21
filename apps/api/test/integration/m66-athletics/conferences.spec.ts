import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ConferenceService } from '@modules/m66-athletics/conference.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_PROGRAMME_A_ID,
  TEST_ATH_PROGRAMME_B_ID,
  TEST_ATH_SEASON_A_ID,
} from '../fixtures/athletics';

/**
 * Conference catalogue requires PLATFORM-scope admin authority
 * (BLOCKING 3). Tenant ADs can manage memberships and schedule entries
 * involving their own school only, never fabricate cross-school games.
 */
describe('integration:m66-athletics/conferences', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let conferences: ConferenceService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    conferences = new ConferenceService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    await ensureAthleticsSeed(rawClient);
  });

  async function seedConferenceDirect(name = 'Big Test Conf', sport = 'Soccer A') {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_conferences (id, name, sport, region, governing_body, is_active) VALUES ($1::uuid, $2, $3, 'West', 'NFHS', true)`,
      id,
      name,
      sport,
    );
    return id;
  }

  // ─────────────────────────────────────────────────────────────────
  // Conference catalogue
  // ─────────────────────────────────────────────────────────────────
  it('create: tenant AD → ForbiddenException (BLOCKING 3)', async () => {
    await expect(
      withTestTenant(() =>
        conferences.create({ name: 'X League', sport: 'Soccer' } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: tenant AD → ForbiddenException', async () => {
    const cId = await seedConferenceDirect('PatchTarget', 'Soccer A');
    await expect(
      withTestTenant(() => conferences.patch(cId, { name: 'Renamed' } as any, adminActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('list + getById visible to tenant', async () => {
    const cId = await seedConferenceDirect();
    const list = await withTestTenant(() => conferences.list({}));
    expect(list.map((c) => c.id)).toContain(cId);

    const filtered = await withTestTenant(() =>
      conferences.list({ sport: 'Soccer A', includeInactive: true }),
    );
    expect(filtered.length).toBeGreaterThan(0);

    const got = await withTestTenant(() => conferences.getById(cId));
    expect(got.id).toBe(cId);
  });

  it('list: includeInactive flag', async () => {
    const cId = await seedConferenceDirect('InactConf');
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.ath_conferences SET is_active = false WHERE id = $1::uuid`,
      cId,
    );
    const active = await withTestTenant(() => conferences.list({}));
    expect(active.map((c) => c.id)).not.toContain(cId);
    const all = await withTestTenant(() => conferences.list({ includeInactive: true }));
    expect(all.map((c) => c.id)).toContain(cId);
  });

  it('getById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() => conferences.getById('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Memberships
  // ─────────────────────────────────────────────────────────────────
  it('addMembership: tenant AD adds own-school programme', async () => {
    const cId = await seedConferenceDirect();
    const m = await withTestTenant(() =>
      conferences.addMembership(
        cId,
        {
          programmeId: TEST_ATH_PROGRAMME_A_ID,
          joinedDate: '2026-08-01',
          level: 'D1',
        } as any,
        adminActor(),
      ),
    );
    expect(m.programmeId).toBe(TEST_ATH_PROGRAMME_A_ID);
    expect(m.schoolId).toBe(TEST_SCHOOL_ID);

    const list = await withTestTenant(() => conferences.listMemberships(cId));
    expect(list.map((x) => x.id)).toContain(m.id);
  });

  it('addMembership: foreign programme → BadRequestException (REVIEW-P2-8 BLOCKING 3)', async () => {
    const cId = await seedConferenceDirect();
    await expect(
      withTestTenant(() =>
        conferences.addMembership(
          cId,
          { programmeId: TEST_ATH_PROGRAMME_B_ID } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addMembership: duplicate → BadRequestException', async () => {
    const cId = await seedConferenceDirect();
    await withTestTenant(() =>
      conferences.addMembership(cId, { programmeId: TEST_ATH_PROGRAMME_A_ID } as any, adminActor()),
    );
    await expect(
      withTestTenant(() =>
        conferences.addMembership(
          cId,
          { programmeId: TEST_ATH_PROGRAMME_A_ID } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addMembership: missing conference → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        conferences.addMembership(
          '00000000-0000-0000-0000-000000000000',
          { programmeId: TEST_ATH_PROGRAMME_A_ID } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('addMembership: student → ForbiddenException', async () => {
    const cId = await seedConferenceDirect();
    await expect(
      withTestTenant(() =>
        conferences.addMembership(
          cId,
          { programmeId: TEST_ATH_PROGRAMME_A_ID } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Schedules
  // ─────────────────────────────────────────────────────────────────
  it('addScheduleEntry: own-school as home', async () => {
    const cId = await seedConferenceDirect();
    const s = await withTestTenant(() =>
      conferences.addScheduleEntry(
        cId,
        {
          seasonId: TEST_ATH_SEASON_A_ID,
          homeSchoolId: TEST_SCHOOL_ID,
          awaySchoolId: TEST_SCHOOL_B_ID,
          scheduledDate: '2026-09-15',
          scheduledTime: '15:00',
          notes: 'Conf game',
        } as any,
        adminActor(),
      ),
    );
    expect(s.homeSchoolId).toBe(TEST_SCHOOL_ID);
    expect(s.awaySchoolId).toBe(TEST_SCHOOL_B_ID);
    expect(s.scheduledTime).toBe('15:00');

    const list = await withTestTenant(() => conferences.listSchedule(cId));
    expect(list.map((x) => x.id)).toContain(s.id);
  });

  it('addScheduleEntry: own-school as away allowed', async () => {
    const cId = await seedConferenceDirect();
    const s = await withTestTenant(() =>
      conferences.addScheduleEntry(
        cId,
        {
          homeSchoolId: TEST_SCHOOL_B_ID,
          awaySchoolId: TEST_SCHOOL_ID,
          scheduledDate: '2026-09-15',
        } as any,
        adminActor(),
      ),
    );
    expect(s.awaySchoolId).toBe(TEST_SCHOOL_ID);
  });

  it('addScheduleEntry: both rosters foreign → ForbiddenException (BLOCKING 3)', async () => {
    const cId = await seedConferenceDirect();
    // Use two random school ids (neither = TEST_SCHOOL_ID)
    await expect(
      withTestTenant(() =>
        conferences.addScheduleEntry(
          cId,
          {
            homeSchoolId: '019e0cf8-aaaa-7777-8888-0000000000d0',
            awaySchoolId: '019e0cf8-aaaa-7777-8888-0000000000d1',
            scheduledDate: '2026-09-15',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('addScheduleEntry: same home + away → BadRequestException', async () => {
    const cId = await seedConferenceDirect();
    await expect(
      withTestTenant(() =>
        conferences.addScheduleEntry(
          cId,
          {
            homeSchoolId: TEST_SCHOOL_ID,
            awaySchoolId: TEST_SCHOOL_ID,
            scheduledDate: '2026-09-15',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addScheduleEntry: foreign season → BadRequestException', async () => {
    const cId = await seedConferenceDirect();
    await expect(
      withTestTenant(() =>
        conferences.addScheduleEntry(
          cId,
          {
            seasonId: '00000000-0000-0000-0000-000000000000',
            homeSchoolId: TEST_SCHOOL_ID,
            awaySchoolId: TEST_SCHOOL_B_ID,
            scheduledDate: '2026-09-15',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addScheduleEntry: student → ForbiddenException', async () => {
    const cId = await seedConferenceDirect();
    await expect(
      withTestTenant(() =>
        conferences.addScheduleEntry(
          cId,
          {
            homeSchoolId: TEST_SCHOOL_ID,
            awaySchoolId: TEST_SCHOOL_B_ID,
            scheduledDate: '2026-09-15',
          } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listMemberships + listSchedule on missing conference → NotFoundException', async () => {
    await expect(
      withTestTenant(() => conferences.listMemberships('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withTestTenant(() => conferences.listSchedule('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hasConferenceScope + hasCatalogueAdminScope', async () => {
    const a = await withTestTenant(() => conferences.hasConferenceScope(adminActor()));
    expect(a).toBe(true);
    const cas = await withTestTenant(() => conferences.hasCatalogueAdminScope(adminActor()));
    // School admin is not platform admin
    expect(cas).toBe(false);
  });
});
