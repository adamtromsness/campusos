import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { PublicationsController } from '@modules/m42-publications/publications.controller';
import {
  CollaboratorService,
  EditionService,
  PublicationService,
  SeriesService,
} from '@modules/m42-publications/series.service';
import {
  CommentService,
  ContributorService,
  SectionService,
} from '@modules/m42-publications/sections.service';
import {
  DistributionService,
  SubscriptionService,
} from '@modules/m42-publications/distribution.service';
import { TemplateService, VersionService } from '@modules/m42-publications/versions.service';
import {
  PublicationAnalyticsService,
  ScheduledPublishService,
} from '@modules/m42-publications/scheduled-publish.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { RedisService } from '@shared/cache/redis.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_PUB_SERIES_ID } from '../fixtures/publications';

/**
 * Controller-layer integration tests for m42-publications. Each route
 * is invoked with a synthetic AuthedRequest carrying the test admin's
 * identity. ActorContextService resolves isSchoolAdmin=true via the
 * pre-seeded IAM cache so controller methods reach the service tree.
 *
 * Purpose: lifts publications.controller.ts from 0% to ≥80% so the
 * module's combined coverage exceeds 80%.
 */
describe('integration:m42-publications/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let actorContext: ActorContextService;
  let controller: PublicationsController;
  let seriesService: SeriesService;
  let editionService: EditionService;
  let publicationService: PublicationService;
  let collaboratorService: CollaboratorService;
  let sectionService: SectionService;
  let contributorService: ContributorService;
  let commentService: CommentService;
  let distributionService: DistributionService;
  let subscriptionService: SubscriptionService;
  let versionService: VersionService;
  let templateService: TemplateService;
  let scheduledService: ScheduledPublishService;
  let analyticsService: PublicationAnalyticsService;

  const seededPubIds: string[] = [];
  const seededSeriesIds: string[] = [];
  const seededTemplateIds: string[] = [];

  function fakeAdminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.integration.local',
        displayName: 'Integration Admin',
        sessionId: 'test-session',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    actorContext = new ActorContextService(rawClient, permCheck, tenantPrisma);

    const kafka = makeRecordingKafka() as unknown as KafkaProducerService;
    const redis = new RedisService();

    seriesService = new SeriesService(tenantPrisma, permCheck);
    editionService = new EditionService(tenantPrisma, permCheck);
    publicationService = new PublicationService(tenantPrisma, permCheck);
    versionService = new VersionService(tenantPrisma, permCheck);
    publicationService.setVersionService(versionService);
    collaboratorService = new CollaboratorService(tenantPrisma);
    sectionService = new SectionService(tenantPrisma, permCheck);
    contributorService = new ContributorService(tenantPrisma);
    commentService = new CommentService(tenantPrisma, permCheck);
    distributionService = new DistributionService(tenantPrisma, permCheck, kafka);
    subscriptionService = new SubscriptionService(tenantPrisma);
    templateService = new TemplateService(tenantPrisma, permCheck);
    scheduledService = new ScheduledPublishService(tenantPrisma, permCheck);
    analyticsService = new PublicationAnalyticsService(tenantPrisma, permCheck, redis);

    controller = new PublicationsController(
      seriesService,
      editionService,
      publicationService,
      collaboratorService,
      sectionService,
      contributorService,
      commentService,
      distributionService,
      subscriptionService,
      versionService,
      templateService,
      scheduledService,
      analyticsService,
      actorContext,
    );

    // Seed admin permission cache so resolveActor returns isSchoolAdmin=true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['sch-001:admin','pub-001:write','pub-001:read','pub-002:write','pub-003:write','pub-003:read']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE SET permission_codes = EXCLUDED.permission_codes`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );

    // Ensure student actor projection for assertAccountInCurrentTenant
    const psId = generateId();
    const sid = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Ctrl', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'Ctrl', 'Student', true) ON CONFLICT DO NOTHING`,
      psId,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, 'Ctrl Student', 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
      TEST_STUDENT_ACCOUNT_ID,
      TEST_STUDENT_PERSON_ID,
      'ctrl-student-' + TEST_STUDENT_ACCOUNT_ID.slice(-6) + '@test.local',
    );
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
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5', 'ENROLLED') ON CONFLICT DO NOTHING`,
        sid,
        psId,
        TEST_SCHOOL_ID,
        'CTRL-' + sid.slice(-6),
      );
    }
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_recipients WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_rules WHERE distribution_list_id IN (
           SELECT id FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = ANY($1::uuid[])
         )`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_analytics_contributions WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.pub_publication_versions`);
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
    if (seededTemplateIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_templates WHERE id = ANY($1::uuid[])`,
        seededTemplateIds.splice(0),
      );
    }
    if (seededSeriesIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_series WHERE id = ANY($1::uuid[])`,
        seededSeriesIds.splice(0),
      );
    }
  });

  async function seedPublication(opts: { status?: string } = {}): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'CtrlPub', 'NEWSLETTER', $3, $4::uuid)`,
      id,
      TEST_SCHOOL_ID,
      opts.status ?? 'DRAFT',
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // Series routes
  // ──────────────────────────────────────────────────────────────────
  describe('series routes', () => {
    it('GET /publications/series returns list', async () => {
      const out = await withTestTenant(async () => controller.listSeries());
      expect(Array.isArray(out)).toBe(true);
    });

    it('GET /publications/series/:id returns the fixture series', async () => {
      const out = await withTestTenant(async () => controller.getSeries(TEST_PUB_SERIES_ID));
      expect(out.id).toBe(TEST_PUB_SERIES_ID);
    });

    it('POST /publications/series creates a new series', async () => {
      const out = await withTestTenant(async () =>
        controller.createSeries(
          {
            title: 'Ctrl Created ' + generateId().slice(-6),
            publicationType: 'NEWSLETTER',
            frequency: 'WEEKLY',
          } as any,
          fakeAdminReq(),
        ),
      );
      seededSeriesIds.push(out.id);
      expect(out.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('PATCH /publications/series/:id updates the series', async () => {
      const created = await withTestTenant(async () =>
        controller.createSeries(
          {
            title: 'Patchable ' + generateId().slice(-6),
            publicationType: 'NEWSLETTER',
            frequency: 'WEEKLY',
          } as any,
          fakeAdminReq(),
        ),
      );
      seededSeriesIds.push(created.id);
      await withTestTenant(async () =>
        controller.patchSeries(created.id, { description: 'patched' } as any, fakeAdminReq()),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT description FROM ${TEST_SCHEMA}.pub_series WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ description: string }>;
      expect(rows[0]!.description).toBe('patched');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Edition routes
  // ──────────────────────────────────────────────────────────────────
  describe('edition routes', () => {
    it('POST /series/:id/editions + GET list + GET by id', async () => {
      const created = await withTestTenant(async () =>
        controller.createEdition(
          TEST_PUB_SERIES_ID,
          { editionLabel: 'CtrlEdition' } as any,
          fakeAdminReq(),
        ),
      );
      const list = await withTestTenant(async () => controller.listEditions(TEST_PUB_SERIES_ID));
      expect(list.map((e) => e.id)).toContain(created.id);

      const fetched = await withTestTenant(async () => controller.getEdition(created.id));
      expect(fetched.id).toBe(created.id);
    });

    it('PATCH /editions/:id', async () => {
      const created = await withTestTenant(async () =>
        controller.createEdition(TEST_PUB_SERIES_ID, {} as any, fakeAdminReq()),
      );
      await withTestTenant(async () =>
        controller.patchEdition(created.id, { theme: 'Spring' } as any, fakeAdminReq()),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT theme FROM ${TEST_SCHEMA}.pub_edition WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ theme: string }>;
      expect(rows[0]!.theme).toBe('Spring');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Publication routes
  // ──────────────────────────────────────────────────────────────────
  describe('publication routes', () => {
    it('POST /publications + GET /publications + GET /publications/:id', async () => {
      const created = await withTestTenant(async () =>
        controller.createPublication(
          {
            title: 'Ctrl pub',
            publicationType: 'NEWSLETTER',
          } as any,
          fakeAdminReq(),
        ),
      );
      seededPubIds.push(created.id);

      const list = await withTestTenant(async () => controller.listPublications(fakeAdminReq()));
      expect(list.map((p) => p.id)).toContain(created.id);

      const detail = await withTestTenant(async () =>
        controller.getPublication(created.id, fakeAdminReq()),
      );
      expect(detail.id).toBe(created.id);
    });

    it('list filter by status + seriesId', async () => {
      await seedPublication({ status: 'DRAFT' });
      await seedPublication({ status: 'IN_REVIEW' });
      const filtered = await withTestTenant(async () =>
        controller.listPublications(fakeAdminReq(), 'IN_REVIEW' as any),
      );
      const statuses = new Set(filtered.map((p) => p.status));
      expect(statuses.has('IN_REVIEW')).toBe(true);
      expect(statuses.has('DRAFT')).toBe(false);

      const bySeries = await withTestTenant(async () =>
        controller.listPublications(fakeAdminReq(), undefined, TEST_PUB_SERIES_ID),
      );
      expect(Array.isArray(bySeries)).toBe(true);
    });

    it('PATCH /publications/:id/status', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        controller.patchPublicationStatus(pubId, { status: 'IN_REVIEW' } as any, fakeAdminReq()),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('IN_REVIEW');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Collaborator routes
  // ──────────────────────────────────────────────────────────────────
  describe('collaborator routes', () => {
    it('POST /publications/:id/collaborators + DELETE /publication-collaborators/:id', async () => {
      const pubId = await seedPublication();
      const created = await withTestTenant(async () =>
        controller.invite(
          pubId,
          {
            userId: TEST_STUDENT_ACCOUNT_ID,
            role: 'CONTRIBUTOR',
          } as any,
          fakeAdminReq(),
        ),
      );
      expect(created.userId).toBe(TEST_STUDENT_ACCOUNT_ID);

      await withTestTenant(async () => controller.removeCollaborator(created.id, fakeAdminReq()));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_collaborators WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Section routes
  // ──────────────────────────────────────────────────────────────────
  describe('section routes', () => {
    it('section CRUD: create, list, patch, approve, remove', async () => {
      const pubId = await seedPublication();
      const created = await withTestTenant(async () =>
        controller.createSection(pubId, { title: 'A', body: 'b' } as any, fakeAdminReq()),
      );
      expect(created.title).toBe('A');

      const list = await withTestTenant(async () => controller.listSections(pubId, fakeAdminReq()));
      expect(list.map((s) => s.id)).toContain(created.id);

      await withTestTenant(async () =>
        controller.patchSection(created.id, { title: 'New title' } as any, fakeAdminReq()),
      );
      await withTestTenant(async () => controller.approveSection(created.id, fakeAdminReq()));

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT title, is_approved FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ title: string; is_approved: boolean }>;
      expect(rows[0]!.title).toBe('New title');
      expect(rows[0]!.is_approved).toBe(true);

      await withTestTenant(async () => controller.removeSection(created.id, fakeAdminReq()));
      const after = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_sections WHERE id = $1::uuid`,
        created.id,
      )) as Array<{ n: number }>;
      expect(after[0]!.n).toBe(0);
    });

    it('contributor + comment routes', async () => {
      const pubId = await seedPublication();
      const section = await withTestTenant(async () =>
        controller.createSection(pubId, { title: 'Sec', body: 'b' } as any, fakeAdminReq()),
      );
      const contrib = await withTestTenant(async () =>
        controller.addContributor(
          section.id,
          { contributorId: TEST_STUDENT_ACCOUNT_ID } as any,
          fakeAdminReq(),
        ),
      );
      expect(contrib.contributorId).toBe(TEST_STUDENT_ACCOUNT_ID);

      const comment = await withTestTenant(async () =>
        controller.createComment(section.id, { body: 'looks good' } as any, fakeAdminReq()),
      );
      expect(comment.body).toBe('looks good');

      const comments = await withTestTenant(async () =>
        controller.listSectionComments(section.id, fakeAdminReq()),
      );
      expect(comments.map((c) => c.id)).toContain(comment.id);

      await withTestTenant(async () => controller.resolveComment(comment.id, fakeAdminReq()));

      await withTestTenant(async () => controller.removeContributor(contrib.id, fakeAdminReq()));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Distribution + subscription routes
  // ──────────────────────────────────────────────────────────────────
  describe('distribution + subscription routes', () => {
    it('createList → addRule → previewAudience → distribute → distributionStatus', async () => {
      const pubId = await seedPublication({ status: 'APPROVED' });
      await withTestTenant(async () =>
        controller.createDistributionList(
          pubId,
          { listName: 'CtrlList', rules: [] } as any,
          fakeAdminReq(),
        ),
      );
      const listRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.pub_distribution_lists WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ id: string }>;
      await withTestTenant(async () =>
        controller.addRule(
          listRows[0]!.id,
          { ruleType: 'ROLE', ruleValue: 'STAFF' } as any,
          fakeAdminReq(),
        ),
      );

      const preview = await withTestTenant(async () =>
        controller.previewAudience(pubId, fakeAdminReq()),
      );
      expect(typeof preview.totalRecipients).toBe('number');

      const distResult = await withTestTenant(async () =>
        controller.distribute(pubId, fakeAdminReq()),
      );
      expect(distResult.status).toBe('PUBLISHED');

      const status = await withTestTenant(async () =>
        controller.distributionStatus(pubId, fakeAdminReq()),
      );
      expect(status.publicationId).toBe(pubId);

      const lists = await withTestTenant(async () =>
        controller.listDistributionLists(pubId, fakeAdminReq()),
      );
      expect(lists.length).toBeGreaterThan(0);
    });

    it('subscribe / unsubscribe / listSubscriptions / mySubscriptions', async () => {
      await withTestTenant(async () => controller.subscribe(TEST_PUB_SERIES_ID, fakeAdminReq()));
      const subs = await withTestTenant(async () =>
        controller.listSubscriptions(TEST_PUB_SERIES_ID),
      );
      expect(subs.length).toBeGreaterThan(0);
      const mine = await withTestTenant(async () => controller.mySubscriptions(fakeAdminReq()));
      expect(mine.length).toBeGreaterThan(0);
      await withTestTenant(async () => controller.unsubscribe(TEST_PUB_SERIES_ID, fakeAdminReq()));
      // Cleanup
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_series_subscriptions WHERE series_id = $1::uuid`,
        TEST_PUB_SERIES_ID,
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Version routes
  // ──────────────────────────────────────────────────────────────────
  describe('version routes', () => {
    it('checkpoint → list → getById → revert', async () => {
      const pubId = await seedPublication();
      const cp = await withTestTenant(async () =>
        controller.createCheckpoint(pubId, { versionNote: 'cp1' } as any, fakeAdminReq()),
      );
      expect(cp.versionNumber).toBe(1);

      const list = await withTestTenant(async () => controller.listVersions(pubId, fakeAdminReq()));
      expect(list.length).toBeGreaterThan(0);

      const detail = await withTestTenant(async () => controller.getVersion(cp.id, fakeAdminReq()));
      expect(detail.id).toBe(cp.id);

      const reverted = await withTestTenant(async () =>
        controller.revertToVersion(pubId, '1', {} as any, fakeAdminReq()),
      );
      expect(reverted.trigger).toBe('REVERT');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Template routes
  // ──────────────────────────────────────────────────────────────────
  describe('template routes', () => {
    it('full template CRUD + from-template', async () => {
      const tpl = await withTestTenant(async () =>
        controller.createTemplate(
          {
            name: 'CtrlTemplate ' + generateId().slice(-6),
            publicationType: 'NEWSLETTER',
            templateContent: { sections: [{ title: 'Intro', sortOrder: 0 }] },
          } as any,
          fakeAdminReq(),
        ),
      );
      seededTemplateIds.push(tpl.id);

      const list = await withTestTenant(async () =>
        controller.listTemplates(undefined, fakeAdminReq()),
      );
      expect(list.map((t) => t.id)).toContain(tpl.id);

      const incInactive = await withTestTenant(async () =>
        controller.listTemplates('1', fakeAdminReq()),
      );
      expect(Array.isArray(incInactive)).toBe(true);

      const fetched = await withTestTenant(async () =>
        controller.getTemplate(tpl.id, fakeAdminReq()),
      );
      expect(fetched.id).toBe(tpl.id);

      await withTestTenant(async () =>
        controller.updateTemplate(tpl.id, { description: 'updated' } as any, fakeAdminReq()),
      );

      const fromTemplate = await withTestTenant(async () =>
        controller.createFromTemplate(
          tpl.id,
          { title: 'from-tpl publication' } as any,
          fakeAdminReq(),
        ),
      );
      seededPubIds.push(fromTemplate.id);
      expect(fromTemplate.title).toBe('from-tpl publication');

      await withTestTenant(async () => controller.deleteTemplate(tpl.id, fakeAdminReq()));
      // Already deleted, remove from cleanup list
      const idx = seededTemplateIds.indexOf(tpl.id);
      if (idx >= 0) seededTemplateIds.splice(idx, 1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Scheduled publishing routes
  // ──────────────────────────────────────────────────────────────────
  describe('scheduled publishing routes', () => {
    it('schedule + get + list + cancel', async () => {
      const pubId = await seedPublication();
      const scheduledAt = new Date(Date.now() + 3600 * 1000).toISOString();
      const scheduled = await withTestTenant(async () =>
        controller.schedulePublication(pubId, { scheduledAt } as any, fakeAdminReq()),
      );
      expect(scheduled.publicationId).toBe(pubId);
      expect(scheduled.status).toBe('SCHEDULED');

      const fromGet = await withTestTenant(async () =>
        controller.getScheduleForPublication(pubId, fakeAdminReq()),
      );
      expect(fromGet?.publicationId).toBe(pubId);

      const list = await withTestTenant(async () => controller.listScheduled(fakeAdminReq()));
      expect(list.map((s) => s.publicationId)).toContain(pubId);

      await withTestTenant(async () =>
        controller.cancelSchedule(pubId, { cancellationReason: 'reason' } as any, fakeAdminReq()),
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Analytics routes
  // ──────────────────────────────────────────────────────────────────
  describe('analytics routes', () => {
    it('ingestAnalyticsEvent + getAnalytics + summary', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        controller.ingestAnalyticsEvent(pubId, { eventType: 'OPEN' } as any, fakeAdminReq()),
      );
      const a = await withTestTenant(async () => controller.getAnalytics(pubId, fakeAdminReq()));
      expect(a.publicationId).toBe(pubId);

      const summary = await withTestTenant(async () => controller.analyticsSummary(fakeAdminReq()));
      expect(Array.isArray(summary)).toBe(true);
    });
  });
});
