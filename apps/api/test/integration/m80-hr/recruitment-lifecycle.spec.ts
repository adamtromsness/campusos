import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { JobPostingService } from '@modules/m80-hr/recruitment/job-posting.service';
import { ApplicationService } from '@modules/m80-hr/recruitment/application.service';
import { InterviewService } from '@modules/m80-hr/recruitment/interview.service';
import { OfferService } from '@modules/m80-hr/recruitment/offer.service';
import { RecruitmentController } from '@modules/m80-hr/recruitment/recruitment.controller';
import { ActorContextService, PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

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
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { resetAndSeedHr, ensureHrFixtures, TEST_HR_POSITION_TEACHER_ID } from '../fixtures/hr';
import { generateId } from '@campusos/database';

describe('integration:m80-hr/recruitment-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let postings: JobPostingService;
  let applications: ApplicationService;
  let interviews: InterviewService;
  let offers: OfferService;
  let ctrl: RecruitmentController;
  let actors: ActorContextService;
  let outbox: OutboxService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const permissions = new PermissionCheckService(rawClient);
    actors = new ActorContextService(rawClient, permissions, tenantPrisma);
    outbox = new OutboxService();

    postings = new JobPostingService(tenantPrisma, permissions, outbox);
    applications = new ApplicationService(tenantPrisma, permissions, postings);
    interviews = new InterviewService(tenantPrisma, permissions, applications);
    offers = new OfferService(tenantPrisma, permissions, outbox, applications);
    ctrl = new RecruitmentController(postings, applications, interviews, offers, actors);

    await ensureHrFixtures(rawClient);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeedHr(rawClient);
    // Drain stray recruitment outbox rows that may have landed before
    // resetAndSeedHr ran (defensive).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox
         WHERE topic IN ('hr.job.posted','hr.offer.accepted')
           AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  function adminReq(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test.local',
        displayName: 'Admin',
        sessionId: 's',
      },
    };
  }

  async function createPosting(): Promise<string> {
    const dto = await withTestTenant(async () =>
      postings.create(
        {
          positionTitle: 'HR Test Teacher Position',
          description: 'Test posting',
          employmentType: 'FULL_TIME',
        } as any,
        adminActor(),
      ),
    );
    return dto.id;
  }

  async function makeLivePosting(): Promise<string> {
    const id = await createPosting();
    await withTestTenant(async () => postings.patch(id, { status: 'LIVE' } as any, adminActor()));
    return id;
  }

  // ───────────────────────────────────────────────────────────────────
  // JobPostingService
  // ───────────────────────────────────────────────────────────────────
  describe('JobPostingService', () => {
    it('create rejects non-admin', async () => {
      await expect(
        withTestTenant(async () =>
          postings.create(
            {
              positionTitle: 'X',
              description: 'd',
              employmentType: 'FULL_TIME',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create rejects invalid salary range', async () => {
      await expect(
        withTestTenant(async () =>
          postings.create(
            {
              positionTitle: 'X',
              description: 'd',
              employmentType: 'FULL_TIME',
              salaryRangeLow: 100,
              salaryRangeHigh: 10,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list + getById + listPublicLive + patch to LIVE emits outbox', async () => {
      const id = await createPosting();
      const list = await withTestTenant(async () => postings.list({} as any));
      expect(list.map((p) => p.id)).toContain(id);

      const got = await withTestTenant(async () => postings.getById(id));
      expect(got.id).toBe(id);

      // Patch to LIVE
      const live = await withTestTenant(async () =>
        postings.patch(id, { status: 'LIVE' } as any, adminActor()),
      );
      expect(live.status).toBe('LIVE');
      expect(live.postedAt).toBeTruthy();

      // Outbox emit
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox
          WHERE topic = 'hr.job.posted' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ topic: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);

      // Public LIVE list shows it
      const pub = await withTestTenant(async () => postings.listPublicLive());
      expect(pub.map((p) => p.id)).toContain(id);
    });

    it('list filters status + department', async () => {
      const id = await createPosting();
      await withTestTenant(async () =>
        postings.patch(
          id,
          {
            status: 'LIVE',
            department: 'Engineering',
            qualificationsRequired: 'Degree',
            salaryRangeLow: 30000,
            salaryRangeHigh: 60000,
            employmentType: 'PART_TIME',
            applicationDeadline: '2026-12-31',
          } as any,
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        postings.list({ status: 'LIVE', department: 'Engineering' } as any),
      );
      expect(filtered.length).toBeGreaterThan(0);
    });

    it('getById 404 missing', async () => {
      await expect(
        withTestTenant(async () => postings.getById('019e0cf8-aaaa-7777-8888-00000000ffff')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          postings.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { status: 'LIVE' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch no-op returns existing', async () => {
      const id = await createPosting();
      const same = await withTestTenant(async () => postings.patch(id, {} as any, adminActor()));
      expect(same.id).toBe(id);
    });

    it('patch CLOSED + then re-patch rejected', async () => {
      const id = await makeLivePosting();
      const closed = await withTestTenant(async () =>
        postings.patch(id, { status: 'CLOSED' } as any, adminActor()),
      );
      expect(closed.status).toBe('CLOSED');
      await expect(
        withTestTenant(async () => postings.patch(id, { status: 'LIVE' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch CANCELLED from DRAFT works (sets posted_at via COALESCE)', async () => {
      const id = await createPosting();
      const c = await withTestTenant(async () =>
        postings.patch(id, { status: 'CANCELLED' } as any, adminActor()),
      );
      expect(c.status).toBe('CANCELLED');
    });

    it('patch invalid status → BadRequest', async () => {
      const id = await createPosting();
      await expect(
        withTestTenant(async () =>
          postings.patch(id, { status: 'BOGUS' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('loadOpenForApply requires LIVE status', async () => {
      const id = await createPosting();
      await expect(
        withTestTenant(async () => postings.loadOpenForApply(id)),
      ).rejects.toBeInstanceOf(BadRequestException);
      await withTestTenant(async () => postings.patch(id, { status: 'LIVE' } as any, adminActor()));
      const row = await withTestTenant(async () => postings.loadOpenForApply(id));
      expect(row.id).toBe(id);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ApplicationService
  // ───────────────────────────────────────────────────────────────────
  describe('ApplicationService', () => {
    async function applyOnce(postingId: string, email = `candidate-${Date.now()}@test.local`) {
      return withTestTenant(async () =>
        applications.apply(postingId, {
          applicantEmail: email,
          firstName: 'Cand',
          lastName: 'Date',
          resumeS3Key: 's3/resume.pdf',
          coverLetterS3Key: 's3/cl.pdf',
        } as any),
      );
    }

    it('apply succeeds + double-apply same email rejects', async () => {
      const id = await makeLivePosting();
      const email = `cand-${Date.now()}@test.local`;
      const first = await applyOnce(id, email);
      expect(first.status).toBe('SUBMITTED');
      await expect(applyOnce(id, email)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('apply to DRAFT posting → BadRequest', async () => {
      const id = await createPosting();
      await expect(applyOnce(id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list admin scoping; non-admin → Forbidden', async () => {
      const id = await makeLivePosting();
      await applyOnce(id);
      await expect(
        withTestTenant(async () => applications.list({} as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const adminList = await withTestTenant(async () =>
        applications.list({} as any, adminActor()),
      );
      expect(adminList.length).toBeGreaterThan(0);
    });

    it('list filters postingId + status', async () => {
      const id = await makeLivePosting();
      const app = await applyOnce(id);
      const filtered = await withTestTenant(async () =>
        applications.list({ postingId: id, status: 'SUBMITTED' } as any, adminActor()),
      );
      expect(filtered.map((a) => a.id)).toContain(app.id);
    });

    it('getById non-admin foreign → 404 (no leak); admin gets it', async () => {
      const id = await makeLivePosting();
      const app = await applyOnce(id);
      await expect(
        withTestTenant(async () => applications.getById(app.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      const dto = await withTestTenant(async () => applications.getById(app.id, adminActor()));
      expect(dto.id).toBe(app.id);
    });

    it('listForPosting admin only', async () => {
      const id = await makeLivePosting();
      await applyOnce(id);
      await expect(
        withTestTenant(async () => applications.listForPosting(id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const list = await withTestTenant(async () => applications.listForPosting(id, adminActor()));
      expect(list.length).toBeGreaterThan(0);
    });

    it('patch flips status + rejects non-admin', async () => {
      const id = await makeLivePosting();
      const app = await applyOnce(id);
      await expect(
        withTestTenant(async () =>
          applications.patch(app.id, { status: 'UNDER_REVIEW' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const out = await withTestTenant(async () =>
        applications.patch(app.id, { status: 'UNDER_REVIEW' } as any, adminActor()),
      );
      expect(out.status).toBe('UNDER_REVIEW');

      // No-op + invalid + notSelectedReason
      const same = await withTestTenant(async () =>
        applications.patch(app.id, {} as any, adminActor()),
      );
      expect(same.id).toBe(app.id);

      await expect(
        withTestTenant(async () =>
          applications.patch(app.id, { status: 'BOGUS' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const ns = await withTestTenant(async () =>
        applications.patch(
          app.id,
          { notSelectedReason: 'no fit', withdrawnReason: 'cand left' } as any,
          adminActor(),
        ),
      );
      expect(ns.notSelectedReason).toBe('no fit');
    });

    it('patch missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          applications.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { status: 'SCREENING' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadInternal returns or null', async () => {
      const id = await makeLivePosting();
      const app = await applyOnce(id);
      const r = await withTestTenant(async () => applications.loadInternal(app.id));
      expect(r?.id).toBe(app.id);
      const miss = await withTestTenant(async () =>
        applications.loadInternal('019e0cf8-aaaa-7777-8888-00000000ffff'),
      );
      expect(miss).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // InterviewService
  // ───────────────────────────────────────────────────────────────────
  describe('InterviewService', () => {
    async function panelAndApplication(): Promise<{
      postingId: string;
      applicationId: string;
      panelId: string;
      personId: string;
    }> {
      const postingId = await makeLivePosting();
      const app = await withTestTenant(async () =>
        applications.apply(postingId, {
          applicantEmail: `panelcand-${Date.now()}@test.local`,
          firstName: 'Panel',
          lastName: 'Cand',
        } as any),
      );
      const panel = await withTestTenant(async () =>
        interviews.createPanel(
          {
            postingId,
            panelName: 'Panel-' + Date.now(),
            panelistPersonIds: [TEST_ADMIN_PERSON_ID],
          } as any,
          adminActor(),
        ),
      );
      return { postingId, applicationId: app.id, panelId: panel.id, personId: app.personId };
    }

    it('createPanel rejects non-admin + foreign posting → BadRequest', async () => {
      const id = await createPosting();
      await expect(
        withTestTenant(async () =>
          interviews.createPanel(
            {
              postingId: id,
              panelName: 'PX',
              panelistPersonIds: [],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          interviews.createPanel(
            {
              postingId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              panelName: 'PX',
              panelistPersonIds: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createPanel duplicate name → BadRequest', async () => {
      const id = await createPosting();
      const name = 'Dup-' + Date.now();
      await withTestTenant(async () =>
        interviews.createPanel(
          { postingId: id, panelName: name, panelistPersonIds: [] } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          interviews.createPanel(
            { postingId: id, panelName: name, panelistPersonIds: [] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('listPanels admin + rejects non-admin', async () => {
      const { postingId } = await panelAndApplication();
      const list = await withTestTenant(async () => interviews.listPanels(postingId, adminActor()));
      expect(list.length).toBeGreaterThan(0);
      await expect(
        withTestTenant(async () => interviews.listPanels(postingId, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listPanels empty → []', async () => {
      // Brand new posting → no panels.
      const id = await createPosting();
      const list = await withTestTenant(async () => interviews.listPanels(id, adminActor()));
      expect(list).toEqual([]);
    });

    it('schedule + getById + listForApplication + patch lifecycle', async () => {
      const { applicationId, panelId } = await panelAndApplication();
      const iv = await withTestTenant(async () =>
        interviews.schedule(
          {
            applicationId,
            panelId,
            scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
            durationMinutes: 60,
            location: 'Room A',
            meetingUrl: 'https://meet/123',
            notes: 'note',
          } as any,
          adminActor(),
        ),
      );
      expect(iv.status).toBe('SCHEDULED');

      const list = await withTestTenant(async () =>
        interviews.listForApplication(applicationId, adminActor()),
      );
      expect(list.map((i) => i.id)).toContain(iv.id);

      const got = await withTestTenant(async () => interviews.getById(iv.id, adminActor()));
      expect(got.id).toBe(iv.id);

      const noop = await withTestTenant(async () =>
        interviews.patch(iv.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(iv.id);

      const completed = await withTestTenant(async () =>
        interviews.patch(iv.id, { notes: 'good', status: 'COMPLETED' } as any, adminActor()),
      );
      expect(completed.status).toBe('COMPLETED');

      // Cannot re-flip terminal
      await expect(
        withTestTenant(async () =>
          interviews.patch(iv.id, { status: 'SCHEDULED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('schedule rejects bogus application + foreign panel', async () => {
      const { postingId, panelId } = await panelAndApplication();
      await expect(
        withTestTenant(async () =>
          interviews.schedule(
            {
              applicationId: '019e0cf8-aaaa-7777-8888-00000000ffff',
              panelId,
              scheduledAt: new Date().toISOString(),
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Application not tied to panel posting
      const otherPostingId = await makeLivePosting();
      const app2 = await withTestTenant(async () =>
        applications.apply(otherPostingId, {
          applicantEmail: `other-${Date.now()}@test.local`,
          firstName: 'O',
          lastName: 'C',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          interviews.schedule(
            {
              applicationId: app2.id,
              panelId,
              scheduledAt: new Date().toISOString(),
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      void postingId;
    });

    it('patch CANCELLED requires cancellationReason', async () => {
      const { applicationId, panelId } = await panelAndApplication();
      const iv = await withTestTenant(async () =>
        interviews.schedule(
          {
            applicationId,
            panelId,
            scheduledAt: new Date().toISOString(),
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          interviews.patch(iv.id, { status: 'CANCELLED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const c = await withTestTenant(async () =>
        interviews.patch(
          iv.id,
          { status: 'CANCELLED', cancellationReason: 'no go' } as any,
          adminActor(),
        ),
      );
      expect(c.status).toBe('CANCELLED');
    });

    it('patch missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          interviews.patch(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { notes: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('submitEvaluation as panel member; non-member → Forbidden', async () => {
      const { applicationId, panelId } = await panelAndApplication();
      const iv = await withTestTenant(async () =>
        interviews.schedule(
          {
            applicationId,
            panelId,
            scheduledAt: new Date().toISOString(),
          } as any,
          adminActor(),
        ),
      );

      const ev = await withTestTenant(async () =>
        interviews.submitEvaluation(
          iv.id,
          { rating: 'HIRE', strengths: 's', concerns: 'c', notes: 'n' } as any,
          adminActor(),
        ),
      );
      expect(ev.rating).toBe('HIRE');

      // Re-submit → UPSERT
      const ev2 = await withTestTenant(async () =>
        interviews.submitEvaluation(iv.id, { rating: 'STRONG_HIRE' } as any, adminActor()),
      );
      expect(ev2.rating).toBe('STRONG_HIRE');

      // Non-member (teacher) → Forbidden
      await expect(
        withTestTenant(async () =>
          interviews.submitEvaluation(iv.id, { rating: 'HIRE' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // No-personId → Forbidden
      await expect(
        withTestTenant(async () =>
          interviews.submitEvaluation(iv.id, { rating: 'HIRE' } as any, {
            ...adminActor(),
            personId: null as any,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // listEvaluations admin
      const evList = await withTestTenant(async () =>
        interviews.listEvaluations(iv.id, adminActor()),
      );
      expect(evList.length).toBeGreaterThanOrEqual(1);
    });

    it('getById non-admin → Forbidden', async () => {
      const { applicationId, panelId } = await panelAndApplication();
      const iv = await withTestTenant(async () =>
        interviews.schedule(
          { applicationId, panelId, scheduledAt: new Date().toISOString() } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => interviews.getById(iv.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // OfferService — KEYSTONE accepted → hr_employees + outbox emit
  // ───────────────────────────────────────────────────────────────────
  describe('OfferService', () => {
    async function applicationReadyForOffer(email = `oc-${Date.now()}@test.local`): Promise<{
      postingId: string;
      applicationId: string;
      personId: string;
    }> {
      const postingId = await makeLivePosting();
      const app = await withTestTenant(async () =>
        applications.apply(postingId, {
          applicantEmail: email,
          firstName: 'Off',
          lastName: 'Cand',
        } as any),
      );
      // Move it forward
      await withTestTenant(async () =>
        applications.patch(app.id, { status: 'INTERVIEW_COMPLETED' } as any, adminActor()),
      );
      return { postingId, applicationId: app.id, personId: app.personId };
    }

    it('extendOffer rejects non-admin + missing application', async () => {
      const { applicationId } = await applicationReadyForOffer();
      await expect(
        withTestTenant(async () =>
          offers.extendOffer(
            applicationId,
            {
              positionTitle: 'X',
              salary: 50000,
              startDate: '2026-09-01',
              contractType: 'ANNUAL',
              acceptanceDeadline: '2026-08-31',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          offers.extendOffer(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            {
              positionTitle: 'X',
              salary: 50000,
              startDate: '2026-09-01',
              contractType: 'ANNUAL',
              acceptanceDeadline: '2026-08-31',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('extendOffer + respond ACCEPTED → creates employee + outbox emit', async () => {
      const { applicationId } = await applicationReadyForOffer();
      const offer = await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'HR Test Teacher Position',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'ANNUAL',
            acceptanceDeadline: '2026-08-31',
            conditions: ['Bg check'],
          } as any,
          adminActor(),
        ),
      );
      expect(offer.status).toBe('PENDING');

      const list = await withTestTenant(async () => offers.list(adminActor()));
      expect(list.map((o) => o.id)).toContain(offer.id);

      const got = await withTestTenant(async () => offers.getById(offer.id, adminActor()));
      expect(got.id).toBe(offer.id);

      // Accept
      const accepted = await withTestTenant(async () =>
        offers.respond(
          offer.id,
          { decision: 'ACCEPTED', responseNotes: 'great' } as any,
          adminActor(),
        ),
      );
      expect(accepted.status).toBe('ACCEPTED');
      expect(accepted.createdEmployeeId).toBeTruthy();

      // Verify outbox emit
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
          WHERE topic = 'hr.offer.accepted' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ envelope: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.payload.offerId).toBe(offer.id);
      expect(env.payload.employeeId).toBe(accepted.createdEmployeeId);

      // Verify hr_employees row landed in this school
      const empRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id FROM ${TEST_SCHEMA}.hr_employees
          WHERE id = $1::uuid`,
        accepted.createdEmployeeId!,
      )) as Array<{ id: string; school_id: string }>;
      expect(empRows.length).toBe(1);
      expect(empRows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    });

    it('extendOffer with in-flight offer → BadRequest', async () => {
      const { applicationId } = await applicationReadyForOffer();
      await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          offers.extendOffer(
            applicationId,
            {
              positionTitle: 'X',
              salary: 50000,
              startDate: '2026-09-01',
              contractType: 'AT_WILL',
              acceptanceDeadline: '2026-08-31',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('respond DECLINED + WITHDRAWN paths', async () => {
      const { applicationId } = await applicationReadyForOffer('decl-' + Date.now() + '@t.l');
      const offer1 = await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      const d = await withTestTenant(async () =>
        offers.respond(offer1.id, { decision: 'DECLINED' } as any, adminActor()),
      );
      expect(d.status).toBe('DECLINED');

      const r2 = await applicationReadyForOffer('wd-' + Date.now() + '@t.l');
      const offer2 = await withTestTenant(async () =>
        offers.extendOffer(
          r2.applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      const w = await withTestTenant(async () =>
        offers.respond(offer2.id, { decision: 'WITHDRAWN' } as any, adminActor()),
      );
      expect(w.status).toBe('WITHDRAWN');
    });

    it('respond invalid decision → BadRequest', async () => {
      await expect(
        withTestTenant(async () =>
          offers.respond(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { decision: 'BOGUS' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('respond non-PENDING → BadRequest', async () => {
      const { applicationId } = await applicationReadyForOffer(`np-${Date.now()}@t.l`);
      const offer = await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        offers.respond(offer.id, { decision: 'DECLINED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          offers.respond(offer.id, { decision: 'ACCEPTED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('respond missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          offers.respond(
            '019e0cf8-aaaa-7777-8888-00000000ffff',
            { decision: 'ACCEPTED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin respond to other candidate offer → Forbidden', async () => {
      const { applicationId } = await applicationReadyForOffer(`fc-${Date.now()}@t.l`);
      const offer = await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          offers.respond(offer.id, { decision: 'ACCEPTED' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('respond ACCEPTED when applicant has no platform_users → Conflict', async () => {
      // Manually build an iam_person without platform_users
      const personId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Orph', 'Cand', 'STAFF', true)`,
        personId,
      );
      const postingId = await makeLivePosting();
      const appId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.hr_applications
           (id, posting_id, person_id, status, submitted_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'INTERVIEW_COMPLETED', now())`,
        appId,
        postingId,
        personId,
      );
      const offer = await withTestTenant(async () =>
        offers.extendOffer(
          appId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          offers.respond(offer.id, { decision: 'ACCEPTED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-admin getById foreign → 404', async () => {
      const { applicationId } = await applicationReadyForOffer(`pc-${Date.now()}@t.l`);
      const offer = await withTestTenant(async () =>
        offers.extendOffer(
          applicationId,
          {
            positionTitle: 'X',
            salary: 50000,
            startDate: '2026-09-01',
            contractType: 'AT_WILL',
            acceptanceDeadline: '2026-08-31',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => offers.getById(offer.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          offers.getById('019e0cf8-aaaa-7777-8888-00000000ffff', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Controllers
  // ───────────────────────────────────────────────────────────────────
  describe('RecruitmentController', () => {
    it('postings + public listing', async () => {
      const created = await withTestTenant(async () =>
        ctrl.createPosting(adminReq(), {
          positionTitle: 'Ctrl P',
          description: 'd',
          employmentType: 'FULL_TIME',
        } as any),
      );
      const list = await withTestTenant(async () => ctrl.listPostings({} as any));
      expect(list.map((l) => l.id)).toContain(created.id);
      const got = await withTestTenant(async () => ctrl.getPosting(created.id));
      expect(got.id).toBe(created.id);
      const upd = await withTestTenant(async () =>
        ctrl.patchPosting(adminReq(), created.id, { status: 'LIVE' } as any),
      );
      expect(upd.status).toBe('LIVE');
      const pub = await withTestTenant(async () => ctrl.listPublicPostings());
      expect(pub.map((p) => p.id)).toContain(created.id);
    });

    it('applications + panels + interviews + offer end-to-end', async () => {
      // Posting + LIVE
      const p = await withTestTenant(async () =>
        ctrl.createPosting(adminReq(), {
          positionTitle: 'HR Test Teacher Position',
          description: 'd',
          employmentType: 'FULL_TIME',
        } as any),
      );
      await withTestTenant(async () =>
        ctrl.patchPosting(adminReq(), p.id, { status: 'LIVE' } as any),
      );
      // Apply
      const a = await withTestTenant(async () =>
        ctrl.apply(p.id, {
          applicantEmail: `ctrl-${Date.now()}@test.local`,
          firstName: 'C',
          lastName: 'Trl',
        } as any),
      );
      // Patch application
      const upd = await withTestTenant(async () =>
        ctrl.patchApplication(adminReq(), a.id, { status: 'INTERVIEW_COMPLETED' } as any),
      );
      expect(upd.status).toBe('INTERVIEW_COMPLETED');
      // Lists
      const aList = await withTestTenant(async () => ctrl.listApplications(adminReq(), {} as any));
      expect(aList.map((x) => x.id)).toContain(a.id);
      const aGot = await withTestTenant(async () => ctrl.getApplication(adminReq(), a.id));
      expect(aGot.id).toBe(a.id);
      const aList2 = await withTestTenant(async () => ctrl.listForPosting(adminReq(), p.id));
      expect(aList2.map((x) => x.id)).toContain(a.id);

      // Panel
      const panel = await withTestTenant(async () =>
        ctrl.createPanel(adminReq(), {
          postingId: p.id,
          panelName: 'CtrlPanel-' + Date.now(),
          panelistPersonIds: [TEST_ADMIN_PERSON_ID],
        } as any),
      );
      const panels = await withTestTenant(async () => ctrl.listPanels(adminReq(), p.id));
      expect(panels.map((x) => x.id)).toContain(panel.id);

      // Interview
      const iv = await withTestTenant(async () =>
        ctrl.scheduleInterview(adminReq(), {
          applicationId: a.id,
          panelId: panel.id,
          scheduledAt: new Date().toISOString(),
        } as any),
      );
      const ivList = await withTestTenant(async () => ctrl.listInterviews(adminReq(), a.id));
      expect(ivList.map((x) => x.id)).toContain(iv.id);
      const ivGot = await withTestTenant(async () => ctrl.getInterview(adminReq(), iv.id));
      expect(ivGot.id).toBe(iv.id);
      const ivUpd = await withTestTenant(async () =>
        ctrl.patchInterview(adminReq(), iv.id, { status: 'COMPLETED' } as any),
      );
      expect(ivUpd.status).toBe('COMPLETED');

      // Evaluation
      const ev = await withTestTenant(async () =>
        ctrl.submitEvaluation(adminReq(), iv.id, { rating: 'HIRE' } as any),
      );
      const evList = await withTestTenant(async () => ctrl.listEvaluations(adminReq(), iv.id));
      expect(evList.map((e) => e.id)).toContain(ev.id);

      // Offer
      const offer = await withTestTenant(async () =>
        ctrl.extendOffer(adminReq(), a.id, {
          positionTitle: 'HR Test Teacher Position',
          salary: 50000,
          startDate: '2026-09-01',
          contractType: 'ANNUAL',
          acceptanceDeadline: '2026-08-31',
        } as any),
      );
      const oList = await withTestTenant(async () => ctrl.listOffers(adminReq()));
      expect(oList.map((x) => x.id)).toContain(offer.id);
      const oGot = await withTestTenant(async () => ctrl.getOffer(adminReq(), offer.id));
      expect(oGot.id).toBe(offer.id);
      const oResp = await withTestTenant(async () =>
        ctrl.respondToOffer(adminReq(), offer.id, { decision: 'ACCEPTED' } as any),
      );
      expect(oResp.status).toBe('ACCEPTED');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Cross-school
  // ───────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('postings A not visible in B', async () => {
      const id = await createPosting();
      const fromB = await withTestTenantB(async () => postings.list({} as any));
      expect(fromB.map((p) => p.id)).not.toContain(id);
    });
  });

  // Reference unused id
  it('exports fixture ids', () => {
    expect(TEST_HR_POSITION_TEACHER_ID).toBeTruthy();
  });
});
