import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform/tenant/tenant.module';
import { IamModule } from '@modules/m00-platform/iam/iam.module';
import { KafkaModule } from '@shared/kafka/kafka.module';
import { DepartmentalBudgetService } from './departmental-budget.service';
import { BudgetTransferService } from './budget-transfer.service';
import { JournalBatchService } from './journal-batch.service';
import { FinanceAdvancedController } from './finance-advanced.controller';

/**
 * Finance Advanced — departmental budgets, atomic budget transfers,
 * manual journal entry batches. Split out of the P2-29 commerce bundle
 * so fin_* tables live alongside the rest of M83.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [DepartmentalBudgetService, BudgetTransferService, JournalBatchService],
  controllers: [FinanceAdvancedController],
  exports: [DepartmentalBudgetService, BudgetTransferService, JournalBatchService],
})
export class FinanceAdvancedModule {}
