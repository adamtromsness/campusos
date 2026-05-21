import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import {
  unwrapEnvelope,
  processWithIdempotency,
  type UnwrappedEvent,
} from '@shared/kafka/envelope-consumer';
import { assertValidEnvelope, EnvelopeValidationError } from '@shared/kafka/envelope-validator';
import { envelopeFromOptions, prefixedTopic, unprefixTopic } from '@shared/kafka/event-envelope';
import type { ConsumedMessage } from '@shared/kafka/kafka-consumer.service';
import { TEST_SCHOOL_ID, TEST_SUBDOMAIN, withTestTenant } from '../helpers/tenant-context';
import { generateId } from '@campusos/database';

/**
 * Wave 8 — Kafka envelope helpers + IdempotencyService end-to-end against
 * platform.platform_event_consumer_idempotency.
 *
 * Coverage:
 *   - envelope-validator: assertValidEnvelope happy path + every rejection branch.
 *   - event-envelope: envelopeFromOptions defaults + prefixedTopic / unprefixTopic.
 *   - envelope-consumer.unwrapEnvelope: ADR-057 envelope or legacy header fallback.
 *   - envelope-consumer.processWithIdempotency: read-only check → process → claim
 *     after success; failing process leaves the row unclaimed.
 *   - IdempotencyService.isClaimed / claim race against the live unique constraint.
 */
describe('integration:shared/kafka-envelope', () => {
  let tenantPrisma: TenantPrismaService;
  let raw: PrismaClient;
  let idempotency: IdempotencyService;
  // Discard the log noise.
  const silentLogger: Logger = {
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    log: () => undefined,
  } as unknown as Logger;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    raw = new PrismaClient();
    await raw.$connect();
    idempotency = new IdempotencyService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await raw.$disconnect();
  });

  beforeEach(async () => {
    // Wipe idempotency rows from prior tests on the dedicated test group.
    await raw.$executeRawUnsafe(
      `DELETE FROM platform.platform_event_consumer_idempotency
        WHERE consumer_group LIKE 'wave8-shared-%'`,
    );
  });

  // ──────────────────────────────────────────────────────────────────
  // envelope-validator
  // ──────────────────────────────────────────────────────────────────
  describe('assertValidEnvelope', () => {
    const baseEnvelope = () => ({
      event_id: generateId(),
      event_type: 'pay.invoice.created',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      tenant_id: TEST_SCHOOL_ID,
      source_module: 'payments',
      correlation_id: generateId(),
      payload: { invoice_id: 'inv-1' },
    });

    it('accepts a well-formed envelope', () => {
      expect(() => assertValidEnvelope(baseEnvelope())).not.toThrow();
    });

    it('accepts when expectedEventType matches', () => {
      expect(() => assertValidEnvelope(baseEnvelope(), 'pay.invoice.created')).not.toThrow();
    });

    it('throws when envelope is null or not an object', () => {
      expect(() => assertValidEnvelope(null)).toThrow(EnvelopeValidationError);
      expect(() => assertValidEnvelope('a string')).toThrow(/not an object/);
    });

    it('throws on missing or non-UUID event_id', () => {
      const e = baseEnvelope();
      (e as any).event_id = 'not-a-uuid';
      expect(() => assertValidEnvelope(e)).toThrow(/Invalid event_id/);
      const e2 = baseEnvelope();
      delete (e2 as any).event_id;
      expect(() => assertValidEnvelope(e2)).toThrow(/Invalid event_id/);
    });

    it('throws on missing event_type', () => {
      const e = baseEnvelope();
      delete (e as any).event_type;
      expect(() => assertValidEnvelope(e)).toThrow(/Missing event_type/);
    });

    it('throws when expectedEventType mismatches', () => {
      expect(() => assertValidEnvelope(baseEnvelope(), 'pay.payment.received')).toThrow(
        /event_type mismatch/,
      );
    });

    it('throws on missing event_version', () => {
      const e = baseEnvelope();
      delete (e as any).event_version;
      expect(() => assertValidEnvelope(e)).toThrow(/Missing event_version/);
    });

    it('throws on missing or non-UUID tenant_id', () => {
      const e = baseEnvelope();
      (e as any).tenant_id = 'not-uuid';
      expect(() => assertValidEnvelope(e)).toThrow(/Invalid tenant_id/);
    });

    it('throws on missing correlation_id', () => {
      const e = baseEnvelope();
      delete (e as any).correlation_id;
      expect(() => assertValidEnvelope(e)).toThrow(/Missing correlation_id/);
    });

    it('throws on missing payload', () => {
      const e = baseEnvelope();
      delete (e as any).payload;
      expect(() => assertValidEnvelope(e)).toThrow(/Missing payload/);
    });

    it('throws on missing source_module', () => {
      const e = baseEnvelope();
      delete (e as any).source_module;
      expect(() => assertValidEnvelope(e)).toThrow(/Missing source_module/);
    });

    it('EnvelopeValidationError carries the errorClass tag', () => {
      const err = new EnvelopeValidationError('test');
      expect(err.errorClass).toBe('ENVELOPE_INVALID');
      expect(err.name).toBe('EnvelopeValidationError');
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // event-envelope.envelopeFromOptions
  // ──────────────────────────────────────────────────────────────────
  describe('envelopeFromOptions', () => {
    it('builds an envelope with sensible defaults inside a tenant context', async () => {
      const env = await withTestTenant(async () =>
        envelopeFromOptions({
          eventType: 'msg.thread.replied',
          payload: { thread_id: 't-1' },
          sourceModule: 'communications',
        }),
      );
      expect(env.event_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(env.event_type).toBe('msg.thread.replied');
      expect(env.event_version).toBe(1);
      expect(env.tenant_id).toBe(TEST_SCHOOL_ID);
      expect(env.source_module).toBe('communications');
      expect(env.payload).toEqual({ thread_id: 't-1' });
      expect(env.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(env.published_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(env.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('honours explicit eventId / occurredAt / eventVersion / correlationId / tenantId', () => {
      const eid = generateId();
      const cid = generateId();
      const at = '2026-01-15T10:00:00.000Z';
      const env = envelopeFromOptions({
        eventType: 'pay.invoice.created',
        payload: {},
        sourceModule: 'payments',
        eventVersion: 3,
        eventId: eid,
        occurredAt: at,
        correlationId: cid,
        tenantId: TEST_SCHOOL_ID,
      });
      expect(env.event_id).toBe(eid);
      expect(env.event_version).toBe(3);
      expect(env.occurred_at).toBe(at);
      expect(env.correlation_id).toBe(cid);
    });

    it('throws when called outside a tenant context without explicit tenantId', () => {
      expect(() =>
        envelopeFromOptions({
          eventType: 'pay.invoice.created',
          payload: {},
          sourceModule: 'payments',
        }),
      ).toThrow(/tenantId not supplied/);
    });
  });

  describe('prefixedTopic / unprefixTopic', () => {
    it('applies and strips KAFKA_TOPIC_ENV', () => {
      const prev = process.env.KAFKA_TOPIC_ENV;
      try {
        process.env.KAFKA_TOPIC_ENV = 'dev';
        expect(prefixedTopic('pay.invoice.created')).toBe('dev.pay.invoice.created');
        expect(unprefixTopic('dev.pay.invoice.created')).toBe('pay.invoice.created');
        // Mismatching prefix is left alone.
        expect(unprefixTopic('staging.pay.invoice.created')).toBe('staging.pay.invoice.created');
      } finally {
        if (prev === undefined) delete process.env.KAFKA_TOPIC_ENV;
        else process.env.KAFKA_TOPIC_ENV = prev;
      }
    });

    it('defaults env prefix to "dev" when KAFKA_TOPIC_ENV is unset', () => {
      const prev = process.env.KAFKA_TOPIC_ENV;
      try {
        delete process.env.KAFKA_TOPIC_ENV;
        expect(prefixedTopic('x.y.z')).toBe('dev.x.y.z');
      } finally {
        if (prev !== undefined) process.env.KAFKA_TOPIC_ENV = prev;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // envelope-consumer.unwrapEnvelope
  // ──────────────────────────────────────────────────────────────────
  describe('unwrapEnvelope', () => {
    const baseEnvelope = () => ({
      event_id: generateId(),
      event_type: 'msg.thread.replied',
      event_version: 1,
      occurred_at: new Date().toISOString(),
      published_at: new Date().toISOString(),
      tenant_id: TEST_SCHOOL_ID,
      source_module: 'communications',
      correlation_id: generateId(),
      payload: { thread_id: 't-1' },
    });

    function makeMsg(payload: any, headers: Record<string, string>): ConsumedMessage {
      return {
        topic: 'dev.msg.thread.replied',
        partition: 0,
        key: 'k',
        headers,
        payload,
        timestamp: '0',
      };
    }

    it('reads event_id + tenant_id from the envelope body', () => {
      const env = baseEnvelope();
      const result = unwrapEnvelope(
        makeMsg(env, { 'tenant-subdomain': TEST_SUBDOMAIN }),
        silentLogger,
      );
      expect(result).not.toBeNull();
      expect(result!.eventId).toBe(env.event_id);
      expect(result!.tenant.schoolId).toBe(TEST_SCHOOL_ID);
      expect(result!.tenant.subdomain).toBe(TEST_SUBDOMAIN);
      expect(result!.tenant.schemaName).toBe('tenant_' + TEST_SUBDOMAIN);
      expect(result!.payload).toEqual(env.payload);
    });

    it('falls back to headers when envelope fields are missing', () => {
      // A pre-ADR-057 raw payload — no envelope shape.
      const eventId = generateId();
      const result = unwrapEnvelope(
        makeMsg(
          { plain: 'payload' },
          {
            'event-id': eventId,
            'tenant-id': TEST_SCHOOL_ID,
            'tenant-subdomain': TEST_SUBDOMAIN,
          },
        ),
        silentLogger,
      );
      expect(result?.eventId).toBe(eventId);
      expect(result?.tenant.schoolId).toBe(TEST_SCHOOL_ID);
      expect(result?.payload).toEqual({ plain: 'payload' });
    });

    it('drops messages with no eventId / tenantId / subdomain', () => {
      expect(
        unwrapEnvelope(
          makeMsg({ payload: {} }, { 'tenant-subdomain': TEST_SUBDOMAIN }),
          silentLogger,
        ),
      ).toBeNull();
      expect(
        unwrapEnvelope(
          makeMsg(
            { payload: {} },
            { 'event-id': generateId(), 'tenant-subdomain': TEST_SUBDOMAIN },
          ),
          silentLogger,
        ),
      ).toBeNull();
      expect(
        unwrapEnvelope(
          makeMsg({ payload: {} }, { 'event-id': generateId(), 'tenant-id': TEST_SCHOOL_ID }),
          silentLogger,
        ),
      ).toBeNull();
    });

    it('drops messages whose payload is not an object', () => {
      const env = baseEnvelope();
      (env as any).payload = 'not-an-object';
      const result = unwrapEnvelope(
        makeMsg(env, { 'tenant-subdomain': TEST_SUBDOMAIN }),
        silentLogger,
      );
      expect(result).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // IdempotencyService — DB-backed unique-constraint race
  // ──────────────────────────────────────────────────────────────────
  describe('IdempotencyService', () => {
    it('claim returns true on first insert, false on duplicate', async () => {
      const group = 'wave8-shared-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      expect(await idempotency.claim(group, eventId, 'topic')).toBe(true);
      expect(await idempotency.claim(group, eventId, 'topic')).toBe(false);
    });

    it('isClaimed reflects the row state', async () => {
      const group = 'wave8-shared-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      expect(await idempotency.isClaimed(group, eventId)).toBe(false);
      await idempotency.claim(group, eventId, 'topic');
      expect(await idempotency.isClaimed(group, eventId)).toBe(true);
    });

    it('concurrent claim on the same (group, eventId) → exactly one winner', async () => {
      const group = 'wave8-shared-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      const results = await Promise.all([
        idempotency.claim(group, eventId, 'topic'),
        idempotency.claim(group, eventId, 'topic'),
        idempotency.claim(group, eventId, 'topic'),
      ]);
      const wins = results.filter((r) => r === true).length;
      const losses = results.filter((r) => r === false).length;
      expect(wins).toBe(1);
      expect(losses).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // processWithIdempotency — claim-after-success
  // ──────────────────────────────────────────────────────────────────
  describe('processWithIdempotency', () => {
    function makeEvent(eventId: string): UnwrappedEvent<unknown> {
      return {
        eventId,
        tenant: {
          schoolId: TEST_SCHOOL_ID,
          schemaName: 'tenant_' + TEST_SUBDOMAIN,
          organisationId: null,
          subdomain: TEST_SUBDOMAIN,
          isFrozen: false,
          planTier: 'STANDARD',
          homeRegion: 'us-east-1',
        },
        payload: {},
        topic: 'dev.test.topic',
      };
    }

    it('runs the processor and claims after success', async () => {
      const group = 'wave8-shared-paid-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      let ran = 0;
      await processWithIdempotency(
        group,
        makeEvent(eventId),
        idempotency,
        silentLogger,
        async () => {
          ran++;
        },
      );
      expect(ran).toBe(1);
      expect(await idempotency.isClaimed(group, eventId)).toBe(true);
    });

    it('skips the processor when already claimed', async () => {
      const group = 'wave8-shared-already-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      await idempotency.claim(group, eventId, 'dev.test');
      let ran = 0;
      await processWithIdempotency(
        group,
        makeEvent(eventId),
        idempotency,
        silentLogger,
        async () => {
          ran++;
        },
      );
      expect(ran).toBe(0);
    });

    it('leaves the event unclaimed when processor throws (at-least-once retry)', async () => {
      const group = 'wave8-shared-throws-' + Math.random().toString(36).slice(2);
      const eventId = generateId();
      await expect(
        processWithIdempotency(group, makeEvent(eventId), idempotency, silentLogger, async () => {
          throw new Error('processor boom');
        }),
      ).rejects.toThrow(/processor boom/);
      expect(await idempotency.isClaimed(group, eventId)).toBe(false);
    });
  });
});
