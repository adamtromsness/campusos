import { Module } from '@nestjs/common';
import { CounsellingModule } from './counselling/counselling.module';
import { WellbeingModule } from './wellbeing/wellbeing.module';
import { StudentServicesAdvancedModule } from './student-services-advanced/student-services-advanced.module';

/**
 * M27 Student Services — canonical aggregator for counselling,
 * wellbeing, and student-services-advanced (caseload, referrals,
 * crisis escalation, MTSS coordination).
 */
@Module({
  imports: [CounsellingModule, WellbeingModule, StudentServicesAdvancedModule],
  exports: [CounsellingModule, WellbeingModule, StudentServicesAdvancedModule],
})
export class M27StudentServicesModule {}
