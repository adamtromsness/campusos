import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { WishlistService } from '@modules/m67-store/wishlists/wishlist.service';
import {
  ExternalCustomerService,
  ShippingService,
  RevenueService,
} from '@modules/m67-store/products/revenue.service';
import { CategoryHierarchyService } from '@modules/m67-store/categories/category-hierarchy.service';
import { PriceScheduleService } from '@modules/m67-store/inventory/price-schedule.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_PUBLIC_ID,
  TEST_STORE_B_STUDENT_ID,
  TEST_PRODUCT_A_ID,
  TEST_PRODUCT_B_ID,
} from '../fixtures/store';

describe('integration:m67-store/wishlists-revenue', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let wishlist: WishlistService;
  let externalCust: ExternalCustomerService;
  let shipping: ShippingService;
  let revenue: RevenueService;
  let category: CategoryHierarchyService;
  let schedule: PriceScheduleService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    wishlist = new WishlistService(tenantPrisma, permCheck);
    externalCust = new ExternalCustomerService(tenantPrisma);
    shipping = new ShippingService(tenantPrisma);
    revenue = new RevenueService(tenantPrisma);
    category = new CategoryHierarchyService(tenantPrisma, permCheck);
    schedule = new PriceScheduleService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
  });

  // ────────────────────────────────────────────────────────
  // WishlistService
  // ────────────────────────────────────────────────────────
  describe('WishlistService', () => {
    it('add → listForCustomer returns the entry', async () => {
      const dto = await withTestTenant(async () =>
        wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
          productId: TEST_PRODUCT_A_ID,
          notifyOnRestock: true,
        } as any),
      );
      expect(dto.productId).toBe(TEST_PRODUCT_A_ID);

      const list = await withTestTenant(async () =>
        wishlist.listForCustomer(adminActor(), TEST_ADMIN_PERSON_ID),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.productId).toBe(TEST_PRODUCT_A_ID);
    });

    it('re-adding same (customer, product) raises or returns existing (UNIQUE protection)', async () => {
      await withTestTenant(async () =>
        wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
          productId: TEST_PRODUCT_A_ID,
        } as any),
      );
      // The service tries to recover from a 23505; whether it succeeds or
      // surfaces is implementation-defined. Either way, exactly one row
      // exists.
      try {
        await withTestTenant(async () =>
          wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
            productId: TEST_PRODUCT_A_ID,
          } as any),
        );
      } catch {
        // ignore — schema-level UNIQUE may surface
      }
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.str_wishlists WHERE customer_person_id = $1::uuid AND product_id = $2::uuid`,
        TEST_ADMIN_PERSON_ID,
        TEST_PRODUCT_A_ID,
      )) as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(1);
    });

    it('update toggles notifyOnRestock', async () => {
      await withTestTenant(async () =>
        wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
          productId: TEST_PRODUCT_A_ID,
          notifyOnRestock: true,
        } as any),
      );
      const updated = await withTestTenant(async () =>
        wishlist.update(adminActor(), TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID, {
          notifyOnRestock: false,
        } as any),
      );
      expect(updated.notifyOnRestock).toBe(false);
    });

    it('update unknown entry → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          wishlist.update(adminActor(), TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID, {
            notifyOnRestock: false,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove deletes the entry', async () => {
      await withTestTenant(async () =>
        wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
          productId: TEST_PRODUCT_A_ID,
        } as any),
      );
      await withTestTenant(async () =>
        wishlist.remove(adminActor(), TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID),
      );
      const list = await withTestTenant(async () =>
        wishlist.listForCustomer(adminActor(), TEST_ADMIN_PERSON_ID),
      );
      expect(list).toHaveLength(0);
    });

    it('remove non-existent is a silent no-op (DELETE ... WHERE no-match)', async () => {
      // Service does not throw; the DELETE just affects 0 rows.
      await withTestTenant(async () =>
        wishlist.remove(adminActor(), TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.str_wishlists`,
      )) as Array<{ c: number }>;
      expect(rows[0]!.c).toBe(0);
    });

    it('non-admin cannot manage another customer\'s wishlist', async () => {
      // student trying to act for admin person → forbidden
      await expect(
        withTestTenant(async () =>
          wishlist.add(studentActor(), TEST_ADMIN_PERSON_ID, {
            productId: TEST_PRODUCT_A_ID,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('add with cross-school product → BadRequestException', async () => {
      const otherProductId = '019e0cf8-aaaa-7777-8888-000000067777';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, price, is_active) VALUES ($1::uuid, $2::uuid, 'X', 1, true)`,
        otherProductId,
        TEST_STORE_B_STUDENT_ID,
      );
      await expect(
        withTestTenant(async () =>
          wishlist.add(adminActor(), TEST_ADMIN_PERSON_ID, {
            productId: otherProductId,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────
  // ExternalCustomerService
  // ────────────────────────────────────────────────────────
  describe('ExternalCustomerService', () => {
    it('create + getById + list works', async () => {
      const created = await withTestTenant(async () =>
        externalCust.create({
          name: 'New Customer',
          email: 'new@example.com',
          phone: '555-0000',
          shippingAddress: '1 Test Ln',
        } as any),
      );
      expect(created.name).toBe('New Customer');
      expect(created.schoolId).toBe(TEST_SCHOOL_ID);

      const fetched = await withTestTenant(async () => externalCust.getById(created.id));
      expect(fetched.id).toBe(created.id);

      const list = await withTestTenant(async () => externalCust.list(adminActor()));
      expect(list.map((c) => c.id)).toContain(created.id);
    });

    it('non-manager list → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => externalCust.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          externalCust.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────
  // ShippingService
  // ────────────────────────────────────────────────────────
  describe('ShippingService', () => {
    it('admin creates shipping option; listForStore returns it', async () => {
      const opt = await withTestTenant(async () =>
        shipping.create(adminActor(), {
          storeId: TEST_STORE_PUBLIC_ID,
          methodName: 'Express',
          estimatedDays: 2,
          flatRate: 10,
        } as any),
      );
      expect(opt.methodName).toBe('Express');
      expect(opt.flatRate).toBe(10);
      const list = await withTestTenant(async () =>
        shipping.listForStore(TEST_STORE_PUBLIC_ID),
      );
      expect(list.map((o) => o.id)).toContain(opt.id);
    });

    it('non-manager create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          shipping.create(studentActor(), {
            storeId: TEST_STORE_PUBLIC_ID,
            methodName: 'X',
            flatRate: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch updates fields', async () => {
      const opt = await withTestTenant(async () =>
        shipping.create(adminActor(), {
          storeId: TEST_STORE_PUBLIC_ID,
          methodName: 'Original',
          flatRate: 5,
        } as any),
      );
      const updated = await withTestTenant(async () =>
        shipping.patch(adminActor(), opt.id, {
          methodName: 'Renamed',
          flatRate: 15,
          isActive: false,
          estimatedDays: 7,
        } as any),
      );
      expect(updated.methodName).toBe('Renamed');
      expect(updated.flatRate).toBe(15);
      expect(updated.isActive).toBe(false);
    });

    it('patch unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          shipping.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            methodName: 'X',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForStore with includeInactive=true returns inactive options', async () => {
      const opt = await withTestTenant(async () =>
        shipping.create(adminActor(), {
          storeId: TEST_STORE_PUBLIC_ID,
          methodName: 'Inactive Option',
          flatRate: 0,
        } as any),
      );
      await withTestTenant(async () =>
        shipping.patch(adminActor(), opt.id, { isActive: false } as any),
      );
      const active = await withTestTenant(async () =>
        shipping.listForStore(TEST_STORE_PUBLIC_ID),
      );
      expect(active.map((o) => o.id)).not.toContain(opt.id);
      const all = await withTestTenant(async () =>
        shipping.listForStore(TEST_STORE_PUBLIC_ID, true),
      );
      expect(all.map((o) => o.id)).toContain(opt.id);
    });
  });

  // ────────────────────────────────────────────────────────
  // RevenueService
  // ────────────────────────────────────────────────────────
  describe('RevenueService', () => {
    it('materialise + list', async () => {
      const row = await withTestTenant(async () =>
        revenue.materialise(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        } as any),
      );
      expect(row.storeId).toBe(TEST_STORE_STUDENT_ID);
      expect(row.totalRevenue).toBe(0);

      const list = await withTestTenant(async () => revenue.list(adminActor()));
      expect(list.map((r) => r.id)).toContain(row.id);
    });

    it('non-manager list → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => revenue.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('materialise rerun is idempotent (upserts)', async () => {
      const first = await withTestTenant(async () =>
        revenue.materialise(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        } as any),
      );
      const second = await withTestTenant(async () =>
        revenue.materialise(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        } as any),
      );
      expect(second.id).toBe(first.id);
    });

    it('list filtered by storeId', async () => {
      await withTestTenant(async () =>
        revenue.materialise(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        } as any),
      );
      const filtered = await withTestTenant(async () =>
        revenue.list(adminActor(), TEST_STORE_STUDENT_ID),
      );
      expect(filtered.length).toBeGreaterThan(0);
      for (const r of filtered) {
        expect(r.storeId).toBe(TEST_STORE_STUDENT_ID);
      }
    });

    it('materialise non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          revenue.materialise(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // CategoryHierarchyService — patch + remove + getById
  // ────────────────────────────────────────────────────────
  describe('CategoryHierarchyService — extended', () => {
    async function makeRoot() {
      return withTestTenant(async () =>
        category.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'RootCat',
          sortOrder: 0,
        } as any),
      );
    }

    it('getById returns category; missing → NotFoundException', async () => {
      const root = await makeRoot();
      const fetched = await withTestTenant(async () =>
        category.getById(adminActor(), root.id),
      );
      expect(fetched.id).toBe(root.id);

      await expect(
        withTestTenant(async () =>
          category.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch updates name/description/sortOrder/isActive', async () => {
      const root = await makeRoot();
      const patched = await withTestTenant(async () =>
        category.patch(adminActor(), root.id, {
          name: 'Renamed',
          description: 'desc',
          sortOrder: 5,
          isActive: false,
        } as any),
      );
      expect(patched.name).toBe('Renamed');
      expect(patched.sortOrder).toBe(5);
      expect(patched.isActive).toBe(false);
    });

    it('patch unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          category.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            name: 'x',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove deletes leaf category', async () => {
      const root = await makeRoot();
      await withTestTenant(async () => category.remove(adminActor(), root.id));
      await expect(
        withTestTenant(async () => category.getById(adminActor(), root.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove non-leaf → BadRequestException (or similar)', async () => {
      const root = await makeRoot();
      await withTestTenant(async () =>
        category.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'Child',
          parentCategoryId: root.id,
        } as any),
      );
      await expect(
        withTestTenant(async () => category.remove(adminActor(), root.id)),
      ).rejects.toThrow();
    });

    it('non-admin remove → ForbiddenException', async () => {
      const root = await makeRoot();
      await expect(
        withTestTenant(async () => category.remove(studentActor(), root.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────
  // PriceScheduleService — remove + runOnce
  // ────────────────────────────────────────────────────────
  describe('PriceScheduleService — extended', () => {
    it('admin removes a non-applied scheduled price change', async () => {
      const sched = await withTestTenant(async () =>
        schedule.create(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          scheduledPrice: 50,
          effectiveFrom: '2099-01-01T00:00:00Z',
        } as any),
      );
      await withTestTenant(async () => schedule.remove(adminActor(), sched.id));

      const list = await withTestTenant(async () =>
        schedule.listForProduct(adminActor(), TEST_PRODUCT_A_ID),
      );
      expect(list.map((s) => s.id)).not.toContain(sched.id);
    });

    it('remove unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          schedule.remove(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin remove → ForbiddenException', async () => {
      const sched = await withTestTenant(async () =>
        schedule.create(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          scheduledPrice: 50,
          effectiveFrom: '2099-01-01T00:00:00Z',
        } as any),
      );
      await expect(
        withTestTenant(async () => schedule.remove(studentActor(), sched.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('runOnce applies ripe schedules; price is updated', async () => {
      // Schedule a price change for the past (already ripe)
      await withTestTenant(async () =>
        schedule.create(adminActor(), {
          productId: TEST_PRODUCT_A_ID,
          scheduledPrice: 9.99,
          effectiveFrom: '2020-01-01T00:00:00Z',
        } as any),
      );
      const result = await schedule.runOnce();
      expect(result.rowsApplied).toBeGreaterThanOrEqual(1);

      const product = (await rawClient.$queryRawUnsafe(
        `SELECT price::text AS p FROM ${TEST_SCHEMA}.str_products WHERE id = $1::uuid`,
        TEST_PRODUCT_A_ID,
      )) as Array<{ p: string }>;
      expect(Number(product[0]!.p)).toBe(9.99);
    });
  });
});
