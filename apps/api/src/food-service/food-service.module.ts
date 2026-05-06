import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { DailyMenuService, MenuCycleService, MenuItemService } from './menu.service';
import {
  PosService,
  ReconciliationService,
  SessionService,
  TransactionService,
} from './pos.service';
import {
  AllergenAlertService,
  DietaryProfileService,
  DietaryUpdateRequestService,
  EligibilityService,
  ProductionRecordService,
  TemperatureLogService,
} from './dietary-eligibility.service';
import { FoodServiceController } from './food-service.controller';

/**
 * Food Service Module — M63 Food Service (Cycle 20).
 *
 * 13 services + 1 controller + ~38 endpoints + 1 Kafka emit topic
 * (fds.transaction.completed).
 *
 * Three structural keystones:
 *   1. POS allergen cross-check (life-safety). TransactionService.create
 *      resolves the patron's active alerts, intersects each item's
 *      allergen_codes against alerts by severity, and BLOCKS with 422
 *      on any CRITICAL match unless supervisorOverrideId is supplied.
 *      The override path persists allergen_override_required=true on
 *      the row for audit.
 *   2. GIN-indexed allergen catalogue. fds_menu_items.allergen_codes
 *      is GIN-indexed for the && (array overlap) operator that backs
 *      the cross-check query and the /menu-items/allergen-check
 *      surface.
 *   3. Health-to-Food read model (ADR-030). fds_student_allergen_alerts
 *      mirrors hlth_health_alerts via a future Kafka consumer; this
 *      cycle ships the schema + seed + a manual sync admin endpoint.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    MenuCycleService,
    MenuItemService,
    DailyMenuService,
    PosService,
    SessionService,
    TransactionService,
    ReconciliationService,
    DietaryProfileService,
    DietaryUpdateRequestService,
    AllergenAlertService,
    EligibilityService,
    TemperatureLogService,
    ProductionRecordService,
  ],
  controllers: [FoodServiceController],
  exports: [
    MenuCycleService,
    MenuItemService,
    DailyMenuService,
    PosService,
    SessionService,
    TransactionService,
    ReconciliationService,
    DietaryProfileService,
    AllergenAlertService,
    EligibilityService,
    TemperatureLogService,
    ProductionRecordService,
  ],
})
export class FoodServiceModule {}
