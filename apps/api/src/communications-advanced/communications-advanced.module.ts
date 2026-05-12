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
import { ModerationService } from './moderation.service';
import { AppealService } from './appeal.service';
import { AIModerationService } from './ai-moderation.service';
import { PushCampaignService } from './push-campaign.service';
import { CommunicationsAdvancedController } from './communications-advanced.controller';
import { TranslationConsumer } from './consumers/translation.consumer';
import { BroadcastAnalyticsConsumer } from './consumers/broadcast-analytics.consumer';
import { ModerationConsumer } from './consumers/moderation.consumer';
import { PushAnalyticsConsumer } from './consumers/push-analytics.consumer';
import { PushCampaignWorker } from './push-campaign.worker';

/**
 * Communications Advanced — Phase 2 Cycle 19 (P2-19a + P2-19b).
 *
 * 13 tables + 9 services + 1 controller + ~34 endpoints + 3 Kafka
 * consumers + 1 polling worker. Closes M40 Communications.
 *
 * P2-19a (6 tables, ~18 endpoints) — Translation + Templates +
 *   Broadcast Analytics:
 *     - AiInferenceService (stub for AI translation + sensitivity).
 *     - LanguagePreferenceService (per-user preferred_language).
 *     - TranslationService (on-demand AI translation with cache).
 *     - TemplateService (templates + render + usage log).
 *     - BroadcastSegmentService (audience targeting).
 *     - BroadcastAnalyticsService (per-(broadcast, segment) funnel).
 *     - TranslationConsumer (auto-translate worker).
 *     - BroadcastAnalyticsConsumer (delivery webhook receiver).
 *
 * P2-19b (7 tables, ~16 endpoints) — Moderation + Push Campaigns +
 *   Appeals:
 *     - ModerationService (three-tier rule catalogue + queue, most-
 *       restrictive-wins resolver).
 *     - AppealService (user appeal workflow; OVERTURNED releases the
 *       blocked message atomically).
 *     - AIModerationService (cached AI sensitivity scoring).
 *     - PushCampaignService (campaigns + analytics + device tokens).
 *     - ModerationConsumer (subscribes msg.message.posted, applies
 *       three-tier moderation, writes msg_moderation_actions).
 *     - PushAnalyticsConsumer (subscribes msg.push.delivered, UPSERTs
 *       msg_push_analytics with recomputed rates).
 *     - PushCampaignWorker (30s poll across all tenants, dispatches
 *       SCHEDULED rows whose scheduled_at has elapsed).
 *
 * Six structural keystones across the full cycle:
 *   1. Translation cache (P2-19a) — UNIQUE(message_id, target_language).
 *   2. Template render-time variable validation (P2-19a).
 *   3. Three-tier most-restrictive-wins moderation (P2-19b).
 *   4. Appeal OVERTURNED releases the parent action in same tx (P2-19b).
 *   5. AI moderation cache (P2-19b) — UNIQUE(message_id) keeps the
 *      AI Inference call to once per message.
 *   6. Push campaign send-time lockstep (P2-19b) — schema-side
 *      sent_chk pins (status, sent_at) atomic.
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
    ModerationService,
    AppealService,
    AIModerationService,
    PushCampaignService,
    TranslationConsumer,
    BroadcastAnalyticsConsumer,
    ModerationConsumer,
    PushAnalyticsConsumer,
    PushCampaignWorker,
  ],
  controllers: [CommunicationsAdvancedController],
  exports: [
    AiInferenceService,
    LanguagePreferenceService,
    TranslationService,
    TemplateService,
    BroadcastSegmentService,
    BroadcastAnalyticsService,
    ModerationService,
    AppealService,
    AIModerationService,
    PushCampaignService,
  ],
})
export class CommunicationsAdvancedModule {}
