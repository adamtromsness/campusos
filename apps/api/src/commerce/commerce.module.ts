import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { CommerceController } from './commerce.controller';
import { VendorCatalogueService } from './vendor-catalogue.service';
import { ContractService } from './contract.service';
import { ContractExpiryWorker } from './contract-expiry.worker';
import { ProcurementAnalyticsWorker, SpendingAnalyticsService } from './spending-analytics.service';
import { DepartmentalBudgetService } from './departmental-budget.service';
import { BudgetTransferService } from './budget-transfer.service';
import { JournalBatchService } from './journal-batch.service';
import { InventoryAdjustmentService } from './inventory-adjustment.service';
import { PromotionService } from './promotion.service';
import { LoyaltyService } from './loyalty.service';
import { GiftCardService } from './gift-card.service';
import { WishlistService } from './wishlist.service';
import { PriceScheduleService } from './price-schedule.service';
import { CategoryHierarchyService } from './category-hierarchy.service';

/**
 * Commerce Module — P2-29 (Procurement + Finance + Store).
 *
 * P2-29a (Procurement Advanced + Finance Extensions):
 *   6 services + 2 background workers + ~22 endpoints +
 *   4 Kafka emit topics (all durable via the platform outbox):
 *     - prc.contract.expiring         (ContractExpiryWorker)
 *     - prc.contract.amended          (ContractService.amend)
 *     - fin.budget_transfer.approved  (BudgetTransferService.approve)
 *     - fin.journal_batch.posted      (JournalBatchService.post)
 *
 * P2-29b (Store Advanced):
 *   7 services + 1 background worker + ~24 endpoints +
 *   3 Kafka emit topics (all durable via the platform outbox):
 *     - str.promotion.code_redeemed   (PromotionService.applyPromoCode)
 *     - str.price.scheduled_applied   (PriceScheduleService worker tick)
 *     - str.gift_card.depleted        (GiftCardService.redeem on depletion)
 *
 * Cumulative P2-29: 19 tenant tables + 1 ALTER, ~46 endpoints,
 * 3 background workers, 7 durable Kafka emits.
 *
 * Six structural keystones:
 *   1. ATOMIC BUDGET TRANSFER — BudgetTransferService.approve locks
 *      BOTH the transfer row AND the two budgets with FOR UPDATE in
 *      one tenant tx, then decrements from-budget + increments
 *      to-budget atomically.
 *   2. BALANCED JOURNAL BATCH POST — JournalBatchService.post locks
 *      the batch, re-aggregates lines fresh, validates
 *      total_debits = total_credits AND entry_count > 0 BEFORE
 *      copying lines into Cycle 26 fin_gl_entries.
 *   3. CONTRACT EXPIRY ALERTING — ContractExpiryWorker sweeps every
 *      6 hours, flips ACTIVE→EXPIRING when end_date - reminder_days
 *      is now or past, emits prc.contract.expiring with deterministic
 *      event_id keyed on contractId.
 *   4. ATOMIC PROMOTION MAX_USES — PromotionService.applyPromoCode
 *      runs a single UPDATE that bundles every validation gate
 *      (is_active, date range, max_uses cap) into the WHERE clause
 *      with current_uses incremented in RETURNING. Zero rows
 *      returned means the cap fired; no use is consumed.
 *   5. ATOMIC GIFT CARD REDEMPTION — GiftCardService.redeem runs a
 *      single UPDATE that bundles balance + expiry + status into
 *      the WHERE clause and decrements current_balance_cents in
 *      RETURNING. Zero rows returned means the gate fired; no
 *      audit row is written. status flips to DEPLETED atomically
 *      when the balance hits zero (CASE expression) and
 *      str.gift_card.depleted is emitted inside the same tx.
 *   6. ATOMIC LOYALTY REDEMPTION — LoyaltyService.redeem locks the
 *      full customer ledger row set with FOR UPDATE, recomputes the
 *      balance under the lock, and refuses if balance < requested
 *      OR requested < min_redemption_points.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    VendorCatalogueService,
    ContractService,
    ContractExpiryWorker,
    SpendingAnalyticsService,
    ProcurementAnalyticsWorker,
    DepartmentalBudgetService,
    BudgetTransferService,
    JournalBatchService,
    InventoryAdjustmentService,
    PromotionService,
    LoyaltyService,
    GiftCardService,
    WishlistService,
    PriceScheduleService,
    CategoryHierarchyService,
  ],
  controllers: [CommerceController],
  exports: [
    VendorCatalogueService,
    ContractService,
    ContractExpiryWorker,
    SpendingAnalyticsService,
    ProcurementAnalyticsWorker,
    DepartmentalBudgetService,
    BudgetTransferService,
    JournalBatchService,
    InventoryAdjustmentService,
    PromotionService,
    LoyaltyService,
    GiftCardService,
    WishlistService,
    PriceScheduleService,
    CategoryHierarchyService,
  ],
})
export class CommerceModule {}
