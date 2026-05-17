import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
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
import { AllergyAlertConsumer } from './allergy-alert.consumer';
import { FoodServiceController } from './food-service.controller';
import { RecipeService } from './recipe.service';
import { InventoryService } from './inventory.service';
import { TransferService } from './transfer.service';
import { StaffMealService } from './staff-meal.service';
import { PreorderService } from './preorder.service';
import { FoodServiceAdvancedController } from './food-service-advanced.controller';

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
 *      mirrors hlth_health_alerts via the AllergyAlertConsumer Kafka
 *      listener on hlth.allergy_alert.changed (REVIEW-FINAL MAJ-5.1).
 *      The admin syncFromHealth endpoint remains as the recovery /
 *      backfill backstop. The consumer is dormant until the Health
 *      module ships the source table + emits — no migration required
 *      to land the read-model wiring.
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
    AllergyAlertConsumer,
    RecipeService,
    InventoryService,
    TransferService,
    StaffMealService,
    PreorderService,
  ],
  controllers: [FoodServiceController, FoodServiceAdvancedController],
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
    RecipeService,
    InventoryService,
    TransferService,
    StaffMealService,
    PreorderService,
  ],
})
export class FoodServiceModule {}
