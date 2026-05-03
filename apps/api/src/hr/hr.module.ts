import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { EmployeeService } from './employee.service';
import { PositionService } from './position.service';
import { EmployeeDocumentService } from './employee-document.service';
import { LeaveService } from './leave.service';
import { CertificationService } from './certification.service';
import { TrainingComplianceService } from './training-compliance.service';
import { LeaveNotificationConsumer } from './leave-notification.consumer';
import { LeaveApprovalConsumer } from './leave-approval.consumer';
import { EmployeeController } from './employee.controller';
import { PositionController } from './position.controller';
import { LeaveController } from './leave.controller';
import { CertificationsController } from './certifications.controller';
import { ComplianceController } from './compliance.controller';

/**
 * HR Module — M80 Workforce Core (Cycle 4 Steps 6 + 7).
 *
 * Step 6 lands employee directory + position catalogue + document
 * management. Step 7 adds leave management, certifications, training
 * compliance, and the LeaveNotificationConsumer that closes the loop on
 * the four leave Kafka emits + republishes hr.leave.coverage_needed for
 * Cycle 5 Scheduling.
 *
 * Authorisation contract:
 *   - hr-001:read   — staff directory + employee profile reads.
 *   - hr-001:write  — document upload + admin-only employee CRUD.
 *   - hr-001:admin  — position CRUD.
 *   - hr-003:read   — own leave history + balances (everyone with the code).
 *                     Admins also see the school-wide approval queue.
 *   - hr-003:write  — submit / cancel own leave; approve / reject for admins.
 *   - hr-004:read   — own certifications + own compliance breakdown.
 *                     Admin reads the school-wide compliance dashboard.
 *   - hr-004:write  — record certifications (own); admin verifies them.
 *
 * Imports NotificationsModule for NotificationQueueService and KafkaModule
 * for the consumer + producer wiring.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule, WorkflowsModule],
  providers: [
    EmployeeService,
    PositionService,
    EmployeeDocumentService,
    LeaveService,
    CertificationService,
    TrainingComplianceService,
    LeaveNotificationConsumer,
    LeaveApprovalConsumer,
  ],
  controllers: [
    EmployeeController,
    PositionController,
    LeaveController,
    CertificationsController,
    ComplianceController,
  ],
  exports: [
    EmployeeService,
    PositionService,
    EmployeeDocumentService,
    LeaveService,
    CertificationService,
    TrainingComplianceService,
  ],
})
export class HrModule {}
