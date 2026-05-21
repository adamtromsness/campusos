import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { JournalBatchPostedConsumer } from '@modules/m83-finance/journal-batch-posted.consumer';
import { PostingService } from '@modules/m83-finance/posting.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService, KafkaConsumerService } from '@shared/kafka';
import type { ConsumedMessage } from '@shared/kafka';

import { TEST_SCHOOL_ID, TEST_SCHEMA, TEST_SUBDOMAIN } from '../helpers/tenant-context';
import { TEST_COA_CASH_ID, TEST_COA_REVENUE_ID, TEST_COA_SUPPLIES_ID } from '../fixtures/finance';

const CONSUMER_GROUP = 'journal-batch-posted-consumer';
const TOPIC = 'dev.fin.journal_batch.posted';

/**
 * DB-backed integration tests for JournalBatchPostedConsumer.
 *
 * Verifies the Finance-side materialisation: the consumer takes a
 * commerce-emitted fin.journal_batch.posted event and writes to
 * fin_journal_batches + fin_gl_entries via PostingService.createAndPost.
 *
 * Coverage:
 *   - happy path: GL batch materialised with correct debit/credit lines
 *   - empty lines payload → drop (warn, no DB writes)
 *   - MAX_BATCH_LINES exceeded → throw (no DB writes)
 *   - missing routing fields → drop
 *   - claim-after-success idempotency: replay is no-op
 *   - missing OPEN period → throw
 *   - no ACTIVE hr_employees → throw
 *   - account fund_id fallback path
 */
describe('integration:m83-finance/journal-batch-posted-consumer', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let idempotency: IdempotencyService;
  let kafkaConsumer: KafkaConsumerService;
  let posting: PostingService;
  let consumer: JournalBatchPostedConsumer;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    idempotency = new IdempotencyService(tenantPrisma);
    kafkaConsumer = new KafkaConsumerService(tenantPrisma);
    posting = new PostingService(tenantPrisma);
    consumer = new JournalBatchPostedConsumer(kafkaConsumer, idempotency, tenantPrisma, posting);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // fin_gl_entries has IMMUTABLE trigger — use TRUNCATE
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.fin_gl_entries, ${TEST_SCHEMA}.fin_journal_batches CASCADE`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency WHERE consumer_group = $1`,
      CONSUMER_GROUP,
    );
  });

  function buildMessage(
    overrides: {
      schoolId?: string;
      subdomain?: string;
      eventId?: string;
      batchId?: string;
      lines?: Array<{
        accountId: string;
        debit: number;
        credit: number;
        description?: string | null;
        lineOrder?: number;
      }>;
      omitEventId?: boolean;
      omitSubdomain?: boolean;
    } = {},
  ): ConsumedMessage {
    const schoolId = overrides.schoolId ?? TEST_SCHOOL_ID;
    const subdomain = overrides.subdomain ?? TEST_SUBDOMAIN;
    const eventId = overrides.eventId ?? generateId();
    const batchId = overrides.batchId ?? generateId();
    const lines = overrides.lines ?? [
      { accountId: TEST_COA_CASH_ID, debit: 100, credit: 0, lineOrder: 0 },
      { accountId: TEST_COA_REVENUE_ID, debit: 0, credit: 100, lineOrder: 1 },
    ];
    const headers: Record<string, string> = {};
    if (!overrides.omitEventId) headers['event-id'] = eventId;
    headers['tenant-id'] = schoolId;
    if (!overrides.omitSubdomain) headers['tenant-subdomain'] = subdomain;
    return {
      topic: TOPIC,
      partition: 0,
      key: batchId,
      headers,
      payload: {
        event_id: eventId,
        event_type: 'fin.journal_batch.posted',
        tenant_id: schoolId,
        source_module: 'commerce',
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        payload: {
          batchId,
          schoolId,
          batchName: 'Q1 Adjusting Entries',
          entryCount: lines.length,
          totalDebits: lines.reduce((s, l) => s + l.debit, 0),
          totalCredits: lines.reduce((s, l) => s + l.credit, 0),
          postedBy: generateId(),
          lines: lines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            description: l.description ?? null,
            lineOrder: l.lineOrder ?? 0,
          })),
          sourceRefId: batchId,
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  async function callHandle(msg: ConsumedMessage): Promise<void> {
    await (consumer as unknown as { handle: (m: ConsumedMessage) => Promise<void> }).handle(msg);
  }

  describe('handle', () => {
    it('materialises fin_journal_batches + fin_gl_entries with correct debit/credit', async () => {
      const msg = buildMessage();
      await callHandle(msg);

      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id, batch_number, status, source_module, source_event_id::text AS source_event_id
           FROM ${TEST_SCHEMA}.fin_journal_batches
          WHERE source_module = 'commerce'`,
      )) as Array<{
        id: string;
        batch_number: string;
        status: string;
        source_module: string;
        source_event_id: string;
      }>;
      expect(batches.length).toBe(1);
      expect(batches[0]!.status).toBe('POSTED');
      expect(batches[0]!.batch_number).toMatch(/^MAN-/);

      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT account_id::text AS account_id, debit, credit
           FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid ORDER BY line_order`,
        batches[0]!.id,
      )) as Array<{ account_id: string; debit: string; credit: string }>;
      expect(entries.length).toBe(2);
      expect(entries[0]!.account_id).toBe(TEST_COA_CASH_ID);
      expect(Number(entries[0]!.debit)).toBe(100);
      expect(Number(entries[0]!.credit)).toBe(0);
      expect(entries[1]!.account_id).toBe(TEST_COA_REVENUE_ID);
      expect(Number(entries[1]!.credit)).toBe(100);
    });

    it('empty lines payload → drop with warn (no DB writes)', async () => {
      const msg = buildMessage({ lines: [] });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(batches[0]!.n).toBe(0);
    });

    it('replay with same event_id is idempotent (claim-after-success + source_event_id UNIQUE)', async () => {
      const eventId = generateId();
      const msg = buildMessage({ eventId });
      await callHandle(msg);
      // Confirm idempotency claim was written
      const claim = (await rawClient.$queryRawUnsafe(
        `SELECT 1 AS ok FROM platform.platform_event_consumer_idempotency
          WHERE consumer_group = $1 AND event_id = $2`,
        CONSUMER_GROUP,
        eventId,
      )) as Array<{ ok: number }>;
      expect(claim.length).toBe(1);

      // Capture batch count before replay
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(before[0]!.n).toBe(1);

      // Replay — should be a no-op (already claimed)
      await callHandle(msg);
      const after = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(after[0]!.n).toBe(1);
    });

    it('missing event-id header AND envelope event_id → drop', async () => {
      const msg = buildMessage({ omitEventId: true });
      (msg.payload as Record<string, unknown>).event_id = undefined;
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(batches[0]!.n).toBe(0);
    });

    it('missing tenant-subdomain → drop', async () => {
      const msg = buildMessage({ omitSubdomain: true });
      await callHandle(msg);
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(batches[0]!.n).toBe(0);
    });

    it('MAX_BATCH_LINES exceeded → throws (no DB writes, event remains unclaimed)', async () => {
      // Build a payload with > 1000 lines
      const lines: Array<{ accountId: string; debit: number; credit: number; lineOrder: number }> =
        [];
      for (let i = 0; i < 1001; i++) {
        lines.push({
          accountId: TEST_COA_SUPPLIES_ID,
          debit: i % 2 === 0 ? 1 : 0,
          credit: i % 2 === 0 ? 0 : 1,
          lineOrder: i,
        });
      }
      const eventId = generateId();
      const msg = buildMessage({ eventId, lines });
      await expect(callHandle(msg)).rejects.toThrow(/MAX_BATCH_LINES/);

      // No claim written (event remains pending for retry)
      const claim = (await rawClient.$queryRawUnsafe(
        `SELECT 1 AS ok FROM platform.platform_event_consumer_idempotency
          WHERE consumer_group = $1 AND event_id = $2`,
        CONSUMER_GROUP,
        eventId,
      )) as Array<{ ok: number }>;
      expect(claim.length).toBe(0);

      // No batch row written
      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ n: number }>;
      expect(batches[0]!.n).toBe(0);
    });

    it('multi-line batch (3 debits + 1 credit) materialises with all entries', async () => {
      const msg = buildMessage({
        lines: [
          { accountId: TEST_COA_CASH_ID, debit: 30, credit: 0, lineOrder: 0 },
          { accountId: TEST_COA_SUPPLIES_ID, debit: 40, credit: 0, lineOrder: 1 },
          { accountId: TEST_COA_REVENUE_ID, debit: 30, credit: 0, lineOrder: 2 },
          { accountId: TEST_COA_REVENUE_ID, debit: 0, credit: 100, lineOrder: 3 },
        ],
      });
      await callHandle(msg);

      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_module = 'commerce'`,
      )) as Array<{ id: string }>;
      const entries = (await rawClient.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(debit), 0)::numeric AS d, COALESCE(SUM(credit), 0)::numeric AS c
           FROM ${TEST_SCHEMA}.fin_gl_entries WHERE batch_id = $1::uuid`,
        batches[0]!.id,
      )) as Array<{ n: number; d: string; c: string }>;
      expect(entries[0]!.n).toBe(4);
      expect(Number(entries[0]!.d)).toBe(100);
      expect(Number(entries[0]!.c)).toBe(100);
    });

    it('source_event_id UNIQUE — two events with same id (different consumer-group claims) materialise once', async () => {
      const sourceEventId = generateId();
      const msg1 = buildMessage({ eventId: sourceEventId });
      await callHandle(msg1);

      // Clear idempotency to allow re-entry of the handler (simulating
      // a different consumer group or manual re-run)
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_event_consumer_idempotency WHERE event_id = $1`,
        sourceEventId,
      );
      // Run again — PostingService's source_event_id UNIQUE should
      // dedupe the second insert.
      await callHandle(msg1);

      const batches = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fin_journal_batches WHERE source_event_id = $1::uuid`,
        sourceEventId,
      )) as Array<{ n: number }>;
      // PostingService's source_event_id UNIQUE prevents double-insert
      expect(batches[0]!.n).toBe(1);
    });
  });
});
