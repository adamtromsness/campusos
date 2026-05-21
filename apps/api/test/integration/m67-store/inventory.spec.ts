import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import {
  StoreService,
  ProductService,
  InventoryService,
} from '@modules/m67-store/products/products.service';
import { InventoryAdjustmentService } from '@modules/m67-store/inventory/inventory-adjustment.service';
import { PriceScheduleService } from '@modules/m67-store/inventory/price-schedule.service';
import { CategoryHierarchyService } from '@modules/m67-store/categories/category-hierarchy.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_PUBLIC_ID,
  TEST_STORE_B_STUDENT_ID,
  TEST_PRODUCT_A_ID,
  TEST_INVENTORY_A_ID,
} from '../fixtures/store';

describe('integration:m67-store/inventory', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let storeService: StoreService;
  let productService: ProductService;
  let inventoryService: InventoryService;
  let adjustmentService: InventoryAdjustmentService;
  let scheduleService: PriceScheduleService;
  let categoryService: CategoryHierarchyService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    kafka = makeRecordingKafka();
    const outbox = new OutboxService();
    storeService = new StoreService(tenantPrisma);
    productService = new ProductService(tenantPrisma, storeService);
    inventoryService = new InventoryService(tenantPrisma, kafka);
    adjustmentService = new InventoryAdjustmentService(tenantPrisma, permCheck);
    scheduleService = new PriceScheduleService(tenantPrisma, permCheck, outbox);
    categoryService = new CategoryHierarchyService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
    (kafka as unknown as RecordingKafkaProducer).reset();
  });

  // ────────────────────────────────────────────────────────
  // StoreService
  // ────────────────────────────────────────────────────────
  describe('StoreService', () => {
    it('admin lists active stores in current school only', async () => {
      const list = await withTestTenant(async () => storeService.list());
      const ids = list.map((s) => s.id);
      expect(ids).toContain(TEST_STORE_STUDENT_ID);
      expect(ids).toContain(TEST_STORE_PUBLIC_ID);
      expect(ids).not.toContain(TEST_STORE_B_STUDENT_ID);
    });

    it('list excludes inactive by default; includeInactive=true returns them', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.str_stores SET is_active = false WHERE id = $1::uuid`,
        TEST_STORE_PUBLIC_ID,
      );
      const active = await withTestTenant(async () => storeService.list());
      expect(active.map((s) => s.id)).not.toContain(TEST_STORE_PUBLIC_ID);
      const all = await withTestTenant(async () => storeService.list(true));
      expect(all.map((s) => s.id)).toContain(TEST_STORE_PUBLIC_ID);
    });

    it('getById returns store; missing → NotFoundException', async () => {
      const dto = await withTestTenant(async () => storeService.getById(TEST_STORE_STUDENT_ID));
      expect(dto.name).toBe('Demo Student Store');
      await expect(
        withTestTenant(async () => storeService.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for School B store from School A context → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => storeService.getById(TEST_STORE_B_STUDENT_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin creates a new store in current school', async () => {
      // Delete the seeded STUDENT store first to free the unique slot
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.str_stores WHERE id = $1::uuid`,
        TEST_STORE_STUDENT_ID,
      );
      const dto = await withTestTenant(async () =>
        storeService.create(adminActor(), {
          storeType: 'STUDENT',
          name: 'New Student Store',
          description: 'A new test store',
        } as any),
      );
      expect(dto.name).toBe('New Student Store');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
      expect(dto.isActive).toBe(true);
    });

    it('creating a second store of same type for same school → ConflictException', async () => {
      await expect(
        withTestTenant(async () =>
          storeService.create(adminActor(), {
            storeType: 'STUDENT',
            name: 'Duplicate Type Store',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('student persona cannot create a store → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          storeService.create(studentActor(), {
            storeType: 'PUBLIC',
            name: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates name, description, isActive', async () => {
      const updated = await withTestTenant(async () =>
        storeService.patch(adminActor(), TEST_STORE_STUDENT_ID, {
          name: 'Renamed Store',
          description: 'New desc',
          isActive: false,
        } as any),
      );
      expect(updated.name).toBe('Renamed Store');
      expect(updated.description).toBe('New desc');
      expect(updated.isActive).toBe(false);
    });

    it('patch with no fields is a no-op', async () => {
      const before = await withTestTenant(async () => storeService.getById(TEST_STORE_STUDENT_ID));
      const after = await withTestTenant(async () =>
        storeService.patch(adminActor(), TEST_STORE_STUDENT_ID, {} as any),
      );
      expect(after.name).toBe(before.name);
    });

    it('non-manager patch → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          storeService.patch(studentActor(), TEST_STORE_STUDENT_ID, { name: 'x' } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertExists rejects unknown / cross-school stores', async () => {
      await expect(
        withTestTenant(async () =>
          storeService.assertExists('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withTestTenant(async () => storeService.assertExists(TEST_STORE_B_STUDENT_ID)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────
  // ProductService
  // ────────────────────────────────────────────────────────
  describe('ProductService', () => {
    it('listForStore returns seeded products with inventory summed', async () => {
      const list = await withTestTenant(async () =>
        productService.listForStore(TEST_STORE_STUDENT_ID),
      );
      expect(list.length).toBeGreaterThanOrEqual(2);
      const a = list.find((p) => p.id === TEST_PRODUCT_A_ID)!;
      expect(a.totalOnHand).toBe(100);
      expect(a.totalAvailable).toBe(100);
    });

    it('listForStore with category filter narrows results', async () => {
      const list = await withTestTenant(async () =>
        productService.listForStore(TEST_STORE_STUDENT_ID, { category: 'Nonexistent' }),
      );
      expect(list).toHaveLength(0);
    });

    it('listForStore includeInactive=true returns inactive products', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.str_products SET is_active = false WHERE id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      );
      const activeOnly = await withTestTenant(async () =>
        productService.listForStore(TEST_STORE_STUDENT_ID),
      );
      expect(activeOnly.map((p) => p.id)).not.toContain(TEST_PRODUCT_A_ID);
      const all = await withTestTenant(async () =>
        productService.listForStore(TEST_STORE_STUDENT_ID, { includeInactive: true }),
      );
      expect(all.map((p) => p.id)).toContain(TEST_PRODUCT_A_ID);
    });

    it('getById returns product + inventory; missing → NotFoundException', async () => {
      const dto = await withTestTenant(async () => productService.getById(TEST_PRODUCT_A_ID));
      expect(dto.name).toBe('Test T-Shirt');
      expect(dto.inventory).toHaveLength(1);
      await expect(
        withTestTenant(async () => productService.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin creates a product', async () => {
      const created = await withTestTenant(async () =>
        productService.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'New Mug',
          sku: 'SKU-MUG',
          category: 'Drinkware',
          price: 7.5,
          cost: 2.25,
          imageS3Keys: [],
        } as any),
      );
      expect(created.name).toBe('New Mug');
      expect(created.price).toBe(7.5);
    });

    it('student persona create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          productService.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'X',
            price: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create against School B store from A context → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          productService.create(adminActor(), {
            storeId: TEST_STORE_B_STUDENT_ID,
            name: 'X',
            price: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch updates name/price/isActive/backorderAllowed', async () => {
      const patched = await withTestTenant(async () =>
        productService.patch(adminActor(), TEST_PRODUCT_A_ID, {
          name: 'Renamed Shirt',
          price: 99,
          isActive: false,
          backorderAllowed: true,
          imageS3Keys: ['s3-1', 's3-2'],
        } as any),
      );
      expect(patched.name).toBe('Renamed Shirt');
      expect(patched.price).toBe(99);
      expect(patched.isActive).toBe(false);
      expect(patched.backorderAllowed).toBe(true);
      expect(patched.imageS3Keys).toEqual(['s3-1', 's3-2']);
    });

    it('non-manager patch → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          productService.patch(studentActor(), TEST_PRODUCT_A_ID, { name: 'X' } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch with no fields is a no-op', async () => {
      const before = await withTestTenant(async () => productService.getById(TEST_PRODUCT_A_ID));
      const after = await withTestTenant(async () =>
        productService.patch(adminActor(), TEST_PRODUCT_A_ID, {} as any),
      );
      expect(after.name).toBe(before.name);
    });
  });

  // ────────────────────────────────────────────────────────
  // InventoryService
  // ────────────────────────────────────────────────────────
  describe('InventoryService', () => {
    it('dashboard returns all inventory in current school with atOrBelowReorder flag', async () => {
      // Force product A inventory to at-or-below reorder
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.str_product_inventory SET quantity_on_hand = 5 WHERE id = $1::uuid`,
        TEST_INVENTORY_A_ID,
      );
      const rows = await withTestTenant(async () => inventoryService.dashboard());
      expect(rows.length).toBeGreaterThan(0);
      const a = rows.find((r) => r.productId === TEST_PRODUCT_A_ID)!;
      expect(a.atOrBelowReorder).toBe(true);
      expect(a.quantityOnHand).toBe(5);
    });

    it('adjust to below reorder fires str.inventory.reorder_needed once', async () => {
      await withTestTenant(async () =>
        inventoryService.adjust(adminActor(), TEST_INVENTORY_A_ID, {
          quantityOnHand: 5,
        } as any),
      );
      const calls = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'str.inventory.reorder_needed',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toMatchObject({
        productId: TEST_PRODUCT_A_ID,
        currentStock: 5,
      });
    });

    it('subsequent adjustment that stays below reorder does NOT re-fire emit', async () => {
      await withTestTenant(async () =>
        inventoryService.adjust(adminActor(), TEST_INVENTORY_A_ID, {
          quantityOnHand: 5,
        } as any),
      );
      (kafka as unknown as RecordingKafkaProducer).reset();
      await withTestTenant(async () =>
        inventoryService.adjust(adminActor(), TEST_INVENTORY_A_ID, {
          quantityOnHand: 3,
        } as any),
      );
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('str.inventory.reorder_needed'),
      ).toHaveLength(0);
    });

    it('non-manager adjust → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          inventoryService.adjust(studentActor(), TEST_INVENTORY_A_ID, {
            quantityOnHand: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('adjust on missing inventory → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          inventoryService.adjust(adminActor(), '00000000-0000-0000-0000-000000000000', {
            quantityOnHand: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school adjust → NotFoundException', async () => {
      // Inventory linked to School B's store
      const schoolBProductId = '019e0cf8-aaaa-7777-8888-000000067099';
      const schoolBInvId = '019e0cf8-aaaa-7777-8888-000000067098';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, price, is_active) VALUES ($1::uuid, $2::uuid, 'B Prod', 5, true)`,
        schoolBProductId,
        TEST_STORE_B_STUDENT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity) VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 50, 0, 10, 10)`,
        schoolBInvId,
        schoolBProductId,
        TEST_SCHOOL_ID, // location_id arbitrary
      );
      await expect(
        withTestTenant(async () =>
          inventoryService.adjust(adminActor(), schoolBInvId, { quantityOnHand: 1 } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────
  // InventoryAdjustmentService — audit trail
  // ────────────────────────────────────────────────────────
  describe('InventoryAdjustmentService', () => {
    it('admin creates a RECOUNT adjustment with positive delta', async () => {
      const adj = await withTestTenant(async () =>
        adjustmentService.adjust(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          inventoryId: TEST_INVENTORY_A_ID,
          adjustmentType: 'RECOUNT',
          quantityDelta: 5,
          reason: 'Manual recount after audit',
        } as any),
      );
      expect(adj.quantityDelta).toBe(5);
      expect(adj.adjustmentType).toBe('RECOUNT');

      // Inventory got bumped
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_on_hand::int AS q FROM ${TEST_SCHEMA}.str_product_inventory WHERE id = $1::uuid`,
        TEST_INVENTORY_A_ID,
      )) as Array<{ q: number }>;
      expect(rows[0]!.q).toBe(105);
    });

    it('creates a negative DAMAGE adjustment', async () => {
      const adj = await withTestTenant(async () =>
        adjustmentService.adjust(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          inventoryId: TEST_INVENTORY_A_ID,
          adjustmentType: 'DAMAGE',
          quantityDelta: -3,
          reason: 'Three units damaged in storage',
        } as any),
      );
      expect(adj.quantityDelta).toBe(-3);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT quantity_on_hand::int AS q FROM ${TEST_SCHEMA}.str_product_inventory WHERE id = $1::uuid`,
        TEST_INVENTORY_A_ID,
      )) as Array<{ q: number }>;
      expect(rows[0]!.q).toBe(97);
    });

    it('zero-delta rejected by schema CHECK', async () => {
      await expect(
        withTestTenant(async () =>
          adjustmentService.adjust(adminActor(), {
            productId: TEST_PRODUCT_A_ID,
            inventoryId: TEST_INVENTORY_A_ID,
            adjustmentType: 'RECOUNT',
            quantityDelta: 0,
            reason: 'no-op recount entry x',
          } as any),
        ),
      ).rejects.toThrow();
    });

    it('listForProduct returns adjustments for a product', async () => {
      await withTestTenant(async () =>
        adjustmentService.adjust(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          inventoryId: TEST_INVENTORY_A_ID,
          adjustmentType: 'RECOUNT',
          quantityDelta: 1,
          reason: 'spot-check increment',
        } as any),
      );
      const list = await withTestTenant(async () =>
        adjustmentService.listForProduct(adminActor(), TEST_PRODUCT_A_ID),
      );
      expect(list.length).toBeGreaterThan(0);
      expect(list[0]!.productId).toBe(TEST_PRODUCT_A_ID);
    });

    it('cross-school product → BadRequest/Forbidden/NotFound', async () => {
      // School B inventory + product
      const schoolBProductId = '019e0cf8-aaaa-7777-8888-000000067088';
      const schoolBInvId = '019e0cf8-aaaa-7777-8888-000000067089';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, price, is_active) VALUES ($1::uuid, $2::uuid, 'B Prod', 5, true)`,
        schoolBProductId,
        TEST_STORE_B_STUDENT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity) VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 50, 0, 10, 10)`,
        schoolBInvId,
        schoolBProductId,
        TEST_SCHOOL_ID,
      );
      await expect(
        withTestTenant(async () =>
          adjustmentService.adjust(adminActor(), {
            productId: schoolBProductId,
            inventoryId: schoolBInvId,
            adjustmentType: 'RECOUNT',
            quantityDelta: 1,
            reason: 'cross-school attempt',
          } as any),
        ),
      ).rejects.toThrow();
    });
  });

  // ────────────────────────────────────────────────────────
  // CategoryHierarchyService
  // ────────────────────────────────────────────────────────
  describe('CategoryHierarchyService', () => {
    it('create root + child categories', async () => {
      const root = await withTestTenant(async () =>
        categoryService.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'Apparel',
          description: 'Clothing items',
          sortOrder: 0,
        } as any),
      );
      const child = await withTestTenant(async () =>
        categoryService.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'T-Shirts',
          parentCategoryId: root.id,
          sortOrder: 1,
        } as any),
      );
      expect(child.parentCategoryId).toBe(root.id);

      const tree = await withTestTenant(async () =>
        categoryService.tree(adminActor(), TEST_STORE_STUDENT_ID),
      );
      const ids = new Set<string>();
      const walk = (nodes: Array<{ id: string; children?: any[] }>): void => {
        for (const n of nodes) {
          ids.add(n.id);
          if (n.children) walk(n.children);
        }
      };
      walk(tree as any);
      expect(ids.has(root.id)).toBe(true);
      expect(ids.has(child.id)).toBe(true);
    });

    it('duplicate sibling name → ConflictException', async () => {
      await withTestTenant(async () =>
        categoryService.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'Dup',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          categoryService.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'Dup',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          categoryService.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // PriceScheduleService
  // ────────────────────────────────────────────────────────
  describe('PriceScheduleService', () => {
    it('admin schedules a future price change', async () => {
      const sched = await withTestTenant(async () =>
        scheduleService.create(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          scheduledPrice: 12.5,
          effectiveFrom: '2027-01-01T00:00:00Z',
          effectiveTo: '2027-02-01T00:00:00Z',
          reason: 'New Year sale',
        } as any),
      );
      expect(sched.scheduledPrice).toBe(12.5);
      expect(sched.productId).toBe(TEST_PRODUCT_A_ID);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          scheduleService.create(studentActor(), {
            productId: TEST_PRODUCT_A_ID,
            scheduledPrice: 1,
            effectiveFrom: '2027-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school product → BadRequestException', async () => {
      const schoolBProductId = '019e0cf8-aaaa-7777-8888-000000067077';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, price, is_active) VALUES ($1::uuid, $2::uuid, 'B Prod', 5, true)`,
        schoolBProductId,
        TEST_STORE_B_STUDENT_ID,
      );
      await expect(
        withTestTenant(async () =>
          scheduleService.create(adminActor(), {
            productId: schoolBProductId,
            scheduledPrice: 1,
            effectiveFrom: '2027-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('list returns schedules for a product', async () => {
      await withTestTenant(async () =>
        scheduleService.create(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          scheduledPrice: 9.99,
          effectiveFrom: '2027-01-01T00:00:00Z',
        } as any),
      );
      const list = await withTestTenant(async () =>
        scheduleService.listForProduct(adminActor(), TEST_PRODUCT_A_ID),
      );
      expect(list.length).toBeGreaterThan(0);
    });
  });
});
