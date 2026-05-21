import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TeamMediaService } from '@modules/m66-athletics/team-media.service';
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

describe('integration:m66-athletics/team-media', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let media: TeamMediaService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    media = new TeamMediaService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    await ensureAthleticsSeed(rawClient);
  });

  // ─────────────────────────────────────────────────────────────────
  // Photos
  // ─────────────────────────────────────────────────────────────────
  it('createPhoto + listForRoster', async () => {
    const p = await withTestTenant(() =>
      media.createPhoto(
        {
          rosterId: TEST_ATH_ROSTER_A_ID,
          photoType: 'TEAM_PHOTO',
          s3Key: 'photos/team.jpg',
          caption: 'team',
        } as any,
        adminActor(),
      ),
    );
    expect(p.rosterId).toBe(TEST_ATH_ROSTER_A_ID);
    expect(p.photoType).toBe('TEAM_PHOTO');

    const list = await withTestTenant(() => media.listForRoster(TEST_ATH_ROSTER_A_ID));
    expect(list.map((x) => x.id)).toContain(p.id);
  });

  it('createPhoto: missing roster → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        media.createPhoto(
          {
            rosterId: '00000000-0000-0000-0000-000000000000',
            photoType: 'TEAM_PHOTO',
            s3Key: 'x',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createPhoto: foreign roster → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        media.createPhoto(
          {
            rosterId: TEST_ATH_ROSTER_B_ID,
            photoType: 'TEAM_PHOTO',
            s3Key: 'x',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createPhoto: student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        media.createPhoto(
          {
            rosterId: TEST_ATH_ROSTER_A_ID,
            photoType: 'INDIVIDUAL',
            s3Key: 'x',
          } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForRoster: missing roster → NotFoundException', async () => {
    await expect(
      withTestTenant(() => media.listForRoster('00000000-0000-0000-0000-000000000000')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Media assets
  // ─────────────────────────────────────────────────────────────────
  it('createAsset (logo, no programme/season) + listMedia', async () => {
    const a = await withTestTenant(() =>
      media.createAsset(
        {
          assetType: 'LOGO',
          s3Key: 'logos/school.png',
          title: 'School crest',
        } as any,
        adminActor(),
      ),
    );
    expect(a.assetType).toBe('LOGO');
    expect(a.programmeId).toBeNull();

    const list = await withTestTenant(() => media.listMedia({ assetType: 'LOGO' }));
    expect(list.map((x) => x.id)).toContain(a.id);
  });

  it('createAsset + listForProgramme', async () => {
    const a = await withTestTenant(() =>
      media.createAsset(
        {
          programmeId: TEST_ATH_PROGRAMME_A_ID,
          assetType: 'PHOTO',
          s3Key: 'gallery/x.jpg',
          title: 'Action',
        } as any,
        adminActor(),
      ),
    );
    expect(a.programmeId).toBe(TEST_ATH_PROGRAMME_A_ID);

    const byProg = await withTestTenant(() => media.listForProgramme(TEST_ATH_PROGRAMME_A_ID));
    expect(byProg.map((x) => x.id)).toContain(a.id);

    const filtered = await withTestTenant(() =>
      media.listMedia({
        programmeId: TEST_ATH_PROGRAMME_A_ID,
        assetType: 'PHOTO',
      }),
    );
    expect(filtered.map((x) => x.id)).toContain(a.id);
  });

  it('createAsset: foreign programme → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        media.createAsset(
          {
            programmeId: TEST_ATH_PROGRAMME_B_ID,
            assetType: 'PHOTO',
            s3Key: 'x',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createAsset: foreign season → BadRequestException', async () => {
    await expect(
      withTestTenant(() =>
        media.createAsset(
          {
            seasonId: TEST_ATH_SEASON_B_ID,
            assetType: 'PHOTO',
            s3Key: 'x',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createAsset: programme + season mismatch → BadRequestException', async () => {
    // programmeId A but seasonId B
    await expect(
      withTestTenant(() =>
        media.createAsset(
          {
            programmeId: TEST_ATH_PROGRAMME_A_ID,
            seasonId: TEST_ATH_SEASON_B_ID,
            assetType: 'PHOTO',
            s3Key: 'x',
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createAsset: programme + matching season succeeds', async () => {
    const a = await withTestTenant(() =>
      media.createAsset(
        {
          programmeId: TEST_ATH_PROGRAMME_A_ID,
          seasonId: TEST_ATH_SEASON_A_ID,
          assetType: 'VIDEO',
          s3Key: 'v/1.mp4',
          title: 'Highlight',
          description: 'desc',
        } as any,
        adminActor(),
      ),
    );
    expect(a.seasonId).toBe(TEST_ATH_SEASON_A_ID);

    const list = await withTestTenant(() => media.listMedia({ seasonId: TEST_ATH_SEASON_A_ID }));
    expect(list.map((x) => x.id)).toContain(a.id);
  });

  it('createAsset: student → ForbiddenException', async () => {
    await expect(
      withTestTenant(() =>
        media.createAsset({ assetType: 'PHOTO', s3Key: 'x' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listMedia: returns empty when no rows', async () => {
    const list = await withTestTenant(() => media.listMedia({}));
    expect(list).toEqual([]);
  });

  it('listForProgramme: returns empty for programme with no media', async () => {
    const list = await withTestTenant(() => media.listForProgramme(TEST_ATH_PROGRAMME_A_ID));
    expect(list).toEqual([]);
  });

  it('hasMediaScope: admin → true', async () => {
    const ok = await withTestTenant(() => media.hasMediaScope(adminActor()));
    expect(ok).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school
  // ─────────────────────────────────────────────────────────────────
  it('cross-school: School A media list excludes School B rows', async () => {
    const bId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.ath_media_assets (id, school_id, programme_id, asset_type, s3_key) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PHOTO', 'b/1.jpg')`,
      bId,
      TEST_SCHOOL_B_ID,
      TEST_ATH_PROGRAMME_B_ID,
    );
    const aList = await withTestTenant(() => media.listMedia({}));
    expect(aList.map((x) => x.id)).not.toContain(bId);
    const bList = await withTestTenantB(() => media.listMedia({}));
    expect(bList.map((x) => x.id)).toContain(bId);
  });
});
