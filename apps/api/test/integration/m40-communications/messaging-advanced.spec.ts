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
  TemplateService,
  interpolate,
} from '@modules/m40-communications/messaging/template.service';
import { TranslationService } from '@modules/m40-communications/messaging/translation.service';
import { LanguagePreferenceService } from '@modules/m40-communications/messaging/language-preference.service';
import { AiInferenceService } from '@modules/m40-communications/messaging/ai-inference.service';
import { AIModerationService } from '@modules/m40-communications/moderation/ai-moderation.service';
import { PushCampaignService } from '@modules/m40-communications/push/push-campaign.service';
import { BroadcastSegmentService } from '@modules/m40-communications/broadcasts/broadcast-segment.service';
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
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m40-communications messaging-advanced (P2-19a) DB-backed tests.
 *
 * Surface covered:
 *   - TemplateService (CRUD, render keystone, use + analytics)
 *   - TranslationService (cache, listForMessage, visibility gate)
 *   - LanguagePreferenceService (getOrDefault, upsert, resolveAutoTranslateTarget)
 *   - AiInferenceService (translate, analyzeSensitivity)
 *   - AIModerationService (cache + analyze)
 *   - PushCampaignService (CRUD, dispatch, analytics, device tokens)
 */
describe('integration:m40-communications/messaging-advanced', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let templates: TemplateService;
  let translations: TranslationService;
  let langPref: LanguagePreferenceService;
  let ai: AiInferenceService;
  let aiMod: AIModerationService;
  let push: PushCampaignService;
  let segments: BroadcastSegmentService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    templates = new TemplateService(tenantPrisma);
    ai = new AiInferenceService();
    translations = new TranslationService(tenantPrisma, ai);
    langPref = new LanguagePreferenceService(tenantPrisma);
    aiMod = new AIModerationService(tenantPrisma, ai);
    push = new PushCampaignService(tenantPrisma);
    segments = new BroadcastSegmentService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_template_usage_log WHERE template_id IN (SELECT id FROM ${TEST_SCHEMA}.msg_templates WHERE name LIKE 'IT-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_templates WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_translations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_ai_moderation_results`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_messages`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_thread_participants`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_threads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_user_language_preferences`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_analytics WHERE campaign_id IN (SELECT id FROM ${TEST_SCHEMA}.msg_push_campaigns WHERE title LIKE 'IT-%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_analytics_contributions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_campaigns WHERE title LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_push_device_tokens`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_broadcast_segments WHERE name LIKE 'IT-adv-%'`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // interpolate helper (exported)
  // ────────────────────────────────────────────────────────────────────
  describe('interpolate()', () => {
    it('replaces simple placeholders', () => {
      expect(interpolate('Hello {name}', { name: 'World' })).toBe('Hello World');
    });

    it('preserves unmatched placeholders', () => {
      expect(interpolate('Hello {missing}', {})).toBe('Hello {missing}');
    });

    it('ignores non-word patterns', () => {
      expect(interpolate('text {1invalid} text', { '1invalid': 'x' })).toBe('text {1invalid} text');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // TemplateService
  // ────────────────────────────────────────────────────────────────────
  describe('TemplateService', () => {
    it('admin creates + lists + getsById a template', async () => {
      const dto = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-greet',
            category: 'WELCOME',
            subjectTemplate: 'Hi {name}',
            bodyTemplate: 'Welcome to {school}',
            variables: [
              { name: 'name', required: true },
              { name: 'school', required: false, defaultValue: 'Our School' },
            ],
            allowedRoles: ['TEACHER', 'PARENT'],
            isActive: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('IT-greet');
      expect(dto.variables.length).toBe(2);
      const list = await withTestTenant(async () => templates.list(adminActor(), {}));
      expect(list.map((t) => t.id)).toContain(dto.id);
      const fetched = await withTestTenant(async () => templates.getById(dto.id, adminActor()));
      expect(fetched.id).toBe(dto.id);
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          templates.create(
            {
              name: 'IT-no',
              category: 'WELCOME',
              bodyTemplate: 'b',
              variables: [],
              allowedRoles: [],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate name → ConflictException', async () => {
      await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-dup',
            category: 'CUSTOM',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          templates.create(
            {
              name: 'IT-dup',
              category: 'CUSTOM',
              bodyTemplate: 'b2',
              variables: [],
              allowedRoles: [],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('list filters by category + includeInactive', async () => {
      const t1 = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-cat-a',
            category: 'REMINDER',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      const t2 = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-cat-b',
            category: 'EMERGENCY',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      const reminders = await withTestTenant(async () =>
        templates.list(adminActor(), { category: 'REMINDER' }),
      );
      expect(reminders.map((t) => t.id)).toContain(t1.id);
      expect(reminders.map((t) => t.id)).not.toContain(t2.id);
    });

    it('non-admin list filters out templates whose allowed_roles do not overlap', async () => {
      const onlyParent = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-only-parent',
            category: 'CUSTOM',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: ['PARENT'],
          } as any,
          adminActor(),
        ),
      );
      const teacherView = await withTestTenant(async () => templates.list(teacherActor(), {}));
      expect(teacherView.map((t) => t.id)).not.toContain(onlyParent.id);
      const parentView = await withTestTenant(async () => templates.list(parentActor(), {}));
      expect(parentView.map((t) => t.id)).toContain(onlyParent.id);
    });

    it('non-admin getById for template they cannot see → NotFoundException', async () => {
      const onlyParent = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-only-parent-2',
            category: 'CUSTOM',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: ['PARENT'],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => templates.getById(onlyParent.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('render KEYSTONE — interpolates values + applies defaults; missing required → 400', async () => {
      const t = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-render',
            category: 'CUSTOM',
            subjectTemplate: 'Hi {name}',
            bodyTemplate: 'Welcome to {school}, {name}',
            variables: [
              { name: 'name', required: true },
              { name: 'school', required: false, defaultValue: 'Our School' },
            ],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      const rendered = await withTestTenant(async () =>
        templates.render(t.id, { values: { name: 'Alice' } } as any, adminActor()),
      );
      expect(rendered.subject).toBe('Hi Alice');
      expect(rendered.body).toBe('Welcome to Our School, Alice');

      // Missing required → 400
      await expect(
        withTestTenant(async () => templates.render(t.id, { values: {} } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('use() renders + logs usage; analytics + listUsage reflect it', async () => {
      const t = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-use',
            category: 'CUSTOM',
            bodyTemplate: 'Hello {name}',
            variables: [{ name: 'name', required: true }],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      const r1 = await withTestTenant(async () =>
        templates.use(t.id, { values: { name: 'A' } } as any, adminActor()),
      );
      expect(r1.body).toBe('Hello A');
      const r2 = await withTestTenant(async () =>
        templates.use(t.id, { values: { name: 'B' } } as any, adminActor()),
      );
      expect(r2.body).toBe('Hello B');
      const a = await withTestTenant(async () => templates.getAnalytics(t.id, adminActor()));
      expect(a.usageCount).toBe(2);
      const usage = await withTestTenant(async () => templates.listUsage(t.id, adminActor()));
      expect(usage.length).toBe(2);
    });

    it('patch updates name + variables; cross-tenant ID → 404', async () => {
      const t = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-patch-target',
            category: 'CUSTOM',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        templates.patch(t.id, { name: 'IT-patch-renamed', isActive: false } as any, adminActor()),
      );
      expect(upd.name).toBe('IT-patch-renamed');
      expect(upd.isActive).toBe(false);

      // Cross-tenant
      await expect(
        withTestTenantB(async () =>
          templates.patch(t.id, { name: 'IT-patch-stolen' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin patch → ForbiddenException', async () => {
      const t = await withTestTenant(async () =>
        templates.create(
          {
            name: 'IT-no-patch',
            category: 'CUSTOM',
            bodyTemplate: 'b',
            variables: [],
            allowedRoles: [],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          templates.patch(t.id, { name: 'IT-stolen' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // LanguagePreferenceService
  // ────────────────────────────────────────────────────────────────────
  describe('LanguagePreferenceService', () => {
    it('getOrDefault returns en + autoTranslate=false when no row', async () => {
      const r = await withTestTenant(async () => langPref.getOrDefault(TEST_TEACHER_ACCOUNT_ID));
      expect(r.preferredLanguage).toBe('en');
      expect(r.autoTranslateIncoming).toBe(false);
      expect(r.id).toBe(''); // sentinel for not-yet-persisted
    });

    it('upsert inserts then updates', async () => {
      const r1 = await withTestTenant(async () =>
        langPref.upsert(TEST_TEACHER_ACCOUNT_ID, {
          preferredLanguage: 'es',
          autoTranslateIncoming: true,
        } as any),
      );
      expect(r1.preferredLanguage).toBe('es');
      expect(r1.autoTranslateIncoming).toBe(true);
      const r2 = await withTestTenant(async () =>
        langPref.upsert(TEST_TEACHER_ACCOUNT_ID, {
          preferredLanguage: 'fr',
        } as any),
      );
      expect(r2.preferredLanguage).toBe('fr');
      expect(r2.autoTranslateIncoming).toBe(true); // unchanged
    });

    it('resolveAutoTranslateTarget returns null when not set / when off', async () => {
      const none = await withTestTenant(async () =>
        langPref.resolveAutoTranslateTarget(TEST_PARENT_ACCOUNT_ID),
      );
      expect(none).toBeNull();
      await withTestTenant(async () =>
        langPref.upsert(TEST_PARENT_ACCOUNT_ID, {
          preferredLanguage: 'zh',
          autoTranslateIncoming: false,
        } as any),
      );
      const off = await withTestTenant(async () =>
        langPref.resolveAutoTranslateTarget(TEST_PARENT_ACCOUNT_ID),
      );
      expect(off).toBeNull();
      await withTestTenant(async () =>
        langPref.upsert(TEST_PARENT_ACCOUNT_ID, {
          autoTranslateIncoming: true,
        } as any),
      );
      const on = await withTestTenant(async () =>
        langPref.resolveAutoTranslateTarget(TEST_PARENT_ACCOUNT_ID),
      );
      expect(on).toBe('zh');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // TranslationService
  // ────────────────────────────────────────────────────────────────────
  describe('TranslationService', () => {
    async function seedMessage(opts: { senderId?: string; body?: string } = {}): Promise<{
      messageId: string;
      threadId: string;
    }> {
      const threadId = generateId();
      const messageId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        threadId,
        TEST_SCHOOL_ID,
        // any thread type id will do for the read-side test
        '019e0cf8-aaaa-7777-8888-000000000400',
        opts.senderId ?? TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER')`,
        generateId(),
        threadId,
        TEST_SCHOOL_ID,
        opts.senderId ?? TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_messages (id, thread_id, school_id, sender_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)`,
        messageId,
        threadId,
        TEST_SCHOOL_ID,
        opts.senderId ?? TEST_ADMIN_ACCOUNT_ID,
        opts.body ?? 'Hello world',
      );
      return { messageId, threadId };
    }

    it('translate inserts new row; second call returns cached=true', async () => {
      const { messageId } = await seedMessage();
      const r1 = await withTestTenant(async () =>
        translations.translate(
          { messageId, targetLanguage: 'es' } as any,
          TEST_ADMIN_ACCOUNT_ID,
          adminActor(),
        ),
      );
      expect(r1.cached).toBe(false);
      expect(r1.targetLanguage).toBe('es');
      expect(r1.translatedText).toContain('[es]');
      const r2 = await withTestTenant(async () =>
        translations.translate(
          { messageId, targetLanguage: 'es' } as any,
          TEST_ADMIN_ACCOUNT_ID,
          adminActor(),
        ),
      );
      expect(r2.cached).toBe(true);
      expect(r2.id).toBe(r1.id);
    });

    it('translate without targetLanguage → BadRequestException', async () => {
      const { messageId } = await seedMessage();
      await expect(
        withTestTenant(async () =>
          translations.translate(
            { messageId, targetLanguage: '   ' } as any,
            TEST_ADMIN_ACCOUNT_ID,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-participant non-admin → NotFoundException', async () => {
      const { messageId } = await seedMessage(); // sender = admin
      await expect(
        withTestTenant(async () =>
          translations.translate(
            { messageId, targetLanguage: 'es' } as any,
            TEST_TEACHER_ACCOUNT_ID,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForMessage returns all cached translations sorted by language', async () => {
      const { messageId } = await seedMessage();
      await withTestTenant(async () =>
        translations.translate({ messageId, targetLanguage: 'es' } as any, null),
      );
      await withTestTenant(async () =>
        translations.translate({ messageId, targetLanguage: 'fr' } as any, null),
      );
      const list = await withTestTenant(async () =>
        translations.listForMessage(messageId, adminActor()),
      );
      expect(list.length).toBe(2);
      expect(list.map((t) => t.targetLanguage)).toEqual(['es', 'fr']);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AiInferenceService + AIModerationService
  // ────────────────────────────────────────────────────────────────────
  describe('AiInferenceService', () => {
    it('translate prefixes target tag; rejects empty input', async () => {
      const r = await ai.translate('hello', 'es');
      expect(r.translatedText).toBe('[es] hello');
      expect(r.confidence).toBe(0.95);
      await expect(ai.translate('', 'es')).rejects.toThrow();
      await expect(ai.translate('hello', '')).rejects.toThrow();
    });

    it('analyzeSensitivity returns a deterministic stub', async () => {
      const r = await ai.analyzeSensitivity('clean text');
      expect(r.sensitivityScore).toBeGreaterThanOrEqual(0);
      expect(r.categoriesDetected).toHaveProperty('profanity');
      await expect(ai.analyzeSensitivity('')).rejects.toThrow();
    });
  });

  describe('AIModerationService', () => {
    async function seedMessage(): Promise<string> {
      const threadId = generateId();
      const messageId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        threadId,
        TEST_SCHOOL_ID,
        '019e0cf8-aaaa-7777-8888-000000000400',
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_messages (id, thread_id, school_id, sender_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'sensitive content')`,
        messageId,
        threadId,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      return messageId;
    }

    it('analyze inserts a row on miss; getCached returns cached=true', async () => {
      const messageId = await seedMessage();
      const r1 = await withTestTenant(async () => aiMod.analyze(messageId));
      expect(r1.cached).toBe(false);
      expect(r1.messageId).toBe(messageId);
      const r2 = await withTestTenant(async () => aiMod.getCached(messageId));
      expect(r2).not.toBeNull();
      expect(r2!.cached).toBe(true);
    });

    it('analyze on unknown message → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => aiMod.analyze('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getCached returns null for unanalyzed message', async () => {
      const r = await withTestTenant(async () =>
        aiMod.getCached('00000000-0000-0000-0000-000000000000'),
      );
      expect(r).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PushCampaignService
  // ────────────────────────────────────────────────────────────────────
  describe('PushCampaignService', () => {
    it('admin creates DRAFT campaign without scheduled_at; SCHEDULED when set', async () => {
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-draft', body: 'b' } as any, adminActor()),
      );
      expect(draft.status).toBe('DRAFT');

      const scheduled = await withTestTenant(async () =>
        push.create(
          {
            title: 'IT-scheduled',
            body: 'b',
            scheduledAt: new Date(Date.now() + 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      expect(scheduled.status).toBe('SCHEDULED');
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          push.create({ title: 'IT-x', body: 'b' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create with cross-school audienceSegmentId → BadRequestException', async () => {
      const sid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_broadcast_segments (id, school_id, name, segment_type, filter_criteria)
         VALUES ($1::uuid, $2::uuid, 'IT-adv-B', 'ALL_STAFF', '{}'::jsonb)`,
        sid,
        TEST_SCHOOL_B_ID,
      );
      await expect(
        withTestTenant(async () =>
          push.create(
            { title: 'IT-x-seg', body: 'b', audienceSegmentId: sid } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list + getById round-trip; getById unknown → NotFoundException', async () => {
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-list', body: 'b' } as any, adminActor()),
      );
      const got = await withTestTenant(async () => push.getById(draft.id));
      expect(got.id).toBe(draft.id);
      const list = await withTestTenant(async () => push.list({}));
      expect(list.map((c) => c.id)).toContain(draft.id);
      await expect(
        withTestTenant(async () => push.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list with status filter narrows results', async () => {
      await withTestTenant(async () =>
        push.create({ title: 'IT-status-draft', body: 'b' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => push.list({ status: 'DRAFT' }));
      expect(list.every((c) => c.status === 'DRAFT')).toBe(true);
    });

    it('patch DRAFT → SCHEDULED requires scheduled_at', async () => {
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-patch', body: 'b' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          push.patch(draft.id, { status: 'SCHEDULED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const upd = await withTestTenant(async () =>
        push.patch(
          draft.id,
          {
            status: 'SCHEDULED',
            scheduledAt: new Date(Date.now() + 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      expect(upd.status).toBe('SCHEDULED');
    });

    it('patch on terminal SENT/CANCELLED → BadRequestException', async () => {
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-cancel', body: 'b' } as any, adminActor()),
      );
      // Manually flip to CANCELLED
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.msg_push_campaigns SET status = 'CANCELLED' WHERE id = $1::uuid`,
        draft.id,
      );
      await expect(
        withTestTenant(async () =>
          push.patch(draft.id, { title: 'IT-renamed' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          push.patch('00000000-0000-0000-0000-000000000000', { title: 'x' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin cannot patch → ForbiddenException', async () => {
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-no-patch', body: 'b' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => push.patch(draft.id, { title: 'x' } as any, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('findRipe returns SCHEDULED campaigns whose scheduled_at has elapsed', async () => {
      // Past-scheduled
      const past = await withTestTenant(async () =>
        push.create(
          {
            title: 'IT-ripe',
            body: 'b',
            scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      // Future-scheduled
      const future = await withTestTenant(async () =>
        push.create(
          {
            title: 'IT-unripe',
            body: 'b',
            scheduledAt: new Date(Date.now() + 600_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      const ripe = await withTestTenant(async () => push.findRipe());
      expect(ripe.map((c) => c.id)).toContain(past.id);
      expect(ripe.map((c) => c.id)).not.toContain(future.id);
    });

    it('dispatchScheduled flips SCHEDULED → SENT + seeds analytics', async () => {
      const past = await withTestTenant(async () =>
        push.create(
          {
            title: 'IT-dispatch',
            body: 'b',
            scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => push.dispatchScheduled(past.id, 100));
      expect(r!.status).toBe('SENT');
      expect(r!.sentAt).not.toBeNull();
      const an = await withTestTenant(async () => push.getAnalytics(past.id));
      expect(an!.totalTargeted).toBe(100);
      // Second dispatch is a no-op (already SENT)
      const r2 = await withTestTenant(async () => push.dispatchScheduled(past.id, 999));
      expect(r2).toBeNull();
    });

    it('recordDelivery is additive across calls', async () => {
      const past = await withTestTenant(async () =>
        push.create(
          {
            title: 'IT-recdel',
            body: 'b',
            scheduledAt: new Date(Date.now() - 60_000).toISOString(),
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => push.dispatchScheduled(past.id, 100));
      const r1 = await withTestTenant(async () =>
        push.recordDelivery({ campaignId: past.id, delivered: 10, opened: 5 } as any),
      );
      expect(r1.totalDelivered).toBe(10);
      expect(r1.totalOpened).toBe(5);
      const r2 = await withTestTenant(async () =>
        push.recordDelivery({ campaignId: past.id, delivered: 5, clicked: 2 } as any),
      );
      expect(r2.totalDelivered).toBe(15);
      expect(r2.totalClicked).toBe(2);
    });

    it('recordDelivery without an analytics row → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          push.recordDelivery({
            campaignId: '00000000-0000-0000-0000-000000000000',
            delivered: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getAnalytics returns null when no analytics row exists', async () => {
      const an = await withTestTenant(async () =>
        push.getAnalytics('00000000-0000-0000-0000-000000000000'),
      );
      expect(an).toBeNull();
    });

    // ── Device tokens ───────────────────────────────────────────
    it('registerDevice inserts then updates; listOwnDevices reflects', async () => {
      const dto1 = await withTestTenant(async () =>
        push.registerDevice(
          {
            deviceToken: 'token-A',
            platform: 'IOS',
            deviceName: 'iPhone',
            appVersion: '1.0.0',
          } as any,
          adminActor(),
        ),
      );
      expect(dto1.deviceToken).toBe('token-A');
      expect(dto1.platform).toBe('IOS');

      // Re-register same token → UPDATE branch
      const dto2 = await withTestTenant(async () =>
        push.registerDevice(
          {
            deviceToken: 'token-A',
            platform: 'ANDROID',
            deviceName: 'Phone 2',
            appVersion: '2.0.0',
          } as any,
          adminActor(),
        ),
      );
      expect(dto2.platform).toBe('ANDROID');
      expect(dto2.deviceName).toBe('Phone 2');

      const list = await withTestTenant(async () => push.listOwnDevices(adminActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.deviceToken).toBe('token-A');
    });

    it('deregisterDevice removes own token; non-owner non-admin → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        push.registerDevice({ deviceToken: 'token-B', platform: 'WEB' } as any, teacherActor()),
      );
      // teacher (owner) can deregister
      await withTestTenant(async () => push.deregisterDevice(dto.id, teacherActor()));
      const after = await withTestTenant(async () => push.listOwnDevices(teacherActor()));
      expect(after.map((d) => d.id)).not.toContain(dto.id);
    });

    it('deregisterDevice on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          push.deregisterDevice('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deregisterDevice of other user as non-admin → ForbiddenException', async () => {
      const dto = await withTestTenant(async () =>
        push.registerDevice({ deviceToken: 'token-C', platform: 'IOS' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => push.deregisterDevice(dto.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolveAudienceSize uses school-affiliated active tokens; returns 0 for segment placeholder', async () => {
      // No tokens registered → school-wide path returns 0
      const draft = await withTestTenant(async () =>
        push.create({ title: 'IT-aud', body: 'b' } as any, adminActor()),
      );
      const size0 = await withTestTenant(async () => push.resolveAudienceSize(draft.id));
      expect(size0).toBe(0);

      // Segment-scoped path also returns 0 per implementation comments
      const seg = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-adv-seg', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      const draftSeg = await withTestTenant(async () =>
        push.create(
          { title: 'IT-aud-seg', body: 'b', audienceSegmentId: seg.id } as any,
          adminActor(),
        ),
      );
      const sizeSeg = await withTestTenant(async () => push.resolveAudienceSize(draftSeg.id));
      expect(sizeSeg).toBe(0);
    });
  });

  // Silence unused imports
  void studentActor;
  void TEST_SCHEMA;
});
