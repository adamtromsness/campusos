import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { TourSlotService } from './tour-slot.service';
import { TourBookingService } from './tour-booking.service';
import { TourController } from './tour.controller';
import { WithdrawalService } from '../withdrawals/withdrawal.service';
import { ExitTaskService } from '../withdrawals/exit-task.service';
import { ReenrolmentService } from '../applications/reenrolment.service';
import { MidYearAdmissionService } from '../applications/mid-year-admission.service';
import { WithdrawalController } from '../withdrawals/withdrawal.controller';
import { ReenrolmentController } from '../applications/reenrolment.controller';
import { MidYearAdmissionController } from '../applications/mid-year-admission.controller';
import { ExitTaskTemplateService } from '../withdrawals/exit-task-template.service';
import { ExitTaskTemplateController } from '../withdrawals/exit-task-template.controller';

/**
 * Enrolment Advanced Module — Phase 2 Cycle 5 (P2-5).
 *
 * Plan reference — docs/campusos-p2c5-enrolment-advanced.html.
 *
 * Layers on top of Cycle 16's M81 admissions pipeline three
 * lifecycle bookends:
 *
 *   Tours (Steps 1, 4)
 *     - TourSlotService — slot calendar + admin CRUD.
 *     - TourBookingService — public booking with ADR-055
 *       iam_person creation, locked-row capacity check, +
 *       enr.tour.booked outbox emit.
 *
 *   Withdrawal + Re-enrolment + Mid-Year (Steps 2, 5)
 *     - WithdrawalService — initiate (auto-creates the per-school
 *       exit task checklist from the platform_tenant_configs
 *       template) + list + complete (gated on every task being
 *       COMPLETED, WAIVED, or NOT_APPLICABLE; fires
 *       enr.student.withdrawn AFTER tx commits and flips the
 *       sis_students.enrollment_status to WITHDRAWN).
 *     - ExitTaskService — per-department staff close their own
 *       category's tasks. Service-layer per-category routing
 *       prevents cross-department task closure.
 *     - ReenrolmentService — parent submits next-year
 *       confirmation. confirmed_continuing=false auto-initiates a
 *       withdrawal in the same tx.
 *     - MidYearAdmissionService — out-of-cycle admission with
 *       capacity check + linked_application_id back into the
 *       Cycle 16 pipeline.
 *
 *   Exit Task Templates (Step 8)
 *     - ExitTaskTemplateService — admin reads + writes the
 *       configurable per-school checklist stored in
 *       platform_tenant_configs.withdrawal_exit_task_template.
 *
 * Authorisation contract:
 *   - stu-003:read   — read tours + bookings + own re-enrolment confirmations.
 *   - stu-003:write  — book tours (when authenticated), patch bookings.
 *   - stu-003:admin  — slot CRUD; admin booking writes.
 *   - stu-004:read   — read own withdrawals + re-enrolment confirmations + mid-year requests.
 *   - stu-004:write  — initiate own withdrawal, complete department exit tasks,
 *                      submit re-enrolment confirmation, submit mid-year request.
 *   - stu-004:admin  — complete withdrawals, place re-enrolment holds,
 *                      EO-driven mid-year offer / capacity checks,
 *                      exit task template management.
 *   - Public (no auth) — browse published tour slots, book a tour slot.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    TourSlotService,
    TourBookingService,
    WithdrawalService,
    ExitTaskService,
    ReenrolmentService,
    MidYearAdmissionService,
    ExitTaskTemplateService,
  ],
  controllers: [
    TourController,
    WithdrawalController,
    ReenrolmentController,
    MidYearAdmissionController,
    ExitTaskTemplateController,
  ],
  exports: [
    TourSlotService,
    TourBookingService,
    WithdrawalService,
    ExitTaskService,
    ReenrolmentService,
    MidYearAdmissionService,
    ExitTaskTemplateService,
  ],
})
export class EnrolmentAdvancedModule {}
