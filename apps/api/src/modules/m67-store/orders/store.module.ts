import { Module } from '@nestjs/common';
import { TenantModule } from '@modules/m00-platform';
import { IamModule } from '@modules/m00-platform';
import { KafkaModule } from '@shared/kafka';
import { InventoryService, ProductService, StoreService } from '../products/products.service';
import { ApprovalService, OrderService } from './orders.service';
import {
  ExternalCustomerService,
  RevenueService,
  ShippingService,
} from '../products/revenue.service';
import { StoreController } from './store.controller';

/**
 * Store Module — M67 School Store (Cycle 28).
 *
 * Wave 6 (Finance & Commerce) closeout cycle. 6 services + 1
 * controller + ~26 endpoints under str-001 / str-002 / str-003 + 2
 * Kafka emit topics (str.order.completed, str.inventory.reorder_needed)
 * + 1 unauthenticated public endpoint at /shop/external-customers.
 *
 * Five structural keystones:
 *   1. PARENT APPROVAL GATE — STUDENT orders auto-create a PENDING
 *      str_order_approvals row inside the same tx as the order INSERT
 *      and reserve inventory; payment is NOT charged until the parent
 *      approves. Locked-row state machine + multi-column responded_chk
 *      lockstep.
 *   2. DUAL-MODE STORE — UNIQUE(school_id, store_type) caps each
 *      school at one STUDENT + one PUBLIC store; per-row 3-value
 *      order_type CHECK enforces the customer-shape contract.
 *   3. CROSS-MODULE TO Cycle 6 PAYMENTS — str.order.completed envelope
 *      carries customerPersonId / externalCustomerId + total + lineItems
 *      so M84 family billing can charge the family account on STUDENT
 *      / PARENT orders.
 *   4. CROSS-MODULE TO Cycle 27 PROCUREMENT — str.inventory.reorder_needed
 *      envelope fires when stock crosses to <= reorder_point so the
 *      future Cycle 27 procurement consumer can auto-create a
 *      requisition pre-filled with the line.
 *   5. REVENUE MATERIALISATION (ADR-018) — StoreRevenueWorker walks
 *      COMPLETED orders for the period, sums revenue + cost, computes
 *      gross margin, UPSERTs into str_store_revenue keyed on (store,
 *      period_start, period_end) for idempotent re-runs.
 *
 * Cross-cycle integration (no direct writes):
 *   - Cycle 6 pay_family_accounts(id) — resolved by M84 from
 *     customerPersonId at billing time.
 *   - Cycle 27 prc_requisitions(id) — created by future procurement
 *     consumer from the reorder_needed payload.
 *
 * Permission codes (already in catalogue):
 *   - STR-001 Store Management (products + inventory)
 *   - STR-002 Store Orders (orders + approvals)
 *   - STR-003 External Customers, Shipping & Revenue
 *
 * Store manager is the **twelfth specialist operator persona** after
 * the nurse, counsellor, librarian, athletic director, enrolment
 * officer, transportation coordinator, food service manager,
 * facilities manager, IT administrator, CFO/Business Manager, and
 * procurement officer.
 *
 * The parent approval gate is the **fifth parent-active feature**
 * after parent messaging (Cycle 3), conference booking (Cycle 15),
 * application submission (Cycle 16), and route-change requests
 * (Cycle 19).
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule],
  providers: [
    StoreService,
    ProductService,
    InventoryService,
    OrderService,
    ApprovalService,
    ExternalCustomerService,
    ShippingService,
    RevenueService,
  ],
  controllers: [StoreController],
  exports: [],
})
export class StoreModule {}
