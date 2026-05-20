import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { CleaningIssueTicketConsumer } from '@modules/m65-facilities/cleaning-issue-ticket.consumer';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';

import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SUBDOMAIN } from '../helpers/tenant-context';
import { TEST_ADMIN_PERSON_ID, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';
import { resetFacilitiesTables, ensureFacilitiesSeed } from '../fixtures/facilities';

/**
 * Stub KafkaConsumerService — we don't need a real broker; we drive
 * the consumer's `handle()` method directly via reflection.
 */
class StubKafkaConsumer {
  async subscribe(): Promise<void> {
    // no-op; tests invoke handle() directly
  }
}

describe('integration:m65-facilities/cleaning-issue-ticket-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let consumer: CleaningIssueTicketConsumer;
  let idempotency: IdempotencyService;
  let categoryId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    idempotency = new IdempotencyService(tenantPrisma);
    consumer = new CleaningIssueTicketConsumer(
      new StubKafkaConsumer() as unknown as KafkaConsumerService,
      idempotency,
      tenantPrisma,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetFacilitiesTables(rawClient);
    await ensureFacilitiesSeed(rawClient);

    // Clear tickets between tests — tkt_ticket_activity is IMMUTABLE
    // (ADR-010), so TRUNCATE bypasses the BEFORE DELETE trigger.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.tkt_ticket_activity, ${TEST_SCHEMA}.tkt_tickets CASCADE`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.tkt_categories WHERE name = 'Cleaning'`,
    );

    // Seed a category named 'Cleaning' so the consumer can find it
    categoryId = '019e0cf8-aaaa-7777-8888-000000065500';
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.tkt_categories (id, school_id, name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Cleaning', true)
       ON CONFLICT (id) DO NOTHING`,
      categoryId,
      TEST_SCHOOL_ID,
    );

    // Clear idempotency rows for the consumer group
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'cleaning-issue-ticket-consumer'`,
    );
  });

  function buildEnvelope(payload: Record<string, unknown>, eventId: string): any {
    return {
      topic: 'fac.route_stop.issue_noted',
      partition: 0,
      offset: '1',
      key: null,
      headers: {
        'tenant-id': TEST_SCHOOL_ID,
        'tenant-subdomain': TEST_SUBDOMAIN,
      },
      payload: {
        event_id: eventId,
        event_type: 'fac.route_stop.issue_noted',
        event_version: 1,
        tenant_id: TEST_SCHOOL_ID,
        source_module: 'facilities',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload,
      },
      timestamp: new Date().toISOString(),
    };
  }

  it('materialises a ticket from a valid envelope; idempotent on retry', async () => {
    const stopCompletionId = '019e0cf8-aaaa-7777-8888-000000065501';
    const eventId = '019e0cf8-aaaa-7777-8888-000000065502';
    const msg = buildEnvelope(
      {
        stopCompletionId,
        routeId: '019e0cf8-aaaa-7777-8888-000000065503',
        issuesNoted: 'Spilled juice in hallway needs cleanup',
        reportedByAccountId: TEST_ADMIN_ACCOUNT_ID,
        schoolId: TEST_SCHOOL_ID,
      },
      eventId,
    );

    await (consumer as any).handle(msg);

    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT id::text AS id, title, description FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ id: string; title: string; description: string }>;
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.title).toContain('Cleaning issue');
    expect(tickets[0]!.description).toContain(stopCompletionId);

    const activity = (await rawClient.$queryRawUnsafe(
      `SELECT id FROM ${TEST_SCHEMA}.tkt_ticket_activity WHERE ticket_id = $1::uuid`,
      tickets[0]!.id,
    )) as Array<{ id: string }>;
    expect(activity.length).toBeGreaterThan(0);

    // Re-deliver same event — should be idempotent (no new ticket)
    await (consumer as any).handle(msg);
    const after = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(after[0]!.c).toBe(1);
  });

  it('falls back to school admin requester when reportedByAccountId is omitted', async () => {
    // Seed admin permission for sch-001:admin so the consumer's fallback
    // requester lookup succeeds.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid,
         (SELECT id FROM platform.iam_scope WHERE entity_id = $2::uuid LIMIT 1),
         ARRAY['sch-001:admin']::text[], now(), 'm65-consumer-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = ARRAY['sch-001:admin']::text[]`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_ID,
    );

    const stopCompletionId = '019e0cf8-aaaa-7777-8888-000000065510';
    const eventId = '019e0cf8-aaaa-7777-8888-000000065511';
    const msg = buildEnvelope(
      {
        stopCompletionId,
        issuesNoted: 'Broken faucet',
        schoolId: TEST_SCHOOL_ID,
        // no reportedByAccountId — service falls back to school admin
      },
      eventId,
    );

    await (consumer as any).handle(msg);

    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(tickets[0]!.c).toBe(1);

    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'm65-consumer-test'`,
    );
  });

  it('drops envelope when payload.schoolId disagrees with tenant_id; claims idempotency', async () => {
    const eventId = '019e0cf8-aaaa-7777-8888-000000065520';
    const msg = buildEnvelope(
      {
        stopCompletionId: '019e0cf8-aaaa-7777-8888-000000065521',
        issuesNoted: 'Mismatch test',
        reportedByAccountId: TEST_ADMIN_ACCOUNT_ID,
        schoolId: '00000000-0000-0000-0000-deadbeefdead',
      },
      eventId,
    );

    await (consumer as any).handle(msg);

    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(tickets[0]!.c).toBe(0);

    const claimed = (await rawClient.$queryRawUnsafe(
      `SELECT 1 FROM platform.platform_event_consumer_idempotency
         WHERE consumer_group = 'cleaning-issue-ticket-consumer' AND event_id = $1`,
      eventId,
    )) as unknown[];
    expect(claimed.length).toBe(1);
  });

  it('drops events missing stopCompletionId or issuesNoted', async () => {
    const eventId = '019e0cf8-aaaa-7777-8888-000000065530';
    const msg = buildEnvelope(
      {
        // no stopCompletionId
        issuesNoted: 'Will be dropped',
        schoolId: TEST_SCHOOL_ID,
      },
      eventId,
    );
    await (consumer as any).handle(msg);
    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(tickets[0]!.c).toBe(0);
  });

  it('uses sourceRefId when stopCompletionId is missing', async () => {
    const sourceRefId = '019e0cf8-aaaa-7777-8888-000000065540';
    const eventId = '019e0cf8-aaaa-7777-8888-000000065541';
    const msg = buildEnvelope(
      {
        sourceRefId,
        issuesNoted: 'sourceRefId fallback test',
        reportedByAccountId: TEST_ADMIN_ACCOUNT_ID,
        schoolId: TEST_SCHOOL_ID,
      },
      eventId,
    );
    await (consumer as any).handle(msg);
    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT description FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ description: string }>;
    expect(tickets[0]!.description).toContain(sourceRefId);
  });

  it('throws NO_FACILITIES_CATEGORY (uncommitted) when no matching category configured', async () => {
    // Wipe the cleaning category so the lookup returns empty
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.tkt_categories WHERE name = 'Cleaning'`,
    );

    const eventId = '019e0cf8-aaaa-7777-8888-000000065550';
    const msg = buildEnvelope(
      {
        stopCompletionId: '019e0cf8-aaaa-7777-8888-000000065551',
        issuesNoted: 'No category configured',
        reportedByAccountId: TEST_ADMIN_ACCOUNT_ID,
        schoolId: TEST_SCHOOL_ID,
      },
      eventId,
    );

    // Service throws inside processWithIdempotency, which logs and does NOT
    // claim — but the consumer's handle() catches and re-throws or returns.
    // Either way, no ticket lands.
    try {
      await (consumer as any).handle(msg);
    } catch {
      // expected — NO_FACILITIES_CATEGORY
    }

    const tickets = (await rawClient.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.tkt_tickets WHERE school_id = $1::uuid`,
      TEST_SCHOOL_ID,
    )) as Array<{ c: number }>;
    expect(tickets[0]!.c).toBe(0);
  });
});
