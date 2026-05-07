import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { KafkaModule } from '../kafka/kafka.module';
import { DlqController } from './dlq.controller';
import { DlqService } from './dlq.service';

/**
 * Cycle 31 Step 7 — DLQ Module.
 *
 * Surfaces the platform.platform_dlq_messages dead-letter queue
 * via the platform admin dashboard. Consumer hardening (envelope
 * validation, circuit breakers) lives in apps/api/src/kafka/ and is
 * shared infrastructure.
 */
@Module({
  imports: [KafkaModule],
  providers: [
    {
      provide: PrismaClient,
      useFactory: () =>
        new PrismaClient({
          datasourceUrl: process.env.DATABASE_URL,
        }),
    },
    DlqService,
  ],
  controllers: [DlqController],
  exports: [DlqService],
})
export class DlqModule {}
