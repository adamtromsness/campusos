import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { PortfolioService } from './portfolio.service';
import { ShareService } from './share.service';
import { AchievementService } from './achievement.service';
import { PortfolioController } from './portfolio.controller';

/**
 * Portfolio Module — M26 (Cycle 24).
 *
 * 3 services + 1 controller + ~21 endpoints + 1 Kafka emit topic
 * (pfl.achievement.awarded).
 *
 * The fourth student-input surface in CampusOS after wellbeing
 * check-ins (Cycle 11.1), library reading logs / reviews (Cycle
 * 12), and clubs service hours (Cycle 17) — and the FIRST truly
 * student-owned surface where the student curates their own
 * academic narrative.
 *
 * Three structural keystones:
 *   1. STUDENT-OWNED — STUDENT actor holds the write authority
 *      on their own portfolio. Teachers and parents are read-only
 *      viewers gated by the student-controlled visibility setting.
 *   2. 4-tier visibility lattice — PRIVATE / TEACHER / PARENT /
 *      PUBLIC. Monotonic: each tier unlocks the strictly larger
 *      reader set.
 *   3. Polymorphic source resolution — pfl_portfolio_items.source_ref_id
 *      points at cls_submissions / cls_grades / pfl_achievements
 *      depending on item_type, with app-layer resolution at read.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [PortfolioService, ShareService, AchievementService],
  controllers: [PortfolioController],
  exports: [PortfolioService, ShareService, AchievementService],
})
export class PortfolioModule {}
