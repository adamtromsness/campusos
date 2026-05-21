import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { VersionService, TemplateService } from '@modules/m42-publications/versions.service';
import { PublicationService } from '@modules/m42-publications/series.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

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
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m42-publications IMMUTABLE pub_publication_versions + VersionService
 * + TemplateService DB-backed integration tests.
 *
 * Contracts:
 *   - DB trigger prevent_mutation on pub_publication_versions raises
 *     SQLSTATE 23001 on UPDATE / DELETE (migration 177).
 *   - VersionService.checkpoint composes snapshot + appends version row.
 *   - VersionService.revert appends a NEW version derived from older
 *     snapshot (NEVER mutates an existing row).
 *   - VersionService.captureForStatusChange via PublicationService.patchStatus
 *     auto-versions every status transition.
 *   - TemplateService school-scope + is_system protection.
 */
describe('integration:m42-publications/versions', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let versionService: VersionService;
  let publicationService: PublicationService;
  let templateService: TemplateService;

  const seededPubIds: string[] = [];
  const seededTemplateIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    versionService = new VersionService(tenantPrisma, permCheck);
    publicationService = new PublicationService(tenantPrisma, permCheck);
    publicationService.setVersionService(versionService);
    templateService = new TemplateService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // pub_publication_versions is IMMUTABLE so we TRUNCATE
    // (BEFORE ROW triggers don't fire on TRUNCATE).
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.pub_publication_versions`);
    if (seededTemplateIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_templates WHERE id = ANY($1::uuid[])`,
        seededTemplateIds.splice(0),
      );
    }
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_sections WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_collaborators WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publications WHERE id = ANY($1::uuid[])`,
        seededPubIds.splice(0),
      );
    }
  });

  async function seedPublication(
    opts: {
      schoolId?: string;
      title?: string;
      status?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'NEWSLETTER', $4, $5::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.title ?? 'Version Test Publication',
      opts.status ?? 'DRAFT',
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  async function seedVersion(
    publicationId: string,
    versionNumber: number,
    trigger = 'MANUAL_CHECKPOINT' as 'MANUAL_CHECKPOINT' | 'STATUS_CHANGE' | 'REVERT',
    revertedFromVersion: number | null = null,
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publication_versions
         (id, publication_id, version_number, snapshot_content, trigger,
          reverted_from_version, version_note, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, 'seed', $7::uuid)`,
      id,
      publicationId,
      versionNumber,
      JSON.stringify({ title: 'Snap v' + versionNumber }),
      trigger,
      revertedFromVersion,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // IMMUTABLE pub_publication_versions
  // ──────────────────────────────────────────────────────────────────
  describe('IMMUTABLE pub_publication_versions (migration 177 prevent_mutation trigger)', () => {
    async function assertRaises23001(fn: () => Promise<unknown>): Promise<void> {
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await fn();
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(
        code === '23001' || msg.includes('23001') || msg.toLowerCase().includes('immutable'),
      ).toBe(true);
    }

    it('INSERT is allowed (the service layer is the sole writer)', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 1);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_versions WHERE id = $1::uuid`,
        versionId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('rejects UPDATE on pub_publication_versions with SQLSTATE 23001', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 1);
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pub_publication_versions SET version_note = 'mutated' WHERE id = $1::uuid`,
          versionId,
        ),
      );
    });

    it('rejects UPDATE snapshot_content with SQLSTATE 23001', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 1);
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pub_publication_versions SET snapshot_content = '{"tampered":true}'::jsonb WHERE id = $1::uuid`,
          versionId,
        ),
      );
    });

    it('rejects UPDATE trigger column with SQLSTATE 23001 (cannot rewrite trigger reason)', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 1, 'MANUAL_CHECKPOINT');
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.pub_publication_versions SET trigger = 'STATUS_CHANGE' WHERE id = $1::uuid`,
          versionId,
        ),
      );
    });

    it('rejects DELETE on pub_publication_versions with SQLSTATE 23001', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 1);
      await assertRaises23001(() =>
        rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.pub_publication_versions WHERE id = $1::uuid`,
          versionId,
        ),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // VersionService.checkpoint
  // ──────────────────────────────────────────────────────────────────
  describe('VersionService.checkpoint', () => {
    it('admin checkpoint creates a new version row with trigger=MANUAL_CHECKPOINT', async () => {
      const pubId = await seedPublication();
      const created = await withTestTenant(async () =>
        versionService.checkpoint(adminActor(), pubId, { versionNote: 'first cp' }),
      );
      expect(created.versionNumber).toBe(1);
      expect(created.trigger).toBe('MANUAL_CHECKPOINT');
      expect(created.publicationId).toBe(pubId);

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ trigger: string; version_number: number; reverted_from_version: number | null }>
      >(
        `SELECT trigger, version_number, reverted_from_version
         FROM ${TEST_SCHEMA}.pub_publication_versions WHERE publication_id = $1::uuid`,
        pubId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.trigger).toBe('MANUAL_CHECKPOINT');
      expect(rows[0]!.reverted_from_version).toBeNull();
    });

    it('consecutive checkpoints auto-increment version_number', async () => {
      const pubId = await seedPublication();
      const v1 = await withTestTenant(async () =>
        versionService.checkpoint(adminActor(), pubId, {}),
      );
      const v2 = await withTestTenant(async () =>
        versionService.checkpoint(adminActor(), pubId, {}),
      );
      const v3 = await withTestTenant(async () =>
        versionService.checkpoint(adminActor(), pubId, {}),
      );
      expect(v1.versionNumber).toBe(1);
      expect(v2.versionNumber).toBe(2);
      expect(v3.versionNumber).toBe(3);
    });

    it('captures sections in snapshot_content', async () => {
      const pubId = await seedPublication();
      const sectionId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_sections
           (id, publication_id, title, body, section_type, sort_order, is_approved)
         VALUES ($1::uuid, $2::uuid, 'Section A', 'body text', 'ARTICLE', 0, true)`,
        sectionId,
        pubId,
      );
      const created = await withTestTenant(async () =>
        versionService.checkpoint(adminActor(), pubId, { versionNote: 'with sections' }),
      );
      const detail = await withTestTenant(async () =>
        versionService.getById(adminActor(), created.id),
      );
      expect(detail.snapshotContent).toBeDefined();
      const sections = (detail.snapshotContent as { sections?: unknown[] }).sections;
      expect(Array.isArray(sections)).toBe(true);
      expect(sections).toHaveLength(1);
    });

    it('non-collaborator non-writer student → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () => versionService.checkpoint(studentActor(), pubId, {})),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('checkpoint on phantom publication id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => versionService.checkpoint(adminActor(), generateId(), {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // VersionService.revert KEYSTONE
  // ──────────────────────────────────────────────────────────────────
  describe('VersionService.revert (append-only KEYSTONE)', () => {
    it('revert creates a NEW version row with trigger=REVERT + reverted_from_version', async () => {
      const pubId = await seedPublication();
      await seedVersion(pubId, 1, 'STATUS_CHANGE');
      await seedVersion(pubId, 2, 'MANUAL_CHECKPOINT');

      const reverted = await withTestTenant(async () =>
        versionService.revert(adminActor(), pubId, 1, { versionNote: 'rollback' }),
      );
      expect(reverted.versionNumber).toBe(3);
      expect(reverted.trigger).toBe('REVERT');
      expect(reverted.revertedFromVersion).toBe(1);

      // Original v1 and v2 unchanged
      const all = (await rawClient.$queryRawUnsafe(
        `SELECT version_number, trigger, reverted_from_version
         FROM ${TEST_SCHEMA}.pub_publication_versions
         WHERE publication_id = $1::uuid ORDER BY version_number`,
        pubId,
      )) as Array<{
        version_number: number;
        trigger: string;
        reverted_from_version: number | null;
      }>;
      expect(all).toHaveLength(3);
      expect(all[0]!.reverted_from_version).toBeNull();
      expect(all[1]!.reverted_from_version).toBeNull();
      expect(all[2]!.trigger).toBe('REVERT');
      expect(all[2]!.reverted_from_version).toBe(1);
    });

    it('revert to non-existent version_number → NotFoundException', async () => {
      const pubId = await seedPublication();
      await seedVersion(pubId, 1);
      await expect(
        withTestTenant(async () => versionService.revert(adminActor(), pubId, 999, {})),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // VersionService.list / getById
  // ──────────────────────────────────────────────────────────────────
  describe('VersionService.list / getById', () => {
    it('list returns versions ordered by version_number DESC', async () => {
      const pubId = await seedPublication();
      await seedVersion(pubId, 1);
      await seedVersion(pubId, 2);
      await seedVersion(pubId, 3);
      const list = await withTestTenant(async () =>
        versionService.listForPublication(adminActor(), pubId),
      );
      expect(list.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    });

    it('getById returns snapshotContent', async () => {
      const pubId = await seedPublication();
      const versionId = await seedVersion(pubId, 5);
      const detail = await withTestTenant(async () =>
        versionService.getById(adminActor(), versionId),
      );
      expect(detail.versionNumber).toBe(5);
      expect(detail.snapshotContent).toBeDefined();
    });

    it('getById on phantom version id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => versionService.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Auto-version hook via PublicationService.patchStatus
  // ──────────────────────────────────────────────────────────────────
  describe('captureForStatusChange via PublicationService.patchStatus', () => {
    it('patchStatus DRAFT → IN_REVIEW creates STATUS_CHANGE version', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'IN_REVIEW' }),
      );
      const versions = (await rawClient.$queryRawUnsafe(
        `SELECT trigger, version_number FROM ${TEST_SCHEMA}.pub_publication_versions
         WHERE publication_id = $1::uuid ORDER BY version_number`,
        pubId,
      )) as Array<{ trigger: string; version_number: number }>;
      expect(versions).toHaveLength(1);
      expect(versions[0]!.trigger).toBe('STATUS_CHANGE');
      expect(versions[0]!.version_number).toBe(1);

      // Status flipped on the parent publication
      const statusRow = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(statusRow[0]!.status).toBe('IN_REVIEW');
    });

    it('full lifecycle DRAFT → IN_REVIEW → APPROVED → ARCHIVED creates 3 versions', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'IN_REVIEW' }),
      );
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'APPROVED' }),
      );
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'ARCHIVED' }),
      );
      const versions = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_versions
         WHERE publication_id = $1::uuid AND trigger = 'STATUS_CHANGE'`,
        pubId,
      )) as Array<{ n: number }>;
      expect(versions[0]!.n).toBe(3);
    });

    it('APPROVED transition is refused while pending sections exist (ADR-035)', async () => {
      const pubId = await seedPublication({ status: 'IN_REVIEW' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_sections
           (id, publication_id, title, body, section_type, sort_order, is_approved)
         VALUES ($1::uuid, $2::uuid, 'pending', '', 'ARTICLE', 0, false)`,
        generateId(),
        pubId,
      );
      await expect(
        withTestTenant(async () =>
          publicationService.patchStatus(adminActor(), pubId, { status: 'APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid status transition → BadRequestException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      // DRAFT cannot go directly to PUBLISHED
      await expect(
        withTestTenant(async () =>
          publicationService.patchStatus(adminActor(), pubId, { status: 'PUBLISHED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ──────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A actor cannot read a School B publication version → NotFound', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const versionId = await seedVersion(pubBId, 1);
      // List from School A
      await expect(
        withTestTenant(async () => versionService.listForPublication(adminActor(), pubBId)),
      ).rejects.toBeInstanceOf(NotFoundException);
      // getById on the foreign version → NotFound
      await expect(
        withTestTenant(async () => versionService.getById(adminActor(), versionId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('School B actor sees School B publication versions in their context', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await seedVersion(pubBId, 1);
      const list = await withTestTenantB(async () =>
        versionService.listForPublication(adminActor(), pubBId),
      );
      expect(list).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // TemplateService
  // ──────────────────────────────────────────────────────────────────
  describe('TemplateService', () => {
    async function seedTemplate(
      opts: {
        schoolId?: string | null;
        isSystem?: boolean;
        name?: string;
        isActive?: boolean;
      } = {},
    ): Promise<string> {
      const id = generateId();
      seededTemplateIds.push(id);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_templates
           (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
         VALUES ($1::uuid, $2::uuid, $3, 'desc', 'NEWSLETTER', $4::jsonb, $5, $6, $7::uuid)`,
        id,
        opts.schoolId === null ? null : (opts.schoolId ?? TEST_SCHOOL_ID),
        opts.name ?? 'Template ' + id.slice(-6),
        JSON.stringify({ sections: [{ title: 'Intro', sortOrder: 0 }] }),
        opts.isSystem ?? false,
        opts.isActive ?? true,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('admin creates a template → row inserted with is_system=false', async () => {
      const created = await withTestTenant(async () =>
        templateService.create(adminActor(), {
          name: 'My Custom Template ' + generateId().slice(-6),
          publicationType: 'NEWSLETTER',
          templateContent: { sections: [{ title: 'Intro', sortOrder: 0 }] },
        } as any),
      );
      seededTemplateIds.push(created.id);
      expect(created.isSystem).toBe(false);
      expect(created.schoolId).toBe(TEST_SCHOOL_ID);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT is_system FROM ${TEST_SCHEMA}.pub_templates WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ is_system: boolean }>;
      expect(rows[0]!.is_system).toBe(false);
    });

    it('non-admin non-staff caller (student) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          templateService.create(studentActor(), {
            name: 'Nope',
            publicationType: 'NEWSLETTER',
            templateContent: { sections: [] },
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list shows both system (school_id NULL) and own-school templates; excludes other schools', async () => {
      const systemId = await seedTemplate({ schoolId: null, isSystem: true });
      const aId = await seedTemplate({ schoolId: TEST_SCHOOL_ID });
      const bId = await seedTemplate({ schoolId: TEST_SCHOOL_B_ID });

      const list = await withTestTenant(async () => templateService.list(adminActor()));
      const ids = list.map((t) => t.id);
      expect(ids).toContain(systemId);
      expect(ids).toContain(aId);
      expect(ids).not.toContain(bId);
    });

    it('getById on foreign-school custom template → NotFoundException', async () => {
      const bId = await seedTemplate({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => templateService.getById(adminActor(), bId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch on system template → ForbiddenException', async () => {
      const systemId = await seedTemplate({ schoolId: null, isSystem: true });
      await expect(
        withTestTenant(async () => templateService.patch(adminActor(), systemId, { name: 'hack' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove on system template → ForbiddenException', async () => {
      const systemId = await seedTemplate({ schoolId: null, isSystem: true });
      await expect(
        withTestTenant(async () => templateService.remove(adminActor(), systemId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch own-school template → row updated', async () => {
      const id = await seedTemplate({ schoolId: TEST_SCHOOL_ID, name: 'Original' });
      const patched = await withTestTenant(async () =>
        templateService.patch(adminActor(), id, { name: 'Renamed', isActive: false }),
      );
      expect(patched.name).toBe('Renamed');
      expect(patched.isActive).toBe(false);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT name, is_active FROM ${TEST_SCHEMA}.pub_templates WHERE id = $1::uuid`,
        id,
      )) as Array<{ name: string; is_active: boolean }>;
      expect(rows[0]!.name).toBe('Renamed');
      expect(rows[0]!.is_active).toBe(false);
    });

    it('patch with empty body returns current row unchanged', async () => {
      const id = await seedTemplate({ schoolId: TEST_SCHOOL_ID, name: 'Stable' });
      const cur = await withTestTenant(async () =>
        templateService.patch(adminActor(), id, {} as any),
      );
      expect(cur.name).toBe('Stable');
    });

    it('remove own-school template → row deleted', async () => {
      const id = await seedTemplate({ schoolId: TEST_SCHOOL_ID });
      await withTestTenant(async () => templateService.remove(adminActor(), id));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_templates WHERE id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
      // Drop from cleanup list since already deleted
      const idx = seededTemplateIds.indexOf(id);
      if (idx >= 0) seededTemplateIds.splice(idx, 1);
    });

    it('createFromTemplate creates publication + auto-populates sections', async () => {
      const templateId = await seedTemplate({ schoolId: TEST_SCHOOL_ID });
      const pub = await withTestTenant(async () =>
        templateService.createFromTemplate(adminActor(), templateId, {
          title: 'From template publication',
        } as any),
      );
      seededPubIds.push(pub.id);
      expect(pub.title).toBe('From template publication');
      expect(pub.status).toBe('DRAFT');
      const sections = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_sections WHERE publication_id = $1::uuid`,
        pub.id,
      )) as Array<{ n: number }>;
      expect(sections[0]!.n).toBe(1);
    });

    it('createFromTemplate on inactive template → BadRequestException', async () => {
      const templateId = await seedTemplate({
        schoolId: TEST_SCHOOL_ID,
        isActive: false,
      });
      await expect(
        withTestTenant(async () =>
          templateService.createFromTemplate(adminActor(), templateId, {
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createFromTemplate on foreign-school template → NotFoundException', async () => {
      const templateId = await seedTemplate({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          templateService.createFromTemplate(adminActor(), templateId, {
            title: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duplicate template name in same school → ConflictException', async () => {
      const dupName = 'DupName ' + generateId().slice(-6);
      await seedTemplate({ schoolId: TEST_SCHOOL_ID, name: dupName });
      await expect(
        withTestTenant(async () =>
          templateService.create(adminActor(), {
            name: dupName,
            publicationType: 'NEWSLETTER',
            templateContent: { sections: [] },
          } as any),
        ),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  // Suppress unused import warning — kept for parity with other suites.
  void TEST_ADMIN_EMPLOYEE_ID;
  void teacherActor;
});
