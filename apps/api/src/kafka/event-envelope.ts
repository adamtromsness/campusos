import { generateId } from '@campusos/database';
import { getRequestContext } from '../tenant/tenant.context';

/**
 * Canonical event envelope (ADR-057, landed in Cycle 3 Step 0).
 *
 * Every Kafka message body is a JSON object with these fields. Domain
 * payloads — what producers used to emit as the entire body — now sit
 * under `payload` so consumers only need to reach for one key.
 *
 * The envelope decouples wire format from domain content:
 *   - `event_id` / `tenant_id` are the dedupe + tenant routing fields
 *     consumers always read first (idempotency claim + search_path).
 *   - `event_type` mirrors the un-prefixed topic so consumers that
 *     subscribe to multiple topics don't have to know about the env
 *     prefix on the wire (`dev.att.student.marked_tardy` etc.).
 *   - `event_version` is producer-asserted; consumers branch on it
 *     when a payload shape evolves.
 *   - `correlation_id` propagates a request-scoped trace id (or a
 *     fresh one when no request context exists, e.g. worker-emitted
 *     events).
 *   - `source_module` is the domain identifier the producer lives in
 *     ("attendance", "classroom", "communications", …) — used for
 *     observability and for routing in the future.
 *
 * Structurally validated on the consumer side; no schema registry.
 */
export interface EventEnvelope<P = unknown> {
  event_id: string;
  event_type: string;
  event_version: number;
  occurred_at: string;
  published_at: string;
  tenant_id: string;
  source_module: string;
  correlation_id: string;
  payload: P;
}

/**
 * Inputs for building an envelope. Producers fill in the bits the
 * builder can't infer; defaults cover the common case (event_version=1,
 * occurred_at=now, correlation_id from request context).
 */
export interface EnvelopeOptions<P = unknown> {
  /** Un-prefixed topic name; also written into `event_type`. */
  eventType: string;
  /** Domain-specific payload. */
  payload: P;
  /** Module the producer lives in: 'attendance' | 'classroom' | 'communications' | … */
  sourceModule: string;
  /** Schema version of the payload. Defaults to 1. Bump on breaking changes. */
  eventVersion?: number;
  /** When the domain event happened. Defaults to now. */
  occurredAt?: string;
  /** School id (UUID). Required for worker-originated emits; optional otherwise — falls back to request tenant context. */
  tenantId?: string;
  /** Trace id propagated from the request. Falls back to a fresh UUIDv7. */
  correlationId?: string;
  /**
   * Deterministic event id override (REVIEW-CYCLE4 MAJOR 3). When a Kafka
   * consumer republishes an event derived from an inbound one, supplying a
   * deterministic id (e.g. derived from the inbound event_id + a stable
   * suffix) lets the next consumer's idempotency table catch a redelivery
   * without needing the producer to be exactly-once. When omitted, a
   * fresh UUIDv7 is generated as before.
   */
  eventId?: string;
}

/**
 * Build an envelope from an `EnvelopeOptions`. Pure — no I/O.
 */
export function envelopeFromOptions<P>(opts: EnvelopeOptions<P>): EventEnvelope<P> {
  var nowIso = new Date().toISOString();
  var ctx = getRequestContext();
  var resolvedTenant = opts.tenantId ?? ctx?.tenant.schoolId;
  if (!resolvedTenant) {
    throw new Error(
      'envelopeFromOptions: tenantId not supplied and no request tenant context — cannot build envelope for ' +
        opts.eventType,
    );
  }
  return {
    event_id: opts.eventId ?? generateId(),
    event_type: opts.eventType,
    event_version: opts.eventVersion ?? 1,
    occurred_at: opts.occurredAt ?? nowIso,
    published_at: nowIso,
    tenant_id: resolvedTenant,
    source_module: opts.sourceModule,
    correlation_id: opts.correlationId ?? generateId(),
    payload: opts.payload,
  };
}

/**
 * Apply the env prefix to a logical topic name. Reads `KAFKA_TOPIC_ENV`
 * (default: `dev`). Producers and consumers MUST go through this helper
 * so a misconfigured env can't quietly cross-pollinate environments.
 *
 *   prefixedTopic('att.student.marked_tardy')
 *     // → 'dev.att.student.marked_tardy'  (or '<env>.att.…')
 */
export function prefixedTopic(logicalTopic: string): string {
  var env = (process.env.KAFKA_TOPIC_ENV || 'dev').trim();
  return env + '.' + logicalTopic;
}
