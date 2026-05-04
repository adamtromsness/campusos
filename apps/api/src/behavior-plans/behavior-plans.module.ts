import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { BehaviorPlanService } from './behavior-plan.service';
import { BehaviorPlanController } from './behavior-plan.controller';
import { GoalService } from './goal.service';
import { GoalController } from './goal.controller';
import { FeedbackService } from './feedback.service';
import { FeedbackController } from './feedback.controller';

/**
 * Behavior Plans Module — Cycle 9 Step 5.
 *
 * Wires the M27 Student Services svc_behavior_plans + svc_behavior_plan_goals
 * + svc_bip_teacher_feedback tables (Step 2 schema, Step 3 seed) into a
 * request-path API surface. Three services + 14 endpoints + 1 Kafka emit
 * topic. The Step 6 BehaviourNotificationConsumer (future) subscribes to
 * beh.bip.feedback_requested for IN_APP fan-out + the Cycle 7 TaskWorker
 * via the seeded auto-task rule routes the request as a TODO task on the
 * teacher's list.
 *
 * Services:
 *   - BehaviorPlanService — sis_students-anchored BIP/BSP/SAFETY_PLAN
 *                           lifecycle. Counsellor scope = isSchoolAdmin
 *                           OR holds beh-002:write (Staff role grant)
 *                           → all plans visible. Regular teacher (STAFF
 *                           with beh-002:read only) → row-scoped to
 *                           plans for students in own classes via
 *                           sis_class_teachers + sis_enrollments.
 *                           Lifecycle PATCH /:id/{activate, expire} use
 *                           executeInTenantTransaction with SELECT ...
 *                           FOR UPDATE per the convention. Activate
 *                           pre-flights the partial UNIQUE on
 *                           (student_id, plan_type) WHERE status='ACTIVE'
 *                           with a friendly 400 carrying the existing
 *                           plan id.
 *   - GoalService         — svc_behavior_plan_goals CRUD per plan.
 *                           Counsellor/admin only writes. PATCH bumps
 *                           last_assessed_at = CURRENT_DATE on every
 *                           progress transition away from NOT_STARTED.
 *   - FeedbackService     — svc_bip_teacher_feedback request + submit
 *                           with row-scope on submit (caller's
 *                           employeeId === row.teacher_id, or
 *                           counsellor/admin override). POST request
 *                           pre-flights the partial UNIQUE on
 *                           (plan_id, teacher_id) WHERE submitted_at IS
 *                           NULL + emits beh.bip.feedback_requested
 *                           with recipientAccountId for the Cycle 7
 *                           TaskWorker fan-out.
 *
 * Authorisation contract:
 *   - beh-002:read   — list + read plans + goals + feedback. Row-scoped
 *                      at the service layer for non-counsellors.
 *                      Teachers also use this gate to PATCH
 *                      /bip-feedback/:id when they are the row.teacher_id
 *                      — same verb-mismatch pattern Cycle 1 attendance
 *                      uses (gate on read, row scope on write).
 *   - beh-002:write  — create/edit BIPs; CRUD goals; request feedback.
 *                      Granted to Staff role (VPs / counsellors).
 *   - beh-002:admin  — reached via the everyFunction grant on School
 *                      Admin / Platform Admin; same write powers as
 *                      counsellor + reserved for future delete or
 *                      cross-tenant operations.
 *
 * 1 Kafka emit: beh.bip.feedback_requested.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [BehaviorPlanService, GoalService, FeedbackService],
  controllers: [BehaviorPlanController, GoalController, FeedbackController],
  exports: [BehaviorPlanService, GoalService, FeedbackService],
})
export class BehaviorPlansModule {}
