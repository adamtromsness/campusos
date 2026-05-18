import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GlReconciliationAlertConsumer } from '@modules/m83-finance/gl-reconciliation-alert.consumer';
import { NotificationQueueService } from '@modules/m40-communications/notifications/notification-queue.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService, KafkaConsumerService } from '@shared/kafka';
import type { ConsumedMessage } from '@shared/kafka';
import { RedisService } from '@shared/cache';

import {
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import { TEST_SCHOOL_SCOPE_ID, TEST_SCHOOL_B_SCOPE_ID } from '../fixtures/platform';

const CONSUMER_GROUP = 'gl-reconciliation-alert-consumer';
const TOPIC = 'dev.fin.gl_reconciliation.discrepancy';

/**
 * DB-backed integration tests for GlReconciliationAlertConsumer.
 *
 * Drives the consumer's private handle() via bracket access to avoid
 * the Kafka broker round trip. Verifies:
 *
 *   - msg_notification_queue rows are enqueued for every school admin
 *   - platform_audit_log SYSTEM row is written with the discrepancy
 *     metadata so PagerDuty / alertmanager polls catch it
 *   - processWithIdempotency claims the (group, eventId) pair on
 *     success; redelivery is a no-op
 *   - missing routing fields (no event-id, no tenant header) → drop
 *   - school scoping: only admins for the event's school get notified
 */
describe('integration:m83-finance/gl-reconciliation-alert-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let redis: RedisService;
  let queue: NotificationQueueService;
  let idempotency: IdempotencyService;
  let kafkaConsumer: KafkaConsumerService;
  let consumer: GlReconciliationAlertConsumer;

  // Two test admin accounts to verify fan-out per school
  const SCHOOL_ADMIN_A_ID = '019e3a70-1111-7777-8888-000000000001';
  const SCHOOL_ADMIN_A_PERSON_ID = '019e3a70-1111-7777-8888-000000000002';
  const SCHOOL_ADMIN_B_ID = '019e3a70-1111-7777-8888-000000000003';
  const SCHOOL_ADMIN_B_PERSON_ID = '019e3a70-1111-7777-8888-000000000004';

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    queue = new NotificationQueueService(tenantPrisma, redis);
    idempotency = new IdempotencyService(tenantPrisma);
    kafkaConsumer = new KafkaConsumerService(tenantPrisma);
    // Don't call onModuleInit on the consumer — we drive handle() directly.
    consumer = new GlReconciliationAlertConsumer(kafkaConsumer, idempotency, tenantPrisma, queue);

    // Seed two admin accounts (one per school) with sch-001:admin
    for (const [personId, accountId, label] of [
      [SCHOOL_ADMIN_A_PERSON_ID, SCHOOL_ADMIN_A_ID, 'AdminA'],
      [SCHOOL_ADMIN_B_PERSON_ID, SCHOOL_ADMIN_B_ID, 'AdminB'],
    ] as const) {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'School', $2, 'STAFF', true)
         ON CONFLICT (id) DO NOTHING`,
        personId,
        label,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
        accountId,
        personId,
        label.toLowerCase() + '@test.integration.local',
        'School ' + label,
      );
    }
  });

  afterAll(async () => {
    // Clean up test admin grants
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      SCHOOL_ADMIN_A_ID,
      SCHOOL_ADMIN_B_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id IN ($1::uuid, $2::uuid)`,
      SCHOOL_ADMIN_A_ID,
      SCHOOL_ADMIN_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = $1`,
      CONSUMER_GROUP,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_audit_log WHERE action = 'fin.gl_reconciliation.alert'`,
    );
  });

  async function grantAdminAt(accountId: string, scopeId: string): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'test-hash')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      accountId,
      scopeId,
      ['sch-001:admin'],
    );
  }

  function buildMessage(
    overrides: {
      schoolId?: string;
      subdomain?: string;
      eventId?: string;
      reconciliationRunId?: string;
      omitEventId?: boolean;
      omitTenantId?: boolean;
      omitSubdomain?: boolean;
    } = {},
  ): ConsumedMessage {
    const schoolId = overrides.schoolId ?? TEST_SCHOOL_ID;
    const subdomain = overrides.subdomain ?? TEST_SUBDOMAIN;
    const eventId = overrides.eventId ?? generateId();
    const reconciliationRunId = overrides.reconciliationRunId ?? generateId();
    const headers: Record<string, string> = {};
    if (!overrides.omitEventId) headers['event-id'] = eventId;
    if (!overrides.omitTenantId) headers['tenant-id'] = schoolId;
    if (!overrides.omitSubdomain) headers['tenant-subdomain'] = subdomain;
    return {
      topic: TOPIC,
      partition: 0,
      key: reconciliationRunId,
      headers,
      payload: {
        event_id: eventId,
        event_type: 'fin.gl_reconciliation.discrepancy',
        tenant_id: schoolId,
        source_module: 'finance.gl_reconciliation',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload: {
          reconciliationRunId,
          schoolId,
          checkType: 'DAILY_TRIAL_BALANCE',
          discrepancyCount: 3,
          status: 'DISCREPANCIES_FOUND',
          severity: 'HIGH',
          discrepancies: [
            { accountId: generateId(), gl: 100, expected: 95 },
            { accountId: generateId(), gl: 50, expected: 45 },
            { accountId: generateId(), gl: 200, expected: 195 },
          ],
          detectedAt: new Date().toISOString(),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  describe('handle', () => {
    it('enqueues one notification per school admin + writes SYSTEM audit row', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      const msg = buildMessage();
      // Call private handle() via bracket access
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);

      // Notification row enqueued for AdminA
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT recipient_id::text AS recipient_id, payload::text AS payload
           FROM ${TEST_SCHEMA}.msg_notification_queue
          WHERE notification_type = 'finance.gl_reconciliation.alert'
          ORDER BY created_at DESC`,
      )) as Array<{ recipient_id: string; payload: string }>;
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      const adminANotif = notifs.find((n) => n.recipient_id === SCHOOL_ADMIN_A_ID);
      expect(adminANotif).toBeDefined();
      const parsed = JSON.parse(adminANotif!.payload);
      expect(parsed.discrepancyCount).toBe(3);
      expect(parsed.severity).toBe('HIGH');
      expect(parsed.firstDiscrepancies).toHaveLength(3);
      expect(parsed.deepLink).toContain('/finance/reconciliation/');

      // Audit log row
      const auditRows = (await rawClient.$queryRawUnsafe(
        `SELECT actor_type, action, entity_type, metadata::text AS metadata
           FROM platform.platform_audit_log
          WHERE action = 'fin.gl_reconciliation.alert'`,
      )) as Array<{
        actor_type: string;
        action: string;
        entity_type: string;
        metadata: string;
      }>;
      expect(auditRows.length).toBeGreaterThanOrEqual(1);
      expect(auditRows[0]!.actor_type).toBe('SYSTEM');
      expect(auditRows[0]!.entity_type).toBe('rpt_gl_reconciliation');
      const meta = JSON.parse(auditRows[0]!.metadata);
      expect(meta.discrepancyCount).toBe(3);
      expect(meta.severity).toBe('HIGH');
    });

    it('school scoping — only admins for the event school are notified', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      await grantAdminAt(SCHOOL_ADMIN_B_ID, TEST_SCHOOL_B_SCOPE_ID);
      const msg = buildMessage({ schoolId: TEST_SCHOOL_ID });
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);

      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT recipient_id::text AS recipient_id
           FROM ${TEST_SCHEMA}.msg_notification_queue
          WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ recipient_id: string }>;
      const recipients = notifs.map((n) => n.recipient_id);
      expect(recipients).toContain(SCHOOL_ADMIN_A_ID);
      expect(recipients).not.toContain(SCHOOL_ADMIN_B_ID);
    });

    it('PLATFORM-scoped admin gets notified for any school', async () => {
      // Grant the admin sch-001:admin at the PLATFORM scope
      const platformScopeRows = (await rawClient.$queryRawUnsafe(
        `SELECT s.id::text AS id FROM platform.iam_scope s
           JOIN platform.iam_scope_type st ON st.id = s.scope_type_id
          WHERE st.code = 'PLATFORM' LIMIT 1`,
      )) as Array<{ id: string }>;
      if (platformScopeRows.length === 0) {
        // No platform scope seeded — skip this assertion
        return;
      }
      await grantAdminAt(SCHOOL_ADMIN_A_ID, platformScopeRows[0]!.id);
      const msg = buildMessage({ schoolId: TEST_SCHOOL_ID });
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);

      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT recipient_id::text AS recipient_id
           FROM ${TEST_SCHEMA}.msg_notification_queue
          WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ recipient_id: string }>;
      const recipients = notifs.map((n) => n.recipient_id);
      expect(recipients).toContain(SCHOOL_ADMIN_A_ID);
    });

    it('claims the eventId after success; second handle is a no-op', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      const eventId = generateId();
      const msg = buildMessage({ eventId });
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);

      // Idempotency row created
      const claim = (await rawClient.$queryRawUnsafe(
        `SELECT 1 AS ok FROM platform.platform_event_consumer_idempotency
          WHERE consumer_group = $1 AND event_id = $2`,
        CONSUMER_GROUP,
        eventId,
      )) as Array<{ ok: number }>;
      expect(claim.length).toBe(1);

      // Wipe queue rows to detect re-enqueue
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      );

      // Replay the same message — should be a no-op
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      const reAfter = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ n: number }>;
      expect(reAfter[0]!.n).toBe(0);
    });

    it('missing event-id header → drop (no claim, no notifications)', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      // Strip envelope event_id AND header to fully omit
      const msg = buildMessage({ omitEventId: true });
      // Also strip envelope event_id
      (msg.payload as Record<string, unknown>).event_id = undefined;
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ n: number }>;
      expect(notifs[0]!.n).toBe(0);
    });

    it('missing tenant-subdomain header → drop', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      const msg = buildMessage({ omitSubdomain: true });
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ n: number }>;
      expect(notifs[0]!.n).toBe(0);
    });

    it('missing tenant-id header AND envelope tenant_id → drop', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      const msg = buildMessage({ omitTenantId: true });
      (msg.payload as Record<string, unknown>).tenant_id = undefined;
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ n: number }>;
      expect(notifs[0]!.n).toBe(0);
    });

    it('falls back to envelope-only event_id when headers absent', async () => {
      await grantAdminAt(SCHOOL_ADMIN_A_ID, TEST_SCHOOL_SCOPE_ID);
      // Build with no event-id header but envelope carries event_id
      const eventId = generateId();
      const msg = buildMessage({ eventId, omitEventId: true });
      // event_id stays in payload from buildMessage
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      // AdminA should have received a notification — verify by recipient
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT recipient_id::text AS recipient_id FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ recipient_id: string }>;
      expect(notifs.find((n) => n.recipient_id === SCHOOL_ADMIN_A_ID)).toBeDefined();
    });

    it('audit row written even when only seeded platform-admin recipients exist', async () => {
      // No additional admin grant — but the seed's Platform Admin holds
      // sch-001:admin at PLATFORM scope, so the explicit audit-log
      // fallback always fires regardless.
      const msg = buildMessage();
      await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
      // AdminA / AdminB without grants should NOT receive notifications
      const notifs = (await rawClient.$queryRawUnsafe(
        `SELECT recipient_id::text AS recipient_id FROM ${TEST_SCHEMA}.msg_notification_queue WHERE notification_type = 'finance.gl_reconciliation.alert'`,
      )) as Array<{ recipient_id: string }>;
      expect(notifs.find((n) => n.recipient_id === SCHOOL_ADMIN_A_ID)).toBeUndefined();
      expect(notifs.find((n) => n.recipient_id === SCHOOL_ADMIN_B_ID)).toBeUndefined();
      // Audit row written
      const auditRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.platform_audit_log WHERE action = 'fin.gl_reconciliation.alert'`,
      )) as Array<{ n: number }>;
      expect(auditRows[0]!.n).toBeGreaterThanOrEqual(1);
    });
  });
});
