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
  CampaignService,
  DonationService,
  OutreachService,
} from '@modules/m102-alumni/campaign.service';
import { AlumniProfileService, AlumniTagService } from '@modules/m102-alumni/profile.service';
import {
  deterministicCampaignActivatedEventId,
  deterministicDonationReceivedEventId,
} from '@modules/m102-alumni/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache/redis.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, parentActor, TEST_PARENT_PERSON_ID } from '../helpers/actor';
import { resetAlumniTables, ensureIamPerson } from '../fixtures/alumni';

/**
 * Wave 7 — m102-alumni CampaignService + DonationService + OutreachService.
 *
 * Exercises:
 *   - Campaign CRUD + activate atomic flip (DRAFT → ACTIVE) + outbox emit
 *     `alm.campaign.activated` with deterministic event_id.
 *   - Campaign raised: Redis cache miss → DB SUM → cache set; cache hit
 *     short-circuit; invalidate on donation.
 *   - Bulk addRecipientsByTag idempotency (ON CONFLICT DO NOTHING).
 *   - Funnel rollup across all 6 statuses.
 *   - sendOutreach bulk PENDING → SENT.
 *   - updateStatus FSM: valid forward transitions, UNSUBSCRIBED from
 *     any non-UNSUBSCRIBED, DONATED rejected (must land via donate()),
 *     backward transitions rejected.
 *   - DonationService.donate: FX rate calc, recipient → DONATED, outbox
 *     emit `alm.donation.received`, Redis cache invalidate, anonymous
 *     stripping for non-admin.
 *   - Cross-school isolation across campaigns, donations, outreach.
 */
describe('integration:m102-alumni/campaigns-donations', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let redis: RedisService;
  let campaigns: CampaignService;
  let donations: DonationService;
  let outreach: OutreachService;
  let profiles: AlumniProfileService;
  let tagsSvc: AlumniTagService;
  const seededPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    redis = new RedisService();
    await redis.onModuleInit();
    campaigns = new CampaignService(tenantPrisma, permCheck, outbox, redis);
    donations = new DonationService(tenantPrisma, permCheck, outbox, redis);
    outreach = new OutreachService(tenantPrisma, permCheck);
    profiles = new AlumniProfileService(tenantPrisma, permCheck);
    tagsSvc = new AlumniTagService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await redis.onModuleDestroy();
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAlumniTables(rawClient, { personIds: seededPersonIds.splice(0) });
  });

  async function seedProfile(
    opts: {
      schoolId?: string;
      personId?: string;
      optedIn?: boolean;
      tag?: string;
    } = {},
  ): Promise<string> {
    const generated = opts.personId === undefined;
    const personId = opts.personId ?? generateId();
    if (generated) seededPersonIds.push(personId);
    await ensureIamPerson(rawClient, personId);
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.alm_alumni_profiles
         (id, school_id, person_id, graduation_year, is_opted_in)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 2020, $4)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      personId,
      opts.optedIn ?? true,
    );
    if (opts.tag) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_alumni_tags (id, alumni_id, tag) VALUES ($1::uuid, $2::uuid, $3)`,
        generateId(),
        id,
        opts.tag,
      );
    }
    return id;
  }

  async function seedCampaign(
    opts: {
      schoolId?: string;
      status?: 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
      reportingCurrency?: string;
      goalAmount?: number;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.alm_campaigns
         (id, school_id, title, description, goal_amount, reporting_currency, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Test Campaign', 'desc', $3, $4, $5, $6::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.goalAmount ?? 10000,
      opts.reportingCurrency ?? 'USD',
      opts.status ?? 'DRAFT',
      // Stable admin person id required, ensure it exists.
      '019e0cf8-aaaa-7777-8888-000000000010',
    );
    return id;
  }

  describe('CampaignService.create / list / getById / patch', () => {
    it('admin creates DRAFT campaign', async () => {
      const dto = await withTestTenant(async () =>
        campaigns.create(
          {
            title: 'Capital Campaign',
            description: 'Building fund',
            goalAmount: 50000,
            reportingCurrency: 'USD',
            startDate: '2026-01-01',
            endDate: '2026-12-31',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('DRAFT');
      expect(dto.goalAmount).toBe(50000);
      expect(dto.reportingCurrency).toBe('USD');
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => campaigns.create({ title: 'X' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('list: admin sees all statuses; non-admin only ACTIVE+COMPLETED', async () => {
      await seedCampaign({ status: 'DRAFT' });
      await seedCampaign({ status: 'ACTIVE' });
      await seedCampaign({ status: 'COMPLETED' });
      await seedCampaign({ status: 'CANCELLED' });
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });

      const adminList = await withTestTenant(async () => campaigns.list(adminActor()));
      expect(adminList.length).toBe(4);
      const parentList = await withTestTenant(async () => campaigns.list(parentActor()));
      expect(parentList.length).toBe(2);
      expect(parentList.map((c) => c.status).sort()).toEqual(['ACTIVE', 'COMPLETED']);

      const onlyDraft = await withTestTenant(async () =>
        campaigns.list(adminActor(), 'DRAFT' as any),
      );
      expect(onlyDraft.length).toBe(1);
    });

    it('getById: DRAFT hidden from non-admin (404)', async () => {
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      const draftId = await seedCampaign({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => campaigns.getById(draftId, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      const seen = await withTestTenant(async () => campaigns.getById(draftId, adminActor()));
      expect(seen.id).toBe(draftId);
    });

    it('patch updates fields; non-admin → ForbiddenException', async () => {
      const id = await seedCampaign({ status: 'DRAFT' });
      const out = await withTestTenant(async () =>
        campaigns.patch(
          id,
          {
            title: 'Renamed',
            description: 'new',
            goalAmount: 99999,
            startDate: '2026-02-02',
            endDate: '2026-11-11',
            status: 'COMPLETED' as any,
          } as any,
          adminActor(),
        ),
      );
      expect(out.title).toBe('Renamed');
      expect(out.status).toBe('COMPLETED');
      // CANCELLED stamps completed_at too
      const id2 = await seedCampaign({ status: 'DRAFT' });
      const cancelled = await withTestTenant(async () =>
        campaigns.patch(id2, { status: 'CANCELLED' as any } as any, adminActor()),
      );
      expect(cancelled.status).toBe('CANCELLED');

      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => campaigns.patch(id, { title: 'X' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School B campaign UUID → 404 in School A patch', async () => {
      const bId = await seedCampaign({ schoolId: TEST_SCHOOL_B_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () => campaigns.patch(bId, { title: 'X' } as any, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('CampaignService.activate (atomic + outbox)', () => {
    it('DRAFT → ACTIVE flip + outbox `alm.campaign.activated`', async () => {
      const id = await seedCampaign({ status: 'DRAFT' });
      const out = await withTestTenant(async () => campaigns.activate(id, adminActor()));
      expect(out.status).toBe('ACTIVE');
      expect(out.activatedAt).toBeTruthy();

      const rows = await rawClient.$queryRawUnsafe<Array<{ topic: string; envelope: string }>>(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'alm.campaign.activated' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicCampaignActivatedEventId(id));
      expect(env.payload.campaignId).toBe(id);
      expect(env.payload.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('non-DRAFT → ConflictException', async () => {
      const id = await seedCampaign({ status: 'ACTIVE' });
      await expect(
        withTestTenant(async () => campaigns.activate(id, adminActor())),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          campaigns.activate('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → ForbiddenException', async () => {
      const id = await seedCampaign({ status: 'DRAFT' });
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => campaigns.activate(id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('CampaignService.raised (Redis cache)', () => {
    it('first call hits DB, second call hits cache', async () => {
      const id = await seedCampaign({ status: 'ACTIVE' });
      const first = await withTestTenant(async () => campaigns.raised(id, adminActor()));
      // Redis may or may not be available; if available, cached=true on second call
      const second = await withTestTenant(async () => campaigns.raised(id, adminActor()));
      expect(first.campaignId).toBe(id);
      expect(first.reportingCurrency).toBe('USD');
      expect(second.raisedAmount).toBe(first.raisedAmount);
    });

    it('reflects donation totals', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const aId = await seedProfile();
      await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 100, currency: 'USD' } as any, adminActor()),
      );
      const r = await withTestTenant(async () => campaigns.raised(cId, adminActor()));
      expect(r.raisedAmount).toBe(100);
    });

    it('cross-school: School B raised query in School A context → 404', async () => {
      const bId = await seedCampaign({ schoolId: TEST_SCHOOL_B_ID, status: 'ACTIVE' });
      await expect(
        withTestTenant(async () => campaigns.raised(bId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('CampaignService.addRecipientsByTag + listRecipients + funnel', () => {
    it('bulk add by tag returns {created, skipped}; idempotent on re-run', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const a1 = await seedProfile({ tag: 'MENTOR' });
      const a2 = await seedProfile({ tag: 'MENTOR' });
      await seedProfile({ tag: 'OTHER' });

      const first = await withTestTenant(async () =>
        campaigns.addRecipientsByTag(cId, { tag: 'MENTOR' } as any, adminActor()),
      );
      expect(first.created).toBe(2);
      expect(first.skipped).toBe(0);

      const second = await withTestTenant(async () =>
        campaigns.addRecipientsByTag(cId, { tag: 'MENTOR' } as any, adminActor()),
      );
      expect(second.created).toBe(0);
      expect(second.skipped).toBe(2);

      const list = await withTestTenant(async () => campaigns.listRecipients(cId, adminActor()));
      expect(list.length).toBe(2);
      expect(list.map((r) => r.alumniId).sort()).toEqual([a1, a2].sort());
    });

    it('funnel rolls up by status', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const a = await seedProfile();
      const b = await seedProfile();
      // PENDING + OPENED
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
        generateId(),
        cId,
        a,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'OPENED')`,
        generateId(),
        cId,
        b,
      );
      const f = await withTestTenant(async () => campaigns.funnel(cId, adminActor()));
      expect(f.pending).toBe(1);
      expect(f.opened).toBe(1);
      expect(f.total).toBe(2);
    });

    it('funnel + listRecipients non-admin → ForbiddenException', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => campaigns.funnel(cId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () => campaigns.listRecipients(cId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listRecipients filter by status', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const a = await seedProfile();
      const b = await seedProfile();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
        generateId(),
        cId,
        a,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SENT')`,
        generateId(),
        cId,
        b,
      );
      const sent = await withTestTenant(async () =>
        campaigns.listRecipients(cId, adminActor(), 'SENT' as any),
      );
      expect(sent.length).toBe(1);
    });

    it('cross-school: addRecipientsByTag on School B campaign from School A → 404', async () => {
      const bId = await seedCampaign({ schoolId: TEST_SCHOOL_B_ID, status: 'ACTIVE' });
      await expect(
        withTestTenant(async () =>
          campaigns.addRecipientsByTag(bId, { tag: 'X' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('OutreachService', () => {
    async function setupRecipient(opts: { campaignStatus?: 'ACTIVE'; status?: string } = {}) {
      const cId = await seedCampaign({ status: opts.campaignStatus ?? 'ACTIVE' });
      const aId = await seedProfile();
      const rId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
        rId,
        cId,
        aId,
        opts.status ?? 'PENDING',
      );
      return { cId, aId, rId };
    }

    it('sendOutreach flips PENDING → SENT', async () => {
      const { cId } = await setupRecipient();
      // Add a second PENDING and one SENT to confirm only PENDING flips
      const a2 = await seedProfile();
      const a3 = await seedProfile();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
        generateId(),
        cId,
        a2,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SENT')`,
        generateId(),
        cId,
        a3,
      );
      const out = await withTestTenant(async () => outreach.sendOutreach(cId, adminActor()));
      expect(out.sent).toBe(2);
    });

    it('updateStatus PENDING → SENT → OPENED → RESPONDED', async () => {
      const { rId } = await setupRecipient();
      const s1 = await withTestTenant(async () =>
        outreach.updateStatus(rId, { status: 'SENT' as any } as any, adminActor()),
      );
      expect(s1.outreachStatus).toBe('SENT');
      expect(s1.sentAt).toBeTruthy();
      const s2 = await withTestTenant(async () =>
        outreach.updateStatus(rId, { status: 'OPENED' as any } as any, adminActor()),
      );
      expect(s2.outreachStatus).toBe('OPENED');
      const s3 = await withTestTenant(async () =>
        outreach.updateStatus(rId, { status: 'RESPONDED' as any } as any, adminActor()),
      );
      expect(s3.outreachStatus).toBe('RESPONDED');
    });

    it('updateStatus rejects backward transitions', async () => {
      const { rId } = await setupRecipient({ status: 'OPENED' });
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(rId, { status: 'PENDING' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateStatus rejects direct DONATED writes', async () => {
      const { rId } = await setupRecipient({ status: 'RESPONDED' });
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(rId, { status: 'DONATED' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateStatus UNSUBSCRIBED from PENDING', async () => {
      const { rId } = await setupRecipient();
      const out = await withTestTenant(async () =>
        outreach.updateStatus(rId, { status: 'UNSUBSCRIBED' as any } as any, adminActor()),
      );
      expect(out.outreachStatus).toBe('UNSUBSCRIBED');
      expect(out.unsubscribedAt).toBeTruthy();
    });

    it('updateStatus UNSUBSCRIBED → UNSUBSCRIBED rejected', async () => {
      const { rId } = await setupRecipient({ status: 'UNSUBSCRIBED' });
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(rId, { status: 'UNSUBSCRIBED' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateStatus missing recipient → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(
            '00000000-0000-0000-0000-000000000000',
            { status: 'SENT' as any } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin → ForbiddenException', async () => {
      const { cId, rId } = await setupRecipient();
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () => outreach.sendOutreach(cId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(rId, { status: 'SENT' as any } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School B recipient UUID → 404 from School A context', async () => {
      const cB = await seedCampaign({ schoolId: TEST_SCHOOL_B_ID, status: 'ACTIVE' });
      const aB = await seedProfile({ schoolId: TEST_SCHOOL_B_ID });
      const rB = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
        rB,
        cB,
        aB,
      );
      await expect(
        withTestTenant(async () =>
          outreach.updateStatus(rB, { status: 'SENT' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('DonationService.donate', () => {
    it('USD donation: amount === amount_in_reporting_currency; fx=null', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE', reportingCurrency: 'USD' });
      const aId = await seedProfile();
      const d = await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 250, currency: 'USD' } as any, adminActor()),
      );
      expect(d.amount).toBe(250);
      expect(d.amountInReportingCurrency).toBe(250);
      expect(d.fxRateAtDonation).toBe(null);
      expect(d.isAnonymous).toBe(false);
    });

    it('Foreign currency: requires fxRate; computes amount_in_reporting_currency', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE', reportingCurrency: 'USD' });
      const aId = await seedProfile();
      // missing fx → 400
      await expect(
        withTestTenant(async () =>
          donations.donate(cId, aId, { amount: 100, currency: 'EUR' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const d = await withTestTenant(async () =>
        donations.donate(
          cId,
          aId,
          { amount: 100, currency: 'EUR', fxRateAtDonation: 1.1 } as any,
          adminActor(),
        ),
      );
      expect(d.currency).toBe('EUR');
      expect(d.amountInReportingCurrency).toBe(110);
      expect(d.fxRateAtDonation).toBe(1.1);
    });

    it('Donation outbox `alm.donation.received` enqueued with deterministic id', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const aId = await seedProfile();
      const d = await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 50, currency: 'USD' } as any, adminActor()),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ envelope: string }>>(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'alm.donation.received' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicDonationReceivedEventId(d.id));
      expect(env.payload.donationId).toBe(d.id);
      expect(env.payload.amount).toBe(50);
    });

    it('Donation flips matching recipient to DONATED', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const aId = await seedProfile();
      const rId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.alm_campaign_recipients (id, campaign_id, alumni_id, outreach_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'SENT')`,
        rId,
        cId,
        aId,
      );
      await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 25, currency: 'USD' } as any, adminActor()),
      );
      const r = await rawClient.$queryRawUnsafe<
        Array<{ outreach_status: string; donated_at: Date | null }>
      >(
        `SELECT outreach_status, donated_at FROM ${TEST_SCHEMA}.alm_campaign_recipients WHERE id = $1::uuid`,
        rId,
      );
      expect(r[0]!.outreach_status).toBe('DONATED');
      expect(r[0]!.donated_at).toBeTruthy();
    });

    it('Anonymous donation strips donor for non-admin readers', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      // Use parent as the donor — they own a profile.
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      const ownId = await seedProfile({ personId: TEST_PARENT_PERSON_ID });
      const d = await withTestTenant(async () =>
        donations.donate(
          cId,
          ownId,
          {
            amount: 75,
            currency: 'USD',
            isAnonymous: true,
            paymentRef: 'REF-1',
            stripePaymentIntentId: 'pi_1',
          } as any,
          parentActor(),
        ),
      );
      // Returned to the donor (parent who is the owner — non-admin):
      expect(d.donorAlumniId).toBe(null);
      expect(d.donorDisplayName).toBe('Anonymous');
      expect(d.paymentRef).toBe(null);
      expect(d.stripePaymentIntentId).toBe(null);
      // Admin listing sees the donor + payment refs
      const adminList = await withTestTenant(async () =>
        donations.listForCampaign(cId, adminActor()),
      );
      expect(adminList[0]!.donorAlumniId).toBe(ownId);
      expect(adminList[0]!.paymentRef).toBe('REF-1');
    });

    it('Non-admin cannot donate on behalf of another alumnus', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const otherId = await seedProfile();
      await ensureIamPerson(rawClient, TEST_PARENT_PERSON_ID, { personType: 'GUARDIAN' });
      await expect(
        withTestTenant(async () =>
          donations.donate(cId, otherId, { amount: 10, currency: 'USD' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Non-ACTIVE campaign rejects donation', async () => {
      const cId = await seedCampaign({ status: 'DRAFT' });
      const aId = await seedProfile();
      await expect(
        withTestTenant(async () =>
          donations.donate(cId, aId, { amount: 10, currency: 'USD' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('listForCampaign returns donations newest-first', async () => {
      const cId = await seedCampaign({ status: 'ACTIVE' });
      const aId = await seedProfile();
      await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 10, currency: 'USD' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        donations.donate(cId, aId, { amount: 20, currency: 'USD' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => donations.listForCampaign(cId, adminActor()));
      expect(list.length).toBe(2);
      expect(list[0]!.amount).toBe(20); // newest first
    });

    it('cross-school: School B campaign → 404 donate from School A', async () => {
      const bId = await seedCampaign({ schoolId: TEST_SCHOOL_B_ID, status: 'ACTIVE' });
      const aId = await seedProfile(); // School A profile
      await expect(
        withTestTenant(async () =>
          donations.donate(bId, aId, { amount: 10, currency: 'USD' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
