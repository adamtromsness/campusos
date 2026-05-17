import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import {
  AppraisalCommentService,
  AppraisalCycleService,
  AppraisalFrameworkService,
  AppraisalGoalService,
  AppraisalService,
  LessonObservationService,
} from './appraisals.service';
import { ExpenseClaimService } from './expense-claim.service';
import { AppraisalsController } from './appraisals.controller';

/**
 * Appraisals + Lesson Observations + Expense Claims — P2-4c
 * (Step 9 of the original P2C4 plan).
 *
 * Module shape:
 *   - Frameworks (rubrics with criteria JSONB).
 *   - Cycles (annual/mid-year/probationary, tied to academic year).
 *   - Appraisals — the SIGNED_OFF immutable terminal status.
 *   - Goals (SMART goals attached to an appraisal).
 *   - Comments (threaded; is_visible_to_employee splits private vs
 *     shared).
 *   - Lesson observations — KEYSTONE gated on the new
 *     lesson_observation:write permission code (granted only via
 *     everyFunction to School Admin / Platform Admin). Mirrors the
 *     P2C3 student_counseling_record:read pattern.
 *   - Expense claims (PD reimbursement) — multi-column decided_chk
 *     schema lockstep on approved_by + approved_at + rejection_reason.
 *
 * Permission gates:
 *   - hr-005:read   — own appraisal read (everyone).
 *   - hr-005:write  — admin-tier framework / cycle / appraisal
 *                     management (Staff covers Principal stand-in).
 *   - lesson_observation:write — School Admin / Platform Admin only.
 *   - hr-012:read   — own expense claim list (everyone).
 *   - hr-012:write  — submit own claim AND decide / pay claims.
 *                     Service-layer admin check binds approval to
 *                     school admin OR hr-012:admin via everyFunction.
 */
@Module({
  imports: [TenantModule, IamModule],
  providers: [
    AppraisalFrameworkService,
    AppraisalCycleService,
    AppraisalService,
    AppraisalGoalService,
    AppraisalCommentService,
    LessonObservationService,
    ExpenseClaimService,
  ],
  controllers: [AppraisalsController],
  exports: [
    AppraisalFrameworkService,
    AppraisalCycleService,
    AppraisalService,
    AppraisalGoalService,
    AppraisalCommentService,
    LessonObservationService,
    ExpenseClaimService,
  ],
})
export class AppraisalsModule {}
