import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { RestorativeJusticeService } from './restorative-justice.service';
import { PeerMediationService } from './peer-mediation.service';
import { PositiveBehaviourService } from './positive-behaviour.service';
import { CategoryConfigService } from './category-config.service';
import { BipFeedbackService } from '../intervention-plans/bip-feedback.service';
import { OverdueActionWorker } from './overdue-action.worker';
import { BehaviourAdvancedController } from './behaviour-advanced.controller';

/**
 * Behaviour Advanced Module (Phase 2 Cycle 14 — P2-14).
 *
 * Five services + one worker + one controller + ~20 endpoints + 2
 * Kafka emit topics. Extends Cycle 9 (sis_discipline_incidents) and
 * Cycle 11 (svc_bip_teacher_feedback) with the restorative + preventive
 * layer.
 *
 * Services:
 *   RestorativeJusticeService — RJ conference lifecycle + agreement
 *                               actions + auto-resolution. Emits
 *                               beh.rj_conference.resolved via
 *                               OutboxService.enqueueInTx when every
 *                               action completes.
 *   PeerMediationService      — Trained peer mediator workflow.
 *                               Schema CHECKs reject self/dup parties
 *                               at the DB layer.
 *   PositiveBehaviourService  — Points award/redeem ledger + rewards
 *                               marketplace. Emits
 *                               beh.positive_points.awarded.
 *   CategoryConfigService     — Tenant-scoped school_config-backed
 *                               positive_behaviour_categories.
 *   BipFeedbackService        — BIP teacher feedback collection on
 *                               existing Cycle 11 svc_bip_teacher_feedback.
 *
 * Worker:
 *   OverdueActionWorker — nightly cron flips PENDING agreement actions
 *                         past due_date to OVERDUE.
 *
 * Authorisation contract (uses existing BEH-001 + BEH-002 codes):
 *   beh-001:read   — list / read RJ conferences, mediations, positive
 *                    points history, rewards catalogue, categories.
 *   beh-001:write  — initiate RJ conference, refer mediation, award
 *                    points, redeem reward.
 *   beh-001:admin  — manage rewards marketplace, configure positive
 *                    categories, schedule/resolve mediations.
 *   beh-002:read   — read BIP teacher feedback (counsellor + assigned
 *                    teacher submit path).
 *   beh-002:write  — request BIP teacher feedback (counsellor + admin).
 *
 * 2 Kafka emits: beh.rj_conference.resolved (durable outbox) +
 *                beh.positive_points.awarded (best-effort).
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    RestorativeJusticeService,
    PeerMediationService,
    PositiveBehaviourService,
    CategoryConfigService,
    BipFeedbackService,
    OverdueActionWorker,
  ],
  controllers: [BehaviourAdvancedController],
  exports: [
    RestorativeJusticeService,
    PeerMediationService,
    PositiveBehaviourService,
    CategoryConfigService,
    BipFeedbackService,
    OverdueActionWorker,
  ],
})
export class BehaviourAdvancedModule {}
