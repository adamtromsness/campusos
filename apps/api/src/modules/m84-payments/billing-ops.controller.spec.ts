import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { BillingOpsController } from './billing-ops.controller';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * P2-H4 test coverage uplift — payments/billing-ops.controller.ts (234 LOC,
 * Tier 1 Financial; admin-only HTTP surface for credit notes / reversals /
 * payment allocations / late-fee policy + scan / saved payment methods).
 *
 * Controllers are pass-throughs into services that already have deep
 * unit coverage; this spec asserts:
 *   - every endpoint is gated with the correct @RequirePermission
 *     metadata (via Reflector)
 *   - each handler resolves the actor from req.user and forwards the
 *     correct positional args to the underlying service
 *   - return values from the service are passed through unchanged
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

function makeStubs() {
  const creditNotes = {
    list: vi.fn().mockResolvedValue([{ id: 'cn-1' }]),
    getById: vi.fn().mockResolvedValue({ id: 'cn-1' }),
    issue: vi.fn().mockResolvedValue({ id: 'cn-new' }),
  };
  const reversals = {
    list: vi.fn().mockResolvedValue([{ id: 'rev-1' }]),
    getById: vi.fn().mockResolvedValue({ id: 'rev-1' }),
    reverse: vi.fn().mockResolvedValue({ id: 'rev-new' }),
  };
  const allocations = {
    listForPayment: vi.fn().mockResolvedValue([{ id: 'alloc-1' }]),
    allocate: vi.fn().mockResolvedValue([{ id: 'alloc-new' }]),
  };
  const lateFees = {
    getPolicy: vi.fn().mockResolvedValue({ id: 'pol-1', isActive: true }),
    upsertPolicy: vi.fn().mockResolvedValue({ id: 'pol-1', isActive: false }),
    runScan: vi.fn().mockResolvedValue({ invoicesEvaluated: 5 }),
  };
  const savedPaymentMethods = {
    listForFamily: vi.fn().mockResolvedValue([{ id: 'pm-1' }]),
    create: vi.fn().mockResolvedValue({ id: 'pm-new' }),
    remove: vi.fn().mockResolvedValue({ id: 'pm-1', removed: true }),
  };
  const actors = {
    resolveActor: vi.fn().mockResolvedValue(actor),
  };
  return { creditNotes, reversals, allocations, lateFees, savedPaymentMethods, actors };
}

function newController() {
  const stubs = makeStubs();
  const c = new BillingOpsController(
    stubs.creditNotes as never,
    stubs.reversals as never,
    stubs.allocations as never,
    stubs.lateFees as never,
    stubs.savedPaymentMethods as never,
    stubs.actors as never,
  );
  return { c, stubs };
}

const reflector = new Reflector();

describe('BillingOpsController — permission metadata', () => {
  it.each([
    ['listCreditNotes', 'fin-001:admin'],
    ['getCreditNote', 'fin-001:admin'],
    ['issueCreditNote', 'fin-001:admin'],
    ['listReversals', 'fin-001:admin'],
    ['getReversal', 'fin-001:admin'],
    ['reversePayment', 'fin-001:admin'],
    ['listAllocations', 'fin-001:admin'],
    ['allocate', 'fin-001:admin'],
    ['getLatePaymentPolicy', 'fin-001:admin'],
    ['upsertLatePaymentPolicy', 'fin-001:admin'],
    ['runLateFeesScan', 'fin-001:admin'],
    ['listSavedPaymentMethods', 'fin-001:read'],
    ['createSavedPaymentMethod', 'fin-001:write'],
    ['removeSavedPaymentMethod', 'fin-001:write'],
  ])('%s is gated on %s', (handler, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = (BillingOpsController.prototype as any)[handler];
    const perms = reflector.get<string[]>(PERMISSIONS_KEY, target);
    expect(perms).toEqual([expected]);
  });
});

describe('BillingOpsController — handler forwarding', () => {
  it('listCreditNotes forwards query + actor', async () => {
    const { c, stubs } = newController();
    const result = await c.listCreditNotes({ status: 'POSTED' } as never, req);
    expect(stubs.actors.resolveActor).toHaveBeenCalledWith('acc-admin', 'pers-admin');
    expect(stubs.creditNotes.list).toHaveBeenCalledWith({ status: 'POSTED' }, actor);
    expect(result).toEqual([{ id: 'cn-1' }]);
  });

  it('getCreditNote forwards id', async () => {
    const { c, stubs } = newController();
    await c.getCreditNote('cn-1', req);
    expect(stubs.creditNotes.getById).toHaveBeenCalledWith('cn-1', actor);
  });

  it('issueCreditNote forwards invoice id + body', async () => {
    const { c, stubs } = newController();
    await c.issueCreditNote(
      'inv-1',
      { amount: 100, reason: 'goodwill', creditCategory: 'GOODWILL' } as never,
      req,
    );
    expect(stubs.creditNotes.issue).toHaveBeenCalledWith(
      'inv-1',
      { amount: 100, reason: 'goodwill', creditCategory: 'GOODWILL' },
      actor,
    );
  });

  it('listReversals forwards query', async () => {
    const { c, stubs } = newController();
    await c.listReversals({} as never, req);
    expect(stubs.reversals.list).toHaveBeenCalledWith({}, actor);
  });

  it('getReversal forwards id', async () => {
    const { c, stubs } = newController();
    await c.getReversal('rev-1', req);
    expect(stubs.reversals.getById).toHaveBeenCalledWith('rev-1', actor);
  });

  it('reversePayment forwards payment id + body', async () => {
    const { c, stubs } = newController();
    await c.reversePayment(
      'pay-1',
      { reversalCategory: 'BOUNCED_CHEQUE', reason: 'NSF' } as never,
      req,
    );
    expect(stubs.reversals.reverse).toHaveBeenCalledWith(
      'pay-1',
      { reversalCategory: 'BOUNCED_CHEQUE', reason: 'NSF' },
      actor,
    );
  });

  it('listAllocations forwards payment id', async () => {
    const { c, stubs } = newController();
    await c.listAllocations('pay-1', req);
    expect(stubs.allocations.listForPayment).toHaveBeenCalledWith('pay-1', actor);
  });

  it('allocate forwards payment id + body', async () => {
    const { c, stubs } = newController();
    await c.allocate(
      'pay-1',
      { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] } as never,
      req,
    );
    expect(stubs.allocations.allocate).toHaveBeenCalledWith(
      'pay-1',
      { allocations: [{ invoiceId: 'inv-1', allocatedAmount: 500 }] },
      actor,
    );
  });

  it('getLatePaymentPolicy forwards actor', async () => {
    const { c, stubs } = newController();
    await c.getLatePaymentPolicy(req);
    expect(stubs.lateFees.getPolicy).toHaveBeenCalledWith(actor);
  });

  it('upsertLatePaymentPolicy forwards body', async () => {
    const { c, stubs } = newController();
    await c.upsertLatePaymentPolicy(
      { feeType: 'FIXED', feeAmount: 25, gracePeriodDays: 7 } as never,
      req,
    );
    expect(stubs.lateFees.upsertPolicy).toHaveBeenCalledWith(
      { feeType: 'FIXED', feeAmount: 25, gracePeriodDays: 7 },
      actor,
    );
  });

  it('runLateFeesScan forwards actor', async () => {
    const { c, stubs } = newController();
    const r = await c.runLateFeesScan(req);
    expect(stubs.lateFees.runScan).toHaveBeenCalledWith(actor);
    expect(r).toEqual({ invoicesEvaluated: 5 });
  });

  it('listSavedPaymentMethods forwards familyAccountId', async () => {
    const { c, stubs } = newController();
    await c.listSavedPaymentMethods('fa-1', req);
    expect(stubs.savedPaymentMethods.listForFamily).toHaveBeenCalledWith('fa-1', actor);
  });

  it('createSavedPaymentMethod forwards body', async () => {
    const { c, stubs } = newController();
    await c.createSavedPaymentMethod(
      { familyAccountId: 'fa-1', stripePaymentMethodId: 'pm_test', cardLastFour: '4242' } as never,
      req,
    );
    expect(stubs.savedPaymentMethods.create).toHaveBeenCalledWith(
      { familyAccountId: 'fa-1', stripePaymentMethodId: 'pm_test', cardLastFour: '4242' },
      actor,
    );
  });

  it('removeSavedPaymentMethod forwards id', async () => {
    const { c, stubs } = newController();
    const r = await c.removeSavedPaymentMethod('pm-1', req);
    expect(stubs.savedPaymentMethods.remove).toHaveBeenCalledWith('pm-1', actor);
    expect(r).toEqual({ id: 'pm-1', removed: true });
  });
});
