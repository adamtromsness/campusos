import { describe, it, expect } from 'vitest';
import { assertValidEnvelope, EnvelopeValidationError } from '@shared/kafka/envelope-validator';

const validEnvelope = {
  event_id: '019dff45-1234-7000-8000-000000000001',
  event_type: 'pay.payment.received',
  event_version: 1,
  occurred_at: '2026-05-07T12:00:00Z',
  published_at: '2026-05-07T12:00:00Z',
  tenant_id: '019dff45-1234-7000-8000-000000000002',
  source_module: 'payments',
  correlation_id: 'corr-1',
  payload: { foo: 'bar' },
};

describe('assertValidEnvelope', () => {
  it('accepts a fully-formed envelope', () => {
    expect(() => assertValidEnvelope(validEnvelope)).not.toThrow();
  });

  it('throws when envelope is null', () => {
    expect(() => assertValidEnvelope(null)).toThrow(EnvelopeValidationError);
  });

  it('throws when event_id is not a UUID', () => {
    expect(() => assertValidEnvelope({ ...validEnvelope, event_id: 'not-a-uuid' })).toThrow(
      EnvelopeValidationError,
    );
  });

  it('throws when tenant_id is not a UUID', () => {
    expect(() => assertValidEnvelope({ ...validEnvelope, tenant_id: 'tenant-foo' })).toThrow(
      EnvelopeValidationError,
    );
  });

  it('throws when event_type is missing', () => {
    expect(() => assertValidEnvelope({ ...validEnvelope, event_type: '' })).toThrow(
      EnvelopeValidationError,
    );
  });

  it('throws when source_module is missing', () => {
    expect(() => assertValidEnvelope({ ...validEnvelope, source_module: '' })).toThrow(
      EnvelopeValidationError,
    );
  });

  it('throws when correlation_id is empty', () => {
    expect(() => assertValidEnvelope({ ...validEnvelope, correlation_id: '' })).toThrow(
      EnvelopeValidationError,
    );
  });

  it('throws when payload is missing', () => {
    const e = { ...validEnvelope } as Partial<typeof validEnvelope>;
    delete e.payload;
    expect(() => assertValidEnvelope(e)).toThrow(EnvelopeValidationError);
  });

  // REVIEW-FINAL-V2 G2 — topic/event_type pairing.
  describe('expectedEventType (G2 — topic/event_type pairing)', () => {
    it('accepts when expected event_type matches', () => {
      expect(() => assertValidEnvelope(validEnvelope, 'pay.payment.received')).not.toThrow();
    });

    it('rejects when expected event_type does NOT match the envelope', () => {
      expect(() => assertValidEnvelope(validEnvelope, 'pay.invoice.created')).toThrow(
        /event_type mismatch/,
      );
    });

    it('rejects with friendly message naming both sides of the mismatch', () => {
      let captured: Error | null = null;
      try {
        assertValidEnvelope(validEnvelope, 'pay.invoice.created');
      } catch (e) {
        captured = e as Error;
      }
      expect(captured).not.toBeNull();
      expect(captured!.message).toContain('pay.invoice.created');
      expect(captured!.message).toContain('pay.payment.received');
    });

    it('skips the check when expectedEventType is omitted', () => {
      expect(() => assertValidEnvelope(validEnvelope)).not.toThrow();
    });
  });
});
