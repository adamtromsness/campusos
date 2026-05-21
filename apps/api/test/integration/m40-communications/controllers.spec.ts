import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache/redis.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';

// Services
import { ThreadService } from '@modules/m40-communications/messaging/thread.service';
import { MessageService } from '@modules/m40-communications/messaging/message.service';
import { UnreadCountService } from '@modules/m40-communications/messaging/unread-count.service';
import { ContentModerationService } from '@modules/m40-communications/moderation/content-moderation.service';
import { AnnouncementService } from '@modules/m40-communications/announcements/announcement.service';
import { EmergencyAlertService } from '@modules/m40-communications/emergency-alerts/emergency-alert.service';
import { AlertTypeService } from '@modules/m40-communications/emergency-alerts/alert-type.service';
import { NotificationInboxService } from '@modules/m40-communications/notifications/notification-inbox.service';
import { TemplateService } from '@modules/m40-communications/messaging/template.service';
import { TranslationService } from '@modules/m40-communications/messaging/translation.service';
import { LanguagePreferenceService } from '@modules/m40-communications/messaging/language-preference.service';
import { AiInferenceService } from '@modules/m40-communications/messaging/ai-inference.service';
import { ModerationService as RulesModerationService } from '@modules/m40-communications/moderation/ai-moderation-aggregate.service';
import { ModerationService as MessagingModerationService } from '@modules/m40-communications/moderation/messaging-moderation.service';
import { AppealService } from '@modules/m40-communications/moderation/appeal.service';
import { AIModerationService } from '@modules/m40-communications/moderation/ai-moderation.service';
import { PushCampaignService } from '@modules/m40-communications/push/push-campaign.service';
import { BroadcastSegmentService } from '@modules/m40-communications/broadcasts/broadcast-segment.service';
import { BroadcastAnalyticsService } from '@modules/m40-communications/broadcasts/broadcast-analytics.service';

// Controllers
import { ThreadController } from '@modules/m40-communications/messaging/thread.controller';
import { MessageController } from '@modules/m40-communications/messaging/message.controller';
import { NotificationBadgeController } from '@modules/m40-communications/messaging/notification-badge.controller';
import { AnnouncementController } from '@modules/m40-communications/announcements/announcement.controller';
import {
  EmergencyAlertController,
  EmergencyAlertDeliveryController,
} from '@modules/m40-communications/emergency-alerts/emergency-alert.controller';
import { AlertTypeController } from '@modules/m40-communications/emergency-alerts/alert-type.controller';
import { NotificationInboxController } from '@modules/m40-communications/notifications/notification-inbox.controller';
import { ModerationController as MessagingModerationController } from '@modules/m40-communications/moderation/messaging-moderation.controller';
import { CommunicationsAdvancedController } from '@modules/m40-communications/messaging/communications-advanced.controller';

import type { ResolvedActor } from '@modules/m00-platform';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_THREAD_TYPE_DIRECT_ID, TEST_ALERT_TYPE_INFO_ID } from '../fixtures/communications';

/**
 * Wave 5 — m40-communications controllers spec.
 *
 * Drives every controller method directly with a stub ActorContextService
 * that returns the appropriate ResolvedActor for the supplied (sub,
 * personId) pair. This exercises the routing layer + DTO plumbing
 * without spinning up a NestApplication. Controllers in this module are
 * thin wrappers around the services, so each call delegates to the
 * already-tested service surface.
 */
describe('integration:m40-communications/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let redis: RedisService;
  let permissions: PermissionCheckService;
  let unread: UnreadCountService;
  let moderation: ContentModerationService;
  let threads: ThreadService;
  let messages: MessageService;
  let announcements: AnnouncementService;
  let alertTypes: AlertTypeService;
  let alerts: EmergencyAlertService;
  let inbox: NotificationInboxService;
  let templates: TemplateService;
  let translations: TranslationService;
  let langPref: LanguagePreferenceService;
  let ai: AiInferenceService;
  let rulesMod: RulesModerationService;
  let messagingMod: MessagingModerationService;
  let appeals: AppealService;
  let aiMod: AIModerationService;
  let push: PushCampaignService;
  let segments: BroadcastSegmentService;
  let analytics: BroadcastAnalyticsService;

  // Stub ActorContextService that returns admin/teacher based on the sub
  function makeActorStub(): any {
    return {
      async resolveActor(accountId: string, _personId: string): Promise<ResolvedActor> {
        if (accountId === TEST_ADMIN_ACCOUNT_ID) return adminActor();
        if (accountId === TEST_TEACHER_ACCOUNT_ID) {
          return {
            accountId,
            personId: TEST_TEACHER_PERSON_ID,
            employeeId: null,
            personType: 'STAFF',
            isSchoolAdmin: false,
          };
        }
        return {
          accountId,
          personId: _personId,
          employeeId: null,
          personType: 'GUARDIAN',
          isSchoolAdmin: false,
        };
      },
    };
  }

  function makeReq(accountId: string, personId: string): any {
    return {
      user: {
        sub: accountId,
        personId,
        email: 'x@x',
        displayName: 'x',
        sessionId: 'sess',
      },
    };
  }

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    outbox = new OutboxService();
    permissions = new PermissionCheckService(rawClient);
    unread = new UnreadCountService(redis);
    moderation = new ContentModerationService(tenantPrisma);
    threads = new ThreadService(tenantPrisma, unread);
    messages = new MessageService(tenantPrisma, threads, moderation, unread, outbox);
    announcements = new AnnouncementService(
      tenantPrisma,
      { emit: async () => undefined } as any,
      permissions,
    );
    alertTypes = new AlertTypeService(tenantPrisma);
    alerts = new EmergencyAlertService(tenantPrisma, alertTypes, permissions, outbox);
    inbox = new NotificationInboxService(tenantPrisma, redis);
    templates = new TemplateService(tenantPrisma);
    ai = new AiInferenceService();
    translations = new TranslationService(tenantPrisma, ai);
    langPref = new LanguagePreferenceService(tenantPrisma);
    rulesMod = new RulesModerationService(tenantPrisma);
    messagingMod = new MessagingModerationService(tenantPrisma);
    appeals = new AppealService(tenantPrisma, rulesMod);
    aiMod = new AIModerationService(tenantPrisma, ai);
    push = new PushCampaignService(tenantPrisma);
    segments = new BroadcastSegmentService(tenantPrisma);
    analytics = new BroadcastAnalyticsService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_message_reads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_messages`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_thread_participants`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_threads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_reads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_audiences`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcements`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_emergency_alert_deliveries`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_emergency_alerts`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_alert_types WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_template_usage_log`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_templates WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_translations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_user_language_preferences`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_moderation_appeals`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_moderation_actions`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_moderation_rules WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_moderation_policies WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_broadcast_analytics`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_broadcast_segments WHERE name LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_analytics_contributions`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_push_analytics`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_campaigns WHERE title LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_push_device_tokens`);
  });

  // ────────────────────────────────────────────────────────────────────
  // ThreadController + MessageController + NotificationBadgeController
  // ────────────────────────────────────────────────────────────────────
  describe('messaging controllers', () => {
    it('ThreadController.list / listTypes / create / markRead / archive', async () => {
      const ctrl = new ThreadController(threads, messages, makeActorStub());
      const adminReq = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);

      // create
      const t = await withTestTenant(async () =>
        ctrl.create(
          {
            threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
            subject: 'IT-thread-controller',
            participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
            initialMessage: 'Hello',
          } as any,
          adminReq,
        ),
      );
      expect(t.subject).toBe('IT-thread-controller');

      // list / types
      const list = await withTestTenant(async () => ctrl.list({} as any, adminReq));
      expect(list.map((r) => r.id)).toContain(t.id);
      const types = await withTestTenant(async () => ctrl.listTypes(adminReq));
      expect(types.length).toBeGreaterThan(0);

      // getOne
      const got = await withTestTenant(async () => ctrl.getOne(t.id, adminReq));
      expect(got.id).toBe(t.id);

      // markRead
      const r = await withTestTenant(async () => ctrl.markRead(t.id, adminReq));
      expect(r.threadId).toBe(t.id);

      // archive
      const a = await withTestTenant(async () =>
        ctrl.archive(t.id, { isArchived: true } as any, adminReq),
      );
      expect(a.isArchived).toBe(true);

      // listRecipients
      const recipients = await withTestTenant(async () =>
        ctrl.listRecipients(TEST_THREAD_TYPE_DIRECT_ID, adminReq),
      );
      expect(Array.isArray(recipients)).toBe(true);
    });

    it('MessageController.post / list / edit / remove', async () => {
      const ctrl = new MessageController(messages, makeActorStub());
      const adminReq = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);

      // Seed a thread
      const threadCtrl = new ThreadController(threads, messages, makeActorStub());
      const t = await withTestTenant(async () =>
        threadCtrl.create(
          {
            threadTypeId: TEST_THREAD_TYPE_DIRECT_ID,
            participants: [{ platformUserId: TEST_TEACHER_ACCOUNT_ID }],
          } as any,
          adminReq,
        ),
      );

      const m = await withTestTenant(async () =>
        ctrl.post(t.id, { body: 'controller post' } as any, adminReq),
      );
      expect(m.body).toBe('controller post');
      const lst = await withTestTenant(async () => ctrl.list(t.id, { limit: 10 } as any, adminReq));
      expect(lst.map((r) => r.id)).toContain(m.id);
      const ed = await withTestTenant(async () =>
        ctrl.edit(m.id, { body: 'controller edited' } as any, adminReq),
      );
      expect(ed.isEdited).toBe(true);
      const rm = await withTestTenant(async () => ctrl.remove(m.id, adminReq));
      expect(rm.isDeleted).toBe(true);
    });

    it('NotificationBadgeController.getCount returns total + per-thread map', async () => {
      const ctrl = new NotificationBadgeController(unread);
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const r = await ctrl.getCount(req);
      expect(typeof r.total).toBe('number');
      expect(typeof r.byThread).toBe('object');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AnnouncementController
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementController', () => {
    it('full CRUD + markRead + getStats', async () => {
      const ctrl = new AnnouncementController(announcements, makeActorStub());
      const adminReq = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const d = await withTestTenant(async () =>
        ctrl.create(
          { title: 'IT-ann-ctrl', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminReq,
        ),
      );
      expect(d.title).toBe('IT-ann-ctrl');
      const list = await withTestTenant(async () => ctrl.list({} as any, adminReq));
      expect(Array.isArray(list)).toBe(true);
      const got = await withTestTenant(async () => ctrl.getOne(d.id, adminReq));
      expect(got.id).toBe(d.id);
      const upd = await withTestTenant(async () =>
        ctrl.update(d.id, { isPublished: true } as any, adminReq),
      );
      expect(upd.isPublished).toBe(true);
      // markRead requires audience row
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        generateId(),
        TEST_SCHOOL_ID,
        d.id,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const mr = await withTestTenant(async () => ctrl.markRead(d.id, adminReq));
      expect(mr.newlyRead).toBe(true);
      const stats = await withTestTenant(async () => ctrl.getStats(d.id, adminReq));
      expect(stats.totalAudience).toBeGreaterThanOrEqual(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // EmergencyAlertController + AlertTypeController + DeliveryController
  // ────────────────────────────────────────────────────────────────────
  describe('emergency alert controllers', () => {
    it('AlertTypeController.list / create / patch', async () => {
      const ctrl = new AlertTypeController(alertTypes, makeActorStub());
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const list = await withTestTenant(async () => ctrl.list(undefined));
      expect(Array.isArray(list)).toBe(true);
      const all = await withTestTenant(async () => ctrl.list('true'));
      expect(Array.isArray(all)).toBe(true);
      const dto = await withTestTenant(async () =>
        ctrl.create(req, {
          name: 'IT-ctrl-type',
          severity: 'WARNING',
          defaultChannels: ['IN_APP'],
        } as any),
      );
      const upd = await withTestTenant(async () =>
        ctrl.patch(req, dto.id, { severity: 'URGENT' } as any),
      );
      expect(upd.severity).toBe('URGENT');
    });

    it('EmergencyAlertController.list / getById / resolve / status', async () => {
      const ctrl = new EmergencyAlertController(alerts, makeActorStub());
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      // Seed alert directly (issue() has a known broken SQL path)
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-alert-ctrl', 'b', $4::uuid, 'ACTIVE')`,
        id,
        TEST_SCHOOL_ID,
        TEST_ALERT_TYPE_INFO_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const list = await withTestTenant(async () => ctrl.list(req));
      expect(list.map((r) => r.id)).toContain(id);
      const got = await withTestTenant(async () => ctrl.getById(req, id));
      expect(got.id).toBe(id);
      const status = await withTestTenant(async () => ctrl.status(req, id));
      expect(status.alertId).toBe(id);
      const resolved = await withTestTenant(async () => ctrl.resolve(req, id));
      expect(resolved.status).toBe('RESOLVED');
    });

    it('EmergencyAlertDeliveryController.acknowledge', async () => {
      const ctrl = new EmergencyAlertDeliveryController(alerts, makeActorStub());
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const alertId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-ack-ctrl', 'b', $4::uuid, 'ACTIVE')`,
        alertId,
        TEST_SCHOOL_ID,
        TEST_ALERT_TYPE_INFO_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const did = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'SENT')`,
        did,
        alertId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const r = await withTestTenant(async () => ctrl.acknowledge(req, did));
      expect(r.acknowledgedAt).not.toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // NotificationInboxController
  // ────────────────────────────────────────────────────────────────────
  describe('NotificationInboxController', () => {
    it('getInbox / getHistory / markAllRead', async () => {
      const ctrl = new NotificationInboxController(inbox);
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const inboxRes = await ctrl.getInbox(req, '5');
      expect(Array.isArray(inboxRes.items)).toBe(true);
      const historyRes = await withTestTenant(async () => ctrl.getHistory(req, {} as any));
      expect(Array.isArray(historyRes.items)).toBe(true);
      const m = await ctrl.markAllRead(req);
      expect(typeof m.lastReadAt).toBe('number');
    });

    it('getInbox with explicit limit string', async () => {
      const ctrl = new NotificationInboxController(inbox);
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      const r = await ctrl.getInbox(req, undefined);
      expect(typeof r.unreadCount).toBe('number');
      const r2 = await ctrl.getInbox(req, '500');
      expect(typeof r2.unreadCount).toBe('number');
      // negative / non-finite handled
      const r3 = await ctrl.getInbox(req, 'not-a-number');
      expect(typeof r3.unreadCount).toBe('number');
      const r4 = await ctrl.getInbox(req, '-5');
      expect(typeof r4.unreadCount).toBe('number');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MessagingModerationController
  // ────────────────────────────────────────────────────────────────────
  describe('MessagingModerationController', () => {
    it('exercises every method', async () => {
      const ctrl = new MessagingModerationController(messagingMod, makeActorStub());
      const req = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);
      // listPolicies (returns empty / platform-only)
      const policies = await withTestTenant(async () => ctrl.listPolicies(req, undefined));
      expect(Array.isArray(policies)).toBe(true);
      // listQueue
      const queue = await withTestTenant(async () => ctrl.listQueue(req));
      expect(Array.isArray(queue)).toBe(true);
      // listLog
      const log = await withTestTenant(async () => ctrl.listLog(req, {} as any));
      expect(Array.isArray(log)).toBe(true);
      // listPolicies includeInactive true
      const all = await withTestTenant(async () => ctrl.listPolicies(req, 'true'));
      expect(Array.isArray(all)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CommunicationsAdvancedController — broad spot-check
  // ────────────────────────────────────────────────────────────────────
  describe('CommunicationsAdvancedController', () => {
    it('language preferences, templates, segments, push round-trip', async () => {
      const ctrl = new CommunicationsAdvancedController(
        translations,
        langPref,
        templates,
        segments,
        analytics,
        rulesMod,
        appeals,
        aiMod,
        push,
        makeActorStub(),
      );
      const adminReq = makeReq(TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID);

      // language preference GET (default) + PATCH
      const pref0 = await withTestTenant(async () => ctrl.getLanguagePreference(adminReq));
      expect(pref0.preferredLanguage).toBe('en');
      const pref1 = await withTestTenant(async () =>
        ctrl.updateLanguagePreference(adminReq, { preferredLanguage: 'es' } as any),
      );
      expect(pref1.preferredLanguage).toBe('es');

      // templates
      const tmpl = await withTestTenant(async () =>
        ctrl.createTemplate(adminReq, {
          name: 'IT-ctrl-tmpl',
          category: 'CUSTOM',
          bodyTemplate: 'hi {name}',
          variables: [{ name: 'name', required: true }],
          allowedRoles: [],
        } as any),
      );
      const tlist = await withTestTenant(async () => ctrl.listTemplates(adminReq));
      expect(tlist.map((t) => t.id)).toContain(tmpl.id);
      const tget = await withTestTenant(async () => ctrl.getTemplate(adminReq, tmpl.id));
      expect(tget.id).toBe(tmpl.id);
      const tpatch = await withTestTenant(async () =>
        ctrl.patchTemplate(adminReq, tmpl.id, { name: 'IT-ctrl-tmpl-2' } as any),
      );
      expect(tpatch.name).toBe('IT-ctrl-tmpl-2');
      const trender = await withTestTenant(async () =>
        ctrl.renderTemplate(adminReq, tmpl.id, { values: { name: 'A' } } as any),
      );
      expect(trender.body).toBe('hi A');
      const tuse = await withTestTenant(async () =>
        ctrl.useTemplate(adminReq, tmpl.id, { values: { name: 'B' } } as any),
      );
      expect(tuse.body).toBe('hi B');
      const tan = await withTestTenant(async () => ctrl.templateAnalytics(adminReq, tmpl.id));
      expect(tan.usageCount).toBeGreaterThan(0);
      const tusage = await withTestTenant(async () => ctrl.templateUsage(adminReq, tmpl.id));
      expect(tusage.length).toBeGreaterThan(0);

      // segments
      const seg = await withTestTenant(async () =>
        ctrl.createSegment(adminReq, {
          name: 'IT-ctrl-seg',
          segmentType: 'ALL_STAFF',
          filterCriteria: {},
        } as any),
      );
      const slist = await withTestTenant(async () => ctrl.listSegments());
      expect(slist.map((s) => s.id)).toContain(seg.id);
      const sget = await withTestTenant(async () => ctrl.getSegment(seg.id));
      expect(sget.id).toBe(seg.id);
      const spreview = await withTestTenant(async () => ctrl.previewSegment(seg.id));
      expect(typeof spreview.estimatedRecipients).toBe('number');
      const sresolve = await withTestTenant(async () => ctrl.resolveSegment(seg.id));
      expect(sresolve.segmentId).toBe(seg.id);
      const spatch = await withTestTenant(async () =>
        ctrl.patchSegment(adminReq, seg.id, { description: 'd' } as any),
      );
      expect(spatch.description).toBe('d');

      // broadcast analytics get (empty)
      const ban = await withTestTenant(async () => ctrl.broadcastAnalytics(generateId()));
      expect(ban.perSegment.length).toBe(0);

      // push campaigns
      const camp = await withTestTenant(async () =>
        ctrl.createPushCampaign(adminReq, { title: 'IT-ctrl-push', body: 'b' } as any),
      );
      const clist = await withTestTenant(async () => ctrl.listPushCampaigns());
      expect(clist.map((c) => c.id)).toContain(camp.id);
      const cget = await withTestTenant(async () => ctrl.getPushCampaign(camp.id));
      expect(cget.id).toBe(camp.id);
      const cpatch = await withTestTenant(async () =>
        ctrl.patchPushCampaign(adminReq, camp.id, { title: 'IT-ctrl-push-2' } as any),
      );
      expect(cpatch.title).toBe('IT-ctrl-push-2');
      const can = await withTestTenant(async () => ctrl.getPushAnalytics(camp.id));
      // analytics row only exists after dispatch — null is fine
      expect(can === null || typeof can.totalTargeted === 'number').toBe(true);

      // push device tokens
      const tok = await withTestTenant(async () =>
        ctrl.registerPushDevice(adminReq, { deviceToken: 'tok-1', platform: 'IOS' } as any),
      );
      const devs = await withTestTenant(async () => ctrl.listMyPushDevices(adminReq));
      expect(devs.map((d) => d.id)).toContain(tok.id);
      await withTestTenant(async () => ctrl.deregisterPushDevice(adminReq, tok.id));

      // moderation rules
      const rule = await withTestTenant(async () =>
        ctrl.createModerationRule(adminReq, {
          scope: 'BUILDING',
          name: 'IT-ctrl-rule',
          keywords: ['x'],
          keywordAction: 'FLAG_FOR_REVIEW',
        } as any),
      );
      const rules = await withTestTenant(async () => ctrl.listModerationRules());
      expect(rules.map((r) => r.id)).toContain(rule.id);
      const rget = await withTestTenant(async () => ctrl.getModerationRule(rule.id));
      expect(rget.id).toBe(rule.id);
      const rpatch = await withTestTenant(async () =>
        ctrl.patchModerationRule(adminReq, rule.id, { name: 'IT-ctrl-rule-2' } as any),
      );
      expect(rpatch.name).toBe('IT-ctrl-rule-2');

      // moderation queue (empty)
      const q = await withTestTenant(async () => ctrl.listModerationQueue());
      expect(Array.isArray(q)).toBe(true);

      // appeals list (empty)
      const alist = await withTestTenant(async () => ctrl.listAppeals());
      expect(Array.isArray(alist)).toBe(true);
    });
  });
});
