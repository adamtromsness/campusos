import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';
import { AllergenAlertService } from './dietary-eligibility.service';

/**
 * AllergyAlertConsumer — REVIEW-FINAL-2026-05-07 MAJ-5.1 fix.
 *
 * Closes the ADR-030 architectural seam between Health and Food
 * Service. Subscribes to `hlth.allergy_alert.changed` and updates
 * the `fds_student_allergen_alerts` read model so the POS allergen
 * cross-check (Cycle 20 SAFETY KEYSTONE) sees current data without
 * Food Service ever reading `hlth_*` tables on the live path.
 *
 * The companion admin endpoint `syncFromHealth` remains as a
 * recovery / backfill backstop, but this consumer is the canonical
 * read-model maintenance path.
 *
 * Forward-compatibility note: the source `hlth_health_alerts` table
 * lands in a future Health hardening cycle (planned Cycle 10.5).
 * Until the Health module emits `hlth.allergy_alert.changed`, this
 * consumer is dormant — it subscribes and waits. The first emit
 * automatically populates the read model.
 *
 * Standard claim-after-success idempotency via
 * `processWithIdempotency` (REVIEW-CYCLE2 BLOCKING 2 pattern). The
 * ON CONFLICT DO UPDATE in `upsertFromAlertEvent` makes the upsert
 * itself idempotent, so a redelivery is safe. Tenant context is
 * reconstructed from the envelope's `tenant_id` and the
 * `tenant-subdomain` transport header.
 */
@Injectable()
export class AllergyAlertConsumer implements OnModuleInit {
  private readonly logger = new Logger(AllergyAlertConsumer.name);
  private static readonly CONSUMER_GROUP = 'allergy-alert-consumer';
  private static readonly TOPIC = 'hlth.allergy_alert.changed';

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly alerts: AllergenAlertService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe({
      groupId: AllergyAlertConsumer.CONSUMER_GROUP,
      topics: [prefixedTopic(AllergyAlertConsumer.TOPIC)],
      handler: (msg) => this.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<AllergyAlertChangedPayload>(msg, this.logger);
    if (!event) return;

    // REVIEW-FINAL-V2 MAJOR-NEW-7 — semantic payload validation
    // happens INSIDE processWithIdempotency so a malformed payload
    // throws and the standard retry/DLQ chain catches it. The
    // earlier shape logged + returned, which under
    // processWithIdempotency would silently claim the event and
    // advance the offset — leaving the Food Service allergen read
    // model stale on a malformed Health emit. For a SAFETY-critical
    // read model that gates the POS allergen cross-check, silent
    // drop is unacceptable. The DLQ row is now the canonical
    // signal that a Health producer shipped a malformed allergy
    // event, surfacing it for operator action.
    await processWithIdempotency(
      AllergyAlertConsumer.CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async () => {
        if (!isValidPayload(event.payload)) {
          throw new MalformedAllergyAlertPayloadError(
            'allergy-alert payload missing required fields ' +
              '(sourceAlertId/studentId/allergenCode/allergenDisplayName/severity/isActive) ' +
              'on event ' +
              event.eventId,
          );
        }
        const payload = event.payload;
        await this.alerts.upsertFromAlertEvent({
          sourceAlertId: payload.sourceAlertId,
          studentId: payload.studentId,
          allergenCode: payload.allergenCode,
          allergenDisplayName: payload.allergenDisplayName,
          severity: payload.severity,
          isActive: payload.isActive,
        });
        this.logger.log(
          '[allergy-alert-consumer] upserted source=' +
            payload.sourceAlertId +
            ' student=' +
            payload.studentId +
            ' allergen=' +
            payload.allergenCode +
            ' severity=' +
            payload.severity +
            ' active=' +
            payload.isActive,
        );
      },
    );
  }
}

/**
 * Thrown when an `hlth.allergy_alert.changed` event has a
 * structurally-valid ADR-057 envelope but is missing required
 * domain fields. The standard retry/DLQ chain catches it and parks
 * to `platform.platform_dlq_messages` with
 * `error_class=MalformedAllergyAlertPayloadError`.
 */
class MalformedAllergyAlertPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedAllergyAlertPayloadError';
  }
}

interface AllergyAlertChangedPayload {
  sourceAlertId: string;
  studentId: string;
  allergenCode: string;
  allergenDisplayName: string;
  severity: string;
  isActive: boolean;
}

function isValidPayload(p: unknown): p is AllergyAlertChangedPayload {
  if (typeof p !== 'object' || p === null) return false;
  const pp = p as Record<string, unknown>;
  return (
    typeof pp.sourceAlertId === 'string' &&
    typeof pp.studentId === 'string' &&
    typeof pp.allergenCode === 'string' &&
    typeof pp.allergenDisplayName === 'string' &&
    typeof pp.severity === 'string' &&
    typeof pp.isActive === 'boolean'
  );
}
