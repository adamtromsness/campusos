import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { BellScheduleService } from './bell-schedule.service';
import { TimetableService } from './timetable.service';
import { RoomService } from './room.service';
import { RoomBookingService } from './room-booking.service';
import { RoomChangeRequestService } from './room-change-request.service';
import { BellScheduleController } from './bell-schedule.controller';
import { TimetableController } from './timetable.controller';
import { RoomController } from './room.controller';
import { RoomBookingController } from './room-booking.controller';
import { RoomChangeRequestController } from './room-change-request.controller';

/**
 * Scheduling Module — M22 Academic Scheduling (Cycle 5 Step 5).
 *
 * Lands the timetable + rooms request path:
 *   - BellScheduleService — bell schedule + period CRUD with default-flip
 *   - TimetableService    — slot CRUD; EXCLUSION 23P01 -> 409 Conflict
 *   - RoomService         — room CRUD + period-availability annotation
 *   - RoomBookingService  — ad-hoc booking with timetable conflict check
 *   - RoomChangeRequestService — teacher request + admin approve/reject
 *
 * Steps 6+ will add the calendar / coverage / substitution side and the
 * CoverageConsumer for `hr.leave.coverage_needed`. The TimetableService
 * already emits `sch.timetable.updated` so the future calendar / coverage
 * code can react without further wiring on the writer side.
 *
 * Authorisation contract:
 *   - sch-001:read   — read bell schedules + the timetable.
 *   - sch-001:admin  — bell schedule + timetable slot writes.
 *   - sch-005:read   — list rooms + bookings + own change requests.
 *   - sch-005:write  — submit / cancel bookings; submit change requests;
 *                      approve / reject room change requests (admin-tier
 *                      check inside the service).
 *   - sch-005:admin  — room catalogue CRUD.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    BellScheduleService,
    TimetableService,
    RoomService,
    RoomBookingService,
    RoomChangeRequestService,
  ],
  controllers: [
    BellScheduleController,
    TimetableController,
    RoomController,
    RoomBookingController,
    RoomChangeRequestController,
  ],
  exports: [
    BellScheduleService,
    TimetableService,
    RoomService,
    RoomBookingService,
    RoomChangeRequestService,
  ],
})
export class SchedulingModule {}
