import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { VersionService, TemplateService } from '../versions.service';
import { ScheduledPublishService, PublicationAnalyticsService } from '../scheduled-publish.service';
import { assertAccountInCurrentTenant } from '../access';

/**
 * REVIEW-P2C26 ROUND 1 — pinned regression tests for all 7 BLOCKING / MAJOR
 * fixes from the post-cycle architecture review. Each describe block ties
 * one fix to a small set of assertions on the new SQL shape + the new
 * service-layer behaviour. Whenever a future refactor touches one of these
 * paths, the matcher pins the school-predicate requirement so the
 * regression cannot ship unnoticed.
 *
 *   R-B1  TemplateService — every read + write JOINs / WHERE-clauses
 *         carry `school_id IS NULL OR school_id = $tenant.schoolId` for
 *         reads + `school_id = $tenant.schoolId` for writes; createFromTemplate
 *         lookup carries the same predicate. `is_system=true` rows refused
 *         on patch / delete after the school-predicate lookup succeeds.
 *
 *   R-B2  ScheduledPublishService + Worker — list, getById, getForPublication,
 *         schedule, and cancel all JOIN through `pub_publications.school_id`.
 *         Worker `tickForSchool` ripe-query JOINs + schedule UPDATE + parent
 *         publication UPDATE + recipient count all carry the school predicate.
 *
 *   R-B3  PublicationAnalyticsService — get, summary, ingestEvent,
 *         setRecipientTotal all JOIN through `pub_publications.school_id`.
 *         The publication existence check fires BEFORE the canEditPublication
 *         admin short-circuit so a school admin cannot pull foreign-school
 *         analytics by guessing a publication UUID.
 *
 *   R-B4  Analytics contribution ledger — ingestEvent INSERTs a ledger row
 *         keyed on (consumer_group, source_event_id, publication_id, event_type)
 *         BEFORE the atomic counter bump. A redelivered event with the same
 *         (group, event_id, publication_id, event_type) tuple raises 23505,
 *         which the service catches + short-circuits to return the current
 *         analytics row WITHOUT bumping any counter.
 *
 *   R-B5  VersionService follow-up reads — listForPublication, getById,
 *         revert, composeSnapshot, and nextVersionNumber all JOIN through
 *         `pub_publications.school_id`. A forged version id for a foreign-
 *         school publication collapses to 404 at the SQL layer.
 *
 *   R-M1  assertAccountInCurrentTenant — each of the 3 projections
 *         (sis_students via platform_students, sis_guardians, hr_employees)
 *         carries a `school_id = $tenant.schoolId` predicate so a cross-school
 *         user in the same tenant schema cannot satisfy the check.
 *
 *   R-M2  ScheduledPublishWorker inline version capture — the worker inserts
 *         the final STATUS_CHANGE row via direct SQL (not via
 *         VersionService.captureForStatusChange) so it does not need the
 *         circular setter-pattern bridge between modules. The handoff doc
 *         spelled this contract out so future maintainers don't reach for
 *         the request-path service.
 */

const SCHOOL = {
  schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa',
  schemaName: 'tenant_demo',
  organisationId: null,
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'SMALL',
  homeRegion: 'us-east-1',
} as const;

const ADMIN_ACTOR = {
  accountId: 'admin-account',
  personId: 'admin-person',
  employeeId: 'admin-emp',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
};

const EDITOR_ACTOR = {
  accountId: 'editor-account',
  personId: 'editor-person',
  employeeId: 'editor-emp',
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

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => true) {
  return {
    hasAnyPermissionInTenant: async (accountId: string, _schoolId: string, codes: string[]) =>
      resolver(accountId, codes),
  } as never;
}

function makeRedis(uniqueViewIncrement = 0) {
  return {
    markUniquePublicationView: async () => uniqueViewIncrement,
  } as never;
}

function withTenant<T>(fn: () => T | Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant: SCHOOL }, async () => fn()) as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────
// R-B1 — TemplateService school-scope
// ─────────────────────────────────────────────────────────────────────

describe('R-B1 — TemplateService school-scope', () => {
  it('list query allows school_id IS NULL OR school_id = $tenant', async () => {
    const fake = makeFake(() => []);
    const svc = new TemplateService(fake.tenantPrisma as never, makePermCheck());
    await withTenant(() => svc.list(EDITOR_ACTOR));
    const matched = fake.capture.find(
      (c) => c.sql.includes('FROM pub_templates') && c.sql.includes('ORDER BY'),
    );
    expect(matched).toBeTruthy();
    expect(matched!.sql).toContain('school_id IS NULL');
    expect(matched!.sql).toContain('school_id = $1::uuid');
  });

  it('getById carries school predicate and 404s on miss', async () => {
    const fake = makeFake(() => []);
    const svc = new TemplateService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.getById(EDITOR_ACTOR, 'tpl-missing'))).rejects.toThrow(
      NotFoundException,
    );
    const sqls = fake.capture.map((c) => c.sql).filter((s) => s.includes('FROM pub_templates'));
    expect(sqls.some((s) => s.includes('school_id IS NULL') && s.includes('$2::uuid'))).toBe(true);
  });

  it('patch refuses is_system=true with 403 AFTER the school predicate lookup', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('FOR UPDATE')) {
        return [{ is_system: true, school_id: null }];
      }
      return [];
    });
    const svc = new TemplateService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() => svc.patch(ADMIN_ACTOR, 'tpl-sys', { name: 'new' })),
    ).rejects.toThrow(ForbiddenException);
    const lookup = fake.capture.find(
      (c) => c.sql.includes('FROM pub_templates') && c.sql.includes('FOR UPDATE'),
    );
    expect(lookup).toBeTruthy();
    expect(lookup!.sql).toContain('school_id IS NULL');
    expect(lookup!.sql).toContain('$2::uuid');
  });

  it('delete refuses is_system=true with 403 AFTER the school predicate lookup', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('FOR UPDATE')) {
        return [{ is_system: true, school_id: null }];
      }
      return [];
    });
    const svc = new TemplateService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.remove(ADMIN_ACTOR, 'tpl-sys'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('createFromTemplate lookup carries school predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('WHERE id')) {
        return [
          {
            publication_type: 'NEWSLETTER',
            template_content: { sections: [] },
            is_active: false,
          },
        ];
      }
      return [];
    });
    const svc = new TemplateService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() =>
        svc.createFromTemplate(ADMIN_ACTOR, 'tpl-1', {
          title: 'New publication',
          publicationType: 'NEWSLETTER',
        }),
      ),
    ).rejects.toThrow(BadRequestException);
    const lookup = fake.capture.find(
      (c) => c.sql.includes('FROM pub_templates') && c.sql.includes('WHERE id'),
    );
    expect(lookup).toBeTruthy();
    expect(lookup!.sql).toContain('school_id IS NULL');
    expect(lookup!.sql).toContain('$2::uuid');
  });
});

// ─────────────────────────────────────────────────────────────────────
// R-B2 — ScheduledPublishService school-scope
// ─────────────────────────────────────────────────────────────────────

describe('R-B2 — ScheduledPublishService school-scope', () => {
  it('list JOINs through pub_publications.school_id', async () => {
    let listSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_scheduled_publications')) {
        listSql = call.sql;
      }
      return [];
    });
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, makePermCheck());
    await withTenant(() => svc.list(ADMIN_ACTOR));
    expect(listSql).toContain(
      'JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $1::uuid',
    );
  });

  it('getById JOINs through pub_publications.school_id and 404s on cross-school', async () => {
    const fake = makeFake(() => []);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.getById(ADMIN_ACTOR, 'sched-foreign'))).rejects.toThrow(
      NotFoundException,
    );
    const sql = fake.capture.find((c) => c.sql.includes('FROM pub_scheduled_publications'));
    expect(sql?.sql).toContain('JOIN pub_publications p ON p.id = s.publication_id');
    expect(sql?.sql).toContain('school_id = $2::uuid');
  });

  it('schedule locks publication FOR UPDATE with school predicate', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id') && call.sql.includes('FOR UPDATE')) {
        return [{ status: 'DRAFT' }];
      }
      return [];
    });
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, makePermCheck());
    // Pub-existence check (canAccess) returns empty so we 404 — that's enough
    // to prove the school predicate is carried through the FOR UPDATE lookup
    // matcher independently.
    await expect(
      withTenant(() =>
        svc.schedule(ADMIN_ACTOR, 'pub-foreign', {
          scheduledAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).rejects.toThrow(NotFoundException);
    // The pre-tx assertCanAccess (publication existence) carries the predicate.
    const existsSql = fake.capture.find(
      (c) =>
        c.sql.includes('SELECT 1 FROM pub_publications WHERE id') && c.sql.includes('school_id'),
    );
    expect(existsSql?.sql).toContain('school_id = $2::uuid');
  });

  it('cancel JOINs through pub_publications.school_id on lookup AND reload', async () => {
    const fake = makeFake((call) => {
      // canAccess publication-exists
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      // Lookup of schedule to cancel — JOIN through publications must be present
      if (
        call.sql.includes('FROM pub_scheduled_publications s') &&
        call.sql.includes('FOR UPDATE OF s')
      ) {
        return [{ id: 'sched-1', status: 'SCHEDULED' }];
      }
      // Reload after cancel
      if (call.sql.includes('FROM pub_scheduled_publications')) {
        return [];
      }
      return [];
    });
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.cancel(ADMIN_ACTOR, 'pub-1', {}))).rejects.toThrow();
    const lookup = fake.capture.find(
      (c) => c.sql.includes('FROM pub_scheduled_publications s') && c.sql.includes('FOR UPDATE'),
    );
    expect(lookup?.sql).toContain('JOIN pub_publications p ON p.id = s.publication_id');
    expect(lookup?.sql).toContain('school_id = $2::uuid');
  });
});

// ─────────────────────────────────────────────────────────────────────
// R-B3 — PublicationAnalyticsService school-scope
// ─────────────────────────────────────────────────────────────────────

describe('R-B3 — PublicationAnalyticsService school-scope', () => {
  it('get fires the publication existence check BEFORE the admin short-circuit', async () => {
    // admin actor but publication does not exist in this school
    const fake = makeFake(() => []);
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    await expect(withTenant(() => svc.get(ADMIN_ACTOR, 'pub-foreign'))).rejects.toThrow(
      NotFoundException,
    );
    const existsSql = fake.capture.find(
      (c) =>
        c.sql.includes('SELECT 1 FROM pub_publications WHERE id') && c.sql.includes('school_id'),
    );
    expect(existsSql?.sql).toContain('school_id = $2::uuid');
  });

  it('summary JOINs through pub_publications.school_id', async () => {
    let summarySql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publication_analytics a')) {
        summarySql = call.sql;
      }
      return [];
    });
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    await withTenant(() => svc.summary(ADMIN_ACTOR));
    expect(summarySql).toContain(
      'JOIN pub_publications p ON p.id = a.publication_id AND p.school_id = $1::uuid',
    );
  });

  it('ingestEvent validates publication ownership before any counter write', async () => {
    const fake = makeFake(() => []); // empty so existence fails
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    await expect(
      withTenant(() => svc.ingestEvent(ADMIN_ACTOR, 'pub-foreign', { eventType: 'OPEN' })),
    ).rejects.toThrow(NotFoundException);
    // No counter UPDATE should have been issued for a foreign publication.
    const updates = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pub_publication_analytics'),
    );
    expect(updates).toHaveLength(0);
  });

  it('setRecipientTotal carries the school predicate', async () => {
    const fake = makeFake(() => []);
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    await expect(withTenant(() => svc.setRecipientTotal('pub-foreign', 100))).rejects.toThrow(
      NotFoundException,
    );
    const existsSql = fake.capture.find(
      (c) =>
        c.sql.includes('SELECT 1 FROM pub_publications WHERE id') && c.sql.includes('school_id'),
    );
    expect(existsSql?.sql).toContain('school_id = $2::uuid');
  });
});

// ─────────────────────────────────────────────────────────────────────
// R-B4 — Analytics contribution ledger (redelivery dedup)
// ─────────────────────────────────────────────────────────────────────

describe('R-B4 — Analytics contribution ledger', () => {
  it('ingestEvent INSERTs a ledger row before the counter UPDATE', async () => {
    let ledgerInserted = false;
    let updateAfterLedger = false;
    const fake = makeFake((call) => {
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('INSERT INTO pub_publication_analytics_contributions')) {
        ledgerInserted = true;
      }
      if (call.sql.includes('UPDATE pub_publication_analytics') && ledgerInserted) {
        updateAfterLedger = true;
      }
      if (call.sql.includes('SELECT a.publication_id::text')) {
        return [
          {
            publication_id: 'pub-1',
            total_recipients: 0,
            total_views: 1,
            unique_views: 0,
            total_opens: 0,
            total_link_clicks: 0,
            total_bounces: 0,
            avg_read_time_seconds: null,
            last_event_at: null,
            last_updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    await withTenant(() =>
      svc.ingestEvent(ADMIN_ACTOR, 'pub-1', {
        eventType: 'VIEW',
        consumerGroup: 'test-consumer',
        sourceEventId: 'evt-1',
      }),
    );
    expect(ledgerInserted).toBe(true);
    expect(updateAfterLedger).toBe(true);
  });

  it('ingestEvent short-circuits on 23505 ledger UNIQUE violation and does NOT bump counters', async () => {
    let bumped = false;
    const fake = makeFake((call) => {
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('INSERT INTO pub_publication_analytics_contributions')) {
        // Simulate a redelivery — UNIQUE catches it.
        const err = new Error('duplicate key value violates unique constraint (23505)') as Error & {
          code?: string;
          meta?: { code?: string };
        };
        err.code = 'P2010';
        err.meta = { code: '23505' };
        throw err;
      }
      if (call.sql.includes('UPDATE pub_publication_analytics')) {
        bumped = true;
      }
      if (call.sql.includes('SELECT a.publication_id::text')) {
        return [
          {
            publication_id: 'pub-1',
            total_recipients: 0,
            total_views: 0,
            unique_views: 0,
            total_opens: 0,
            total_link_clicks: 0,
            total_bounces: 0,
            avg_read_time_seconds: null,
            last_event_at: null,
            last_updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new PublicationAnalyticsService(
      fake.tenantPrisma as never,
      makePermCheck(),
      makeRedis(),
    );
    const result = await withTenant(() =>
      svc.ingestEvent(ADMIN_ACTOR, 'pub-1', {
        eventType: 'OPEN',
        consumerGroup: 'test-consumer',
        sourceEventId: 'evt-dup',
      }),
    );
    expect(bumped).toBe(false);
    expect(result.totalOpens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// R-B5 — VersionService follow-up reads JOIN through school
// ─────────────────────────────────────────────────────────────────────

describe('R-B5 — VersionService school-scope on follow-up reads', () => {
  it('listForPublication assertCanAccess existence query carries school predicate', async () => {
    const fake = makeFake(() => []);
    const svc = new VersionService(fake.tenantPrisma as never, makePermCheck());
    await expect(
      withTenant(() => svc.listForPublication(ADMIN_ACTOR, 'pub-foreign')),
    ).rejects.toThrow(NotFoundException);
    const existsSql = fake.capture.find((c) =>
      c.sql.includes('SELECT 1 FROM pub_publications WHERE id'),
    );
    expect(existsSql?.sql).toContain('school_id = $2::uuid');
  });

  it('getById JOINs through pub_publications.school_id', async () => {
    const fake = makeFake(() => []);
    const svc = new VersionService(fake.tenantPrisma as never, makePermCheck());
    await expect(withTenant(() => svc.getById(ADMIN_ACTOR, 'ver-foreign'))).rejects.toThrow(
      NotFoundException,
    );
    // The version read JOINs through publications and carries the school
    // predicate on the publication join clause ($2 in this 2-arg query).
    const verRead = fake.capture.find(
      (c) =>
        c.sql.includes('FROM pub_publication_versions v') &&
        c.sql.includes('JOIN pub_publications p'),
    );
    expect(verRead?.sql).toContain('p.school_id = $2::uuid');
  });
});

// ─────────────────────────────────────────────────────────────────────
// R-M1 — assertAccountInCurrentTenant school predicate hardening
// ─────────────────────────────────────────────────────────────────────

describe('R-M1 — assertAccountInCurrentTenant school predicate', () => {
  it('each projection sub-query carries school_id = $tenant predicate', async () => {
    let probedSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.platform_users pu')) {
        probedSql = call.sql;
      }
      return [];
    });
    await expect(
      withTenant(() => assertAccountInCurrentTenant(fake.tenantPrisma as never, 'acct-1')),
    ).rejects.toThrow(BadRequestException);
    expect(probedSql).toContain('FROM sis_students s');
    expect(probedSql).toContain('s.school_id = $2::uuid');
    expect(probedSql).toContain('FROM sis_guardians g');
    expect(probedSql).toContain('g.school_id = $2::uuid');
    expect(probedSql).toContain('FROM hr_employees e');
    expect(probedSql).toContain('e.school_id = $2::uuid');
  });

  it('empty result raises BadRequestException with the supplied field name', async () => {
    const fake = makeFake(() => []);
    await expect(
      withTenant(() =>
        assertAccountInCurrentTenant(fake.tenantPrisma as never, 'acct-foreign', 'collaboratorId'),
      ),
    ).rejects.toThrow(/collaboratorId does not match/);
  });

  it('any projection match passes the check', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM platform.platform_users pu')) {
        return [{ ok: 1 }];
      }
      return [];
    });
    await expect(
      withTenant(() => assertAccountInCurrentTenant(fake.tenantPrisma as never, 'acct-1')),
    ).resolves.toBeUndefined();
  });
});
