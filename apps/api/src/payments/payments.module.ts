import { Module } from '@nestjs/common';
import { TenantModule } from '../tenant/tenant.module';
import { IamModule } from '../iam/iam.module';
import { KafkaModule } from '../kafka/kafka.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { LedgerService } from './ledger.service';
import { FeeScheduleService } from './fee-schedule.service';
import { FamilyAccountService } from './family-account.service';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { PaymentPlanService } from './payment-plan.service';
import { FeeScheduleController } from './fee-schedule.controller';
import { FamilyAccountController } from './family-account.controller';
import { InvoiceController } from './invoice.controller';
import { PaymentController } from './payment.controller';
import { RefundController } from './refund.controller';
import { PaymentPlanController } from './payment-plan.controller';
import { PaymentAccountWorker } from './consumers/payment-account.consumer';

/**
 * Payments Module — M84 Family Billing (Cycle 6 Step 7).
 *
 * Seven services + six controllers + 19 endpoints + one Kafka consumer:
 *
 *   - LedgerService          — internal recordEntry helper called from
 *                              within open tenant transactions; Redis-
 *                              cached balance read at TTL=30s.
 *   - FeeScheduleService     — admin-only fee category + schedule CRUD
 *                              (5 endpoints).
 *   - FamilyAccountService   — list / get / linked students / balance /
 *                              ledger (5 endpoints, row-scoped on
 *                              account_holder_id for parents).
 *   - InvoiceService         — create / list / get / send (locks invoice
 *                              FOR UPDATE, writes CHARGE ledger entry,
 *                              emits pay.invoice.created) / cancel /
 *                              generate-from-schedule bulk (6 endpoints).
 *   - PaymentService         — list / get / pay (locks invoice FOR
 *                              UPDATE, writes PAYMENT ledger entry,
 *                              recomputes invoice status PARTIAL/PAID,
 *                              emits pay.payment.received; Stripe
 *                              stubbed in dev — CARD payments
 *                              auto-COMPLETE) (3 endpoints).
 *   - RefundService          — list (admin only at service layer) /
 *                              issue (locks payment FOR UPDATE, writes
 *                              REFUND ledger entry, emits
 *                              pay.refund.issued) (2 endpoints).
 *   - PaymentPlanService     — create-plan-with-installments (admin
 *                              only) / get plan with installments (2
 *                              endpoints).
 *   - PaymentAccountWorker   — Kafka consumer on enr.student.enrolled
 *                              under group payment-account-worker;
 *                              UPSERT (school, account_holder_id) on
 *                              pay_family_accounts; idempotent link to
 *                              sis_students.
 *
 * Authorisation contract:
 *   - fin-001:read   — read family accounts, balances, ledger entries,
 *                       invoices, payments. Parent: own; admin: all.
 *   - fin-001:write  — pay an invoice (parent or admin acting for
 *                       parent).
 *   - fin-001:admin  — fee schedule + category CRUD; invoice create /
 *                       send / cancel / generate-from-schedule;
 *                       refund issue; payment plan create.
 */
@Module({
  imports: [TenantModule, IamModule, KafkaModule, NotificationsModule],
  providers: [
    LedgerService,
    FeeScheduleService,
    FamilyAccountService,
    InvoiceService,
    PaymentService,
    RefundService,
    PaymentPlanService,
    PaymentAccountWorker,
  ],
  controllers: [
    FeeScheduleController,
    FamilyAccountController,
    InvoiceController,
    PaymentController,
    RefundController,
    PaymentPlanController,
  ],
  exports: [
    LedgerService,
    FeeScheduleService,
    FamilyAccountService,
    InvoiceService,
    PaymentService,
    RefundService,
    PaymentPlanService,
  ],
})
export class PaymentsModule {}
