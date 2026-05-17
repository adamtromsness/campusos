import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka/kafka-consumer.service';
import { IdempotencyService } from '@shared/kafka/idempotency.service';
import { prefixedTopic } from '@shared/kafka/event-envelope';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@modules/m40-communications/notifications/consumers/notification-consumer-base';
import { LunchAccountService } from '../lunch-account.service';

/**
 * LunchAccountConsumer (P2-6 Step 10).
 *
 * The cafeteria POS integration. Subscribes to `dev.fds.meal.served`
 * (or whatever `KAFKA_TOPIC_ENV` resolves to) under group
 * `lunch-account-consumer`. On every served meal:
 *
 *   1. Resolve the student's pay_lunch_accounts row inside the
 *      tenant tx (FOR UPDATE locked).
 *   2. INSERT a pay_lunch_transactions row (MEAL_CHARGE,
 *      source_event_id = inbound event_id) — schema-side dedup
 *      via the partial UNIQUE on source_event_id catches Kafka
 *      redelivery.
 *   3. Decrement balance.
 *   4. If balance just crossed low_balance_threshold, emit
 *      pay.lunch.low_balance (throttled to 1 per 24h via
 *      last_low_balance_alert_at).
 *
 * Idempotency: dual-layer.
 *   - Per-event_id consumer-group claim (claim-after-success).
 *   - Per-event source_event_id partial UNIQUE in the schema.
 *
 * The plan's payload contract for fds.meal.served (Cycle 20):
 *   { studentId, schoolId, mealDate, amount, posDeviceId,
 *     posSessionId, servedAt }
 */

interface MealServedPayload {
  studentId: string;
  schoolId: string;
  mealDate: string;
  amount: number;
  posDeviceId?: string | null;
  posSessionId?: string | null;
  servedAt?: string;
}

const CONSUMER_GROUP = 'lunch-account-consumer';

@Injectable()
export class LunchAccountConsumer implements OnModuleInit {
  private readonly logger = new Logger(LunchAccountConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly lunch: LunchAccountService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('fds.meal.served')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<MealServedPayload>(msg, this.logger);
    if (!event) return;
    const p = event.payload;
    if (!p.studentId || !p.schoolId || !p.mealDate || typeof p.amount !== 'number') {
      this.logger.warn(
        'Dropping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — missing required field on payload',
      );
      return;
    }
    if (p.amount <= 0) {
      this.logger.warn(
        'Dropping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — non-positive meal amount $' +
          p.amount,
      );
      return;
    }
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.lunch.chargeMealFromConsumer({
          studentId: p.studentId,
          amount: p.amount,
          mealDate: p.mealDate,
          posDeviceId: p.posDeviceId ?? null,
          sourceEventId: event.eventId,
          posSessionId: p.posSessionId ?? null,
        });
      },
    );
  }
}
