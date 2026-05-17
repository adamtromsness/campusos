import { describe, it, expect } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant';
import { PERMISSIONS_KEY } from '@shared/auth';
import { AiInferenceService } from '../messaging/ai-inference.service';
import { TranslationService } from '../messaging/translation.service';
import { TemplateService, interpolate } from '../messaging/template.service';
import { BroadcastSegmentService } from '../broadcasts/broadcast-segment.service';
import { BroadcastAnalyticsService } from '../broadcasts/broadcast-analytics.service';
import { CommunicationsAdvancedController } from '../messaging/communications-advanced.controller';

/**
 * Phase 2 Cycle 19 sub-cycle a (P2-19a) — Communications Advanced
 * keystone unit tests.
 *
 * Load-bearing invariants:
 *   1. Translation cache: a second translate() call for the same
 *      (messageId, target_language) returns the cached row instead
 *      of re-calling the AI service.
 *   2. Template render: required variables without a value AND
 *      without a default_value cause render() to throw 400 with the
 *      offending names. Default values fill in for missing required
 *      variables. Unknown variables are ignored.
 *   3. Template allowed_roles filter: non-admin readers see only
 *      templates whose allowed_roles overlap with their IAM role
 *      tokens. Empty allowed_roles = open to all readers.
 *   4. Broadcast segment resolution: each segment_type produces the
 *      expected SQL shape against the right join graph (per-type).
 *   5. Broadcast analytics worker UPSERT idempotency: the same
 *      delivery event for an existing (broadcast, segment) row
 *      updates the counters rather than inserting a duplicate.
 *   6. Controller permission gates pin the documented codes.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0e69-1111-7000-8000-000000000001',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0e69-2222-7000-8000-000000000001',
  personId: '019e0e69-2222-7000-8000-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0e69-2222-7000-8000-000000000099',
} as never;

const TEACHER_ACTOR = {
  accountId: '019e0e69-3333-7000-8000-000000000001',
  personId: '019e0e69-3333-7000-8000-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
  employeeId: '019e0e69-3333-7000-8000-000000000088',
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0e69-4444-7000-8000-000000000001',
  personId: '019e0e69-4444-7000-8000-000000000002',
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

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

function makeAiCounter() {
  let calls = 0;
  const ai = {
    translate: async (
      sourceText: string,
      targetLanguage: string,
      sourceLanguage: string | null,
    ) => {
      calls++;
      return {
        translatedText: `[${targetLanguage}] ${sourceText}`,
        sourceLanguage: sourceLanguage ?? 'en',
        confidence: 0.95,
        modelVersion: 'stub-translation-v1',
      };
    },
    analyzeSensitivity: async () => ({
      sensitivityScore: 0,
      categoriesDetected: {},
      modelVersion: 'stub',
    }),
  } as AiInferenceService;
  return {
    ai,
    get calls() {
      return calls;
    },
  };
}

describe('TranslationService — caching keystone (UNIQUE message_id, target_language)', () => {
  it('returns the cached row on the second translate() call without re-calling the AI service', async () => {
    const messageId = '019e0e69-aaaa-7000-8000-000000000001';
    const sourceCreatedAt = '2026-05-10T09:00:00Z';
    // Cache state: starts empty; after the first call, the INSERT lands;
    // the second call's lookup returns the inserted row.
    let cache: Array<{
      id: string;
      message_id: string;
      message_created_at: string;
      target_language: string;
      translated_text: string;
      source_language: string | null;
      model_version: string | null;
      confidence: string | null;
      translated_at: string;
      requested_by: string | null;
    }> = [];

    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_translations')) {
        return cache;
      }
      if (sql.includes('from msg_messages')) {
        // Cache miss — service needs the source text from msg_messages
        return [{ body: 'Welcome back', created_at: sourceCreatedAt }];
      }
      if (sql.includes('insert into msg_translations')) {
        cache = [
          {
            id: call.args[0] as string,
            message_id: call.args[1] as string,
            message_created_at: call.args[2] as string,
            target_language: call.args[3] as string,
            translated_text: call.args[4] as string,
            source_language: call.args[5] as string,
            model_version: call.args[6] as string,
            confidence: String(call.args[7]),
            translated_at: '2026-05-12T10:00:00Z',
            requested_by: call.args[8] as string,
          },
        ];
        return 1;
      }
      return [];
    });

    const aiCounter = makeAiCounter();
    const svc = new TranslationService(fake.tenantPrisma as never, aiCounter.ai);

    const first = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.translate({ messageId, targetLanguage: 'es' }, ADMIN_ACTOR.accountId),
    );
    expect(first.cached).toBe(false);
    expect(first.translatedText).toBe('[es] Welcome back');
    expect(aiCounter.calls).toBe(1);

    // Second call — should hit the cache, NOT call the AI service.
    const second = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.translate({ messageId, targetLanguage: 'es' }, ADMIN_ACTOR.accountId),
    );
    expect(second.cached).toBe(true);
    expect(second.translatedText).toBe('[es] Welcome back');
    expect(aiCounter.calls).toBe(1); // Still 1 — the cache hit prevented a second AI call.
  });

  it('different target_language for the same message returns a fresh translation', async () => {
    const messageId = '019e0e69-aaaa-7000-8000-000000000002';
    const sourceCreatedAt = '2026-05-10T09:00:00Z';
    // Cache per-(message, lang) — we model two slots
    const cache = new Map<string, unknown>();

    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_translations')) {
        const lang = call.args[1] as string;
        return cache.has(lang) ? [cache.get(lang)] : [];
      }
      if (sql.includes('from msg_messages')) {
        return [{ body: 'Welcome back', created_at: sourceCreatedAt }];
      }
      if (sql.includes('insert into msg_translations')) {
        const lang = call.args[3] as string;
        cache.set(lang, {
          id: call.args[0] as string,
          message_id: call.args[1] as string,
          message_created_at: call.args[2] as string,
          target_language: lang,
          translated_text: call.args[4] as string,
          source_language: call.args[5] as string,
          model_version: call.args[6] as string,
          confidence: String(call.args[7]),
          translated_at: '2026-05-12T10:00:00Z',
          requested_by: call.args[8] as string,
        });
        return 1;
      }
      return [];
    });

    const aiCounter = makeAiCounter();
    const svc = new TranslationService(fake.tenantPrisma as never, aiCounter.ai);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.translate({ messageId, targetLanguage: 'es' }, null),
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.translate({ messageId, targetLanguage: 'zh' }, null),
    );
    expect(aiCounter.calls).toBe(2);
  });

  it('uses sourceText when supplied (auto-translate worker path) — INSERT carries caller body', async () => {
    const messageId = '019e0e69-aaaa-7000-8000-000000000003';
    let messageLookupCalls = 0;
    let inserted: {
      id: string;
      message_id: string;
      message_created_at: string;
      target_language: string;
      translated_text: string;
      source_language: string | null;
      model_version: string | null;
      confidence: string | null;
      translated_at: string;
      requested_by: string | null;
    } | null = null;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_translations')) {
        return inserted ? [inserted] : [];
      }
      if (sql.includes('from msg_messages')) {
        messageLookupCalls++;
        // Worker path still issues a small lookup for created_at — that's
        // expected. The keystone assertion is that the INSERTed body
        // comes from the caller-supplied sourceText, not from this row.
        return [{ body: 'this should not be used', created_at: '2026-05-10T09:00:00Z' }];
      }
      if (sql.includes('insert into msg_translations')) {
        inserted = {
          id: call.args[0] as string,
          message_id: call.args[1] as string,
          message_created_at: call.args[2] as string,
          target_language: call.args[3] as string,
          translated_text: call.args[4] as string,
          source_language: call.args[5] as string,
          model_version: call.args[6] as string,
          confidence: String(call.args[7]),
          translated_at: '2026-05-12T10:00:00Z',
          requested_by: (call.args[8] as string) ?? null,
        };
        return 1;
      }
      return [];
    });
    const aiCounter = makeAiCounter();
    const svc = new TranslationService(fake.tenantPrisma as never, aiCounter.ai);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.translate(
        {
          messageId,
          targetLanguage: 'es',
          sourceText: 'caller-supplied body',
          sourceLanguage: 'en',
        },
        null,
      ),
    );
    // INSERT should carry the caller-supplied text — not the msg_messages body.
    const insertCall = fake.capture.find(
      (c) => c.fn === 'e' && c.sql.toLowerCase().includes('insert into msg_translations'),
    );
    expect(insertCall).toBeTruthy();
    expect(insertCall!.args[4]).toBe('[es] caller-supplied body');
    expect(messageLookupCalls).toBe(1); // for the message_created_at
  });
});

describe('TemplateService — render keystone (required-variable validation)', () => {
  function makeTemplateFetch(template: {
    id: string;
    name: string;
    body_template: string;
    subject_template: string | null;
    variables: unknown[];
    allowed_roles: string[];
    is_active: boolean;
    category: string;
    created_by: string;
  }) {
    return makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_templates') && sql.includes('limit 1')) {
        return [
          {
            id: template.id,
            school_id: SCHOOL.schoolId,
            name: template.name,
            category: template.category,
            subject_template: template.subject_template,
            body_template: template.body_template,
            variables: template.variables,
            allowed_roles: template.allowed_roles,
            is_active: template.is_active,
            created_by: template.created_by,
            created_at: '2026-05-10T09:00:00Z',
            updated_at: '2026-05-10T09:00:00Z',
          },
        ];
      }
      return [];
    });
  }

  it('rejects missing required variables with 400 carrying the offending names', async () => {
    const fake = makeTemplateFetch({
      id: '019e0e69-bbbb-7000-8000-000000000001',
      name: 'Snow Day',
      category: 'EMERGENCY',
      subject_template: '{school_name} closed {closure_date}',
      body_template: 'Closed {closure_date} reopens {reopen_date}',
      variables: [
        { name: 'school_name', required: true },
        { name: 'closure_date', required: true },
        { name: 'reopen_date', required: true },
      ],
      allowed_roles: ['SCHOOL_ADMIN', 'TEACHER'],
      is_active: true,
      created_by: ADMIN_ACTOR.accountId,
    });
    const svc = new TemplateService(fake.tenantPrisma as never);
    let thrown: unknown = null;
    try {
      await runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.render(
          '019e0e69-bbbb-7000-8000-000000000001',
          { values: { school_name: 'Lincoln' } },
          ADMIN_ACTOR,
        ),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const msg = (thrown as BadRequestException).message;
    expect(msg).toContain('closure_date');
    expect(msg).toContain('reopen_date');
    expect(msg).not.toContain('school_name'); // school_name WAS provided
  });

  it('default_value fills in for a missing required variable', async () => {
    const fake = makeTemplateFetch({
      id: '019e0e69-bbbb-7000-8000-000000000002',
      name: 'Field Trip',
      category: 'REMINDER',
      subject_template: 'Trip to {trip_destination}',
      body_template: 'Your child {student_name} has a trip on {trip_date}',
      variables: [
        { name: 'student_name', required: true },
        { name: 'trip_destination', required: true },
        { name: 'trip_date', required: true, default_value: 'TBD' },
      ],
      allowed_roles: ['SCHOOL_ADMIN', 'TEACHER'],
      is_active: true,
      created_by: ADMIN_ACTOR.accountId,
    });
    const svc = new TemplateService(fake.tenantPrisma as never);
    const rendered = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.render(
        '019e0e69-bbbb-7000-8000-000000000002',
        { values: { student_name: 'Maya', trip_destination: 'Museum' } },
        ADMIN_ACTOR,
      ),
    );
    expect(rendered.body).toBe('Your child Maya has a trip on TBD');
    expect(rendered.subject).toBe('Trip to Museum');
  });

  it('happy-path interpolates all provided variables', async () => {
    const fake = makeTemplateFetch({
      id: '019e0e69-bbbb-7000-8000-000000000003',
      name: 'Welcome',
      category: 'WELCOME',
      subject_template: null,
      body_template: 'Hello {name}',
      variables: [{ name: 'name', required: true }],
      allowed_roles: [],
      is_active: true,
      created_by: ADMIN_ACTOR.accountId,
    });
    const svc = new TemplateService(fake.tenantPrisma as never);
    const rendered = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.render(
        '019e0e69-bbbb-7000-8000-000000000003',
        { values: { name: 'Chen Family' } },
        ADMIN_ACTOR,
      ),
    );
    expect(rendered.body).toBe('Hello Chen Family');
    expect(rendered.subject).toBeNull();
  });

  it('interpolate() helper leaves unknown placeholders intact', () => {
    expect(interpolate('Hi {name}, your {role}', { name: 'Maya' })).toBe('Hi Maya, your {role}');
  });

  it('list() filters by allowed_roles for non-admin readers', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_templates') && sql.includes('order by name')) {
        // We never reach the result rows; assert the SQL shape includes
        // the allowed_roles overlap predicate when non-admin.
        return [];
      }
      return [];
    });
    const svc = new TemplateService(fake.tenantPrisma as never);

    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(TEACHER_ACTOR));
    const teacherList = fake.capture.find(
      (c) =>
        c.fn === 'q' &&
        c.sql.toLowerCase().includes('from msg_templates') &&
        c.sql.toLowerCase().includes('order by name'),
    );
    expect(teacherList).toBeTruthy();
    expect(teacherList!.sql).toContain('allowed_roles');
    // Last arg is the role tokens array
    const tokens = teacherList!.args[teacherList!.args.length - 1] as string[];
    expect(tokens).toContain('TEACHER');
    expect(tokens).not.toContain('SCHOOL_ADMIN');

    // Admin path skips the role overlap predicate.
    fake.capture.length = 0;
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(ADMIN_ACTOR));
    const adminList = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('order by name'),
    );
    expect(adminList).toBeTruthy();
    expect(adminList!.sql).not.toContain('allowed_roles &&');
  });

  it('non-admin caller is rejected from create() with Forbidden', async () => {
    const fake = makeFake(() => []);
    const svc = new TemplateService(fake.tenantPrisma as never);
    let thrown: unknown = null;
    try {
      await runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ name: 'X', category: 'CUSTOM', bodyTemplate: 'Hi' }, TEACHER_ACTOR),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
  });
});

describe('BroadcastSegmentService — recipient resolution', () => {
  it('ALL_PARENTS resolution joins through sis_guardians', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_broadcast_segments')) {
        return [
          {
            id: '019e0e69-cccc-7000-8000-000000000001',
            school_id: SCHOOL.schoolId,
            name: 'All Parents',
            description: null,
            segment_type: 'ALL_PARENTS',
            filter_criteria: {},
            estimated_recipients: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: '2026-05-10T09:00:00Z',
            updated_at: '2026-05-10T09:00:00Z',
          },
        ];
      }
      if (sql.includes('from sis_guardians g')) {
        return [
          { account_id: '11111111-1111-7000-8000-000000000001' },
          { account_id: '11111111-1111-7000-8000-000000000002' },
        ];
      }
      return [];
    });
    const svc = new BroadcastSegmentService(fake.tenantPrisma as never);
    const res = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.resolve('019e0e69-cccc-7000-8000-000000000001'),
    );
    expect(res.totalRecipients).toBe(2);
    expect(res.accountIds).toHaveLength(2);
    // The resolver should issue a query that joins sis_guardians +
    // platform_users with the school_id predicate.
    const guardiansQuery = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from sis_guardians g'),
    );
    expect(guardiansQuery).toBeTruthy();
    expect(guardiansQuery!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(guardiansQuery!.args[0]).toBe(SCHOOL.schoolId);
  });

  it('GRADE_LEVEL resolution requires grade_level and joins through sis_students', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_broadcast_segments')) {
        return [
          {
            id: '019e0e69-cccc-7000-8000-000000000002',
            school_id: SCHOOL.schoolId,
            name: 'Grade 5',
            description: null,
            segment_type: 'GRADE_LEVEL',
            filter_criteria: { grade_level: '5' },
            estimated_recipients: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: '2026-05-10T09:00:00Z',
            updated_at: '2026-05-10T09:00:00Z',
          },
        ];
      }
      if (sql.includes('from sis_students s')) {
        return [{ account_id: '22222222-2222-7000-8000-000000000001' }];
      }
      return [];
    });
    const svc = new BroadcastSegmentService(fake.tenantPrisma as never);
    const res = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.resolve('019e0e69-cccc-7000-8000-000000000002'),
    );
    expect(res.totalRecipients).toBe(1);
    const studentsQuery = fake.capture.find(
      (c) => c.fn === 'q' && c.sql.toLowerCase().includes('from sis_students s'),
    );
    expect(studentsQuery).toBeTruthy();
    expect(studentsQuery!.sql.toLowerCase()).toContain('grade_level = $2');
    expect(studentsQuery!.args[1]).toBe('5');
  });

  it('GRADE_LEVEL without filter_criteria.grade_level throws 400', async () => {
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('from msg_broadcast_segments')) {
        return [
          {
            id: '019e0e69-cccc-7000-8000-000000000003',
            school_id: SCHOOL.schoolId,
            name: 'Grade ??',
            description: null,
            segment_type: 'GRADE_LEVEL',
            filter_criteria: {}, // missing grade_level
            estimated_recipients: null,
            is_active: true,
            created_by: ADMIN_ACTOR.accountId,
            created_at: '2026-05-10T09:00:00Z',
            updated_at: '2026-05-10T09:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new BroadcastSegmentService(fake.tenantPrisma as never);
    let thrown: unknown = null;
    try {
      await runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.resolve('019e0e69-cccc-7000-8000-000000000003'),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
  });
});

describe('BroadcastAnalyticsService — UPSERT idempotency', () => {
  it('duplicate delivery event updates the existing row (no double-count)', async () => {
    const existingId = '019e0e69-dddd-7000-8000-000000000099';
    let updateCount = 0;
    let insertCount = 0;
    let cache: {
      delivered: number;
      opened: number;
      clicked: number;
    } = { delivered: 0, opened: 0, clicked: 0 };

    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('select id::text as id from msg_broadcast_analytics')) {
        return [{ id: existingId }];
      }
      if (sql.includes('insert into msg_broadcast_analytics')) {
        insertCount++;
        return 1;
      }
      if (sql.includes('update msg_broadcast_analytics')) {
        updateCount++;
        cache = {
          delivered: call.args[2] as number,
          opened: call.args[3] as number,
          clicked: call.args[4] as number,
        };
        return 1;
      }
      if (sql.includes('select a.id::text as id') && sql.includes('limit 1')) {
        return [
          {
            id: existingId,
            broadcast_id: '019e0e69-eeee-7000-8000-000000000001',
            segment_id: '019e0e69-cccc-7000-8000-000000000002',
            segment_name: 'Grade 5',
            total_recipients: 42,
            delivered: cache.delivered,
            opened: cache.opened,
            clicked: cache.clicked,
            bounced: 0,
            unsubscribed: 0,
            delivery_rate: '0.9524',
            open_rate: '0.7',
            click_rate: '0.2143',
            last_updated_at: '2026-05-12T10:00:00Z',
          },
        ];
      }
      return [];
    });

    const svc = new BroadcastAnalyticsService(fake.tenantPrisma as never);
    const event = {
      broadcastId: '019e0e69-eeee-7000-8000-000000000001',
      segmentId: '019e0e69-cccc-7000-8000-000000000002',
      totalRecipients: 42,
      delivered: 40,
      opened: 28,
      clicked: 6,
      bounced: 2,
      unsubscribed: 0,
    };
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.applyDeliveryEvent(event));
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.applyDeliveryEvent(event));
    expect(insertCount).toBe(0);
    expect(updateCount).toBe(2);
  });

  it('first delivery event with no existing row issues an INSERT', async () => {
    let insertCount = 0;
    let updateCount = 0;
    const fake = makeFake((call) => {
      const sql = call.sql.toLowerCase();
      if (sql.includes('select id::text as id from msg_broadcast_analytics')) {
        return []; // no row yet
      }
      if (sql.includes('insert into msg_broadcast_analytics')) {
        insertCount++;
        return 1;
      }
      if (sql.includes('update msg_broadcast_analytics')) {
        updateCount++;
        return 1;
      }
      if (sql.includes('select a.id::text as id') && sql.includes('limit 1')) {
        return [
          {
            id: '019e0e69-dddd-7000-8000-000000000111',
            broadcast_id: '019e0e69-eeee-7000-8000-000000000002',
            segment_id: null,
            segment_name: null,
            total_recipients: 100,
            delivered: 90,
            opened: 60,
            clicked: 10,
            bounced: 0,
            unsubscribed: 0,
            delivery_rate: '0.9',
            open_rate: '0.6667',
            click_rate: '0.1667',
            last_updated_at: '2026-05-12T10:00:00Z',
          },
        ];
      }
      return [];
    });
    const svc = new BroadcastAnalyticsService(fake.tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.applyDeliveryEvent({
        broadcastId: '019e0e69-eeee-7000-8000-000000000002',
        totalRecipients: 100,
        delivered: 90,
        opened: 60,
        clicked: 10,
      }),
    );
    expect(insertCount).toBe(1);
    expect(updateCount).toBe(0);
  });
});

describe('CommunicationsAdvancedController — permission gates', () => {
  const proto = CommunicationsAdvancedController.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  function gateFor(methodName: string): string[] {
    return Reflect.getMetadata(PERMISSIONS_KEY, proto[methodName]!) ?? [];
  }

  it('translation + language-preferences gate on com-001:read', () => {
    expect(gateFor('translate')).toEqual(['com-001:read']);
    expect(gateFor('listTranslations')).toEqual(['com-001:read']);
    expect(gateFor('getLanguagePreference')).toEqual(['com-001:read']);
    expect(gateFor('updateLanguagePreference')).toEqual(['com-001:read']);
  });

  it('template reads gate on com-001:read; template writes on com-002:write', () => {
    expect(gateFor('listTemplates')).toEqual(['com-001:read']);
    expect(gateFor('getTemplate')).toEqual(['com-001:read']);
    expect(gateFor('createTemplate')).toEqual(['com-002:write']);
    expect(gateFor('patchTemplate')).toEqual(['com-002:write']);
    expect(gateFor('renderTemplate')).toEqual(['com-001:read']);
    expect(gateFor('useTemplate')).toEqual(['com-001:write']);
    expect(gateFor('templateAnalytics')).toEqual(['com-001:read']);
    expect(gateFor('templateUsage')).toEqual(['com-001:read']);
  });

  it('broadcast segments + analytics gate on com-002', () => {
    expect(gateFor('listSegments')).toEqual(['com-002:read']);
    expect(gateFor('getSegment')).toEqual(['com-002:read']);
    expect(gateFor('createSegment')).toEqual(['com-002:write']);
    expect(gateFor('patchSegment')).toEqual(['com-002:write']);
    expect(gateFor('resolveSegment')).toEqual(['com-002:write']);
    expect(gateFor('previewSegment')).toEqual(['com-002:read']);
    expect(gateFor('broadcastAnalytics')).toEqual(['com-002:read']);
  });
});

describe('AiInferenceService — stub contract', () => {
  it('translate() returns the canonical stub shape and rejects empty source text', async () => {
    const ai = new AiInferenceService();
    const out = await ai.translate('Hello', 'es', 'en');
    expect(out.translatedText).toBe('[es] Hello');
    expect(out.sourceLanguage).toBe('en');
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.modelVersion).toContain('stub');

    await expect(ai.translate('', 'es')).rejects.toBeInstanceOf(Error);
    await expect(ai.translate('hi', '   ')).rejects.toBeInstanceOf(Error);
  });

  // Cycle 19 schema-side proof that the unused STUDENT_ACTOR fixture is
  // wired correctly — keeps the lint happy and pins the actor shape we
  // use in other tests.
  it('STUDENT_ACTOR fixture has the documented shape', () => {
    expect(STUDENT_ACTOR.personType).toBe('STUDENT');
    expect(STUDENT_ACTOR.isSchoolAdmin).toBe(false);
  });
});
