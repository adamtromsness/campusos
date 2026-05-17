export { KafkaModule } from './kafka.module';
export { KafkaProducerService, KafkaProducerNotConnectedError } from './kafka-producer.service';
export type { EmitOptions } from './kafka-producer.service';
export { KafkaConsumerService, DlqWriteFailureError } from './kafka-consumer.service';
export type { ConsumedMessage, MessageHandler } from './kafka-consumer.service';
export { IdempotencyService } from './idempotency.service';
export { OutboxService } from './outbox.service';
export type { OutboxEnqueueOptions, OutboxTxClient } from './outbox.service';
export { OutboxPublisherWorker } from './outbox-publisher.worker';
export {
  envelopeFromOptions,
  prefixedTopic,
  unprefixTopic,
} from './event-envelope';
export type { EventEnvelope, EnvelopeOptions } from './event-envelope';
export { assertValidEnvelope, EnvelopeValidationError } from './envelope-validator';
export { unwrapEnvelope, processWithIdempotency } from './envelope-consumer';
export type { UnwrappedEvent } from './envelope-consumer';
