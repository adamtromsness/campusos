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
import { CleaningRouteService } from './cleaning-route.service';
import { ZoneInspectionService } from './zone-inspection.service';
import { SupplyAuditService } from './supply-audit.service';
import { WorkOrderDepthService } from './work-order-depth.service';
import { CleaningIssueTicketConsumer } from './cleaning-issue-ticket.consumer';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesAdvancedController } from './facilities-advanced.controller';

/**
 * Facilities Module — M65 Facilities Management.
 *
 * Cycle 21 surface (11 services + 1 controller + ~38 endpoints + 5
 * Kafka emit topics — fac.work_order.created, fac.maintenance_task.overdue,
 * fac.inspection.failed, fac.inspection_violation.overdue,
 * fac.supply.reorder_needed).
 *
 * P2-18a additions:
 *   - 4 new services (CleaningRouteService + ZoneInspectionService +
 *     SupplyAuditService + WorkOrderDepthService),
 *   - 1 new controller (FacilitiesAdvancedController, ~24 endpoints),
 *   - 1 new Kafka consumer (CleaningIssueTicketConsumer subscribes to
 *     fac.route_stop.issue_noted and materialises a tkt_tickets row),
 *   - 1 new Kafka emit topic (fac.route_stop.issue_noted) plus a
 *     fac.work_order.created emit fan-out from ZoneInspectionService
 *     on FAIL inspections (re-uses the Cycle 21 topic).
 *
 * Three keystones in P2-18a:
 *   1. Cleaning route stop completion with issues_noted → emit
 *      fac.route_stop.issue_noted → CleaningIssueTicketConsumer →
 *      tkt_tickets row materialised in the helpdesk queue.
 *   2. Zone inspection on FAIL → auto-create fac_work_orders row in
 *      the same tenant tx as the inspection insert.
 *   3. Stocktake completion → walk every (expected != actual) item +
 *      create ADJUSTMENT fac_supply_transactions row per discrepancy +
 *      update fac_supply_inventory.current_quantity to actual figure,
 *      all in one tenant tx.
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
    CleaningRouteService,
    ZoneInspectionService,
    SupplyAuditService,
    WorkOrderDepthService,
    CleaningIssueTicketConsumer,
  ],
  controllers: [FacilitiesController, FacilitiesAdvancedController],
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
    CleaningRouteService,
    ZoneInspectionService,
    SupplyAuditService,
    WorkOrderDepthService,
  ],
})
export class FacilitiesModule {}
