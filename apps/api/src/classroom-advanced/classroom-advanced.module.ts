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
import { StandardGradeService } from './standard-grade.service';
import { StandardGradeController } from './standard-grade.controller';
import { PeerReviewService } from './peer-review.service';
import { PeerReviewController } from './peer-review.controller';
import { ObservationService } from './observation.service';
import { ObservationController } from './observation.controller';
import { ReportCardSubjectService } from './report-card-subject.service';
import { ReportCardSubjectController } from './report-card-subject.controller';
import { FormativeAssessmentService } from './formative-assessment.service';
import { FormativeAssessmentController } from './formative-assessment.controller';

/**
 * ClassroomAdvancedModule — Phase 2 Cycle 7 sub-cycles a + b (P2-7a, P2-7b).
 *
 * P2-7a — Hall passes (4-state lifecycle, configurable concurrent + daily
 * limits, OverdueWorker cron flips ACTIVE rows past expected_return_at to
 * OVERDUE), rubrics engine (template + assignment-specific, weighted criteria
 * with SUM-equals-100 non-blocking warning, per-(submission, criterion,
 * scorer) UPSERT scores), and class moments (teacher-posted photo feed
 * visible to enrolled students' families with LIKE / LOVE / CELEBRATE
 * reactions).
 *
 * P2-7b — Standards-based gradebook (per-standard proficiency rating
 * UPSERT + evidence linking to cls_submissions/cls_grades), peer review
 * (anonymisation keystone — reviewer identity stripped from DTO when the
 * parent assignment is is_anonymous=true and the reading actor is a
 * student), student observations (lighter than report cards, mid-term
 * teacher notes with PROGRESS / CONCERN / COMMENDATION categorisation
 * and is_shared_with_parent visibility flag), report card subjects
 * (snapshot per-(report_card, subject) rows over the existing Cycle 2
 * report cards), and formative assessment (real-time check-for-
 * understanding with EXIT_TICKET / POLL / QUICK_CHECK / DO_NOW types
 * and JSONB questions + responses).
 *
 * Permission gates:
 *   - att-005:read+write — Hall passes (Teacher / Admin write; Student
 *     read on own; Parent currently no grant — service returns empty list).
 *   - tch-001:read+write — Rubrics (Teacher write; Student read for
 *     rubric viewing on own submissions).
 *   - tch-002:read+write — Peer review + formative assessment (Teacher
 *     write; Student read on own assigned reviews; Student write on
 *     own response submission via /respond).
 *   - tch-003:read+write — Standards gradebook + observations + report
 *     card subjects (Teacher write; Student read for own profile;
 *     Parent read for shared-with-parent observations).
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
  providers: [
    HallPassService,
    HallPassOverdueWorker,
    RubricService,
    ClassMomentService,
    StandardGradeService,
    PeerReviewService,
    ObservationService,
    ReportCardSubjectService,
    FormativeAssessmentService,
  ],
  controllers: [
    HallPassController,
    RubricController,
    ClassMomentController,
    StandardGradeController,
    PeerReviewController,
    ObservationController,
    ReportCardSubjectController,
    FormativeAssessmentController,
  ],
  exports: [
    HallPassService,
    RubricService,
    ClassMomentService,
    StandardGradeService,
    PeerReviewService,
    ObservationService,
    ReportCardSubjectService,
    FormativeAssessmentService,
  ],
})
export class ClassroomAdvancedModule {}
