import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { EnrollmentPeriodService } from './enrollment-period.service';
import { ApplicationService } from './application.service';
import { OfferService } from './offer.service';
import { WaitlistService } from './waitlist.service';
import { CapacitySummaryService } from './capacity-summary.service';
import { EnrollmentPeriodController } from './enrollment-period.controller';
import { ApplicationController } from './application.controller';
import { OfferController } from './offer.controller';
import { WaitlistController } from './waitlist.controller';

/**
 * Enrollment Module — M81 Admissions (Cycle 6 Step 6).
 *
 * Five services + four controllers + 16 endpoints. Three Kafka emits
 * (enr.application.submitted, enr.application.status_changed,
 * enr.student.enrolled) plus two supplementary topics
 * (enr.offer.issued, enr.offer.responded) used by the future
 * notification + enrollment confirmation flows.
 *
 * - EnrollmentPeriodService — period CRUD + nested streams + capacities.
 *                             Admin writes lock the row FOR UPDATE.
 * - ApplicationService      — submit (parent or admin), list (row-scoped),
 *                             get, admin status transitions (locked),
 *                             admin notes timeline. Notes flagged
 *                             is_confidential=true are filtered from the
 *                             non-admin payload.
 * - OfferService            — issue (admin), set conditions met (admin
 *                             on CONDITIONAL only), respond (parent or
 *                             admin acting for parent). On parent ACCEPT,
 *                             flips the application to ENROLLED and
 *                             emits enr.student.enrolled — the future
 *                             PaymentAccountWorker (Step 7) is the
 *                             consumer.
 * - WaitlistService         — admin-only list + offer-from-waitlist.
 *                             Promote rotates the entry through OFFERED
 *                             status while issuing the new offer in one
 *                             tx.
 * - CapacitySummaryService  — internal-only UPSERT helper. Called by
 *                             ApplicationService and OfferService inside
 *                             the same tx as every status flip.
 *
 * Authorisation contract:
 *   - stu-003:read   — read enrollment periods, own application(s) (parent
 *                       row-scope on guardian_person_id), or all (admin).
 *   - stu-003:write  — submit applications (parent or admin); respond to
 *                       offers (parent or admin acting for parent).
 *   - stu-003:admin  — period / stream / capacity CRUD; admin status
 *                       transitions; offer issue + conditions verify;
 *                       waitlist read + promote.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    EnrollmentPeriodService,
    ApplicationService,
    OfferService,
    WaitlistService,
    CapacitySummaryService,
  ],
  controllers: [
    EnrollmentPeriodController,
    ApplicationController,
    OfferController,
    WaitlistController,
  ],
  exports: [
    EnrollmentPeriodService,
    ApplicationService,
    OfferService,
    WaitlistService,
    CapacitySummaryService,
  ],
})
export class EnrollmentModule {}
