import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { NotificationsModule } from '@modules/m40-communications';
import { ChartOfAccountsService, FundService, PeriodService } from './chart.service';
import { PostingService } from './posting.service';
import {
  APPaymentService,
  APVoucherService,
  BoardReportService,
  BudgetService,
  GrantService,
  ReconciliationService,
  SupplierService,
} from './budgets.service';
import { FinanceValidationService } from './validation';
import { GLConsumer } from './gl.consumer';
import { JournalBatchPostedConsumer } from './journal-batch-posted.consumer';
import { GlReconciliationWorker } from './gl-reconciliation.worker';
import { GlReconciliationAlertConsumer } from './gl-reconciliation-alert.consumer';
import { FinanceController } from './finance.controller';
import { FinanceAdvancedModule } from './finance-advanced.module';

/**
 * Finance Module — M83 Finance & Accounting (Cycle 26).
 *
 * Opens Wave 6 (Finance & Commerce). 11 services + 1 Kafka consumer
 * + 1 controller + ~36 endpoints under fin-005 / fin-006 / fin-007 /
 * fin-008. The first Kafka consumer in CampusOS that writes
 * financial data — GLConsumer subscribes to 5 dev.pay.* topics
 * from Cycle 6 and auto-posts balanced GL batches via PostingService.
 *
 * Three structural keystones:
 *   1. DB-validated double-entry posting (ADR-058 / ADR-059) —
 *      PostingService.post() runs SUM(debit) = SUM(credit)
 *      validation inside the same tenant tx as the status flip.
 *      On imbalance the entire transaction rolls back.
 *   2. Permanent period LOCK — fin_accounting_periods.status flips
 *      FUTURE → OPEN → CLOSED → LOCKED and PeriodService refuses
 *      any transition out of LOCKED, regardless of caller.
 *   3. Idempotent GL Consumer — fin_journal_batches.source_event_id
 *      UNIQUE catches Kafka redelivery; PostingService.createAndPost()
 *      returns the existing batch when source_event_id already maps
 *      to one.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule, FinanceAdvancedModule],
  providers: [
    FinanceValidationService,
    FundService,
    ChartOfAccountsService,
    PeriodService,
    PostingService,
    SupplierService,
    BudgetService,
    APVoucherService,
    APPaymentService,
    ReconciliationService,
    BoardReportService,
    GrantService,
    GLConsumer,
    JournalBatchPostedConsumer,
    GlReconciliationWorker,
    GlReconciliationAlertConsumer,
  ],
  controllers: [FinanceController],
  exports: [
    FundService,
    ChartOfAccountsService,
    PeriodService,
    PostingService,
    BudgetService,
    FinanceValidationService,
    GlReconciliationWorker,
    FinanceAdvancedModule,
  ],
})
export class FinanceModule {}
