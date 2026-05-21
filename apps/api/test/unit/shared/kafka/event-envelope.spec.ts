import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { envelopeFromOptions, prefixedTopic, unprefixTopic } from '@shared/kafka/event-envelope';

describe('event-envelope helpers', () => {
  describe('prefixedTopic / unprefixTopic', () => {
    const original = process.env.KAFKA_TOPIC_ENV;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.KAFKA_TOPIC_ENV;
      } else {
        process.env.KAFKA_TOPIC_ENV = original;
      }
    });

    it('prefixes a logical topic with the configured env', () => {
      process.env.KAFKA_TOPIC_ENV = 'staging';
      expect(prefixedTopic('pay.payment.received')).toBe('staging.pay.payment.received');
    });

    it('falls back to "dev" when KAFKA_TOPIC_ENV is unset', () => {
      delete process.env.KAFKA_TOPIC_ENV;
      expect(prefixedTopic('pay.payment.received')).toBe('dev.pay.payment.received');
    });

    it('unprefixTopic is the inverse of prefixedTopic', () => {
      process.env.KAFKA_TOPIC_ENV = 'dev';
      const wire = prefixedTopic('hlth.allergy_alert.changed');
      expect(unprefixTopic(wire)).toBe('hlth.allergy_alert.changed');
    });

    it('unprefixTopic returns the raw input when prefix does not match', () => {
      process.env.KAFKA_TOPIC_ENV = 'dev';
      // A wire topic from a foreign env passes through unchanged.
      expect(unprefixTopic('staging.pay.payment.received')).toBe('staging.pay.payment.received');
    });
  });

  describe('envelopeFromOptions', () => {
    beforeEach(() => {
      delete process.env.KAFKA_TOPIC_ENV;
    });

    it('builds a complete ADR-057 envelope from minimal inputs', () => {
      const env = envelopeFromOptions({
        eventType: 'pay.payment.received',
        payload: { amount: 100 },
        sourceModule: 'payments',
        tenantId: '019dff45-1234-7000-8000-000000000001',
      });
      expect(env.event_type).toBe('pay.payment.received');
      expect(env.event_version).toBe(1);
      expect(env.source_module).toBe('payments');
      expect(env.tenant_id).toBe('019dff45-1234-7000-8000-000000000001');
      expect(env.payload).toEqual({ amount: 100 });
      // event_id + correlation_id auto-populate.
      expect(env.event_id).toMatch(/^[0-9a-f-]{36}$/i);
      expect(env.correlation_id).toBeTruthy();
      expect(env.occurred_at).toBeTruthy();
      expect(env.published_at).toBeTruthy();
    });

    it('honours an explicit deterministic event_id', () => {
      const env = envelopeFromOptions({
        eventType: 'hr.leave.coverage_needed',
        payload: {},
        sourceModule: 'hr',
        tenantId: '019dff45-1234-7000-8000-000000000001',
        eventId: 'fixed-event-id-uuid-shape-aaaaaaaaaaaaaaaaaaaa',
      });
      expect(env.event_id).toBe('fixed-event-id-uuid-shape-aaaaaaaaaaaaaaaaaaaa');
    });

    it('honours explicit correlationId', () => {
      const env = envelopeFromOptions({
        eventType: 'pay.payment.received',
        payload: {},
        sourceModule: 'payments',
        tenantId: '019dff45-1234-7000-8000-000000000001',
        correlationId: 'correlate-me',
      });
      expect(env.correlation_id).toBe('correlate-me');
    });
  });
});
