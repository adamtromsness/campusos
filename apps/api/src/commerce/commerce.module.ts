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

/**
 * Commerce Module — P2-29a (Procurement Advanced + Finance Extensions).
 *
 * 6 services + 1 controller + 2 background workers + ~22 endpoints +
 * 4 Kafka emit topics (all durable via the platform outbox):
 *   - prc.contract.expiring         (ContractExpiryWorker)
 *   - prc.contract.amended          (ContractService.amend)
 *   - fin.budget_transfer.approved  (BudgetTransferService.approve)
 *   - fin.journal_batch.posted      (JournalBatchService.post)
 *
 * Three structural keystones:
 *   1. ATOMIC BUDGET TRANSFER — BudgetTransferService.approve locks
 *      BOTH the transfer row AND the two budgets with FOR UPDATE in
 *      one tenant tx, then decrements from-budget + increments
 *      to-budget atomically. On any step failure the entire tx
 *      rolls back — budgets are NEVER half-applied.
 *   2. BALANCED JOURNAL BATCH POST — JournalBatchService.post locks
 *      the batch, re-aggregates lines fresh, validates
 *      total_debits = total_credits AND entry_count > 0 BEFORE
 *      copying lines into Cycle 26 fin_gl_entries. Unbalanced
 *      batches are rejected with the entire tx rolling back. Mirrors
 *      the ADR-058/ADR-059 Cycle 26 PostingService contract for the
 *      manual edit path.
 *   3. CONTRACT EXPIRY ALERTING — ContractExpiryWorker sweeps every
 *      6 hours, flips ACTIVE→EXPIRING when end_date - reminder_days
 *      is now or past, emits prc.contract.expiring with deterministic
 *      event_id keyed on contractId so the renewal alert fires
 *      exactly once per contract.
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
  ],
})
export class CommerceModule {}
