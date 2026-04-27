import { Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { IdempotencyService } from './idempotency.service';
import { TenantModule } from '../tenant/tenant.module';

/**
 * KafkaModule
 *
 * Provides shared Kafka infrastructure:
 *   - KafkaProducerService — best-effort producer (Cycle 1).
 *   - KafkaConsumerService — best-effort consumer registry (Cycle 2 Step 6).
 *   - IdempotencyService — wraps platform.platform_event_consumer_idempotency
 *     so handlers can claim events at most once per consumer group.
 *
 * Both transports connect once on app boot and disconnect on shutdown.
 */
@Module({
  imports: [TenantModule],
  providers: [KafkaProducerService, KafkaConsumerService, IdempotencyService],
  exports: [KafkaProducerService, KafkaConsumerService, IdempotencyService],
})
export class KafkaModule {}
