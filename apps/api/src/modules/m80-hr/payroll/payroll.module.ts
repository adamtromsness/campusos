import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { PayrollController } from './payroll.controller';
import { PayGradeService } from './pay-grade.service';
import { PayrollService } from './payroll.service';
import { SalaryReviewService } from './salary-review.service';

/**
 * Payroll Module — P2C4 sub-cycle a (Phase 2 Cycle 4).
 *
 * 3 services + 1 controller + ~18 endpoints + 1 Kafka emit topic
 * (hr.payroll.processed for the Cycle 26 GLConsumer).
 *
 * Three structural keystones:
 *   1. PAYROLL UPSERT IDEMPOTENCY — UNIQUE(employee_id, pay_period_id)
 *      on hr_payroll_records means processPeriod() can be re-run any
 *      number of times. ON CONFLICT DO NOTHING + RETURNING id lets
 *      the worker land exactly the rows that are missing on each run
 *      so partial-failure recovery is safe.
 *   2. POST-COMMIT KAFKA EMIT — markPaid() builds the per-record
 *      payload inside the locking tx, then chains the emit AFTER the
 *      tx resolves. The contract matches the GLConsumer expectation:
 *      { payrollRecordId, schoolId, employeeId, payPeriodId, payDate,
 *        grossPay, totalDeductions, netPay, deductions[], paidAt }.
 *      One emit per record.
 *   3. EMPLOYEE SELF-SERVICE ROW SCOPE — payroll record reads use
 *      hr-003:read at the controller (held by every employee) but
 *      the service narrows to actor.employeeId for non-admins. The
 *      `/hr/payroll/me/payslips` alias forces self-binding even for
 *      admin actors, mirroring the P2C3 per-actor-type narrowing.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  controllers: [PayrollController],
  providers: [PayGradeService, PayrollService, SalaryReviewService],
  exports: [PayGradeService, PayrollService, SalaryReviewService],
})
export class PayrollModule {}
