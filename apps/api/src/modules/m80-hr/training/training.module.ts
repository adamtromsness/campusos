import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { TrainingProgrammeService } from './programme.service';
import { TrainingEventService } from './event.service';
import { CompletionService } from './completion.service';
import { CertificationTypeService, EmployeeCertificationService } from './certification.service';
import { TrainingController } from './training.controller';

/**
 * Training & Certifications — P2-4c sub-cycle (Step 8 of the
 * original P2C4 plan, shipped as P2-4c after the cycle was split
 * 4a / 4b / 4c per the plan's context-limit guidance).
 *
 * Module shape:
 *   - Programme catalogue (hr_training_programmes)
 *   - Event scheduling (hr_training_events) with multi-column
 *     completed_chk + cancelled_chk lifecycle invariants from
 *     migration 116.
 *   - Completion records (hr_training_completions, UNIQUE keystone
 *     for idempotency under retry) — emits `hr.training.completed`
 *     via OutboxService.enqueueInTx (durable outbox pattern from
 *     P2-4a Round 1) and runs the AUTO-ISSUE keystone for matching
 *     hr_certification_types rows.
 *   - Certification type catalogue (hr_certification_types)
 *   - Employee certifications (hr_employee_certifications) — flexible
 *     per-employee records keyed on the type catalogue. Coexists with
 *     Cycle 4 hr_staff_certifications (the legacy 10-value enum table).
 *
 * Permission gates: hr-004:read covers the catalogue + own-employee
 * records (service-layer narrowing binds non-admin readers to
 * actor.employeeId for own training history). hr-004:write covers
 * admin programme / event / cert type management + completion
 * recording. School Admin / Platform Admin pick up hr-004:admin via
 * everyFunction.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    TrainingProgrammeService,
    TrainingEventService,
    CompletionService,
    CertificationTypeService,
    EmployeeCertificationService,
  ],
  controllers: [TrainingController],
  exports: [
    TrainingProgrammeService,
    TrainingEventService,
    CompletionService,
    CertificationTypeService,
    EmployeeCertificationService,
  ],
})
export class TrainingModule {}
