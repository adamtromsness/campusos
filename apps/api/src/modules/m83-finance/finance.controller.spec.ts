import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { FinanceController } from './finance.controller';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';

/**
 * P2-H4 test coverage uplift — finance.controller.ts (464 LOC).
 *
 * Single @Controller injecting 11 services (FundService, ChartOfAccountsService,
 * PeriodService, PostingService, SupplierService, BudgetService,
 * APVoucherService, APPaymentService, ReconciliationService, BoardReportService,
 * GrantService) + ActorContextService for the @Req actor resolution helper.
 *
 * Tests cover:
 *   - resolveActor private helper: throws on unauthenticated request
 *   - service delegation: every endpoint forwards to the right service method
 *     with the right arguments
 *   - @RequirePermission metadata: every endpoint carries the correct
 *     fin-005/006/007/008:read/write/admin gate per Cycle 26 design
 *   - filter passthrough on list endpoints (includeInactive, fiscalYear,
 *     status, supplierId, periodId, sourceModule)
 */

interface ServiceCalls {
  calls: Array<{ svc: string; method: string; args: unknown[] }>;
}

function makeServices() {
  const tracker: ServiceCalls = { calls: [] };
  function record(svc: string, method: string, ret: unknown = undefined) {
    return (...args: unknown[]) => {
      tracker.calls.push({ svc, method, args });
      return Promise.resolve(ret);
    };
  }
  const funds = {
    list: record('funds', 'list', ['fundA']),
    getById: record('funds', 'getById', { id: 'f-1' }),
    create: record('funds', 'create', { id: 'f-new' }),
    patch: record('funds', 'patch', { id: 'f-1', updated: true }),
  };
  const accounts = {
    list: record('accounts', 'list', ['accA']),
    getById: record('accounts', 'getById', { id: 'a-1' }),
    create: record('accounts', 'create', { id: 'a-new' }),
    patch: record('accounts', 'patch', { id: 'a-1', updated: true }),
    trialBalance: record('accounts', 'trialBalance', { lines: [], balanced: true }),
  };
  const periods = {
    list: record('periods', 'list', ['perA']),
    getById: record('periods', 'getById', { id: 'p-1' }),
    create: record('periods', 'create', { id: 'p-new' }),
    createSeries: record('periods', 'createSeries', [{ id: 'p-jan' }, { id: 'p-feb' }]),
    patchStatus: record('periods', 'patchStatus', { id: 'p-1', status: 'OPEN' }),
  };
  const posting = {
    list: record('posting', 'list', [{ id: 'b-1' }]),
    getById: record('posting', 'getById', { id: 'b-1' }),
    createDraft: record('posting', 'createDraft', { id: 'b-new' }),
    post: record('posting', 'post', { id: 'b-1', status: 'POSTED' }),
    void: record('posting', 'void', { id: 'b-1', status: 'VOIDED' }),
  };
  const suppliers = {
    list: record('suppliers', 'list', [{ id: 's-1' }]),
    getById: record('suppliers', 'getById', { id: 's-1' }),
    create: record('suppliers', 'create', { id: 's-new' }),
  };
  const budgets = {
    list: record('budgets', 'list', [{ id: 'bud-1' }]),
    getById: record('budgets', 'getById', { id: 'bud-1' }),
    create: record('budgets', 'create', { id: 'bud-new' }),
    patch: record('budgets', 'patch', { id: 'bud-1' }),
    addLine: record('budgets', 'addLine', { id: 'bud-1', lines: 2 }),
  };
  const apVouchers = {
    list: record('apVouchers', 'list', [{ id: 'v-1' }]),
    getById: record('apVouchers', 'getById', { id: 'v-1' }),
    create: record('apVouchers', 'create', { id: 'v-new' }),
    transition: record('apVouchers', 'transition', { id: 'v-1', status: 'APPROVED' }),
  };
  const apPayments = {
    listForVoucher: record('apPayments', 'listForVoucher', [{ id: 'pay-1' }]),
    pay: record('apPayments', 'pay', { id: 'pay-new' }),
  };
  const reconciliation = {
    list: record('reconciliation', 'list', [{ id: 'rec-1' }]),
    getById: record('reconciliation', 'getById', { id: 'rec-1' }),
    start: record('reconciliation', 'start', { id: 'rec-new' }),
    finalize: record('reconciliation', 'finalize', { id: 'rec-1', status: 'RECONCILED' }),
  };
  const boardReports = {
    list: record('boardReports', 'list', [{ id: 'rpt-1' }]),
    getById: record('boardReports', 'getById', { id: 'rpt-1' }),
    generate: record('boardReports', 'generate', { id: 'rpt-new' }),
  };
  const grants = {
    list: record('grants', 'list', [{ id: 'g-1' }]),
    getById: record('grants', 'getById', { id: 'g-1' }),
    create: record('grants', 'create', { id: 'g-new' }),
    patch: record('grants', 'patch', { id: 'g-1' }),
  };
  const actors = {
    resolveActor: async (accountId: string, personId: string) => ({
      accountId,
      personId,
      personType: 'STAFF',
      isSchoolAdmin: true,
      employeeId: 'emp-1',
    }),
  };
  return {
    tracker,
    services: {
      funds,
      accounts,
      periods,
      posting,
      suppliers,
      budgets,
      apVouchers,
      apPayments,
      reconciliation,
      boardReports,
      grants,
      actors,
    },
  };
}

function makeController() {
  const { tracker, services } = makeServices();
  const controller = new FinanceController(
    services.funds as never,
    services.accounts as never,
    services.periods as never,
    services.posting as never,
    services.suppliers as never,
    services.budgets as never,
    services.apVouchers as never,
    services.apPayments as never,
    services.reconciliation as never,
    services.boardReports as never,
    services.grants as never,
    services.actors as never,
  );
  return { controller, tracker };
}

function mockReq() {
  return {
    user: {
      sub: 'acc-admin',
      personId: 'pers-admin',
      email: 'a@b.c',
      displayName: 'Admin',
      sessionId: 'sess-1',
    },
  } as unknown as Parameters<FinanceController['createFund']>[1];
}

describe('FinanceController — resolveActor', () => {
  it('throws when request is unauthenticated (no user)', async () => {
    const { controller } = makeController();
    const req = {} as Parameters<FinanceController['createFund']>[1];
    await expect(controller.createFund({} as never, req)).rejects.toThrow(
      'Unauthenticated request reached Finance controller',
    );
  });
});

describe('FinanceController — Funds endpoints', () => {
  it('GET /funds delegates to funds.list', async () => {
    const { controller, tracker } = makeController();
    const result = await controller.listFunds();
    expect(result).toEqual(['fundA']);
    expect(tracker.calls).toContainEqual({ svc: 'funds', method: 'list', args: [] });
  });

  it('GET /funds/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getFund('f-1');
    expect(tracker.calls).toContainEqual({ svc: 'funds', method: 'getById', args: ['f-1'] });
  });

  it('POST /funds resolves actor + forwards dto', async () => {
    const { controller, tracker } = makeController();
    const dto = { fundCode: 'X', fundName: 'X', fundType: 'GENERAL' as const };
    await controller.createFund(dto, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'funds' && c.method === 'create')!;
    expect(call.args[0]).toMatchObject({ accountId: 'acc-admin', personId: 'pers-admin' });
    expect(call.args[1]).toBe(dto);
  });

  it('PATCH /funds/:id forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.patchFund('f-1', { fundName: 'Renamed' }, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'funds' && c.method === 'patch')!;
    expect(call.args[1]).toBe('f-1');
    expect(call.args[2]).toEqual({ fundName: 'Renamed' });
  });
});

describe('FinanceController — Chart of Accounts endpoints', () => {
  it('GET /accounts passes includeInactive=true correctly', async () => {
    const { controller, tracker } = makeController();
    await controller.listAccounts('true');
    expect(tracker.calls).toContainEqual({ svc: 'accounts', method: 'list', args: [true] });
  });

  it('GET /accounts defaults includeInactive=false on omission', async () => {
    const { controller, tracker } = makeController();
    await controller.listAccounts();
    expect(tracker.calls).toContainEqual({ svc: 'accounts', method: 'list', args: [false] });
  });

  it('GET /accounts treats any non-true string as false', async () => {
    const { controller, tracker } = makeController();
    await controller.listAccounts('yes');
    expect(tracker.calls).toContainEqual({ svc: 'accounts', method: 'list', args: [false] });
  });

  it('GET /accounts/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getAccount('a-1');
    expect(tracker.calls).toContainEqual({ svc: 'accounts', method: 'getById', args: ['a-1'] });
  });

  it('POST /accounts forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    const dto = {
      accountCode: '1000',
      accountName: 'Cash',
      accountType: 'ASSET' as const,
      normalBalance: 'DEBIT' as const,
    };
    await controller.createAccount(dto, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'accounts' && c.method === 'create')!;
    expect(call.args[1]).toBe(dto);
  });

  it('PATCH /accounts/:id forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.patchAccount('a-1', { description: 'new' }, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'accounts' && c.method === 'patch')!;
    expect(call.args[1]).toBe('a-1');
  });

  it('GET /trial-balance forwards periodId or undefined', async () => {
    const { controller, tracker } = makeController();
    await controller.trialBalance('p-1');
    expect(tracker.calls).toContainEqual({
      svc: 'accounts',
      method: 'trialBalance',
      args: ['p-1'],
    });
    await controller.trialBalance();
    expect(tracker.calls).toContainEqual({
      svc: 'accounts',
      method: 'trialBalance',
      args: [undefined],
    });
  });
});

describe('FinanceController — Periods endpoints', () => {
  it('GET /periods forwards fiscalYear filter', async () => {
    const { controller, tracker } = makeController();
    await controller.listPeriods('2026');
    expect(tracker.calls).toContainEqual({ svc: 'periods', method: 'list', args: ['2026'] });
  });

  it('GET /periods/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getPeriod('p-1');
    expect(tracker.calls).toContainEqual({ svc: 'periods', method: 'getById', args: ['p-1'] });
  });

  it('POST /periods forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    const dto = {
      fiscalYear: '2026',
      periodNumber: 1,
      periodName: 'Jan',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    };
    await controller.createPeriod(dto, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'periods' && c.method === 'create')!;
    expect(call.args[1]).toBe(dto);
  });

  it('POST /periods/series forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    const dto = { fiscalYear: '2026', yearStart: '2026-07-01' };
    await controller.createPeriodSeries(dto, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'periods' && c.method === 'createSeries')!;
    expect(call.args[1]).toBe(dto);
  });

  it('PATCH /periods/:id/status forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.patchPeriodStatus('p-1', { status: 'CLOSED' }, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'periods' && c.method === 'patchStatus')!;
    expect(call.args[1]).toBe('p-1');
    expect(call.args[2]).toEqual({ status: 'CLOSED' });
  });
});

describe('FinanceController — Journal Batches endpoints', () => {
  it('GET /journal-batches forwards filter object', async () => {
    const { controller, tracker } = makeController();
    await controller.listBatches('POSTED', 'p-1', 'payments');
    expect(tracker.calls).toContainEqual({
      svc: 'posting',
      method: 'list',
      args: [{ status: 'POSTED', periodId: 'p-1', sourceModule: 'payments' }],
    });
  });

  it('GET /journal-batches forwards undefined filters when omitted', async () => {
    const { controller, tracker } = makeController();
    await controller.listBatches();
    expect(tracker.calls).toContainEqual({
      svc: 'posting',
      method: 'list',
      args: [{ status: undefined, periodId: undefined, sourceModule: undefined }],
    });
  });

  it('GET /journal-batches/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getBatch('b-1');
    expect(tracker.calls).toContainEqual({ svc: 'posting', method: 'getById', args: ['b-1'] });
  });

  it('POST /journal-batches delegates to createDraft (NOT post)', async () => {
    const { controller, tracker } = makeController();
    const dto = {
      batchNumber: 'B-1',
      description: 'd',
      batchType: 'MANUAL' as const,
      accountingPeriodId: 'p-1',
      entries: [],
    };
    await controller.createBatch(dto, mockReq());
    expect(tracker.calls.some((c) => c.svc === 'posting' && c.method === 'createDraft')).toBe(true);
    expect(tracker.calls.some((c) => c.svc === 'posting' && c.method === 'post')).toBe(false);
  });

  it('POST /journal-batches/:id/post forwards id + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.postBatch('b-1', mockReq());
    const call = tracker.calls.find((c) => c.svc === 'posting' && c.method === 'post')!;
    expect(call.args[1]).toBe('b-1');
  });

  it('POST /journal-batches/:id/void forwards id + reason', async () => {
    const { controller, tracker } = makeController();
    await controller.voidBatch('b-1', { reason: 'misposted' }, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'posting' && c.method === 'void')!;
    expect(call.args[1]).toBe('b-1');
    expect(call.args[2]).toEqual({ reason: 'misposted' });
  });
});

describe('FinanceController — Suppliers endpoints', () => {
  it('GET /suppliers passes includeInactive correctly', async () => {
    const { controller, tracker } = makeController();
    await controller.listSuppliers('true');
    expect(tracker.calls).toContainEqual({ svc: 'suppliers', method: 'list', args: [true] });
    await controller.listSuppliers();
    expect(tracker.calls).toContainEqual({ svc: 'suppliers', method: 'list', args: [false] });
  });

  it('GET /suppliers/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getSupplier('s-1');
    expect(tracker.calls).toContainEqual({
      svc: 'suppliers',
      method: 'getById',
      args: ['s-1'],
    });
  });

  it('POST /suppliers forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.createSupplier({ supplierName: 'Acme' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'suppliers' && c.method === 'create')!;
    expect(call.args[1]).toEqual({ supplierName: 'Acme' });
  });
});

describe('FinanceController — Budgets endpoints', () => {
  it('GET /budgets forwards fiscalYear', async () => {
    const { controller, tracker } = makeController();
    await controller.listBudgets('2026');
    expect(tracker.calls).toContainEqual({ svc: 'budgets', method: 'list', args: ['2026'] });
  });

  it('GET /budgets/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getBudget('bud-1');
    expect(tracker.calls).toContainEqual({
      svc: 'budgets',
      method: 'getById',
      args: ['bud-1'],
    });
  });

  it('POST /budgets forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.createBudget({ name: 'B' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'budgets' && c.method === 'create')!;
    expect(call.args[1]).toEqual({ name: 'B' });
  });

  it('PATCH /budgets/:id forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.patchBudget('bud-1', { name: 'B2' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'budgets' && c.method === 'patch')!;
    expect(call.args[1]).toBe('bud-1');
    expect(call.args[2]).toEqual({ name: 'B2' });
  });

  it('POST /budgets/:id/lines forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.addBudgetLine('bud-1', { accountId: 'a-1', amount: 1000 } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'budgets' && c.method === 'addLine')!;
    expect(call.args[1]).toBe('bud-1');
  });
});

describe('FinanceController — AP Vouchers endpoints', () => {
  it('GET /ap-vouchers forwards filter object', async () => {
    const { controller, tracker } = makeController();
    await controller.listAPVouchers('APPROVED', 's-1');
    expect(tracker.calls).toContainEqual({
      svc: 'apVouchers',
      method: 'list',
      args: [{ status: 'APPROVED', supplierId: 's-1' }],
    });
  });

  it('GET /ap-vouchers passes undefined for missing query params', async () => {
    const { controller, tracker } = makeController();
    await controller.listAPVouchers();
    expect(tracker.calls).toContainEqual({
      svc: 'apVouchers',
      method: 'list',
      args: [{ status: undefined, supplierId: undefined }],
    });
  });

  it('GET /ap-vouchers/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getAPVoucher('v-1');
    expect(tracker.calls).toContainEqual({
      svc: 'apVouchers',
      method: 'getById',
      args: ['v-1'],
    });
  });

  it('POST /ap-vouchers forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.createAPVoucher({ supplierId: 's-1', total: 100 } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'apVouchers' && c.method === 'create')!;
    expect(call.args[1]).toEqual({ supplierId: 's-1', total: 100 });
  });

  it('PATCH /ap-vouchers/:id/transition forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.transitionAPVoucher('v-1', { action: 'APPROVE' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'apVouchers' && c.method === 'transition')!;
    expect(call.args[1]).toBe('v-1');
    expect(call.args[2]).toEqual({ action: 'APPROVE' });
  });
});

describe('FinanceController — AP Payments endpoints', () => {
  it('GET /ap-vouchers/:id/payments forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.listAPPayments('v-1');
    expect(tracker.calls).toContainEqual({
      svc: 'apPayments',
      method: 'listForVoucher',
      args: ['v-1'],
    });
  });

  it('POST /ap-vouchers/:id/pay forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.payAPVoucher('v-1', { amount: 100 } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'apPayments' && c.method === 'pay')!;
    expect(call.args[1]).toBe('v-1');
    expect(call.args[2]).toEqual({ amount: 100 });
  });
});

describe('FinanceController — Reconciliation endpoints', () => {
  it('GET /reconciliation delegates', async () => {
    const { controller, tracker } = makeController();
    await controller.listReconciliation();
    expect(tracker.calls).toContainEqual({ svc: 'reconciliation', method: 'list', args: [] });
  });

  it('GET /reconciliation/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getReconciliation('rec-1');
    expect(tracker.calls).toContainEqual({
      svc: 'reconciliation',
      method: 'getById',
      args: ['rec-1'],
    });
  });

  it('POST /reconciliation forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.startReconciliation({ accountId: 'a-1' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'reconciliation' && c.method === 'start')!;
    expect(call.args[1]).toEqual({ accountId: 'a-1' });
  });

  it('PATCH /reconciliation/:id/finalize forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.finalizeReconciliation('rec-1', { status: 'RECONCILED' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'reconciliation' && c.method === 'finalize')!;
    expect(call.args[1]).toBe('rec-1');
  });
});

describe('FinanceController — Board Reports + Grants endpoints', () => {
  it('GET /board-reports delegates', async () => {
    const { controller, tracker } = makeController();
    await controller.listBoardReports();
    expect(tracker.calls).toContainEqual({ svc: 'boardReports', method: 'list', args: [] });
  });

  it('GET /board-reports/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getBoardReport('rpt-1');
    expect(tracker.calls).toContainEqual({
      svc: 'boardReports',
      method: 'getById',
      args: ['rpt-1'],
    });
  });

  it('POST /board-reports forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.generateBoardReport({ reportType: 'BALANCE_SHEET' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'boardReports' && c.method === 'generate')!;
    expect(call.args[1]).toEqual({ reportType: 'BALANCE_SHEET' });
  });

  it('GET /grants delegates', async () => {
    const { controller, tracker } = makeController();
    await controller.listGrants();
    expect(tracker.calls).toContainEqual({ svc: 'grants', method: 'list', args: [] });
  });

  it('GET /grants/:id forwards id', async () => {
    const { controller, tracker } = makeController();
    await controller.getGrant('g-1');
    expect(tracker.calls).toContainEqual({ svc: 'grants', method: 'getById', args: ['g-1'] });
  });

  it('POST /grants forwards dto + actor', async () => {
    const { controller, tracker } = makeController();
    await controller.createGrant({ name: 'Title I' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'grants' && c.method === 'create')!;
    expect(call.args[1]).toEqual({ name: 'Title I' });
  });

  it('PATCH /grants/:id forwards (actor, id, dto)', async () => {
    const { controller, tracker } = makeController();
    await controller.patchGrant('g-1', { name: 'Updated' } as never, mockReq());
    const call = tracker.calls.find((c) => c.svc === 'grants' && c.method === 'patch')!;
    expect(call.args[1]).toBe('g-1');
  });
});

describe('FinanceController — @RequirePermission metadata distribution', () => {
  function metaFor(method: keyof FinanceController): string[] {
    const fn = FinanceController.prototype[method] as unknown as object;
    return (Reflect.getMetadata(PERMISSIONS_KEY, fn) ?? []) as string[];
  }

  // FIN-005 — General Ledger + Chart of Accounts + Periods
  it.each([
    ['listFunds', ['fin-005:read']],
    ['getFund', ['fin-005:read']],
    ['createFund', ['fin-005:write']],
    ['patchFund', ['fin-005:write']],
    ['listAccounts', ['fin-005:read']],
    ['getAccount', ['fin-005:read']],
    ['createAccount', ['fin-005:write']],
    ['patchAccount', ['fin-005:write']],
    ['trialBalance', ['fin-005:read']],
    ['listPeriods', ['fin-005:read']],
    ['getPeriod', ['fin-005:read']],
    ['createPeriod', ['fin-005:write']],
    ['createPeriodSeries', ['fin-005:write']],
    ['patchPeriodStatus', ['fin-005:write']],
    ['listBatches', ['fin-005:read']],
    ['getBatch', ['fin-005:read']],
    ['createBatch', ['fin-005:write']],
    ['postBatch', ['fin-005:write']],
    ['voidBatch', ['fin-005:admin']],
  ])('%s gates on %s', (method, expected) => {
    expect(metaFor(method as keyof FinanceController)).toEqual(expected);
  });

  // FIN-006 — Operating Budgets
  it.each([
    ['listBudgets', ['fin-006:read']],
    ['getBudget', ['fin-006:read']],
    ['createBudget', ['fin-006:write']],
    ['patchBudget', ['fin-006:write']],
    ['addBudgetLine', ['fin-006:write']],
  ])('%s gates on %s', (method, expected) => {
    expect(metaFor(method as keyof FinanceController)).toEqual(expected);
  });

  // FIN-007 — Accounts Payable (suppliers, vouchers, payments)
  it.each([
    ['listSuppliers', ['fin-007:read']],
    ['getSupplier', ['fin-007:read']],
    ['createSupplier', ['fin-007:write']],
    ['listAPVouchers', ['fin-007:read']],
    ['getAPVoucher', ['fin-007:read']],
    ['createAPVoucher', ['fin-007:write']],
    ['transitionAPVoucher', ['fin-007:admin']],
    ['listAPPayments', ['fin-007:read']],
    ['payAPVoucher', ['fin-007:admin']],
  ])('%s gates on %s', (method, expected) => {
    expect(metaFor(method as keyof FinanceController)).toEqual(expected);
  });

  // FIN-008 — Reconciliation, Board Reports & Grants
  it.each([
    ['listReconciliation', ['fin-008:read']],
    ['getReconciliation', ['fin-008:read']],
    ['startReconciliation', ['fin-008:write']],
    ['finalizeReconciliation', ['fin-008:write']],
    ['listBoardReports', ['fin-008:read']],
    ['getBoardReport', ['fin-008:read']],
    ['generateBoardReport', ['fin-008:write']],
    ['listGrants', ['fin-008:read']],
    ['getGrant', ['fin-008:read']],
    ['createGrant', ['fin-008:write']],
    ['patchGrant', ['fin-008:write']],
  ])('%s gates on %s', (method, expected) => {
    expect(metaFor(method as keyof FinanceController)).toEqual(expected);
  });

  it('voidBatch + transitionAPVoucher + payAPVoucher carry :admin tier (board-action keystone gates)', () => {
    expect(metaFor('voidBatch')).toEqual(['fin-005:admin']);
    expect(metaFor('transitionAPVoucher')).toEqual(['fin-007:admin']);
    expect(metaFor('payAPVoucher')).toEqual(['fin-007:admin']);
  });
});
