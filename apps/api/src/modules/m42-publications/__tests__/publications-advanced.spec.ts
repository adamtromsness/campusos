import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { VersionService, TemplateService } from '../versions.service';
import { ScheduledPublishService, PublicationAnalyticsService } from '../scheduled-publish.service';
import { deterministicPublicationPublishedEventId } from '../event-ids';

/**
 * P2-26 Step 6 — Publications Advanced vertical-slice integration tests.
 *
 * Walks the 5 plan scenarios end-to-end with a stubbed tenant-prisma
 * client + outbox stub:
 *
 *   S1 Version IMMUTABLE             — no UPDATE / DELETE method on
 *                                      VersionService; revert creates a
 *                                      NEW row (append-only)
 *   S2 Templates                     — from-template auto-populates
 *                                      sections; is_system=true edit/
 *                                      delete refused with 403
 *   S3 Scheduled publishing          — schedule accepts only future
 *                                      timestamps + UNIQUE(publication)
 *                                      catch + cancel atomic lockstep
 *   S4 Analytics atomic counters     — ingestEvent uses SQL-level
 *                                      INCREMENT (not read-then-write)
 *   S5 Visibility                    — Editor sees own versions +
 *                                      analytics. Admin sees all.
 *                                      Students 403 on every advanced
 *                                      surface.
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

const STUDENT_ACTOR = {
  accountId: 'student-account',
  personId: 'student-person',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
};

const PARENT_ACTOR = {
  accountId: 'parent-account',
  personId: 'parent-person',
  employeeId: null,
  personType: 'GUARDIAN' as const,
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

function makePermCheck(resolver: (accountId: string, codes: string[]) => boolean = () => false) {
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

// ─────────────────────────────────────────────────────────────────
// Scenario 1 — Version history IMMUTABILITY contract
// ─────────────────────────────────────────────────────────────────

describe('S1 — Version IMMUTABLE contract', () => {
  it('VersionService prototype has NO update or delete method', () => {
    const proto = Object.getPrototypeOf(new VersionService(null as never, null as never)) as Record<
      string,
      unknown
    >;
    const methods = Object.getOwnPropertyNames(proto);
    // Confirm the IMMUTABLE contract: no mutating verbs on the prototype
    expect(methods).not.toContain('update');
    expect(methods).not.toContain('patch');
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('remove');
    // Confirm the canonical writers exist
    expect(methods).toContain('checkpoint');
    expect(methods).toContain('revert');
    expect(methods).toContain('captureForStatusChange');
  });

  it('checkpoint INSERTs a new row with trigger=MANUAL_CHECKPOINT (no UPDATE)', async () => {
    const fake = makeFake((call) => {
      // composeSnapshot pub read — now JOINs via school_id
      if (
        call.sql.includes('FROM pub_publications WHERE id') &&
        call.sql.includes('publication_type')
      ) {
        return [
          {
            title: 'Test',
            status: 'DRAFT',
            publication_type: 'NEWSLETTER',
            published_at: null,
          },
        ];
      }
      // assertCanAccess existence check
      if (call.sql.includes('FROM pub_publications WHERE id') && call.sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM pub_sections')) return [];
      if (
        call.sql.includes('COALESCE(MAX(v.version_number)') ||
        call.sql.includes('COALESCE(MAX(version_number)')
      ) {
        return [{ next: 6 }];
      }
      if (call.sql.includes('FROM pub_publication_versions v') && call.sql.includes('WHERE v.id')) {
        return [
          {
            id: 'ver-new',
            publication_id: 'pub-1',
            version_number: 6,
            trigger: 'MANUAL_CHECKPOINT',
            reverted_from_version: null,
            version_note: 'mid-draft save',
            created_by: 'editor-account',
            created_by_name: 'editor@school',
            created_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      // canEditPublication collaborator probe
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new VersionService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.checkpoint(EDITOR_ACTOR, 'pub-1', { versionNote: 'mid-draft save' }),
    );
    const inserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO pub_publication_versions'),
    );
    expect(inserts).toHaveLength(1);
    // trigger is parameterised via $5 — assert against the args, not inline SQL
    expect(inserts[0]!.args[4]).toBe('MANUAL_CHECKPOINT');
    // NO UPDATE statement should have been issued
    const updates = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pub_publication_versions'),
    );
    expect(updates).toHaveLength(0);
    expect(result.versionNumber).toBe(6);
  });

  it('revert creates a NEW version (append-only) — never modifies an existing row', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id') && call.sql.includes('school_id')) {
        return [{ ok: 1 }];
      }
      if (
        call.sql.includes('snapshot_content') &&
        call.sql.includes('FROM pub_publication_versions')
      ) {
        return [{ snapshot_content: { title: 'v1 snapshot' } }];
      }
      if (
        call.sql.includes('COALESCE(MAX(v.version_number)') ||
        call.sql.includes('COALESCE(MAX(version_number)')
      ) {
        return [{ next: 7 }];
      }
      if (call.sql.includes('FROM pub_publication_versions v') && call.sql.includes('WHERE v.id')) {
        return [
          {
            id: 'ver-revert',
            publication_id: 'pub-1',
            version_number: 7,
            trigger: 'REVERT',
            reverted_from_version: 1,
            version_note: 'rolled back',
            created_by: 'editor-account',
            created_by_name: 'editor@school',
            created_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new VersionService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.revert(EDITOR_ACTOR, 'pub-1', 1, { versionNote: 'rolled back' }),
    );
    // Should be exactly one INSERT, no UPDATE
    const inserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO pub_publication_versions'),
    );
    expect(inserts).toHaveLength(1);
    // revert path uses an inline 'REVERT' literal (not parameterised) since
    // there's no trigger ambiguity — verify the literal + reverted_from_version
    // column appears in the SQL
    expect(inserts[0]!.sql).toContain("'REVERT'");
    expect(inserts[0]!.sql).toContain('reverted_from_version');
    const updates = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('UPDATE pub_publication_versions'),
    );
    expect(updates).toHaveLength(0);
    expect(result.versionNumber).toBe(7);
    expect(result.revertedFromVersion).toBe(1);
  });

  it('revert against missing target version returns 404', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('snapshot_content FROM pub_publication_versions')) return [];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new VersionService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.revert(EDITOR_ACTOR, 'pub-1', 99, {}))).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 2 — Templates
// ─────────────────────────────────────────────────────────────────

describe('S2 — Templates (is_system protection + from-template auto-populate)', () => {
  it('patch refuses is_system=true with 403', async () => {
    const fake = makeFake((call) => {
      // REVIEW-P2C26 R-B1 — lookup row now also returns school_id alongside is_system
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('FOR UPDATE')) {
        return [{ is_system: true, school_id: null }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.patch(ADMIN_ACTOR, 'sys-tpl-1', { name: 'rename attempt' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('delete refuses is_system=true with 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('FOR UPDATE')) {
        return [{ is_system: true, school_id: null }];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.remove(ADMIN_ACTOR, 'sys-tpl-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('createFromTemplate auto-populates sections from template_content.sections', async () => {
    const sections = [
      { title: 'Section A', sortOrder: 0, ownerHint: 'STAFF' },
      { title: 'Section B', sortOrder: 1, ownerHint: 'STAFF' },
      { title: 'Section C', sortOrder: 2, ownerHint: 'STUDENT' },
    ];
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_templates') && call.sql.includes('WHERE id')) {
        return [
          {
            publication_type: 'NEWSLETTER',
            template_content: { sections },
            is_active: true,
          },
        ];
      }
      if (call.sql.includes('FROM pub_publications p')) {
        return [
          {
            id: 'new-pub',
            school_id: SCHOOL.schoolId,
            title: 'Smoke',
            publication_type: 'NEWSLETTER',
            series_id: null,
            edition_id: null,
            created_by: ADMIN_ACTOR.accountId,
            status: 'DRAFT',
            scheduled_publish_at: null,
            published_at: null,
            approval_request_id: null,
            created_at: '',
            updated_at: '',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.createFromTemplate(ADMIN_ACTOR, 'tpl-1', { title: 'Smoke' }),
    );
    const sectionInserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO pub_sections'),
    );
    expect(sectionInserts).toHaveLength(3);
    expect(result.sectionCount).toBe(3);
    expect(result.pendingSectionCount).toBe(3);
    expect(result.status).toBe('DRAFT');
  });

  it('createFromTemplate refuses inactive templates with 400', async () => {
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
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.createFromTemplate(ADMIN_ACTOR, 'tpl-1', { title: 'Smoke' })),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 3 — Scheduled publishing
// ─────────────────────────────────────────────────────────────────

describe('S3 — Scheduled publishing', () => {
  it('schedule rejects past timestamps with 400', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, perm);
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await expect(
      withTenant(() => svc.schedule(EDITOR_ACTOR, 'pub-1', { scheduledAt: past })),
    ).rejects.toThrow(BadRequestException);
  });

  it('schedule rejects invalid timestamps with 400', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.schedule(EDITOR_ACTOR, 'pub-1', { scheduledAt: 'not a date' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('cancel locks parent + flips status with cancelled_at + cancelled_by populated', async () => {
    let updateSql = '';
    let updateArgs: unknown[] = [];
    const refreshedRow = {
      id: 'sched-1',
      publication_id: 'pub-1',
      publication_title: 'Test',
      scheduled_at: '2026-06-01T20:00:00Z',
      timezone: 'America/Chicago',
      status: 'CANCELLED' as const,
      scheduled_by: ADMIN_ACTOR.accountId,
      scheduled_by_name: 'editor@school',
      cancelled_at: '2026-05-16T00:00:00Z',
      cancelled_by: EDITOR_ACTOR.accountId,
      cancellation_reason: 'editor changed mind',
      published_at: null,
      worker_attempts: 0,
      last_error: null,
      created_at: '',
      updated_at: '',
    };
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE pub_scheduled_publications')) {
        updateSql = call.sql;
        updateArgs = call.args;
        return 0;
      }
      if (call.sql.includes('FROM pub_scheduled_publications') && call.sql.includes('FOR UPDATE')) {
        return [{ id: 'sched-1', status: 'SCHEDULED' }];
      }
      if (
        call.sql.includes('FROM pub_scheduled_publications s') &&
        call.sql.includes('WHERE s.id')
      ) {
        return [refreshedRow];
      }
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, perm);
    const result = await withTenant(() =>
      svc.cancel(EDITOR_ACTOR, 'pub-1', { cancellationReason: 'editor changed mind' }),
    );
    expect(updateSql).toContain("status = 'CANCELLED'");
    expect(updateSql).toContain('cancelled_at = now()');
    expect(updateSql).toContain('cancelled_by');
    expect(updateArgs[0]).toBe(EDITOR_ACTOR.accountId);
    expect(updateArgs[1]).toBe('editor changed mind');
    expect(result.status).toBe('CANCELLED');
  });

  it('cancel returns 404 when no active schedule exists', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_scheduled_publications')) return [];
      return [];
    });
    const perm = makePermCheck(() => true);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.cancel(EDITOR_ACTOR, 'pub-1', {}))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('deterministicPublicationPublishedEventId is stable + v5-shaped', () => {
    const id = deterministicPublicationPublishedEventId('pub-1');
    const id2 = deterministicPublicationPublishedEventId('pub-1');
    expect(id).toBe(id2);
    // v5-shape: nibble 13 (after the 3rd hyphen) is '5'
    expect(id[14]).toBe('5');
    // RFC 4122 variant: nibble 17 is one of 8/9/a/b
    expect(['8', '9', 'a', 'b']).toContain(id[19]!);
    // Different keys produce different ids
    expect(deterministicPublicationPublishedEventId('pub-2')).not.toBe(id);
  });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 4 — Analytics atomic counters
// ─────────────────────────────────────────────────────────────────

describe('S4 — Analytics atomic counter increments', () => {
  it('ingestEvent VIEW issues UPDATE ... SET total_views = total_views + 1 (not read-then-write)', async () => {
    let updateSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE pub_publication_analytics')) {
        updateSql = call.sql;
      }
      // Publication existence check (R-B3)
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('SELECT a.publication_id::text')) {
        return [
          {
            publication_id: 'pub-1',
            total_recipients: 100,
            total_views: 11,
            unique_views: 5,
            total_opens: 0,
            total_link_clicks: 0,
            total_bounces: 0,
            avg_read_time_seconds: 120,
            last_event_at: '2026-05-16T00:00:00Z',
            last_updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const redis = makeRedis(1);
    const svc = new PublicationAnalyticsService(fake.tenantPrisma as never, perm, redis);
    const result = await withTenant(() =>
      svc.ingestEvent(ADMIN_ACTOR, 'pub-1', { eventType: 'VIEW', recipientAccountId: 'r-1' }),
    );
    expect(updateSql).toContain('total_views = total_views + 1');
    expect(updateSql).toContain('last_event_at = now()');
    expect(result.publicationId).toBe('pub-1');
  });

  it('ingestEvent LINK_CLICK increments total_link_clicks atomically', async () => {
    let updateSql = '';
    const fake = makeFake((call) => {
      if (call.sql.includes('UPDATE pub_publication_analytics')) {
        updateSql = call.sql;
      }
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('SELECT a.publication_id::text')) {
        return [
          {
            publication_id: 'pub-1',
            total_recipients: 0,
            total_views: 0,
            unique_views: 0,
            total_opens: 0,
            total_link_clicks: 1,
            total_bounces: 0,
            avg_read_time_seconds: null,
            last_event_at: '2026-05-16T00:00:00Z',
            last_updated_at: '2026-05-16T00:00:00Z',
          },
        ];
      }
      return [];
    });
    const perm = makePermCheck(() => false);
    const redis = makeRedis();
    const svc = new PublicationAnalyticsService(fake.tenantPrisma as never, perm, redis);
    await withTenant(() => svc.ingestEvent(ADMIN_ACTOR, 'pub-1', { eventType: 'LINK_CLICK' }));
    expect(updateSql).toContain('total_link_clicks = total_link_clicks + 1');
  });

  it('ingestEvent first event upserts a zero-valued analytics row', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('INSERT INTO pub_publication_analytics ')) {
        expect(call.sql).toContain('ON CONFLICT (publication_id) DO NOTHING');
      }
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('SELECT a.publication_id::text')) {
        return [
          {
            publication_id: 'pub-1',
            total_recipients: 0,
            total_views: 0,
            unique_views: 0,
            total_opens: 1,
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
    const perm = makePermCheck(() => false);
    const redis = makeRedis();
    const svc = new PublicationAnalyticsService(fake.tenantPrisma as never, perm, redis);
    await withTenant(() => svc.ingestEvent(ADMIN_ACTOR, 'pub-1', { eventType: 'OPEN' }));
    const upserts = fake.capture.filter(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO pub_publication_analytics '),
    );
    expect(upserts).toHaveLength(1);
  });

  it('summary refuses non-admin actors with 403', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => false);
    const redis = makeRedis();
    const svc = new PublicationAnalyticsService(fake.tenantPrisma as never, perm, redis);
    await expect(withTenant(() => svc.summary(EDITOR_ACTOR))).rejects.toThrow(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────
// Scenario 5 — Visibility
// ─────────────────────────────────────────────────────────────────

describe('S5 — Visibility matrix', () => {
  it('VersionService.listForPublication refuses non-collaborator non-editor readers with 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      // canEditPublication: not admin + no write perm + no collab row
      if (call.sql.includes('FROM pub_publication_collaborators')) return [];
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new VersionService(fake.tenantPrisma as never, perm);
    await expect(withTenant(() => svc.listForPublication(STUDENT_ACTOR, 'pub-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("VersionService.listForPublication returns 404 (don't-leak-existence) when publication missing", async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new VersionService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() => svc.listForPublication(ADMIN_ACTOR, 'pub-missing')),
    ).rejects.toThrow(NotFoundException);
  });

  it('TemplateService.create refuses parent (GUARDIAN persona) with 403', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(PARENT_ACTOR, {
          name: 'Bad Template',
          publicationType: 'NEWSLETTER',
          templateContent: {},
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('TemplateService.create refuses student persona with 403', async () => {
    const fake = makeFake(() => []);
    const perm = makePermCheck(() => true);
    const svc = new TemplateService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.create(STUDENT_ACTOR, {
          name: 'Bad Template',
          publicationType: 'NEWSLETTER',
          templateContent: {},
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('PublicationAnalyticsService.get refuses non-collaborator non-editor with 403', async () => {
    const fake = makeFake((call) => {
      // Publication existence check (R-B3 — must pass before access check)
      if (
        call.sql.includes('SELECT 1 FROM pub_publications WHERE id') &&
        call.sql.includes('school_id')
      ) {
        return [{ ok: 1 }];
      }
      if (call.sql.includes('FROM pub_publication_collaborators')) return [];
      return [];
    });
    const perm = makePermCheck(() => false);
    const redis = makeRedis();
    const svc = new PublicationAnalyticsService(fake.tenantPrisma as never, perm, redis);
    await expect(withTenant(() => svc.get(STUDENT_ACTOR, 'pub-1'))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('ScheduledPublishService.schedule refuses non-editor with 403', async () => {
    const fake = makeFake((call) => {
      if (call.sql.includes('FROM pub_publications WHERE id')) return [{ ok: 1 }];
      if (call.sql.includes('FROM pub_publication_collaborators')) return [];
      return [];
    });
    const perm = makePermCheck(() => false);
    const svc = new ScheduledPublishService(fake.tenantPrisma as never, perm);
    await expect(
      withTenant(() =>
        svc.schedule(STUDENT_ACTOR, 'pub-1', {
          scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});

// ─────────────────────────────────────────────────────────────────
// Bonus — captureForStatusChange integration (used by PublicationService.patchStatus auto-hook)
// ─────────────────────────────────────────────────────────────────

describe('S6 — captureForStatusChange auto-hook contract', () => {
  it('inserts a row with trigger=STATUS_CHANGE inside the supplied tx', async () => {
    let insertCount = 0;
    let insertArgs: unknown[] = [];
    const txClient = {
      $queryRawUnsafe: async (sql: string, ..._args: unknown[]) => {
        if (sql.includes('FROM pub_publications WHERE id') && sql.includes('publication_type')) {
          return [
            {
              title: 'Test',
              status: 'IN_REVIEW',
              publication_type: 'NEWSLETTER',
              published_at: null,
            },
          ];
        }
        if (sql.includes('FROM pub_sections')) return [];
        if (sql.includes('COALESCE(MAX(v.version_number)')) return [{ next: 4 }];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        if (sql.includes('INSERT INTO pub_publication_versions')) {
          insertCount += 1;
          insertArgs = args;
        }
        return 0;
      },
    };
    const svc = new VersionService(
      { executeInTenantContext: async () => [] } as never,
      makePermCheck(() => true),
    );
    await withTenant(() =>
      svc.captureForStatusChange(
        txClient as never,
        'pub-1',
        'admin-account',
        'Status: DRAFT → IN_REVIEW',
      ),
    );
    expect(insertCount).toBe(1);
    // trigger goes in via $5 parameter; reverted_from_version is $6 (null);
    // version_note is $7; created_by is $8
    expect(insertArgs[4]).toBe('STATUS_CHANGE');
    expect(insertArgs[5]).toBeNull();
    expect(insertArgs[6]).toBe('Status: DRAFT → IN_REVIEW');
    expect(insertArgs[7]).toBe('admin-account');
  });
});
