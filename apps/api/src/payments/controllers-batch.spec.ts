import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PaymentController } from './payment.controller';
import { RefundController } from './refund.controller';
import { FamilyAccountController } from './family-account.controller';
import { FeeScheduleController } from './fee-schedule.controller';
import { InvoiceController } from './invoice.controller';
import { LunchAccountController } from './lunch-account.controller';
import { PaymentPlanController } from './payment-plan.controller';
import { BillingConfigController } from './billing-config.controller';
import { FinancialAidController } from './financial-aid.controller';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import type { ResolvedActor } from '../iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — batched coverage for the 9 remaining
 * payment controllers (payment / refund / family-account /
 * fee-schedule / invoice / lunch-account / payment-plan /
 * billing-config / financial-aid). Each controller is a thin
 * pass-through; tests assert (a) @RequirePermission metadata and
 * (b) handlers forward positional args to the underlying service.
 */

const actor: ResolvedActor = {
  accountId: 'acc-admin',
  personId: 'pers-admin',
  personType: 'STAFF',
  isSchoolAdmin: true,
  employeeId: 'emp-admin',
};

const req = {
  user: {
    sub: 'acc-admin',
    personId: 'pers-admin',
    email: 'a@b',
    displayName: 'A',
    sessionId: 's',
  },
} as never;

function actorsStub() {
  return { resolveActor: vi.fn().mockResolvedValue(actor) };
}

const reflector = new Reflector();

function permFor(target: object, handler: string): string[] | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (target as any)[handler];
  return reflector.get<string[]>(PERMISSIONS_KEY, fn);
}

describe('PaymentController', () => {
  it('list / getById gated on fin-001:read; pay on fin-001:write', () => {
    expect(permFor(PaymentController.prototype, 'list')).toEqual(['fin-001:read']);
    expect(permFor(PaymentController.prototype, 'getById')).toEqual(['fin-001:read']);
    expect(permFor(PaymentController.prototype, 'pay')).toEqual(['fin-001:write']);
  });

  it('list forwards query', async () => {
    const payments = { list: vi.fn().mockResolvedValue([{ id: 'p-1' }]) };
    const c = new PaymentController(payments as never, actorsStub() as never);
    await c.list({ status: 'COMPLETED' } as never, req);
    expect(payments.list).toHaveBeenCalledWith({ status: 'COMPLETED' }, actor);
  });

  it('getById forwards id', async () => {
    const payments = { getById: vi.fn().mockResolvedValue({ id: 'p-1' }) };
    const c = new PaymentController(payments as never, actorsStub() as never);
    await c.getById('p-1', req);
    expect(payments.getById).toHaveBeenCalledWith('p-1', actor);
  });

  it('pay forwards invoiceId + body', async () => {
    const payments = { pay: vi.fn().mockResolvedValue({ id: 'p-new' }) };
    const c = new PaymentController(payments as never, actorsStub() as never);
    await c.pay('inv-1', { amount: 100, paymentMethod: 'CARD' } as never, req);
    expect(payments.pay).toHaveBeenCalledWith(
      'inv-1',
      { amount: 100, paymentMethod: 'CARD' },
      actor,
    );
  });
});

describe('RefundController', () => {
  it('list on fin-001:read; issue on fin-001:admin', () => {
    expect(permFor(RefundController.prototype, 'list')).toEqual(['fin-001:read']);
    expect(permFor(RefundController.prototype, 'issue')).toEqual(['fin-001:admin']);
  });

  it('list forwards query', async () => {
    const refunds = { list: vi.fn().mockResolvedValue([]) };
    const c = new RefundController(refunds as never, actorsStub() as never);
    await c.list({} as never, req);
    expect(refunds.list).toHaveBeenCalledWith({}, actor);
  });

  it('issue forwards paymentId + body', async () => {
    const refunds = { issue: vi.fn().mockResolvedValue({ id: 'r-1' }) };
    const c = new RefundController(refunds as never, actorsStub() as never);
    await c.issue('pay-1', { amount: 50, reason: 'X', refundCategory: 'GOODWILL' } as never, req);
    expect(refunds.issue).toHaveBeenCalledWith(
      'pay-1',
      { amount: 50, reason: 'X', refundCategory: 'GOODWILL' },
      actor,
    );
  });
});

describe('FamilyAccountController', () => {
  it('all 5 endpoints gated on fin-001:read', () => {
    expect(permFor(FamilyAccountController.prototype, 'list')).toEqual(['fin-001:read']);
    expect(permFor(FamilyAccountController.prototype, 'getById')).toEqual(['fin-001:read']);
    expect(permFor(FamilyAccountController.prototype, 'listStudents')).toEqual(['fin-001:read']);
    expect(permFor(FamilyAccountController.prototype, 'getBalance')).toEqual(['fin-001:read']);
    expect(permFor(FamilyAccountController.prototype, 'listLedger')).toEqual(['fin-001:read']);
  });

  it('list / getById / listStudents pass through actor', async () => {
    const accounts = {
      list: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({ id: 'fa-1' }),
      listStudents: vi.fn().mockResolvedValue([]),
    };
    const ledger = {};
    const c = new FamilyAccountController(
      accounts as never,
      ledger as never,
      actorsStub() as never,
    );
    await c.list(req);
    expect(accounts.list).toHaveBeenCalledWith(actor);
    await c.getById('fa-1', req);
    expect(accounts.getById).toHaveBeenCalledWith('fa-1', actor);
    await c.listStudents('fa-1', req);
    expect(accounts.listStudents).toHaveBeenCalledWith('fa-1', actor);
  });

  it('getBalance: row-scope getById first, then ledger.getBalance', async () => {
    const accounts = { getById: vi.fn().mockResolvedValue({ id: 'fa-1' }) };
    const ledger = {
      getBalance: vi.fn().mockResolvedValue({ balance: 0, cached: false, familyAccountId: 'fa-1' }),
    };
    const c = new FamilyAccountController(
      accounts as never,
      ledger as never,
      actorsStub() as never,
    );
    await c.getBalance('fa-1', req);
    expect(accounts.getById).toHaveBeenCalledWith('fa-1', actor);
    expect(ledger.getBalance).toHaveBeenCalledWith('fa-1');
  });

  it('listLedger: row-scope getById first, then ledger.listEntries with query', async () => {
    const accounts = { getById: vi.fn().mockResolvedValue({ id: 'fa-1' }) };
    const ledger = { listEntries: vi.fn().mockResolvedValue([]) };
    const c = new FamilyAccountController(
      accounts as never,
      ledger as never,
      actorsStub() as never,
    );
    await c.listLedger('fa-1', { limit: 10 } as never, req);
    expect(accounts.getById).toHaveBeenCalledWith('fa-1', actor);
    expect(ledger.listEntries).toHaveBeenCalledWith('fa-1', { limit: 10 });
  });
});

describe('FeeScheduleController', () => {
  it('reads on fin-001:read; writes on fin-001:admin', () => {
    expect(permFor(FeeScheduleController.prototype, 'listCategories')).toEqual(['fin-001:read']);
    expect(permFor(FeeScheduleController.prototype, 'listSchedules')).toEqual(['fin-001:read']);
    expect(permFor(FeeScheduleController.prototype, 'getScheduleById')).toEqual(['fin-001:read']);
    expect(permFor(FeeScheduleController.prototype, 'createCategory')).toEqual(['fin-001:admin']);
    expect(permFor(FeeScheduleController.prototype, 'createSchedule')).toEqual(['fin-001:admin']);
    expect(permFor(FeeScheduleController.prototype, 'updateSchedule')).toEqual(['fin-001:admin']);
  });

  it('listCategories does not need actor', async () => {
    const fees = { listCategories: vi.fn().mockResolvedValue([]) };
    const c = new FeeScheduleController(fees as never, actorsStub() as never);
    await c.listCategories();
    expect(fees.listCategories).toHaveBeenCalled();
  });

  it('listSchedules does not need actor', async () => {
    const fees = { listSchedules: vi.fn().mockResolvedValue([]) };
    const c = new FeeScheduleController(fees as never, actorsStub() as never);
    await c.listSchedules();
    expect(fees.listSchedules).toHaveBeenCalled();
  });

  it('getScheduleById forwards id', async () => {
    const fees = { getScheduleById: vi.fn().mockResolvedValue({}) };
    const c = new FeeScheduleController(fees as never, actorsStub() as never);
    await c.getScheduleById('s-1');
    expect(fees.getScheduleById).toHaveBeenCalledWith('s-1');
  });

  it('writes forward body + actor', async () => {
    const fees = {
      createCategory: vi.fn().mockResolvedValue({}),
      createSchedule: vi.fn().mockResolvedValue({}),
      updateSchedule: vi.fn().mockResolvedValue({}),
    };
    const c = new FeeScheduleController(fees as never, actorsStub() as never);
    await c.createCategory({ name: 'Tuition' } as never, req);
    expect(fees.createCategory).toHaveBeenCalledWith({ name: 'Tuition' }, actor);
    await c.createSchedule({ name: 'F1' } as never, req);
    expect(fees.createSchedule).toHaveBeenCalledWith({ name: 'F1' }, actor);
    await c.updateSchedule('s-1', { name: 'X' } as never, req);
    expect(fees.updateSchedule).toHaveBeenCalledWith('s-1', { name: 'X' }, actor);
  });
});

describe('InvoiceController', () => {
  it('reads on fin-001:read; writes on fin-001:admin', () => {
    expect(permFor(InvoiceController.prototype, 'list')).toEqual(['fin-001:read']);
    expect(permFor(InvoiceController.prototype, 'getById')).toEqual(['fin-001:read']);
    expect(permFor(InvoiceController.prototype, 'create')).toEqual(['fin-001:admin']);
    expect(permFor(InvoiceController.prototype, 'send')).toEqual(['fin-001:admin']);
    expect(permFor(InvoiceController.prototype, 'cancel')).toEqual(['fin-001:admin']);
    expect(permFor(InvoiceController.prototype, 'generateFromSchedule')).toEqual(['fin-001:admin']);
  });

  it('forwards args to each handler', async () => {
    const invoices = {
      list: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      send: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue({}),
      generateFromSchedule: vi.fn().mockResolvedValue({ created: 0 }),
    };
    const c = new InvoiceController(invoices as never, actorsStub() as never);
    await c.list({} as never, req);
    expect(invoices.list).toHaveBeenCalledWith({}, actor);
    await c.getById('inv-1', req);
    expect(invoices.getById).toHaveBeenCalledWith('inv-1', actor);
    await c.create({ title: 'X' } as never, req);
    expect(invoices.create).toHaveBeenCalledWith({ title: 'X' }, actor);
    await c.send('inv-1', req);
    expect(invoices.send).toHaveBeenCalledWith('inv-1', actor);
    await c.cancel('inv-1', req);
    expect(invoices.cancel).toHaveBeenCalledWith('inv-1', actor);
    await c.generateFromSchedule({ feeScheduleId: 'fs-1' } as never, req);
    expect(invoices.generateFromSchedule).toHaveBeenCalledWith({ feeScheduleId: 'fs-1' }, actor);
  });
});

describe('LunchAccountController', () => {
  it('mixed gates: admin / write / read', () => {
    expect(permFor(LunchAccountController.prototype, 'listLowBalance')).toEqual(['fin-001:admin']);
    expect(permFor(LunchAccountController.prototype, 'transfer')).toEqual(['fin-001:admin']);
    expect(permFor(LunchAccountController.prototype, 'getForStudent')).toEqual(['fin-001:read']);
    expect(permFor(LunchAccountController.prototype, 'deposit')).toEqual(['fin-001:write']);
    expect(permFor(LunchAccountController.prototype, 'updateSettings')).toEqual(['fin-001:admin']);
  });

  it('listLowBalance forwards actor', async () => {
    const lunch = { listLowBalance: vi.fn().mockResolvedValue([]) };
    const c = new LunchAccountController(lunch as never, actorsStub() as never);
    await c.listLowBalance(req);
    expect(lunch.listLowBalance).toHaveBeenCalledWith(actor);
  });

  it('transfer forwards body', async () => {
    const lunch = { transfer: vi.fn().mockResolvedValue({}) };
    const c = new LunchAccountController(lunch as never, actorsStub() as never);
    await c.transfer({ amount: 5, transferType: 'SIBLING_TRANSFER' } as never, req);
    expect(lunch.transfer).toHaveBeenCalledWith(
      { amount: 5, transferType: 'SIBLING_TRANSFER' },
      actor,
    );
  });

  it('getForStudent parses transactionsLimit + defaults to undefined', async () => {
    const lunch = { getForStudent: vi.fn().mockResolvedValue({}) };
    const c = new LunchAccountController(lunch as never, actorsStub() as never);
    await c.getForStudent('stu-1', '50', req);
    expect(lunch.getForStudent).toHaveBeenCalledWith('stu-1', actor, { transactionsLimit: 50 });
    await c.getForStudent('stu-1', undefined, req);
    expect(lunch.getForStudent).toHaveBeenLastCalledWith('stu-1', actor, {
      transactionsLimit: undefined,
    });
  });

  it('deposit forwards id + body', async () => {
    const lunch = { deposit: vi.fn().mockResolvedValue({}) };
    const c = new LunchAccountController(lunch as never, actorsStub() as never);
    await c.deposit('la-1', { amount: 25 } as never, req);
    expect(lunch.deposit).toHaveBeenCalledWith('la-1', { amount: 25 }, actor);
  });

  it('updateSettings forwards id + body', async () => {
    const lunch = { update: vi.fn().mockResolvedValue({}) };
    const c = new LunchAccountController(lunch as never, actorsStub() as never);
    await c.updateSettings('la-1', { lowBalanceThreshold: 5 } as never, req);
    expect(lunch.update).toHaveBeenCalledWith('la-1', { lowBalanceThreshold: 5 }, actor);
  });
});

describe('PaymentPlanController', () => {
  it('create on fin-001:admin; getById on fin-001:read', () => {
    expect(permFor(PaymentPlanController.prototype, 'create')).toEqual(['fin-001:admin']);
    expect(permFor(PaymentPlanController.prototype, 'getById')).toEqual(['fin-001:read']);
  });

  it('forwards args', async () => {
    const plans = {
      create: vi.fn().mockResolvedValue({}),
      getById: vi.fn().mockResolvedValue({}),
    };
    const c = new PaymentPlanController(plans as never, actorsStub() as never);
    await c.create('inv-1', { installmentCount: 4 } as never, req);
    expect(plans.create).toHaveBeenCalledWith('inv-1', { installmentCount: 4 }, actor);
    await c.getById('plan-1');
    expect(plans.getById).toHaveBeenCalledWith('plan-1');
  });
});

describe('BillingConfigController', () => {
  it('reads on fin-001:read; writes/triggers on fin-001:admin', () => {
    expect(permFor(BillingConfigController.prototype, 'listDiscountRules')).toEqual([
      'fin-001:read',
    ]);
    expect(permFor(BillingConfigController.prototype, 'getDiscountRule')).toEqual(['fin-001:read']);
    expect(permFor(BillingConfigController.prototype, 'createDiscountRule')).toEqual([
      'fin-001:admin',
    ]);
    expect(permFor(BillingConfigController.prototype, 'updateDiscountRule')).toEqual([
      'fin-001:admin',
    ]);
    expect(permFor(BillingConfigController.prototype, 'listAutoRules')).toEqual(['fin-001:read']);
    expect(permFor(BillingConfigController.prototype, 'getAutoRule')).toEqual(['fin-001:read']);
    expect(permFor(BillingConfigController.prototype, 'createAutoRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController.prototype, 'updateAutoRule')).toEqual(['fin-001:admin']);
    expect(permFor(BillingConfigController.prototype, 'triggerAutoRule')).toEqual([
      'fin-001:admin',
    ]);
    expect(permFor(BillingConfigController.prototype, 'generateFromFeeSchedule')).toEqual([
      'fin-001:admin',
    ]);
    expect(permFor(BillingConfigController.prototype, 'listGenerationRuns')).toEqual([
      'fin-001:read',
    ]);
    expect(permFor(BillingConfigController.prototype, 'getGenerationRun')).toEqual([
      'fin-001:read',
    ]);
  });

  it('discount rules pass through', async () => {
    const discounts = {
      list: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const autoInvoice = {};
    const c = new BillingConfigController(
      discounts as never,
      autoInvoice as never,
      actorsStub() as never,
    );
    await c.listDiscountRules({} as never, req);
    expect(discounts.list).toHaveBeenCalledWith({}, actor);
    await c.getDiscountRule('d-1', req);
    expect(discounts.getById).toHaveBeenCalledWith('d-1', actor);
    await c.createDiscountRule({ name: 'X' } as never, req);
    expect(discounts.create).toHaveBeenCalledWith({ name: 'X' }, actor);
    await c.updateDiscountRule('d-1', { name: 'Y' } as never, req);
    expect(discounts.update).toHaveBeenCalledWith('d-1', { name: 'Y' }, actor);
  });

  it('auto-invoice rules pass through with includeInactive parsing', async () => {
    const discounts = {};
    const autoInvoice = {
      listRules: vi.fn().mockResolvedValue([]),
      getRuleById: vi.fn().mockResolvedValue({}),
      createRule: vi.fn().mockResolvedValue({}),
      updateRule: vi.fn().mockResolvedValue({}),
      triggerRule: vi.fn().mockResolvedValue({}),
      generateFromFeeSchedule: vi.fn().mockResolvedValue({}),
      listRuns: vi.fn().mockResolvedValue([]),
      getRunById: vi.fn().mockResolvedValue({}),
    };
    const c = new BillingConfigController(
      discounts as never,
      autoInvoice as never,
      actorsStub() as never,
    );

    await c.listAutoRules('true', req);
    expect(autoInvoice.listRules).toHaveBeenCalledWith(true, actor);
    await c.listAutoRules(undefined, req);
    expect(autoInvoice.listRules).toHaveBeenLastCalledWith(false, actor);
    await c.listAutoRules('false', req);
    expect(autoInvoice.listRules).toHaveBeenLastCalledWith(false, actor);

    await c.getAutoRule('r-1', req);
    expect(autoInvoice.getRuleById).toHaveBeenCalledWith('r-1', actor);

    await c.createAutoRule({ name: 'R' } as never, req);
    expect(autoInvoice.createRule).toHaveBeenCalledWith({ name: 'R' }, actor);

    await c.updateAutoRule('r-1', { name: 'R2' } as never, req);
    expect(autoInvoice.updateRule).toHaveBeenCalledWith('r-1', { name: 'R2' }, actor);

    await c.triggerAutoRule('r-1', { academicYearId: 'ay-1' } as never, req);
    expect(autoInvoice.triggerRule).toHaveBeenCalledWith('r-1', { academicYearId: 'ay-1' }, actor);

    await c.generateFromFeeSchedule('fs-1', { academicYearId: 'ay-1' } as never, req);
    expect(autoInvoice.generateFromFeeSchedule).toHaveBeenCalledWith('fs-1', 'ay-1', actor);

    // null academic year when omitted
    await c.generateFromFeeSchedule('fs-1', {} as never, req);
    expect(autoInvoice.generateFromFeeSchedule).toHaveBeenLastCalledWith('fs-1', null, actor);

    await c.listGenerationRuns({} as never, req);
    expect(autoInvoice.listRuns).toHaveBeenCalledWith({}, actor);

    await c.getGenerationRun('run-1', req);
    expect(autoInvoice.getRunById).toHaveBeenCalledWith('run-1', actor);
  });
});

describe('FinancialAidController', () => {
  it('reads on fin-002:read; writes on fin-002:write/admin', () => {
    expect(permFor(FinancialAidController.prototype, 'listPrograms')).toEqual(['fin-002:read']);
    expect(permFor(FinancialAidController.prototype, 'getProgramById')).toEqual(['fin-002:read']);
    expect(permFor(FinancialAidController.prototype, 'createProgram')).toEqual(['fin-002:admin']);
    expect(permFor(FinancialAidController.prototype, 'updateProgram')).toEqual(['fin-002:admin']);
    expect(permFor(FinancialAidController.prototype, 'listApplications')).toEqual(['fin-002:read']);
    expect(permFor(FinancialAidController.prototype, 'getApplicationById')).toEqual([
      'fin-002:read',
    ]);
    expect(permFor(FinancialAidController.prototype, 'createApplication')).toEqual([
      'fin-002:write',
    ]);
    expect(permFor(FinancialAidController.prototype, 'updateApplication')).toEqual([
      'fin-002:write',
    ]);
    expect(permFor(FinancialAidController.prototype, 'submitApplication')).toEqual([
      'fin-002:write',
    ]);
    expect(permFor(FinancialAidController.prototype, 'withdrawApplication')).toEqual([
      'fin-002:write',
    ]);
    expect(permFor(FinancialAidController.prototype, 'reviewApplication')).toEqual([
      'fin-002:admin',
    ]);
    expect(permFor(FinancialAidController.prototype, 'listAwardsForStudent')).toEqual([
      'fin-002:read',
    ]);
  });

  it('programmes pass through with includeInactive parsing', async () => {
    const aid = {
      listPrograms: vi.fn().mockResolvedValue([]),
      getProgramById: vi.fn().mockResolvedValue({}),
      createProgram: vi.fn().mockResolvedValue({}),
      updateProgram: vi.fn().mockResolvedValue({}),
    };
    const c = new FinancialAidController(aid as never, actorsStub() as never);

    await c.listPrograms('true');
    expect(aid.listPrograms).toHaveBeenCalledWith(true);
    await c.listPrograms(undefined);
    expect(aid.listPrograms).toHaveBeenLastCalledWith(false);

    await c.getProgramById('p-1');
    expect(aid.getProgramById).toHaveBeenCalledWith('p-1');

    await c.createProgram({ name: 'P' } as never, req);
    expect(aid.createProgram).toHaveBeenCalledWith({ name: 'P' }, actor);

    await c.updateProgram('p-1', { name: 'P2' } as never, req);
    expect(aid.updateProgram).toHaveBeenCalledWith('p-1', { name: 'P2' }, actor);
  });

  it('applications pass through with actor + body', async () => {
    const aid = {
      listApplications: vi.fn().mockResolvedValue([]),
      getApplicationById: vi.fn().mockResolvedValue({}),
      createApplication: vi.fn().mockResolvedValue({}),
      updateApplication: vi.fn().mockResolvedValue({}),
      submitApplication: vi.fn().mockResolvedValue({}),
      withdrawApplication: vi.fn().mockResolvedValue({}),
      reviewApplication: vi.fn().mockResolvedValue({}),
      listAwardsForStudent: vi.fn().mockResolvedValue([]),
    };
    const c = new FinancialAidController(aid as never, actorsStub() as never);

    await c.listApplications({} as never, req);
    expect(aid.listApplications).toHaveBeenCalledWith({}, actor);

    await c.getApplicationById('a-1', req);
    expect(aid.getApplicationById).toHaveBeenCalledWith('a-1', actor);

    await c.createApplication({ studentId: 's-1' } as never, req);
    expect(aid.createApplication).toHaveBeenCalledWith({ studentId: 's-1' }, actor);

    await c.updateApplication('a-1', { applicationStatement: 'X' } as never, req);
    expect(aid.updateApplication).toHaveBeenCalledWith('a-1', { applicationStatement: 'X' }, actor);

    await c.submitApplication('a-1', req);
    expect(aid.submitApplication).toHaveBeenCalledWith('a-1', actor);

    await c.withdrawApplication('a-1', { reason: 'X' } as never, req);
    expect(aid.withdrawApplication).toHaveBeenCalledWith('a-1', { reason: 'X' }, actor);

    await c.reviewApplication('a-1', { action: 'APPROVE', awardAmount: 1500 } as never, req);
    expect(aid.reviewApplication).toHaveBeenCalledWith(
      'a-1',
      { action: 'APPROVE', awardAmount: 1500 },
      actor,
    );

    await c.listAwardsForStudent('stu-1', req);
    expect(aid.listAwardsForStudent).toHaveBeenCalledWith('stu-1', actor);
  });
});
