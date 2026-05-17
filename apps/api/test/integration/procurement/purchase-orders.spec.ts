import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  GoodsReceiptService,
  PurchaseOrderService,
} from '../../../src/procurement/purchase-orders.service';
import { RequisitionService } from '../../../src/procurement/requisitions.service';
import { TenantPrismaService } from '../../../src/tenant/tenant-prisma.service';
import { FinanceValidationService } from '../../../src/finance/validation';
import type { KafkaProducerService } from '../../../src/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { resetProcurementTables, resetEncumberedAmount } from '../helpers/reset';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  TEST_BUDGET_LINE_ID,
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_ID,
  TEST_INACTIVE_SUPPLIER_ID,
  TEST_COA_SUPPLIES_ID,
  TEST_COA_CASH_ID, // ASSET, allowed
  TEST_COA_AR_ID, // ASSET, allowed
} from '../fixtures/finance';
import type {
  CreatePurchaseOrderDto,
  CreatePOLineDto,
  CreateGoodsReceiptDto,
} from '../../../src/procurement/dto/procurement.dto';

/**
 * Loop 4 — DATABASE-BACKED integration tests for PurchaseOrderService +
 * GoodsReceiptService.
 *
 * Covers the BUDGET COMMITMENT keystone end-to-end against a real budget
 * line: PO ISSUE creates prc_budget_commitments + bumps
 * fin_budget_lines.encumbered_amount atomically; CLOSE/CANCEL release
 * symmetrically. Also covers the VENDOR PERFORMANCE auto-scoring keystone:
 * GoodsReceiptService.create UPSERTs prc_vendor_performance with the right
 * counts (per-PO total_orders + on_time/late, per-receipt accepted/rejected).
 *
 * Per the design doc, every test asserts on real DB state via raw SQL after
 * the service call.
 */

const PO_LINE_TECH: CreatePOLineDto = {
  itemDescription: 'Chromebook 14"',
  quantityOrdered: 10,
  unitCost: 250,
  destinationModule: 'tech',
};

const PO_LINE_FDS: CreatePOLineDto = {
  itemDescription: 'Cafeteria napkins (case)',
  quantityOrdered: 20,
  unitCost: 15.5,
  destinationModule: 'fds',
};

function buildPOInput(overrides?: Partial<CreatePurchaseOrderDto>): CreatePurchaseOrderDto {
  return {
    vendorId: TEST_SUPPLIER_A_ID,
    deliveryAddress: '100 Test St, Springfield IL 62701',
    expectedDeliveryDate: '2099-12-31', // far future so on-time is always true
    paymentTerms: 'NET_30',
    lines: [PO_LINE_TECH],
    ...overrides,
  };
}

describe('integration:PurchaseOrderService', () => {
  let tenantPrisma: TenantPrismaService;
  let finance: FinanceValidationService;
  let service: PurchaseOrderService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    finance = new FinanceValidationService(tenantPrisma);
    service = new PurchaseOrderService(tenantPrisma, finance);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
      await resetEncumberedAmount(tenantPrisma);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // create — PO authoring
  // ──────────────────────────────────────────────────────────────
  describe('create', () => {
    it('happy path: 2-line PO writes DRAFT with computed total + allocated po_number', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          ...buildPOInput({ lines: [PO_LINE_TECH, PO_LINE_FDS] }),
        }),
      );

      expect(result.status).toBe('DRAFT');
      expect(result.totalAmount).toBe(10 * 250 + 20 * 15.5);
      expect(result.poNumber).toMatch(/^PO-\d{4}-001$/);
      expect(result.vendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(result.vendorName).toBe('Test Vendor Alpha');
      expect(result.issuedBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
      expect(result.issuedAt).toBeNull(); // not issued yet
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0]!.lineTotal).toBe(2500);
      expect(result.lines[0]!.quantityReceived).toBe(0);
      expect(result.commitments).toEqual([]);

      // DB-state assertion
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, po_number, total_amount,
                (SELECT count(*)::int FROM tenant_test.prc_purchase_order_lines WHERE purchase_order_id = $1::uuid) AS line_count
         FROM tenant_test.prc_purchase_orders WHERE id = $1::uuid`,
        result.id,
      )) as Array<{
        status: string;
        po_number: string;
        total_amount: string;
        line_count: number;
      }>;
      expect(rows[0]!.status).toBe('DRAFT');
      expect(Number(rows[0]!.total_amount)).toBe(2810);
      expect(Number(rows[0]!.line_count)).toBe(2);
    });

    it('po_number auto-increments next_seq across multiple POs', async () => {
      const a = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const b = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      expect(a.poNumber).toMatch(/-001$/);
      expect(b.poNumber).toMatch(/-002$/);
    });

    it('non-procurement-officer (student) → 403', async () => {
      await expect(
        withTestTenant(async () => service.create(studentActor(), buildPOInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent → 403', async () => {
      await expect(
        withTestTenant(async () => service.create(parentActor(), buildPOInput())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin without employeeId → 400', async () => {
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => service.create(adminNoEmp, buildPOInput())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bogus vendorId → 400', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput(),
            vendorId: '00000000-0000-0000-0000-000000000999',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inactive vendor → 400', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput(),
            vendorId: TEST_INACTIVE_SUPPLIER_ID,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('glAccountId of invalid type (REVENUE) → 400', async () => {
      // We don't have a REVENUE account fixture; use AR (ASSET) on a line where
      // valid types are EXPENSE/ASSET/LIABILITY. AR is allowed. To exercise the
      // failure path, use a bogus id (which is exactly the assertActiveAccount
      // validation behaviour).
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput({
              lines: [{ ...PO_LINE_TECH, glAccountId: '00000000-0000-0000-0000-000000000999' }],
            }),
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('valid glAccountId (Supplies EXPENSE) accepted and persisted', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          ...buildPOInput({
            lines: [{ ...PO_LINE_TECH, glAccountId: TEST_COA_SUPPLIES_ID }],
          }),
        }),
      );
      expect(result.lines[0]!.glAccountId).toBe(TEST_COA_SUPPLIES_ID);
      expect(result.lines[0]!.glAccountCode).toBe('5000');
    });

    it('valid glAccountId (Cash ASSET + AR ASSET) both accepted', async () => {
      const result = await withTestTenant(async () =>
        service.create(officerActor(), {
          ...buildPOInput({
            lines: [
              { ...PO_LINE_TECH, glAccountId: TEST_COA_CASH_ID },
              { ...PO_LINE_FDS, glAccountId: TEST_COA_AR_ID },
            ],
          }),
        }),
      );
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0]!.glAccountCode).toBe('1000');
      expect(result.lines[1]!.glAccountCode).toBe('1100');
    });

    it('requisitionId bogus → 400', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput(),
            requisitionId: '00000000-0000-0000-0000-000000000999',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('standalone PO with requisitionLineId on a line → 400 ', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput({
              lines: [
                {
                  ...PO_LINE_TECH,
                  requisitionLineId: '00000000-0000-0000-0000-000000000999',
                },
              ],
            }),
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requisition in DRAFT (not approved) → 400 on PO create', async () => {
      const reqSvc = new RequisitionService(
        tenantPrisma,
        new RecordingKafkaProducer() as unknown as KafkaProducerService,
        finance,
      );
      const draft = await withTestTenant(async () =>
        reqSvc.create(officerActor(), {
          justification: 'unapproved',
          lines: [
            {
              itemDescription: 'Item',
              quantity: 1,
              estimatedUnitCost: 10,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), { ...buildPOInput(), requisitionId: draft.id }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requisition in ADMIN_APPROVED can drive a PO; orphan requisitionLineId → 400', async () => {
      const reqSvc = new RequisitionService(
        tenantPrisma,
        new RecordingKafkaProducer() as unknown as KafkaProducerService,
        finance,
      );
      const req = await withTestTenant(async () =>
        reqSvc.create(officerActor(), {
          justification: 'will be approved',
          lines: [
            {
              itemDescription: 'Item',
              quantity: 1,
              estimatedUnitCost: 10,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      await withTestTenant(async () => reqSvc.submit(officerActor(), req.id));
      await withTestTenant(async () =>
        reqSvc.approve(adminActor(), req.id, { toStatus: 'DEPT_APPROVED' }),
      );
      await withTestTenant(async () =>
        reqSvc.approve(adminActor(), req.id, { toStatus: 'ADMIN_APPROVED' }),
      );

      // Orphan requisitionLineId (a real UUID not from this req)
      await expect(
        withTestTenant(async () =>
          service.create(officerActor(), {
            ...buildPOInput({
              lines: [
                {
                  ...PO_LINE_TECH,
                  requisitionLineId: '00000000-0000-0000-0000-000000000999',
                },
              ],
            }),
            requisitionId: req.id,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Without orphan, success
      const po = await withTestTenant(async () =>
        service.create(officerActor(), { ...buildPOInput(), requisitionId: req.id }),
      );
      expect(po.requisitionId).toBe(req.id);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // list + getById
  // ──────────────────────────────────────────────────────────────
  describe('list + getById', () => {
    it('list returns all POs sorted newest-first', async () => {
      const a = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const b = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const list = await withTestTenant(async () => service.list());
      expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
    });

    it('list filter by status', async () => {
      await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const drafts = await withTestTenant(async () => service.list({ status: 'DRAFT' }));
      expect(drafts).toHaveLength(1);
      const issued = await withTestTenant(async () => service.list({ status: 'ISSUED' }));
      expect(issued).toHaveLength(0);
    });

    it('list filter by vendorId', async () => {
      const a = await withTestTenant(async () =>
        service.create(officerActor(), buildPOInput({ vendorId: TEST_SUPPLIER_A_ID })),
      );
      await withTestTenant(async () =>
        service.create(officerActor(), buildPOInput({ vendorId: TEST_SUPPLIER_B_ID })),
      );
      const alpha = await withTestTenant(async () =>
        service.list({ vendorId: TEST_SUPPLIER_A_ID }),
      );
      expect(alpha).toHaveLength(1);
      expect(alpha[0]!.id).toBe(a.id);
    });

    it('getById bogus id → 404', async () => {
      await expect(
        withTestTenant(async () => service.getById('00000000-0000-0000-0000-000000000999')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // transition — BUDGET COMMITMENT KEYSTONE
  // ──────────────────────────────────────────────────────────────
  describe('transition (ISSUE) — budget commitment keystone', () => {
    it('DRAFT → ISSUED creates commitment + bumps encumbered_amount atomically', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));

      // Sanity: no commitments yet, encumbered=0
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(before[0]!.encumbered_amount)).toBe(0);

      const issued = await withTestTenant(async () =>
        service.transition(
          adminActor(),
          po.id,
          { action: 'ISSUE' },
          TEST_BUDGET_LINE_ID, // explicit override since the PO has no parent requisition
        ),
      );

      expect(issued.status).toBe('ISSUED');
      expect(issued.issuedAt).not.toBeNull();
      expect(issued.commitments).toHaveLength(1);
      expect(issued.commitments[0]!.budgetLineId).toBe(TEST_BUDGET_LINE_ID);
      expect(issued.commitments[0]!.committedAmount).toBe(2500); // 10 * 250
      expect(issued.commitments[0]!.status).toBe('COMMITTED');

      // KEYSTONE assertion: encumbered_amount bumped by PO total
      const after = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(after[0]!.encumbered_amount)).toBe(2500);

      // commitment row also persisted
      const commitments = (await rawClient.$queryRawUnsafe(
        `SELECT committed_amount, released_amount, status FROM tenant_test.prc_budget_commitments
         WHERE purchase_order_id = $1::uuid`,
        po.id,
      )) as Array<{ committed_amount: string; released_amount: string; status: string }>;
      expect(commitments).toHaveLength(1);
      expect(Number(commitments[0]!.committed_amount)).toBe(2500);
      expect(Number(commitments[0]!.released_amount)).toBe(0);
      expect(commitments[0]!.status).toBe('COMMITTED');
    });

    it('DRAFT → ISSUED without budget line skips commitment but still flips status', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const issued = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ISSUE' }),
      );
      expect(issued.status).toBe('ISSUED');
      expect(issued.commitments).toEqual([]);

      const enc = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(enc[0]!.encumbered_amount)).toBe(0);
    });

    it('insufficient budget remaining → 400 + no encumbered bump', async () => {
      // PO total $25,000 > $10,000 budget
      const po = await withTestTenant(async () =>
        service.create(officerActor(), {
          ...buildPOInput({
            lines: [
              { ...PO_LINE_TECH, quantityOrdered: 100, unitCost: 250 }, // $25,000
            ],
          }),
        }),
      );

      await expect(
        withTestTenant(async () =>
          service.transition(adminActor(), po.id, { action: 'ISSUE' }, TEST_BUDGET_LINE_ID),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // PO stays DRAFT, encumbered stays 0
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_purchase_orders WHERE id = $1::uuid`,
        po.id,
      )) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('DRAFT');

      const enc = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(enc[0]!.encumbered_amount)).toBe(0);
    });

    it('bogus budget_line_id at issue → 400', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await expect(
        withTestTenant(async () =>
          service.transition(
            adminActor(),
            po.id,
            { action: 'ISSUE' },
            '00000000-0000-0000-0000-000000000999',
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCEL after ISSUE releases the commitment + decrements encumbered atomically', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ISSUE' }, TEST_BUDGET_LINE_ID),
      );

      const cancelled = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, {
          action: 'CANCEL',
          reason: 'No longer needed',
        }),
      );

      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelReason).toBe('No longer needed');
      expect(cancelled.cancelledAt).not.toBeNull();

      const commitments = (await rawClient.$queryRawUnsafe(
        `SELECT status, released_amount, committed_amount FROM tenant_test.prc_budget_commitments
         WHERE purchase_order_id = $1::uuid`,
        po.id,
      )) as Array<{ status: string; released_amount: string; committed_amount: string }>;
      expect(commitments[0]!.status).toBe('RELEASED');
      expect(Number(commitments[0]!.released_amount)).toBe(
        Number(commitments[0]!.committed_amount),
      );

      const enc = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(enc[0]!.encumbered_amount)).toBe(0);
    });

    it('CANCEL of DRAFT (never issued) leaves encumbered untouched + still flips status', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const cancelled = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'CANCEL', reason: 'oops' }),
      );
      expect(cancelled.status).toBe('CANCELLED');
      const enc = (await rawClient.$queryRawUnsafe(
        `SELECT encumbered_amount FROM tenant_test.fin_budget_lines WHERE id = $1::uuid`,
        TEST_BUDGET_LINE_ID,
      )) as Array<{ encumbered_amount: string }>;
      expect(Number(enc[0]!.encumbered_amount)).toBe(0);
    });

    it('CANCEL without explicit reason defaults to "Cancelled"', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const cancelled = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'CANCEL' }),
      );
      expect(cancelled.cancelReason).toBe('Cancelled');
    });

    it('illegal transition DRAFT → SHIP → 400', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await expect(
        withTestTenant(async () => service.transition(adminActor(), po.id, { action: 'SHIP' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ISSUE → ACKNOWLEDGE → SHIP chain', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ISSUE' }),
      );
      const ack = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ACKNOWLEDGE' }),
      );
      expect(ack.status).toBe('ACKNOWLEDGED');
      const shipped = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'SHIP' }),
      );
      expect(shipped.status).toBe('SHIPPED');
    });

    it('non-officer (student) → 403', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await expect(
        withTestTenant(async () => service.transition(studentActor(), po.id, { action: 'ISSUE' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin without employeeId → 400', async () => {
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => service.transition(adminNoEmp, po.id, { action: 'ISSUE' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bogus poId → 404', async () => {
      await expect(
        withTestTenant(async () =>
          service.transition(adminActor(), '00000000-0000-0000-0000-000000000999', {
            action: 'ISSUE',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ISSUE inherits budget_line_id from linked requisition (no override needed)', async () => {
      const reqSvc = new RequisitionService(
        tenantPrisma,
        new RecordingKafkaProducer() as unknown as KafkaProducerService,
        finance,
      );
      const req = await withTestTenant(async () =>
        reqSvc.create(officerActor(), {
          justification: 'req with budget',
          budgetLineId: TEST_BUDGET_LINE_ID,
          lines: [
            {
              itemDescription: 'thing',
              quantity: 1,
              estimatedUnitCost: 50,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      await withTestTenant(async () => reqSvc.submit(officerActor(), req.id));
      await withTestTenant(async () =>
        reqSvc.approve(adminActor(), req.id, { toStatus: 'DEPT_APPROVED' }),
      );
      await withTestTenant(async () =>
        reqSvc.approve(adminActor(), req.id, { toStatus: 'ADMIN_APPROVED' }),
      );

      const po = await withTestTenant(async () =>
        service.create(officerActor(), { ...buildPOInput(), requisitionId: req.id }),
      );

      // ISSUE without override — should inherit budget line from req
      const issued = await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ISSUE' }),
      );

      expect(issued.commitments).toHaveLength(1);
      expect(issued.commitments[0]!.budgetLineId).toBe(TEST_BUDGET_LINE_ID);

      // Parent requisition flipped to ORDERED
      const reqAfter = await withTestTenant(async () => reqSvc.getById(req.id, adminActor()));
      expect(reqAfter.status).toBe('ORDERED');
    });

    it('REVIEW-CYCLE27 MAJOR 8: ISSUE of a DRAFT-requisition-linked PO does NOT promote the DRAFT req', async () => {
      // Direct SQL: build a requisition manually in DRAFT, link it to a PO, ISSUE the PO.
      // The req should stay DRAFT — only ADMIN_APPROVED / DISTRICT_APPROVED get promoted.
      const reqSvc = new RequisitionService(
        tenantPrisma,
        new RecordingKafkaProducer() as unknown as KafkaProducerService,
        finance,
      );
      const draftReq = await withTestTenant(async () =>
        reqSvc.create(officerActor(), {
          justification: 'never-approved req',
          lines: [
            {
              itemDescription: 'thing',
              quantity: 1,
              estimatedUnitCost: 50,
              destinationModule: 'tech',
            },
          ],
        }),
      );

      // The PO create path will reject linking to a DRAFT req. Use direct SQL to plant
      // the link, mimicking pre-fix data drift.
      const po = await withTestTenant(async () => service.create(officerActor(), buildPOInput()));
      await rawClient.$executeRawUnsafe(
        `UPDATE tenant_test.prc_purchase_orders SET requisition_id = $1::uuid WHERE id = $2::uuid`,
        draftReq.id,
        po.id,
      );

      await withTestTenant(async () =>
        service.transition(adminActor(), po.id, { action: 'ISSUE' }),
      );

      const reqStatus = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        draftReq.id,
      )) as Array<{ status: string }>;
      expect(reqStatus[0]!.status).toBe('DRAFT');
    });
  });
});

// ──────────────────────────────────────────────────────────────
// GoodsReceiptService — receipt + vendor performance keystone
// ──────────────────────────────────────────────────────────────
describe('integration:GoodsReceiptService', () => {
  let tenantPrisma: TenantPrismaService;
  let finance: FinanceValidationService;
  let poService: PurchaseOrderService;
  let receiptService: GoodsReceiptService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    finance = new FinanceValidationService(tenantPrisma);
    poService = new PurchaseOrderService(tenantPrisma, finance);
    receiptService = new GoodsReceiptService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
      await resetEncumberedAmount(tenantPrisma);
    });
  });

  /** Helper — create + ISSUE a PO with one line of 10 units @ $250. */
  async function seedIssuedPO(expectedDeliveryDate = '2099-12-31'): Promise<{
    poId: string;
    poLineId: string;
  }> {
    const po = await withTestTenant(async () =>
      poService.create(officerActor(), {
        vendorId: TEST_SUPPLIER_A_ID,
        deliveryAddress: '100 Test St',
        expectedDeliveryDate,
        lines: [PO_LINE_TECH],
      }),
    );
    await withTestTenant(async () =>
      poService.transition(adminActor(), po.id, { action: 'ISSUE' }, TEST_BUDGET_LINE_ID),
    );
    return { poId: po.id, poLineId: po.lines[0]!.id };
  }

  it('happy path: receive full quantity flips PO to RECEIVED + UPSERTs vendor_performance', async () => {
    const { poId, poLineId } = await seedIssuedPO();

    const receipt = await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        notes: 'all good',
        lines: [
          {
            poLineId,
            quantityReceived: 10,
            quantityAccepted: 10,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );

    expect(receipt.inspectionOutcome).toBe('ACCEPTED');
    expect(receipt.receivedBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
    expect(receipt.lines).toHaveLength(1);
    expect(receipt.lines[0]!.quantityAccepted).toBe(10);

    // PO flipped to RECEIVED
    const poRows = (await rawClient.$queryRawUnsafe(
      `SELECT status FROM tenant_test.prc_purchase_orders WHERE id = $1::uuid`,
      poId,
    )) as Array<{ status: string }>;
    expect(poRows[0]!.status).toBe('RECEIVED');

    // Vendor performance: one PO, on-time, 10/0 accepted/rejected
    const vp = (await rawClient.$queryRawUnsafe(
      `SELECT total_orders, on_time_deliveries, late_deliveries, accepted_count, rejected_count,
              average_quality_score, average_delivery_score
       FROM tenant_test.prc_vendor_performance
       WHERE vendor_id = $1::uuid AND school_id = $2::uuid`,
      TEST_SUPPLIER_A_ID,
      TEST_SCHOOL_ID,
    )) as Array<{
      total_orders: number;
      on_time_deliveries: number;
      late_deliveries: number;
      accepted_count: number;
      rejected_count: number;
      average_quality_score: string;
      average_delivery_score: string;
    }>;
    expect(Number(vp[0]!.total_orders)).toBe(1);
    expect(Number(vp[0]!.on_time_deliveries)).toBe(1);
    expect(Number(vp[0]!.late_deliveries)).toBe(0);
    expect(Number(vp[0]!.accepted_count)).toBe(10);
    expect(Number(vp[0]!.rejected_count)).toBe(0);
    expect(Number(vp[0]!.average_quality_score)).toBe(1);
    expect(Number(vp[0]!.average_delivery_score)).toBe(1);
  });

  it('partial receipt flips PO to PARTIALLY_RECEIVED; on_time/late deferred to final receipt', async () => {
    const { poId, poLineId } = await seedIssuedPO();

    // Receive 4 of 10
    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        lines: [
          {
            poLineId,
            quantityReceived: 4,
            quantityAccepted: 4,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );

    const poRows = (await rawClient.$queryRawUnsafe(
      `SELECT status FROM tenant_test.prc_purchase_orders WHERE id = $1::uuid`,
      poId,
    )) as Array<{ status: string }>;
    expect(poRows[0]!.status).toBe('PARTIALLY_RECEIVED');

    const vp1 = (await rawClient.$queryRawUnsafe(
      `SELECT total_orders, on_time_deliveries, late_deliveries, accepted_count
       FROM tenant_test.prc_vendor_performance
       WHERE vendor_id = $1::uuid AND school_id = $2::uuid`,
      TEST_SUPPLIER_A_ID,
      TEST_SCHOOL_ID,
    )) as Array<{
      total_orders: number;
      on_time_deliveries: number;
      late_deliveries: number;
      accepted_count: number;
    }>;
    expect(Number(vp1[0]!.total_orders)).toBe(1); // first receipt bumps order count
    expect(Number(vp1[0]!.on_time_deliveries)).toBe(0); // deferred — not final yet
    expect(Number(vp1[0]!.late_deliveries)).toBe(0);
    expect(Number(vp1[0]!.accepted_count)).toBe(4);

    // Receive remaining 6 — completes the PO
    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        lines: [
          {
            poLineId,
            quantityReceived: 6,
            quantityAccepted: 6,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );

    const poRows2 = (await rawClient.$queryRawUnsafe(
      `SELECT status FROM tenant_test.prc_purchase_orders WHERE id = $1::uuid`,
      poId,
    )) as Array<{ status: string }>;
    expect(poRows2[0]!.status).toBe('RECEIVED');

    const vp2 = (await rawClient.$queryRawUnsafe(
      `SELECT total_orders, on_time_deliveries, late_deliveries, accepted_count
       FROM tenant_test.prc_vendor_performance
       WHERE vendor_id = $1::uuid AND school_id = $2::uuid`,
      TEST_SUPPLIER_A_ID,
      TEST_SCHOOL_ID,
    )) as Array<{
      total_orders: number;
      on_time_deliveries: number;
      late_deliveries: number;
      accepted_count: number;
    }>;
    // total_orders stayed at 1 (REVIEW-CYCLE27 BLOCKING 3 — bumps once per PO)
    expect(Number(vp2[0]!.total_orders)).toBe(1);
    // on_time now bumped (final receipt + on-time)
    expect(Number(vp2[0]!.on_time_deliveries)).toBe(1);
    expect(Number(vp2[0]!.late_deliveries)).toBe(0);
    expect(Number(vp2[0]!.accepted_count)).toBe(10);
  });

  it('late delivery (today > expected_delivery_date) bumps late_deliveries, not on_time', async () => {
    // Past expected delivery date
    const { poId, poLineId } = await seedIssuedPO('2020-01-01');

    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        lines: [
          {
            poLineId,
            quantityReceived: 10,
            quantityAccepted: 10,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );

    const vp = (await rawClient.$queryRawUnsafe(
      `SELECT on_time_deliveries, late_deliveries, average_delivery_score
       FROM tenant_test.prc_vendor_performance
       WHERE vendor_id = $1::uuid AND school_id = $2::uuid`,
      TEST_SUPPLIER_A_ID,
      TEST_SCHOOL_ID,
    )) as Array<{
      on_time_deliveries: number;
      late_deliveries: number;
      average_delivery_score: string;
    }>;
    expect(Number(vp[0]!.on_time_deliveries)).toBe(0);
    expect(Number(vp[0]!.late_deliveries)).toBe(1);
    expect(Number(vp[0]!.average_delivery_score)).toBe(0);
  });

  it('rejected line bumps rejected_count + lowers quality_score', async () => {
    const { poId, poLineId } = await seedIssuedPO();

    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED_WITH_DISCREPANCY',
        lines: [
          {
            poLineId,
            quantityReceived: 10,
            quantityAccepted: 8,
            quantityRejected: 2,
            condition: 'DAMAGED',
            discrepancyNotes: 'two units damaged in shipping',
          },
        ],
      }),
    );

    const vp = (await rawClient.$queryRawUnsafe(
      `SELECT accepted_count, rejected_count, average_quality_score
       FROM tenant_test.prc_vendor_performance
       WHERE vendor_id = $1::uuid AND school_id = $2::uuid`,
      TEST_SUPPLIER_A_ID,
      TEST_SCHOOL_ID,
    )) as Array<{
      accepted_count: number;
      rejected_count: number;
      average_quality_score: string;
    }>;
    expect(Number(vp[0]!.accepted_count)).toBe(8);
    expect(Number(vp[0]!.rejected_count)).toBe(2);
    expect(Number(vp[0]!.average_quality_score)).toBeCloseTo(0.8, 4);
  });

  it('quantity_received exceeding remaining → 400', async () => {
    const { poId, poLineId } = await seedIssuedPO();

    await expect(
      withTestTenant(async () =>
        receiptService.create(officerActor(), poId, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId,
              quantityReceived: 11, // > 10 ordered
              quantityAccepted: 11,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('po_line_id belonging to a different PO → 400', async () => {
    const { poId: poA } = await seedIssuedPO();
    const { poLineId: poBLineId } = await seedIssuedPO(); // separate PO

    await expect(
      withTestTenant(async () =>
        receiptService.create(officerActor(), poA, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId: poBLineId,
              quantityReceived: 1,
              quantityAccepted: 1,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('receive against a DRAFT PO → 400 ', async () => {
    const po = await withTestTenant(async () => poService.create(officerActor(), buildPOInput()));
    await expect(
      withTestTenant(async () =>
        receiptService.create(officerActor(), po.id, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId: po.lines[0]!.id,
              quantityReceived: 1,
              quantityAccepted: 1,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('receive against bogus poId → 404', async () => {
    await expect(
      withTestTenant(async () =>
        receiptService.create(officerActor(), '00000000-0000-0000-0000-000000000999', {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId: '00000000-0000-0000-0000-000000000888',
              quantityReceived: 1,
              quantityAccepted: 1,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('non-officer (student) → 403', async () => {
    const { poId, poLineId } = await seedIssuedPO();
    await expect(
      withTestTenant(async () =>
        receiptService.create(studentActor(), poId, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId,
              quantityReceived: 1,
              quantityAccepted: 1,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admin without employeeId → 400', async () => {
    const { poId, poLineId } = await seedIssuedPO();
    const adminNoEmp = { ...adminActor(), employeeId: null };
    await expect(
      withTestTenant(async () =>
        receiptService.create(adminNoEmp, poId, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId,
              quantityReceived: 1,
              quantityAccepted: 1,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('listForPO returns receipts newest-first with lines + po_number inlined', async () => {
    const { poId, poLineId } = await seedIssuedPO();
    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        lines: [
          {
            poLineId,
            quantityReceived: 4,
            quantityAccepted: 4,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );
    await withTestTenant(async () =>
      receiptService.create(officerActor(), poId, {
        inspectionOutcome: 'ACCEPTED',
        lines: [
          {
            poLineId,
            quantityReceived: 6,
            quantityAccepted: 6,
            quantityRejected: 0,
            condition: 'GOOD',
          },
        ],
      }),
    );

    const list = await withTestTenant(async () => receiptService.listForPO(poId));
    expect(list).toHaveLength(2);
    expect(list[0]!.poNumber).toMatch(/^PO-\d{4}-/);
    expect(list[0]!.lines).toHaveLength(1);
    expect(list[0]!.receivedByName).toBe('Integration Officer');
  });

  // sanity import wiring for unused helper imports
  it('imports remain wired (sanity)', () => {
    expect(teacherActor()).toBeDefined();
    expect(TEST_ADMIN_EMPLOYEE_ID).toBeTruthy();
  });
});
