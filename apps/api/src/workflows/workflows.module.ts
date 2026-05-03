import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowController } from './workflow.controller';

/**
 * Workflows Module — M2 Approval Workflows (Cycle 7 Step 6).
 *
 * WorkflowEngineService is the sole writer to wsk_approval_requests
 * and wsk_approval_steps per ADR-012. Source modules (LeaveService,
 * ChildLinkRequestService, …) consume the engine by:
 *
 *   1. calling WorkflowEngineService.submit() programmatically when
 *      the domain row is created (e.g. LeaveService.submit() now also
 *      creates an approval request — Step 7), or by hitting the public
 *      POST /approvals endpoint, and
 *   2. listening to the approval.request.resolved Kafka event with
 *      requestType filter so the source can apply the approved action.
 *
 * The engine emits two topics:
 *   - approval.step.awaiting    fires on every fresh AWAITING step.
 *                                Future cycles wire a notification
 *                                consumer or a TaskWorker auto-task
 *                                rule onto this so approvers see the
 *                                step in their Tasks app.
 *   - approval.request.resolved fires once per terminal transition
 *                                (APPROVED or REJECTED). WITHDRAWN
 *                                deliberately does not emit — the
 *                                requester pulled back, source modules
 *                                shouldn't act on it.
 *
 * Permission contract:
 *   - ops-001:read   list / get + own scope
 *   - ops-001:write  submit / approve / reject / comment / withdraw
 *
 * Row scope (non-admin):
 *   - list / get: requester OR any current / past approver
 *   - approve / reject: assigned approver on the awaiting step
 *   - withdraw: requester only
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [WorkflowEngineService],
  controllers: [WorkflowController],
  exports: [WorkflowEngineService],
})
export class WorkflowsModule {}
