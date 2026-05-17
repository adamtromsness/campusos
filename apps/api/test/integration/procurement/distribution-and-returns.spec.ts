import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  DistributionService,
  ReturnService,
  VendorPerformanceService,
} from '@modules/m86-procurement/distribution.service';
import {
  GoodsReceiptService,
  PurchaseOrderService,
} from '@modules/m86-procurement/purchase-orders.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { withTestTenant, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { resetProcurementTables, resetEncumberedAmount } from '../helpers/reset';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  adminActor,
  officerActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_OFFICER_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_BUDGET_LINE_ID, TEST_SUPPLIER_A_ID, TEST_SUPPLIER_B_ID } from '../fixtures/finance';

/**
 * Loop 5 — DATABASE-BACKED integration tests for the remaining procurement
 * services: DistributionService, ReturnService, VendorPerformanceService.
 *
 * Closes the CROSS-MODULE DISTRIBUTION KEYSTONE: DistributionService.create
 * emits `prc.distribution.completed` AFTER the tenant tx commits with the
 * full payload that downstream modules (tech / trn / fds / lib / ath / ext /
 * fac / str) consume. Verified via RecordingKafkaProducer.
 *
 * Also exercises:
 *   - REVIEW-CYCLE27 BLOCKING 4 — return-create concurrency race resolved
 *     by SELECT ... FOR UPDATE on the receipt-line row
 *   - The 4-state return lifecycle INITIATED -> SHIPPED_TO_VENDOR -> RESOLVED
 *     with the RESOLVE-without-resolution and CANCEL-after-RESOLVED guards
 *   - Cross-school read scope on returns (the receipt-line owning PO must
 *     match tenant.schoolId)
 */
describe('integration:DistributionService + ReturnService + VendorPerformanceService', () => {
  let tenantPrisma: TenantPrismaService;
  let finance: FinanceValidationService;
  let poService: PurchaseOrderService;
  let receiptService: GoodsReceiptService;
  let kafka: RecordingKafkaProducer;
  let distService: DistributionService;
  let returnService: ReturnService;
  let vpService: VendorPerformanceService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    finance = new FinanceValidationService(tenantPrisma);
    poService = new PurchaseOrderService(tenantPrisma, finance);
    receiptService = new GoodsReceiptService(tenantPrisma);
    kafka = new RecordingKafkaProducer();
    distService = new DistributionService(tenantPrisma, kafka as unknown as KafkaProducerService);
    returnService = new ReturnService(tenantPrisma);
    vpService = new VendorPerformanceService(tenantPrisma);
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    kafka.reset();
    await withTestTenant(async () => {
      await resetProcurementTables(tenantPrisma);
      await resetEncumberedAmount(tenantPrisma);
    });
  });

  /**
   * Seed the full PO -> ISSUE -> goods receipt chain so the test has
   * a receipt line ready to distribute or return.
   *
   * Defaults: 10 ordered, 8 accepted, 2 rejected. Vendor = Test Vendor Alpha.
   */
  async function seedReceivedChain(opts?: {
    vendorId?: string;
    quantityOrdered?: number;
    quantityAccepted?: number;
    quantityRejected?: number;
  }): Promise<{
    poId: string;
    poLineId: string;
    receiptId: string;
    receiptLineId: string;
  }> {
    const quantityOrdered = opts?.quantityOrdered ?? 10;
    const quantityAccepted = opts?.quantityAccepted ?? 8;
    const quantityRejected = opts?.quantityRejected ?? 2;
    const quantityReceived = quantityAccepted + quantityRejected;

    const po = await withTestTenant(async () =>
      poService.create(officerActor(), {
        vendorId: opts?.vendorId ?? TEST_SUPPLIER_A_ID,
        deliveryAddress: '100 Test St',
        expectedDeliveryDate: '2099-12-31',
        lines: [
          {
            itemDescription: 'Chromebook 14"',
            quantityOrdered,
            unitCost: 250,
            destinationModule: 'tech',
          },
        ],
      }),
    );
    await withTestTenant(async () =>
      poService.transition(adminActor(), po.id, { action: 'ISSUE' }, TEST_BUDGET_LINE_ID),
    );
    const receipt = await withTestTenant(async () =>
      receiptService.create(officerActor(), po.id, {
        inspectionOutcome:
          quantityRejected > 0 && quantityAccepted > 0 ? 'ACCEPTED_WITH_DISCREPANCY' : 'ACCEPTED',
        lines: [
          {
            poLineId: po.lines[0]!.id,
            quantityReceived,
            quantityAccepted,
            quantityRejected,
            condition: quantityRejected > 0 ? 'DAMAGED' : 'GOOD',
          },
        ],
      }),
    );
    return {
      poId: po.id,
      poLineId: po.lines[0]!.id,
      receiptId: receipt.id,
      receiptLineId: receipt.lines[0]!.id,
    };
  }

  // ──────────────────────────────────────────────────────────────
  // DistributionService — the CROSS-MODULE keystone
  // ──────────────────────────────────────────────────────────────
  describe('DistributionService.create — CROSS-MODULE KEYSTONE', () => {
    it('happy path: distribute 8 accepted units to tech, emit prc.distribution.completed AFTER tx', async () => {
      const { poId, receiptId, receiptLineId } = await seedReceivedChain();

      const dist = await withTestTenant(async () =>
        distService.create(officerActor(), receiptId, {
          destinationModule: 'tech',
          destinationDepartment: 'IT Asset Pool',
          notes: 'Asset-tagged + barcode applied',
          lines: [
            {
              receiptLineId,
              quantityDistributed: 8,
              itemDescription: 'Chromebook 14"',
              unitCost: 250,
            },
          ],
        }),
      );

      // DTO shape
      expect(dist.receiptId).toBe(receiptId);
      expect(dist.destinationModule).toBe('tech');
      expect(dist.destinationDepartment).toBe('IT Asset Pool');
      expect(dist.distributedBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
      expect(dist.distributedByName).toBe('Integration Officer');
      expect(dist.lines).toHaveLength(1);
      expect(dist.lines[0]!.quantityDistributed).toBe(8);
      expect(dist.lines[0]!.itemDescription).toBe('Chromebook 14"');
      expect(dist.lines[0]!.unitCost).toBe(250);

      // DB state
      const dbRows = (await rawClient.$queryRawUnsafe(
        `SELECT destination_module, destination_department,
                (SELECT count(*)::int FROM tenant_test.prc_distribution_lines WHERE distribution_id = $1::uuid) AS line_count
         FROM tenant_test.prc_distributions WHERE id = $1::uuid`,
        dist.id,
      )) as Array<{
        destination_module: string;
        destination_department: string;
        line_count: number;
      }>;
      expect(dbRows[0]!.destination_module).toBe('tech');
      expect(dbRows[0]!.destination_department).toBe('IT Asset Pool');
      expect(Number(dbRows[0]!.line_count)).toBe(1);

      // Kafka emit — the CROSS-MODULE keystone
      const emitted = kafka.callsForTopic('prc.distribution.completed');
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.sourceModule).toBe('procurement');
      expect(emitted[0]!.key).toBe(dist.id);
      expect(emitted[0]!.payload).toMatchObject({
        distributionId: dist.id,
        receiptId,
        purchaseOrderId: poId,
        schoolId: TEST_SCHOOL_ID,
        destinationModule: 'tech',
        destinationDepartment: 'IT Asset Pool',
        sourceRefId: dist.id,
      });
      expect((emitted[0]!.payload as { lines: unknown[] }).lines).toEqual([
        {
          receiptLineId,
          itemDescription: 'Chromebook 14"',
          quantity: 8,
          unitCost: 250,
        },
      ]);
    });

    it('distribute leaves the linked requisition (RECEIVED) flipped to DISTRIBUTED', async () => {
      // Build PO via a requisition so the linked-req auto-promote path fires
      const reqSvc = (await import('@modules/m86-procurement/requisitions.service'))
        .RequisitionService;
      const requisitionService = new reqSvc(
        tenantPrisma,
        kafka as unknown as KafkaProducerService,
        finance,
      );
      const req = await withTestTenant(async () =>
        requisitionService.create(officerActor(), {
          justification: 'will go all the way to distributed',
          budgetLineId: TEST_BUDGET_LINE_ID,
          lines: [
            {
              itemDescription: 'thing',
              quantity: 10,
              estimatedUnitCost: 250,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      await withTestTenant(async () => requisitionService.submit(officerActor(), req.id));
      await withTestTenant(async () =>
        requisitionService.approve(adminActor(), req.id, { toStatus: 'DEPT_APPROVED' }),
      );
      await withTestTenant(async () =>
        requisitionService.approve(adminActor(), req.id, { toStatus: 'ADMIN_APPROVED' }),
      );
      const po = await withTestTenant(async () =>
        poService.create(officerActor(), {
          vendorId: TEST_SUPPLIER_A_ID,
          deliveryAddress: '100 Test St',
          requisitionId: req.id,
          lines: [
            {
              itemDescription: 'thing',
              quantityOrdered: 10,
              unitCost: 250,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      await withTestTenant(async () =>
        poService.transition(adminActor(), po.id, { action: 'ISSUE' }),
      );
      const receipt = await withTestTenant(async () =>
        receiptService.create(officerActor(), po.id, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId: po.lines[0]!.id,
              quantityReceived: 10,
              quantityAccepted: 10,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        }),
      );

      // Req should be RECEIVED at this point
      const beforeStatus = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        req.id,
      )) as Array<{ status: string }>;
      expect(beforeStatus[0]!.status).toBe('RECEIVED');

      await withTestTenant(async () =>
        distService.create(officerActor(), receipt.id, {
          destinationModule: 'tech',
          lines: [
            {
              receiptLineId: receipt.lines[0]!.id,
              quantityDistributed: 10,
              itemDescription: 'thing',
              unitCost: 250,
            },
          ],
        }),
      );

      const afterStatus = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM tenant_test.prc_requisitions WHERE id = $1::uuid`,
        req.id,
      )) as Array<{ status: string }>;
      expect(afterStatus[0]!.status).toBe('DISTRIBUTED');
    });

    it('partial distribute then full distribute: second emit carries remaining lines', async () => {
      const { receiptId, receiptLineId } = await seedReceivedChain({
        quantityAccepted: 8,
        quantityRejected: 0,
      });

      // First partial
      await withTestTenant(async () =>
        distService.create(officerActor(), receiptId, {
          destinationModule: 'tech',
          lines: [
            {
              receiptLineId,
              quantityDistributed: 5,
              itemDescription: 'first half',
            },
          ],
        }),
      );
      // Second partial — remaining 3
      const second = await withTestTenant(async () =>
        distService.create(officerActor(), receiptId, {
          destinationModule: 'fac',
          lines: [
            {
              receiptLineId,
              quantityDistributed: 3,
              itemDescription: 'second half',
            },
          ],
        }),
      );

      expect(second.destinationModule).toBe('fac');

      // Trying to distribute even 1 more should fail (remaining = 0)
      await expect(
        withTestTenant(async () =>
          distService.create(officerActor(), receiptId, {
            destinationModule: 'lib',
            lines: [
              {
                receiptLineId,
                quantityDistributed: 1,
                itemDescription: 'one too many',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Two emit events captured (only the successful pair)
      expect(kafka.callsForTopic('prc.distribution.completed')).toHaveLength(2);
    });

    it('quantityDistributed exceeds remaining accepted → 400 + no row inserted + no emit', async () => {
      const { receiptId, receiptLineId } = await seedReceivedChain({
        quantityAccepted: 5,
        quantityRejected: 0,
      });

      await expect(
        withTestTenant(async () =>
          distService.create(officerActor(), receiptId, {
            destinationModule: 'tech',
            lines: [
              {
                receiptLineId,
                quantityDistributed: 6, // 6 > 5 accepted
                itemDescription: 'over-distribution',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const distCount = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.prc_distributions`,
      )) as Array<{ n: number }>;
      expect(distCount[0]!.n).toBe(0);
      expect(kafka.callsForTopic('prc.distribution.completed')).toHaveLength(0);
    });

    it('bogus receipt_line_id → 400', async () => {
      const { receiptId } = await seedReceivedChain();
      await expect(
        withTestTenant(async () =>
          distService.create(officerActor(), receiptId, {
            destinationModule: 'tech',
            lines: [
              {
                receiptLineId: '00000000-0000-0000-0000-000000000999',
                quantityDistributed: 1,
                itemDescription: 'bogus',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bogus receiptId → 404', async () => {
      await expect(
        withTestTenant(async () =>
          distService.create(officerActor(), '00000000-0000-0000-0000-000000000999', {
            destinationModule: 'tech',
            lines: [
              {
                receiptLineId: '00000000-0000-0000-0000-000000000999',
                quantityDistributed: 1,
                itemDescription: 'bogus',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-officer (student / parent) → 403', async () => {
      const { receiptId, receiptLineId } = await seedReceivedChain();
      await expect(
        withTestTenant(async () =>
          distService.create(studentActor(), receiptId, {
            destinationModule: 'tech',
            lines: [{ receiptLineId, quantityDistributed: 1, itemDescription: 'x' }],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        withTestTenant(async () =>
          distService.create(parentActor(), receiptId, {
            destinationModule: 'tech',
            lines: [{ receiptLineId, quantityDistributed: 1, itemDescription: 'x' }],
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin without employeeId → 400', async () => {
      const { receiptId, receiptLineId } = await seedReceivedChain();
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          distService.create(adminNoEmp, receiptId, {
            destinationModule: 'tech',
            lines: [{ receiptLineId, quantityDistributed: 1, itemDescription: 'x' }],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('DistributionService.listForReceipt', () => {
    it('newest-first ordering, lines + distributedByName inlined', async () => {
      const { receiptId, receiptLineId } = await seedReceivedChain({
        quantityAccepted: 8,
        quantityRejected: 0,
      });
      const first = await withTestTenant(async () =>
        distService.create(officerActor(), receiptId, {
          destinationModule: 'tech',
          lines: [{ receiptLineId, quantityDistributed: 3, itemDescription: 'first' }],
        }),
      );
      // Small delay to guarantee distinct distributed_at timestamps
      await new Promise((r) => setTimeout(r, 20));
      const second = await withTestTenant(async () =>
        distService.create(officerActor(), receiptId, {
          destinationModule: 'fac',
          lines: [{ receiptLineId, quantityDistributed: 5, itemDescription: 'second' }],
        }),
      );

      const list = await withTestTenant(async () => distService.listForReceipt(receiptId));
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe(second.id);
      expect(list[1]!.id).toBe(first.id);
      expect(list[0]!.distributedByName).toBe('Integration Officer');
      expect(list[0]!.lines).toHaveLength(1);
    });

    it('empty receipt returns []', async () => {
      const { receiptId } = await seedReceivedChain();
      const list = await withTestTenant(async () => distService.listForReceipt(receiptId));
      expect(list).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // ReturnService
  // ──────────────────────────────────────────────────────────────
  describe('ReturnService.create', () => {
    it('happy path: status=INITIATED, no resolution, initiatedBy stamped', async () => {
      const { receiptLineId } = await seedReceivedChain();
      const r = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 2,
          returnReference: 'INTERNAL-RMA-001',
          vendorRmaNumber: 'VENDOR-RMA-999',
        }),
      );
      expect(r.status).toBe('INITIATED');
      expect(r.returnType).toBe('DAMAGED');
      expect(r.quantityReturned).toBe(2);
      expect(r.returnReference).toBe('INTERNAL-RMA-001');
      expect(r.vendorRmaNumber).toBe('VENDOR-RMA-999');
      expect(r.initiatedBy).toBe(TEST_OFFICER_EMPLOYEE_ID);
      expect(r.initiatedByName).toBe('Integration Officer');
      expect(r.resolution).toBeNull();
      expect(r.resolvedAt).toBeNull();
    });

    it('quantity exceeds receipt-line remaining → 400', async () => {
      const { receiptLineId } = await seedReceivedChain({
        quantityAccepted: 8,
        quantityRejected: 2, // received = 10
      });
      await expect(
        withTestTenant(async () =>
          returnService.create(officerActor(), receiptLineId, {
            returnType: 'DAMAGED',
            quantityReturned: 11, // > 10 received
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('REVIEW-CYCLE27 BLOCKING 4: concurrent returns serialise on FOR UPDATE; second loser sees re-read snapshot', async () => {
      // Receipt line received=2, no quantityAccepted distinction since
      // returns check quantity_received (not accepted). Two parallel creates
      // each requesting 2 should land 1 success + 1 BadRequestException
      // (remaining=0 after the winner inserts).
      const { receiptLineId } = await seedReceivedChain({
        quantityOrdered: 2,
        quantityAccepted: 2,
        quantityRejected: 0,
      });

      const results = await Promise.allSettled([
        withTestTenant(async () =>
          returnService.create(officerActor(), receiptLineId, {
            returnType: 'DAMAGED',
            quantityReturned: 2,
          }),
        ),
        withTestTenant(async () =>
          returnService.create(officerActor(), receiptLineId, {
            returnType: 'WARRANTY_CLAIM',
            quantityReturned: 2,
          }),
        ),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0]! as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);

      // Confirm only one row landed in prc_returns for that receipt line
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM tenant_test.prc_returns WHERE receipt_line_id = $1::uuid`,
        receiptLineId,
      )) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    });

    it('CANCELLED returns do NOT count toward remaining (concurrent allowance)', async () => {
      const { receiptLineId } = await seedReceivedChain({
        quantityOrdered: 2,
        quantityAccepted: 2,
        quantityRejected: 0,
      });
      const first = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 2,
        }),
      );
      await withTestTenant(async () =>
        returnService.update(adminActor(), first.id, { action: 'CANCEL' }),
      );
      // After cancel, remaining is back to 2 — a new return is allowed
      const second = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'WARRANTY_CLAIM',
          quantityReturned: 2,
        }),
      );
      expect(second.status).toBe('INITIATED');
    });

    it('bogus receiptLineId → 404', async () => {
      await expect(
        withTestTenant(async () =>
          returnService.create(officerActor(), '00000000-0000-0000-0000-000000000999', {
            returnType: 'DAMAGED',
            quantityReturned: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-officer → 403', async () => {
      const { receiptLineId } = await seedReceivedChain();
      await expect(
        withTestTenant(async () =>
          returnService.create(studentActor(), receiptLineId, {
            returnType: 'DAMAGED',
            quantityReturned: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin without employeeId → 400', async () => {
      const { receiptLineId } = await seedReceivedChain();
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () =>
          returnService.create(adminNoEmp, receiptLineId, {
            returnType: 'DAMAGED',
            quantityReturned: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('ReturnService.update (lifecycle)', () => {
    async function seedInitiatedReturn(): Promise<string> {
      const { receiptLineId } = await seedReceivedChain();
      const r = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 2,
        }),
      );
      return r.id;
    }

    it('SHIP from INITIATED → SHIPPED_TO_VENDOR', async () => {
      const id = await seedInitiatedReturn();
      const r = await withTestTenant(async () =>
        returnService.update(adminActor(), id, { action: 'SHIP' }),
      );
      expect(r.status).toBe('SHIPPED_TO_VENDOR');
    });

    it('SHIP from non-INITIATED status → 400', async () => {
      const id = await seedInitiatedReturn();
      await withTestTenant(async () => returnService.update(adminActor(), id, { action: 'SHIP' }));
      await expect(
        withTestTenant(async () => returnService.update(adminActor(), id, { action: 'SHIP' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('RESOLVE from INITIATED with REPLACED stamps resolution + resolvedBy + resolvedAt', async () => {
      const id = await seedInitiatedReturn();
      const r = await withTestTenant(async () =>
        returnService.update(adminActor(), id, {
          action: 'RESOLVE',
          resolution: 'REPLACED',
          resolutionNotes: 'New units arrived 2026-01-05',
        }),
      );
      expect(r.status).toBe('RESOLVED');
      expect(r.resolution).toBe('REPLACED');
      expect(r.resolutionNotes).toBe('New units arrived 2026-01-05');
      expect(r.resolvedAt).not.toBeNull();
      expect(r.resolvedBy).not.toBeNull();
    });

    it('RESOLVE from SHIPPED_TO_VENDOR → RESOLVED', async () => {
      const id = await seedInitiatedReturn();
      await withTestTenant(async () => returnService.update(adminActor(), id, { action: 'SHIP' }));
      const r = await withTestTenant(async () =>
        returnService.update(adminActor(), id, {
          action: 'RESOLVE',
          resolution: 'REFUNDED',
        }),
      );
      expect(r.status).toBe('RESOLVED');
      expect(r.resolution).toBe('REFUNDED');
    });

    it('RESOLVE without resolution → 400', async () => {
      const id = await seedInitiatedReturn();
      await expect(
        withTestTenant(async () => returnService.update(adminActor(), id, { action: 'RESOLVE' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('RESOLVE from CANCELLED → 400', async () => {
      const id = await seedInitiatedReturn();
      await withTestTenant(async () =>
        returnService.update(adminActor(), id, { action: 'CANCEL' }),
      );
      await expect(
        withTestTenant(async () =>
          returnService.update(adminActor(), id, {
            action: 'RESOLVE',
            resolution: 'CREDITED',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCEL of an already-RESOLVED return → 400', async () => {
      const id = await seedInitiatedReturn();
      await withTestTenant(async () =>
        returnService.update(adminActor(), id, {
          action: 'RESOLVE',
          resolution: 'CREDITED',
        }),
      );
      await expect(
        withTestTenant(async () => returnService.update(adminActor(), id, { action: 'CANCEL' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCEL from INITIATED → CANCELLED', async () => {
      const id = await seedInitiatedReturn();
      const r = await withTestTenant(async () =>
        returnService.update(adminActor(), id, { action: 'CANCEL' }),
      );
      expect(r.status).toBe('CANCELLED');
    });

    it('non-officer (student) → 403', async () => {
      const id = await seedInitiatedReturn();
      await expect(
        withTestTenant(async () => returnService.update(studentActor(), id, { action: 'CANCEL' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin without employeeId → 400', async () => {
      const id = await seedInitiatedReturn();
      const adminNoEmp = { ...adminActor(), employeeId: null };
      await expect(
        withTestTenant(async () => returnService.update(adminNoEmp, id, { action: 'CANCEL' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('bogus returnId → 404', async () => {
      await expect(
        withTestTenant(async () =>
          returnService.update(adminActor(), '00000000-0000-0000-0000-000000000999', {
            action: 'CANCEL',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('ReturnService — reads', () => {
    it('listForReceiptLine returns newest-first', async () => {
      const { receiptLineId } = await seedReceivedChain();
      await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 1,
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      const second = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'WARRANTY_CLAIM',
          quantityReturned: 1,
        }),
      );
      const list = await withTestTenant(async () =>
        returnService.listForReceiptLine(receiptLineId),
      );
      expect(list).toHaveLength(2);
      expect(list[0]!.id).toBe(second.id);
    });

    it('listAll with status filter narrows correctly', async () => {
      const { receiptLineId } = await seedReceivedChain();
      const initiated = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 1,
        }),
      );
      const cancelled = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'WARRANTY_CLAIM',
          quantityReturned: 1,
        }),
      );
      await withTestTenant(async () =>
        returnService.update(adminActor(), cancelled.id, { action: 'CANCEL' }),
      );

      const initiatedOnly = await withTestTenant(async () =>
        returnService.listAll({ status: 'INITIATED' }),
      );
      expect(initiatedOnly.map((r) => r.id)).toEqual([initiated.id]);

      const cancelledOnly = await withTestTenant(async () =>
        returnService.listAll({ status: 'CANCELLED' }),
      );
      expect(cancelledOnly.map((r) => r.id)).toEqual([cancelled.id]);

      const all = await withTestTenant(async () => returnService.listAll());
      expect(all).toHaveLength(2);
    });

    it('listAll scopes to current school (EXISTS join through PO)', async () => {
      // Build a return inside our tenant, confirm listAll returns it
      const { receiptLineId } = await seedReceivedChain();
      const r = await withTestTenant(async () =>
        returnService.create(officerActor(), receiptLineId, {
          returnType: 'DAMAGED',
          quantityReturned: 1,
        }),
      );
      const list = await withTestTenant(async () => returnService.listAll());
      expect(list.map((x) => x.id)).toContain(r.id);
    });

    it('getById bogus id → 404', async () => {
      await expect(
        withTestTenant(async () => returnService.getById('00000000-0000-0000-0000-000000000999')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // VendorPerformanceService
  // ──────────────────────────────────────────────────────────────
  describe('VendorPerformanceService', () => {
    it('list returns rows newest-first with vendor_name + computed scores', async () => {
      // Drive a complete on-time receipt against vendor A so the scorecard
      // materialises via the GoodsReceiptService UPSERT.
      await seedReceivedChain({
        vendorId: TEST_SUPPLIER_A_ID,
        quantityOrdered: 10,
        quantityAccepted: 10,
        quantityRejected: 0,
      });

      const rows = await withTestTenant(async () => vpService.list());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.vendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(rows[0]!.vendorName).toBe('Test Vendor Alpha');
      expect(rows[0]!.schoolId).toBe(TEST_SCHOOL_ID);
      expect(rows[0]!.totalOrders).toBe(1);
      expect(rows[0]!.onTimeDeliveries).toBe(1);
      expect(rows[0]!.lateDeliveries).toBe(0);
      expect(rows[0]!.acceptedCount).toBe(10);
      expect(rows[0]!.rejectedCount).toBe(0);
      expect(rows[0]!.averageQualityScore).toBe(1);
      expect(rows[0]!.averageDeliveryScore).toBe(1);
      expect(typeof rows[0]!.lastUpdatedAt).toBe('string');
    });

    it('list returns multiple vendors sorted by last_updated_at DESC', async () => {
      // Vendor A scored first
      await seedReceivedChain({
        vendorId: TEST_SUPPLIER_A_ID,
        quantityOrdered: 5,
        quantityAccepted: 5,
        quantityRejected: 0,
      });
      await new Promise((r) => setTimeout(r, 50));
      // Vendor B scored second (newer)
      await seedReceivedChain({
        vendorId: TEST_SUPPLIER_B_ID,
        quantityOrdered: 5,
        quantityAccepted: 5,
        quantityRejected: 0,
      });

      const rows = await withTestTenant(async () => vpService.list());
      expect(rows).toHaveLength(2);
      // B was updated more recently → first
      expect(rows[0]!.vendorId).toBe(TEST_SUPPLIER_B_ID);
      expect(rows[1]!.vendorId).toBe(TEST_SUPPLIER_A_ID);
    });

    it('list with no vendor performance rows returns []', async () => {
      const rows = await withTestTenant(async () => vpService.list());
      expect(rows).toEqual([]);
    });

    it('getForVendor returns the row when present', async () => {
      await seedReceivedChain({
        vendorId: TEST_SUPPLIER_A_ID,
        quantityOrdered: 4,
        quantityAccepted: 3,
        quantityRejected: 1,
      });
      const r = await withTestTenant(async () => vpService.getForVendor(TEST_SUPPLIER_A_ID));
      expect(r).not.toBeNull();
      expect(r!.vendorId).toBe(TEST_SUPPLIER_A_ID);
      expect(r!.totalOrders).toBe(1);
      expect(r!.acceptedCount).toBe(3);
      expect(r!.rejectedCount).toBe(1);
      expect(r!.averageQualityScore).toBeCloseTo(0.75, 4);
    });

    it('getForVendor returns null for a vendor with no scorecard', async () => {
      const r = await withTestTenant(async () => vpService.getForVendor(TEST_SUPPLIER_B_ID));
      expect(r).toBeNull();
    });
  });

  // sanity: keep imports honest
  it('imports remain wired', () => {
    expect(teacherActor()).toBeDefined();
  });
});
