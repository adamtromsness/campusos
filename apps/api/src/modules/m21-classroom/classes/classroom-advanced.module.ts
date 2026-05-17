import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { NotificationsModule } from '@modules/m40-communications/notifications/notifications.module';
import { HallPassService } from '../hall-passes/hall-pass.service';
import { HallPassController } from '../hall-passes/hall-pass.controller';
import { HallPassOverdueWorker } from '../hall-passes/hall-pass-overdue.worker';
import { RubricService } from '../assignments/rubric.service';
import { RubricController } from '../assignments/rubric.controller';
import { ClassMomentService } from './class-moment.service';
import { ClassMomentController } from './class-moment.controller';
import { StandardGradeService } from '../grading/standard-grade.service';
import { StandardGradeController } from '../grading/standard-grade.controller';
import { PeerReviewService } from '../peer-review/peer-review.service';
import { PeerReviewController } from '../peer-review/peer-review.controller';
import { ObservationService } from '../grading/observation.service';
import { ObservationController } from '../grading/observation.controller';
import { ReportCardSubjectService } from '../report-cards/report-card-subject.service';
import { ReportCardSubjectController } from '../report-cards/report-card-subject.controller';
import { FormativeAssessmentService } from '../assignments/formative-assessment.service';
import { FormativeAssessmentController } from '../assignments/formative-assessment.controller';
import { AITutoringService } from '../ai-tutoring/ai-tutoring.service';
import { AITutoringController } from '../ai-tutoring/ai-tutoring.controller';
import { AIGatewayService } from '../ai-tutoring/ai-gateway.service';
import { AIUsageService } from '../ai-tutoring/ai-usage.service';
import { AIUsageController } from '../ai-tutoring/ai-usage.controller';
import { AIOptOutService } from '../ai-tutoring/ai-opt-out.service';
import { AIOptOutController } from '../ai-tutoring/ai-opt-out.controller';
import { LessonRecordingService } from '../lessons/lesson-recording.service';
import { LessonRecordingController } from '../lessons/lesson-recording.controller';
import { VideoTranscriptConsumer } from '../lessons/video-transcript.consumer';
import { LessonSummaryConsumer } from '../lessons/lesson-summary.consumer';

/**
 * ClassroomAdvancedModule — Phase 2 Cycle 7 (P2-7) sub-cycles a + b + c.
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
 * student), student observations, report card subjects, formative
 * assessment.
 *
 * P2-7c — AI tutoring with conversation history and opt-out keystone, AI
 * Gateway stub for the AI Inference extracted service per ADR-004, lesson
 * video recording with VideoTranscriptConsumer + LessonSummaryConsumer
 * pipeline, AI usage logging with per-tenant Redis quota enforcement.
 *
 * Three load-bearing AI safety rules from ADR-004 enforced at the service
 * layer (the schema cannot enforce them but the service tests pin them
 * as regression tests):
 *
 *   1. AI MUST NEVER write to cls_grades. AITutoringService reads from
 *      cls_grades for context but never inserts or updates a grade row.
 *      Only teacher action via Cycle 2 GradeService writes that table.
 *   2. AI MUST NEVER receive student PII in prompts. The
 *      AITutoringService.toAnonymousId helper hashes student_id +
 *      session_id into an opaque token before any AI Gateway call.
 *      The system prompt contains the subject only.
 *   3. AI tutoring opt-out is hard-gated. AITutoringService checks
 *      cls_ai_tutoring_opt_outs before every session start AND every
 *      message — opted-out students receive 403 even on admin override.
 *
 * Permission gates:
 *   - att-005:read+write — Hall passes.
 *   - tch-001:read+write — Rubrics + Lesson Recordings.
 *   - tch-002:read+write — Peer review + formative assessment.
 *   - tch-003:read+write — Standards gradebook + observations + report
 *     card subjects.
 *   - tch-007:read+write — AI tutoring (Student + Teacher + VP).
 *   - tch-007:admin     — AI Usage admin dashboard (admin tier only).
 *   - tch-009:read+write — Class moments.
 *
 * Kafka emits:
 *   - cls.hall_pass.issued + cls.hall_pass.overdue (P2-7a)
 *   - video.uploaded — emitted by LessonRecordingService.create. The
 *     Video Processing service consumes this off the bus and publishes
 *     video.transcribed when the transcript is ready.
 *   - lesson.summary.ready — emitted by LessonRecordingService.applySummary
 *     for downstream teacher notification fan-out.
 *
 * Kafka consumers:
 *   - VideoTranscriptConsumer (group classroom-video-transcript-consumer)
 *     subscribes to dev.video.transcribed.
 *   - LessonSummaryConsumer (group classroom-lesson-summary-consumer)
 *     subscribes to dev.lesson.summary.from_ai for the production AI
 *     Inference response wire (chained inline in dev).
 *
 * Workers:
 *   - HallPassOverdueWorker — once per minute walks every active school
 *     and flips ACTIVE passes past expected_return_at to OVERDUE.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
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
    AITutoringService,
    AIGatewayService,
    AIUsageService,
    AIOptOutService,
    LessonRecordingService,
    VideoTranscriptConsumer,
    LessonSummaryConsumer,
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
    AITutoringController,
    AIUsageController,
    AIOptOutController,
    LessonRecordingController,
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
    AITutoringService,
    AIGatewayService,
    AIUsageService,
    AIOptOutService,
    LessonRecordingService,
  ],
})
export class ClassroomAdvancedModule {}
