import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { HallPassService } from './hall-pass.service';
import { HallPassController } from './hall-pass.controller';
import { HallPassOverdueWorker } from './hall-pass-overdue.worker';
import { RubricService } from './rubric.service';
import { RubricController } from './rubric.controller';
import { ClassMomentService } from './class-moment.service';
import { ClassMomentController } from './class-moment.controller';

/**
 * ClassroomAdvancedModule — Phase 2 Cycle 7 sub-cycle a (P2-7a).
 *
 * Hall passes (4-state lifecycle, configurable concurrent + daily limits,
 * OverdueWorker cron flips ACTIVE rows past expected_return_at to OVERDUE),
 * rubrics engine (template + assignment-specific, weighted criteria with
 * SUM-equals-100 non-blocking warning, per-(submission, criterion, scorer)
 * UPSERT scores), and class moments (teacher-posted photo feed visible to
 * enrolled students' families with LIKE / LOVE / CELEBRATE reactions).
 *
 * Permission gates:
 *   - att-005:read+write — Hall passes (Teacher / Admin write; Student
 *     read on own; Parent currently no grant — service returns empty list).
 *   - tch-001:read+write — Rubrics (Teacher write; Student read for
 *     rubric viewing on own submissions).
 *   - tch-009:read+write — Class moments (Teacher write; Parent read on
 *     enrolled-children's classes; Student read on enrolled classes).
 *
 * Kafka emits:
 *   - cls.hall_pass.issued — fires after issue tx commits.
 *   - cls.hall_pass.overdue — fires per row that the OverdueWorker flips.
 *
 * Workers:
 *   - HallPassOverdueWorker — once per minute walks every active school
 *     and flips ACTIVE passes past expected_return_at to OVERDUE.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [HallPassService, HallPassOverdueWorker, RubricService, ClassMomentService],
  controllers: [HallPassController, RubricController, ClassMomentController],
  exports: [HallPassService, RubricService, ClassMomentService],
})
export class ClassroomAdvancedModule {}
