import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { BookingService, BuildingService, ClosureService, SpaceService } from './buildings.service';
import {
  MaintenancePlanService,
  MaintenanceTaskService,
  WorkOrderService,
} from './work-orders.service';
import {
  InspectionService,
  SupplyService,
  ViolationService,
  ZoneService,
} from './inspections.service';
import { FacilitiesController } from './facilities.controller';

/**
 * Facilities Module — M65 Facilities Management (Cycle 21).
 *
 * 11 services + 1 controller + ~38 endpoints + 5 Kafka emit topics
 * (fac.work_order.created, fac.maintenance_task.overdue,
 * fac.inspection.failed, fac.inspection_violation.overdue,
 * fac.supply.reorder_needed).
 *
 * Three structural keystones:
 *   1. EXCLUDE gist booking conflict detection. fac_space_bookings
 *      carries an EXCLUDE USING gist (space_id WITH =,
 *      tstzrange(starts_at, ends_at) WITH &&) WHERE status='CONFIRMED'
 *      that prevents overlapping CONFIRMED bookings at the schema
 *      level. BookingService translates SQLSTATE 23P01 into a 409
 *      Conflict.
 *   2. Immutable work order activity timeline. fac_work_order_activity
 *      is append-only via WorkOrderService.recordActivityInTx — every
 *      state transition, reassignment, and comment writes a row in
 *      the same tenant tx as the corresponding mutation. No UPDATE
 *      and no DELETE methods exposed.
 *   3. PM checklist FAIL auto-creates follow-up work order.
 *      MaintenanceTaskService.submitResults inserts a follow-up
 *      fac_work_orders row with priority=MEDIUM whenever a result
 *      lands with passed=false, all inside one tenant tx so the
 *      checklist record stays immutable while the corrective work
 *      flows through the standard work order lifecycle.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    BuildingService,
    SpaceService,
    BookingService,
    ClosureService,
    WorkOrderService,
    MaintenancePlanService,
    MaintenanceTaskService,
    InspectionService,
    ViolationService,
    ZoneService,
    SupplyService,
  ],
  controllers: [FacilitiesController],
  exports: [
    BuildingService,
    SpaceService,
    BookingService,
    ClosureService,
    WorkOrderService,
    MaintenancePlanService,
    MaintenanceTaskService,
    InspectionService,
    ViolationService,
    ZoneService,
    SupplyService,
  ],
})
export class FacilitiesModule {}
