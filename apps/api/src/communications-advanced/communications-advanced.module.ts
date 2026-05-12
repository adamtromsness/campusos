import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { AiInferenceService } from './ai-inference.service';
import { LanguagePreferenceService } from './language-preference.service';
import { TranslationService } from './translation.service';
import { TemplateService } from './template.service';
import { BroadcastSegmentService } from './broadcast-segment.service';
import { BroadcastAnalyticsService } from './broadcast-analytics.service';
import { CommunicationsAdvancedController } from './communications-advanced.controller';
import { TranslationConsumer } from './consumers/translation.consumer';
import { BroadcastAnalyticsConsumer } from './consumers/broadcast-analytics.consumer';

/**
 * Communications Advanced — Phase 2 Cycle 19 sub-cycle a (P2-19a).
 *
 * 6 tables + 5 services + 1 controller + ~18 endpoints + 2 Kafka
 * consumers (TranslationConsumer on msg.message.posted +
 * BroadcastAnalyticsConsumer on msg.broadcast.delivered). Opens
 * P2-19; the moderation + push campaigns surface ships in P2-19b.
 *
 * Two structural keystones in this cycle:
 *   1. Translation cache (UNIQUE(message_id, target_language)) — same
 *      message + same language returns the cached row, never re-
 *      translates. The AI Inference service is stubbed in dev and
 *      swapped for a real HTTP client when the extracted service
 *      deploys.
 *   2. Template render-time variable validation — required variables
 *      without a provided value AND without a default_value cause
 *      render() to throw 400 carrying the offending names. Schools
 *      cannot accidentally send "Hello {student_name}" to families
 *      when the placeholder wasn't filled.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    AiInferenceService,
    LanguagePreferenceService,
    TranslationService,
    TemplateService,
    BroadcastSegmentService,
    BroadcastAnalyticsService,
    TranslationConsumer,
    BroadcastAnalyticsConsumer,
  ],
  controllers: [CommunicationsAdvancedController],
  exports: [
    AiInferenceService,
    LanguagePreferenceService,
    TranslationService,
    TemplateService,
    BroadcastSegmentService,
    BroadcastAnalyticsService,
  ],
})
export class CommunicationsAdvancedModule {}
