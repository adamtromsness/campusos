import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  KafkaProducerService,
  KafkaProducerNotConnectedError,
} from '@shared/kafka/kafka-producer.service';
import { KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TEST_SCHOOL_ID, withTestTenant } from '../helpers/tenant-context';
import { generateId } from '@campusos/database';

/**
 * Wave 8 — KafkaProducerService + KafkaConsumerService lifecycle.
 *
 * The Kafka broker may or may not be up — both services degrade to
 * "best-effort" mode when the broker is unreachable. The tests assert:
 *   - construct + onModuleInit + onModuleDestroy do not throw.
 *   - emit() never throws (best-effort).
 *   - emitRaw() throws KafkaProducerNotConnectedError when the producer
 *     is not connected.
 *   - KafkaConsumerService.subscribe() is best-effort when broker is down.
 *
 * The actual Kafka container in docker-compose is currently
 * "unhealthy" — the suite intentionally exercises the disconnected
 * path because that's the dominant case in CI / local dev and is
 * where the bulk of the lifecycle / no-op code lives.
 */
describe('integration:shared/kafka-services', () => {
  // ──────────────────────────────────────────────────────────────────
  // KafkaProducerService — lifecycle + best-effort emit
  // ──────────────────────────────────────────────────────────────────
  describe('KafkaProducerService', () => {
    let producer: KafkaProducerService;

    beforeAll(async () => {
      // Use a deliberately invalid broker so the connect() path returns
      // the disconnected state. The class is designed to log + no-op
      // rather than throw.
      process.env.KAFKA_BROKERS = '127.0.0.1:1';
      producer = new KafkaProducerService();
      // Give the producer ~1s to attempt connect. If the broker is up
      // on localhost:9092 (default) and we set KAFKA_BROKERS to a bad
      // address, the connect will fail; either way the service ends up
      // in `connected=false`.
      await producer.onModuleInit();
    });

    afterAll(async () => {
      await producer.onModuleDestroy();
      delete process.env.KAFKA_BROKERS;
    });

    it('emit is best-effort (never throws) when disconnected', async () => {
      await withTestTenant(async () => {
        await producer.emit({
          topic: 'pay.invoice.created',
          key: 'k-1',
          payload: { invoice_id: 'i-1' },
          sourceModule: 'payments',
        });
      });
      // No assertion needed — the contract is "did not throw".
      expect(true).toBe(true);
    });

    it('emit succeeds when an explicit tenantId / tenantSubdomain is supplied (worker path)', async () => {
      await producer.emit({
        topic: 'pay.invoice.created',
        key: 'k-2',
        payload: { invoice_id: 'i-2' },
        sourceModule: 'payments',
        tenantId: TEST_SCHOOL_ID,
        tenantSubdomain: 'test',
      });
      expect(true).toBe(true);
    });

    it('emit forwards optional headers without throwing', async () => {
      await withTestTenant(async () => {
        await producer.emit({
          topic: 'pay.invoice.created',
          key: 'k-3',
          payload: { invoice_id: 'i-3' },
          sourceModule: 'payments',
          headers: { 'x-extra': 'value' },
        });
      });
      expect(true).toBe(true);
    });

    it('emit with no tenant context AND no tenantId logs + returns', async () => {
      await producer.emit({
        topic: 'pay.invoice.created',
        key: 'k-4',
        payload: { invoice_id: 'i-4' },
        sourceModule: 'payments',
      });
      // No throw; the disconnected path skips the envelope build entirely.
      expect(true).toBe(true);
    });

    it('emitRaw throws KafkaProducerNotConnectedError when disconnected', async () => {
      await expect(
        producer.emitRaw({
          topic: 'dev.pay.invoice.created',
          key: 'k-raw',
          envelope: {
            event_id: generateId(),
            event_type: 'pay.invoice.created',
            tenant_id: TEST_SCHOOL_ID,
          },
        }),
      ).rejects.toBeInstanceOf(KafkaProducerNotConnectedError);
    });

    it('KafkaProducerNotConnectedError carries the topic', () => {
      const err = new KafkaProducerNotConnectedError('dev.test');
      expect(err.topic).toBe('dev.test');
      expect(err.name).toBe('KafkaProducerNotConnectedError');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // KafkaConsumerService — subscribe is best-effort when broker down
  // ──────────────────────────────────────────────────────────────────
  describe('KafkaConsumerService', () => {
    let consumer: KafkaConsumerService;
    let tenantPrisma: TenantPrismaService;

    beforeAll(async () => {
      tenantPrisma = new TenantPrismaService();
      consumer = new KafkaConsumerService(tenantPrisma);
      await consumer.onModuleInit();
    });

    afterAll(async () => {
      await consumer.onApplicationShutdown();
      await tenantPrisma.onModuleDestroy();
    });

    it('subscribe is best-effort when Kafka is unavailable', async () => {
      // No exception expected — subscribe records the pending sub and
      // continues even when the broker is unreachable.
      await consumer.subscribe({
        topics: ['dev.test.topic'],
        groupId: 'wave8-consumer-test',
        handler: async () => undefined,
      });
      expect(true).toBe(true);
    });

    it('subscribe with envelope validation opt-out also succeeds', async () => {
      await consumer.subscribe({
        topics: ['dev.test.topic.legacy'],
        groupId: 'wave8-consumer-legacy',
        handler: async () => undefined,
        validateEnvelope: false,
      });
      expect(true).toBe(true);
    });
  });
});
