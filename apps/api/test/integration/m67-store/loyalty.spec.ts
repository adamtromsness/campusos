import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { LoyaltyService } from '@modules/m67-store/loyalty/loyalty.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  TEST_ADMIN_PERSON_ID,
  TEST_TEACHER_PERSON_ID,
} from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_B_STUDENT_ID,
} from '../fixtures/store';

describe('integration:m67-store/loyalty', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: LoyaltyService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    service = new LoyaltyService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
  });

  describe('config CRUD', () => {
    it('upsertConfig creates a config and getConfig reads it back', async () => {
      const dto = await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 2,
          redemptionRateCents: 1,
          minRedemptionPoints: 100,
          isEnabled: true,
        } as any),
      );
      expect(dto.pointsPerDollar).toBe(2);
      expect(dto.isEnabled).toBe(true);

      const reread = await withTestTenant(async () =>
        service.getConfig(adminActor(), TEST_STORE_STUDENT_ID),
      );
      expect(reread.pointsPerDollar).toBe(2);
    });

    it('upsertConfig updates existing config', async () => {
      await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 1,
          redemptionRateCents: 1,
          minRedemptionPoints: 100,
          isEnabled: false,
        } as any),
      );
      const updated = await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 5,
          redemptionRateCents: 2,
          minRedemptionPoints: 200,
          isEnabled: true,
        } as any),
      );
      expect(updated.pointsPerDollar).toBe(5);
      expect(updated.isEnabled).toBe(true);
    });

    it('non-admin upsertConfig → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.upsertConfig(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            pointsPerDollar: 1,
            redemptionRateCents: 1,
            minRedemptionPoints: 100,
            isEnabled: true,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school store → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.upsertConfig(adminActor(), {
            storeId: TEST_STORE_B_STUDENT_ID,
            pointsPerDollar: 1,
            redemptionRateCents: 1,
            minRedemptionPoints: 100,
            isEnabled: true,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('getConfig for missing config → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getConfig(adminActor(), TEST_STORE_STUDENT_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('earn / adjust / balance', () => {
    beforeEach(async () => {
      await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 1,
          redemptionRateCents: 1,
          minRedemptionPoints: 100,
          isEnabled: true,
        } as any),
      );
    });

    it('earn writes an EARNED ledger row', async () => {
      const tx = await withTestTenant(async () =>
        service.earn(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 50,
        } as any),
      );
      expect(tx.transactionType).toBe('EARNED');
      expect(tx.points).toBe(50);
    });

    it('getBalance sums EARNED + ADJUSTMENT - REDEEMED', async () => {
      await withTestTenant(async () =>
        service.earn(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 200,
        } as any),
      );
      await withTestTenant(async () =>
        service.adjust(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 30,
          reason: 'manual correction',
        } as any),
      );
      const bal = await withTestTenant(async () =>
        service.getBalance(adminActor(), TEST_STORE_STUDENT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(bal.balance).toBe(230);
    });

    it('non-admin earn → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.earn(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listTransactions returns ledger rows for a customer', async () => {
      await withTestTenant(async () =>
        service.earn(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 50,
        } as any),
      );
      const list = await withTestTenant(async () =>
        service.listTransactions(adminActor(), TEST_STORE_STUDENT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(list.length).toBeGreaterThan(0);
    });

    it('earn for non-affiliated personId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.earn(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: '00000000-0000-0000-0000-000000000099',
            points: 1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('redeem (KEYSTONE)', () => {
    beforeEach(async () => {
      await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 1,
          redemptionRateCents: 1,
          minRedemptionPoints: 100,
          isEnabled: true,
        } as any),
      );
      // Seed a high balance for the admin customer
      await withTestTenant(async () =>
        service.earn(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 1000,
        } as any),
      );
    });

    it('admin can redeem on behalf of admin customer', async () => {
      const tx = await withTestTenant(async () =>
        service.redeem(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          customerPersonId: TEST_ADMIN_PERSON_ID,
          points: 200,
        } as any),
      );
      expect(tx.points).toBe(200);
      expect(tx.transactionType).toBe('REDEEMED');

      const bal = await withTestTenant(async () =>
        service.getBalance(adminActor(), TEST_STORE_STUDENT_ID, TEST_ADMIN_PERSON_ID),
      );
      expect(bal.balance).toBe(800);
    });

    it('redeem below min_redemption_points → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 50,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('redeem above balance → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 5000,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('disabled config → BadRequestException', async () => {
      await withTestTenant(async () =>
        service.upsertConfig(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          pointsPerDollar: 1,
          redemptionRateCents: 1,
          minRedemptionPoints: 100,
          isEnabled: false,
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: TEST_ADMIN_PERSON_ID,
            points: 200,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-affiliated person → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            customerPersonId: '00000000-0000-0000-0000-000000000099',
            points: 200,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
