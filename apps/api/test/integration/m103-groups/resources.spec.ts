import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { ResourceLibraryService } from '@modules/m103-groups/resources/resource-library.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
} from '../helpers/actor';
import {
  resetGroupsAndStudents,
  ensureGroupsSeed,
  TEST_GROUP_OPEN_A_ID,
  TEST_GROUP_B_ID,
} from '../fixtures/groups';
import { ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m103-groups resource library suite. Covers
 * ResourceLibraryService (create + list + getById + patch + delete +
 * addVersion atomic increment + listVersions + UNIQUE(resource_id,
 * version_number) + s3_key/url target_chk + member-gating). Cross-school
 * isolation via assertGroupInCurrentSchool on every surface.
 */
describe('integration:m103-groups/resources', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let groups: GroupService;
  let memberships: MembershipService;
  let resources: ResourceLibraryService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    groups = new GroupService(tenantPrisma);
    memberships = new MembershipService(tenantPrisma, groups);
    resources = new ResourceLibraryService(tenantPrisma, groups);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetGroupsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    await ensureGroupsSeed(rawClient);
  });

  it('create: admin uploads a document resource at version 1', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        {
          title: 'Game Plan',
          description: 'Initial draft',
          resourceType: 'DOCUMENT',
          s3Key: 'gameplans/v1.pdf',
        } as any,
        adminActor(),
      ),
    );
    expect(dto.title).toBe('Game Plan');
    expect(dto.version).toBe(1);
    expect(dto.s3Key).toBe('gameplans/v1.pdf');
  });

  it('create: requires s3Key OR url', async () => {
    await expect(
      withTestTenant(async () =>
        resources.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'Bad', resourceType: 'DOCUMENT' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: link with url only', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        {
          title: 'External Link',
          resourceType: 'LINK',
          url: 'https://example.com/x',
          isPinned: true,
        } as any,
        adminActor(),
      ),
    );
    expect(dto.url).toBe('https://example.com/x');
    expect(dto.isPinned).toBe(true);
  });

  it('create: non-member non-admin → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.create(
          TEST_GROUP_OPEN_A_ID,
          { title: 'X', resourceType: 'DOCUMENT', url: 'https://x.com' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create: cross-school group → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.create(
          TEST_GROUP_B_ID,
          { title: 'X', resourceType: 'DOCUMENT', url: 'https://x.com' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listForGroup: admin sees all resources for the group', async () => {
    await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'A', resourceType: 'DOCUMENT', s3Key: 'a' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'B', resourceType: 'LINK', url: 'https://b' } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(async () =>
      resources.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
    );
    expect(list.length).toBe(2);
  });

  it('listForGroup: non-member → ForbiddenException', async () => {
    await expect(
      withTestTenant(async () => resources.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.getById('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getById: existing — member sees', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'x' } as any,
        adminActor(),
      ),
    );
    const view = await withTestTenant(async () => resources.getById(dto.id, adminActor()));
    expect(view.id).toBe(dto.id);
  });

  it('patch: admin updates title and pin', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'x' } as any,
        adminActor(),
      ),
    );
    const patched = await withTestTenant(async () =>
      resources.patch(
        dto.id,
        { title: 'Renamed', description: 'Updated', isPinned: true } as any,
        adminActor(),
      ),
    );
    expect(patched.title).toBe('Renamed');
    expect(patched.isPinned).toBe(true);
  });

  it('patch: no-op input returns existing DTO', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'x' } as any,
        adminActor(),
      ),
    );
    const noop = await withTestTenant(async () =>
      resources.patch(dto.id, {} as any, adminActor()),
    );
    expect(noop.id).toBe(dto.id);
  });

  it('patch: non-uploader non-manager → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'x' } as any,
        adminActor(),
      ),
    );
    // join student as member, but they're not the uploader and not a manager
    await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    await expect(
      withTestTenant(async () =>
        resources.patch(dto.id, { title: 'Mine' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('patch: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.patch(
          '00000000-0000-0000-0000-000000000000',
          { title: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('addVersion: increments monotonically inside one tx', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1.pdf' } as any,
        adminActor(),
      ),
    );
    const v2 = await withTestTenant(async () =>
      resources.addVersion(
        dto.id,
        { s3Key: 'v2.pdf', changeNotes: 'Round 2 edits' } as any,
        adminActor(),
      ),
    );
    expect(v2.versionNumber).toBe(2);
    const v3 = await withTestTenant(async () =>
      resources.addVersion(
        dto.id,
        { url: 'https://example.com/v3', changeNotes: 'Out for review' } as any,
        adminActor(),
      ),
    );
    expect(v3.versionNumber).toBe(3);

    // Parent row should reflect latest version
    const reread = await withTestTenant(async () => resources.getById(dto.id, adminActor()));
    expect(reread.version).toBe(3);
    expect(reread.url).toBe('https://example.com/v3');
  });

  it('addVersion: requires s3Key OR url', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () => resources.addVersion(dto.id, {} as any, adminActor())),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addVersion: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.addVersion(
          '00000000-0000-0000-0000-000000000000',
          { s3Key: 'x' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('addVersion: non-member → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        resources.addVersion(dto.id, { s3Key: 'v2' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listVersions: returns ordered history', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      resources.addVersion(dto.id, { s3Key: 'v2' } as any, adminActor()),
    );
    await withTestTenant(async () =>
      resources.addVersion(dto.id, { s3Key: 'v3' } as any, adminActor()),
    );
    const list = await withTestTenant(async () => resources.listVersions(dto.id, adminActor()));
    expect(list.length).toBe(2);
    expect(list[0]!.versionNumber).toBe(3);
    expect(list[1]!.versionNumber).toBe(2);
  });

  it('remove: admin deletes; cascades versions', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      resources.addVersion(dto.id, { s3Key: 'v2' } as any, adminActor()),
    );
    const r = await withTestTenant(async () => resources.remove(dto.id, adminActor()));
    expect(r.ok).toBe(true);
    // Versions should be gone via CASCADE
    const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM ${TEST_SCHEMA}.grp_resource_versions WHERE resource_id = $1::uuid`,
      dto.id,
    );
    expect(rows.length).toBe(0);
  });

  it('remove: non-uploader non-manager → ForbiddenException', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
    );
    await expect(
      withTestTenant(async () => resources.remove(dto.id, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('remove: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(async () =>
        resources.remove('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('UNIQUE(resource_id, version_number): manual collision fails at DB layer', async () => {
    const dto = await withTestTenant(async () =>
      resources.create(
        TEST_GROUP_OPEN_A_ID,
        { title: 'X', resourceType: 'DOCUMENT', s3Key: 'v1' } as any,
        adminActor(),
      ),
    );
    await withTestTenant(async () =>
      resources.addVersion(dto.id, { s3Key: 'v2' } as any, adminActor()),
    );
    // Manually try to insert version_number=2 again — UNIQUE blocks
    await expect(
      rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.grp_resource_versions
           (id, resource_id, version_number, s3_key, uploaded_by)
         VALUES (gen_random_uuid(), $1::uuid, 2, 'dup', $2::uuid)`,
        dto.id,
        '019e0cf8-aaaa-7777-8888-000000000011', // admin account id
      ),
    ).rejects.toThrow(/already exists|duplicate|unique|23505/i);
  });

  it('cross-school: School A admin cannot read School B resources via listForGroup', async () => {
    // Seed a resource in School B
    await withTestTenantB(async () =>
      resources.create(
        TEST_GROUP_B_ID,
        { title: 'B', resourceType: 'DOCUMENT', s3Key: 'b' } as any,
        adminActor(),
      ),
    );
    // listForGroup applies assertGroupInCurrentSchool (Forbidden) before
    // any other check.
    await expect(
      withTestTenant(async () => resources.listForGroup(TEST_GROUP_B_ID, adminActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cross-school: patch on School B resource from School A context → ForbiddenException', async () => {
    const dto = await withTestTenantB(async () =>
      resources.create(
        TEST_GROUP_B_ID,
        { title: 'B', resourceType: 'DOCUMENT', s3Key: 'b' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        resources.patch(dto.id, { title: 'Hijack' } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cross-school: addVersion on School B resource from School A context → ForbiddenException', async () => {
    const dto = await withTestTenantB(async () =>
      resources.create(
        TEST_GROUP_B_ID,
        { title: 'B', resourceType: 'DOCUMENT', s3Key: 'b' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () =>
        resources.addVersion(dto.id, { s3Key: 'b2' } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cross-school: remove on School B resource from School A context → ForbiddenException', async () => {
    const dto = await withTestTenantB(async () =>
      resources.create(
        TEST_GROUP_B_ID,
        { title: 'B', resourceType: 'DOCUMENT', s3Key: 'b' } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(async () => resources.remove(dto.id, adminActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
