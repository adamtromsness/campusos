import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { EventService, TierService } from './events.service';
import { OrderService, RefundService } from './orders.service';
import { CompListService, GateScanService, SeasonPassService } from './gate.service';
import { EventRevenueService } from './revenue.service';
import { EventsController } from './events.controller';
import {
  deterministicAthleticEventCreatedEventId,
  deterministicEventCompletedEventId,
  deterministicOrderConfirmedEventId,
  deterministicRefundIssuedEventId,
} from './event-ids';

/**
 * P2-12 Step 7 + REVIEW-P2C12 ROUND 1 regression coverage.
 *
 * The original Step 7 spec covered all 10 vertical-slice scenarios.
 * REVIEW-P2C12 ROUND 1 returned FAIL with 5 BLOCKING + 3 MAJOR; this
 * file adds the pinned regression tests so every BLOCKING fix is
 * locked under test and cannot regress silently.
 *
 *   S1.  Atomic ticket sale (UPDATE WHERE quantity_sold+$qty<=quantity).
 *   S2.  Concurrent sale race — exactly one 409 with qty=1.
 *   S3.  Event capacity CHECK — tier total>capacity rejected.
 *   S4.  Order expiry — OrderExpiryWorker cancels + decrements tier.
 *   S5.  Gate scan atomic — VALID flip + ALREADY_SCANNED + INVALID.
 *   S6.  Season pass — events_included gate, non-matching denied.
 *   S7.  Comp list — gate check admits listed person, denies others.
 *   S8.  Refund — tier.quantity_sold decremented + tickets REFUNDED.
 *   S9.  Auto SOLD_OUT — all tiers sold flips event to SOLD_OUT.
 *   S10. Permission metadata — controller routes pinned to evt-001.
 *
 * REVIEW-P2C12 ROUND 1 regressions:
 *   R-B1a. evt.order.confirmed enqueued via outbox INSIDE confirm tx.
 *   R-B1b. evt.refund.issued enqueued via outbox INSIDE refund tx.
 *   R-B1c. evt.event.completed enqueued via outbox INSIDE complete tx.
 *   R-B1d. evt.athletic_event.created enqueued via outbox INSIDE create tx.
 *   R-B1e. Deterministic event IDs are stable + v5-shaped.
 *   R-B2.  STRIPE_DEV_AUTO_CONFIRM=true enqueues evt.order.confirmed.
 *   R-B3a. Athletic comp auto-populate JOINs through ath_programmes.school_id.
 *   R-B3b. Foreign-school linked_game_id → 0 comps + warn.
 *   R-B4a. Season pass gate validates target event school + status.
 *   R-B4b. events_included IS NULL admits only via pass-type/year match.
 *   R-B5.  Comp add validates personId per compType.
 *   R-M1.  maybeAutoFlipSoldOut UPDATE carries school predicate.
 *   R-M2.  loadTiers JOINs through evt_events with school predicate.
 */

const SCHOOL: TenantInfo = {
  schoolId: '019e0cf8-bbb8-7556-8c81-f07b3369e584',
  schemaName: 'tenant_demo',
  organisationId: 'org-1',
  subdomain: 'demo',
  isFrozen: false,
  planTier: 'MEDIUM',
  homeRegion: 'us-east-1',
};

const ADMIN_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-000000000001',
  personId: '019e0cf8-bbb8-7556-8c81-000000000002',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
  employeeId: '019e0cf8-bbb8-7556-8c81-000000000099',
} as never;

const PARENT_ACTOR = {
  accountId: '019e0cf8-bbb8-7556-8c81-c0000000c001',
  personId: '019e0cf8-bbb8-7556-8c81-c0000000c002',
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
  employeeId: null,
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (
      _tx: unknown,
      opts: {
        topic: string;
        sourceModule: string;
        key: string;
        eventId?: string;
        payload: Record<string, unknown>;
      },
    ) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-row-id';
    },
  };
  return { outbox, enqueued };
}

function makePerms(grant = true) {
  return {
    hasAnyPermissionInTenant: async () => grant,
  };
}

const EVENT_ID = '019e0cf8-aaaa-7000-8000-0000000000ee';
const TIER_ID = '019e0cf8-aaaa-7000-8000-0000000000ff';
const ORDER_ID = '019e0cf8-aaaa-7000-8000-000000000001';
const TICKET_ID_1 = '019e0cf8-aaaa-7000-8000-0000000000a1';

describe('Events & Ticketing — vertical slice (Step 7)', () => {
  // ─── S1 — Atomic ticket sale ───
  it('S1: purchase issues the atomic UPDATE WHERE quantity_sold + qty <= quantity (single statement, never SELECT-then-UPDATE)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status, title from evt_events')) {
        return [{ id: EVENT_ID, status: 'ON_SALE', title: 'Spring Musical' }];
      }
      if (sql.includes('from evt_ticket_tiers t') && sql.includes('join evt_events e')) {
        return [
          {
            id: TIER_ID,
            event_id: EVENT_ID,
            name: 'General Admission',
            price: 10.0,
            quantity: 200,
            quantity_sold: 0,
            is_active: true,
            sale_starts_at: null,
            sale_ends_at: null,
          },
        ];
      }
      if (
        sql.includes('update evt_ticket_tiers') &&
        sql.includes('quantity_sold + $1 <= quantity')
      ) {
        return [{ new_sold: 2 }];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 'Spring Musical',
            description: null,
            event_type: 'PERFORMANCE',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: 300,
            total_tier_quantity: 200,
            linked_game_id: null,
            status: 'ON_SALE',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      if (sql.includes('from evt_ticket_tiers') && sql.includes('order by t.created_at')) {
        return [];
      }
      if (sql.includes('from evt_orders o') && sql.includes('limit 1')) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            event_title: 'Spring Musical',
            purchaser_id: PARENT_ACTOR.personId,
            purchaser_name: 'David Chen',
            status: 'PENDING',
            total_amount: 20,
            stripe_payment_intent_id: 'pi_dev_evt_abc',
            expires_at: null,
            confirmed_at: null,
            cancelled_at: null,
            cancellation_reason: null,
            created_at: 't',
          },
        ];
      }
      if (sql.includes('from evt_tickets t')) {
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
      events,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 2 }] }, PARENT_ACTOR),
    );
    const atomic = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_ticket_tiers') &&
        c.sql.includes('quantity_sold + $1 <= quantity'),
    );
    expect(atomic).toBeDefined();
    expect(atomic!.args[0]).toBe(2);
    expect(atomic!.args[1]).toBe(TIER_ID);
  });

  // ─── S2 — Concurrent race condition ───
  it('S2: two purchases against tier qty=1 — first succeeds, second 409', async () => {
    let soldCount = 0;
    const baseHandler = (c: CapturedCall) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status, title from evt_events')) {
        return [{ id: EVENT_ID, status: 'ON_SALE', title: 'Race Test' }];
      }
      if (sql.includes('from evt_ticket_tiers t') && sql.includes('join evt_events e')) {
        return [
          {
            id: TIER_ID,
            event_id: EVENT_ID,
            name: 'Solo',
            price: 5.0,
            quantity: 1,
            quantity_sold: soldCount,
            is_active: true,
            sale_starts_at: null,
            sale_ends_at: null,
          },
        ];
      }
      if (
        sql.includes('update evt_ticket_tiers') &&
        sql.includes('quantity_sold + $1 <= quantity')
      ) {
        if (soldCount + 1 <= 1) {
          soldCount += 1;
          return [{ new_sold: soldCount }];
        }
        return [];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 'Race Test',
            description: null,
            event_type: 'PERFORMANCE',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: 1,
            total_tier_quantity: 1,
            linked_game_id: null,
            status: 'ON_SALE',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    };
    const fake = makeFake(baseHandler);
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
      events,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
    );
    expect(soldCount).toBe(1);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ─── S3 — Event capacity CHECK on tier total ───
  it('S3: TierService.create surfaces venue_capacity_chk violations as ConflictException', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status from evt_events')) {
        return [{ id: EVENT_ID, status: 'DRAFT' }];
      }
      if (sql.includes('insert into evt_ticket_tiers')) {
        const err = new Error('evt_events_venue_capacity_chk') as Error & { code?: string };
        err.message = 'CHECK constraint evt_events_venue_capacity_chk violated';
        throw err;
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const tiers = new TierService(fake.tenantPrisma as never, events);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        tiers.create(EVENT_ID, { name: 'Overflow', price: 1, quantity: 999 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ─── S4 — Order expiry / cancel path ───
  it('S4: OrderService.cancel decrements tier.quantity_sold, flips tickets CANCELLED, stamps order CANCELLED', async () => {
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (sql.includes('select o.id::text as id, o.event_id::text as event_id, o.status')) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            status: 'PENDING',
            purchaser_id: PARENT_ACTOR.personId,
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
      events,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      orders.cancel(ORDER_ID, { cancellationReason: 'Expired' }, null),
    );
    const decrement = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_ticket_tiers t') &&
        c.sql.toLowerCase().includes('greatest(0, t.quantity_sold - tk.cnt)'),
    );
    expect(decrement).toBeDefined();
    const ticketFlip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_tickets set status = 'cancelled'"),
    );
    expect(ticketFlip).toBeDefined();
    const orderFlip = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_orders') &&
        c.sql.toLowerCase().includes("status = 'cancelled'"),
    );
    expect(orderFlip).toBeDefined();
  });

  // ─── S5 — Atomic gate scan ───
  it('S5: gate scan VALID flips status=USED, logs to evt_ticket_scans, ALREADY_SCANNED on re-scan', async () => {
    let scanned = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('update evt_tickets t') && sql.includes("status = 'used'")) {
        if (!scanned) {
          scanned = true;
          return [
            {
              id: TICKET_ID_1,
              tier_id: TIER_ID,
              holder_name: 'Maya Chen',
              event_id: EVENT_ID,
              event_title: 'Spring Musical',
            },
          ];
        }
        return [];
      }
      if (sql.includes('from evt_tickets t') && sql.includes('t.qr_code_token = $1')) {
        return [
          {
            id: TICKET_ID_1,
            status: 'USED',
            holder_name: 'Maya Chen',
            scanned_at: 't',
            event_id: EVENT_ID,
            event_title: 'Spring Musical',
          },
        ];
      }
      if (sql.includes('select name from evt_ticket_tiers')) {
        return [{ name: 'General Admission' }];
      }
      if (sql.includes('insert into evt_ticket_scans')) {
        return 1;
      }
      return [];
    });
    const gate = new GateScanService(fake.tenantPrisma as never, makePerms() as never);
    const first = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      gate.scan({ qrCodeToken: 'tok-1', scanSource: 'TEST' }, ADMIN_ACTOR),
    );
    expect(first.scanResult).toBe('VALID');
    expect(first.holderName).toBe('Maya Chen');
    expect(
      fake.capture.find((c) => c.sql.toLowerCase().includes('insert into evt_ticket_scans')),
    ).toBeDefined();
    const second = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      gate.scan({ qrCodeToken: 'tok-1', scanSource: 'TEST' }, ADMIN_ACTOR),
    );
    expect(second.scanResult).toBe('ALREADY_SCANNED');
  });

  // ─── S6 — Season pass admission rules (BLOCKING 4 covered separately below) ───
  it('S6: season pass admits matching events_included (with event-in-school check)', async () => {
    const ACTIVE_PASS = 'pass-active';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included') && c.args[0] === ACTIVE_PASS) {
        return [
          {
            status: 'ACTIVE',
            events_included: ['019e-incl-1', '019e-incl-2'],
            pass_type: 'All Sports',
            academic_year: '2025-2026',
          },
        ];
      }
      // Event-in-school lookup
      if (sql.includes('from evt_events') && sql.includes('event_type, event_date::text')) {
        const eventId = c.args[0];
        if (eventId === '019e-incl-1') {
          return [
            {
              id: '019e-incl-1',
              event_type: 'ATHLETIC_GAME',
              event_date: '2025-10-15',
              status: 'ON_SALE',
            },
          ];
        }
        return [];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const admit = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: ACTIVE_PASS, eventId: '019e-incl-1' }, ADMIN_ACTOR),
    );
    expect(admit.admitted).toBe(true);
  });

  // ─── S7 — Comp gate check ───
  it('S7: comp gate check admits listed person, denies non-listed', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from evt_comp_lists c') && sql.includes('person_id = $2::uuid')) {
        const personArg = c.args[1];
        if (personArg === '019e-listed') {
          return [{ comp_type: 'ATHLETE', person_name: 'Listed Athlete' }];
        }
        return [];
      }
      return [];
    });
    const comp = new CompListService(fake.tenantPrisma as never, makePerms() as never);
    const admit = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      comp.gateCheck({ eventId: EVENT_ID, personId: '019e-listed' }, ADMIN_ACTOR),
    );
    expect(admit.admitted).toBe(true);
    expect(admit.compType).toBe('ATHLETE');
    const deny = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      comp.gateCheck({ eventId: EVENT_ID, personId: '019e-not-listed' }, ADMIN_ACTOR),
    );
    expect(deny.admitted).toBe(false);
  });

  // ─── S8 — Refund tier decrement (BLOCKING 1 outbox emit covered in R-B1b) ───
  it('S8: full-amount refund decrements tier.quantity_sold + flips tickets REFUNDED', async () => {
    const captures: CapturedCall[] = [];
    let capturedRefundId: string | null = null;
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select o.id::text as id, o.event_id::text as event_id, o.status, o.total_amount',
        )
      ) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            status: 'CONFIRMED',
            total_amount: 20,
            purchaser_id: PARENT_ACTOR.personId,
            stripe_payment_intent_id: 'pi_dev_evt_abc',
          },
        ];
      }
      if (sql.includes('coalesce(sum(refund_amount), 0)::numeric as sum')) {
        return [{ sum: 0 }];
      }
      if (sql.includes('insert into evt_refunds')) {
        capturedRefundId = String(c.args[0] ?? '');
        return 1;
      }
      if (sql.includes('from evt_refunds r') && sql.includes('join evt_orders o')) {
        return [
          {
            id: capturedRefundId ?? 'refund-1',
            order_id: ORDER_ID,
            refund_amount: 20,
            reason: 'Test refund',
            stripe_refund_id: 're_dev_evt_abc',
            refunded_by: ADMIN_ACTOR.personId,
            refunded_at: 't',
          },
        ];
      }
      if (sql.includes('select o.purchaser_id::text as pid')) {
        return [{ pid: PARENT_ACTOR.personId }];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const refunds = new RefundService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      refunds.issue(ORDER_ID, { refundAmount: 20, reason: 'Test refund' }, ADMIN_ACTOR),
    );
    expect(result.refundAmount).toBe(20);
    const decrement = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_ticket_tiers t') &&
        c.sql.toLowerCase().includes('greatest(0, t.quantity_sold - tk.cnt)'),
    );
    expect(decrement).toBeDefined();
    const ticketFlip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_tickets set status = 'refunded'"),
    );
    expect(ticketFlip).toBeDefined();
    expect(enqueued.find((e) => e.topic === 'evt.refund.issued')).toBeDefined();
  });

  // ─── S9 — Auto SOLD_OUT flip ───
  it('S9: maybeAutoFlipSoldOut flips ON_SALE → SOLD_OUT when no tiers have remaining capacity', async () => {
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status from evt_events') && sql.includes('for update')) {
        return [{ status: 'ON_SALE' }];
      }
      if (sql.includes('select count(*)::int as n from evt_ticket_tiers')) {
        return [{ n: 0 }];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.maybeAutoFlipSoldOut(EVENT_ID),
    );
    const flip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_events set status = 'sold_out'"),
    );
    expect(flip).toBeDefined();
  });

  // ─── S10 — Permission metadata ───
  it('S10: controller routes are pinned to evt-001 permission codes', () => {
    const proto = EventsController.prototype as unknown as Record<string, unknown>;
    const checks: Array<[string, string[]]> = [
      ['listEvents', ['evt-001:read']],
      ['createEvent', ['evt-001:write']],
      ['purchase', ['evt-001:write']],
      ['issueRefund', ['evt-001:write']],
      ['gateScan', ['evt-001:write']],
      ['compGate', ['evt-001:write']],
      ['seasonPassGate', ['evt-001:write']],
      ['revenueForEvent', ['evt-001:read']],
      ['revenueSummary', ['evt-001:read']],
    ];
    for (const [method, expected] of checks) {
      const meta = Reflect.getMetadata(PERMISSIONS_KEY, proto[method] as object);
      expect(meta, `${method} must declare @RequirePermission`).toBeDefined();
      expect(meta).toEqual(expected);
    }
  });

  // ─── Bonus — revenue summary aggregation ───
  it('Bonus: revenue summary aggregates by event_type and computes net = gross - refunds', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('group by e.event_type')) {
        return [
          {
            event_type: 'PERFORMANCE',
            orders_confirmed: 5,
            gross: 100,
            refunds: 10,
            tickets_sold: 8,
          },
          {
            event_type: 'ATHLETIC_GAME',
            orders_confirmed: 3,
            gross: 60,
            refunds: 0,
            tickets_sold: 6,
          },
        ];
      }
      return [];
    });
    const revenue = new EventRevenueService(fake.tenantPrisma as never, makePerms() as never);
    const summary = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      revenue.summary({ from: '2026-01-01', to: '2026-12-31' }, ADMIN_ACTOR),
    );
    expect(summary.byEventType.length).toBe(2);
    expect(summary.totals.grossRevenue).toBe(160);
    expect(summary.totals.refundsIssued).toBe(10);
    expect(summary.totals.netRevenue).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// REVIEW-P2C12 ROUND 1 — pinned regression coverage for all 5 BLOCKING +
// the 2 actionable MAJORs (1 + 2). Each test asserts a single load-bearing
// invariant from the closeout commit and cannot regress silently.
// ─────────────────────────────────────────────────────────────────────────

describe('REVIEW-P2C12 ROUND 1 — BLOCKING regressions', () => {
  // ─── R-B1a — order confirm enqueues outbox INSIDE tx ───
  it('R-B1a: OrderService.confirm enqueues evt.order.confirmed via OutboxService.enqueueInTx', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from evt_orders o') && sql.includes('for update of o')) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            status: 'PENDING',
            total_amount: 20,
            purchaser_id: PARENT_ACTOR.personId,
          },
        ];
      }
      if (sql.includes('update evt_orders') && sql.includes("status = 'confirmed'")) {
        return [{ confirmed_at: '2026-05-15T19:00:00Z' }];
      }
      if (sql.includes('select status from evt_events') && sql.includes('for update')) {
        return [{ status: 'CONFIRMED' }];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 'T',
            description: null,
            event_type: 'PERFORMANCE',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: 100,
            total_tier_quantity: 100,
            linked_game_id: null,
            status: 'CONFIRMED',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      if (sql.includes('from evt_orders o') && sql.includes('limit 1')) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            event_title: 'T',
            purchaser_id: PARENT_ACTOR.personId,
            purchaser_name: 'P',
            status: 'CONFIRMED',
            total_amount: 20,
            stripe_payment_intent_id: 'pi_dev_evt_abc',
            expires_at: null,
            confirmed_at: '2026-05-15T19:00:00Z',
            cancelled_at: null,
            cancellation_reason: null,
            created_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
      events,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      orders.confirm(ORDER_ID, {}, ADMIN_ACTOR),
    );
    const env = enqueued.find((e) => e.topic === 'evt.order.confirmed');
    expect(env, 'evt.order.confirmed outbox row must land').toBeDefined();
    expect(env?.sourceModule).toBe('events');
    expect(env?.eventId).toBe(deterministicOrderConfirmedEventId(ORDER_ID));
    expect(env?.payload?.orderId).toBe(ORDER_ID);
    expect(env?.payload?.schoolId).toBe(SCHOOL.schoolId);
  });

  // ─── R-B1b — refund issue enqueues outbox INSIDE tx ───
  it('R-B1b: RefundService.issue enqueues evt.refund.issued via OutboxService.enqueueInTx with deterministic id', async () => {
    let capturedRefundId: string | null = null;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes(
          'select o.id::text as id, o.event_id::text as event_id, o.status, o.total_amount',
        )
      ) {
        return [
          {
            id: ORDER_ID,
            event_id: EVENT_ID,
            status: 'CONFIRMED',
            total_amount: 20,
            purchaser_id: PARENT_ACTOR.personId,
            stripe_payment_intent_id: 'pi_dev_evt_abc',
          },
        ];
      }
      if (sql.includes('coalesce(sum(refund_amount), 0)::numeric as sum')) {
        return [{ sum: 0 }];
      }
      if (sql.includes('insert into evt_refunds')) {
        capturedRefundId = String(c.args[0] ?? '');
        return 1;
      }
      if (sql.includes('from evt_refunds r') && sql.includes('join evt_orders o')) {
        return [
          {
            id: capturedRefundId ?? 'refund-1',
            order_id: ORDER_ID,
            refund_amount: 20,
            reason: 'r',
            stripe_refund_id: 're_dev_evt_abc',
            refunded_by: ADMIN_ACTOR.personId,
            refunded_at: 't',
          },
        ];
      }
      if (sql.includes('select o.purchaser_id::text as pid')) {
        return [{ pid: PARENT_ACTOR.personId }];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const refunds = new RefundService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      refunds.issue(ORDER_ID, { refundAmount: 20, reason: 'r' }, ADMIN_ACTOR),
    );
    const env = enqueued.find((e) => e.topic === 'evt.refund.issued');
    expect(env, 'evt.refund.issued outbox row must land').toBeDefined();
    expect(env?.sourceModule).toBe('events');
    expect(capturedRefundId).toBeTruthy();
    expect(env?.eventId).toBe(deterministicRefundIssuedEventId(capturedRefundId!));
  });

  // ─── R-B1c — event complete enqueues outbox INSIDE tx ───
  it('R-B1c: EventService.complete enqueues evt.event.completed via OutboxService.enqueueInTx', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes("update evt_events set status = 'completed'")) {
        return [{ updated_at: '2026-06-01T20:00:00Z' }];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 'T',
            description: null,
            event_type: 'PERFORMANCE',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: 100,
            total_tier_quantity: 100,
            linked_game_id: null,
            status: 'COMPLETED',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.complete(EVENT_ID, ADMIN_ACTOR),
    );
    const env = enqueued.find((e) => e.topic === 'evt.event.completed');
    expect(env).toBeDefined();
    expect(env?.eventId).toBe(deterministicEventCompletedEventId(EVENT_ID));
    expect(env?.payload?.eventId).toBe(EVENT_ID);
  });

  // ─── R-B1d — athletic event create enqueues outbox INSIDE tx ───
  it('R-B1d: EventService.create with ATHLETIC_GAME + linked_game_id enqueues evt.athletic_event.created', async () => {
    const GAME = '019e0cf8-aaaa-7000-8000-00000000ga01';
    const ROSTER = '019e0cf8-aaaa-7000-8000-00000000ro01';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // School-scoped game lookup
      if (
        sql.includes('from ath_games g') &&
        sql.includes('join ath_rosters ar') &&
        sql.includes('pr.school_id = $2::uuid')
      ) {
        return [{ roster_id: ROSTER }];
      }
      // INSERT … SELECT comp population (returns 0 affected; we just want emit)
      if (sql.includes('insert into evt_comp_lists')) return 0;
      if (sql.includes('insert into evt_events')) return 0;
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 'Basketball',
            description: null,
            event_type: 'ATHLETIC_GAME',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: null,
            total_tier_quantity: 0,
            linked_game_id: GAME,
            status: 'DRAFT',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.create(
        {
          title: 'Basketball vs Eastside',
          eventType: 'ATHLETIC_GAME',
          eventDate: '2026-05-15',
          startTime: '19:00',
          linkedGameId: GAME,
        },
        ADMIN_ACTOR,
      ),
    );
    const env = enqueued.find((e) => e.topic === 'evt.athletic_event.created');
    expect(env, 'evt.athletic_event.created outbox row must land').toBeDefined();
    expect(env?.sourceModule).toBe('events');
    // eventId not yet known at test time — assert the helper produces a v5-shaped UUID
    expect(env?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  // ─── R-B1e — deterministic event IDs ───
  it('R-B1e: deterministic event IDs are stable + v5-shaped', () => {
    const oid = '019e0cf8-aaaa-7000-8000-deadbeef0001';
    const a = deterministicOrderConfirmedEventId(oid);
    const b = deterministicOrderConfirmedEventId(oid);
    const c = deterministicOrderConfirmedEventId('019e0cf8-aaaa-7000-8000-deadbeef0002');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    const v5shape = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(a).toMatch(v5shape);
    expect(deterministicRefundIssuedEventId('refund-1')).toMatch(v5shape);
    expect(deterministicEventCompletedEventId('evt-1')).toMatch(v5shape);
    expect(deterministicAthleticEventCreatedEventId('evt-1')).toMatch(v5shape);
    // Topic suffix uniqueness — same key should not collide across topics
    const k = 'shared-key';
    expect(deterministicOrderConfirmedEventId(k)).not.toBe(deterministicRefundIssuedEventId(k));
    expect(deterministicOrderConfirmedEventId(k)).not.toBe(deterministicEventCompletedEventId(k));
    expect(deterministicEventCompletedEventId(k)).not.toBe(
      deterministicAthleticEventCreatedEventId(k),
    );
  });

  // ─── R-B2 — STRIPE_DEV_AUTO_CONFIRM enqueues evt.order.confirmed ───
  it('R-B2: STRIPE_DEV_AUTO_CONFIRM=true enqueues evt.order.confirmed in the purchase tx', async () => {
    const prev = process.env.STRIPE_DEV_AUTO_CONFIRM;
    process.env.STRIPE_DEV_AUTO_CONFIRM = 'true';
    try {
      const fake = makeFake((c) => {
        const sql = c.sql.toLowerCase();
        if (sql.includes('select id::text as id, status, title from evt_events')) {
          return [{ id: EVENT_ID, status: 'ON_SALE', title: 'AutoConfirm' }];
        }
        if (sql.includes('from evt_ticket_tiers t') && sql.includes('join evt_events e')) {
          return [
            {
              id: TIER_ID,
              event_id: EVENT_ID,
              name: 'G',
              price: 10,
              quantity: 100,
              quantity_sold: 0,
              is_active: true,
              sale_starts_at: null,
              sale_ends_at: null,
            },
          ];
        }
        if (
          sql.includes('update evt_ticket_tiers') &&
          sql.includes('quantity_sold + $1 <= quantity')
        ) {
          return [{ new_sold: 1 }];
        }
        if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
          return [
            {
              id: EVENT_ID,
              school_id: SCHOOL.schoolId,
              title: 'AutoConfirm',
              description: null,
              event_type: 'PERFORMANCE',
              event_date: '2026-05-15',
              start_time: '19:00:00',
              end_time: null,
              venue_id: null,
              venue_name: null,
              total_capacity: 100,
              total_tier_quantity: 100,
              linked_game_id: null,
              status: 'ON_SALE',
              created_by: ADMIN_ACTOR.personId,
              created_at: 't',
              updated_at: 't',
            },
          ];
        }
        if (sql.includes('from evt_orders o') && sql.includes('limit 1')) {
          return [
            {
              id: ORDER_ID,
              event_id: EVENT_ID,
              event_title: 'AutoConfirm',
              purchaser_id: PARENT_ACTOR.personId,
              purchaser_name: 'P',
              status: 'CONFIRMED',
              total_amount: 10,
              stripe_payment_intent_id: 'pi_dev_evt_abc',
              expires_at: null,
              confirmed_at: 't',
              cancelled_at: null,
              cancellation_reason: null,
              created_at: 't',
            },
          ];
        }
        return [];
      });
      const { outbox, enqueued } = makeOutbox();
      const events = new EventService(
        fake.tenantPrisma as never,
        outbox as never,
        makePerms() as never,
      );
      const orders = new OrderService(
        fake.tenantPrisma as never,
        outbox as never,
        makePerms() as never,
        events,
      );
      await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
      );
      const env = enqueued.find((e) => e.topic === 'evt.order.confirmed');
      expect(env, 'STRIPE_DEV_AUTO_CONFIRM must enqueue evt.order.confirmed').toBeDefined();
      expect(env?.payload?.autoConfirmed).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.STRIPE_DEV_AUTO_CONFIRM;
      else process.env.STRIPE_DEV_AUTO_CONFIRM = prev;
    }
  });

  // ─── R-B3a — athletic comp auto-populate JOINs through ath_programmes.school_id ───
  it('R-B3a: athletic comp population JOINs through ath_programmes.school_id (defence-in-depth)', async () => {
    const GAME = '019e0cf8-aaaa-7000-8000-00000000ga01';
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (sql.includes('from ath_games g') && sql.includes('join ath_programmes pr')) {
        return [{ roster_id: 'roster-1' }];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 't',
            description: null,
            event_type: 'ATHLETIC_GAME',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: null,
            total_tier_quantity: 0,
            linked_game_id: GAME,
            status: 'DRAFT',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.create(
        {
          title: 'Basketball',
          eventType: 'ATHLETIC_GAME',
          eventDate: '2026-05-15',
          startTime: '19:00',
          linkedGameId: GAME,
        },
        ADMIN_ACTOR,
      ),
    );
    // ATHLETE INSERT … SELECT must JOIN through ath_programmes pr2 with school_id predicate
    const athleteIns = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('insert into evt_comp_lists') &&
        c.sql.toLowerCase().includes("'athlete'") &&
        c.sql.toLowerCase().includes('ath_programmes pr2'),
    );
    expect(athleteIns, 'ATHLETE INSERT must JOIN ath_programmes pr2').toBeDefined();
    // COACH INSERT … SELECT must JOIN through ath_programmes pr3
    const coachIns = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('insert into evt_comp_lists') &&
        c.sql.toLowerCase().includes("'coach'") &&
        c.sql.toLowerCase().includes('ath_programmes pr3'),
    );
    expect(coachIns, 'COACH INSERT must JOIN ath_programmes pr3').toBeDefined();
    // OFFICIAL INSERT … SELECT must JOIN through ath_programmes pr4
    const officialIns = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('insert into evt_comp_lists') &&
        c.sql.toLowerCase().includes("'official'") &&
        c.sql.toLowerCase().includes('ath_programmes pr4'),
    );
    expect(officialIns, 'OFFICIAL INSERT must JOIN ath_programmes pr4').toBeDefined();
  });

  // ─── R-B3b — foreign-school linked game → 0 comps + WARN log ───
  it('R-B3b: foreign-school linked_game_id resolves to 0 rows so comp INSERTs never run', async () => {
    const FOREIGN_GAME = '019e0cf8-aaaa-7000-8000-fffffffff001';
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      // Foreign-school game lookup returns 0 rows
      if (sql.includes('from ath_games g') && sql.includes('pr.school_id = $2::uuid')) {
        return [];
      }
      if (sql.includes('from evt_events e') && sql.includes('limit 1')) {
        return [
          {
            id: EVENT_ID,
            school_id: SCHOOL.schoolId,
            title: 't',
            description: null,
            event_type: 'ATHLETIC_GAME',
            event_date: '2026-05-15',
            start_time: '19:00:00',
            end_time: null,
            venue_id: null,
            venue_name: null,
            total_capacity: null,
            total_tier_quantity: 0,
            linked_game_id: FOREIGN_GAME,
            status: 'DRAFT',
            created_by: ADMIN_ACTOR.personId,
            created_at: 't',
            updated_at: 't',
          },
        ];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.create(
        {
          title: 'Foreign-game test',
          eventType: 'ATHLETIC_GAME',
          eventDate: '2026-05-15',
          startTime: '19:00',
          linkedGameId: FOREIGN_GAME,
        },
        ADMIN_ACTOR,
      ),
    );
    // No comp-list INSERT … SELECT should have fired
    const compIns = captures.filter((c) =>
      c.sql.toLowerCase().includes('insert into evt_comp_lists'),
    );
    expect(compIns.length).toBe(0);
  });

  // ─── R-B4a — season pass gate validates target event ───
  it('R-B4a: season pass gate denies when target event is not in current school', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included')) {
        return [
          {
            status: 'ACTIVE',
            events_included: null,
            pass_type: 'All Sports',
            academic_year: '2025-2026',
          },
        ];
      }
      // Foreign-school event → 0 rows
      if (sql.includes('from evt_events') && sql.includes('event_type, event_date::text')) {
        return [];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: 'pass-1', eventId: 'foreign-event' }, ADMIN_ACTOR),
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/Event not found/i);
  });

  // ─── R-B4b — events_included IS NULL admits only via pass-type/year match ───
  it('R-B4b: events_included IS NULL denies when event type does not match pass coverage', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included')) {
        return [
          {
            status: 'ACTIVE',
            events_included: null,
            pass_type: 'All Sports',
            academic_year: '2025-2026',
          },
        ];
      }
      if (sql.includes('from evt_events') && sql.includes('event_type, event_date::text')) {
        // Event exists in this school but is a FUNDRAISER — sports pass does not cover
        return [
          {
            id: 'evt-1',
            event_type: 'FUNDRAISER',
            event_date: '2025-12-15',
            status: 'ON_SALE',
          },
        ];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: 'pass-1', eventId: 'evt-1' }, ADMIN_ACTOR),
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/does not cover/i);
  });

  // ─── R-B4c — events_included IS NULL with matching event_type + year admits ───
  it('R-B4c: events_included IS NULL admits when pass_type and academic_year match', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included')) {
        return [
          {
            status: 'ACTIVE',
            events_included: null,
            pass_type: 'All Sports',
            academic_year: '2025-2026',
          },
        ];
      }
      if (sql.includes('from evt_events') && sql.includes('event_type, event_date::text')) {
        return [
          {
            id: 'evt-1',
            event_type: 'ATHLETIC_GAME',
            event_date: '2025-10-15',
            status: 'ON_SALE',
          },
        ];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: 'pass-1', eventId: 'evt-1' }, ADMIN_ACTOR),
    );
    expect(result.admitted).toBe(true);
  });

  // ─── R-B4d — event_date outside academic year denied ───
  it('R-B4d: events_included IS NULL denies when event_date falls outside academic_year window', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included')) {
        return [
          {
            status: 'ACTIVE',
            events_included: null,
            pass_type: 'All Sports',
            academic_year: '2025-2026',
          },
        ];
      }
      if (sql.includes('from evt_events') && sql.includes('event_type, event_date::text')) {
        // 2027 date — outside the 2025-2026 academic window
        return [
          {
            id: 'evt-1',
            event_type: 'ATHLETIC_GAME',
            event_date: '2027-10-15',
            status: 'ON_SALE',
          },
        ];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: 'pass-1', eventId: 'evt-1' }, ADMIN_ACTOR),
    );
    expect(result.admitted).toBe(false);
    expect(result.reason).toMatch(/outside.*pass window/i);
  });

  // ─── R-B5a — Comp add refused on unaffiliated STUDENT personId ───
  it('R-B5a: CompListService.add refuses arbitrary personId for STUDENT compType', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // Event in school
      if (sql.includes('select id from evt_events where id = $1::uuid and school_id')) {
        return [{ id: EVENT_ID }];
      }
      // sis_students lookup misses
      if (sql.includes('from sis_students s') && sql.includes('platform.platform_students ps')) {
        return [];
      }
      return [];
    });
    const comp = new CompListService(fake.tenantPrisma as never, makePerms() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        comp.add(
          EVENT_ID,
          { compType: 'STUDENT', personId: '019e0000-0000-7000-8000-000000000bbb' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── R-B5b — Comp add refused on unaffiliated COACH personId ───
  it('R-B5b: CompListService.add refuses unaffiliated COACH personId (hr_employees miss)', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id from evt_events where id = $1::uuid and school_id')) {
        return [{ id: EVENT_ID }];
      }
      if (sql.includes('from hr_employees') && sql.includes('person_id = $1::uuid')) {
        return [];
      }
      return [];
    });
    const comp = new CompListService(fake.tenantPrisma as never, makePerms() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        comp.add(
          EVENT_ID,
          { compType: 'COACH', personId: '019e0000-0000-7000-8000-000000000ccc' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── R-B5c — Comp add refused for VIP without any tenant projection ───
  it('R-B5c: CompListService.add refuses VIP personId with no current-tenant projection', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id from evt_events where id = $1::uuid and school_id')) {
        return [{ id: EVENT_ID }];
      }
      // UNION ALL projection query — returns 0 rows
      if (sql.includes('union all')) return [];
      return [];
    });
    const comp = new CompListService(fake.tenantPrisma as never, makePerms() as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        comp.add(
          EVENT_ID,
          { compType: 'VIP', personId: '019e0000-0000-7000-8000-00000000fff1' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── R-B5d — Comp add succeeds on real STUDENT projection ───
  it('R-B5d: CompListService.add accepts STUDENT personId when sis_students projection exists', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id from evt_events where id = $1::uuid and school_id')) {
        return [{ id: EVENT_ID }];
      }
      if (sql.includes('from sis_students s') && sql.includes('platform.platform_students ps')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('insert into evt_comp_lists')) return 1;
      // listForEvent reload
      if (sql.includes('from evt_comp_lists c') && sql.includes('join evt_events e')) {
        return [
          {
            id: 'will-be-replaced',
            event_id: EVENT_ID,
            comp_type: 'STUDENT',
            person_id: '019e0000-0000-7000-8000-000000000aaa',
            person_name: 'Maya Chen',
            notes: null,
            added_by: ADMIN_ACTOR.personId,
            added_by_name: 'Admin',
            added_at: 't',
          },
        ];
      }
      return [];
    });
    const comp = new CompListService(fake.tenantPrisma as never, makePerms() as never);
    // We mutate the listForEvent return so the service's `.find(c => c.id === id)`
    // resolves cleanly. Capture the insert id first:
    let insertedId: string | null = null;
    const origQ = fake.client.$queryRawUnsafe;
    fake.client.$queryRawUnsafe = async (sql: string, ...args: unknown[]) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from evt_comp_lists c') && lower.includes('join evt_events e')) {
        return [
          {
            id: insertedId ?? 'no-id-yet',
            event_id: EVENT_ID,
            comp_type: 'STUDENT',
            person_id: '019e0000-0000-7000-8000-000000000aaa',
            person_name: 'Maya Chen',
            notes: null,
            added_by: ADMIN_ACTOR.personId,
            added_by_name: 'Admin',
            added_at: 't',
          },
        ];
      }
      return origQ(sql, ...args);
    };
    const origE = fake.client.$executeRawUnsafe;
    fake.client.$executeRawUnsafe = async (sql: string, ...args: unknown[]) => {
      if (sql.toLowerCase().includes('insert into evt_comp_lists')) {
        insertedId = String(args[0]);
      }
      return origE(sql, ...args);
    };
    const res = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      comp.add(
        EVENT_ID,
        { compType: 'STUDENT', personId: '019e0000-0000-7000-8000-000000000aaa' },
        ADMIN_ACTOR,
      ),
    );
    expect(res.compType).toBe('STUDENT');
    expect(res.personId).toBe('019e0000-0000-7000-8000-000000000aaa');
  });
});

describe('REVIEW-P2C12 ROUND 1 — MAJOR regressions', () => {
  // ─── R-M1 — SOLD_OUT UPDATE carries school predicate ───
  it('R-M1: maybeAutoFlipSoldOut UPDATE carries the school_id predicate', async () => {
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status from evt_events') && sql.includes('for update')) {
        return [{ status: 'ON_SALE' }];
      }
      if (sql.includes('select count(*)::int as n from evt_ticket_tiers')) {
        return [{ n: 0 }];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.maybeAutoFlipSoldOut(EVENT_ID),
    );
    const flip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_events set status = 'sold_out'"),
    );
    expect(flip).toBeDefined();
    expect(flip!.sql.toLowerCase()).toContain('and school_id = $2::uuid');
    expect(flip!.args[1]).toBe(SCHOOL.schoolId);
  });

  // ─── R-M2 — loadTiers JOINs through evt_events with school predicate ───
  it('R-M2: loadTiers SELECT JOINs evt_events with the school predicate', async () => {
    const captures: CapturedCall[] = [];
    const fake = makeFake((c) => {
      captures.push(c);
      const sql = c.sql.toLowerCase();
      if (sql.includes('from evt_ticket_tiers t') && sql.includes('join evt_events e')) {
        return [];
      }
      return [];
    });
    const { outbox } = makeOutbox();
    const events = new EventService(
      fake.tenantPrisma as never,
      outbox as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () => events.loadTiers(EVENT_ID));
    const select = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('from evt_ticket_tiers t') &&
        c.sql.toLowerCase().includes('join evt_events e') &&
        c.sql.toLowerCase().includes('e.school_id = $2::uuid'),
    );
    expect(select, 'loadTiers SELECT must JOIN evt_events with school predicate').toBeDefined();
    expect(select!.args[1]).toBe(SCHOOL.schoolId);
  });
});

// Re-export for `BadRequestException` linkage referenced in R-B5a..c
void BadRequestException;
void NotFoundException;
