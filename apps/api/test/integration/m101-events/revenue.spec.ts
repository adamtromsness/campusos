import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EventService } from '@modules/m101-events/events.service';
import { OrderService, RefundService } from '@modules/m101-events/orders.service';
import { EventRevenueService } from '@modules/m101-events/revenue.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, parentActor, TEST_ADMIN_PERSON_ID } from '../helpers/actor';
import { resetEventsTables } from '../fixtures/events';

describe('integration:m101-events/revenue', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let events: EventService;
  let orders: OrderService;
  let refunds: RefundService;
  let revenue: EventRevenueService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    events = new EventService(tenantPrisma, outbox, permCheck);
    orders = new OrderService(tenantPrisma, outbox, permCheck, events);
    refunds = new RefundService(tenantPrisma, outbox, permCheck);
    revenue = new EventRevenueService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEventsTables(rawClient);
    vi.unstubAllEnvs();
    // Auto-confirm so test ordering is simple
    vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', 'true');
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }
  function datePast(days: number): string {
    return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  }

  async function seedEventWithTiers(
    opts: {
      schoolId?: string;
      eventType?: string;
      eventDate?: string;
      status?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'COMPLETED' | 'CANCELLED';
      tiers?: Array<{ name: string; price: number; quantity: number }>;
      title?: string;
    } = {},
  ): Promise<{ eventId: string; tierIds: string[] }> {
    const eventId = generateId();
    const tierSpec = opts.tiers ?? [
      { name: 'GA', price: 10, quantity: 100 },
      { name: 'VIP', price: 25, quantity: 20 },
    ];
    const total = tierSpec.reduce((acc, t) => acc + t.quantity, 0);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_events
         (id, school_id, title, event_type, event_date, start_time, status, created_by, total_tier_quantity)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, '19:00', $6, $7::uuid, $8)`,
      eventId,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.title ?? 'Revenue Event',
      opts.eventType ?? 'PERFORMANCE',
      opts.eventDate ?? dateFuture(14),
      opts.status ?? 'ON_SALE',
      TEST_ADMIN_PERSON_ID,
      total,
    );
    const tierIds: string[] = [];
    for (const t of tierSpec) {
      const tid = generateId();
      tierIds.push(tid);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_ticket_tiers
           (id, event_id, name, price, quantity)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
        tid,
        eventId,
        t.name,
        t.price,
        t.quantity,
      );
    }
    return { eventId, tierIds };
  }

  describe('forEvent', () => {
    it('aggregates gross / refunds / net / Stripe fees / per-tier rollup', async () => {
      const { eventId, tierIds } = await seedEventWithTiers();
      // Two purchases on tier 1, one on tier 2
      await withTestTenant(async () =>
        orders.purchase(
          eventId,
          { lines: [{ tierId: tierIds[0]!, quantity: 2 }] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        orders.purchase(
          eventId,
          { lines: [{ tierId: tierIds[0]!, quantity: 3 }] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        orders.purchase(
          eventId,
          { lines: [{ tierId: tierIds[1]!, quantity: 1 }] } as any,
          adminActor(),
        ),
      );

      const report = await withTestTenant(async () => revenue.forEvent(eventId, adminActor()));
      // gross = (2+3)*10 + 1*25 = 75
      expect(report.grossTicketSales).toBe(75);
      expect(report.ordersConfirmed).toBe(3);
      expect(report.totalTicketsSold).toBe(6);
      expect(report.totalTicketsScanned).toBe(0);
      expect(report.refundsIssued).toBe(0);
      expect(report.netRevenue).toBe(75);
      // Stripe fee = 75 * 0.029 + 0.30 * 3 = 2.175 + 0.9 = 3.075 → 3.08
      expect(report.estimatedStripeFees).toBeCloseTo(3.08, 2);

      // Per-tier rollup
      const ga = report.tiers.find((t) => t.tierId === tierIds[0]);
      expect(ga!.quantitySold).toBe(5);
      expect(ga!.grossRevenue).toBe(50);
      const vip = report.tiers.find((t) => t.tierId === tierIds[1]);
      expect(vip!.quantitySold).toBe(1);
      expect(vip!.grossRevenue).toBe(25);
    });

    it('counts USED scan as totalTicketsScanned', async () => {
      const { eventId, tierIds } = await seedEventWithTiers({
        tiers: [{ name: 'GA', price: 10, quantity: 50 }],
      });
      const order = await withTestTenant(async () =>
        orders.purchase(
          eventId,
          { lines: [{ tierId: tierIds[0]!, quantity: 2 }] } as any,
          adminActor(),
        ),
      );
      // Mark one ticket USED
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_tickets SET status = 'USED', scanned_at = now()
         WHERE id = (SELECT id FROM ${TEST_SCHEMA}.evt_tickets WHERE order_id = $1::uuid LIMIT 1)`,
        order.id,
      );
      const report = await withTestTenant(async () => revenue.forEvent(eventId, adminActor()));
      expect(report.totalTicketsScanned).toBe(1);
      expect(report.totalTicketsSold).toBe(2);
    });

    it('refunds reduce net', async () => {
      const { eventId, tierIds } = await seedEventWithTiers({
        tiers: [{ name: 'GA', price: 10, quantity: 50 }],
      });
      const order = await withTestTenant(async () =>
        orders.purchase(
          eventId,
          { lines: [{ tierId: tierIds[0]!, quantity: 2 }] } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        refunds.issue(order.id, { refundAmount: 5, reason: 'partial' } as any, adminActor()),
      );
      const report = await withTestTenant(async () => revenue.forEvent(eventId, adminActor()));
      expect(report.grossTicketSales).toBe(20);
      expect(report.refundsIssued).toBe(5);
      expect(report.netRevenue).toBe(15);
    });

    it('counts SEASON_PASS and COMP scan_source as season_pass / comp admits', async () => {
      const { eventId } = await seedEventWithTiers();
      // Seed scan rows manually with scan_source LIKE 'SEASON_PASS%' and 'COMP%'
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_ticket_scans
           (id, ticket_id, event_id, qr_code_token, scanned_at, scanned_by, scan_result, scan_source)
         VALUES (gen_random_uuid(), NULL, $1::uuid, NULL, now(), $2::uuid, 'VALID', 'SEASON_PASS_ENTRY')`,
        eventId,
        TEST_ADMIN_PERSON_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.evt_ticket_scans
           (id, ticket_id, event_id, qr_code_token, scanned_at, scanned_by, scan_result, scan_source)
         VALUES (gen_random_uuid(), NULL, $1::uuid, NULL, now(), $2::uuid, 'VALID', 'COMP_LIST_ENTRY')`,
        eventId,
        TEST_ADMIN_PERSON_ID,
      );
      const report = await withTestTenant(async () => revenue.forEvent(eventId, adminActor()));
      expect(report.seasonPassAdmissions).toBe(1);
      expect(report.compAdmissions).toBe(1);
    });

    it('missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          revenue.forEvent('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer → ForbiddenException', async () => {
      const { eventId } = await seedEventWithTiers();
      await expect(
        withTestTenant(async () => revenue.forEvent(eventId, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A admin cannot read School B revenue', async () => {
      const { eventId } = await seedEventWithTiers({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => revenue.forEvent(eventId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Cleanup directly
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_ticket_tiers WHERE event_id = $1::uuid`,
        eventId,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.evt_events WHERE id = $1::uuid`,
        eventId,
      );
    });

    it('empty event returns zeros', async () => {
      const { eventId } = await seedEventWithTiers({ tiers: [] });
      const report = await withTestTenant(async () => revenue.forEvent(eventId, adminActor()));
      expect(report.grossTicketSales).toBe(0);
      expect(report.totalTicketsSold).toBe(0);
      expect(report.tiers).toEqual([]);
    });
  });

  describe('summary', () => {
    it('returns rows grouped by event_type with totals', async () => {
      // Events must fall inside the default 90-day backward window.
      const perf = await seedEventWithTiers({
        eventType: 'PERFORMANCE',
        eventDate: datePast(2),
        tiers: [{ name: 'GA', price: 10, quantity: 10 }],
      });
      await withTestTenant(async () =>
        orders.purchase(
          perf.eventId,
          { lines: [{ tierId: perf.tierIds[0]!, quantity: 2 }] } as any,
          adminActor(),
        ),
      );

      // ATHLETIC_GAME event with sales
      const game = await seedEventWithTiers({
        eventType: 'ATHLETIC_GAME',
        eventDate: datePast(3),
        tiers: [{ name: 'Adult', price: 5, quantity: 50 }],
      });
      await withTestTenant(async () =>
        orders.purchase(
          game.eventId,
          { lines: [{ tierId: game.tierIds[0]!, quantity: 3 }] } as any,
          adminActor(),
        ),
      );

      const summary = await withTestTenant(async () => revenue.summary({}, adminActor()));
      expect(summary.byEventType.length).toBe(2);
      const perfRow = summary.byEventType.find((r) => r.eventType === 'PERFORMANCE');
      const gameRow = summary.byEventType.find((r) => r.eventType === 'ATHLETIC_GAME');
      expect(perfRow!.grossRevenue).toBe(20);
      expect(gameRow!.grossRevenue).toBe(15);
      expect(summary.totals.grossRevenue).toBe(35);
      expect(summary.totals.ticketsSold).toBe(5);
    });

    it('from/to filter excludes events outside the window', async () => {
      await seedEventWithTiers({
        eventType: 'PERFORMANCE',
        eventDate: datePast(60), // older than 30-day window
        tiers: [{ name: 'GA', price: 10, quantity: 10 }],
      });
      const summary = await withTestTenant(async () =>
        revenue.summary({ from: datePast(30), to: dateFuture(0) }, adminActor()),
      );
      expect(summary.byEventType.length).toBe(0);
    });

    it('default 90-day window covers recent events', async () => {
      await seedEventWithTiers({
        eventType: 'PERFORMANCE',
        eventDate: datePast(10),
        tiers: [{ name: 'GA', price: 10, quantity: 10 }],
      });
      const summary = await withTestTenant(async () => revenue.summary({}, adminActor()));
      expect(summary.byEventType.length).toBe(1);
    });

    it('non-writer → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => revenue.summary({}, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: summary scoped to current tenant', async () => {
      await seedEventWithTiers({
        schoolId: TEST_SCHOOL_B_ID,
        eventDate: datePast(2),
      });
      const summaryA = await withTestTenant(async () => revenue.summary({}, adminActor()));
      expect(summaryA.byEventType.length).toBe(0);
      const summaryB = await withTestTenantB(async () => revenue.summary({}, adminActor()));
      expect(summaryB.byEventType.length).toBeGreaterThanOrEqual(1);
    });
  });
});
