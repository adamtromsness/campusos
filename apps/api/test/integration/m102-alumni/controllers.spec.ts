import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AlumniController } from '@modules/m102-alumni/alumni.controller';
import {
  AlumniProfileService,
  AlumniTagService,
} from '@modules/m102-alumni/profile.service';
import {
  CampaignService,
  DonationService,
  OutreachService,
} from '@modules/m102-alumni/campaign.service';
import {
  AlumniEventService,
  AlumniNewsService,
  ReunionGroupService,
} from '@modules/m102-alumni/news.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache/redis.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetAlumniTables, ensureIamPerson } from '../fixtures/alumni';

class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

/**
 * Wave 7 — m102-alumni AlumniController.
 *
 * Smokes every controller handler through a stub ActorContextService.
 * Deeper service contracts live in the dedicated spec files.
 */
describe('integration:m102-alumni/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: AlumniController;
  let actorStub: SwitchingActorContext;
  let req: { user: { sub: string; personId: string; email: string; displayName: string; sessionId: string } };
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const redis = new RedisService();
    await redis.onModuleInit();

    const profiles = new AlumniProfileService(tenantPrisma, permCheck);
    const tagsSvc = new AlumniTagService(tenantPrisma, permCheck);
    const campaigns = new CampaignService(tenantPrisma, permCheck, outbox, redis);
    const donations = new DonationService(tenantPrisma, permCheck, outbox, redis);
    const outreach = new OutreachService(tenantPrisma, permCheck);
    const news = new AlumniNewsService(tenantPrisma, permCheck);
    const reunions = new ReunionGroupService(tenantPrisma, permCheck);
    const events = new AlumniEventService(tenantPrisma, permCheck);

    actorStub = new SwitchingActorContext();
    ctl = new AlumniController(
      profiles,
      tagsSvc,
      campaigns,
      donations,
      outreach,
      news,
      reunions,
      events,
      actorStub as unknown as ActorContextService,
    );

    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAlumniTables(rawClient, { personIds: seededPersonIds.splice(0) });
    actorStub.current = adminActor();
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  describe('profile + tag handlers', () => {
    it('createProfile + listProfiles + getProfile + patchProfile', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId, { firstName: 'A', lastName: 'B' });

      const created = await withTestTenant(async () =>
        ctl.createProfile(
          { personId, graduationYear: 2020 } as any,
          req as any,
        ),
      );
      expect(created.id).toBeTruthy();

      const list = await withTestTenant(async () => ctl.listProfiles(req as any));
      expect(list.length).toBe(1);
      const filtered = await withTestTenant(async () =>
        ctl.listProfiles(req as any, '2020', undefined, undefined),
      );
      expect(filtered.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getProfile(created.id, req as any));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        ctl.patchProfile(created.id, { currentEmployer: 'Z' } as any, req as any),
      );
      expect(patched.currentEmployer).toBe('Z');
    });

    it('getMyProfile resolves admin profile', async () => {
      // Admin needs an alumni row to call /me
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_alumni_profiles
           (id, school_id, person_id, graduation_year)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 2010)`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_ADMIN_PERSON_ID,
      );
      const mine = await withTestTenant(async () => ctl.getMyProfile(req as any));
      expect(mine.personId).toBe(TEST_ADMIN_PERSON_ID);
    });

    it('addTag + listByTag + removeTag', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId);
      const p = await withTestTenant(async () =>
        ctl.createProfile({ personId, graduationYear: 2020 } as any, req as any),
      );
      const t = await withTestTenant(async () =>
        ctl.addTag({ alumniId: p.id, tag: 'DONOR' } as any, req as any),
      );
      const list = await withTestTenant(async () => ctl.listByTag('DONOR', req as any));
      expect(list.length).toBe(1);
      await withTestTenant(async () => ctl.removeTag(t.id, req as any));
    });
  });

  describe('campaign + outreach handlers', () => {
    it('createCampaign + activate + raised + funnel + recipients + sendOutreach + updateStatus', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId);
      const p = await withTestTenant(async () =>
        ctl.createProfile({ personId, graduationYear: 2020 } as any, req as any),
      );
      await withTestTenant(async () =>
        ctl.addTag({ alumniId: p.id, tag: 'MENTOR' } as any, req as any),
      );

      const c = await withTestTenant(async () =>
        ctl.createCampaign({ title: 'Drive' } as any, req as any),
      );
      const cList = await withTestTenant(async () => ctl.listCampaigns(req as any));
      expect(cList.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getCampaign(c.id, req as any));
      expect(got.id).toBe(c.id);

      const patched = await withTestTenant(async () =>
        ctl.patchCampaign(c.id, { description: 'updated' } as any, req as any),
      );
      expect(patched.description).toBe('updated');

      const activated = await withTestTenant(async () => ctl.activateCampaign(c.id, req as any));
      expect(activated.status).toBe('ACTIVE');

      const r = await withTestTenant(async () => ctl.getCampaignRaised(c.id, req as any));
      expect(r.raisedAmount).toBe(0);

      const added = await withTestTenant(async () =>
        ctl.addRecipientsByTag(c.id, { tag: 'MENTOR' } as any, req as any),
      );
      expect(added.created).toBe(1);

      const recList = await withTestTenant(async () => ctl.listRecipients(c.id, req as any));
      expect(recList.length).toBe(1);
      const sent = await withTestTenant(async () => ctl.sendOutreach(c.id, req as any));
      expect(sent.sent).toBe(1);

      const funnel = await withTestTenant(async () => ctl.getCampaignFunnel(c.id, req as any));
      expect(funnel.sent).toBe(1);

      const upd = await withTestTenant(async () =>
        ctl.updateRecipientStatus(recList[0]!.id, { status: 'OPENED' as any } as any, req as any),
      );
      expect(upd.outreachStatus).toBe('OPENED');
    });

    it('donate + listDonations', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId);
      const p = await withTestTenant(async () =>
        ctl.createProfile({ personId, graduationYear: 2020 } as any, req as any),
      );
      const c = await withTestTenant(async () =>
        ctl.createCampaign({ title: 'Drive' } as any, req as any),
      );
      await withTestTenant(async () => ctl.activateCampaign(c.id, req as any));
      const d = await withTestTenant(async () =>
        ctl.donate(
          c.id,
          { donorAlumniId: p.id, amount: 100, currency: 'USD' } as any,
          req as any,
        ),
      );
      expect(d.amount).toBe(100);

      const list = await withTestTenant(async () => ctl.listDonations(c.id, req as any));
      expect(list.length).toBe(1);
    });
  });

  describe('news + reunions + events handlers', () => {
    it('createNews + listNews + getNews + patchNews + deleteNews', async () => {
      const created = await withTestTenant(async () =>
        ctl.createNews(
          { title: 'T', body: 'B', category: 'GENERAL' as any, publish: true } as any,
          req as any,
        ),
      );
      const list = await withTestTenant(async () => ctl.listNews(req as any));
      expect(list.length).toBe(1);
      const filteredList = await withTestTenant(async () =>
        ctl.listNews(req as any, 'GENERAL' as any, 'true'),
      );
      expect(filteredList.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getNews(created.id, req as any));
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        ctl.patchNews(created.id, { title: 'TT' } as any, req as any),
      );
      expect(patched.title).toBe('TT');
      await withTestTenant(async () => ctl.deleteNews(created.id, req as any));
    });

    it('createReunion + listReunions + getReunion + patchReunion', async () => {
      const personId = generateId();
      seededPersonIds.push(personId);
      await ensureIamPerson(rawClient, personId);
      const p = await withTestTenant(async () =>
        ctl.createProfile({ personId, graduationYear: 2010 } as any, req as any),
      );
      const r = await withTestTenant(async () =>
        ctl.createReunion(
          { graduationYear: 2010, name: 'Class of 2010', organiserId: p.id } as any,
          req as any,
        ),
      );
      const list = await withTestTenant(async () => ctl.listReunions(req as any, '2010', undefined));
      expect(list.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getReunion(r.id, req as any));
      expect(got.id).toBe(r.id);
      const patched = await withTestTenant(async () =>
        ctl.patchReunion(r.id, { name: 'Renamed' } as any, req as any),
      );
      expect(patched.name).toBe('Renamed');
    });

    it('createEvent + listEvents + getEvent + patchEvent + deleteEvent', async () => {
      const created = await withTestTenant(async () =>
        ctl.createEvent(
          { title: 'Homecoming', eventDate: dateFuture(60) } as any,
          req as any,
        ),
      );
      const list = await withTestTenant(async () => ctl.listEvents(req as any));
      expect(list.length).toBe(1);
      const filteredList = await withTestTenant(async () =>
        ctl.listEvents(req as any, dateFuture(0), dateFuture(90)),
      );
      expect(filteredList.length).toBe(1);
      const got = await withTestTenant(async () => ctl.getEvent(created.id, req as any));
      expect(got.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        ctl.patchEvent(created.id, { title: 'X' } as any, req as any),
      );
      expect(patched.title).toBe('X');
      await withTestTenant(async () => ctl.deleteEvent(created.id, req as any));
    });
  });
});
