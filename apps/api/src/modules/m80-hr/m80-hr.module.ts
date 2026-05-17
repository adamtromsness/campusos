import { Module } from '@nestjs/common';
import { HrModule } from './employees/hr.module';
import { PayrollModule } from './payroll/payroll.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { TrainingModule } from './training/training.module';
import { AppraisalsModule } from './appraisals/appraisals.module';

/**
 * M80 HR — canonical aggregator for HR core (employees, leave,
 * onboarding), payroll, recruitment, training & certifications, and
 * appraisals / lesson observations / expense claims.
 */
@Module({
  imports: [HrModule, PayrollModule, RecruitmentModule, TrainingModule, AppraisalsModule],
  exports: [HrModule, PayrollModule, RecruitmentModule, TrainingModule, AppraisalsModule],
})
export class M80HrModule {}
