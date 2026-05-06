import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { RequisitionService } from './requisitions.service';
import { GoodsReceiptService, PurchaseOrderService } from './purchase-orders.service';
import {
  DistributionService,
  ProcurementSettingsService,
  ReturnService,
  VendorPerformanceService,
} from './distribution.service';
import { ProcurementController } from './procurement.controller';

/**
 * Procurement Module — M86 Procurement (Cycle 27).
 *
 * Wave 6 (Finance & Commerce) continuation cycle. 6 services + 1
 * controller + ~28 endpoints under prc-001 / prc-002 / prc-003.
 *
 * Three structural keystones:
 *   1. BUDGET COMMITMENT KEYSTONE — PO ISSUE creates
 *      prc_budget_commitments + bumps fin_budget_lines.encumbered_amount
 *      in one tenant tx. CLOSE / CANCEL release the commitment +
 *      decrement encumbered_amount.
 *   2. CROSS-MODULE DISTRIBUTION KEYSTONE — DistributionService.create
 *      emits prc.distribution.completed AFTER tx commits with
 *      destination_module set so downstream modules (tech / trn / fds /
 *      lib / ath / ext / fac / str) can react.
 *   3. VENDOR PERFORMANCE AUTO-SCORING — GoodsReceiptService.create
 *      atomically updates prc_vendor_performance per receipt with
 *      on-time + quality scores, inside the same tenant tx as the
 *      receipt insert + PO status flip.
 *
 * Cross-cycle integration:
 *   - Cycle 7 wsk_approval_requests (multi-level requisition approval
 *     scaffolded in service layer; dedicated approval-flow consumer
 *     deferred to Phase 2 polish — current implementation uses
 *     direct counsellor/admin transitions)
 *   - Cycle 26 fin_budget_lines (BUDGET COMMITMENT KEYSTONE encumbers
 *     the line + decrements remaining_balance)
 *   - Cycle 26 fin_suppliers (vendor lookup + scoring)
 *   - Cycle 26 fin_chart_of_accounts (GL account assignment per PO line)
 *
 * Permission codes (already in catalogue from Wave 1):
 *   - PRC-001 Requisitions
 *   - PRC-002 Purchase Orders + Receiving
 *   - PRC-003 Distribution + Returns + Vendor Performance
 *
 * Procurement Officer / Purchasing Clerk = eleventh specialist
 * operator persona after nurse, counsellor, librarian, athletic
 * director, enrolment officer, transportation coordinator, food
 * service manager, facilities manager, IT administrator, and
 * finance manager.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    RequisitionService,
    PurchaseOrderService,
    GoodsReceiptService,
    DistributionService,
    ReturnService,
    VendorPerformanceService,
    ProcurementSettingsService,
  ],
  controllers: [ProcurementController],
  exports: [],
})
export class ProcurementModule {}
