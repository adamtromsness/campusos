import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
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
import { FireDrillService } from './fire-drill.service';
import { AssetService } from './asset.service';
import { EnergyService } from './energy.service';
import { SpaceUtilisationService } from './space-utilisation.service';
import { SustainabilityService } from './sustainability.service';
import { FacilitiesController } from './facilities.controller';
import { FacilitiesAdvancedController } from './facilities-advanced.controller';
import { FacilitiesAssetsController } from './facilities-assets.controller';

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
 * P2-18b additions (this cycle):
 *   - 5 new services (FireDrillService + AssetService + EnergyService +
 *     SpaceUtilisationService + SustainabilityService),
 *   - 1 new controller (FacilitiesAssetsController, ~22 endpoints),
 *   - 1 new Kafka emit topic (fac.fire_drill.overdue, fired per
 *     overdue building by the compliance endpoint with a deterministic
 *     event_id keyed on (buildingId, computedAtIsoDate)).
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
 *
 * Three keystones in P2-18b:
 *   1. Asset disposal SAFETY KEYSTONE — AssetService.dispose locks the
 *      parent fac_assets row FOR UPDATE inside the tenant tx, validates
 *      status='DECOMMISSIONED', then INSERTs fac_asset_disposals. The
 *      schema cannot encode the cross-row invariant directly so the
 *      service layer is the authoritative gate.
 *   2. Energy reading consumption auto-compute — EnergyService.record
 *      reads the most-recent earlier reading on the same meter under a
 *      meter-row FOR UPDATE lock and stores the difference as
 *      consumption inside the same tx as the INSERT. NULL on the
 *      first reading per meter (no prior).
 *   3. Fire drill 90-day compliance — FireDrillService.compliance
 *      LEFT JOINs every fac_buildings row against the most-recent
 *      drill, flags rows with no drill in the trailing 90 days, and
 *      emits fac.fire_drill.overdue per overdue building with a
 *      deterministic event_id keyed on (buildingId, today_iso).
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
    FireDrillService,
    AssetService,
    EnergyService,
    SpaceUtilisationService,
    SustainabilityService,
  ],
  controllers: [FacilitiesController, FacilitiesAdvancedController, FacilitiesAssetsController],
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
    FireDrillService,
    AssetService,
    EnergyService,
    SpaceUtilisationService,
    SustainabilityService,
  ],
})
export class FacilitiesModule {}
