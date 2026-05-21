import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { GiftCardService } from '@modules/m67-store/gift-cards/gift-card.service';
import { PermissionCheckService } from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor } from '../helpers/actor';
import {
  ensureStoreSeed,
  resetStoreTables,
  TEST_STORE_STUDENT_ID,
  TEST_STORE_B_STUDENT_ID,
} from '../fixtures/store';

describe('integration:m67-store/gift-cards', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: GiftCardService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();
    service = new GiftCardService(tenantPrisma, permCheck, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetStoreTables(rawClient);
    await ensureStoreSeed(rawClient);
    // Clear outbox between tests
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'str.gift_card.depleted'`,
    );
  });

  describe('issue', () => {
    it('admin issues a gift card with $100 balance + PURCHASE ledger row', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 10000,
          recipientEmail: 'recipient@example.com',
        } as any),
      );
      expect(card.initialBalanceCents).toBe(10000);
      expect(card.currentBalanceCents).toBe(10000);
      expect(card.status).toBe('ACTIVE');
      expect(card.cardCode).toMatch(/^[A-Z0-9]{16}$/);

      // PURCHASE ledger row
      const tx = (await rawClient.$queryRawUnsafe(
        `SELECT transaction_type, amount_cents FROM ${TEST_SCHEMA}.str_gift_card_transactions WHERE card_id = $1::uuid`,
        card.id,
      )) as Array<{ transaction_type: string; amount_cents: number }>;
      expect(tx).toHaveLength(1);
      expect(tx[0]!.transaction_type).toBe('PURCHASE');
      expect(Number(tx[0]!.amount_cents)).toBe(10000);
    });

    it('issue against cross-school store → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.issue(adminActor(), {
            storeId: TEST_STORE_B_STUDENT_ID,
            initialBalanceCents: 5000,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('student persona cannot issue → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.issue(studentActor(), {
            storeId: TEST_STORE_STUDENT_ID,
            initialBalanceCents: 5000,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('redeem (KEYSTONE)', () => {
    it('redeem $60 against a $100 balance → balance $40, REDEMPTION ledger row', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 10000,
        } as any),
      );
      const { card: after, transaction } = await withTestTenant(async () =>
        service.redeem(adminActor(), {
          cardCode: card.cardCode,
          amountCents: 6000,
        } as any),
      );
      expect(after.currentBalanceCents).toBe(4000);
      expect(after.status).toBe('ACTIVE');
      expect(transaction.transactionType).toBe('REDEMPTION');
      expect(transaction.amountCents).toBe(6000);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT current_balance_cents FROM ${TEST_SCHEMA}.str_gift_cards WHERE id = $1::uuid`,
        card.id,
      )) as Array<{ current_balance_cents: number }>;
      expect(Number(rows[0]!.current_balance_cents)).toBe(4000);
    });

    it('redeem more than balance → ConflictException; balance unchanged; no ledger row', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            cardCode: card.cardCode,
            amountCents: 6000,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      const balance = (await rawClient.$queryRawUnsafe(
        `SELECT current_balance_cents FROM ${TEST_SCHEMA}.str_gift_cards WHERE id = $1::uuid`,
        card.id,
      )) as Array<{ current_balance_cents: number }>;
      expect(Number(balance[0]!.current_balance_cents)).toBe(5000);

      const ledger = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.str_gift_card_transactions WHERE card_id = $1::uuid AND transaction_type = 'REDEMPTION'`,
        card.id,
      )) as unknown[];
      expect(ledger).toHaveLength(0);
    });

    it('redeem to exactly $0 flips status to DEPLETED and enqueues outbox event', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      const { card: after } = await withTestTenant(async () =>
        service.redeem(adminActor(), {
          cardCode: card.cardCode,
          amountCents: 5000,
        } as any),
      );
      expect(after.status).toBe('DEPLETED');
      expect(after.currentBalanceCents).toBe(0);

      const outbox = (await rawClient.$queryRawUnsafe(
        `SELECT topic, message_key FROM platform.platform_outbox WHERE topic = 'str.gift_card.depleted' AND message_key = $1`,
        card.id,
      )) as Array<{ topic: string; message_key: string }>;
      expect(outbox).toHaveLength(1);
    });

    it('redeem against unknown card code → ConflictException', async () => {
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            cardCode: 'NOTREALCARD12345',
            amountCents: 100,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('redeem against cancelled card → ConflictException', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.cancel(adminActor(), card.id, { reason: 'X' } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            cardCode: card.cardCode,
            amountCents: 100,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cross-school card from School A context → ConflictException', async () => {
      const card = await withTestTenantB(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_B_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            cardCode: card.cardCode,
            amountCents: 100,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('expired card → ConflictException', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.str_gift_cards (id, store_id, card_code, initial_balance_cents, current_balance_cents, status, expires_at)
         VALUES ($1::uuid, $2::uuid, 'EXPIREDCARD12345', 5000, 5000, 'ACTIVE', '2020-01-01')`,
        id,
        TEST_STORE_STUDENT_ID,
      );
      await expect(
        withTestTenant(async () =>
          service.redeem(adminActor(), {
            cardCode: 'EXPIREDCARD12345',
            amountCents: 100,
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('topUp', () => {
    it('admin tops up active card', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      const { card: after } = await withTestTenant(async () =>
        service.topUp(adminActor(), card.id, { amountCents: 2000 } as any),
      );
      expect(after.currentBalanceCents).toBe(7000);
    });

    it('top up restores DEPLETED card to ACTIVE', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.redeem(adminActor(), { cardCode: card.cardCode, amountCents: 5000 } as any),
      );
      const { card: revived } = await withTestTenant(async () =>
        service.topUp(adminActor(), card.id, { amountCents: 1000 } as any),
      );
      expect(revived.status).toBe('ACTIVE');
      expect(revived.currentBalanceCents).toBe(1000);
    });

    it('top up CANCELLED card → BadRequestException', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.cancel(adminActor(), card.id, { reason: 'X' } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.topUp(adminActor(), card.id, { amountCents: 1000 } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('top up unknown card → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.topUp(adminActor(), '00000000-0000-0000-0000-000000000000', {
            amountCents: 100,
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('top up cross-school card → NotFoundException', async () => {
      const card = await withTestTenantB(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_B_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          service.topUp(adminActor(), card.id, { amountCents: 1000 } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('cancel', () => {
    it('admin cancels active card', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      const cancelled = await withTestTenant(async () =>
        service.cancel(adminActor(), card.id, { reason: 'Lost card' } as any),
      );
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('double cancel → BadRequestException', async () => {
      const card = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.cancel(adminActor(), card.id, { reason: 'X' } as any),
      );
      await expect(
        withTestTenant(async () => service.cancel(adminActor(), card.id, { reason: 'Y' } as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel cross-school card → NotFoundException', async () => {
      const card = await withTestTenantB(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_B_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await expect(
        withTestTenant(async () => service.cancel(adminActor(), card.id, { reason: 'X' } as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list / getByCode', () => {
    it('list returns cards filtered by store and status', async () => {
      const a = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      const b = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.redeem(adminActor(), { cardCode: b.cardCode, amountCents: 5000 } as any),
      );
      const allList = await withTestTenant(async () =>
        service.list(adminActor(), TEST_STORE_STUDENT_ID),
      );
      expect(allList.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

      const depleted = await withTestTenant(async () =>
        service.list(adminActor(), TEST_STORE_STUDENT_ID, 'DEPLETED'),
      );
      expect(depleted.map((c) => c.id)).toEqual([b.id]);
    });

    it('getByCode returns card with transactions', async () => {
      const c = await withTestTenant(async () =>
        service.issue(adminActor(), {
          storeId: TEST_STORE_STUDENT_ID,
          initialBalanceCents: 5000,
        } as any),
      );
      await withTestTenant(async () =>
        service.redeem(adminActor(), { cardCode: c.cardCode, amountCents: 1000 } as any),
      );
      const detail = await withTestTenant(async () => service.getByCode(adminActor(), c.cardCode));
      expect(detail.transactions.length).toBeGreaterThanOrEqual(2);
    });

    it('getByCode for unknown code → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => service.getByCode(adminActor(), 'UNKNOWNCARDCODE1')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
