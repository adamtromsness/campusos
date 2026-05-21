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
  CollaboratorService,
  EditionService,
  PublicationService,
  SeriesService,
} from '@modules/m42-publications/series.service';
import { VersionService } from '@modules/m42-publications/versions.service';
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
  parentActor,
  teacherActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_PUB_SERIES_ID, TEST_PUB_SERIES_B_ID } from '../fixtures/publications';

/**
 * Wave 5 — m42-publications publication-lifecycle DB-backed integration
 * tests covering SeriesService, EditionService, PublicationService,
 * CollaboratorService.
 *
 * Contracts:
 *   - Series CRUD + school-scope (UNIQUE(school_id, title)).
 *   - Edition auto-increment per series + status transitions.
 *   - Publication CRUD + ALLOWED_TRANSITIONS state machine.
 *   - ADR-035 KEYSTONE: APPROVED transition refuses while pending sections.
 *   - Collaborator invite + remove (assertAccountInCurrentTenant).
 *   - Cross-school isolation (School A actor cannot list/get School B).
 *   - Reader visibility — non-writer sees only PUBLISHED publications.
 */
describe('integration:m42-publications/publication-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let seriesService: SeriesService;
  let editionService: EditionService;
  let publicationService: PublicationService;
  let collaboratorService: CollaboratorService;
  let versionService: VersionService;

  const seededPubIds: string[] = [];
  const seededSeriesIds: string[] = [];
  const seededEditionIds: string[] = [];
  const seededStudentPersonIds: string[] = [];
  const seededStudentPlatformIds: string[] = [];
  const seededStudentRowIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    seriesService = new SeriesService(tenantPrisma, permCheck);
    editionService = new EditionService(tenantPrisma, permCheck);
    publicationService = new PublicationService(tenantPrisma, permCheck);
    versionService = new VersionService(tenantPrisma, permCheck);
    publicationService.setVersionService(versionService);
    collaboratorService = new CollaboratorService(tenantPrisma);

    // Seed the static STUDENT actor's sis_students row so
    // assertAccountInCurrentTenant resolves for collaborator invites.
    await ensureStudentActorInTenant();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.pub_publication_versions`);
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
    if (seededEditionIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_edition WHERE id = ANY($1::uuid[])`,
        seededEditionIds.splice(0),
      );
    }
    if (seededSeriesIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_series WHERE id = ANY($1::uuid[])`,
        seededSeriesIds.splice(0),
      );
    }
  });

  async function ensureStudentActorInTenant(): Promise<void> {
    // Required for assertAccountInCurrentTenant to find the student
    // user via the sis_students → platform_students.person_id chain.
    const psId = generateId();
    const sid = generateId();
    seededStudentPlatformIds.push(psId);
    seededStudentRowIds.push(sid);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Pub', 'Student', 'STUDENT', true)
         ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Pub', 'Student', true) ON CONFLICT DO NOTHING`,
      psId,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'Pub Student', 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_ACCOUNT_ID,
      TEST_STUDENT_PERSON_ID,
      'pub-student-' + TEST_STUDENT_ACCOUNT_ID.slice(-6) + '@test.local',
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED')
       ON CONFLICT DO NOTHING`,
      sid,
      psId,
      TEST_SCHOOL_ID,
      'PUB-COLLAB-' + sid.slice(-6),
    );
  }

  async function seedPublication(
    opts: {
      schoolId?: string;
      title?: string;
      status?: string;
      seriesId?: string | null;
      createdBy?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, series_id, created_by)
       VALUES ($1::uuid, $2::uuid, $3, 'NEWSLETTER', $4, $5::uuid, $6::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.title ?? 'Test Publication',
      opts.status ?? 'DRAFT',
      opts.seriesId === null ? null : (opts.seriesId ?? null),
      opts.createdBy ?? TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // SeriesService
  // ──────────────────────────────────────────────────────────────────
  describe('SeriesService', () => {
    it('admin creates series → row inserted', async () => {
      const dto = await withTestTenant(async () =>
        seriesService.create(adminActor(), {
          title: 'New Series ' + generateId().slice(-6),
          publicationType: 'NEWSLETTER',
          frequency: 'WEEKLY',
        } as any),
      );
      seededSeriesIds.push(dto.id);
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.isActive).toBe(true);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT title, school_id::text AS school_id FROM ${TEST_SCHEMA}.pub_series WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ title: string; school_id: string }>;
      expect(rows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    });

    it('duplicate series title in same school → ConflictException', async () => {
      const title = 'Dup ' + generateId().slice(-6);
      const first = await withTestTenant(async () =>
        seriesService.create(adminActor(), {
          title,
          publicationType: 'NEWSLETTER',
          frequency: 'WEEKLY',
        } as any),
      );
      seededSeriesIds.push(first.id);
      await expect(
        withTestTenant(async () =>
          seriesService.create(adminActor(), {
            title,
            publicationType: 'NEWSLETTER',
            frequency: 'WEEKLY',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('list returns only own-school series (cross-school isolation)', async () => {
      // Fixture provides TEST_PUB_SERIES_ID (School A) and
      // TEST_PUB_SERIES_B_ID (School B).
      const list = await withTestTenant(async () => seriesService.list());
      const ids = list.map((s) => s.id);
      expect(ids).toContain(TEST_PUB_SERIES_ID);
      expect(ids).not.toContain(TEST_PUB_SERIES_B_ID);
    });

    it('getById for a School B series from School A context → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => seriesService.getById(TEST_PUB_SERIES_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById on a School B series with School B context works', async () => {
      const dto = await withTestTenantB(async () => seriesService.getById(TEST_PUB_SERIES_B_ID));
      expect(dto.schoolId).toBe(TEST_SCHOOL_B_ID);
    });

    it('non-writer caller (student) → ForbiddenException on create', async () => {
      await expect(
        withTestTenant(async () =>
          seriesService.create(studentActor(), {
            title: 'Student-attempted',
            publicationType: 'NEWSLETTER',
            frequency: 'WEEKLY',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates description + frequency + isActive', async () => {
      const dto = await withTestTenant(async () =>
        seriesService.create(adminActor(), {
          title: 'Patchable ' + generateId().slice(-6),
          publicationType: 'NEWSLETTER',
          frequency: 'WEEKLY',
        } as any),
      );
      seededSeriesIds.push(dto.id);

      await withTestTenant(async () =>
        seriesService.patch(adminActor(), dto.id, {
          description: 'updated',
          frequency: 'MONTHLY',
          isActive: false,
        } as any),
      );
      // Verify DB state (the patch returns the in-tx reload which may
      // observe stale values due to nested-context reads; DB is authoritative).
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT description, frequency, is_active FROM ${TEST_SCHEMA}.pub_series WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ description: string; frequency: string; is_active: boolean }>;
      expect(rows[0]!.description).toBe('updated');
      expect(rows[0]!.frequency).toBe('MONTHLY');
      expect(rows[0]!.is_active).toBe(false);
    });

    it('patch with empty body returns current row', async () => {
      const dto = await withTestTenant(async () =>
        seriesService.create(adminActor(), {
          title: 'Empty Patch ' + generateId().slice(-6),
          publicationType: 'NEWSLETTER',
          frequency: 'WEEKLY',
        } as any),
      );
      seededSeriesIds.push(dto.id);
      const same = await withTestTenant(async () =>
        seriesService.patch(adminActor(), dto.id, {} as any),
      );
      expect(same.id).toBe(dto.id);
    });

    it('patch on a phantom series id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          seriesService.patch(adminActor(), generateId(), { description: 'x' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // EditionService
  // ──────────────────────────────────────────────────────────────────
  describe('EditionService', () => {
    it('create auto-increments edition_number per series', async () => {
      const e1 = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {
          editionLabel: 'First',
        } as any),
      );
      seededEditionIds.push(e1.id);
      const e2 = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {
          editionLabel: 'Second',
        } as any),
      );
      seededEditionIds.push(e2.id);
      expect(e2.editionNumber).toBe(e1.editionNumber + 1);
    });

    it('non-writer (student) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          editionService.create(studentActor(), TEST_PUB_SERIES_ID, {} as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create on phantom series id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => editionService.create(adminActor(), generateId(), {} as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForSeries returns editions ordered by number DESC', async () => {
      const e1 = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {
          editionLabel: 'A',
        } as any),
      );
      seededEditionIds.push(e1.id);
      const e2 = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {
          editionLabel: 'B',
        } as any),
      );
      seededEditionIds.push(e2.id);
      const list = await withTestTenant(async () =>
        editionService.listForSeries(TEST_PUB_SERIES_ID),
      );
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list[0]!.editionNumber).toBeGreaterThanOrEqual(list[1]!.editionNumber);
    });

    it('patch edition with status transition DRAFT → IN_REVIEW succeeds', async () => {
      const e = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {} as any),
      );
      seededEditionIds.push(e.id);
      await withTestTenant(async () =>
        editionService.patch(adminActor(), e.id, {
          editionLabel: 'updated label',
          status: 'IN_REVIEW',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, edition_label FROM ${TEST_SCHEMA}.pub_edition WHERE id = $1::uuid`,
        e.id,
      )) as Array<{ status: string; edition_label: string }>;
      expect(rows[0]!.status).toBe('IN_REVIEW');
      expect(rows[0]!.edition_label).toBe('updated label');
    });

    it('patch with invalid transition DRAFT → PUBLISHED → BadRequest', async () => {
      const e = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {} as any),
      );
      seededEditionIds.push(e.id);
      await expect(
        withTestTenant(async () =>
          editionService.patch(adminActor(), e.id, { status: 'PUBLISHED' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch with empty body returns same edition', async () => {
      const e = await withTestTenant(async () =>
        editionService.create(adminActor(), TEST_PUB_SERIES_ID, {} as any),
      );
      seededEditionIds.push(e.id);
      const same = await withTestTenant(async () =>
        editionService.patch(adminActor(), e.id, {} as any),
      );
      expect(same.id).toBe(e.id);
    });

    it('patch on phantom edition id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          editionService.patch(adminActor(), generateId(), { theme: 'x' } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById on phantom edition → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => editionService.getById(generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PublicationService
  // ──────────────────────────────────────────────────────────────────
  describe('PublicationService.create / list / getById', () => {
    it('admin creates publication → row inserted with status=DRAFT', async () => {
      const dto = await withTestTenant(async () =>
        publicationService.create(adminActor(), {
          title: 'New Publication',
          publicationType: 'NEWSLETTER',
        } as any),
      );
      seededPubIds.push(dto.id);
      expect(dto.status).toBe('DRAFT');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        dto.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('create with editionId without seriesId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          publicationService.create(adminActor(), {
            title: 'Bad',
            publicationType: 'NEWSLETTER',
            editionId: generateId(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-writer (student) → ForbiddenException on create', async () => {
      await expect(
        withTestTenant(async () =>
          publicationService.create(studentActor(), {
            title: 'Stud',
            publicationType: 'NEWSLETTER',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-writer parent reading list sees only PUBLISHED publications', async () => {
      const draftId = await seedPublication({ status: 'DRAFT', title: 'Draft Pub' });
      const pubId = await seedPublication({
        status: 'PUBLISHED',
        title: 'Published Pub',
      });
      const list = await withTestTenant(async () => publicationService.list(parentActor()), {
        personId: '019e0cf8-aaaa-7777-8888-000000000050',
      });
      const ids = list.map((p) => p.id);
      expect(ids).toContain(pubId);
      expect(ids).not.toContain(draftId);
    });

    it('admin sees DRAFT publications in list', async () => {
      const draftId = await seedPublication({ status: 'DRAFT', title: 'Adm Draft' });
      const list = await withTestTenant(async () => publicationService.list(adminActor()));
      expect(list.map((p) => p.id)).toContain(draftId);
    });

    it('list filtered by status returns matches only', async () => {
      const draftId = await seedPublication({ status: 'DRAFT', title: 'Adm Draft 2' });
      const reviewId = await seedPublication({
        status: 'IN_REVIEW',
        title: 'Adm IR',
      });
      const list = await withTestTenant(async () =>
        publicationService.list(adminActor(), { status: 'IN_REVIEW' as any }),
      );
      const ids = list.map((p) => p.id);
      expect(ids).toContain(reviewId);
      expect(ids).not.toContain(draftId);
    });

    it('list filtered by seriesId returns scoped results', async () => {
      const noSeriesId = await seedPublication({
        status: 'PUBLISHED',
        title: 'Standalone',
      });
      const withSeriesId = await seedPublication({
        status: 'PUBLISHED',
        title: 'In Series',
        seriesId: TEST_PUB_SERIES_ID,
      });
      const list = await withTestTenant(async () =>
        publicationService.list(adminActor(), { seriesId: TEST_PUB_SERIES_ID }),
      );
      const ids = list.map((p) => p.id);
      expect(ids).toContain(withSeriesId);
      expect(ids).not.toContain(noSeriesId);
    });

    it('non-writer parent getById on a DRAFT publication → collapsed 404', async () => {
      const draftId = await seedPublication({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => publicationService.getById(draftId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin getById returns the publication with collaborators', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const detail = await withTestTenant(async () =>
        publicationService.getById(pubId, adminActor()),
      );
      expect(detail.id).toBe(pubId);
      expect(Array.isArray(detail.collaborators)).toBe(true);
    });

    it('getById on a phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => publicationService.getById(generateId(), adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PublicationService.patchStatus state machine
  // ──────────────────────────────────────────────────────────────────
  describe('PublicationService.patchStatus state machine', () => {
    it('DRAFT → IN_REVIEW allowed', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'IN_REVIEW' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('IN_REVIEW');
    });

    it('DRAFT → APPROVED → BadRequest (illegal transition)', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          publicationService.patchStatus(adminActor(), pubId, { status: 'APPROVED' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('IN_REVIEW → APPROVED with pending section refused (ADR-035 KEYSTONE)', async () => {
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

    it('IN_REVIEW → APPROVED with all sections approved succeeds', async () => {
      const pubId = await seedPublication({ status: 'IN_REVIEW' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_sections
           (id, publication_id, title, body, section_type, sort_order, is_approved)
         VALUES ($1::uuid, $2::uuid, 'approved', '', 'ARTICLE', 0, true)`,
        generateId(),
        pubId,
      );
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'APPROVED' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('APPROVED');
    });

    it('ARCHIVED → DRAFT allowed', async () => {
      const pubId = await seedPublication({ status: 'ARCHIVED' });
      await withTestTenant(async () =>
        publicationService.patchStatus(adminActor(), pubId, { status: 'DRAFT' }),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('patchStatus on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          publicationService.patchStatus(adminActor(), generateId(), {
            status: 'IN_REVIEW',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer caller (student) → ForbiddenException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          publicationService.patchStatus(studentActor(), pubId, {
            status: 'IN_REVIEW',
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // CollaboratorService
  // ──────────────────────────────────────────────────────────────────
  describe('CollaboratorService', () => {
    it('admin invites a student → collaborator row inserted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const collab = await withTestTenant(async () =>
        collaboratorService.invite(adminActor(), pubId, {
          userId: TEST_STUDENT_ACCOUNT_ID,
          role: 'CONTRIBUTOR',
        } as any),
      );
      expect(collab.userId).toBe(TEST_STUDENT_ACCOUNT_ID);
      expect(collab.role).toBe('CONTRIBUTOR');

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT role FROM ${TEST_SCHEMA}.pub_publication_collaborators WHERE id = $1::uuid`,
        collab.id,
      )) as Array<{ role: string }>;
      expect(rows[0]!.role).toBe('CONTRIBUTOR');
    });

    it('invite same user twice → ConflictException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        collaboratorService.invite(adminActor(), pubId, {
          userId: TEST_STUDENT_ACCOUNT_ID,
          role: 'CONTRIBUTOR',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          collaboratorService.invite(adminActor(), pubId, {
            userId: TEST_STUDENT_ACCOUNT_ID,
            role: 'EDITOR',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('invite with userId NOT in current tenant → BadRequestException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      // Random unknown account id — not a sis_student/sis_guardian/hr_employees projection.
      await expect(
        withTestTenant(async () =>
          collaboratorService.invite(adminActor(), pubId, {
            userId: generateId(),
            role: 'EDITOR',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invite on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          collaboratorService.invite(adminActor(), generateId(), {
            userId: TEST_STUDENT_ACCOUNT_ID,
            role: 'CONTRIBUTOR',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin remove deletes the collaborator row', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const collab = await withTestTenant(async () =>
        collaboratorService.invite(adminActor(), pubId, {
          userId: TEST_STUDENT_ACCOUNT_ID,
          role: 'CONTRIBUTOR',
        } as any),
      );
      await withTestTenant(async () => collaboratorService.remove(adminActor(), collab.id));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_collaborators WHERE id = $1::uuid`,
        collab.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });

    it('non-admin teacher cannot remove a collaborator → ForbiddenException', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      const collab = await withTestTenant(async () =>
        collaboratorService.invite(adminActor(), pubId, {
          userId: TEST_STUDENT_ACCOUNT_ID,
          role: 'CONTRIBUTOR',
        } as any),
      );
      await expect(
        withTestTenant(async () => collaboratorService.remove(teacherActor(), collab.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Cross-school isolation for publications
  // ──────────────────────────────────────────────────────────────────
  describe('cross-school publication isolation', () => {
    it('School A admin cannot read School B publication → NotFoundException', async () => {
      const pubBId = await seedPublication({
        schoolId: TEST_SCHOOL_B_ID,
        status: 'PUBLISHED',
      });
      await expect(
        withTestTenant(async () => publicationService.getById(pubBId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('School A admin list excludes School B publications', async () => {
      const pubAId = await seedPublication({
        schoolId: TEST_SCHOOL_ID,
        title: 'A',
      });
      const pubBId = await seedPublication({
        schoolId: TEST_SCHOOL_B_ID,
        title: 'B',
      });
      const list = await withTestTenant(async () => publicationService.list(adminActor()));
      const ids = list.map((p) => p.id);
      expect(ids).toContain(pubAId);
      expect(ids).not.toContain(pubBId);
    });
  });

  // Suppress unused warnings for symbols kept for parity.
  void TEST_ADMIN_PERSON_ID;
  void seededStudentPersonIds;
});
