import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TaskWorker } from './task.worker';
import { TaskService } from './task.service';
import { AcknowledgementService } from './acknowledgement.service';
import { TaskController } from './task.controller';
import { AcknowledgementController } from './acknowledgement.controller';
import { TicketTaskCompletionConsumer } from './ticket-task-completion.consumer';

/**
 * Tasks Module — M1 Task Management (Cycle 7).
 *
 * Step 4 ships the TaskWorker — sole writer to tsk_tasks per ADR-011.
 * It subscribes at boot to the union of trigger_event_type values from
 * every active tenant's tsk_auto_task_rules, and translates inbound
 * domain events into auto-tasks.
 *
 * Steps 5+ will add the request-path API (TaskService,
 * AcknowledgementService, controllers) for manual tasks and the
 * acknowledgement workflow.
 *
 * Imports:
 *   - TenantModule         — TenantPrismaService for tenant-scoped reads
 *   - IamModule            — ActorContextService for the future request path
 *   - KafkaModule          — KafkaConsumerService + KafkaProducerService
 *                            + IdempotencyService
 *   - NotificationsModule  — RedisService for per-(owner, source_ref_id)
 *                            SET NX dedup
 *
 * Authorisation contract (Step 5+):
 *   - ops-001:read   — read own tasks; admins read all in the tenant
 *   - ops-001:write  — create manual tasks, transition status, complete
 *                       acknowledgements
 *   - ops-001:admin  — bulk task admin operations (Step 5+)
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [TaskWorker, TaskService, AcknowledgementService, TicketTaskCompletionConsumer],
  controllers: [TaskController, AcknowledgementController],
  exports: [TaskService, AcknowledgementService],
})
export class TasksModule {}
