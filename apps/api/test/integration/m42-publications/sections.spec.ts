import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  CommentService,
  ContributorService,
  SectionService,
} from '@modules/m42-publications/sections.service';
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
  studentActor,
  teacherActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m42-publications sections + contributors + comments
 * DB-backed integration tests.
 *
 * CODEX FINDINGS verified here:
 *   - ContributorService.add/remove authorize through pub_sections →
 *     pub_publications.school_id.
 *   - CommentService.create/resolve authorize through pub_sections →
 *     pub_publications.school_id.
 *   - SectionService.patch/remove/approve enforce school-scope via
 *     JOIN through pub_publications.
 *   - Student section create requires CONTRIBUTOR/EDITOR collaborator
 *     (BLOCKING 2).
 *   - Non-writer non-collaborator section list collapses to 404 for
 *     non-PUBLISHED publications.
 */
describe('integration:m42-publications/sections', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let sectionService: SectionService;
  let contributorService: ContributorService;
  let commentService: CommentService;

  const seededPubIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    sectionService = new SectionService(tenantPrisma, permCheck);
    contributorService = new ContributorService(tenantPrisma);
    commentService = new CommentService(tenantPrisma, permCheck);

    // Ensure the student actor has a sis_students row for
    // assertAccountInCurrentTenant checks.
    await ensureStudentActor();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_section_comments WHERE section_id IN (
           SELECT id FROM ${TEST_SCHEMA}.pub_sections WHERE publication_id = ANY($1::uuid[])
         )`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_section_contributors WHERE section_id IN (
           SELECT id FROM ${TEST_SCHEMA}.pub_sections WHERE publication_id = ANY($1::uuid[])
         )`,
        seededPubIds,
      );
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

  async function ensureStudentActor(): Promise<void> {
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Sec', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Sec', 'Student', true) ON CONFLICT DO NOTHING`,
      psId,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'Sec Student', 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_ACCOUNT_ID,
      TEST_STUDENT_PERSON_ID,
      'sec-student-' + TEST_STUDENT_ACCOUNT_ID.slice(-6) + '@test.local',
    );
    // Check if any sis_students row exists for this person; insert if missing.
    const existing = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       WHERE ps.person_id = $1::uuid AND s.school_id = $2::uuid`,
      TEST_STUDENT_PERSON_ID,
      TEST_SCHOOL_ID,
    )) as Array<{ n: number }>;
    if (existing[0]!.n === 0) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')
         ON CONFLICT DO NOTHING`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'SEC-' + sid.slice(-6),
      );
    }
  }

  async function seedPublication(
    opts: {
      schoolId?: string;
      status?: string;
      createdBy?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Sect Test Pub', 'NEWSLETTER', $3, $4::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.status ?? 'DRAFT',
      opts.createdBy ?? TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  async function seedSection(
    publicationId: string,
    opts: {
      isApproved?: boolean;
      title?: string;
      sortOrder?: number;
      ownerEmployeeId?: string | null;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_sections
         (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
       VALUES ($1::uuid, $2::uuid, $3, '', 'ARTICLE', $4::uuid, $5, $6)`,
      id,
      publicationId,
      opts.title ?? 'Section',
      opts.ownerEmployeeId === undefined ? null : opts.ownerEmployeeId,
      opts.sortOrder ?? 0,
      opts.isApproved ?? false,
    );
    return id;
  }

  async function seedCollaborator(
    publicationId: string,
    userId: string,
    role: 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER' = 'CONTRIBUTOR',
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publication_collaborators
         (id, publication_id, user_id, role, invited_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid)`,
      id,
      publicationId,
      userId,
      role,
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // SectionService.create
  // ──────────────────────────────────────────────────────────────────
  describe('SectionService.create', () => {
    it('admin creates a staff-owned section → row inserted, is_approved=true', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        sectionService.create(adminActor(), pubId, {
          title: 'Intro',
          body: 'Welcome',
          sectionType: 'ARTICLE',
          ownerEmployeeId: TEST_ADMIN_EMPLOYEE_ID,
        } as any),
      );
      expect(dto.isApproved).toBe(true);
      expect(dto.title).toBe('Intro');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT is_approved FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ is_approved: boolean }>;
      expect(rows[0]!.is_approved).toBe(true);
    });

    it('admin creates a student-owned (no ownerEmployeeId) section → is_approved=false', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const dto = await withTestTenant(async () =>
        sectionService.create(adminActor(), pubId, {
          title: 'Student Story',
          body: 'My take',
          sectionType: 'ARTICLE',
        } as any),
      );
      expect(dto.isApproved).toBe(false);
    });

    it('student NOT a collaborator → ForbiddenException (BLOCKING 2)', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          sectionService.create(studentActor(), pubId, {
            title: 'Sneaky',
            body: 'Should fail',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('student WITH CONTRIBUTOR collaborator role → section created', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await seedCollaborator(pubId, TEST_STUDENT_ACCOUNT_ID, 'CONTRIBUTOR');
      const dto = await withTestTenant(async () =>
        sectionService.create(studentActor(), pubId, {
          title: 'Authorized student section',
          body: 'My story',
        } as any),
      );
      expect(dto.title).toBe('Authorized student section');
      expect(dto.isApproved).toBe(false);
    });

    it('sortOrder auto-increments when not supplied', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const s1 = await withTestTenant(async () =>
        sectionService.create(adminActor(), pubId, { title: 'A' } as any),
      );
      const s2 = await withTestTenant(async () =>
        sectionService.create(adminActor(), pubId, { title: 'B' } as any),
      );
      expect(s2.sortOrder).toBe(s1.sortOrder + 1);
    });

    it('create on phantom publication id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          sectionService.create(adminActor(), generateId(), { title: 'Ghost' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create on a foreign-school publication → NotFoundException (cross-school)', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          sectionService.create(adminActor(), pubBId, { title: 'X' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SectionService.listForPublication
  // ──────────────────────────────────────────────────────────────────
  describe('SectionService.listForPublication', () => {
    it('writer (admin) sees all sections including unapproved', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const approved = await seedSection(pubId, { isApproved: true, title: 'A' });
      const pending = await seedSection(pubId, {
        isApproved: false,
        title: 'P',
        sortOrder: 1,
      });
      const list = await withTestTenant(async () =>
        sectionService.listForPublication(pubId, adminActor()),
      );
      const ids = list.map((s) => s.id);
      expect(ids).toContain(approved);
      expect(ids).toContain(pending);
    });

    it('non-writer parent on DRAFT publication → NotFoundException (collapsed)', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await seedSection(pubId, { isApproved: true });
      await expect(
        withTestTenant(async () => sectionService.listForPublication(pubId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer parent on PUBLISHED publication sees only approved sections', async () => {
      const pubId = await seedPublication({ status: 'PUBLISHED' });
      const approved = await seedSection(pubId, { isApproved: true, title: 'Pub Approved' });
      const pending = await seedSection(pubId, {
        isApproved: false,
        title: 'Pub Pending',
        sortOrder: 1,
      });
      const list = await withTestTenant(async () =>
        sectionService.listForPublication(pubId, parentActor()),
      );
      const ids = list.map((s) => s.id);
      expect(ids).toContain(approved);
      expect(ids).not.toContain(pending);
    });

    it('list on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => sectionService.listForPublication(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A actor on School B publication → NotFoundException', async () => {
      const pubBId = await seedPublication({
        schoolId: TEST_SCHOOL_B_ID,
        status: 'PUBLISHED',
      });
      await seedSection(pubBId, { isApproved: true });
      await expect(
        withTestTenant(async () => sectionService.listForPublication(pubBId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SectionService.patch / remove
  // ──────────────────────────────────────────────────────────────────
  describe('SectionService.patch', () => {
    it('admin patch updates title + body', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { title: 'Old' });
      await withTestTenant(async () =>
        sectionService.patch(adminActor(), sectId, {
          title: 'New',
          body: 'New body',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT title, body FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        sectId,
      )) as Array<{ title: string; body: string }>;
      expect(rows[0]!.title).toBe('New');
      expect(rows[0]!.body).toBe('New body');
    });

    it('patch with empty body returns current section', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { title: 'Same' });
      const same = await withTestTenant(async () =>
        sectionService.patch(adminActor(), sectId, {} as any),
      );
      expect(same.id).toBe(sectId);
    });

    it('patch on phantom section → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          sectionService.patch(adminActor(), generateId(), { title: 'X' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A actor patching School B section → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId, { title: 'B section' });
      await expect(
        withTestTenant(async () =>
          sectionService.patch(adminActor(), sectBId, { title: 'hack' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('SectionService.remove', () => {
    it('admin removes own-school section → row deleted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { title: 'Bye' });
      await withTestTenant(async () => sectionService.remove(adminActor(), sectId));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        sectId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('remove on foreign-school section is a no-op (no row deleted)', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId, { title: 'B' });
      await withTestTenant(async () => sectionService.remove(adminActor(), sectBId));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        sectBId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // SectionService.approve (ADR-035)
  // ──────────────────────────────────────────────────────────────────
  describe('SectionService.approve', () => {
    it('admin approves a pending section → is_approved=true', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { isApproved: false });
      await withTestTenant(async () => sectionService.approve(adminActor(), sectId));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT is_approved FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        sectId,
      )) as Array<{ is_approved: boolean }>;
      expect(rows[0]!.is_approved).toBe(true);
    });

    it('student cannot approve their own section → ForbiddenException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { isApproved: false });
      await expect(
        withTestTenant(async () => sectionService.approve(studentActor(), sectId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('approve on phantom section → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => sectionService.approve(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('approve on foreign-school section → NotFoundException (school-scope)', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId, { isApproved: false });
      await expect(
        withTestTenant(async () => sectionService.approve(adminActor(), sectBId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin teacher without collaborator role cannot approve → ForbiddenException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId, { isApproved: false });
      await expect(
        withTestTenant(async () => sectionService.approve(teacherActor(), sectId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ContributorService — CODEX FINDING: school-scope authorization
  // ──────────────────────────────────────────────────────────────────
  describe('ContributorService.add', () => {
    it('admin adds a contributor to a section → row inserted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const dto = await withTestTenant(async () =>
        contributorService.add(adminActor(), sectId, {
          contributorId: TEST_STUDENT_ACCOUNT_ID,
          contributionNote: 'helped with draft',
        } as any),
      );
      expect(dto.contributorId).toBe(TEST_STUDENT_ACCOUNT_ID);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_section_contributors WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('add same contributor twice → ConflictException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      await withTestTenant(async () =>
        contributorService.add(adminActor(), sectId, {
          contributorId: TEST_STUDENT_ACCOUNT_ID,
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          contributorService.add(adminActor(), sectId, {
            contributorId: TEST_STUDENT_ACCOUNT_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('contributorId not in current tenant → BadRequestException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      await expect(
        withTestTenant(async () =>
          contributorService.add(adminActor(), sectId, {
            contributorId: generateId(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CODEX FINDING — add contributor on School B section from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId);
      await expect(
        withTestTenant(async () =>
          contributorService.add(adminActor(), sectBId, {
            contributorId: TEST_STUDENT_ACCOUNT_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('add contributor on phantom section → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          contributorService.add(adminActor(), generateId(), {
            contributorId: TEST_STUDENT_ACCOUNT_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ContributorService.remove', () => {
    it('admin removes contributor → row deleted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const dto = await withTestTenant(async () =>
        contributorService.add(adminActor(), sectId, {
          contributorId: TEST_STUDENT_ACCOUNT_ID,
        } as any),
      );
      await withTestTenant(async () => contributorService.remove(adminActor(), dto.id));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_section_contributors WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('CODEX FINDING — remove contributor row on School B section from School A → NotFoundException', async () => {
      // Seed the contributor row directly using a raw INSERT under School B.
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId);
      const contribId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_section_contributors
           (id, section_id, contributor_id, contribution_note)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'cross-school check')`,
        contribId,
        sectBId,
        TEST_STUDENT_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => contributorService.remove(adminActor(), contribId)),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Row should still exist
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_section_contributors WHERE id = $1::uuid`,
        contribId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('remove phantom contributor row → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => contributorService.remove(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // CommentService — CODEX FINDING: school-scope authorization
  // ──────────────────────────────────────────────────────────────────
  describe('CommentService.create', () => {
    it('admin creates a comment on a section → row inserted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const dto = await withTestTenant(async () =>
        commentService.create(adminActor(), sectId, {
          body: 'looks good',
        } as any),
      );
      expect(dto.body).toBe('looks good');
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT body FROM ${TEST_SCHEMA}.pub_section_comments WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ body: string }>;
      expect(rows[0]!.body).toBe('looks good');
    });

    it('CODEX FINDING — create comment on School B section from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId);
      await expect(
        withTestTenant(async () =>
          commentService.create(adminActor(), sectBId, {
            body: 'cross-school comment attempt',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create comment on phantom section → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          commentService.create(adminActor(), generateId(), {
            body: 'phantom',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('CommentService.listForSection', () => {
    async function seedComment(sectionId: string): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_section_comments
           (id, section_id, author_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'seed comment')`,
        id,
        sectionId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('admin lists comments on section', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const cid = await seedComment(sectId);
      const list = await withTestTenant(async () =>
        commentService.listForSection(sectId, adminActor()),
      );
      expect(list.map((c) => c.id)).toContain(cid);
    });

    it('list on phantom section → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => commentService.listForSection(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-collaborator parent gets collapsed 404 on comments', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      await expect(
        withTestTenant(async () => commentService.listForSection(sectId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('CommentService.resolve', () => {
    async function seedComment(sectionId: string): Promise<string> {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_section_comments
           (id, section_id, author_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'seed')`,
        id,
        sectionId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return id;
    }

    it('admin resolves a comment → is_resolved=true + resolved_by set', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const cid = await seedComment(sectId);
      await withTestTenant(async () => commentService.resolve(adminActor(), cid));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT is_resolved, resolved_by::text AS resolved_by FROM ${TEST_SCHEMA}.pub_section_comments WHERE id = $1::uuid`,
        cid,
      )) as Array<{ is_resolved: boolean; resolved_by: string | null }>;
      expect(rows[0]!.is_resolved).toBe(true);
      expect(rows[0]!.resolved_by).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('resolving an already-resolved comment → BadRequestException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const sectId = await seedSection(pubId);
      const cid = await seedComment(sectId);
      await withTestTenant(async () => commentService.resolve(adminActor(), cid));
      await expect(
        withTestTenant(async () => commentService.resolve(adminActor(), cid)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CODEX FINDING — resolve comment on School B section from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      const sectBId = await seedSection(pubBId);
      const cid = await seedComment(sectBId);
      await expect(
        withTestTenant(async () => commentService.resolve(adminActor(), cid)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolve on phantom comment → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => commentService.resolve(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Suppress unused warnings
  void withTestTenantB;
});
