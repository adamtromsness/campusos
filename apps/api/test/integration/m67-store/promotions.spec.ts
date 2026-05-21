import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { PromotionService } from '@modules/m67-store/promotions/promotion.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_B_STUDENT_ID,
  TEST_PRODUCT_A_ID,
  TEST_PRODUCT_B_ID,
} from '../fixtures/store';

describe('integration:m67-store/promotions', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: PromotionService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    service = new PromotionService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'str.promotion.code_redeemed'`,
    );
  });

  // ────────────────────────────────────────────────────────
  // CRUD
  // ────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a PERCENTAGE promo with product list + lands str_promotion_products rows', async () => {
      const promo = await withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: '20% off T-Shirts',
          discountType: 'PERCENTAGE',
          discountValue: 20,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-01T00:00:00Z',
          promoCode: 'SHIRT20',
          maxUses: 100,
          productIds: [TEST_PRODUCT_A_ID, TEST_PRODUCT_B_ID],
        } as any),
      );
      expect(promo.discountType).toBe('PERCENTAGE');
      expect(promo.discountValue).toBe(20);
      expect(promo.productIds.sort()).toEqual([TEST_PRODUCT_A_ID, TEST_PRODUCT_B_ID].sort());
      expect(promo.maxUses).toBe(100);

      const products = (await rawClient.$queryRawUnsafe(
        `SELECT product_id::text AS pid FROM ${TEST_SCHEMA}.str_promotion_products WHERE promotion_id = $1::uuid`,
        promo.id,
      )) as Array<{ pid: string }>;
      expect(products).toHaveLength(2);
    });

    it('PERCENTAGE > 100 → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'bad',
            discountType: 'PERCENTAGE',
            discountValue: 150,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('endsAt <= startsAt → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'bad date',
            discountType: 'FLAT_AMOUNT',
            discountValue: 5,
            startsAt: '2027-01-01T00:00:00Z',
            endsAt: '2026-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-store productId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'mixed',
            discountType: 'FLAT_AMOUNT',
            discountValue: 5,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
            productIds: ['00000000-0000-0000-0000-000000000099'],
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school store → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_B_STUDENT_ID,
            name: 'x-school',
            discountType: 'FLAT_AMOUNT',
            discountValue: 5,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('duplicate promo_code → ConflictException', async () => {
      await withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'A',
          discountType: 'FLAT_AMOUNT',
          discountValue: 5,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-01T00:00:00Z',
          promoCode: 'DUP1',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'B',
            discountType: 'FLAT_AMOUNT',
            discountValue: 5,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
            promoCode: 'DUP1',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('non-admin create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: 'x',
            discountType: 'PERCENTAGE',
            discountValue: 10,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('all 4 discount types accepted', async () => {
      for (const t of ['PERCENTAGE', 'FLAT_AMOUNT', 'BOGO', 'FREE_SHIPPING'] as const) {
        const promo = await withTestTenant(async () =>
          service.create(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            name: `${t} promo`,
            discountType: t,
            discountValue: t === 'PERCENTAGE' ? 5 : 5,
            startsAt: '2026-01-01T00:00:00Z',
            endsAt: '2027-01-01T00:00:00Z',
          } as any),
        );
        expect(promo.discountType).toBe(t);
      }
    });
  });

  describe('list / getById', () => {
    async function makePromo(code: string) {
      return withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: code,
          discountType: 'PERCENTAGE',
          discountValue: 10,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-01T00:00:00Z',
          promoCode: code,
        } as any),
      );
    }

    it('list returns active promotions by default', async () => {
      const p = await makePromo('LIST1');
      const list = await withTestTenant(async () =>
        service.list(adminActor(), TEST_STORE_STUDENT_ID),
      );
      expect(list.map((x) => x.id)).toContain(p.id);
    });

    it('list includeInactive=true returns deactivated', async () => {
      const p = await makePromo('LIST2');
      await withTestTenant(async () =>
        service.patch(adminActor(), p.id, { isActive: false } as any),
      );
      const active = await withTestTenant(async () =>
        service.list(adminActor(), TEST_STORE_STUDENT_ID),
      );
      expect(active.map((x) => x.id)).not.toContain(p.id);
      const all = await withTestTenant(async () =>
        service.list(adminActor(), TEST_STORE_STUDENT_ID, true),
      );
      expect(all.map((x) => x.id)).toContain(p.id);
    });

    it('getById returns detail with productIds', async () => {
      const p = await withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'GET1',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-01T00:00:00Z',
          productIds: [TEST_PRODUCT_A_ID],
        } as any),
      );
      const detail = await withTestTenant(async () => service.getById(adminActor(), p.id));
      expect(detail.productIds).toEqual([TEST_PRODUCT_A_ID]);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById(adminActor(), '00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('patch', () => {
    async function makePromo() {
      return withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'P',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          startsAt: '2026-01-01T00:00:00Z',
          endsAt: '2027-01-01T00:00:00Z',
        } as any),
      );
    }

    it('admin patches name/value/isActive', async () => {
      const p = await makePromo();
      const updated = await withTestTenant(async () =>
        service.patch(adminActor(), p.id, {
          name: 'Renamed',
          discountValue: 15,
          maxUses: 50,
          isActive: false,
          description: 'new desc',
        } as any),
      );
      expect(updated.name).toBe('Renamed');
      expect(updated.discountValue).toBe(15);
      expect(updated.maxUses).toBe(50);
      expect(updated.isActive).toBe(false);
    });

    it('patch PERCENTAGE value > 100 → BadRequestException', async () => {
      const p = await makePromo();
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), p.id, { discountValue: 200 } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch with new startsAt > current endsAt → BadRequestException', async () => {
      const p = await makePromo();
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), p.id, { startsAt: '2028-01-01T00:00:00Z' } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.patch(adminActor(), '00000000-0000-0000-0000-000000000000', {
            name: 'x',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch is a no-op', async () => {
      const p = await makePromo();
      const after = await withTestTenant(async () => service.patch(adminActor(), p.id, {} as any));
      expect(after.id).toBe(p.id);
    });
  });

  describe('applyPromoCode (KEYSTONE)', () => {
    async function makeActivePromo(code: string, maxUses?: number | null) {
      return withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: `Promo ${code}`,
          discountType: 'FLAT_AMOUNT',
          discountValue: 5,
          startsAt: '2020-01-01T00:00:00Z',
          endsAt: '2030-01-01T00:00:00Z',
          promoCode: code,
          maxUses: maxUses ?? null,
        } as any),
      );
    }

    it('apply increments current_uses + enqueues outbox event', async () => {
      const p = await makeActivePromo('APPLYOK', 5);
      const updated = await withTestTenant(async () =>
        service.applyPromoCode(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          promoCode: 'APPLYOK',
        } as any),
      );
      expect(updated.currentUses).toBe(1);

      const outbox = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'str.promotion.code_redeemed' AND message_key = $1`,
        p.id,
      )) as unknown[];
      expect(outbox).toHaveLength(1);
    });

    it('max_uses=2: 3rd apply rejected; current_uses stays at 2', async () => {
      const p = await makeActivePromo('CAP2', 2);
      await withTestTenant(async () =>
        service.applyPromoCode(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          promoCode: 'CAP2',
        } as any),
      );
      await withTestTenant(async () =>
        service.applyPromoCode(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          promoCode: 'CAP2',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.applyPromoCode(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            promoCode: 'CAP2',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT current_uses FROM ${TEST_SCHEMA}.str_promotions WHERE id = $1::uuid`,
        p.id,
      )) as Array<{ current_uses: number }>;
      expect(rows[0]!.current_uses).toBe(2);
    });

    it('inactive promo → ConflictException', async () => {
      const p = await makeActivePromo('INACTIVE', null);
      await withTestTenant(async () =>
        service.patch(adminActor(), p.id, { isActive: false } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.applyPromoCode(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            promoCode: 'INACTIVE',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('out-of-window promo → ConflictException', async () => {
      await withTestTenant(async () =>
        service.create(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          name: 'Future',
          discountType: 'FLAT_AMOUNT',
          discountValue: 1,
          startsAt: '2099-01-01T00:00:00Z',
          endsAt: '2099-02-01T00:00:00Z',
          promoCode: 'FUTURE',
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.applyPromoCode(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            promoCode: 'FUTURE',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('unknown code → ConflictException', async () => {
      await expect(
        withTestTenant(async () =>
          service.applyPromoCode(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            promoCode: 'UNKNOWN1',
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cross-school store → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.applyPromoCode(adminActor(), {
            storeId: TEST_STORE_B_STUDENT_ID,
            promoCode: 'XSCHOOL',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
