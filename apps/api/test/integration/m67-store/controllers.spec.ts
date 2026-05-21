import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { StoreController } from '@modules/m67-store/orders/store.controller';
import { StoreAdvancedController } from '@modules/m67-store/orders/store-advanced.controller';
import {
  StoreService,
  ProductService,
  InventoryService,
} from '@modules/m67-store/products/products.service';
import { OrderService, ApprovalService } from '@modules/m67-store/orders/orders.service';
import {
  ExternalCustomerService,
  ShippingService,
  RevenueService,
} from '@modules/m67-store/products/revenue.service';
import { InventoryAdjustmentService } from '@modules/m67-store/inventory/inventory-adjustment.service';
import { PromotionService } from '@modules/m67-store/promotions/promotion.service';
import { LoyaltyService } from '@modules/m67-store/loyalty/loyalty.service';
import { GiftCardService } from '@modules/m67-store/gift-cards/gift-card.service';
import { WishlistService } from '@modules/m67-store/wishlists/wishlist.service';
import { PriceScheduleService } from '@modules/m67-store/inventory/price-schedule.service';
import { CategoryHierarchyService } from '@modules/m67-store/categories/category-hierarchy.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { makeRecordingKafka } from '../helpers/recording-kafka';
import { withTestTenant } from '../helpers/tenant-context';
import { adminActor, TEST_ADMIN_ACCOUNT_ID, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_PUBLIC_ID,
  TEST_PRODUCT_A_ID,
  TEST_INVENTORY_A_ID,
} from '../fixtures/store';

class StubActorContext {
  async resolveActor(_accountId: string, _personId: string): Promise<ResolvedActor> {
    return adminActor();
  }
}

describe('integration:m67-store/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let storeCtl: StoreController;
  let advCtl: StoreAdvancedController;
  let req: {
    user: {
      sub: string;
      personId: string;
      accountId: string;
      email: string;
      displayName: string;
      sessionId: string;
    };
  };

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    const kafka = makeRecordingKafka();

    const storeSvc = new StoreService(tenantPrisma);
    const productSvc = new ProductService(tenantPrisma, storeSvc);
    const inventorySvc = new InventoryService(tenantPrisma, kafka);
    const orderSvc = new OrderService(tenantPrisma, kafka, productSvc);
    const approvalSvc = new ApprovalService(tenantPrisma, orderSvc);
    const externalSvc = new ExternalCustomerService(tenantPrisma);
    const shippingSvc = new ShippingService(tenantPrisma);
    const revenueSvc = new RevenueService(tenantPrisma);
    const adjSvc = new InventoryAdjustmentService(tenantPrisma, permCheck);
    const promoSvc = new PromotionService(tenantPrisma, permCheck, outbox);
    const loyaltySvc = new LoyaltyService(tenantPrisma, permCheck);
    const gcSvc = new GiftCardService(tenantPrisma, permCheck, outbox);
    const wlSvc = new WishlistService(tenantPrisma, permCheck);
    const psSvc = new PriceScheduleService(tenantPrisma, permCheck, outbox);
    const catSvc = new CategoryHierarchyService(tenantPrisma, permCheck);

    const stubCtx = new StubActorContext() as unknown as ActorContextService;
    storeCtl = new StoreController(
      storeSvc,
      productSvc,
      inventorySvc,
      orderSvc,
      approvalSvc,
      externalSvc,
      shippingSvc,
      revenueSvc,
      stubCtx,
    );
    advCtl = new StoreAdvancedController(
      stubCtx,
      adjSvc,
      promoSvc,
      loyaltySvc,
      gcSvc,
      wlSvc,
      psSvc,
      catSvc,
    );
    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
  });

  describe('StoreController', () => {
    it('lists + reads + patches stores', async () => {
      const list = await withTestTenant(async () => storeCtl.listStores());
      expect(list.length).toBeGreaterThan(0);
      const all = await withTestTenant(async () => storeCtl.listStores('true'));
      expect(all.length).toBeGreaterThanOrEqual(list.length);
      const single = await withTestTenant(async () => storeCtl.getStore(TEST_STORE_STUDENT_ID));
      expect(single.id).toBe(TEST_STORE_STUDENT_ID);
      const patched = await withTestTenant(async () =>
        storeCtl.patchStore(TEST_STORE_STUDENT_ID, { description: 'patched' } as any, req as any),
      );
      expect(patched.description).toBe('patched');
    });

    it('lists + reads + patches products', async () => {
      const list = await withTestTenant(async () => storeCtl.listProducts(TEST_STORE_STUDENT_ID));
      expect(list.length).toBeGreaterThan(0);
      const p = await withTestTenant(async () => storeCtl.getProduct(TEST_PRODUCT_A_ID));
      expect(p.id).toBe(TEST_PRODUCT_A_ID);
      const patched = await withTestTenant(async () =>
        storeCtl.patchProduct(TEST_PRODUCT_A_ID, { description: 'updated' } as any, req as any),
      );
      expect(patched.description).toBe('updated');
    });

    it('inventory dashboard + adjust', async () => {
      const dash = await withTestTenant(async () => storeCtl.inventoryDashboard());
      expect(dash.length).toBeGreaterThan(0);
      await withTestTenant(async () =>
        storeCtl.adjustInventory(TEST_INVENTORY_A_ID, { quantityOnHand: 50 } as any, req as any),
      );
    });

    it('lists + creates external customers, shipping options, revenue', async () => {
      const ec = await withTestTenant(async () =>
        storeCtl.registerExternalCustomer({ name: 'EC', email: 'ec@test' } as any),
      );
      const ecList = await withTestTenant(async () => storeCtl.listExternalCustomers(req as any));
      expect(ecList.map((c) => c.id)).toContain(ec.id);

      const opt = await withTestTenant(async () =>
        storeCtl.createShippingOption(
          { storeId: TEST_STORE_PUBLIC_ID, methodName: 'Std', flatRate: 5 } as any,
          req as any,
        ),
      );
      const optList = await withTestTenant(async () =>
        storeCtl.listShippingOptions(TEST_STORE_PUBLIC_ID),
      );
      expect(optList.map((o) => o.id)).toContain(opt.id);

      const rev = await withTestTenant(async () =>
        storeCtl.materialiseRevenue(
          {
            storeId: TEST_STORE_STUDENT_ID,
            periodStart: '2026-01-01',
            periodEnd: '2026-01-31',
          } as any,
          req as any,
        ),
      );
      const revList = await withTestTenant(async () => storeCtl.listRevenue(req as any));
      expect(revList.map((r) => r.id)).toContain(rev.id);
    });
  });

  describe('StoreAdvancedController', () => {
    it('promotions endpoints — list/create/get/patch/applyPromoCode', async () => {
      const created = await withTestTenant(async () =>
        advCtl.createPromotion(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'Promo',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            startsAt: '2020-01-01T00:00:00Z',
            endsAt: '2030-01-01T00:00:00Z',
            promoCode: 'CTLPROMO',
          } as any,
        ),
      );
      const list = await withTestTenant(async () => advCtl.listPromotions(req as any));
      expect(list.map((p) => p.id)).toContain(created.id);
      const detail = await withTestTenant(async () => advCtl.getPromotion(req as any, created.id));
      expect(detail.id).toBe(created.id);
      const patched = await withTestTenant(async () =>
        advCtl.patchPromotion(req as any, created.id, { name: 'New' } as any),
      );
      expect(patched.name).toBe('New');
      const applied = await withTestTenant(async () =>
        advCtl.applyPromoCode(
          req as any,
          { storeId: TEST_STORE_STUDENT_ID, promoCode: 'CTLPROMO' } as any,
        ),
      );
      expect(applied.currentUses).toBe(1);
    });

    it('loyalty endpoints — config + earn + balance + adjust + redeem', async () => {
      await withTestTenant(async () =>
        advCtl.upsertLoyaltyConfig(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            pointsPerDollar: 1,
            redemptionRateCents: 1,
            minRedemptionPoints: 100,
            isEnabled: true,
          } as any,
        ),
      );
      const cfg = await withTestTenant(async () =>
        advCtl.getLoyaltyConfig(req as any, TEST_STORE_STUDENT_ID),
      );
      expect(cfg.isEnabled).toBe(true);

      await withTestTenant(async () =>
        advCtl.earnLoyalty(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 500,
          } as any,
        ),
      );
      const bal = await withTestTenant(async () =>
        advCtl.getLoyaltyBalance(req as any, TEST_STORE_STUDENT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(bal.balance).toBe(500);

      await withTestTenant(async () =>
        advCtl.adjustLoyalty(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 50,
            reason: 'adjustment',
          } as any,
        ),
      );
      await withTestTenant(async () =>
        advCtl.redeemLoyalty(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 200,
          } as any,
        ),
      );
      const txs = await withTestTenant(async () =>
        advCtl.listLoyaltyTransactions(req as any, TEST_STORE_STUDENT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(txs.length).toBeGreaterThan(0);
    });

    it('gift card endpoints — issue + redeem + topUp + cancel + list + getByCode', async () => {
      const card = await withTestTenant(async () =>
        advCtl.issueGiftCard(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            initialBalanceCents: 5000,
          } as any,
        ),
      );
      const list = await withTestTenant(async () =>
        advCtl.listGiftCards(req as any, TEST_STORE_STUDENT_ID),
      );
      expect(list.map((c) => c.id)).toContain(card.id);

      const detail = await withTestTenant(async () =>
        advCtl.getGiftCardByCode(req as any, card.cardCode),
      );
      expect(detail.id).toBe(card.id);

      await withTestTenant(async () =>
        advCtl.redeemGiftCard(
          req as any,
          {
            cardCode: card.cardCode,
            amountCents: 1000,
          } as any,
        ),
      );
      await withTestTenant(async () =>
        advCtl.topUpGiftCard(req as any, card.id, { amountCents: 500 } as any),
      );
      const cancelled = await withTestTenant(async () =>
        advCtl.cancelGiftCard(req as any, card.id, { reason: 'lost' } as any),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('wishlist endpoints', async () => {
      await withTestTenant(async () =>
        advCtl.addWishlist(req as any, TEST_ADMIN_PERSON_ID, {
          productId: TEST_PRODUCT_A_ID,
        } as any),
      );
      const list = await withTestTenant(async () =>
        advCtl.listWishlist(req as any, TEST_ADMIN_PERSON_ID),
      );
      expect(list.length).toBe(1);
      await withTestTenant(async () =>
        advCtl.updateWishlist(req as any, TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID, {
          notifyOnRestock: false,
        } as any),
      );
      await withTestTenant(async () =>
        advCtl.removeWishlist(req as any, TEST_ADMIN_PERSON_ID, TEST_PRODUCT_A_ID),
      );
    });

    it('category endpoints', async () => {
      const root = await withTestTenant(async () =>
        advCtl.createCategory(
          req as any,
          {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'Cat',
          } as any,
        ),
      );
      const tree = await withTestTenant(async () =>
        advCtl.getCategoryTree(req as any, TEST_STORE_STUDENT_ID),
      );
      expect(tree.length).toBeGreaterThan(0);
      const got = await withTestTenant(async () => advCtl.getCategory(req as any, root.id));
      expect(got.id).toBe(root.id);
      await withTestTenant(async () =>
        advCtl.patchCategory(req as any, root.id, { name: 'Renamed' } as any),
      );
      await withTestTenant(async () => advCtl.removeCategory(req as any, root.id));
    });

    it('price schedule endpoints', async () => {
      const sched = await withTestTenant(async () =>
        advCtl.createPriceSchedule(
          req as any,
          {
            productId: TEST_PRODUCT_A_ID,
            scheduledPrice: 99,
            effectiveFrom: '2099-01-01T00:00:00Z',
          } as any,
        ),
      );
      const list = await withTestTenant(async () =>
        advCtl.listPriceSchedules(req as any, TEST_PRODUCT_A_ID),
      );
      expect(list.map((s) => s.id)).toContain(sched.id);
      await withTestTenant(async () => advCtl.removePriceSchedule(req as any, sched.id));
    });

    it('inventory adjustment endpoints', async () => {
      await withTestTenant(async () =>
        advCtl.adjustInventory(
          req as any,
          {
            productId: TEST_PRODUCT_A_ID,
            inventoryId: TEST_INVENTORY_A_ID,
            adjustmentType: 'RECOUNT',
            quantityDelta: 1,
            reason: 'controller test adjustment',
          } as any,
        ),
      );
      const list = await withTestTenant(async () =>
        advCtl.listInventoryAdjustments(req as any, TEST_PRODUCT_A_ID),
      );
      expect(list.length).toBeGreaterThan(0);
    });
  });
});
