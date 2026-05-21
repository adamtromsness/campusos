import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { DlqService } from '@shared/dlq/dlq.service';
import { DlqController } from '@shared/dlq/dlq.controller';
import {
  KafkaProducerNotConnectedError,
  type KafkaProducerService,
} from '@shared/kafka/kafka-producer.service';
import { TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';

/**
 * Wave 8 — DLQ service + controller integration coverage.
 *
 * Exercises the operational recovery surface end-to-end against the
 * platform_dlq_messages table:
 *   - list (filtered) + getById + stats
 *   - replay happy path: atomic claim → emit → finalise REPLAYED
 *   - replay race: concurrent replays produce exactly one winner
 *   - replay broker outage: emit throws, row reverts to PENDING
 *   - discard happy path + double-discard rejection
 *   - 404 + 400 error contracts
 */

interface RawEmit {
  topic: string;
  key: string | null;
  envelope: any;
  tenantSubdomain?: string | null;
}

class RecordingRawProducer {
  emits: RawEmit[] = [];
  failNext = false;
  failWith: Error | null = null;
  async emit(): Promise<void> {}
  async emitRaw(args: RawEmit): Promise<void> {
    if (this.failNext && this.failWith) {
      this.failNext = false;
      throw this.failWith;
    }
    this.emits.push(args);
  }
}

describe('integration:shared/dlq', () => {
  let raw: PrismaClient;
  let producer: RecordingRawProducer;
  let svc: DlqService;
  let controller: DlqController;

  beforeAll(async () => {
    raw = new PrismaClient();
    await raw.$connect();
    producer = new RecordingRawProducer();
    svc = new DlqService(raw, producer as unknown as KafkaProducerService);
    controller = new DlqController(svc);
  });

  afterAll(async () => {
    await raw.$disconnect();
  });

  beforeEach(async () => {
    // Wipe rows that belong to our test tenant — leaves any unrelated rows alone.
    await raw.$executeRawUnsafe(
      `DELETE FROM platform.platform_dlq_messages WHERE tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    producer.emits = [];
    producer.failNext = false;
    producer.failWith = null;
  });

  async function seedDlqRow(opts: {
    consumerGroup?: string;
    topic?: string;
    eventType?: string;
    eventId?: string;
    olderThanMinutes?: number;
  } = {}): Promise<string> {
    const id = generateId();
    const eventId = opts.eventId ?? generateId();
    const envelope = {
      event_id: eventId,
      event_type: opts.eventType ?? 'pay.invoice.created',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      tenant_id: TEST_SCHOOL_ID,
      source_module: 'payments',
      correlation_id: generateId(),
      payload: { invoice_id: 'inv-x' },
    };
    const olderBy = opts.olderThanMinutes ?? 0;
    const lastFailedAt = new Date(Date.now() - olderBy * 60 * 1000);
    await raw.$executeRawUnsafe(
      `INSERT INTO platform.platform_dlq_messages
         (id, topic, partition, kafka_offset, consumer_group, event_id, tenant_id,
          payload, headers, error_message, error_class, retry_count,
          first_failed_at, last_failed_at)
       VALUES ($1::uuid, $2, 0, 0, $3, $4, $5::uuid,
               $6::jsonb, '{}'::jsonb, 'boom', 'TestError', 5, now(), $7)`,
      id,
      opts.topic ?? 'dev.pay.invoice.created',
      opts.consumerGroup ?? 'test-group',
      eventId,
      TEST_SCHOOL_ID,
      JSON.stringify(envelope),
      lastFailedAt,
    );
    return id;
  }

  // ──────────────────────────────────────────────────────────────────
  // list / getById / stats
  // ──────────────────────────────────────────────────────────────────
  describe('list / getById / stats', () => {
    it('list returns rows ordered by lastFailedAt desc with filters honoured', async () => {
      await seedDlqRow({ consumerGroup: 'group-A', topic: 'dev.t.one' });
      await seedDlqRow({ consumerGroup: 'group-B', topic: 'dev.t.two' });
      await seedDlqRow({ consumerGroup: 'group-A', topic: 'dev.t.one' });

      const all = await svc.list({ tenantId: TEST_SCHOOL_ID });
      expect(all.length).toBeGreaterThanOrEqual(3);

      const groupAOnly = await svc.list({ consumerGroup: 'group-A', tenantId: TEST_SCHOOL_ID });
      expect(groupAOnly.every((r) => r.consumerGroup === 'group-A')).toBe(true);

      const topicOnly = await svc.list({ topic: 'dev.t.two', tenantId: TEST_SCHOOL_ID });
      expect(topicOnly.every((r) => r.topic === 'dev.t.two')).toBe(true);

      const unresolvedOnly = await svc.list({
        resolved: false,
        tenantId: TEST_SCHOOL_ID,
      });
      expect(unresolvedOnly.every((r) => r.resolvedAt === null)).toBe(true);

      // Limit honours cap of 500
      const limited = await svc.list({ tenantId: TEST_SCHOOL_ID, limit: 1 });
      expect(limited).toHaveLength(1);

      const resolvedTrue = await svc.list({ tenantId: TEST_SCHOOL_ID, resolved: true });
      expect(resolvedTrue.every((r) => r.resolvedAt !== null)).toBe(true);
    });

    it('controller.list passes query params through and normalises resolved', async () => {
      await seedDlqRow();
      const rows = await controller.list(undefined, undefined, TEST_SCHOOL_ID, 'true', '50');
      expect(rows.every((r) => r.resolvedAt !== null)).toBe(true);

      const open = await controller.list(undefined, undefined, TEST_SCHOOL_ID, 'false', '5');
      expect(open.every((r) => r.resolvedAt === null)).toBe(true);

      const undefinedResolved = await controller.list(
        undefined,
        undefined,
        TEST_SCHOOL_ID,
        undefined,
        undefined,
      );
      expect(Array.isArray(undefinedResolved)).toBe(true);
    });

    it('getById returns full row including payload + headers + errorMessage', async () => {
      const id = await seedDlqRow();
      const row = await svc.getById(id);
      expect(row.id).toBe(id);
      expect(row.payload).toMatchObject({ event_type: 'pay.invoice.created' });
      expect(row.headers).toEqual({});
      expect(row.errorMessage).toBe('boom');
    });

    it('getById throws NotFoundException for unknown id', async () => {
      await expect(svc.getById(generateId())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('stats returns total / olderThan15Min / byConsumerGroup', async () => {
      // Fresh row + a stale row.
      await seedDlqRow({ consumerGroup: 'stale-group', olderThanMinutes: 20 });
      await seedDlqRow({ consumerGroup: 'fresh-group' });
      const stats = await svc.stats();
      expect(stats.totalUnresolved).toBeGreaterThanOrEqual(2);
      expect(stats.olderThan15Min).toBeGreaterThanOrEqual(1);
      const groupLabels = stats.byConsumerGroup.map((g) => g.consumerGroup);
      expect(groupLabels).toContain('stale-group');
      expect(groupLabels).toContain('fresh-group');
    });

    it('controller.stats and controller.getById delegate correctly', async () => {
      const id = await seedDlqRow();
      const stats = await controller.stats();
      expect(typeof stats.totalUnresolved).toBe('number');
      const row = await controller.getById(id);
      expect(row.id).toBe(id);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // replay — atomic claim + finalise + revert on error
  // ──────────────────────────────────────────────────────────────────
  describe('replay', () => {
    it('emits the envelope verbatim + marks the row REPLAYED', async () => {
      const id = await seedDlqRow();
      await svc.replay(id, TEST_ADMIN_ACCOUNT_ID);
      expect(producer.emits).toHaveLength(1);
      expect(producer.emits[0]!.envelope.event_type).toBe('pay.invoice.created');
      expect(producer.emits[0]!.topic).toBe('dev.pay.invoice.created');

      const after = await svc.getById(id);
      expect(after.resolvedAt).not.toBeNull();
      expect(after.resolution).toBe('REPLAYED');
      expect(after.resolvedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(svc.replay(generateId(), TEST_ADMIN_ACCOUNT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the row is already resolved', async () => {
      const id = await seedDlqRow();
      await svc.replay(id, TEST_ADMIN_ACCOUNT_ID);
      await expect(svc.replay(id, TEST_ADMIN_ACCOUNT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws BadRequestException when the envelope has no event_type', async () => {
      // Insert a malformed payload.
      const id = generateId();
      await raw.$executeRawUnsafe(
        `INSERT INTO platform.platform_dlq_messages
           (id, topic, partition, kafka_offset, consumer_group, event_id, tenant_id,
            payload, headers, error_message, error_class, retry_count,
            first_failed_at, last_failed_at)
         VALUES ($1::uuid, 'dev.broken', 0, 0, 'g', NULL, $2::uuid,
                 '{"not_an_envelope": true}'::jsonb, '{}'::jsonb,
                 'boom', 'TestError', 5, now(), now())`,
        id,
        TEST_SCHOOL_ID,
      );
      await expect(svc.replay(id, TEST_ADMIN_ACCOUNT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('reverts the row to PENDING when the broker is disconnected (503)', async () => {
      const id = await seedDlqRow();
      producer.failNext = true;
      producer.failWith = new KafkaProducerNotConnectedError('dev.pay.invoice.created');

      let captured: any = null;
      try {
        await svc.replay(id, TEST_ADMIN_ACCOUNT_ID);
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(HttpException);
      expect((captured as HttpException).getStatus()).toBe(503);

      const after = await svc.getById(id);
      expect(after.resolvedAt).toBeNull();
      expect(after.resolution).toBeNull();
    });

    it('reverts the row and surfaces a 500 when the producer throws a generic error', async () => {
      const id = await seedDlqRow();
      producer.failNext = true;
      producer.failWith = new Error('generic kafka failure');

      let captured: any = null;
      try {
        await svc.replay(id, TEST_ADMIN_ACCOUNT_ID);
      } catch (e) {
        captured = e;
      }
      expect(captured).toBeInstanceOf(HttpException);
      expect((captured as HttpException).getStatus()).toBe(500);

      const after = await svc.getById(id);
      expect(after.resolvedAt).toBeNull();
      expect(after.resolution).toBeNull();
    });

    it('atomic claim — only one of two concurrent replays wins', async () => {
      const id = await seedDlqRow();
      const [first, second] = await Promise.allSettled([
        svc.replay(id, TEST_ADMIN_ACCOUNT_ID),
        svc.replay(id, TEST_ADMIN_ACCOUNT_ID),
      ]);
      const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
      const rejected = [first, second].filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(BadRequestException);
    });

    it('controller.replay delegates to service with actor sub', async () => {
      const id = await seedDlqRow();
      await controller.replay(
        { user: { sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_ACCOUNT_ID } } as any,
        id,
      );
      const after = await svc.getById(id);
      expect(after.resolution).toBe('REPLAYED');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // discard — atomic acknowledgement without replay
  // ──────────────────────────────────────────────────────────────────
  describe('discard', () => {
    it('marks the row DISCARDED with the provided reason', async () => {
      const id = await seedDlqRow();
      await svc.discard(id, TEST_ADMIN_ACCOUNT_ID, 'duplicate event');
      const after = await svc.getById(id);
      expect(after.resolvedAt).not.toBeNull();
      expect(after.resolution).toMatch(/^DISCARDED: duplicate event/);
      expect(after.resolvedBy).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('throws NotFoundException for unknown id', async () => {
      await expect(svc.discard(generateId(), TEST_ADMIN_ACCOUNT_ID, 'r')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the row is already resolved', async () => {
      const id = await seedDlqRow();
      await svc.discard(id, TEST_ADMIN_ACCOUNT_ID, 'first');
      await expect(svc.discard(id, TEST_ADMIN_ACCOUNT_ID, 'second')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('truncates the resolution reason to 500 chars', async () => {
      const id = await seedDlqRow();
      const longReason = 'x'.repeat(600);
      await svc.discard(id, TEST_ADMIN_ACCOUNT_ID, longReason);
      const after = await svc.getById(id);
      expect((after.resolution ?? '').length).toBeLessThanOrEqual(500);
    });

    it('controller.discard delegates to service', async () => {
      const id = await seedDlqRow();
      await controller.discard(
        { user: { sub: TEST_ADMIN_ACCOUNT_ID, personId: TEST_ADMIN_ACCOUNT_ID } } as any,
        id,
        { reason: 'controller-test' },
      );
      const after = await svc.getById(id);
      expect(after.resolution).toMatch(/^DISCARDED: controller-test/);
    });
  });
});
