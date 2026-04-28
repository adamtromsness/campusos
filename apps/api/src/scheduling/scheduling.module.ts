import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { SisModule } from '../sis/sis.module';
import { BellScheduleService } from './bell-schedule.service';
import { TimetableService } from './timetable.service';
import { RoomService } from './room.service';
import { RoomBookingService } from './room-booking.service';
import { RoomChangeRequestService } from './room-change-request.service';
import { CalendarService } from './calendar.service';
import { DayOverrideService } from './day-override.service';
import { CoverageService } from './coverage.service';
import { SubstitutionService } from './substitution.service';
import { CoverageConsumer } from './coverage.consumer';
import { BellScheduleController } from './bell-schedule.controller';
import { TimetableController } from './timetable.controller';
import { RoomController } from './room.controller';
import { RoomBookingController } from './room-booking.controller';
import { RoomChangeRequestController } from './room-change-request.controller';
import { CalendarController } from './calendar.controller';
import { CoverageController } from './coverage.controller';
import { SubstitutionController } from './substitution.controller';

/**
 * Scheduling Module — M22 Academic Scheduling (Cycle 5 Steps 5 + 6).
 *
 * Step 5 — timetable + rooms request path:
 *   - BellScheduleService — bell schedule + period CRUD with default-flip
 *   - TimetableService    — slot CRUD; EXCLUSION 23P01 -> 409 Conflict
 *   - RoomService         — room CRUD + period-availability annotation
 *   - RoomBookingService  — ad-hoc booking with timetable conflict check
 *   - RoomChangeRequestService — teacher request + admin approve/reject
 *
 * Step 6 — calendar + coverage path:
 *   - CalendarService     — event CRUD + GET /calendar/day/:date resolution
 *   - DayOverrideService  — day override CRUD
 *   - CoverageService     — coverage board + assign/cancel; emits
 *                            sch.coverage.assigned on assign
 *   - SubstitutionService — read-only views on the substitution timetable
 *   - CoverageConsumer    — Kafka consumer on hr.leave.coverage_needed,
 *                            inserts OPEN sch_coverage_requests rows for
 *                            each (slot, weekday-in-range) tuple, emits
 *                            sch.coverage.needed when new rows land
 *
 * Authorisation contract:
 *   - sch-001:read   — read bell schedules + the timetable.
 *   - sch-001:admin  — bell schedule + timetable slot writes.
 *   - sch-003:read   — read calendar + day overrides + day resolution.
 *   - sch-003:write  — calendar event create/update/delete (admin-only at
 *                       service layer too).
 *   - sch-003:admin  — day override create/delete.
 *   - sch-004:read   — read coverage requests + substitution timetable.
 *                       Non-admin staff see only their own coverage rows.
 *   - sch-004:write  — admin-only assign / cancel coverage.
 *   - sch-005:read   — list rooms + bookings + own change requests.
 *   - sch-005:write  — submit / cancel bookings; submit change requests;
 *                      approve / reject room change requests (admin-tier
 *                      check inside the service).
 *   - sch-005:admin  — room catalogue CRUD.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, SisModule],
  providers: [
    BellScheduleService,
    TimetableService,
    RoomService,
    RoomBookingService,
    RoomChangeRequestService,
    CalendarService,
    DayOverrideService,
    CoverageService,
    SubstitutionService,
    CoverageConsumer,
  ],
  controllers: [
    BellScheduleController,
    TimetableController,
    RoomController,
    RoomBookingController,
    RoomChangeRequestController,
    CalendarController,
    CoverageController,
    SubstitutionController,
  ],
  exports: [
    BellScheduleService,
    TimetableService,
    RoomService,
    RoomBookingService,
    RoomChangeRequestService,
    CalendarService,
    DayOverrideService,
    CoverageService,
    SubstitutionService,
  ],
})
export class SchedulingModule {}
