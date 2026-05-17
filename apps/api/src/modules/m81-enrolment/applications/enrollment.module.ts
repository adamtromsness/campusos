import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { EnrollmentPeriodService } from './enrollment-period.service';
import { ApplicationService } from './application.service';
import { OfferService } from '../offers/offer.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { CapacitySummaryService } from '../capacity/capacity-summary.service';
import { EnrollmentSearchService } from './enrollment-search.service';
import { ApplicationStageService } from './application-stage.service';
import { ApplicationScoringService } from './application-scoring.service';
import { OnboardingService } from './onboarding.service';
import { EnrollmentPeriodController } from './enrollment-period.controller';
import { ApplicationController } from './application.controller';
import { OfferController } from '../offers/offer.controller';
import { WaitlistController } from '../waitlist/waitlist.controller';
import { EnrollmentSearchController } from './enrollment-search.controller';
import { ApplicationStageController } from './application-stage.controller';
import { ApplicationScoringController } from './application-scoring.controller';
import { OnboardingController } from './onboarding.controller';

/**
 * Enrollment Module — M81 Admissions.
 *
 * Cycle 6 shipped the bulk of M81 (period CRUD, application
 * lifecycle, offer/waitlist, capacity summary, public search). Cycle
 * 16 layers in:
 *   - ApplicationStageService — multi-stage review pipeline (UNDER_REVIEW
 *       → INTERVIEW → ASSESSMENT → OFFERED → ACCEPTED) with locked-row
 *       transition gate + immutable enr_application_stages audit.
 *   - ApplicationScoringService — per-criterion scores with UNIQUE
 *       (application, criterion) catch.
 *   - OnboardingService — checklist templates + per-student progress
 *       generation (inside the offer-accept tx) + task completion
 *       with auto-flip-to-COMPLETE + enr.student.onboarded emit when
 *       the last mandatory task lands.
 *
 * OfferService is hooked: on parent ACCEPT it now auto-generates the
 * onboarding progress row inside the same tenant tx that flips the
 * application to ENROLLED. enr.student.enrolled (Cycle 6) keeps
 * firing on offer-accept; enr.student.onboarded (Cycle 16) fires
 * only when the school finishes onboarding the student.
 *
 * Authorisation contract:
 *   - stu-003:read   — read enrollment periods, own application(s) (parent
 *                       row-scope), or all (admin); read stages, scores,
 *                       onboarding progress.
 *   - stu-003:write  — submit applications (parent or admin); respond to
 *                       offers (parent or admin acting for parent);
 *                       advance stages; record scores; complete onboarding
 *                       tasks (EO / admin only — service-side check).
 *   - stu-003:admin  — period / stream / capacity CRUD; admin status
 *                       transitions; offer issue + conditions verify;
 *                       waitlist read + promote; checklist template CRUD;
 *                       waive onboarding tasks.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    EnrollmentPeriodService,
    ApplicationService,
    OfferService,
    WaitlistService,
    CapacitySummaryService,
    EnrollmentSearchService,
    ApplicationStageService,
    ApplicationScoringService,
    OnboardingService,
  ],
  controllers: [
    EnrollmentPeriodController,
    ApplicationController,
    OfferController,
    WaitlistController,
    EnrollmentSearchController,
    ApplicationStageController,
    ApplicationScoringController,
    OnboardingController,
  ],
  exports: [
    EnrollmentPeriodService,
    ApplicationService,
    OfferService,
    WaitlistService,
    CapacitySummaryService,
    EnrollmentSearchService,
    ApplicationStageService,
    ApplicationScoringService,
    OnboardingService,
  ],
})
export class EnrollmentModule {}
