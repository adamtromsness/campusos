import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { SisModule } from '../students/sis.module';
import { AttendanceService } from './attendance.service';
import { AbsenceRequestService } from './absence-request.service';
import { AttendanceController } from './attendance.controller';

/**
 * AttendanceModule — Cycle 1 Step 6.
 *
 * Provides the teacher attendance workflow (open class period →
 * pre-populate → mark exceptions → batch submit) and the parent
 * absence-request workflow.
 *
 * Consumes SisModule (ClassService.getRoster, StudentService) for
 * roster lookups, and KafkaModule for event emission. Events are
 * fire-and-forget in Cycle 1; consumers land in Cycle 3.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, SisModule],
  providers: [AttendanceService, AbsenceRequestService],
  controllers: [AttendanceController],
  exports: [AttendanceService, AbsenceRequestService],
})
export class AttendanceModule {}
