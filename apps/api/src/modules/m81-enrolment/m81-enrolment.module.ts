import { Module } from '@nestjs/common';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { EnrolmentAdvancedModule } from './enrolment-advanced/enrolment-advanced.module';

/**
 * M81 Enrolment — canonical aggregator for enrolment core
 * (applications, offers, waitlist, withdrawals) and enrolment-advanced
 * (tours, capacity, re-enrolment).
 */
@Module({
  imports: [EnrollmentModule, EnrolmentAdvancedModule],
  exports: [EnrollmentModule, EnrolmentAdvancedModule],
})
export class M81EnrolmentModule {}
