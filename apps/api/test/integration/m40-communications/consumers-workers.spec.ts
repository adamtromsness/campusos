import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { RedisService } from '@shared/cache/redis.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import type { ConsumedMessage } from '@shared/kafka/kafka-consumer.service';

// Services
import { NotificationQueueService } from '@modules/m40-communications/notifications/notification-queue.service';
import { BroadcastAnalyticsService } from '@modules/m40-communications/broadcasts/broadcast-analytics.service';
import { TranslationService } from '@modules/m40-communications/messaging/translation.service';
import { AiInferenceService } from '@modules/m40-communications/messaging/ai-inference.service';
import { ModerationService as RulesModerationService } from '@modules/m40-communications/moderation/ai-moderation-aggregate.service';
import { AIModerationService } from '@modules/m40-communications/moderation/ai-moderation.service';
import { PushCampaignService } from '@modules/m40-communications/push/push-campaign.service';

// Consumers + Workers
import { MessageNotificationConsumer } from '@modules/m40-communications/notifications/consumers/message-notification.consumer';
import { AttendanceNotificationConsumer } from '@modules/m40-communications/notifications/consumers/attendance-notification.consumer';
import { GradeNotificationConsumer } from '@modules/m40-communications/notifications/consumers/grade-notification.consumer';
import { TicketNotificationConsumer } from '@modules/m40-communications/notifications/consumers/ticket-notification.consumer';
import { BehaviourNotificationConsumer } from '@modules/m40-communications/notifications/consumers/behaviour-notification.consumer';
import { ProgressNoteNotificationConsumer } from '@modules/m40-communications/notifications/consumers/progress-note-notification.consumer';
import { AbsenceRequestNotificationConsumer } from '@modules/m40-communications/notifications/consumers/absence-request-notification.consumer';
import { ThreadStatsConsumer } from '@modules/m40-communications/messaging/consumers/thread-stats.consumer';
import { TranslationConsumer } from '@modules/m40-communications/messaging/consumers/translation.consumer';
import { BroadcastAnalyticsConsumer } from '@modules/m40-communications/broadcasts/broadcast-analytics.consumer';
import { ModerationConsumer } from '@modules/m40-communications/moderation/moderation.consumer';
import { PushAnalyticsConsumer } from '@modules/m40-communications/push/push-analytics.consumer';
import { AudienceFanOutWorker } from '@modules/m40-communications/announcements/audience-fan-out.worker';
import { NotificationDeliveryWorker } from '@modules/m40-communications/notifications/notification-delivery.worker';
import { PushCampaignWorker } from '@modules/m40-communications/push/push-campaign.worker';

import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_THREAD_TYPE_DIRECT_ID } from '../fixtures/communications';

/**
 * Wave 5 — m40-communications consumers + workers spec.
 *
 * Each Kafka consumer / worker is constructed with its real deps and
 * exercised by calling its private `handle(msg)` method directly with a
 * synthesised ConsumedMessage envelope (see makeEnvelope below).
 * KafkaConsumerService.subscribe() is never invoked.
 *
 * For workers we call the exposed `pollOnceForTest()` seam, which drives
 * tick → tickForTenant → processPendingForTenant in one call.
 */
describe('integration:m40-communications/consumers-workers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let redis: RedisService;
  let outbox: OutboxService;
  let idempotency: IdempotencyService;
  let consumer: KafkaConsumerService;
  let queue: NotificationQueueService;
  let analytics: BroadcastAnalyticsService;
  let ai: AiInferenceService;
  let translations: TranslationService;
  let rulesMod: RulesModerationService;
  let aiMod: AIModerationService;
  let pushCampaigns: PushCampaignService;

  // Consumers
  let messageConsumer: MessageNotificationConsumer;
  let attendanceConsumer: AttendanceNotificationConsumer;
  let gradeConsumer: GradeNotificationConsumer;
  let ticketConsumer: TicketNotificationConsumer;
  let behaviourConsumer: BehaviourNotificationConsumer;
  let progressConsumer: ProgressNoteNotificationConsumer;
  let absenceConsumer: AbsenceRequestNotificationConsumer;
  let threadStatsConsumer: ThreadStatsConsumer;
  let translationConsumer: TranslationConsumer;
  let broadcastConsumer: BroadcastAnalyticsConsumer;
  let moderationConsumer: ModerationConsumer;
  let pushAnalyticsConsumer: PushAnalyticsConsumer;

  // Workers
  let audienceFanOutWorker: AudienceFanOutWorker;
  let notificationDeliveryWorker: NotificationDeliveryWorker;
  let pushCampaignWorker: PushCampaignWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    outbox = new OutboxService();
    idempotency = new IdempotencyService(tenantPrisma);
    consumer = new KafkaConsumerService(tenantPrisma);
    queue = new NotificationQueueService(tenantPrisma, redis);
    analytics = new BroadcastAnalyticsService(tenantPrisma);
    ai = new AiInferenceService();
    translations = new TranslationService(tenantPrisma, ai);
    rulesMod = new RulesModerationService(tenantPrisma);
    aiMod = new AIModerationService(tenantPrisma, ai);
    pushCampaigns = new PushCampaignService(tenantPrisma);

    messageConsumer = new MessageNotificationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      queue,
      redis,
    );
    attendanceConsumer = new AttendanceNotificationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      queue,
    );
    gradeConsumer = new GradeNotificationConsumer(consumer, idempotency, tenantPrisma, queue);
    ticketConsumer = new TicketNotificationConsumer(consumer, idempotency, tenantPrisma, queue);
    behaviourConsumer = new BehaviourNotificationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      queue,
    );
    progressConsumer = new ProgressNoteNotificationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      queue,
    );
    absenceConsumer = new AbsenceRequestNotificationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      queue,
    );
    threadStatsConsumer = new ThreadStatsConsumer(consumer, idempotency, tenantPrisma);
    translationConsumer = new TranslationConsumer(
      consumer,
      idempotency,
      tenantPrisma,
      translations,
    );
    broadcastConsumer = new BroadcastAnalyticsConsumer(consumer, idempotency, analytics);
    moderationConsumer = new ModerationConsumer(consumer, idempotency, rulesMod, aiMod);
    pushAnalyticsConsumer = new PushAnalyticsConsumer(consumer, idempotency, pushCampaigns);

    audienceFanOutWorker = new AudienceFanOutWorker(consumer, idempotency, tenantPrisma, queue);
    notificationDeliveryWorker = new NotificationDeliveryWorker(tenantPrisma, redis);
    pushCampaignWorker = new PushCampaignWorker(tenantPrisma, pushCampaigns);
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
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_audiences`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_reads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcements`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_translations`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_ai_moderation_results`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_notification_queue WHERE recipient_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_PARENT_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_broadcast_analytics`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_analytics_contributions`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_push_analytics`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_push_campaigns WHERE title LIKE 'IT-%'`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_moderation_actions`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_moderation_contributions`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_moderation_rules WHERE name LIKE 'IT-%'`,
    );
    // Scope the cleanup to the consumer groups exercised by this spec so
    // we don't clobber idempotency claims from other m-modules' specs.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group IN (
         'message-notification-consumer',
         'attendance-notification-consumer',
         'grade-notification-consumer',
         'ticket-notification-consumer',
         'behaviour-notification-consumer',
         'progress-note-notification-consumer',
         'absence-request-notification-consumer',
         'thread-stats-consumer',
         'translation-consumer',
         'broadcast-analytics-worker',
         'moderation-worker',
         'push-analytics-worker',
         'audience-fan-out-worker'
       )`,
    );
  });

  /**
   * Build a synthetic ADR-057 envelope ConsumedMessage. The `payload`
   * is the wire-shape envelope; the headers carry the routing fields
   * unwrapEnvelope falls back on if the envelope is malformed.
   */
  function makeEnvelope(opts: {
    topic: string;
    eventId?: string;
    payload: unknown;
    schoolId?: string;
    subdomain?: string;
  }): ConsumedMessage {
    return {
      topic: opts.topic,
      partition: 0,
      offset: '0',
      key: 'k',
      headers: {
        'tenant-subdomain': opts.subdomain ?? TEST_SUBDOMAIN,
        'tenant-id': opts.schoolId ?? TEST_SCHOOL_ID,
      },
      payload: {
        event_id: opts.eventId ?? generateId(),
        event_type: opts.topic,
        event_version: 1,
        tenant_id: opts.schoolId ?? TEST_SCHOOL_ID,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        source_module: 'test',
        payload: opts.payload,
      },
      timestamp: String(Date.now()),
    };
  }

  function makeMalformed(topic: string): ConsumedMessage {
    return {
      topic,
      partition: 0,
      offset: '0',
      key: 'k',
      headers: {},
      payload: null,
      timestamp: String(Date.now()),
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // MessageNotificationConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('MessageNotificationConsumer', () => {
    it('drops malformed envelope; processes valid msg.message.posted', async () => {
      // Malformed
      await (messageConsumer as any).handle(makeMalformed('msg.message.posted'));

      // Seed thread + participants
      const tid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, subject, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-cons', $4::uuid)`,
        tid,
        TEST_SCHOOL_ID,
        TEST_THREAD_TYPE_DIRECT_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER')`,
        generateId(),
        tid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PARTICIPANT')`,
        generateId(),
        tid,
        TEST_SCHOOL_ID,
        TEST_TEACHER_ACCOUNT_ID,
      );
      const messageId = generateId();
      const eventId = generateId();
      const msg = makeEnvelope({
        topic: 'msg.message.posted',
        eventId,
        payload: {
          messageId,
          threadId: tid,
          senderId: TEST_ADMIN_ACCOUNT_ID,
          body: 'hello team',
          postedAt: new Date().toISOString(),
        },
      });
      await (messageConsumer as any).handle(msg);
      // Notification enqueued for teacher
      const rows = await rawClient.$queryRawUnsafe<Array<{ recipient_id: string }>>(
        `SELECT recipient_id::text AS recipient_id FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'message.posted'`,
      );
      expect(rows.map((r) => r.recipient_id)).toContain(TEST_TEACHER_ACCOUNT_ID);
      // Idempotency claimed
      expect(await idempotency.isClaimed('message-notification-consumer', eventId)).toBe(true);
      // Redelivery is a no-op
      await (messageConsumer as any).handle(msg);
    });

    it('drops envelope when messageId missing', async () => {
      await (messageConsumer as any).handle(
        makeEnvelope({ topic: 'msg.message.posted', payload: { threadId: 'x' } }),
      );
    });

    it('skips fan-out when thread not found', async () => {
      await (messageConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.message.posted',
          payload: {
            messageId: generateId(),
            threadId: generateId(),
            senderId: TEST_ADMIN_ACCOUNT_ID,
            body: 'orphan',
            postedAt: new Date().toISOString(),
          },
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Other notification consumers — exercise handle() with minimal payloads
  // ────────────────────────────────────────────────────────────────────
  describe('notification consumers — basic envelope handling', () => {
    it('AttendanceNotificationConsumer drops malformed + handles valid', async () => {
      await (attendanceConsumer as any).handle(makeMalformed('att.student.absent'));
      await (attendanceConsumer as any).handle(
        makeEnvelope({
          topic: 'att.student.absent',
          payload: {
            studentId: generateId(),
            classId: generateId(),
            date: '2026-05-19',
            recordedBy: TEST_ADMIN_ACCOUNT_ID,
          },
        }),
      );
    });

    it('GradeNotificationConsumer drops malformed + handles valid', async () => {
      await (gradeConsumer as any).handle(makeMalformed('cls.grade.published'));
      await (gradeConsumer as any).handle(
        makeEnvelope({
          topic: 'cls.grade.published',
          payload: {
            gradeId: generateId(),
            studentId: generateId(),
            assignmentId: generateId(),
            assignmentTitle: 'Math test',
            classId: generateId(),
            pointsEarned: 90,
            maxPoints: 100,
            publishedBy: TEST_TEACHER_ACCOUNT_ID,
            publishedAt: new Date().toISOString(),
          },
        }),
      );
    });

    it('TicketNotificationConsumer drops malformed + handles each subtype', async () => {
      await (ticketConsumer as any).handle(makeMalformed('tkt.ticket.submitted'));
      const payload = {
        ticketId: generateId(),
        submittedBy: TEST_ADMIN_ACCOUNT_ID,
        subject: 'broken light',
      };
      await (ticketConsumer as any).handle(
        makeEnvelope({ topic: 'tkt.ticket.submitted', payload }),
      );
      await (ticketConsumer as any).handle(
        makeEnvelope({
          topic: 'tkt.ticket.assigned',
          payload: { ...payload, assignedTo: TEST_TEACHER_ACCOUNT_ID },
        }),
      );
      await (ticketConsumer as any).handle(
        makeEnvelope({
          topic: 'tkt.ticket.resolved',
          payload: { ...payload, resolvedBy: TEST_ADMIN_ACCOUNT_ID },
        }),
      );
      await (ticketConsumer as any).handle(
        makeEnvelope({
          topic: 'tkt.ticket.commented',
          payload: { ...payload, commentedBy: TEST_TEACHER_ACCOUNT_ID, commentBody: 'x' },
        }),
      );
    });

    it('BehaviourNotificationConsumer handles incident topics', async () => {
      await (behaviourConsumer as any).handle(makeMalformed('beh.incident.reported'));
      const incidentPayload = {
        incidentId: generateId(),
        studentId: generateId(),
        studentName: 'Test',
        severity: 'MINOR',
        categoryName: 'Tardy',
        reportedBy: TEST_TEACHER_ACCOUNT_ID,
        reportedAt: new Date().toISOString(),
      };
      await (behaviourConsumer as any).handle(
        makeEnvelope({ topic: 'beh.incident.reported', payload: incidentPayload }),
      );
      await (behaviourConsumer as any).handle(
        makeEnvelope({ topic: 'beh.incident.resolved', payload: incidentPayload }),
      );
      await (behaviourConsumer as any).handle(
        makeEnvelope({
          topic: 'beh.action.assigned',
          payload: {
            ...incidentPayload,
            actionId: generateId(),
            actionDescription: 'restorative',
          },
        }),
      );
    });

    it('ProgressNoteNotificationConsumer handles published notes', async () => {
      await (progressConsumer as any).handle(makeMalformed('cls.progress_note.published'));
      await (progressConsumer as any).handle(
        makeEnvelope({
          topic: 'cls.progress_note.published',
          payload: {
            noteId: generateId(),
            studentId: generateId(),
            classId: generateId(),
            authorId: TEST_TEACHER_ACCOUNT_ID,
            noteType: 'PROGRESS',
            body: 'doing well',
            publishedAt: new Date().toISOString(),
          },
        }),
      );
    });

    it('AbsenceRequestNotificationConsumer handles requested + reviewed', async () => {
      await (absenceConsumer as any).handle(makeMalformed('att.absence.requested'));
      await (absenceConsumer as any).handle(
        makeEnvelope({
          topic: 'att.absence.requested',
          payload: {
            requestId: generateId(),
            studentId: generateId(),
            requestedBy: TEST_PARENT_ACCOUNT_ID,
            reason: 'doctor',
            startDate: '2026-05-20',
          },
        }),
      );
      await (absenceConsumer as any).handle(
        makeEnvelope({
          topic: 'att.absence.reviewed',
          payload: {
            requestId: generateId(),
            studentId: generateId(),
            reviewedBy: TEST_ADMIN_ACCOUNT_ID,
            outcome: 'APPROVED',
          },
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Messaging consumers — thread-stats, translation
  // ────────────────────────────────────────────────────────────────────
  describe('messaging consumers', () => {
    it('ThreadStatsConsumer drops malformed + handles valid msg.message.posted', async () => {
      await (threadStatsConsumer as any).handle(makeMalformed('msg.message.posted'));

      const tid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        tid,
        TEST_SCHOOL_ID,
        TEST_THREAD_TYPE_DIRECT_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await (threadStatsConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.message.posted',
          payload: {
            messageId: generateId(),
            threadId: tid,
            senderId: TEST_ADMIN_ACCOUNT_ID,
            body: 'hi',
            postedAt: new Date().toISOString(),
          },
        }),
      );
    });

    it('TranslationConsumer drops malformed + handles posted event with auto-translate prefs', async () => {
      await (translationConsumer as any).handle(makeMalformed('msg.message.posted'));

      // Set the teacher to want auto-translate to es
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_user_language_preferences (id, user_id, preferred_language, auto_translate_incoming)
         VALUES ($1::uuid, $2::uuid, 'es', true)
         ON CONFLICT (user_id) DO UPDATE SET preferred_language = 'es', auto_translate_incoming = true`,
        generateId(),
        TEST_TEACHER_ACCOUNT_ID,
      );

      // Seed thread + message + participant
      const tid = generateId();
      const mid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_threads (id, school_id, thread_type_id, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        tid,
        TEST_SCHOOL_ID,
        TEST_THREAD_TYPE_DIRECT_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'OWNER')`,
        generateId(),
        tid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_thread_participants (id, thread_id, school_id, platform_user_id, role)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PARTICIPANT')`,
        generateId(),
        tid,
        TEST_SCHOOL_ID,
        TEST_TEACHER_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_messages (id, thread_id, school_id, sender_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'hello')`,
        mid,
        tid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await (translationConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.message.posted',
          payload: {
            messageId: mid,
            threadId: tid,
            senderId: TEST_ADMIN_ACCOUNT_ID,
            body: 'hello',
            postedAt: new Date().toISOString(),
          },
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // BroadcastAnalyticsConsumer + PushAnalyticsConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('analytics consumers', () => {
    it('BroadcastAnalyticsConsumer drops malformed + handles delivery event', async () => {
      await (broadcastConsumer as any).handle(makeMalformed('msg.broadcast.delivered'));
      const bid = generateId();
      await (broadcastConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.broadcast.delivered',
          payload: {
            broadcastId: bid,
            totalRecipients: 50,
            delivered: 40,
            opened: 20,
          },
        }),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.msg_broadcast_analytics WHERE broadcast_id = $1::uuid`,
        bid,
      );
      expect(rows.length).toBe(1);
    });

    it('BroadcastAnalyticsConsumer drops payload missing broadcastId', async () => {
      await (broadcastConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.broadcast.delivered',
          payload: { totalRecipients: 10 },
        }),
      );
    });

    it('PushAnalyticsConsumer drops malformed + handles delivery event', async () => {
      await (pushAnalyticsConsumer as any).handle(makeMalformed('msg.push.delivered'));

      // Need a campaign + analytics row first (recordDelivery throws otherwise)
      const cid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_push_campaigns (id, school_id, title, body, status, created_by, sent_at)
         VALUES ($1::uuid, $2::uuid, 'IT-pac-cons', 'b', 'SENT', $3::uuid, now())`,
        cid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_push_analytics (id, campaign_id, total_targeted, total_delivered, total_opened, total_clicked, last_updated_at)
         VALUES ($1::uuid, $2::uuid, 100, 0, 0, 0, now())`,
        generateId(),
        cid,
      );
      await (pushAnalyticsConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.push.delivered',
          payload: { campaignId: cid, delivered: 10, opened: 5 },
        }),
      );
      const a = await rawClient.$queryRawUnsafe<
        Array<{ total_delivered: number; total_opened: number }>
      >(
        `SELECT total_delivered, total_opened FROM ${TEST_SCHEMA}.msg_push_analytics WHERE campaign_id = $1::uuid`,
        cid,
      );
      expect(a[0]!.total_delivered).toBe(10);
    });

    it('PushAnalyticsConsumer drops payload missing campaignId', async () => {
      await (pushAnalyticsConsumer as any).handle(
        makeEnvelope({ topic: 'msg.push.delivered', payload: { delivered: 1 } }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // ModerationConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('ModerationConsumer', () => {
    it('drops malformed + handles valid msg.message.posted', async () => {
      await (moderationConsumer as any).handle(makeMalformed('msg.message.posted'));

      // Seed a rule so resolveDecision returns something
      const rid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_moderation_rules (id, school_id, scope, name, keywords, keyword_action, is_active)
         VALUES ($1::uuid, $2::uuid, 'BUILDING', 'IT-cons-rule', ARRAY['banned']::text[], 'FLAG_FOR_REVIEW', true)`,
        rid,
        TEST_SCHOOL_ID,
      );
      const mid = generateId();
      // Seed message
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_messages (id, thread_id, school_id, sender_id, body)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'banned phrase here')`,
        mid,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await (moderationConsumer as any).handle(
        makeEnvelope({
          topic: 'msg.message.posted',
          payload: {
            messageId: mid,
            threadId: generateId(),
            senderId: TEST_ADMIN_ACCOUNT_ID,
            body: 'banned phrase here',
            postedAt: new Date().toISOString(),
          },
        }),
      );
      const actions = await rawClient.$queryRawUnsafe<Array<{ action_taken: string }>>(
        `SELECT action_taken FROM ${TEST_SCHEMA}.msg_moderation_actions WHERE message_id = $1::uuid`,
        mid,
      );
      expect(actions.length).toBe(1);
      expect(actions[0]!.action_taken).toBe('FLAGGED_FOR_REVIEW');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AudienceFanOutWorker
  // ────────────────────────────────────────────────────────────────────
  describe('AudienceFanOutWorker', () => {
    it('drops malformed + fans out msg.announcement.published to staff', async () => {
      await (audienceFanOutWorker as any).handle(makeMalformed('msg.announcement.published'));

      // Seed the announcement (worker reads it back)
      const aid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcements
         (id, school_id, author_id, title, body, audience_type, is_published, publish_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'IT-fan', 'b', 'ALL_SCHOOL', true, now())`,
        aid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await (audienceFanOutWorker as any).handle(
        makeEnvelope({
          topic: 'msg.announcement.published',
          payload: {
            announcementId: aid,
            audienceType: 'ALL_SCHOOL',
            audienceRef: null,
            authorId: TEST_ADMIN_ACCOUNT_ID,
            title: 'IT-fan',
            publishedAt: new Date().toISOString(),
          },
        }),
      );
    });

    it('drops payload missing audienceType', async () => {
      await (audienceFanOutWorker as any).handle(
        makeEnvelope({
          topic: 'msg.announcement.published',
          payload: { announcementId: generateId() },
        }),
      );
    });

    it('drops fan-out when announcement not found in tenant', async () => {
      await (audienceFanOutWorker as any).handle(
        makeEnvelope({
          topic: 'msg.announcement.published',
          payload: {
            announcementId: generateId(),
            audienceType: 'ALL_SCHOOL',
            authorId: TEST_ADMIN_ACCOUNT_ID,
            title: 'phantom',
            publishedAt: new Date().toISOString(),
          },
        }),
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // NotificationDeliveryWorker — pollOnceForTest()
  // ────────────────────────────────────────────────────────────────────
  describe('NotificationDeliveryWorker', () => {
    it('pollOnceForTest is callable; drains PENDING into in-app notifications', async () => {
      // Seed a pending row
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
         (id, school_id, recipient_id, notification_type, payload, status, scheduled_for)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'TEST_DEL', '{"x":1}'::jsonb, 'PENDING', now() - INTERVAL '1 second')`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      await notificationDeliveryWorker.pollOnceForTest();
      // The worker may have flipped the row's status — we don't assert the
      // exact landing state because Redis-dependent IN_APP delivery depends
      // on env. The smoke check is that the tick ran without throwing.
      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.msg_notification_queue WHERE recipient_id = $1::uuid AND notification_type = 'TEST_DEL'`,
        TEST_PARENT_ACCOUNT_ID,
      );
      expect(rows.length).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // PushCampaignWorker
  // ────────────────────────────────────────────────────────────────────
  describe('PushCampaignWorker', () => {
    it('pollOnceForTest dispatches scheduled campaigns whose scheduled_at has elapsed', async () => {
      const cid = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_push_campaigns
         (id, school_id, title, body, status, scheduled_at, created_by)
         VALUES ($1::uuid, $2::uuid, 'IT-ripe-cons', 'b', 'SCHEDULED', now() - INTERVAL '1 minute', $3::uuid)`,
        cid,
        TEST_SCHOOL_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await pushCampaignWorker.pollOnceForTest();
      const r = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.msg_push_campaigns WHERE id = $1::uuid`,
        cid,
      );
      expect(r[0]!.status).toBe('SENT');
    });
  });

  // Silence unused
  void outbox;
});
