import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EventsController } from '@modules/m101-events/events.controller';
import { EventService, TierService } from '@modules/m101-events/events.service';
import { OrderService, RefundService } from '@modules/m101-events/orders.service';
import {
  CompListService,
  GateScanService,
  SeasonPassService,
  VolunteerService,
} from '@modules/m101-events/gate.service';
import { EventRevenueService } from '@modules/m101-events/revenue.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_PARENT_PERSON_ID,
} from '../helpers/actor';
import { resetEventsTables } from '../fixtures/events';

class SwitchingActorContext {
  current: ResolvedActor = adminActor();
  async resolveActor(): Promise<ResolvedActor> {
    return this.current;
  }
}

describe('integration:m101-events/controllers', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: EventsController;
  let actorStub: SwitchingActorContext;
  let req: {
    user: { sub: string; personId: string; email: string; displayName: string; sessionId: string };
  };

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();

    const events = new EventService(tenantPrisma, outbox, permCheck);
    const tiers = new TierService(tenantPrisma, events);
    const orders = new OrderService(tenantPrisma, outbox, permCheck, events);
    const refunds = new RefundService(tenantPrisma, outbox, permCheck);
    const gate = new GateScanService(tenantPrisma, permCheck);
    const passes = new SeasonPassService(tenantPrisma, permCheck);
    const compList = new CompListService(tenantPrisma, permCheck);
    const vols = new VolunteerService(tenantPrisma, permCheck);
    const revenue = new EventRevenueService(tenantPrisma, permCheck);

    actorStub = new SwitchingActorContext();
    ctl = new EventsController(
      events,
      tiers,
      orders,
      refunds,
      gate,
      passes,
      compList,
      vols,
      revenue,
      actorStub as unknown as ActorContextService,
    );

    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
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
    await resetEventsTables(rawClient);
    vi.unstubAllEnvs();
    actorStub.current = adminActor();
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  async function seedEventDirect(
    opts: {
      schoolId?: string;
      eventType?: string;
      status?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_events
         (id, school_id, title, event_type, event_date, start_time, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'C', $3, $4::date, '19:00', $5, $6::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.eventType ?? 'PERFORMANCE',
      dateFuture(14),
      opts.status ?? 'DRAFT',
      TEST_ADMIN_PERSON_ID,
    );
    return id;
  }

  describe('event endpoints', () => {
    it('createEvent + listEvents + getEvent', async () => {
      const created = await withTestTenant(async () =>
        ctl.createEvent(
          {
            title: 'Ctl Event',
            eventType: 'PERFORMANCE',
            eventDate: dateFuture(30),
            startTime: '19:00',
          } as any,
          req as any,
        ),
      );
      expect(created.status).toBe('DRAFT');

      const list = await withTestTenant(async () => ctl.listEvents(req as any));
      expect(list.length).toBe(1);

      const got = await withTestTenant(async () => ctl.getEvent(created.id, req as any));
      expect(got.id).toBe(created.id);
    });

    it('listEvents with filters', async () => {
      await seedEventDirect({ status: 'ON_SALE', eventType: 'PERFORMANCE' });
      await seedEventDirect({ status: 'ON_SALE', eventType: 'DANCE' });
      const filtered = await withTestTenant(async () =>
        ctl.listEvents(req as any, 'ON_SALE' as any, 'DANCE' as any, dateFuture(0)),
      );
      expect(filtered.length).toBe(1);
    });

    it('patchEvent + completeEvent', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const patched = await withTestTenant(async () =>
        ctl.patchEvent(id, { status: 'ON_SALE' as any } as any, req as any),
      );
      expect(patched.status).toBe('ON_SALE');
      const completed = await withTestTenant(async () => ctl.completeEvent(id, req as any));
      expect(completed.status).toBe('COMPLETED');
    });

    it('tier endpoints: listTiers + createTier + patchTier', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      expect(tier.name).toBe('GA');

      const list = await withTestTenant(async () => ctl.listTiers(id));
      expect(list.length).toBe(1);

      const patched = await withTestTenant(async () =>
        ctl.patchTier(tier.id, { price: 12 } as any, req as any),
      );
      expect(patched.price).toBe(12);
    });
  });

  describe('order/refund/gate endpoints', () => {
    it('purchase + listOrders + listMyOrders + getOrder + confirmOrder + cancelOrder', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', '');
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      const ord = await withTestTenant(async () =>
        ctl.purchase(id, { lines: [{ tierId: tier.id, quantity: 2 }] } as any, req as any),
      );
      expect(ord.status).toBe('PENDING');

      const list = await withTestTenant(async () => ctl.listOrders(req as any));
      expect(list.length).toBe(1);

      const mine = await withTestTenant(async () => ctl.listMyOrders(req as any));
      expect(mine.length).toBe(1);

      const seen = await withTestTenant(async () => ctl.getOrder(ord.id, req as any));
      expect(seen.id).toBe(ord.id);

      const confirmed = await withTestTenant(async () =>
        ctl.confirmOrder(ord.id, {} as any, req as any),
      );
      expect(confirmed.status).toBe('CONFIRMED');
    });

    it('cancelOrder on PENDING flips to CANCELLED', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', '');
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      const ord = await withTestTenant(async () =>
        ctl.purchase(id, { lines: [{ tierId: tier.id, quantity: 1 }] } as any, req as any),
      );
      const cancelled = await withTestTenant(async () =>
        ctl.cancelOrder(ord.id, { cancellationReason: 'x' } as any, req as any),
      );
      expect(cancelled!.status).toBe('CANCELLED');
    });

    it('issueRefund + listRefunds', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', 'true');
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      const ord = await withTestTenant(async () =>
        ctl.purchase(id, { lines: [{ tierId: tier.id, quantity: 1 }] } as any, req as any),
      );
      const refund = await withTestTenant(async () =>
        ctl.issueRefund(ord.id, { refundAmount: 10, reason: 'requested' } as any, req as any),
      );
      expect(refund.refundAmount).toBe(10);

      const list = await withTestTenant(async () => ctl.listRefunds(ord.id, req as any));
      expect(list.length).toBe(1);
    });

    it('gateScan endpoint scans a ticket', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', 'true');
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      const ord = await withTestTenant(async () =>
        ctl.purchase(id, { lines: [{ tierId: tier.id, quantity: 1 }] } as any, req as any),
      );
      const result = await withTestTenant(async () =>
        ctl.gateScan({ qrCodeToken: ord.tickets[0]!.qrCodeToken } as any, req as any),
      );
      expect(result.scanResult).toBe('VALID');
    });
  });

  describe('season pass endpoints', () => {
    it('createSeasonPass + listSeasonPasses + listMyPasses + revokeSeasonPass + seasonPassGate', async () => {
      const pass = await withTestTenant(async () =>
        ctl.createSeasonPass(
          {
            personId: TEST_PARENT_PERSON_ID,
            passType: 'All Sports',
            price: 50,
            academicYear: '2025-2026',
          } as any,
          req as any,
        ),
      );
      expect(pass.status).toBe('ACTIVE');

      const list = await withTestTenant(async () => ctl.listSeasonPasses(req as any));
      expect(list.length).toBe(1);

      const mine = await withTestTenant(async () => ctl.listMyPasses(req as any));
      expect(mine.length).toBe(1);

      const eventId = await seedEventDirect({
        eventType: 'ATHLETIC_GAME',
        status: 'ON_SALE',
      });
      // Bypass DTO date check by manually setting event_date
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_events SET event_date = '2025-10-15' WHERE id = $1::uuid`,
        eventId,
      );
      const gate = await withTestTenant(async () =>
        ctl.seasonPassGate({ passId: pass.id, eventId } as any, req as any),
      );
      expect(gate.admitted).toBe(true);

      const revoked = await withTestTenant(async () => ctl.revokeSeasonPass(pass.id, req as any));
      expect(revoked.status).toBe('REVOKED');
    });
  });

  describe('comp list endpoints', () => {
    it('addComp + listComp + removeComp + compGate', async () => {
      const eventId = await seedEventDirect({ status: 'ON_SALE' });
      const entry = await withTestTenant(async () =>
        ctl.addComp(
          eventId,
          { compType: 'STAFF', personId: TEST_ADMIN_PERSON_ID } as any,
          req as any,
        ),
      );
      expect(entry.compType).toBe('STAFF');

      const list = await withTestTenant(async () => ctl.listComp(eventId, req as any));
      expect(list.length).toBe(1);

      const gate = await withTestTenant(async () =>
        ctl.compGate({ eventId, personId: TEST_ADMIN_PERSON_ID } as any, req as any),
      );
      expect(gate.admitted).toBe(true);

      const removed = await withTestTenant(async () =>
        ctl.removeComp(eventId, entry.id, req as any),
      );
      expect(removed.ok).toBe(true);
    });
  });

  describe('volunteer endpoints', () => {
    it('signUpVolunteer + listVolunteers + patchVolunteer', async () => {
      const eventId = await seedEventDirect({ status: 'ON_SALE' });
      actorStub.current = parentActor();
      const dto = await withTestTenant(async () =>
        ctl.signUpVolunteer(
          eventId,
          { personId: TEST_PARENT_PERSON_ID, role: 'gate' } as any,
          req as any,
        ),
      );
      expect(dto.status).toBe('SIGNED_UP');

      const list = await withTestTenant(async () => ctl.listVolunteers(eventId));
      expect(list.length).toBe(1);

      actorStub.current = adminActor();
      const patched = await withTestTenant(async () =>
        ctl.patchVolunteer(
          dto.id,
          { status: 'CONFIRMED' as any, checkIn: true } as any,
          req as any,
        ),
      );
      expect(patched.status).toBe('CONFIRMED');
      expect(patched.checkInAt).toBeTruthy();
    });
  });

  describe('revenue endpoints', () => {
    it('revenueForEvent + revenueSummary', async () => {
      vi.stubEnv('STRIPE_DEV_AUTO_CONFIRM', 'true');
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const tier = await withTestTenant(async () =>
        ctl.createTier(id, { name: 'GA', price: 10, quantity: 50 } as any, req as any),
      );
      await withTestTenant(async () =>
        ctl.purchase(id, { lines: [{ tierId: tier.id, quantity: 2 }] } as any, req as any),
      );
      const report = await withTestTenant(async () => ctl.revenueForEvent(id, req as any));
      expect(report.grossTicketSales).toBe(20);

      // Default summary `to` is today; the seeded event is 14 days in
      // the future. Pass a forward-looking `to` so the event falls in
      // the window.
      const to = dateFuture(30);
      const summary = await withTestTenant(async () =>
        ctl.revenueSummary(req as any, undefined, to),
      );
      expect(summary.totals.grossRevenue).toBeGreaterThan(0);
    });
  });
});
