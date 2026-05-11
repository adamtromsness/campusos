import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { RouteService } from './route.service';
import { StopService } from './stop.service';
import { AssignmentService } from './assignment.service';
import { RouteChangeRequestService } from './route-change-request.service';
import { RouteChangeLogService } from './route-change-log.service';
import { VehicleService } from './vehicle.service';
import { InspectionService } from './inspection.service';
import { DriverCredentialService } from './driver-credential.service';
import { BusPassService } from './bus-pass.service';
import { RidershipService } from './ridership.service';
import { RunLogService } from './run-log.service';
import { NoShowService } from './no-show.service';
import { DelayReportService } from './delay-report.service';
import { TransportController } from './transport.controller';
// P2-11a — Fleet Maintenance + Fuel + Driver Hours
import { RepairService } from './repair.service';
import { PartsService } from './parts.service';
import { ComponentService } from './component.service';
import { FuelLogService } from './fuel-log.service';
import { DriverHoursService } from './driver-hours.service';
import { VehicleLifecycleService } from './vehicle-lifecycle.service';
import { FleetMaintenanceController } from './fleet-maintenance.controller';
// P2-11b — Route Generation Pipeline + Ad-Hoc Trips + Contracted Routes
import { RouteConstraintService } from './route-constraint.service';
import { RouteGenerationService } from './route-generation.service';
import { AdhocTripService } from './adhoc-trip.service';
import { ContractedRouteService } from './contracted-route.service';
import { RouteGenerationController } from './route-generation.controller';
// P2-11c — GPS Telemetry + Fleet Dashboard
import { VehiclePositionService } from './vehicle-position.service';
import { GeofenceService } from './geofence.service';
import { ETAService } from './eta.service';
import { DispatchService } from './dispatch.service';
import { ParentTrackingService } from './parent-tracking.service';
import { FleetStatusService } from './fleet-status.service';
import { GpsFleetController } from './gps-fleet.controller';

/**
 * Transport Module — M61 Transportation (Cycle 19).
 *
 * 13 services + 1 controller + ~38 endpoints + 2 Kafka emit topics
 * (trn.no_show.detected, trn.delay.reported).
 *
 * Three structural keystones:
 *   1. Immutable route change log. RouteChangeLogService is the sole
 *      writer to trn_route_change_log. No UPDATE / no DELETE methods
 *      exposed at the application layer. Every route mutation
 *      (RouteService, StopService, AssignmentService, RouteChangeRequest
 *      approve path) writes a row inside the same tenant tx.
 *   2. No-show detection. NoShowService.runOnce() walks expected
 *      ridership against actual scans and INSERTs trn_no_show_alerts
 *      ON CONFLICT DO NOTHING — UNIQUE(student, route, expected_date,
 *      expected_stop) is the schema-side dedup gate. Emits
 *      trn.no_show.detected for parent notification fan-out.
 *   3. QR scan. RidershipService.scan resolves the bus pass via
 *      qr_code_token UNIQUE, validates the date window, and writes
 *      a trn_ridership_records row in one tenant tx.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, WorkflowsModule],
  providers: [
    RouteChangeLogService,
    RouteService,
    StopService,
    AssignmentService,
    RouteChangeRequestService,
    VehicleService,
    InspectionService,
    DriverCredentialService,
    BusPassService,
    RidershipService,
    RunLogService,
    NoShowService,
    DelayReportService,
    // P2-11a
    RepairService,
    PartsService,
    ComponentService,
    FuelLogService,
    DriverHoursService,
    VehicleLifecycleService,
    // P2-11b
    RouteConstraintService,
    RouteGenerationService,
    AdhocTripService,
    ContractedRouteService,
    // P2-11c
    VehiclePositionService,
    GeofenceService,
    ETAService,
    DispatchService,
    ParentTrackingService,
    FleetStatusService,
  ],
  controllers: [
    TransportController,
    FleetMaintenanceController,
    RouteGenerationController,
    GpsFleetController,
  ],
  exports: [
    RouteService,
    StopService,
    AssignmentService,
    VehicleService,
    InspectionService,
    DriverCredentialService,
    BusPassService,
    RidershipService,
    RunLogService,
    NoShowService,
    DelayReportService,
    // P2-11a
    RepairService,
    PartsService,
    ComponentService,
    FuelLogService,
    DriverHoursService,
    VehicleLifecycleService,
    // P2-11b
    RouteConstraintService,
    RouteGenerationService,
    AdhocTripService,
    ContractedRouteService,
    // P2-11c
    VehiclePositionService,
    GeofenceService,
    ETAService,
    DispatchService,
    ParentTrackingService,
    FleetStatusService,
  ],
})
export class TransportModule {}
