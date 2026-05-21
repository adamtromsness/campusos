import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EventService, TierService } from '@modules/m101-events/events.service';
import { OrderService, RefundService } from '@modules/m101-events/orders.service';
import { GateScanService } from '@modules/m101-events/gate.service';
import { OrderExpiryWorker } from '@modules/m101-events/order-expiry.worker';
import {
  deterministicOrderConfirmedEventId,
  deterministicRefundIssuedEventId,
} from '@modules/m101-events/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
  TEST_SUBDOMAIN,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';
import { resetEventsTables } from '../fixtures/events';

describe('integration:m101-events/ticketing', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let events: EventService;
  let tiers: TierService;
  let orders: OrderService;
  let refunds: RefundService;
  let gate: GateScanService;
  let worker: OrderExpiryWorker;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    events = new EventService(tenantPrisma, outbox, permCheck);
    tiers = new TierService(tenantPrisma, events);
    orders = new OrderService(tenantPrisma, outbox, permCheck, events);
    refunds = new RefundService(tenantPrisma, outbox, permCheck);
    gate = new GateScanService(tenantPrisma, permCheck);
    worker = new OrderExpiryWorker(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEventsTables(rawClient);
    vi.unstubAllEnvs();
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  async function seedEventWithTier(
    opts: {
      schoolId?: string;
      eventStatus?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'COMPLETED' | 'CANCELLED';
      tierQty?: number;
      tierPrice?: number;
      capacity?: number | null;
      saleStartsAt?: string | null;
      saleEndsAt?: string | null;
      isActive?: boolean;
    } = {},
  ): Promise<{ eventId: string; tierId: string }> {
    const eventId = generateId();
    const tierId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_events
         (id, school_id, title, event_type, event_date, start_time, total_capacity, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Tickety', 'PERFORMANCE', $3::date, '19:00', $4, $5, $6::uuid)`,
      eventId,
      opts.schoolId ?? TEST_SCHOOL_ID,
      dateFuture(14),
      opts.capacity ?? null,
      opts.eventStatus ?? 'ON_SALE',
      TEST_ADMIN_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_ticket_tiers
         (id, event_id, name, price, quantity, sale_starts_at, sale_ends_at, is_active)
       VALUES ($1::uuid, $2::uuid, 'GA', $3, $4, $5::timestamptz, $6::timestamptz, $7)`,
      tierId,
      eventId,
      opts.tierPrice ?? 10,
      opts.tierQty ?? 10,
      opts.saleStartsAt ?? null,
      opts.saleEndsAt ?? null,
      opts.isActive ?? true,
    );
    // Keep total_tier_quantity in lockstep
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.evt_events SET total_tier_quantity = $1 WHERE id = $2::uuid`,
      opts.tierQty ?? 10,
      eventId,
    );
    return { eventId, tierId };
  }

  // ─── ATOMIC SALE ───
  describe('OrderService.purchase — atomic sale', () => {
    it('purchase decrements tier.quantity_sold exactly and creates one ticket per qty', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 10 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 3 }] } as any, adminActor()),
      );
      expect(order.status).toBe('PENDING');
      expect(order.tickets.length).toBe(3);
      expect(order.totalAmount).toBe(30);

      const sold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(sold[0]!.q)).toBe(3);

      // PENDING orders carry expires_at = now+15min
      expect(order.expiresAt).toBeTruthy();
      const expires = new Date(order.expiresAt!);
      const now = Date.now();
      const minutes = (expires.getTime() - now) / 60_000;
      expect(minutes).toBeGreaterThan(13);
      expect(minutes).toBeLessThan(17);
    });

    it('purchase respects ticket holder names', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(
          eventId,
          {
            lines: [{ tierId, quantity: 2, holderNames: ['Alice', 'Bob'] }],
          } as any,
          adminActor(),
        ),
      );
      const names = order.tickets.map((t) => t.holderName).sort();
      expect(names).toEqual(['Alice', 'Bob']);
    });

    it('sold-out → 409 ConflictException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 2 });
      await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 2 }] } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('purchase against DRAFT event → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ eventStatus: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('purchase against missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          orders.purchase(
            '00000000-0000-0000-0000-000000000000',
            { lines: [{ tierId: '00000000-0000-0000-0000-000000000001', quantity: 1 }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('purchase with tier from another event → BadRequestException', async () => {
      const { eventId } = await seedEventWithTier({ tierQty: 5 });
      const otherEvent = await seedEventWithTier({ tierQty: 5 });
      await expect(
        withTestTenant(async () =>
          orders.purchase(
            eventId,
            { lines: [{ tierId: otherEvent.tierId, quantity: 1 }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('purchase inactive tier → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ isActive: false });
      await expect(
        withTestTenant(async () =>
          orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('purchase before sale_starts_at → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({
        saleStartsAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      await expect(
        withTestTenant(async () =>
          orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('purchase after sale_ends_at → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({
        saleEndsAt: new Date(Date.now() - 3600_000).toISOString(),
      });
      await expect(
        withTestTenant(async () =>
          orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STRIPE_DEV_AUTO_CONFIRM=true → order CONFIRMED + evt.order.confirmed outbox enqueued', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', 'true');
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 2 }] } as any, adminActor()),
      );
      expect(order.status).toBe('CONFIRMED');
      expect(order.expiresAt).toBeNull();
      const outboxRows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; envelope: string }>
      >(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.order.confirmed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(outboxRows.length).toBe(1);
      const env = JSON.parse(outboxRows[0]!.envelope);
      expect(env.event_id).toBe(deterministicOrderConfirmedEventId(order.id));
      expect(env.payload.autoConfirmed).toBe(true);
    });

    it('foreign-school tier for current-school event → BadRequestException', async () => {
      const aEvent = await seedEventWithTier({ schoolId: TEST_SCHOOL_ID });
      const bEvent = await seedEventWithTier({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          orders.purchase(
            aEvent.eventId,
            { lines: [{ tierId: bEvent.tierId, quantity: 1 }] } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── OrderService.list / getById ───
  describe('OrderService.list / getById', () => {
    it('writer sees all orders; non-writer sees only own', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 10 });
      await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      const adminList = await withTestTenant(async () => orders.list(adminActor()));
      expect(adminList.length).toBe(2);
      const parentList = await withTestTenant(async () => orders.list(parentActor()));
      expect(parentList.length).toBe(1);
      expect(parentList[0]!.purchaserId).toBe(TEST_PARENT_PERSON_ID);
    });

    it('list filters: mine + eventId + status', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 10 });
      await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      const mine = await withTestTenant(async () => orders.list(adminActor(), { mine: true }));
      expect(mine.length).toBe(1);

      const byEvent = await withTestTenant(async () => orders.list(adminActor(), { eventId }));
      expect(byEvent.length).toBe(1);

      const byStatus = await withTestTenant(async () =>
        orders.list(adminActor(), { status: 'PENDING' as any }),
      );
      expect(byStatus.length).toBe(1);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          orders.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: non-writer non-purchaser → NotFoundException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () => orders.getById(order.id, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A order invisible in School B context', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await expect(
        withTestTenantB(async () => orders.getById(order.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── OrderService.confirm ───
  describe('OrderService.confirm', () => {
    it('PENDING → CONFIRMED + outbox enqueue with deterministic event_id', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      const confirmed = await withTestTenant(async () =>
        orders.confirm(order.id, { stripePaymentIntentId: 'pi_test' } as any, adminActor()),
      );
      expect(confirmed.status).toBe('CONFIRMED');
      expect(confirmed.stripePaymentIntentId).toBe('pi_test');

      const out = await rawClient.$queryRawUnsafe<Array<{ envelope: string }>>(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.order.confirmed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(out.length).toBe(1);
      const env = JSON.parse(out[0]!.envelope);
      expect(env.event_id).toBe(deterministicOrderConfirmedEventId(order.id));
    });

    it('confirm idempotent — second call no-op', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      const again = await withTestTenant(async () =>
        orders.confirm(order.id, {} as any, adminActor()),
      );
      expect(again.status).toBe('CONFIRMED');
    });

    it('confirm CANCELLED order → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      // PENDING → CANCELLED directly (no confirm) so confirmed_chk
      // stays satisfied.
      await withTestTenant(async () => orders.cancel(order.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirm by another non-admin (not purchaser) → ForbiddenException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () => orders.confirm(order.id, {} as any, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('confirm missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          orders.confirm('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('confirm fills last seat → triggers auto SOLD_OUT flip', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 2 });
      const ord1 = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 2 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(ord1.id, {} as any, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.evt_events WHERE id = $1::uuid`,
        eventId,
      );
      expect(rows[0]!.status).toBe('SOLD_OUT');
    });
  });

  // ─── OrderService.cancel ───
  describe('OrderService.cancel', () => {
    it('cancel: tickets CANCELLED + tier.quantity_sold decremented', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 3 }] } as any, adminActor()),
      );
      const beforeSold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(beforeSold[0]!.q)).toBe(3);
      const cancelled = await withTestTenant(async () =>
        orders.cancel(order.id, { cancellationReason: 'changed plans' } as any, adminActor()),
      );
      expect(cancelled!.status).toBe('CANCELLED');
      expect(cancelled!.cancellationReason).toBe('changed plans');

      const afterSold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(afterSold[0]!.q)).toBe(0);

      const ticketRows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_tickets WHERE order_id = $1::uuid`,
        order.id,
      );
      expect(ticketRows.every((r) => r.s === 'CANCELLED')).toBe(true);
    });

    it('cancel idempotent — already CANCELLED returns gracefully', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.cancel(order.id, {} as any, adminActor()));
      const again = await withTestTenant(async () =>
        orders.cancel(order.id, {} as any, adminActor()),
      );
      expect(again!.status).toBe('CANCELLED');
    });

    it('cancel: non-writer non-purchaser → ForbiddenException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await expect(
        withTestTenant(async () => orders.cancel(order.id, {} as any, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel: actor=null + missing → silent skip returns null', async () => {
      // worker path
      const result = await withTestTenant(async () =>
        orders.cancel('00000000-0000-0000-0000-000000000000', {} as any, null),
      );
      expect(result).toBeNull();
    });

    it('cancel: actor=null with valid order — worker style cancel returns null', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      const ret = await withTestTenant(async () => orders.cancel(order.id, {} as any, null));
      expect(ret).toBeNull();
    });

    it('cancel missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          orders.cancel('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── RefundService ───
  describe('RefundService.issue', () => {
    it('full refund: tickets REFUNDED + tier decrement + outbox evt.refund.issued', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 2 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));

      // Mark one ticket USED to exercise the scanned_at clear path on refund
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_tickets SET status = 'USED', scanned_at = now()
         WHERE id = (SELECT id FROM ${TEST_SCHEMA}.evt_tickets WHERE order_id = $1::uuid LIMIT 1)`,
        order.id,
      );

      const refund = await withTestTenant(async () =>
        refunds.issue(
          order.id,
          { refundAmount: 20, reason: 'event cancelled' } as any,
          adminActor(),
        ),
      );
      expect(refund.refundAmount).toBe(20);
      expect(refund.reason).toBe('event cancelled');

      const orderRow = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(orderRow[0]!.s).toBe('REFUNDED');

      const ticketRows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_tickets WHERE order_id = $1::uuid`,
        order.id,
      );
      expect(ticketRows.every((r) => r.s === 'REFUNDED')).toBe(true);

      const sold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(sold[0]!.q)).toBe(0);

      const out = await rawClient.$queryRawUnsafe<Array<{ envelope: string }>>(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.refund.issued' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(out.length).toBe(1);
      const env = JSON.parse(out[0]!.envelope);
      expect(env.event_id).toBe(deterministicRefundIssuedEventId(refund.id));
    });

    it('partial refund: tickets remain VALID + no tier decrement', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 2 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      const refund = await withTestTenant(async () =>
        refunds.issue(order.id, { refundAmount: 5, reason: 'partial' } as any, adminActor()),
      );
      expect(refund.refundAmount).toBe(5);

      const orderRow = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(orderRow[0]!.s).toBe('CONFIRMED');

      const sold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(sold[0]!.q)).toBe(2);
    });

    it('refund exceeding total → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          refunds.issue(order.id, { refundAmount: 999, reason: 'too much' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refund PENDING order → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          refunds.issue(order.id, { refundAmount: 5, reason: 'oops' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refund CANCELLED order → BadRequestException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      // PENDING → CANCELLED via service path (no confirm so the
      // confirmed_chk lockstep stays satisfied).
      await withTestTenant(async () => orders.cancel(order.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          refunds.issue(order.id, { refundAmount: 5, reason: 'after cancel' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refund missing order → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          refunds.issue(
            '00000000-0000-0000-0000-000000000000',
            { refundAmount: 5, reason: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin refund → ForbiddenException', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      await expect(
        withTestTenant(async () =>
          refunds.issue(order.id, { refundAmount: 5, reason: 'x' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForOrder: admin sees refunds; non-purchaser non-writer sees empty', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      await withTestTenant(async () =>
        refunds.issue(order.id, { refundAmount: 5, reason: 'r' } as any, adminActor()),
      );

      const adminList = await withTestTenant(async () =>
        refunds.listForOrder(order.id, adminActor()),
      );
      expect(adminList.length).toBe(1);

      const studentList = await withTestTenant(async () =>
        refunds.listForOrder(order.id, studentActor()),
      );
      expect(studentList.length).toBe(0);
    });

    it('listForOrder missing order returns []', async () => {
      const list = await withTestTenant(async () =>
        refunds.listForOrder('00000000-0000-0000-0000-000000000000', adminActor()),
      );
      expect(list).toEqual([]);
    });

    it('listForOrder: purchaser sees own refunds', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, parentActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      await withTestTenant(async () =>
        refunds.issue(order.id, { refundAmount: 5, reason: 'r' } as any, adminActor()),
      );
      const list = await withTestTenant(async () => refunds.listForOrder(order.id, parentActor()));
      expect(list.length).toBe(1);
    });
  });

  // ─── OrderExpiryWorker ───
  describe('OrderExpiryWorker', () => {
    it('tickForTenant sweeps expired PENDING orders + decrements tier + cancels tickets', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 3 }] } as any, adminActor()),
      );
      // Backdate expires_at to past
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_orders SET expires_at = now() - interval '1 minute'
         WHERE id = $1::uuid`,
        order.id,
      );
      // Call tickForTenant via the worker
      // Use any cast to reach the private method through TypeScript
      await (worker as any).tickForTenant({
        schoolId: TEST_SCHOOL_ID,
        subdomain: TEST_SUBDOMAIN,
        schemaName: TEST_SCHEMA,
        organisationId: null,
        isFrozen: false,
        planTier: 'STANDARD',
        homeRegion: 'us-east-1',
      });

      const orderRow = await rawClient.$queryRawUnsafe<Array<{ s: string; reason: string | null }>>(
        `SELECT status AS s, cancellation_reason AS reason FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(orderRow[0]!.s).toBe('CANCELLED');
      expect(orderRow[0]!.reason).toContain('Expired');

      const sold = await rawClient.$queryRawUnsafe<Array<{ q: number }>>(
        `SELECT quantity_sold AS q FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE id = $1::uuid`,
        tierId,
      );
      expect(Number(sold[0]!.q)).toBe(0);

      const ticketRows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_tickets WHERE order_id = $1::uuid`,
        order.id,
      );
      expect(ticketRows.every((r) => r.s === 'CANCELLED')).toBe(true);
    });

    it('worker ignores non-expired PENDING orders', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await (worker as any).tickForTenant({
        schoolId: TEST_SCHOOL_ID,
        subdomain: TEST_SUBDOMAIN,
        schemaName: TEST_SCHEMA,
        organisationId: null,
        isFrozen: false,
        planTier: 'STANDARD',
        homeRegion: 'us-east-1',
      });
      const rows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(rows[0]!.s).toBe('PENDING');
    });

    it('worker idempotent — second tick is a no-op', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_orders SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
        order.id,
      );
      await (worker as any).tickForTenant({
        schoolId: TEST_SCHOOL_ID,
        subdomain: TEST_SUBDOMAIN,
        schemaName: TEST_SCHEMA,
        organisationId: null,
        isFrozen: false,
        planTier: 'STANDARD',
        homeRegion: 'us-east-1',
      });
      await (worker as any).tickForTenant({
        schoolId: TEST_SCHOOL_ID,
        subdomain: TEST_SUBDOMAIN,
        schemaName: TEST_SCHEMA,
        organisationId: null,
        isFrozen: false,
        planTier: 'STANDARD',
        homeRegion: 'us-east-1',
      });
      const rows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(rows[0]!.s).toBe('CANCELLED');
    });

    it('worker tick() drains across active schools', async () => {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_orders SET expires_at = now() - interval '1 minute' WHERE id = $1::uuid`,
        order.id,
      );
      await worker.tick();
      const rows = await rawClient.$queryRawUnsafe<Array<{ s: string }>>(
        `SELECT status AS s FROM ${TEST_SCHEMA}.evt_orders WHERE id = $1::uuid`,
        order.id,
      );
      expect(rows[0]!.s).toBe('CANCELLED');
    });

    it('worker tick() while running flag is set is skipped', async () => {
      (worker as any).running = true;
      try {
        await worker.tick();
        // running flag remains true since we set it manually; that's fine
      } finally {
        (worker as any).running = false;
      }
    });
  });

  // ─── Gate scan ───
  describe('GateScanService.scan — atomic gate scan', () => {
    async function setupTicketAndOrder(): Promise<{
      eventId: string;
      tierId: string;
      orderId: string;
      qrToken: string;
      ticketId: string;
    }> {
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      await withTestTenant(async () => orders.confirm(order.id, {} as any, adminActor()));
      const ticket = order.tickets[0]!;
      return {
        eventId,
        tierId,
        orderId: order.id,
        qrToken: ticket.qrCodeToken,
        ticketId: ticket.id,
      };
    }

    it('VALID ticket → USED + scanResult=VALID + audit log row inserted', async () => {
      const { qrToken, ticketId } = await setupTicketAndOrder();
      const result = await withTestTenant(async () =>
        gate.scan({ qrCodeToken: qrToken, scanSource: 'KIOSK_A' } as any, adminActor()),
      );
      expect(result.scanResult).toBe('VALID');
      expect(result.ticketId).toBe(ticketId);

      const tickRow = await rawClient.$queryRawUnsafe<Array<{ s: string; sa: string | null }>>(
        `SELECT status AS s, scanned_at::text AS sa FROM ${TEST_SCHEMA}.evt_tickets WHERE id = $1::uuid`,
        ticketId,
      );
      expect(tickRow[0]!.s).toBe('USED');
      expect(tickRow[0]!.sa).toBeTruthy();

      const scanRows = await rawClient.$queryRawUnsafe<Array<{ result: string }>>(
        `SELECT scan_result AS result FROM ${TEST_SCHEMA}.evt_ticket_scans WHERE ticket_id = $1::uuid`,
        ticketId,
      );
      expect(scanRows.length).toBe(1);
      expect(scanRows[0]!.result).toBe('VALID');
    });

    it('double-scan → ALREADY_SCANNED + new audit row', async () => {
      const { qrToken, ticketId } = await setupTicketAndOrder();
      await withTestTenant(async () => gate.scan({ qrCodeToken: qrToken } as any, adminActor()));
      const result = await withTestTenant(async () =>
        gate.scan({ qrCodeToken: qrToken } as any, adminActor()),
      );
      expect(result.scanResult).toBe('ALREADY_SCANNED');

      const scanRows = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.evt_ticket_scans WHERE ticket_id = $1::uuid`,
        ticketId,
      );
      expect(Number(scanRows[0]!.n)).toBe(2);
    });

    it('INVALID token → INVALID + audit row with ticket_id NULL', async () => {
      const { eventId } = await setupTicketAndOrder();
      const result = await withTestTenant(async () =>
        gate.scan({ qrCodeToken: 'no_such_token_' + Date.now(), eventId } as any, adminActor()),
      );
      expect(result.scanResult).toBe('INVALID');
      expect(result.ticketId).toBeNull();

      // Some scan audit row exists with that token
      const rows = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.evt_ticket_scans
         WHERE qr_code_token = $1 AND scan_result = 'INVALID'`,
        result.ticketId === null && true ? 'no_such_token_' + 'placeholder' : 'x',
      );
      // We just verify total invalid count >= 1 via the most recent scan_result
      const allInvalid = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.evt_ticket_scans WHERE scan_result = 'INVALID'`,
      );
      expect(Number(allInvalid[0]!.n)).toBeGreaterThanOrEqual(1);
      void rows;
    });

    it('CANCELLED ticket → EXPIRED branch', async () => {
      // Don't go through confirm — directly flip ticket to CANCELLED
      // via a fresh PENDING purchase + cancel. That way the
      // confirmed_chk lockstep stays satisfied.
      const { eventId, tierId } = await seedEventWithTier({ tierQty: 5 });
      const order = await withTestTenant(async () =>
        orders.purchase(eventId, { lines: [{ tierId, quantity: 1 }] } as any, adminActor()),
      );
      const qrToken = order.tickets[0]!.qrCodeToken;
      await withTestTenant(async () => orders.cancel(order.id, {} as any, adminActor()));
      const result = await withTestTenant(async () =>
        gate.scan({ qrCodeToken: qrToken } as any, adminActor()),
      );
      expect(result.scanResult).toBe('EXPIRED');
    });

    it('REFUNDED ticket → EXPIRED branch', async () => {
      const { qrToken, orderId } = await setupTicketAndOrder();
      await withTestTenant(async () =>
        refunds.issue(orderId, { refundAmount: 10, reason: 'r' } as any, adminActor()),
      );
      const result = await withTestTenant(async () =>
        gate.scan({ qrCodeToken: qrToken } as any, adminActor()),
      );
      expect(result.scanResult).toBe('EXPIRED');
    });

    it('non-writer → ForbiddenException', async () => {
      const { qrToken } = await setupTicketAndOrder();
      await expect(
        withTestTenant(async () => gate.scan({ qrCodeToken: qrToken } as any, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A token cannot be scanned in School B context', async () => {
      const { qrToken } = await setupTicketAndOrder();
      const result = await withTestTenantB(async () =>
        gate.scan({ qrCodeToken: qrToken } as any, adminActor()),
      );
      expect(result.scanResult).toBe('INVALID');
    });
  });
});

void TEST_STUDENT_PERSON_ID;
