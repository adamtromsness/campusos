import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { CategoryService } from './category.service';
import { ActionTypeService } from './action-type.service';
import { CategoryController } from './category.controller';
import { IncidentService } from './incident.service';
import { IncidentController } from './incident.controller';
import { ActionService } from './action.service';
import { ActionController } from './action.controller';

/**
 * Discipline Module — Cycle 9 Step 4.
 *
 * Wires the M20 SIS discipline tables (Step 1 schema, Step 3 seed) into a
 * request-path API surface. Three services + 14 endpoints + 3 Kafka emit
 * topics. The Step 6 BehaviourNotificationConsumer (future) subscribes to
 * the emitted topics for IN_APP fan-out.
 *
 * Services:
 *   - CategoryService    — sis_discipline_categories CRUD with active +
 *                          severity-aware ordering. Read on beh-001:read,
 *                          write on beh-001:admin.
 *   - ActionTypeService  — sis_discipline_action_types CRUD.
 *                          requires_parent_notification flag drives the
 *                          ActionService.create fan-out path. Same
 *                          permission tiers as CategoryService.
 *   - IncidentService    — sis_discipline_incidents lifecycle. POST stamps
 *                          reported_by from actor.employeeId; PATCH
 *                          /review, /resolve, /reopen all use
 *                          executeInTenantTransaction with SELECT ... FOR
 *                          UPDATE per the locked-read convention. Resolve
 *                          stamps resolved_by + resolved_at in the same
 *                          UPDATE so the multi-column resolved_chk stays
 *                          satisfied. Emits beh.incident.reported and
 *                          beh.incident.resolved.
 *   - ActionService      — sis_discipline_actions CRUD per incident.
 *                          Admin-only writes. POST resolves portal-enabled
 *                          guardian account ids via sis_student_guardians
 *                          when the action type requires parent
 *                          notification, and emits
 *                          beh.action.parent_notification_required with
 *                          the guardian list inline so the Step 6
 *                          consumer fans out IN_APP notifications without
 *                          a second DB read.
 *
 * Authorisation contract:
 *   - beh-001:read   — list + read incidents + categories + action types.
 *                      Row-scoped at the service layer for non-admins
 *                      (teacher = reported + class students; parent = own
 *                      children with admin_notes stripped; student = no
 *                      rows). admin_notes is admin-only in the response.
 *   - beh-001:write  — submit incidents (POST /discipline/incidents).
 *                      Stamps reported_by from actor.employeeId; refuses
 *                      callers without an hr_employees row.
 *   - beh-001:admin  — review / resolve / reopen incidents; assign /
 *                      update / delete actions; CRUD on categories and
 *                      action types.
 *
 * BEH-002 (Behaviour Intervention Plans) lives in the future Step 5
 * BehaviorPlanModule; it is intentionally NOT exported from this module.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [CategoryService, ActionTypeService, IncidentService, ActionService],
  controllers: [CategoryController, IncidentController, ActionController],
  exports: [CategoryService, ActionTypeService, IncidentService, ActionService],
})
export class DisciplineModule {}
