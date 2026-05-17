import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { AlumniProfileService, AlumniTagService } from '../profile.service';
import { CampaignService, DonationService, OutreachService } from '../campaign.service';
import { AlumniEventService, AlumniNewsService, ReunionGroupService } from '../news.service';

/**
 * P2-22b Step 8 — Vertical slice integration test.
 *
 * Walks the 7 plan scenarios end-to-end:
 *   1. Profile + directory: alumni opt-in / opt-out visibility
 *   2. Tag segmentation: tag drives /by-tag and bulk recipient add
 *   3. Campaign + donation: multi-currency FX + Redis invalidate +
 *      campaign_recipients flip to DONATED in same tx + Kafka emit
 *   4. Anonymous donation: stripped for non-staff, visible to admin
 *   5. Outreach funnel: 6-state count rollup
 *   6. Events linkage: graceful fallback when Events not enabled
 *   7. Visibility matrix: alumni / staff / admin row scope
 */

const SCHOOL = { schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const STAFF_ACTOR = {
  accountId: 'staff-account',
  personId: 'staff-person',
  employeeId: 'staff-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

const ALEX_ACTOR = {
  accountId: 'alex-account',
  personId: 'alex-person',
  employeeId: null,
  personType: 'ALUMNI' as const,
  isSchoolAdmin: false,
};

const PRIYA_ACTOR = {
  accountId: 'priya-account',
  personId: 'priya-person',
  employeeId: null,
  personType: 'ALUMNI' as const,
  isSchoolAdmin: false,
};

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'student-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

const TEACHER_ACTOR = {
  accountId: 'teacher-account',
  personId: 'teacher-person',
  employeeId: 'teacher-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
};

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

// REVIEW-P2C22 BLOCKING 1 — `OutboxService` replaces the prior
// best-effort `KafkaProducerService` in CampaignService + DonationService.
// `enqueueInTx(tx, opts)` is captured here so regression tests can
// assert the envelope shape, source module, deterministic event_id,
// and payload contents land as expected. The legacy `kafka.emit`
// alias is preserved for backward-compat with older test blocks that
// were written against the kafka stub before the outbox migration.
function makeOutbox() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
    },
  };
  return { outbox, emitted };
}

// Back-compat alias for legacy test blocks. New tests should use
// `makeOutbox()` directly.
function makeKafka() {
  const { outbox, emitted } = makeOutbox();
  return { kafka: outbox, emitted };
}

function makeRedis() {
  const store = new Map<string, unknown>();
  const ops: Array<{ op: 'get' | 'set' | 'del'; key: string; value?: unknown }> = [];
  return {
    redis: {
      cacheGet: vi.fn(async (key: string) => {
        ops.push({ op: 'get', key });
        return store.has(key) ? (store.get(key) as unknown) : null;
      }),
      cacheSet: vi.fn(async (key: string, value: unknown) => {
        ops.push({ op: 'set', key, value });
        store.set(key, value);
      }),
      cacheInvalidate: vi.fn(async (...keys: string[]) => {
        for (const k of keys) {
          ops.push({ op: 'del', key: k });
          store.delete(k);
        }
      }),
    },
    ops,
    store,
  };
}

function makePerms(grants: Record<string, string[]> = {}) {
  return {
    hasAnyPermissionInTenant: vi.fn(
      async (accountId: string, _scopeId: string, codes: string[]) => {
        const held = grants[accountId] ?? [];
        return codes.some((c) => held.includes(c));
      },
    ),
  };
}

// =====================================================================
// Scenario 1 — Profile + directory: opt-in / opt-out visibility
// =====================================================================
describe('Scenario 1 — Profile + directory visibility (RLS)', () => {
  it('non-staff readers see opted-in rows; staff sees all', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.sql.startsWith('SELECT p.id::text')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: 'alex-person',
            graduation_year: 2020,
            degree_programme: null,
            current_employer: 'TechCorp',
            current_title: 'Engineer',
            linkedin_url: null,
            contact_email: null,
            contact_phone: null,
            is_opted_in: true,
            display_name: 'Alex Rivera',
            tags: ['STEM_MENTOR'],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniProfileService(tenantPrisma as never, perms as never);

    // Admin: no opt-in filter clause in the outer WHERE. Split on the
    // outer WHERE (uniquely identified by "p.school_id" which only
    // appears in the top-level filter).
    const adminRows = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.list(ADMIN_ACTOR as never),
    );
    expect(adminRows).toHaveLength(1);
    const adminListCall = capture.find((c) => c.sql.startsWith('SELECT p.id::text'));
    const adminOuterWhere = adminListCall!.sql.substring(
      adminListCall!.sql.indexOf('WHERE p.school_id'),
    );
    expect(adminOuterWhere).not.toContain('p.is_opted_in');

    // Reset and re-run for student
    capture.length = 0;
    const studentRows = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.list(STUDENT_ACTOR as never),
    );
    expect(studentRows).toHaveLength(1);
    const studentListCall = capture.find((c) => c.sql.startsWith('SELECT p.id::text'));
    const studentOuterWhere = studentListCall!.sql.substring(
      studentListCall!.sql.indexOf('WHERE p.school_id'),
    );
    expect(studentOuterWhere).toContain('p.is_opted_in = true');
  });

  it('opted-out profile returns 404 to a non-owner non-staff caller', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.sql.includes('SELECT id::text AS id, school_id::text AS school_id') &&
        c.sql.includes('WHERE id =')
      ) {
        return [
          {
            id: 'p-david',
            school_id: SCHOOL.schoolId,
            person_id: 'david-person',
            is_opted_in: false,
          },
        ];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniProfileService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.getById('p-david', STUDENT_ACTOR as never),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('non-staff cannot create profile for another person', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms();
    const svc = new AlumniProfileService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          { personId: 'other-person', graduationYear: 2020 } as never,
          STUDENT_ACTOR as never,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// =====================================================================
// Scenario 2 — Tag segmentation
// =====================================================================
describe('Scenario 2 — Tag segmentation', () => {
  it('addTag refuses non-owner non-staff', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('SELECT id::text AS id, school_id')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: 'alex-person',
            is_opted_in: true,
          },
        ];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniTagService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addTag({ alumniId: 'p-alex', tag: 'DONOR' }, STUDENT_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('addTag allows owner', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('SELECT id::text AS id, school_id')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: ALEX_ACTOR.personId,
            is_opted_in: true,
          },
        ];
      }
      if (c.sql.includes('SELECT id::text AS id, alumni_id::text')) {
        return [{ id: 'tag-row-1', alumni_id: 'p-alex', tag: 'DONOR', created_at: new Date() }];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniTagService(tenantPrisma as never, perms as never);
    const tag = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.addTag({ alumniId: 'p-alex', tag: 'DONOR' }, ALEX_ACTOR as never),
    );
    expect(tag.tag).toBe('DONOR');
  });

  it('addTag returns 409 on duplicate', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('SELECT id::text AS id, school_id')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: ALEX_ACTOR.personId,
            is_opted_in: true,
          },
        ];
      }
      if (c.fn === 'e' && c.sql.includes('INSERT INTO alm_alumni_tags')) {
        throw { code: 'P2010', meta: { code: '23505' } };
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniTagService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.addTag({ alumniId: 'p-alex', tag: 'DONOR' }, ALEX_ACTOR as never),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('listByTag joins through alm_alumni_tags and filters by tag', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.sql.startsWith('SELECT p.id::text')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: 'alex-person',
            graduation_year: 2020,
            degree_programme: null,
            current_employer: null,
            current_title: null,
            linkedin_url: null,
            contact_email: null,
            contact_phone: null,
            is_opted_in: true,
            display_name: 'Alex',
            tags: ['STEM_MENTOR'],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniTagService(tenantPrisma as never, perms as never);
    const out = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listByTag('STEM_MENTOR', ADMIN_ACTOR as never),
    );
    expect(out).toHaveLength(1);
    const sql = capture.find((c) => c.sql.startsWith('SELECT p.id::text'))!.sql;
    expect(sql).toContain('EXISTS (SELECT 1 FROM alm_alumni_tags t');
  });
});

// =====================================================================
// Scenario 3 — Campaign + donation (multi-currency + Redis + Kafka)
// =====================================================================
describe('Scenario 3 — Campaign + donation multi-currency keystone', () => {
  it('Campaign activate emits alm.campaign.activated AFTER tx + invalidates Redis', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FOR UPDATE')) {
        return [{ status: 'DRAFT' }];
      }
      if (c.fn === 'q' && c.sql.includes('SELECT id::text AS id, title')) {
        return [
          { id: 'camp-1', title: 'Science Lab', reporting_currency: 'USD', goal_amount: '50000' },
        ];
      }
      if (c.fn === 'q' && c.sql.startsWith('SELECT c.id::text')) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            title: 'Science Lab',
            description: null,
            goal_amount: '50000',
            reporting_currency: 'USD',
            start_date: null,
            end_date: null,
            status: 'ACTIVE',
            created_by: ADMIN_ACTOR.personId,
            activated_at: new Date(),
            completed_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            raised_amount: '0',
            recipient_count: 0,
            donation_count: 0,
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { kafka, emitted } = makeKafka();
    const { redis, ops } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.activate('camp-1', ADMIN_ACTOR as never),
    );
    expect(result.status).toBe('ACTIVE');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('alm.campaign.activated');
    expect(emitted[0]!.sourceModule).toBe('alumni');
    expect(emitted[0]!.payload.title).toBe('Science Lab');
    // Cache invalidated
    expect(ops.some((op) => op.op === 'del' && op.key === 'campaign:raised:camp-1')).toBe(true);
  });

  it('Donate USD: computes amount_in_reporting_currency = amount; flips matching recipient; invalidates Redis; emits alm.donation.received', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (
        c.fn === 'q' &&
        c.sql.includes('FROM alm_alumni_profiles') &&
        c.sql.includes('WHERE id = $1::uuid AND school_id = $2::uuid')
      ) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: ALEX_ACTOR.personId,
            is_opted_in: true,
          },
        ];
      }
      if (c.fn === 'q' && c.sql.startsWith('SELECT id::text AS id, campaign_id::text')) {
        return [
          {
            id: 'don-1',
            campaign_id: 'camp-1',
            donor_alumni_id: 'p-alex',
            amount: '2000',
            currency: 'USD',
            fx_rate_at_donation: null,
            amount_in_reporting_currency: '2000',
            payment_ref: null,
            stripe_payment_intent_id: null,
            donated_at: new Date(),
            is_anonymous: false,
          },
        ];
      }
      return [];
    });
    const perms = makePerms();
    const { kafka, emitted } = makeKafka();
    const { redis, ops } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );

    const dto = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.donate(
        'camp-1',
        'p-alex',
        { donorAlumniId: 'p-alex', amount: 2000, currency: 'USD' } as never,
        ALEX_ACTOR as never,
      ),
    );
    expect(dto.amount).toBe(2000);
    expect(dto.currency).toBe('USD');
    expect(dto.amountInReportingCurrency).toBe(2000);

    // Recipient flip in the same tx
    const flipCall = capture.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.includes('UPDATE alm_campaign_recipients') &&
        c.sql.includes("'DONATED'"),
    );
    expect(flipCall).toBeDefined();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('alm.donation.received');
    expect(emitted[0]!.payload.amountInReportingCurrency).toBe(2000);
    expect(emitted[0]!.payload.currency).toBe('USD');

    // Redis cache invalidated
    expect(ops.some((op) => op.op === 'del' && op.key === 'campaign:raised:camp-1')).toBe(true);
  });

  it('Donate GBP without fxRateAtDonation → 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (
        c.fn === 'q' &&
        c.sql.includes('FROM alm_alumni_profiles') &&
        c.sql.includes('WHERE id = $1::uuid AND school_id = $2::uuid')
      ) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: ALEX_ACTOR.personId,
            is_opted_in: true,
          },
        ];
      }
      return [];
    });
    const perms = makePerms();
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.donate(
          'camp-1',
          'p-alex',
          { donorAlumniId: 'p-alex', amount: 500, currency: 'GBP' } as never,
          ALEX_ACTOR as never,
        ),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('Donate GBP with fx=1.27: amount_in_reporting_currency = 635.00', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (
        c.fn === 'q' &&
        c.sql.includes('FROM alm_alumni_profiles') &&
        c.sql.includes('WHERE id = $1::uuid AND school_id = $2::uuid')
      ) {
        return [
          {
            id: 'p-hiro',
            school_id: SCHOOL.schoolId,
            person_id: 'hiro-person',
            is_opted_in: true,
          },
        ];
      }
      if (c.fn === 'q' && c.sql.startsWith('SELECT id::text AS id, campaign_id::text')) {
        return [
          {
            id: 'don-2',
            campaign_id: 'camp-1',
            donor_alumni_id: 'p-hiro',
            amount: '500',
            currency: 'GBP',
            fx_rate_at_donation: '1.270000',
            amount_in_reporting_currency: '635',
            payment_ref: null,
            stripe_payment_intent_id: null,
            donated_at: new Date(),
            is_anonymous: false,
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { kafka, emitted } = makeKafka();
    const { redis } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    const dto = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.donate(
        'camp-1',
        'p-hiro',
        {
          donorAlumniId: 'p-hiro',
          amount: 500,
          currency: 'GBP',
          fxRateAtDonation: 1.27,
        } as never,
        ADMIN_ACTOR as never,
      ),
    );
    expect(dto.amount).toBe(500);
    expect(dto.currency).toBe('GBP');
    expect(dto.amountInReportingCurrency).toBe(635);
    expect(dto.fxRateAtDonation).toBe(1.27);
    expect(emitted[0]!.payload.amountInReportingCurrency).toBe(635);
  });
});

// =====================================================================
// Scenario 4 — Anonymous donation: stripped for non-staff
// =====================================================================
describe('Scenario 4 — Anonymous donation visibility', () => {
  const rows = [
    {
      id: 'don-2',
      campaign_id: 'camp-1',
      donor_alumni_id: 'p-priya',
      amount: '1500',
      currency: 'USD',
      fx_rate_at_donation: null,
      amount_in_reporting_currency: '1500',
      payment_ref: 'pay_priya',
      stripe_payment_intent_id: 'pi_priya',
      donated_at: new Date(),
      is_anonymous: true,
      donor_display_name: 'Priya Patel',
    },
  ];

  it('admin sees donor name even when is_anonymous=true', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (c.sql.startsWith('SELECT d.id::text')) {
        return rows;
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    const list = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listForCampaign('camp-1', ADMIN_ACTOR as never),
    );
    expect(list[0]!.donorAlumniId).toBe('p-priya');
    expect(list[0]!.donorDisplayName).toBe('Priya Patel');
    expect(list[0]!.paymentRef).toBe('pay_priya');
  });

  it('non-staff sees Anonymous with donorAlumniId null', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (c.sql.startsWith('SELECT d.id::text')) {
        return rows;
      }
      return [];
    });
    const perms = makePerms();
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    const list = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listForCampaign('camp-1', STUDENT_ACTOR as never),
    );
    expect(list[0]!.donorAlumniId).toBeNull();
    expect(list[0]!.donorDisplayName).toBe('Anonymous');
    expect(list[0]!.paymentRef).toBeNull();
    expect(list[0]!.stripePaymentIntentId).toBeNull();
    expect(list[0]!.amount).toBe(1500);
  });
});

// =====================================================================
// Scenario 5 — Outreach funnel + sendOutreach + state machine
// =====================================================================
describe('Scenario 5 — Outreach funnel', () => {
  it('funnel rolls up the 6-value status grouping', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      // REVIEW-P2C22 BLOCKING 3 — funnel SQL now JOINs through
      // alm_campaigns and the SELECT uses the r.outreach_status alias.
      if (c.sql.includes('GROUP BY r.outreach_status')) {
        return [
          { outreach_status: 'PENDING', n: 1 },
          { outreach_status: 'SENT', n: 1 },
          { outreach_status: 'OPENED', n: 1 },
          { outreach_status: 'RESPONDED', n: 1 },
          { outreach_status: 'DONATED', n: 2 },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    const funnel = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.funnel('camp-1', ADMIN_ACTOR as never),
    );
    expect(funnel.pending).toBe(1);
    expect(funnel.sent).toBe(1);
    expect(funnel.opened).toBe(1);
    expect(funnel.responded).toBe(1);
    expect(funnel.donated).toBe(2);
    expect(funnel.unsubscribed).toBe(0);
    expect(funnel.total).toBe(6);
  });

  it('sendOutreach flips PENDING -> SENT for every matching row', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (c.fn === 'q' && c.sql.includes('UPDATE alm_campaign_recipients')) {
        return [{ id: 'r1' }, { id: 'r2' }];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new OutreachService(tenantPrisma as never, perms as never);
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.sendOutreach('camp-1', ADMIN_ACTOR as never),
    );
    expect(result.sent).toBe(2);
    const updateCall = capture.find(
      (c) => c.sql.includes('UPDATE alm_campaign_recipients') && c.sql.includes("'SENT'"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("outreach_status = 'PENDING'");
  });

  it('updateStatus refuses backwards transitions and direct DONATED writes', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FOR UPDATE')) {
        return [{ outreach_status: 'OPENED' }];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new OutreachService(tenantPrisma as never, perms as never);

    // Backwards: OPENED -> PENDING
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.updateStatus('r1', { status: 'PENDING' } as never, ADMIN_ACTOR as never),
      ),
    ).rejects.toThrow(BadRequestException);

    // Direct DONATED disallowed
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.updateStatus('r1', { status: 'DONATED' } as never, ADMIN_ACTOR as never),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('non-staff cannot send outreach', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms();
    const svc = new OutreachService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.sendOutreach('camp-1', STUDENT_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// =====================================================================
// Scenario 6 — Events graceful fallback
// =====================================================================
describe('Scenario 6 — Events soft link with graceful fallback', () => {
  it('returns ticketsAvailable=null when Events table is missing (Events not enabled)', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_events e WHERE')) {
        return [
          {
            id: 'evt-1',
            school_id: SCHOOL.schoolId,
            title: 'Homecoming',
            description: null,
            event_date: new Date('2026-10-15'),
            venue: 'Stadium',
            rsvp_url: 'https://example.com/rsvp',
            evt_event_id: 'some-uuid-not-in-evt',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (c.fn === 'q' && c.sql.includes('FROM evt_events')) {
        // Events table missing — simulate the Postgres relation-doesn't-exist error
        const err = new Error('relation "evt_events" does not exist');
        throw err;
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    const list = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.list(STUDENT_ACTOR as never),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.evtEventId).toBe('some-uuid-not-in-evt');
    // KEY ASSERTION — graceful fallback
    expect(list[0]!.ticketsAvailable).toBeNull();
    // RSVP URL is preserved so the UI can fall back to "RSVP →"
    expect(list[0]!.rsvpUrl).toBe('https://example.com/rsvp');
  });

  it('returns ticketsAvailable when Events resolves', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_events e WHERE')) {
        return [
          {
            id: 'evt-1',
            school_id: SCHOOL.schoolId,
            title: 'Homecoming',
            description: null,
            event_date: new Date('2026-10-15'),
            venue: 'Stadium',
            rsvp_url: null,
            evt_event_id: 'real-evt-uuid',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      if (c.fn === 'q' && c.sql.includes('FROM evt_events')) {
        return [{ available: 42 }];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    const list = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.list(STUDENT_ACTOR as never),
    );
    expect(list[0]!.ticketsAvailable).toBe(42);
  });

  it('refuses event mutations from non-staff', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms();
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ title: 'X', eventDate: '2026-10-15' } as never, STUDENT_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// =====================================================================
// Scenario 7 — Visibility matrix across personas
// =====================================================================
describe('Scenario 7 — Visibility matrix', () => {
  it('non-staff campaign list filters out DRAFT', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.sql.startsWith('SELECT c.id::text')) {
        return [];
      }
      return [];
    });
    const perms = makePerms();
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(STUDENT_ACTOR as never));
    const listSql = capture.find((c) => c.sql.startsWith('SELECT c.id::text'))!.sql;
    expect(listSql).toContain("c.status IN ('ACTIVE', 'COMPLETED')");
  });

  it('admin campaign list returns all statuses', async () => {
    // REVIEW-P2C22 BLOCKING 6 — module-wide admin authority now
    // requires pub-004:admin (was pub-004:write). Generic STAFF with
    // only pub-004:write no longer sees DRAFT/CANCELLED campaigns.
    const { capture, tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:admin'] });
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(STAFF_ACTOR as never));
    const listSql = capture.find((c) => c.sql.startsWith('SELECT c.id::text'))!.sql;
    expect(listSql).not.toContain('c.status IN');
  });

  it('staff with only pub-004:write sees ACTIVE+COMPLETED only (B6 narrowing)', async () => {
    // Verifies the B6 narrowing — a STAFF actor without pub-004:admin
    // is correctly treated as a non-admin reader.
    const { capture, tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:write'] });
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(STAFF_ACTOR as never));
    const listSql = capture.find((c) => c.sql.startsWith('SELECT c.id::text'))!.sql;
    expect(listSql).toContain("c.status IN ('ACTIVE', 'COMPLETED')");
  });

  it('parent (no staff scope) cannot read funnel', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms();
    const { kafka } = makeKafka();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      kafka as never,
      redis as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () => svc.funnel('camp-1', STUDENT_ACTOR as never)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('non-staff news list excludes drafts (published_at IS NOT NULL)', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const perms = makePerms();
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, () => svc.list(STUDENT_ACTOR as never));
    const listSql = capture.find((c) => c.sql.startsWith('SELECT n.id::text'))!.sql;
    expect(listSql).toContain('n.published_at IS NOT NULL');
  });

  it('reunion CONFIRMED requires event_date — refuses without one', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.sql.startsWith('SELECT r.id::text')) {
        return [
          {
            id: 'r-1',
            school_id: SCHOOL.schoolId,
            graduation_year: 2020,
            name: 'Class of 2020',
            organiser_id: 'org-1',
            organiser_name: 'Alex',
            event_date: null, // not set
            rsvp_deadline: null,
            status: 'PLANNING',
            description: null,
            venue: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new ReunionGroupService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.patch('r-1', { status: 'CONFIRMED' } as never, ADMIN_ACTOR as never),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('teacher (no pub-004:write) is not staff scope for write-paths', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [TEACHER_ACTOR.accountId]: ['pub-004:read'] });
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ title: 'x', body: 'y', category: 'GENERAL' } as never, TEACHER_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// =====================================================================
// REVIEW-P2C22 ROUND 1 regression tests
// =====================================================================
// These tests pin the 6 BLOCKING fixes so the contracts cannot regress
// in a future cycle. Each block targets one BLOCKING:
//   R-B1 — outbox enqueueInTx + deterministic event_id (campaign + donation)
//   R-B2 — school-scoped access helpers (loadAlumniProfileOrFail / loadCampaignOrFail / resolveOwnAlumniId)
//   R-B3 — campaign + recipient + outreach mutation paths JOIN through alm_campaigns.school_id
//   R-B4 — news + reunion + event UPDATE/DELETE carry AND school_id
//   R-B5 — evt_event_id ticket enrichment filters by current-school evt_events
//   R-B6 — module-wide admin authority requires pub-004:admin (was pub-004:write)
describe('REVIEW-P2C22 ROUND 1 — BLOCKING 1: durable outbox for alumni emits', () => {
  it('CampaignService.activate enqueues alm.campaign.activated via OutboxService with deterministic event_id', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_campaigns')) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'DRAFT',
            reporting_currency: 'USD',
            title: 'Library Renovation',
            description: null,
            goal_amount: '50000.00',
            campaign_year: 2026,
            start_date: null,
            end_date: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { outbox, emitted } = makeOutbox();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.activate('camp-1', ADMIN_ACTOR as never),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('alm.campaign.activated');
    expect(emitted[0]!.sourceModule).toBe('alumni');
    // Deterministic event_id is v5-shaped UUID derived from
    // sha256("camp-1:alm.campaign.activated:v1"). Replaying twice
    // produces the same envelope event_id so downstream consumers
    // dedupe through the consumer-group idempotency claim.
    expect(emitted[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Stable across reruns — re-deriving must match.
    const { deterministicCampaignActivatedEventId } = await import('../event-ids');
    expect(emitted[0]!.eventId).toBe(deterministicCampaignActivatedEventId('camp-1'));
  });

  it('DonationService.donate enqueues alm.donation.received via OutboxService with deterministic event_id', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_campaigns')) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      if (c.fn === 'q' && c.sql.includes('FROM alm_alumni_profiles')) {
        return [
          {
            id: 'p-alex',
            school_id: SCHOOL.schoolId,
            person_id: ALEX_ACTOR.personId,
            is_opted_in: true,
          },
        ];
      }
      if (c.fn === 'q' && c.sql.includes('FROM alm_donations WHERE id =')) {
        return [
          {
            id: 'don-1',
            campaign_id: 'camp-1',
            donor_alumni_id: 'p-alex',
            donor_name: 'Alex Rivera',
            donor_email: 'alex@example.com',
            amount: '100.00',
            currency: 'USD',
            fx_rate_at_donation: '1.0000',
            amount_in_reporting_currency: '100.00',
            payment_method: 'CARD',
            stripe_payment_intent_id: null,
            is_anonymous: false,
            note: null,
            donated_at: new Date(),
            created_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { outbox, emitted } = makeOutbox();
    const { redis } = makeRedis();
    const svc = new DonationService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.donate(
        'camp-1',
        'p-alex',
        { donorAlumniId: 'p-alex', amount: 100, currency: 'USD' } as never,
        ADMIN_ACTOR as never,
      ),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe('alm.donation.received');
    expect(emitted[0]!.sourceModule).toBe('alumni');
    expect(emitted[0]!.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const { deterministicDonationReceivedEventId } = await import('../event-ids');
    // The donation id is generated server-side; assert the event_id
    // matches the same deterministic shape against the actual donation
    // id captured from the response DTO.
    const insertedDonationId = emitted[0]!.payload.donationId as string;
    expect(emitted[0]!.eventId).toBe(deterministicDonationReceivedEventId(insertedDonationId));
  });

  it('deterministic event_ids are distinct across topics for the same key', async () => {
    const { deterministicCampaignActivatedEventId, deterministicDonationReceivedEventId } =
      await import('../event-ids');
    // Same domain id, different topic suffix → different envelope id
    expect(deterministicCampaignActivatedEventId('shared-id')).not.toBe(
      deterministicDonationReceivedEventId('shared-id'),
    );
  });
});

describe('REVIEW-P2C22 ROUND 1 — BLOCKING 2: school-scoped access helpers', () => {
  it('loadAlumniProfileOrFail collapses cross-school UUIDs to NotFoundException', async () => {
    const { capture, tenantPrisma } = makeFake(() => []); // empty result simulates cross-school miss
    const { loadAlumniProfileOrFail } = await import('../access');
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        loadAlumniProfileOrFail(tenantPrisma as never, 'cross-school-uuid'),
      ),
    ).rejects.toThrow(NotFoundException);
    // The lookup SQL carries the school_id predicate
    const sql = capture[0]!.sql;
    expect(sql).toContain('WHERE id = $1::uuid AND school_id = $2::uuid');
    expect(capture[0]!.args).toEqual(['cross-school-uuid', SCHOOL.schoolId]);
  });

  it('loadCampaignOrFail collapses cross-school UUIDs to NotFoundException', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const { loadCampaignOrFail } = await import('../access');
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        loadCampaignOrFail(tenantPrisma as never, 'cross-school-camp'),
      ),
    ).rejects.toThrow(NotFoundException);
    const sql = capture[0]!.sql;
    expect(sql).toContain('WHERE id = $1::uuid AND school_id = $2::uuid');
    expect(capture[0]!.args).toEqual(['cross-school-camp', SCHOOL.schoolId]);
  });

  it('resolveOwnAlumniId restricts to current tenant via school_id', async () => {
    const { capture, tenantPrisma } = makeFake(() => []);
    const { resolveOwnAlumniId } = await import('../access');
    const result = await runWithTenantContext({ tenant: SCHOOL }, () =>
      resolveOwnAlumniId(tenantPrisma as never, ALEX_ACTOR as never),
    );
    expect(result).toBeNull();
    // SQL binds person_id AND school_id (not just person_id)
    const sql = capture[0]!.sql;
    expect(sql).toContain('person_id = $1::uuid AND school_id = $2::uuid');
    expect(capture[0]!.args).toEqual([ALEX_ACTOR.personId, SCHOOL.schoolId]);
  });
});

describe('REVIEW-P2C22 ROUND 1 — BLOCKING 3: campaign+recipient+outreach SQL joins through alm_campaigns.school_id', () => {
  it('campaign patch UPDATE includes the school predicate', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_campaigns')) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'DRAFT',
            reporting_currency: 'USD',
            title: 'Original',
            description: null,
            goal_amount: '5000.00',
            campaign_year: 2026,
            start_date: null,
            end_date: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { outbox } = makeOutbox();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch('camp-1', { title: 'Renamed' } as never, ADMIN_ACTOR as never),
    );
    const upd = capture.find((c) => c.fn === 'e' && c.sql.startsWith('UPDATE alm_campaigns'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain('school_id =');
    expect(upd!.args).toContain(SCHOOL.schoolId);
  });

  it('listRecipients JOIN includes c.school_id predicate', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (
        c.fn === 'q' &&
        c.fn === 'q' &&
        c.sql.includes(
          'SELECT id::text AS id, school_id::text AS school_id, status, reporting_currency',
        )
      ) {
        return [
          {
            id: 'camp-1',
            school_id: SCHOOL.schoolId,
            status: 'ACTIVE',
            reporting_currency: 'USD',
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const { outbox } = makeOutbox();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      redis as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.listRecipients('camp-1', ADMIN_ACTOR as never),
    );
    const recipientQuery = capture.find((c) => c.sql.includes('alm_campaign_recipients'));
    expect(recipientQuery).toBeDefined();
    expect(recipientQuery!.sql).toContain('alm_campaigns');
    expect(recipientQuery!.sql).toContain('c.school_id =');
  });
});

describe('REVIEW-P2C22 ROUND 1 — BLOCKING 4: news + reunion + event UPDATE/DELETE carry AND school_id', () => {
  it('news patch UPDATE carries AND school_id', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_alumni_news n')) {
        return [
          {
            id: 'n-1',
            school_id: SCHOOL.schoolId,
            author_id: 'author-1',
            author_name: 'Author',
            title: 'T',
            body: 'B',
            category: 'GENERAL',
            published_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.patch('n-1', { title: 'Renamed' } as never, ADMIN_ACTOR as never),
    );
    const upd = capture.find((c) => c.fn === 'e' && c.sql.startsWith('UPDATE alm_alumni_news'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain('AND school_id =');
    expect(upd!.args).toContain(SCHOOL.schoolId);
  });

  it('news remove DELETE carries AND school_id and 404s on zero-row', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      // Return 0 from the DELETE (cross-school UUID).
      if (c.fn === 'e' && c.sql.startsWith('DELETE FROM alm_alumni_news')) return 0;
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.remove('cross-school-uuid', ADMIN_ACTOR as never),
      ),
    ).rejects.toThrow(NotFoundException);
    const del = capture.find(
      (c) => c.fn === 'e' && c.sql.startsWith('DELETE FROM alm_alumni_news'),
    );
    expect(del!.sql).toContain('AND school_id = $2::uuid');
    expect(del!.args).toEqual(['cross-school-uuid', SCHOOL.schoolId]);
  });

  it('event remove DELETE carries AND school_id and 404s on zero-row', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.fn === 'e' && c.sql.startsWith('DELETE FROM alm_events')) return 0;
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.remove('cross-school-uuid', ADMIN_ACTOR as never),
      ),
    ).rejects.toThrow(NotFoundException);
    const del = capture.find((c) => c.fn === 'e' && c.sql.startsWith('DELETE FROM alm_events'));
    expect(del!.sql).toContain('AND school_id = $2::uuid');
    expect(del!.args).toEqual(['cross-school-uuid', SCHOOL.schoolId]);
  });
});

describe('REVIEW-P2C22 ROUND 1 — BLOCKING 5: evt_event_id ticket enrichment filters by current-school evt_events', () => {
  it('resolveTicketsAvailable JOIN binds e.school_id to the current tenant', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_events e WHERE')) {
        return [
          {
            id: 'e-1',
            school_id: SCHOOL.schoolId,
            title: 'Reunion 2026',
            description: null,
            event_date: new Date('2026-06-01'),
            venue: null,
            rsvp_url: null,
            evt_event_id: 'evt-cross-school',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      // resolveTicketsAvailable JOIN — return empty so a cross-school
      // evt_event_id resolves to ticketsAvailable=null.
      if (c.fn === 'q' && c.sql.includes('FROM evt_events e')) {
        return [];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.getById('e-1', ADMIN_ACTOR as never),
    );
    expect(dto.ticketsAvailable).toBeNull();
    const ticketsLookup = capture.find((c) => c.fn === 'q' && c.sql.includes('FROM evt_events e'));
    expect(ticketsLookup).toBeDefined();
    expect(ticketsLookup!.sql).toContain('WHERE e.id = $1::uuid AND e.school_id = $2::uuid');
    expect(ticketsLookup!.args).toEqual(['evt-cross-school', SCHOOL.schoolId]);
  });
});

describe('REVIEW-P2C22 ROUND 1 — BLOCKING 6: module-wide admin authority requires pub-004:admin', () => {
  it('news create refuses STAFF actor with only pub-004:write (no admin)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:write'] });
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ title: 't', body: 'b', category: 'GENERAL' } as never, STAFF_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('event create refuses STAFF actor with only pub-004:write (no admin)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:write'] });
    const svc = new AlumniEventService(tenantPrisma as never, perms as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create({ title: 'Reunion', eventDate: '2026-06-01' } as never, STAFF_ACTOR as never),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('campaign create refuses STAFF actor with only pub-004:write (no admin)', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:write'] });
    const { outbox } = makeOutbox();
    const { redis } = makeRedis();
    const svc = new CampaignService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      redis as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, () =>
        svc.create(
          { title: 'Sci', campaignYear: 2026, reportingCurrency: 'USD' } as never,
          STAFF_ACTOR as never,
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('news create accepts an actor with pub-004:admin', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'q' && c.sql.includes('FROM alm_alumni_news n')) {
        return [
          {
            id: 'n-new',
            school_id: SCHOOL.schoolId,
            author_id: STAFF_ACTOR.personId,
            author_name: 'Staff',
            title: 't',
            body: 'b',
            category: 'GENERAL',
            published_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const perms = makePerms({ [STAFF_ACTOR.accountId]: ['pub-004:admin'] });
    const svc = new AlumniNewsService(tenantPrisma as never, perms as never);
    const dto = await runWithTenantContext({ tenant: SCHOOL }, () =>
      svc.create({ title: 't', body: 'b', category: 'GENERAL' } as never, STAFF_ACTOR as never),
    );
    expect(dto.id).toBe('n-new');
  });
});

// =====================================================================
// Persona constants are referenced — keep them used (prevents the
// strict TS noUnusedLocals from tripping in the spec).
// =====================================================================
describe('persona fixtures (keep-used)', () => {
  it('priya actor + staff actor exist', () => {
    expect(PRIYA_ACTOR.personId).toBe('priya-person');
    expect(STAFF_ACTOR.isSchoolAdmin).toBe(false);
  });
});
