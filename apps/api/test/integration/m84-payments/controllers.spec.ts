import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

// Controllers under test
import { InvoiceController } from '@modules/m84-payments/invoice.controller';
import { PaymentController } from '@modules/m84-payments/payment.controller';
import { FamilyAccountController } from '@modules/m84-payments/family-account.controller';
import { LunchAccountController } from '@modules/m84-payments/lunch-account.controller';
import { RefundController } from '@modules/m84-payments/refund.controller';
import { PaymentPlanController } from '@modules/m84-payments/payment-plan.controller';
import { FeeScheduleController } from '@modules/m84-payments/fee-schedule.controller';
import { BillingConfigController } from '@modules/m84-payments/billing-config.controller';
import { FinancialAidController } from '@modules/m84-payments/financial-aid.controller';
import { BillingOpsController } from '@modules/m84-payments/billing-ops.controller';

// Services
import { InvoiceService } from '@modules/m84-payments/invoice.service';
import { PaymentService } from '@modules/m84-payments/payment.service';
import { FamilyAccountService } from '@modules/m84-payments/family-account.service';
import { LedgerService } from '@modules/m84-payments/ledger.service';
import { LunchAccountService } from '@modules/m84-payments/lunch-account.service';
import { RefundService } from '@modules/m84-payments/refund.service';
import { PaymentPlanService } from '@modules/m84-payments/payment-plan.service';
import { FeeScheduleService } from '@modules/m84-payments/fee-schedule.service';
import { DiscountRuleService } from '@modules/m84-payments/discount-rule.service';
import { AutoInvoiceService } from '@modules/m84-payments/auto-invoice.service';
import { FinancialAidService } from '@modules/m84-payments/financial-aid.service';
import { CreditNoteService } from '@modules/m84-payments/credit-note.service';
import { ReversalService } from '@modules/m84-payments/reversal.service';
import { PaymentAllocationService } from '@modules/m84-payments/payment-allocation.service';
import { LateFeeService } from '@modules/m84-payments/late-fee.service';
import { SavedPaymentMethodService } from '@modules/m84-payments/saved-payment-method.service';
import { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { RedisService } from '@shared/cache';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { resetFinanceAdvancedTables } from '../helpers/reset';
import { TEST_ACADEMIC_YEAR_ID } from '../fixtures/finance';

function stubRedis(): RedisService {
  return {
    invalidateLedgerBalance: async () => undefined,
    getLedgerBalance: async () => null,
    setLedgerBalance: async () => undefined,
  } as unknown as RedisService;
}

/**
 * Controller-layer integration coverage for m84-payments. Every controller
 * is instantiated with real services. Tests drive each route handler
 * with synthetic AuthedRequest and verify delegation succeeds.
 */
describe('integration:m84-payments/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let invoiceCtrl: InvoiceController;
  let paymentCtrl: PaymentController;
  let familyAcctCtrl: FamilyAccountController;
  let lunchCtrl: LunchAccountController;
  let refundCtrl: RefundController;
  let planCtrl: PaymentPlanController;
  let feeCtrl: FeeScheduleController;
  let billingCfgCtrl: BillingConfigController;
  let aidCtrl: FinancialAidController;
  let billingOpsCtrl: BillingOpsController;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();

    const permCheck = new PermissionCheckService(rawClient);
    const actors = new ActorContextService(rawClient, permCheck, tenantPrisma);
    const outbox = new OutboxService();
    const ledger = new LedgerService(tenantPrisma, stubRedis());
    const invoices = new InvoiceService(tenantPrisma, outbox, ledger);
    const payments = new PaymentService(tenantPrisma, outbox, ledger);
    const familyAccounts = new FamilyAccountService(tenantPrisma, ledger);
    const lunch = new LunchAccountService(tenantPrisma, outbox);
    const refunds = new RefundService(tenantPrisma, outbox, ledger);
    const plans = new PaymentPlanService(tenantPrisma);
    const fees = new FeeScheduleService(tenantPrisma);
    const discounts = new DiscountRuleService(tenantPrisma);
    const autoInvoice = new AutoInvoiceService(tenantPrisma);
    const aid = new FinancialAidService(tenantPrisma);
    const creditNotes = new CreditNoteService(tenantPrisma, outbox, ledger);
    const reversals = new ReversalService(tenantPrisma, outbox, ledger);
    const allocations = new PaymentAllocationService(tenantPrisma);
    const lateFees = new LateFeeService(tenantPrisma);
    const savedPm = new SavedPaymentMethodService(tenantPrisma);

    invoiceCtrl = new InvoiceController(invoices, actors);
    paymentCtrl = new PaymentController(payments, actors);
    familyAcctCtrl = new FamilyAccountController(familyAccounts, ledger, actors);
    lunchCtrl = new LunchAccountController(lunch, actors);
    refundCtrl = new RefundController(refunds, actors);
    planCtrl = new PaymentPlanController(plans, actors);
    feeCtrl = new FeeScheduleController(fees, actors);
    billingCfgCtrl = new BillingConfigController(discounts, autoInvoice, actors);
    aidCtrl = new FinancialAidController(aid, actors);
    billingOpsCtrl = new BillingOpsController(
      creditNotes,
      reversals,
      allocations,
      lateFees,
      savedPm,
      actors,
    );

    // Grant admin sch-001:admin so resolveActor returns isSchoolAdmin=true.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache
         (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], now(), 'm84-ctrl-test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
      generateId(),
      TEST_ADMIN_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
      [
        'sch-001:admin',
        'fin-001:read',
        'fin-001:write',
        'fin-001:admin',
        'fin-002:read',
        'fin-002:write',
        'fin-002:admin',
      ],
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE assignment_version_hash = 'm84-ctrl-test'`,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => resetFinanceAdvancedTables(tenantPrisma));
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  function req(): any {
    return {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess-1',
      },
    };
  }

  let acctCounter = 100;
  async function seedFamilyAccount(): Promise<string> {
    const id = generateId();
    acctCounter += 1;
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pay_family_accounts
         (id, school_id, account_holder_id, account_number, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE')`,
      id,
      TEST_SCHOOL_ID,
      TEST_PARENT_PERSON_ID,
      'CTRL-FA-' + acctCounter,
    );
    return id;
  }

  // ─── Invoice ─────────────────────────────────────────────────
  describe('InvoiceController', () => {
    it('list + getById + create + send + cancel', async () => {
      const fa = await seedFamilyAccount();
      const created = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'CTRL-INV',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 100 }],
          } as any,
          req(),
        ),
      );
      expect(created.status).toBe('DRAFT');

      const list = await withTestTenant(() => invoiceCtrl.list({} as any, req()));
      expect(list.find((i: any) => i.id === created.id)).toBeDefined();

      const got = await withTestTenant(() => invoiceCtrl.getById(created.id, req()));
      expect(got.id).toBe(created.id);

      const sent = await withTestTenant(() => invoiceCtrl.send(created.id, req()));
      expect(sent.status).toBe('SENT');

      const cancelled = await withTestTenant(() => invoiceCtrl.cancel(created.id, req()));
      expect(['CANCELLED', 'WRITTEN_OFF', 'CANCELED']).toContain(cancelled.status);
    });

    it('generateFromSchedule smoke-tests the bulk path', async () => {
      // No fee schedule wired here — just exercise the route handler
      // and accept the service-layer NotFound or similar throw.
      const fakeId = generateId();
      await expect(
        withTestTenant(() =>
          invoiceCtrl.generateFromSchedule({ feeScheduleId: fakeId } as any, req()),
        ),
      ).rejects.toBeDefined();
    });
  });

  // ─── Payment ─────────────────────────────────────────────────
  describe('PaymentController', () => {
    it('list smoke', async () => {
      const list = await withTestTenant(() => paymentCtrl.list({} as any, req()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('getById missing → throws', async () => {
      await expect(
        withTestTenant(() => paymentCtrl.getById(generateId(), req())),
      ).rejects.toBeDefined();
    });

    it('pay an invoice', async () => {
      const fa = await seedFamilyAccount();
      const inv = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'pay-test',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 50 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(inv.id, req()));
      const payment = await withTestTenant(() =>
        paymentCtrl.pay(inv.id, { amount: 50, paymentMethod: 'CASH' } as any, req()),
      );
      expect(payment.id).toBeTruthy();
    });
  });

  // ─── Family Account ──────────────────────────────────────────
  describe('FamilyAccountController', () => {
    it('list + getById + listStudents + getBalance + listLedger', async () => {
      const fa = await seedFamilyAccount();
      const list = await withTestTenant(() => familyAcctCtrl.list(req()));
      expect(list.find((a: any) => a.id === fa)).toBeDefined();

      const got = await withTestTenant(() => familyAcctCtrl.getById(fa, req()));
      expect(got.id).toBe(fa);

      const students = await withTestTenant(() => familyAcctCtrl.listStudents(fa, req()));
      expect(Array.isArray(students)).toBe(true);

      const balance = await withTestTenant(() => familyAcctCtrl.getBalance(fa, req()));
      expect(balance).toBeDefined();

      const ledger = await withTestTenant(() => familyAcctCtrl.listLedger(fa, {} as any, req()));
      expect(Array.isArray(ledger)).toBe(true);
    });
  });

  // ─── Lunch Account ───────────────────────────────────────────
  describe('LunchAccountController', () => {
    it('listLowBalance smoke', async () => {
      const list = await withTestTenant(() => lunchCtrl.listLowBalance(req()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('getForStudent missing → throws', async () => {
      await expect(
        withTestTenant(() => lunchCtrl.getForStudent(generateId(), '10', req())),
      ).rejects.toBeDefined();
    });

    it('deposit + transfer + updateSettings on missing → throws', async () => {
      await expect(
        withTestTenant(() => lunchCtrl.deposit(generateId(), { amount: 10 } as any, req())),
      ).rejects.toBeDefined();
      await expect(
        withTestTenant(() =>
          lunchCtrl.transfer(
            {
              fromAccountId: generateId(),
              toAccountId: generateId(),
              amount: 1,
              reason: 'SIBLING_TRANSFER',
            } as any,
            req(),
          ),
        ),
      ).rejects.toBeDefined();
      await expect(
        withTestTenant(() =>
          lunchCtrl.updateSettings(generateId(), { lowBalanceThreshold: 5 } as any, req()),
        ),
      ).rejects.toBeDefined();
    });
  });

  // ─── Refund ──────────────────────────────────────────────────
  describe('RefundController', () => {
    it('list smoke', async () => {
      const list = await withTestTenant(() => refundCtrl.list({} as any, req()));
      expect(Array.isArray(list)).toBe(true);
    });

    it('issue on a paid invoice', async () => {
      const fa = await seedFamilyAccount();
      const inv = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'refund-test',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 50 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(inv.id, req()));
      const payment = await withTestTenant(() =>
        paymentCtrl.pay(inv.id, { amount: 50, paymentMethod: 'CASH' } as any, req()),
      );

      const refund = await withTestTenant(() =>
        refundCtrl.issue(
          payment.id,
          { amount: 50, refundCategory: 'OVERPAYMENT', reason: 'dup' } as any,
          req(),
        ),
      );
      expect(refund.amount).toBe(50);
    });
  });

  // ─── Payment Plan ────────────────────────────────────────────
  describe('PaymentPlanController', () => {
    it('create + getById', async () => {
      const fa = await seedFamilyAccount();
      const inv = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'plan-test',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 1200 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(inv.id, req()));

      const plan = await withTestTenant(() =>
        planCtrl.create(
          inv.id,
          { installmentCount: 4, frequency: 'MONTHLY', startDate: '2027-01-01' } as any,
          req(),
        ),
      );
      expect(plan.installmentCount).toBe(4);

      const got = await withTestTenant(() => planCtrl.getById(plan.id));
      expect(got.id).toBe(plan.id);
    });
  });

  // ─── Fee Schedule ────────────────────────────────────────────
  describe('FeeScheduleController', () => {
    it('listCategories + createCategory + createSchedule + listSchedules + getScheduleById + updateSchedule', async () => {
      const cat = await withTestTenant(() =>
        feeCtrl.createCategory(
          { name: 'CTRL-FC-' + generateId().slice(-6), description: 'd' } as any,
          req(),
        ),
      );
      const cats = await withTestTenant(() => feeCtrl.listCategories());
      expect(cats.find((c: any) => c.id === cat.id)).toBeDefined();

      const sched = await withTestTenant(() =>
        feeCtrl.createSchedule(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            feeCategoryId: cat.id,
            name: 'CTRL-Sched-' + generateId().slice(-6),
            amount: 100,
          } as any,
          req(),
        ),
      );
      const schedList = await withTestTenant(() => feeCtrl.listSchedules());
      expect(schedList.find((s: any) => s.id === sched.id)).toBeDefined();

      const gotSched = await withTestTenant(() => feeCtrl.getScheduleById(sched.id));
      expect(gotSched.id).toBe(sched.id);

      const updated = await withTestTenant(() =>
        feeCtrl.updateSchedule(sched.id, { amount: 150 } as any, req()),
      );
      expect(updated.amount).toBe(150);
    });
  });

  // ─── Billing Config ──────────────────────────────────────────
  describe('BillingConfigController', () => {
    it('listDiscountRules + createDiscountRule + getDiscountRule + updateDiscountRule', async () => {
      const rule = await withTestTenant(() =>
        billingCfgCtrl.createDiscountRule(
          {
            name: 'CTRL-DR-' + generateId().slice(-6),
            discountType: 'EARLY_PAYMENT',
            calculationMethod: 'PERCENTAGE',
            value: 10,
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => billingCfgCtrl.listDiscountRules({} as any, req()));
      expect(list.find((r: any) => r.id === rule.id)).toBeDefined();

      const got = await withTestTenant(() => billingCfgCtrl.getDiscountRule(rule.id, req()));
      expect(got.id).toBe(rule.id);

      const patched = await withTestTenant(() =>
        billingCfgCtrl.updateDiscountRule(rule.id, { value: 15 } as any, req()),
      );
      expect(patched.value).toBe(15);
    });

    it('listAutoRules + listGenerationRuns smoke', async () => {
      const auto = await withTestTenant(() => billingCfgCtrl.listAutoRules('true', req()));
      expect(Array.isArray(auto)).toBe(true);
      const runs = await withTestTenant(() => billingCfgCtrl.listGenerationRuns({} as any, req()));
      expect(Array.isArray(runs)).toBe(true);
    });

    it('getAutoRule + getGenerationRun missing → throws (exercises lookup branch)', async () => {
      await expect(
        withTestTenant(() => billingCfgCtrl.getAutoRule(generateId(), req())),
      ).rejects.toBeDefined();
      await expect(
        withTestTenant(() => billingCfgCtrl.getGenerationRun(generateId(), req())),
      ).rejects.toBeDefined();
    });

    it('createAutoRule + updateAutoRule + triggerAutoRule + generateFromFeeSchedule', async () => {
      // Need a fee schedule for the auto-invoice rule
      const cat = await withTestTenant(() =>
        feeCtrl.createCategory({ name: 'AC-' + generateId().slice(-6) } as any, req()),
      );
      const sched = await withTestTenant(() =>
        feeCtrl.createSchedule(
          {
            academicYearId: TEST_ACADEMIC_YEAR_ID,
            feeCategoryId: cat.id,
            name: 'AC-Sched',
            amount: 100,
          } as any,
          req(),
        ),
      );

      const rule = await withTestTenant(() =>
        billingCfgCtrl.createAutoRule(
          {
            name: 'CTRL-Auto-' + generateId().slice(-6),
            feeScheduleId: sched.id,
            triggerType: 'ENROLMENT_CONFIRMED',
          } as any,
          req(),
        ),
      );
      const got = await withTestTenant(() => billingCfgCtrl.getAutoRule(rule.id, req()));
      expect(got.id).toBe(rule.id);

      const patched = await withTestTenant(() =>
        billingCfgCtrl.updateAutoRule(rule.id, { name: 'Renamed' } as any, req()),
      );
      expect(patched.name).toBe('Renamed');

      const triggered = await withTestTenant(() =>
        billingCfgCtrl.triggerAutoRule(rule.id, {} as any, req()),
      );
      expect(triggered.id).toBeTruthy();

      const fromSched = await withTestTenant(() =>
        billingCfgCtrl.generateFromFeeSchedule(sched.id, {} as any, req()),
      );
      expect(fromSched.id).toBeTruthy();
    });
  });

  // ─── Financial Aid ──────────────────────────────────────────
  describe('FinancialAidController', () => {
    it('listPrograms + createProgram + getProgramById + updateProgram', async () => {
      const created = await withTestTenant(() =>
        aidCtrl.createProgram(
          {
            name: 'CTRL-Aid-' + generateId().slice(-6),
            reductionType: 'PERCENTAGE',
            reductionValue: 25,
          } as any,
          req(),
        ),
      );
      const list = await withTestTenant(() => aidCtrl.listPrograms('true'));
      expect(list.find((p: any) => p.id === created.id)).toBeDefined();

      const got = await withTestTenant(() => aidCtrl.getProgramById(created.id));
      expect(got.id).toBe(created.id);

      const patched = await withTestTenant(() =>
        aidCtrl.updateProgram(created.id, { description: 'updated CTRL desc' } as any, req()),
      );
      expect(patched.description).toBe('updated CTRL desc');
    });

    it('listApplications + listAwardsForStudent + missing-id paths smoke', async () => {
      const apps = await withTestTenant(() => aidCtrl.listApplications({} as any, req()));
      expect(Array.isArray(apps)).toBe(true);

      const awards = await withTestTenant(() => aidCtrl.listAwardsForStudent(generateId(), req()));
      expect(Array.isArray(awards)).toBe(true);

      await expect(
        withTestTenant(() => aidCtrl.getApplicationById(generateId(), req())),
      ).rejects.toBeDefined();

      await expect(
        withTestTenant(() =>
          aidCtrl.createApplication(
            { programId: generateId(), studentId: generateId() } as any,
            req(),
          ),
        ),
      ).rejects.toBeDefined();

      await expect(
        withTestTenant(() => aidCtrl.updateApplication(generateId(), {} as any, req())),
      ).rejects.toBeDefined();

      await expect(
        withTestTenant(() => aidCtrl.submitApplication(generateId(), req())),
      ).rejects.toBeDefined();

      await expect(
        withTestTenant(() =>
          aidCtrl.withdrawApplication(generateId(), { reason: 'x' } as any, req()),
        ),
      ).rejects.toBeDefined();

      await expect(
        withTestTenant(() =>
          aidCtrl.reviewApplication(
            generateId(),
            { decision: 'REJECT', reason: 'x' } as any,
            req(),
          ),
        ),
      ).rejects.toBeDefined();
    });
  });

  // ─── Billing Ops ─────────────────────────────────────────────
  describe('BillingOpsController', () => {
    it('listCreditNotes + listReversals smoke', async () => {
      const cn = await withTestTenant(() => billingOpsCtrl.listCreditNotes({} as any, req()));
      expect(Array.isArray(cn)).toBe(true);
      const rev = await withTestTenant(() => billingOpsCtrl.listReversals({} as any, req()));
      expect(Array.isArray(rev)).toBe(true);
    });

    it('getCreditNote / getReversal missing → throws', async () => {
      await expect(
        withTestTenant(() => billingOpsCtrl.getCreditNote(generateId(), req())),
      ).rejects.toBeDefined();
      await expect(
        withTestTenant(() => billingOpsCtrl.getReversal(generateId(), req())),
      ).rejects.toBeDefined();
    });

    it('issueCreditNote against an invoice', async () => {
      const fa = await seedFamilyAccount();
      const inv = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'cn-test',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 100 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(inv.id, req()));

      const cn = await withTestTenant(() =>
        billingOpsCtrl.issueCreditNote(
          inv.id,
          { creditAmount: 30, reason: 'goodwill', creditCategory: 'GOODWILL' } as any,
          req(),
        ),
      );
      expect(cn.creditAmount).toBe(30);
    });

    it('reversePayment after a payment', async () => {
      const fa = await seedFamilyAccount();
      const inv = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'rev-test',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 50 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(inv.id, req()));
      const payment = await withTestTenant(() =>
        paymentCtrl.pay(inv.id, { amount: 50, paymentMethod: 'CASH' } as any, req()),
      );
      const rev = await withTestTenant(() =>
        billingOpsCtrl.reversePayment(
          payment.id,
          { reversalType: 'BOUNCED_CHEQUE', reversalReason: 'returned' } as any,
          req(),
        ),
      );
      expect(rev.id).toBeTruthy();
    });

    it('allocate + listAllocations across two invoices', async () => {
      const fa = await seedFamilyAccount();
      const i1 = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'alloc-1',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 100 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(i1.id, req()));
      const i2 = await withTestTenant(() =>
        invoiceCtrl.create(
          {
            familyAccountId: fa,
            title: 'alloc-2',
            lineItems: [{ description: 'item', quantity: 1, unitPrice: 40 }],
          } as any,
          req(),
        ),
      );
      await withTestTenant(() => invoiceCtrl.send(i2.id, req()));
      const payment = await withTestTenant(() =>
        paymentCtrl.pay(i1.id, { amount: 100, paymentMethod: 'CASH' } as any, req()),
      );

      const allocs = await withTestTenant(() =>
        billingOpsCtrl.allocate(
          payment.id,
          {
            allocations: [
              { invoiceId: i1.id, allocatedAmount: 60 },
              { invoiceId: i2.id, allocatedAmount: 40 },
            ],
          } as any,
          req(),
        ),
      );
      expect(allocs.length).toBe(2);

      const list = await withTestTenant(() => billingOpsCtrl.listAllocations(payment.id, req()));
      expect(list.length).toBe(2);
    });

    it('getLatePaymentPolicy + upsertLatePaymentPolicy + runLateFeesScan', async () => {
      const initial = await withTestTenant(() => billingOpsCtrl.getLatePaymentPolicy(req()));
      // initial is null if no policy yet
      expect(initial === null || typeof initial === 'object').toBe(true);

      const upserted = await withTestTenant(() =>
        billingOpsCtrl.upsertLatePaymentPolicy(
          {
            gracePeriodDays: 5,
            feeType: 'FIXED',
            feeAmount: 25,
            maxFeesPerInvoice: 1,
          } as any,
          req(),
        ),
      );
      expect(upserted.feeAmount).toBe(25);

      const scan = await withTestTenant(() => billingOpsCtrl.runLateFeesScan(req()));
      expect(scan).toBeDefined();
    });

    it('savedPaymentMethods: list + create + remove', async () => {
      const fa = await seedFamilyAccount();
      const list = await withTestTenant(() => billingOpsCtrl.listSavedPaymentMethods(fa, req()));
      expect(Array.isArray(list)).toBe(true);

      const pm = await withTestTenant(() =>
        billingOpsCtrl.createSavedPaymentMethod(
          {
            familyAccountId: fa,
            stripePaymentMethodId: 'pm_test_' + generateId().slice(-8),
            cardBrand: 'visa',
            cardLastFour: '4242',
          } as any,
          req(),
        ),
      );

      const removed = await withTestTenant(() =>
        billingOpsCtrl.removeSavedPaymentMethod(pm.id, req()),
      );
      expect(removed.removed).toBe(true);
    });
  });
});
