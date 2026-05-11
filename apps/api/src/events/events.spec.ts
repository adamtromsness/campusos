import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext, TenantInfo } from '../tenant/tenant.context';
import { PERMISSIONS_KEY } from '../auth/require-permission.decorator';
import { EventService, TierService } from './events.service';
import { OrderService, RefundService } from './orders.service';
import { CompListService, GateScanService, SeasonPassService } from './gate.service';
import { EventRevenueService } from './revenue.service';
import { EventsController } from './events.controller';

/**
 * P2-12 Step 7 — Vertical-slice integration tests covering the 10
 * plan scenarios. Each test asserts a single load-bearing invariant
 * of the Events & Ticketing module.
 *
 *   S1. Atomic ticket sale (UPDATE WHERE quantity_sold+$qty<=quantity).
 *   S2. Concurrent sale race condition — exactly one 409 with qty=1.
 *   S3. Event capacity CHECK — tier total>capacity rejected.
 *   S4. Order expiry — OrderExpiryWorker cancels + decrements tier.
 *   S5. Gate scan atomic — VALID flip + ALREADY_SCANNED + INVALID.
 *   S6. Season pass — events_included gate, non-matching denied.
 *   S7. Comp list — gate check admits listed person, denies others.
 *   S8. Refund — tier.quantity_sold decremented + tickets REFUNDED.
 *   S9. Auto SOLD_OUT — all tiers sold flips event to SOLD_OUT.
 *  S10. Permission metadata — controller routes pinned to evt-001.
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

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: {
      topic: string;
      sourceModule: string;
      key: string;
      payload: Record<string, unknown>;
    }) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
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
      // Event existence check
      if (sql.includes('select id::text as id, status, title from evt_events')) {
        return [{ id: EVENT_ID, status: 'ON_SALE', title: 'Spring Musical' }];
      }
      // Tier lookup
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
      // ATOMIC UPDATE
      if (
        sql.includes('update evt_ticket_tiers') &&
        sql.includes('quantity_sold + $1 <= quantity')
      ) {
        return [{ new_sold: 2 }];
      }
      // Final reload (getById)
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
      // tiers reload
      if (sql.includes('from evt_ticket_tiers') && sql.includes('order by created_at')) {
        return [];
      }
      // Orders + tickets reload
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
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      kafka as never,
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
    // arg[0] is the increment quantity, arg[1] is the tier id
    expect(atomic!.args[0]).toBe(2);
    expect(atomic!.args[1]).toBe(TIER_ID);
  });

  // ─── S2 — Concurrent race condition ───
  it('S2: two purchases against tier qty=1 — first succeeds, second 409', async () => {
    let soldCount = 0; // simulates the atomic UPDATE under concurrency
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
        // Atomic — emulate Postgres "WHERE quantity_sold + qty <= quantity"
        if (soldCount + 1 <= 1) {
          soldCount += 1;
          return [{ new_sold: soldCount }];
        }
        return []; // 0 rows = sold out
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
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
      events,
    );

    // First purchase — winner
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
    );
    expect(soldCount).toBe(1);

    // Second purchase — loser, atomic UPDATE returns 0 rows
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
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const tiers = new TierService(fake.tenantPrisma as never, events);
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        tiers.create(EVENT_ID, { name: 'Overflow', price: 1, quantity: 999 }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ─── S4 — Order expiry ───
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
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      kafka as never,
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
    expect(decrement, 'tier decrement UPDATE must fire on cancel').toBeDefined();
    const ticketFlip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_tickets set status = 'cancelled'"),
    );
    expect(ticketFlip, 'tickets must flip to CANCELLED').toBeDefined();
    const orderFlip = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_orders') &&
        c.sql.toLowerCase().includes("status = 'cancelled'"),
    );
    expect(orderFlip, 'order must flip to CANCELLED').toBeDefined();
  });

  // ─── S5 — Atomic gate scan ───
  it('S5: gate scan VALID flips status=USED, logs to evt_ticket_scans, and ALREADY_SCANNED returns 0 from the UPDATE', async () => {
    let scanned = false;
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // The atomic gate scan UPDATE
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
        return []; // already scanned — RETURNING empty
      }
      // ALREADY_SCANNED lookup (run on 0-row update)
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
      // Tier name lookup
      if (sql.includes('select name from evt_ticket_tiers')) {
        return [{ name: 'General Admission' }];
      }
      // INSERT into evt_ticket_scans
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
    // Verify a scan-log INSERT happened
    expect(
      fake.capture.find((c) => c.sql.toLowerCase().includes('insert into evt_ticket_scans')),
    ).toBeDefined();

    const second = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      gate.scan({ qrCodeToken: 'tok-1', scanSource: 'TEST' }, ADMIN_ACTOR),
    );
    expect(second.scanResult).toBe('ALREADY_SCANNED');
  });

  // ─── S6 — Season pass admission rules ───
  it('S6: season pass admits matching events_included, denies non-matching, denies revoked', async () => {
    const ACTIVE_PASS = 'pass-active';
    const REVOKED_PASS = 'pass-revoked';
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status, events_included') && c.args[0] === ACTIVE_PASS) {
        return [{ status: 'ACTIVE', events_included: ['019e-incl-1', '019e-incl-2'] }];
      }
      if (sql.includes('select status, events_included') && c.args[0] === REVOKED_PASS) {
        return [{ status: 'REVOKED', events_included: null }];
      }
      return [];
    });
    const pass = new SeasonPassService(fake.tenantPrisma as never, makePerms() as never);
    const admit = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: ACTIVE_PASS, eventId: '019e-incl-1' }, ADMIN_ACTOR),
    );
    expect(admit.admitted).toBe(true);
    const deny = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: ACTIVE_PASS, eventId: '019e-not-incl' }, ADMIN_ACTOR),
    );
    expect(deny.admitted).toBe(false);
    expect(deny.reason).toMatch(/not in the pass/i);
    const revoked = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      pass.gateCheck({ passId: REVOKED_PASS, eventId: '019e-incl-1' }, ADMIN_ACTOR),
    );
    expect(revoked.admitted).toBe(false);
    expect(revoked.reason).toMatch(/REVOKED/);
  });

  // ─── S7 — Comp list admission ───
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

  // ─── S8 — Refund decrements tier.quantity_sold + emits evt.refund.issued ───
  it('S8: full-amount refund decrements tier.quantity_sold, flips tickets REFUNDED, emits evt.refund.issued', async () => {
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
        // First positional arg is the refundId generated by the service.
        capturedRefundId = String(c.args[0] ?? '');
        return 1;
      }
      // listForOrder reload after issue — return a row with the
      // service-generated refundId so RefundService.issue's `find`
      // succeeds and returns the dto.
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
      // listForOrder owner check
      if (sql.includes('select o.purchaser_id::text as pid')) {
        return [{ pid: PARENT_ACTOR.personId }];
      }
      return [];
    });
    const { kafka, emitted } = makeKafka();
    const refunds = new RefundService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const result = await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      refunds.issue(ORDER_ID, { refundAmount: 20, reason: 'Test refund' }, ADMIN_ACTOR),
    );
    expect(result.refundAmount).toBe(20);
    // tier decrement happens on full refunds
    const decrement = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_ticket_tiers t') &&
        c.sql.toLowerCase().includes('greatest(0, t.quantity_sold - tk.cnt)'),
    );
    expect(decrement, 'tier decrement must fire on full refund').toBeDefined();
    // tickets flipped to REFUNDED
    const ticketFlip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_tickets set status = 'refunded'"),
    );
    expect(ticketFlip).toBeDefined();
    // order flipped to REFUNDED
    const orderFlip = captures.find(
      (c) =>
        c.sql.toLowerCase().includes('update evt_orders') &&
        c.sql.toLowerCase().includes("status = 'refunded'"),
    );
    expect(orderFlip).toBeDefined();
    // Kafka emit on evt.refund.issued
    expect(emitted.find((e) => e.topic === 'evt.refund.issued')).toBeDefined();
    const env = emitted.find((e) => e.topic === 'evt.refund.issued');
    expect(env?.sourceModule).toBe('events');
    expect(env?.payload?.refundAmount).toBe(20);
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
        return [{ n: 0 }]; // 0 tiers with remaining capacity
      }
      return [];
    });
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL } as never, async () =>
      events.maybeAutoFlipSoldOut(EVENT_ID),
    );
    const flip = captures.find((c) =>
      c.sql.toLowerCase().includes("update evt_events set status = 'sold_out'"),
    );
    expect(flip, 'SOLD_OUT flip UPDATE must fire when all tiers full').toBeDefined();
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
    const perf = summary.byEventType.find((r) => r.eventType === 'PERFORMANCE');
    expect(perf?.netRevenue).toBe(90);
  });

  // ─── Bonus — Sale outside window rejected ───
  it('Bonus: purchase on a tier whose sale_starts_at is in the future returns BadRequestException', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status, title from evt_events')) {
        return [{ id: EVENT_ID, status: 'ON_SALE', title: 'Future' }];
      }
      if (sql.includes('from evt_ticket_tiers t') && sql.includes('join evt_events e')) {
        return [
          {
            id: TIER_ID,
            event_id: EVENT_ID,
            name: 'Future VIP',
            price: 25.0,
            quantity: 20,
            quantity_sold: 0,
            is_active: true,
            sale_starts_at: future,
            sale_ends_at: null,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
      events,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── Bonus — Order on non-ON_SALE event ───
  it('Bonus: purchase on DRAFT or COMPLETED event is rejected with BadRequest', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select id::text as id, status, title from evt_events')) {
        return [{ id: EVENT_ID, status: 'DRAFT', title: 'Draft' }];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    const orders = new OrderService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
      events,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        orders.purchase(EVENT_ID, { lines: [{ tierId: TIER_ID, quantity: 1 }] }, PARENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── Bonus — getEvent 404 don't-leak-existence ───
  it('Bonus: getEvent on a missing event throws NotFoundException', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const events = new EventService(
      fake.tenantPrisma as never,
      kafka as never,
      makePerms() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL } as never, async () =>
        events.getById('019e-missing', ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
