import { Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';

/**
 * KafkaModule
 *
 * Provides a shared KafkaProducerService for any domain module that
 * needs to emit events. Connected once on app boot, disconnected on
 * shutdown. Best-effort delivery (see KafkaProducerService).
 */
@Module({
  providers: [KafkaProducerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
