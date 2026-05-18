import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RequisitionService } from '@modules/m86-procurement/requisitions.service';
import {
  PurchaseOrderService,
  GoodsReceiptService,
} from '@modules/m86-procurement/purchase-orders.service';
import { DistributionService } from '@modules/m86-procurement/distribution.service';
import { FinanceValidationService } from '@modules/m83-finance/validation';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { resetProcurementTables } from '../helpers/reset';
import { RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  TEST_BUDGET_LINE_ID,
  TEST_BUDGET_LINE_B_ID,
  TEST_SUPPLIER_A_ID,
  TEST_SUPPLIER_B_SCHOOL_ID,
} from '../fixtures/finance';

/**
 * Wave 1 — final m86-procurement slice. Two strategy-doc Wave 1 contracts
 * the existing procurement specs do NOT cover:
 *
 *   1. Cross-school isolation for the procurement services. The existing
 *      tests at `test/integration/procurement/` exercise School A only.
 *      Here we seed records under School B and verify a School A actor
 *      cannot read / mutate them via getById (NotFoundException).
 *
 *   2. The IMMUTABLE pay_lunch_account_balance_transfers contract is
 *      verified in lunch-accounts.spec.ts. The fourth strategy-doc
 *      IMMUTABLE contract — `fds_inventory_transactions` (migration
 *      177 prevent_mutation trigger on a monthly-partitioned table) —
 *      lands here. Tests UPDATE/DELETE against a seeded row → SQLSTATE
 *      23001. TRUNCATE bypasses BEFORE ROW triggers (documented).
 */
describe('integration:m86-procurement/cross-school-and-immutable', () => {
  let tenantPrisma: TenantPrismaService;
  let finance: FinanceValidationService;
  let kafka: RecordingKafkaProducer;
  let requisitionService: RequisitionService;
  let poService: PurchaseOrderService;
  let receiptService: GoodsReceiptService;
  let distributionService: DistributionService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    finance = new FinanceValidationService(tenantPrisma);
    kafka = new RecordingKafkaProducer();
    requisitionService = new RequisitionService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      finance,
    );
    poService = new PurchaseOrderService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      finance,
    );
    receiptService = new GoodsReceiptService(tenantPrisma);
    distributionService = new DistributionService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );
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
    });
    // Wipe test-created fds_* rows from prior runs. fds_inventory_transactions
    // carries an IMMUTABLE prevent_mutation trigger (BEFORE UPDATE/DELETE),
    // so a per-row DELETE fails. TRUNCATE bypasses the row trigger and
    // cascades through every monthly partition.
    await rawClient.$executeRawUnsafe(
      `TRUNCATE ${TEST_SCHEMA}.fds_inventory_transactions`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fds_inventory_items WHERE name LIKE 'PROC-TEST-%'`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.fds_inventory_groups WHERE name LIKE 'PROC-TEST-%'`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school: RequisitionService / PurchaseOrderService / DistributionService
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('requisition seeded in School B → NotFoundException for School A admin', async () => {
      // Seed a requisition under School B via the service running in
      // School B's tenant context. budgetLineId belongs to School B.
      const reqB = await withTestTenantB(async () =>
        requisitionService.create(adminActor(), {
          requestingDepartment: 'B-dept',
          urgency: 'ROUTINE',
          justification: 'B-only justification',
          lines: [
            {
              itemDescription: 'School B item',
              quantity: 1,
              unit: 'each',
              estimatedUnitCost: 10,
              destinationModule: 'tech',
              budgetLineId: TEST_BUDGET_LINE_B_ID,
            },
          ],
        }),
      );

      // School A admin cannot see it
      await expect(
        withTestTenant(async () => requisitionService.getById(reqB.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('purchase order seeded in School B → NotFoundException for School A admin', async () => {
      // Seed PO under School B with the school-B-scoped supplier.
      const poB = await withTestTenantB(async () =>
        poService.create(adminActor(), {
          vendorId: TEST_SUPPLIER_B_SCHOOL_ID,
          deliveryAddress: '500 School B Way',
          lines: [
            {
              itemDescription: 'School B widget',
              quantityOrdered: 2,
              unitCost: 25,
              destinationModule: 'tech',
            },
          ],
        }),
      );
      // School A admin cannot read it
      await expect(
        withTestTenant(async () => poService.getById(poB.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('procurement list endpoints scoped: School A list does NOT include School B rows', async () => {
      // Seed one in each school
      const reqA = await withTestTenant(async () =>
        requisitionService.create(adminActor(), {
          requestingDepartment: 'A',
          urgency: 'ROUTINE',
          justification: 'A',
          lines: [
            {
              itemDescription: 'A',
              quantity: 1,
              unit: 'each',
              estimatedUnitCost: 5,
              destinationModule: 'tech',
              budgetLineId: TEST_BUDGET_LINE_ID,
            },
          ],
        }),
      );
      const reqB = await withTestTenantB(async () =>
        requisitionService.create(adminActor(), {
          requestingDepartment: 'B',
          urgency: 'ROUTINE',
          justification: 'B',
          lines: [
            {
              itemDescription: 'B',
              quantity: 1,
              unit: 'each',
              estimatedUnitCost: 5,
              destinationModule: 'tech',
              budgetLineId: TEST_BUDGET_LINE_B_ID,
            },
          ],
        }),
      );

      const listA = await withTestTenant(async () => requisitionService.list(adminActor()));
      expect(listA.find((r) => r.id === reqA.id)).toBeDefined();
      expect(listA.find((r) => r.id === reqB.id)).toBeUndefined();
    });

    it('distribution: School A admin cannot resolve School B distribution via the JOIN chain (full PO + receipt + distribution chain)', async () => {
      // Full chain in School B: PO → ISSUE → receive → distribute
      const chainResult = await withTestTenantB(async () => {
        const po = await poService.create(adminActor(), {
          vendorId: TEST_SUPPLIER_B_SCHOOL_ID,
          deliveryAddress: '500 School B Way',
          lines: [
            {
              itemDescription: 'School B widget',
              quantityOrdered: 3,
              unitCost: 25,
              destinationModule: 'tech',
            },
          ],
        });
        await poService.transition(adminActor(), po.id, { action: 'ISSUE' });
        const issued = await poService.getById(po.id);
        const poLineId = issued.lines[0]!.id;
        const receipt = await receiptService.create(adminActor(), po.id, {
          inspectionOutcome: 'ACCEPTED',
          lines: [
            {
              poLineId,
              quantityReceived: 3,
              quantityAccepted: 3,
              quantityRejected: 0,
              condition: 'GOOD',
            },
          ],
        });
        const receiptLineId = receipt.lines[0]!.id;
        const dist = await distributionService.create(adminActor(), receipt.id, {
          destinationModule: 'tech',
          lines: [
            {
              receiptLineId,
              quantityDistributed: 3,
              itemDescription: 'School B widget',
              unitCost: 25,
            },
          ],
        });
        return { distId: dist.id, receiptId: receipt.id };
      });
      // 1. Confirm the distribution row exists in School B's view
      const fromB = await withTestTenantB(async () =>
        distributionService.listForReceipt(chainResult.receiptId),
      );
      expect(fromB.find((d) => d.id === chainResult.distId)).toBeDefined();
      // 2. School A admin cannot read the distribution that lives
      //    under School B's PO. listForReceipt JOINs through
      //    prc_goods_receipts → prc_purchase_orders.school_id, so a
      //    cross-school probe with the B-receipt id under A returns []
      //    even though prc_distributions itself has no school_id col.
      const fromA = await withTestTenant(async () =>
        distributionService.listForReceipt(chainResult.receiptId),
      );
      expect(fromA).toEqual([]);
      // 3. School A cannot even DISTRIBUTE against a foreign-tenant
      //    receipt — create() also walks the JOIN.
      await expect(
        withTestTenant(async () =>
          distributionService.create(adminActor(), chainResult.receiptId, {
            destinationModule: 'tech',
            lines: [
              {
                receiptLineId: '00000000-0000-0000-0000-000000000000',
                quantityDistributed: 1,
                itemDescription: 'cross-school attempt',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // IMMUTABLE fds_inventory_transactions — strategy doc Wave 1 contract
  // ────────────────────────────────────────────────────────────────────
  describe('IMMUTABLE fds_inventory_transactions (migration 177 trigger)', () => {
    async function seedInventoryTransaction(): Promise<{
      transactionId: string;
      transactionAt: string;
    }> {
      // Seed a group + item + transaction. The transactions table is
      // partitioned monthly by transaction_at; pick a date that lands
      // in an existing partition. The migration provisions monthly
      // partitions from 2024-08 onward, so today's date should hit a
      // partition that exists.
      const groupId = generateId();
      const itemId = generateId();
      const transactionId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fds_inventory_groups
           (id, school_id, name, group_type, is_active)
         VALUES ($1::uuid, $2::uuid, 'PROC-TEST-group', 'LUNCH', true)`,
        groupId,
        TEST_SCHOOL_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fds_inventory_items
           (id, school_id, name, unit, category)
         VALUES ($1::uuid, $2::uuid, 'PROC-TEST-item', 'kg', 'PROTEIN')`,
        itemId,
        TEST_SCHOOL_ID,
      );
      // Pin the transaction to "now" — present-month partition exists for
      // 2024-08 onward in the migration, so any current-ish date is fine.
      const txDate = new Date().toISOString();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.fds_inventory_transactions
           (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'RECEIPT', 10, $5::uuid, $6::timestamptz)`,
        transactionId,
        TEST_SCHOOL_ID,
        groupId,
        itemId,
        TEST_ADMIN_EMPLOYEE_ID,
        txDate,
      );
      return { transactionId, transactionAt: txDate };
    }

    it('UPDATE fds_inventory_transactions.quantity_delta → SQLSTATE 23001', async () => {
      const { transactionId, transactionAt } = await seedInventoryTransaction();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fds_inventory_transactions SET quantity_delta = 999 WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
          transactionId,
          transactionAt,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001') || msg.toLowerCase().includes('immutable')).toBe(
        true,
      );
    });

    it('UPDATE fds_inventory_transactions.transaction_type → SQLSTATE 23001', async () => {
      const { transactionId, transactionAt } = await seedInventoryTransaction();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `UPDATE ${TEST_SCHEMA}.fds_inventory_transactions SET transaction_type = 'WASTE' WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
          transactionId,
          transactionAt,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('DELETE FROM fds_inventory_transactions → SQLSTATE 23001', async () => {
      const { transactionId, transactionAt } = await seedInventoryTransaction();
      let caught: { meta?: { code?: string }; message?: string } | undefined;
      try {
        await rawClient.$executeRawUnsafe(
          `DELETE FROM ${TEST_SCHEMA}.fds_inventory_transactions WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
          transactionId,
          transactionAt,
        );
      } catch (err) {
        caught = err as { meta?: { code?: string }; message?: string };
      }
      expect(caught).toBeDefined();
      const code = caught?.meta?.code ?? '';
      const msg = caught?.message ?? '';
      expect(code === '23001' || msg.includes('23001')).toBe(true);
    });

    it('TRUNCATE fds_inventory_transactions succeeds — table-level op bypasses BEFORE ROW triggers', async () => {
      const { transactionId, transactionAt } = await seedInventoryTransaction();
      const before = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fds_inventory_transactions WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
        transactionId,
        transactionAt,
      )) as Array<{ n: number }>;
      expect(before[0]!.n).toBe(1);

      // TRUNCATE on the partitioned parent CASCADEs to every partition
      // and bypasses BEFORE ROW triggers per Postgres semantics. Use
      // a transaction so we can roll back after asserting — keeping
      // partitions clean for the rest of the suite.
      await rawClient.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.fds_inventory_transactions`);
        const after = (await tx.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fds_inventory_transactions WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
          transactionId,
          transactionAt,
        )) as Array<{ n: number }>;
        expect(after[0]!.n).toBe(0);
        // Rollback by throwing — tx is discarded.
        throw new Error('rollback');
      }).catch((e) => {
        if ((e as Error).message !== 'rollback') throw e;
      });

      // After rollback the row is back (proving TRUNCATE was visible inside
      // the tx and rolled back cleanly with it).
      const afterRollback = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.fds_inventory_transactions WHERE id = $1::uuid AND transaction_at = $2::timestamptz`,
        transactionId,
        transactionAt,
      )) as Array<{ n: number }>;
      expect(afterRollback[0]!.n).toBe(1);
    });
  });
});
