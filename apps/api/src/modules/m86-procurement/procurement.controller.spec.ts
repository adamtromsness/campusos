import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ProcurementController } from './procurement.controller';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

/**
 * Loop 6 — controller-layer coverage for procurement.controller.ts.
 *
 * Procurement's 28 endpoints are thin pass-throughs to the 7 services
 * already covered end-to-end by the DB-backed integration suite at
 * test/integration/procurement/. This spec adds the controller-specific
 * surface area:
 *
 *   - @RequirePermission metadata on every handler (PRC-001 / 002 / 003
 *     read / write / admin per the IAM catalogue);
 *   - actor resolution from req.user → ActorContextService.resolveActor;
 *   - argument forwarding from path / query / body / actor into the
 *     correct service method positional shape.
 *
 * Matches the established pattern from src/payments/controllers-batch.spec.ts
 * (mock-based vi.fn() stubs, no DB, no Nest TestingModule). Coverage lands
 * under the unit suite and pushes procurement.controller.ts from 0% to
 * ~100% lines.
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

const reflector = new Reflector();

function permFor(handler: string): string[] | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (ProcurementController.prototype as any)[handler];
  return reflector.get<string[]>(PERMISSIONS_KEY, fn);
}

/**
 * Build a fresh ProcurementController with vi.fn() service stubs.
 * Each test gets isolated mocks so call assertions don't bleed across tests.
 */
function makeController() {
  const requisitions = {
    list: vi.fn().mockResolvedValue([{ id: 'r-1' }]),
    getById: vi.fn().mockResolvedValue({ id: 'r-1' }),
    create: vi.fn().mockResolvedValue({ id: 'r-new' }),
    addLine: vi.fn().mockResolvedValue({ id: 'r-1' }),
    removeLine: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue({ id: 'r-1' }),
    approve: vi.fn().mockResolvedValue({ id: 'r-1' }),
    reject: vi.fn().mockResolvedValue({ id: 'r-1' }),
  };
  const purchaseOrders = {
    list: vi.fn().mockResolvedValue([{ id: 'po-1' }]),
    getById: vi.fn().mockResolvedValue({ id: 'po-1' }),
    create: vi.fn().mockResolvedValue({ id: 'po-new' }),
    transition: vi.fn().mockResolvedValue({ id: 'po-1' }),
  };
  const receipts = {
    listForPO: vi.fn().mockResolvedValue([{ id: 'gr-1' }]),
    create: vi.fn().mockResolvedValue({ id: 'gr-new' }),
  };
  const distributions = {
    listForReceipt: vi.fn().mockResolvedValue([{ id: 'd-1' }]),
    create: vi.fn().mockResolvedValue({ id: 'd-new' }),
  };
  const returns = {
    listAll: vi.fn().mockResolvedValue([{ id: 'ret-1' }]),
    getById: vi.fn().mockResolvedValue({ id: 'ret-1' }),
    listForReceiptLine: vi.fn().mockResolvedValue([{ id: 'ret-1' }]),
    create: vi.fn().mockResolvedValue({ id: 'ret-new' }),
    update: vi.fn().mockResolvedValue({ id: 'ret-1' }),
  };
  const vendorPerformance = {
    list: vi.fn().mockResolvedValue([{ vendorId: 'v-1' }]),
    getForVendor: vi.fn().mockResolvedValue({ vendorId: 'v-1' }),
  };
  const settings = {
    get: vi.fn().mockResolvedValue({ schoolId: 's-1' }),
    update: vi.fn().mockResolvedValue({ schoolId: 's-1' }),
  };
  const actors = { resolveActor: vi.fn().mockResolvedValue(actor) };
  const controller = new ProcurementController(
    requisitions as never,
    purchaseOrders as never,
    receipts as never,
    distributions as never,
    returns as never,
    vendorPerformance as never,
    settings as never,
    actors as never,
  );
  return {
    controller,
    requisitions,
    purchaseOrders,
    receipts,
    distributions,
    returns,
    vendorPerformance,
    settings,
    actors,
  };
}

// ──────────────────────────────────────────────────────────────
// @RequirePermission metadata — one block, all 28 endpoints
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — @RequirePermission metadata', () => {
  it('requisitions endpoints gated on prc-001 (read for reads, write for writes)', () => {
    expect(permFor('listRequisitions')).toEqual(['prc-001:read']);
    expect(permFor('getRequisition')).toEqual(['prc-001:read']);
    expect(permFor('createRequisition')).toEqual(['prc-001:write']);
    expect(permFor('addRequisitionLine')).toEqual(['prc-001:write']);
    expect(permFor('removeRequisitionLine')).toEqual(['prc-001:write']);
    expect(permFor('submitRequisition')).toEqual(['prc-001:write']);
    expect(permFor('approveRequisition')).toEqual(['prc-001:write']);
    expect(permFor('rejectRequisition')).toEqual(['prc-001:write']);
  });

  it('purchase-order + receipt endpoints gated on prc-002', () => {
    expect(permFor('listPOs')).toEqual(['prc-002:read']);
    expect(permFor('getPO')).toEqual(['prc-002:read']);
    expect(permFor('createPO')).toEqual(['prc-002:write']);
    expect(permFor('transitionPO')).toEqual(['prc-002:write']);
    expect(permFor('listReceipts')).toEqual(['prc-002:read']);
    expect(permFor('createReceipt')).toEqual(['prc-002:write']);
  });

  it('distribution + return + vendor-performance endpoints gated on prc-003', () => {
    expect(permFor('listDistributions')).toEqual(['prc-003:read']);
    expect(permFor('createDistribution')).toEqual(['prc-003:write']);
    expect(permFor('listReturns')).toEqual(['prc-003:read']);
    expect(permFor('getReturn')).toEqual(['prc-003:read']);
    expect(permFor('listReturnsForLine')).toEqual(['prc-003:read']);
    expect(permFor('createReturn')).toEqual(['prc-003:write']);
    expect(permFor('updateReturn')).toEqual(['prc-003:write']);
    expect(permFor('listVendorPerformance')).toEqual(['prc-003:read']);
    expect(permFor('getVendorPerformance')).toEqual(['prc-003:read']);
  });

  it('settings: getSettings on prc-001:read; updateSettings ADMIN-ONLY on prc-001:admin', () => {
    expect(permFor('getSettings')).toEqual(['prc-001:read']);
    expect(permFor('updateSettings')).toEqual(['prc-001:admin']);
  });
});

// ──────────────────────────────────────────────────────────────
// Actor resolution from req.user
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — actor resolution', () => {
  it('resolveActor passes sub + personId from req.user into ActorContextService', async () => {
    const c = makeController();
    await c.controller.listRequisitions('SUBMITTED', req);
    expect(c.actors.resolveActor).toHaveBeenCalledWith('acc-admin', 'pers-admin');
  });

  it('throws when req.user is missing (the canonical "unauthenticated request reached controller" guard)', async () => {
    const c = makeController();
    const unauthed = {} as never;
    await expect(
      c.controller.listRequisitions(undefined, unauthed),
    ).rejects.toThrow(/Unauthenticated request reached Procurement controller/);
  });
});

// ──────────────────────────────────────────────────────────────
// Requisition endpoints — argument forwarding
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — requisition endpoint forwarding', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listRequisitions forwards (actor, status)', async () => {
    const out = await c.controller.listRequisitions('SUBMITTED', req);
    expect(c.requisitions.list).toHaveBeenCalledWith(actor, 'SUBMITTED');
    expect(out).toEqual([{ id: 'r-1' }]);
  });

  it('listRequisitions forwards undefined status', async () => {
    await c.controller.listRequisitions(undefined, req);
    expect(c.requisitions.list).toHaveBeenCalledWith(actor, undefined);
  });

  it('getRequisition forwards (id, actor)', async () => {
    await c.controller.getRequisition('req-42', req);
    expect(c.requisitions.getById).toHaveBeenCalledWith('req-42', actor);
  });

  it('createRequisition forwards (actor, dto)', async () => {
    const dto = {
      justification: 'because',
      lines: [
        {
          itemDescription: 'widget',
          quantity: 1,
          destinationModule: 'tech' as const,
        },
      ],
    };
    await c.controller.createRequisition(dto as never, req);
    expect(c.requisitions.create).toHaveBeenCalledWith(actor, dto);
  });

  it('addRequisitionLine forwards (actor, id, dto)', async () => {
    const dto = {
      itemDescription: 'extra item',
      quantity: 2,
      destinationModule: 'tech' as const,
    };
    await c.controller.addRequisitionLine('req-42', dto as never, req);
    expect(c.requisitions.addLine).toHaveBeenCalledWith(actor, 'req-42', dto);
  });

  it('removeRequisitionLine forwards (actor, lineId)', async () => {
    await c.controller.removeRequisitionLine('line-7', req);
    expect(c.requisitions.removeLine).toHaveBeenCalledWith(actor, 'line-7');
  });

  it('submitRequisition forwards (actor, id)', async () => {
    await c.controller.submitRequisition('req-42', req);
    expect(c.requisitions.submit).toHaveBeenCalledWith(actor, 'req-42');
  });

  it('approveRequisition forwards (actor, id, dto)', async () => {
    const dto = { toStatus: 'DEPT_APPROVED' as const };
    await c.controller.approveRequisition('req-42', dto, req);
    expect(c.requisitions.approve).toHaveBeenCalledWith(actor, 'req-42', dto);
  });

  it('rejectRequisition forwards (actor, id, dto)', async () => {
    const dto = { reason: 'out of scope' };
    await c.controller.rejectRequisition('req-42', dto, req);
    expect(c.requisitions.reject).toHaveBeenCalledWith(actor, 'req-42', dto);
  });
});

// ──────────────────────────────────────────────────────────────
// PO endpoints — argument forwarding (incl. the budgetLineId destructure)
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — purchase-order endpoint forwarding', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listPOs forwards { status, vendorId }', async () => {
    await c.controller.listPOs('ISSUED', 'vend-1');
    expect(c.purchaseOrders.list).toHaveBeenCalledWith({
      status: 'ISSUED',
      vendorId: 'vend-1',
    });
  });

  it('listPOs forwards undefined filters', async () => {
    await c.controller.listPOs();
    expect(c.purchaseOrders.list).toHaveBeenCalledWith({
      status: undefined,
      vendorId: undefined,
    });
  });

  it('getPO forwards id', async () => {
    await c.controller.getPO('po-42');
    expect(c.purchaseOrders.getById).toHaveBeenCalledWith('po-42');
  });

  it('createPO forwards (actor, dto)', async () => {
    const dto = {
      vendorId: 'vend-1',
      deliveryAddress: 'somewhere',
      lines: [
        {
          itemDescription: 'widget',
          quantityOrdered: 5,
          unitCost: 10,
          destinationModule: 'tech' as const,
        },
      ],
    };
    await c.controller.createPO(dto as never, req);
    expect(c.purchaseOrders.create).toHaveBeenCalledWith(actor, dto);
  });

  it('transitionPO destructures budgetLineId from dto + passes the rest', async () => {
    const dto = {
      action: 'ISSUE' as const,
      reason: 'go',
      budgetLineId: 'bl-1',
    };
    await c.controller.transitionPO('po-42', dto as never, req);
    expect(c.purchaseOrders.transition).toHaveBeenCalledWith(
      actor,
      'po-42',
      { action: 'ISSUE', reason: 'go' },
      'bl-1',
    );
  });

  it('transitionPO without budgetLineId passes undefined for the 4th arg', async () => {
    const dto = { action: 'ACKNOWLEDGE' as const };
    await c.controller.transitionPO('po-42', dto as never, req);
    expect(c.purchaseOrders.transition).toHaveBeenCalledWith(
      actor,
      'po-42',
      { action: 'ACKNOWLEDGE' },
      undefined,
    );
  });
});

// ──────────────────────────────────────────────────────────────
// Receipts
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — receipts', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listReceipts forwards poId', async () => {
    await c.controller.listReceipts('po-42');
    expect(c.receipts.listForPO).toHaveBeenCalledWith('po-42');
  });

  it('createReceipt forwards (actor, poId, dto)', async () => {
    const dto = {
      inspectionOutcome: 'ACCEPTED' as const,
      lines: [
        {
          poLineId: 'pol-1',
          quantityReceived: 5,
          quantityAccepted: 5,
          quantityRejected: 0,
          condition: 'GOOD' as const,
        },
      ],
    };
    await c.controller.createReceipt('po-42', dto, req);
    expect(c.receipts.create).toHaveBeenCalledWith(actor, 'po-42', dto);
  });
});

// ──────────────────────────────────────────────────────────────
// Distributions
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — distributions', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listDistributions forwards receiptId', async () => {
    await c.controller.listDistributions('rec-1');
    expect(c.distributions.listForReceipt).toHaveBeenCalledWith('rec-1');
  });

  it('createDistribution forwards (actor, receiptId, dto)', async () => {
    const dto = {
      destinationModule: 'tech' as const,
      lines: [
        {
          receiptLineId: 'rl-1',
          quantityDistributed: 5,
          itemDescription: 'thing',
        },
      ],
    };
    await c.controller.createDistribution('rec-1', dto, req);
    expect(c.distributions.create).toHaveBeenCalledWith(actor, 'rec-1', dto);
  });
});

// ──────────────────────────────────────────────────────────────
// Returns
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — returns', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listReturns forwards { status }', async () => {
    await c.controller.listReturns('INITIATED');
    expect(c.returns.listAll).toHaveBeenCalledWith({ status: 'INITIATED' });
  });

  it('listReturns forwards undefined status', async () => {
    await c.controller.listReturns();
    expect(c.returns.listAll).toHaveBeenCalledWith({ status: undefined });
  });

  it('getReturn forwards id', async () => {
    await c.controller.getReturn('ret-1');
    expect(c.returns.getById).toHaveBeenCalledWith('ret-1');
  });

  it('listReturnsForLine forwards receiptLineId', async () => {
    await c.controller.listReturnsForLine('rl-1');
    expect(c.returns.listForReceiptLine).toHaveBeenCalledWith('rl-1');
  });

  it('createReturn forwards (actor, receiptLineId, dto)', async () => {
    const dto = { returnType: 'DAMAGED' as const, quantityReturned: 2 };
    await c.controller.createReturn('rl-1', dto, req);
    expect(c.returns.create).toHaveBeenCalledWith(actor, 'rl-1', dto);
  });

  it('updateReturn forwards (actor, id, dto)', async () => {
    const dto = { action: 'SHIP' as const };
    await c.controller.updateReturn('ret-1', dto, req);
    expect(c.returns.update).toHaveBeenCalledWith(actor, 'ret-1', dto);
  });
});

// ──────────────────────────────────────────────────────────────
// Vendor Performance + Settings
// ──────────────────────────────────────────────────────────────
describe('ProcurementController — vendor performance + settings', () => {
  let c: ReturnType<typeof makeController>;
  beforeEach(() => {
    c = makeController();
  });

  it('listVendorPerformance calls service with no args', async () => {
    const out = await c.controller.listVendorPerformance();
    expect(c.vendorPerformance.list).toHaveBeenCalledWith();
    expect(out).toEqual([{ vendorId: 'v-1' }]);
  });

  it('getVendorPerformance forwards vendorId', async () => {
    await c.controller.getVendorPerformance('vend-1');
    expect(c.vendorPerformance.getForVendor).toHaveBeenCalledWith('vend-1');
  });

  it('getSettings calls service with no args', async () => {
    await c.controller.getSettings();
    expect(c.settings.get).toHaveBeenCalledWith();
  });

  it('updateSettings forwards (actor, dto)', async () => {
    const dto = { poNumberPrefix: 'TEST' };
    await c.controller.updateSettings(dto, req);
    expect(c.settings.update).toHaveBeenCalledWith(actor, dto);
  });
});
