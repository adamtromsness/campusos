import type { EventEnvelope } from './event-envelope';

/**
 * Cycle 31 Step 7 — Envelope Validator.
 *
 * Every Kafka consumer MUST validate the ADR-057 envelope before
 * processing per the cycle-31 plan. Validation failure parks the
 * message into the DLQ with `error_class=ENVELOPE_INVALID`.
 *
 * Validation contract:
 *   - event_id present and UUID-shaped
 *   - event_type present and matches the consumer's expected topic
 *   - event_version present (default 1 accepted)
 *   - tenant_id present and UUID-shaped
 *   - correlation_id present (any string)
 *   - payload present (any value)
 *
 * Consumer code wraps the envelope unwrap in a try/catch around
 * `assertValidEnvelope` and returns to the consumer-loop's DLQ park
 * path on throw.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EnvelopeValidationError extends Error {
  readonly errorClass = 'ENVELOPE_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeValidationError';
  }
}

export function assertValidEnvelope<P>(
  envelope: unknown,
  expectedEventType?: string,
): asserts envelope is EventEnvelope<P> {
  if (!envelope || typeof envelope !== 'object') {
    throw new EnvelopeValidationError('Envelope is missing or not an object');
  }
  const e = envelope as Record<string, unknown>;
  if (typeof e.event_id !== 'string' || !UUID_REGEX.test(e.event_id)) {
    throw new EnvelopeValidationError(`Invalid event_id: ${String(e.event_id)}`);
  }
  if (typeof e.event_type !== 'string' || e.event_type.length === 0) {
    throw new EnvelopeValidationError('Missing event_type');
  }
  if (expectedEventType && e.event_type !== expectedEventType) {
    throw new EnvelopeValidationError(
      `event_type mismatch: expected '${expectedEventType}', got '${e.event_type}'`,
    );
  }
  if (typeof e.event_version !== 'number') {
    throw new EnvelopeValidationError('Missing event_version');
  }
  if (typeof e.tenant_id !== 'string' || !UUID_REGEX.test(e.tenant_id)) {
    throw new EnvelopeValidationError(`Invalid tenant_id: ${String(e.tenant_id)}`);
  }
  if (typeof e.correlation_id !== 'string' || e.correlation_id.length === 0) {
    throw new EnvelopeValidationError('Missing correlation_id');
  }
  if (e.payload === undefined) {
    throw new EnvelopeValidationError('Missing payload');
  }
  if (typeof e.source_module !== 'string' || e.source_module.length === 0) {
    throw new EnvelopeValidationError('Missing source_module');
  }
}
