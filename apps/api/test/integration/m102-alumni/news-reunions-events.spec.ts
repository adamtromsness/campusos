import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  AlumniEventService,
  AlumniNewsService,
  ReunionGroupService,
} from '@modules/m102-alumni/news.service';
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
  parentActor,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetAlumniTables, ensureIamPerson } from '../fixtures/alumni';

/**
 * Wave 7 — m102-alumni AlumniNewsService + ReunionGroupService + AlumniEventService.
 *
 * Exercises:
 *   - News lifecycle: create draft / create published / list filters
 *     (drafts hidden from non-admin) / patch publish toggle / remove
 *     with school predicate / 404 don't-leak-existence.
 *   - Reunion lifecycle: alumni create only own; staff create any;
 *     status transitions; CONFIRMED requires event_date.
 *   - AlumniEvent lifecycle: admin-only create/patch/remove; soft
 *     evt_event_id resolves to null when no matching evt_events row.
 *   - Cross-school isolation across all three sub-domains.
 */
describe('integration:m102-alumni/news-reunions-events', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let news: AlumniNewsService;
  let reunions: ReunionGroupService;
  let events: AlumniEventService;
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    news = new AlumniNewsService(tenantPrisma, permCheck);
    reunions = new ReunionGroupService(tenantPrisma, permCheck);
    events = new AlumniEventService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAlumniTables(rawClient, { personIds: seededPersonIds.splice(0) });
  });

  async function seedProfile(opts: { schoolId?: string; personId?: string } = {}): Promise<string> {
    const generated = opts.personId === undefined;
    const personId = opts.personId ?? generateId();
    if (generated) seededPersonIds.push(personId);
    await ensureIamPerson(rawClient, personId);
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.alm_alumni_profiles
         (id, school_id, person_id, graduation_year, is_opted_in)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 2018, true)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      personId,
    );
    return id;
  }

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  describe('AlumniNewsService', () => {
    it('admin creates draft + published news; list filters published only for non-admin', async () => {
      await withTestTenant(async () =>
        news.create(
          { title: 'Draft', body: 'wip', category: 'GENERAL' as any } as any,
          adminActor(),
        ),
      );
      const pub = await withTestTenant(async () =>
        news.create(
          {
            title: 'Pub',
            body: 'published',
            category: 'ACHIEVEMENT' as any,
            publish: true,
          } as any,
          adminActor(),
        ),
      );
      expect(pub.publishedAt).toBeTruthy();

      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      const parentList = await withTestTenant(async () => news.list(parentActor()));
      expect(parentList.length).toBe(1);
      expect(parentList[0]!.title).toBe('Pub');

      const adminList = await withTestTenant(async () =>
        news.list(adminActor(), { includeDrafts: true }),
      );
      expect(adminList.length).toBe(2);

      const filtered = await withTestTenant(async () =>
        news.list(adminActor(), { category: 'ACHIEVEMENT' as any, includeDrafts: true }),
      );
      expect(filtered.length).toBe(1);
    });

    it('non-admin cannot create / patch / remove → ForbiddenException', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () =>
          news.create({ title: 'X', body: 'Y', category: 'GENERAL' as any } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const pub = await withTestTenant(async () =>
        news.create(
          { title: 'P', body: 'B', category: 'GENERAL' as any, publish: true } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => news.patch(pub.id, { title: 'Renamed' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => news.remove(pub.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: draft hidden from non-admin → 404', async () => {
      const draft = await withTestTenant(async () =>
        news.create({ title: 'D', body: 'b', category: 'GENERAL' as any } as any, adminActor()),
      );
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => news.getById(draft.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      const seen = await withTestTenant(async () => news.getById(draft.id, adminActor()));
      expect(seen.id).toBe(draft.id);
    });

    it('patch toggles publish state', async () => {
      const draft = await withTestTenant(async () =>
        news.create({ title: 'D', body: 'b', category: 'GENERAL' as any } as any, adminActor()),
      );
      expect(draft.publishedAt).toBe(null);
      const published = await withTestTenant(async () =>
        news.patch(draft.id, { publish: true } as any, adminActor()),
      );
      expect(published.publishedAt).toBeTruthy();
      const back = await withTestTenant(async () =>
        news.patch(draft.id, { publish: false } as any, adminActor()),
      );
      expect(back.publishedAt).toBe(null);
    });

    it('patch with title/body/category fields', async () => {
      const draft = await withTestTenant(async () =>
        news.create({ title: 'A', body: 'A', category: 'GENERAL' as any } as any, adminActor()),
      );
      const out = await withTestTenant(async () =>
        news.patch(
          draft.id,
          { title: 'B', body: 'B body', category: 'EVENT' as any } as any,
          adminActor(),
        ),
      );
      expect(out.title).toBe('B');
      expect(out.body).toBe('B body');
      expect(out.category).toBe('EVENT');
    });

    it('remove succeeds; missing → 404', async () => {
      const draft = await withTestTenant(async () =>
        news.create({ title: 'A', body: 'A', category: 'GENERAL' as any } as any, adminActor()),
      );
      await withTestTenant(async () => news.remove(draft.id, adminActor()));
      await expect(
        withTestTenant(async () => news.getById(draft.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () =>
          news.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School B news → 404 from School A get/remove', async () => {
      const bNews = await withTestTenantB(async () =>
        news.create(
          { title: 'B', body: 'B', category: 'GENERAL' as any, publish: true } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => news.getById(bNews.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => news.remove(bNews.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ReunionGroupService', () => {
    it('admin creates reunion for any alumnus organiser', async () => {
      const aId = await seedProfile();
      const dto = await withTestTenant(async () =>
        reunions.create(
          {
            graduationYear: 2010,
            name: 'Class of 2010',
            organiserId: aId,
            description: 'Annual',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('PLANNING');
      expect(dto.organiserId).toBe(aId);
    });

    it('non-admin must be the organiser themselves', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      const ownId = await seedProfile({ personId: TEST_PARENT_PERSON_ID });
      const otherId = await seedProfile();
      const dto = await withTestTenant(async () =>
        reunions.create(
          { graduationYear: 2010, name: 'Mine', organiserId: ownId } as any,
          parentActor(),
        ),
      );
      expect(dto.organiserId).toBe(ownId);

      await expect(
        withTestTenant(async () =>
          reunions.create(
            { graduationYear: 2011, name: 'Not Mine', organiserId: otherId } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by graduationYear / status', async () => {
      const a = await seedProfile();
      await withTestTenant(async () =>
        reunions.create({ graduationYear: 2010, name: 'A', organiserId: a } as any, adminActor()),
      );
      await withTestTenant(async () =>
        reunions.create({ graduationYear: 2011, name: 'B', organiserId: a } as any, adminActor()),
      );
      const byYear = await withTestTenant(async () =>
        reunions.list(adminActor(), { graduationYear: 2010 }),
      );
      expect(byYear.length).toBe(1);
      const byStatus = await withTestTenant(async () =>
        reunions.list(adminActor(), { status: 'PLANNING' as any }),
      );
      expect(byStatus.length).toBe(2);
    });

    it('patch: CONFIRMED requires event_date', async () => {
      const a = await seedProfile();
      const r = await withTestTenant(async () =>
        reunions.create({ graduationYear: 2010, name: 'A', organiserId: a } as any, adminActor()),
      );
      // Without event_date → 400
      await expect(
        withTestTenant(async () =>
          reunions.patch(r.id, { status: 'CONFIRMED' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Set event_date inline + status confirmed → ok
      const out = await withTestTenant(async () =>
        reunions.patch(
          r.id,
          { status: 'CONFIRMED' as any, eventDate: dateFuture(60) } as any,
          adminActor(),
        ),
      );
      expect(out.status).toBe('CONFIRMED');
      expect(out.eventDate).toBeTruthy();
    });

    it('patch: non-organiser non-admin → ForbiddenException', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      // parent owns nothing
      const otherAlumni = await seedProfile();
      const r = await withTestTenant(async () =>
        reunions.create(
          { graduationYear: 2010, name: 'A', organiserId: otherAlumni } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => reunions.patch(r.id, { name: 'X' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: organiser can update own reunion + venue/description', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      const ownId = await seedProfile({ personId: TEST_PARENT_PERSON_ID });
      const r = await withTestTenant(async () =>
        reunions.create(
          { graduationYear: 2010, name: 'Mine', organiserId: ownId } as any,
          parentActor(),
        ),
      );
      const out = await withTestTenant(async () =>
        reunions.patch(
          r.id,
          {
            name: 'Renamed',
            venue: 'Main Hall',
            description: 'Updated',
            rsvpDeadline: dateFuture(30),
          } as any,
          parentActor(),
        ),
      );
      expect(out.name).toBe('Renamed');
      expect(out.venue).toBe('Main Hall');
      expect(out.rsvpDeadline).toBeTruthy();
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          reunions.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School B reunion → 404 from School A', async () => {
      const aB = await seedProfile({ schoolId: TEST_SCHOOL_B_ID });
      const rB = await withTestTenantB(async () =>
        reunions.create({ graduationYear: 2010, name: 'B', organiserId: aB } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => reunions.getById(rB.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('AlumniEventService', () => {
    it('admin creates + list + getById + patch + remove', async () => {
      const created = await withTestTenant(async () =>
        events.create(
          {
            title: 'Homecoming',
            description: 'Big game',
            eventDate: dateFuture(45),
            venue: 'Stadium',
            rsvpUrl: 'https://example.com/rsvp',
          } as any,
          adminActor(),
        ),
      );
      expect(created.title).toBe('Homecoming');
      expect(created.ticketsAvailable).toBe(null);

      const list = await withTestTenant(async () => events.list(adminActor()));
      expect(list.length).toBe(1);

      const got = await withTestTenant(async () => events.getById(created.id, adminActor()));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(async () =>
        events.patch(
          created.id,
          {
            title: 'Renamed',
            description: 'New desc',
            eventDate: dateFuture(60),
            venue: 'New Hall',
            rsvpUrl: 'https://example.com/new',
            evtEventId: generateId(),
          } as any,
          adminActor(),
        ),
      );
      expect(patched.title).toBe('Renamed');

      await withTestTenant(async () => events.remove(created.id, adminActor()));
      await expect(
        withTestTenant(async () => events.getById(created.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → ForbiddenException for create/patch/remove', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () =>
          events.create({ title: 'X', eventDate: dateFuture(30) } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const ev = await withTestTenant(async () =>
        events.create({ title: 'E', eventDate: dateFuture(30) } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => events.patch(ev.id, { title: 'Z' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => events.remove(ev.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list filters by fromDate / toDate', async () => {
      await withTestTenant(async () =>
        events.create({ title: 'Near', eventDate: dateFuture(5) } as any, adminActor()),
      );
      await withTestTenant(async () =>
        events.create({ title: 'Far', eventDate: dateFuture(60) } as any, adminActor()),
      );
      const near = await withTestTenant(async () =>
        events.list(adminActor(), { fromDate: dateFuture(0), toDate: dateFuture(10) }),
      );
      expect(near.length).toBe(1);
      expect(near[0]!.title).toBe('Near');
    });

    it('remove missing → 404', async () => {
      await expect(
        withTestTenant(async () =>
          events.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('soft evt_event_id resolves to null when no matching evt_events row', async () => {
      const fakeEvtId = generateId();
      const created = await withTestTenant(async () =>
        events.create(
          {
            title: 'Linked',
            eventDate: dateFuture(30),
            evtEventId: fakeEvtId,
            rsvpUrl: 'https://rsvp',
          } as any,
          adminActor(),
        ),
      );
      // evt_events row missing → graceful fallback → null
      const got = await withTestTenant(async () => events.getById(created.id, adminActor()));
      expect(got.evtEventId).toBe(fakeEvtId);
      expect(got.ticketsAvailable).toBe(null);
    });

    it('evt_event_id resolves to remaining capacity when evt_events row exists', async () => {
      // Seed evt_events + a ticket tier in current school
      const evtId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_events
           (id, school_id, title, event_type, event_date, start_time, status, created_by)
         VALUES ($1::uuid, $2::uuid, 'Linked Event', 'PERFORMANCE', $3::date, '19:00', 'ON_SALE', $4::uuid)`,
        evtId,
        TEST_SCHOOL_ID,
        dateFuture(20),
        TEST_ADMIN_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_ticket_tiers
           (id, event_id, name, price, quantity, quantity_sold, is_active)
         VALUES ($1::uuid, $2::uuid, 'GA', 10, 100, 25, true)`,
        generateId(),
        evtId,
      );
      const created = await withTestTenant(async () =>
        events.create(
          { title: 'L', eventDate: dateFuture(20), evtEventId: evtId } as any,
          adminActor(),
        ),
      );
      const got = await withTestTenant(async () => events.getById(created.id, adminActor()));
      expect(got.ticketsAvailable).toBe(75); // 100 - 25

      // Cleanup the evt_events rows so the next spec's reset works cleanly
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE event_id = $1::uuid`,
        evtId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_events WHERE id = $1::uuid`,
        evtId,
      );
    });

    it('cross-school: School B alumni event → 404 from School A', async () => {
      const bEv = await withTestTenantB(async () =>
        events.create({ title: 'B', eventDate: dateFuture(40) } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => events.getById(bEv.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => events.patch(bEv.id, { title: 'X' } as any, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        withTestTenant(async () => events.remove(bEv.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
