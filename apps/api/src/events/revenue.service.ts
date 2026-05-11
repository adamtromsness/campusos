import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import type {
  EventStatus,
  EventType,
  TierRevenueDto,
  RevenueReportDto,
  RevenueRowDto,
  RevenueSummaryDto,
} from './dto/events.dto';

// Stripe standard fee model — 2.9% + $0.30 per successful charge. The
// estimate is for the revenue report only; the canonical fee number lives
// on the actual Stripe payout once that integration ships per ADR.
const STRIPE_FEE_PERCENT = 0.029;
const STRIPE_FEE_FIXED = 0.3;

interface EventHeaderRow {
  id: string;
  title: string;
  event_date: string;
  status: string;
}

interface TierRow {
  tier_id: string;
  tier_name: string;
  price: string | number;
}

interface OrderRow {
  status: string;
  total_amount: string | number;
}

interface RefundRow {
  refund_amount: string | number;
}

@Injectable()
export class EventRevenueService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertReader(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:write',
      'evt-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Revenue reports require evt-001:write or admin scope.');
    }
  }

  /**
   * GET /events/:id/revenue — per-event revenue + attendance rollup.
   *
   * Aggregates pulled from a single tenant context so the row counts
   * stay consistent across the response.
   *
   *   Gross sales       = SUM(orders WHERE status IN CONFIRMED/REFUNDED).total_amount
   *   Refunds           = SUM(evt_refunds.refund_amount)
   *   Net               = gross - refunds
   *   Stripe fees est.  = gross * 2.9% + 0.30 * confirmed_order_count
   *   Tickets scanned   = COUNT(evt_tickets WHERE status='USED')
   *   Season pass admits= COUNT(evt_ticket_scans WHERE ticket_id IS NULL AND scan_result='VALID' AND scan_source LIKE 'SEASON_PASS%')
   *   Comp admits       = COUNT(evt_ticket_scans WHERE ticket_id IS NULL AND scan_result='VALID' AND scan_source LIKE 'COMP%')
   *
   * Per-tier rollup is grouped by tier_id with the live ticket count and
   * tier price as the gross multiplier.
   */
  async forEvent(eventId: string, actor: ResolvedActor): Promise<RevenueReportDto> {
    await this.assertReader(actor);
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const eventRows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, title, event_date::text AS event_date, status
         FROM evt_events
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        eventId,
        tenant.schoolId,
      )) as EventHeaderRow[];
      if (eventRows.length === 0) throw new NotFoundException('Event not found');
      const event = eventRows[0]!;

      const orderRows = (await client.$queryRawUnsafe(
        `SELECT status, total_amount
         FROM evt_orders
         WHERE event_id = $1::uuid AND status IN ('CONFIRMED', 'REFUNDED')`,
        eventId,
      )) as OrderRow[];
      const confirmedOrders = orderRows.filter((r) => r.status === 'CONFIRMED').length;
      const refundedOrders = orderRows.filter((r) => r.status === 'REFUNDED').length;
      const grossSales = orderRows.reduce((acc, r) => acc + Number(r.total_amount), 0);

      const refundRows = (await client.$queryRawUnsafe(
        `SELECT refund_amount
         FROM evt_refunds r
         JOIN evt_orders o ON o.id = r.order_id
         WHERE o.event_id = $1::uuid`,
        eventId,
      )) as RefundRow[];
      const refundsIssued = refundRows.reduce((acc, r) => acc + Number(r.refund_amount), 0);
      const net = grossSales - refundsIssued;
      const estStripe = grossSales * STRIPE_FEE_PERCENT + STRIPE_FEE_FIXED * confirmedOrders;

      const ticketsRows = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE t.status IN ('VALID','USED'))::int AS sold,
           COUNT(*) FILTER (WHERE t.status = 'USED')::int AS scanned
         FROM evt_tickets t
         JOIN evt_orders o ON o.id = t.order_id
         WHERE o.event_id = $1::uuid AND o.status = 'CONFIRMED'`,
        eventId,
      )) as Array<{ sold: number; scanned: number }>;
      const totalSold = Number(ticketsRows[0]?.sold ?? 0);
      const totalScanned = Number(ticketsRows[0]?.scanned ?? 0);

      const passScans = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE scan_source LIKE 'SEASON_PASS%')::int AS season_pass,
           COUNT(*) FILTER (WHERE scan_source LIKE 'COMP%')::int AS comp
         FROM evt_ticket_scans
         WHERE event_id = $1::uuid AND scan_result = 'VALID' AND ticket_id IS NULL`,
        eventId,
      )) as Array<{ season_pass: number; comp: number }>;
      const seasonPassAdmits = Number(passScans[0]?.season_pass ?? 0);
      const compAdmits = Number(passScans[0]?.comp ?? 0);

      const tierRows = (await client.$queryRawUnsafe(
        `SELECT t.id::text AS tier_id, t.name AS tier_name, t.price
         FROM evt_ticket_tiers t WHERE t.event_id = $1::uuid ORDER BY t.created_at ASC`,
        eventId,
      )) as TierRow[];
      const tierSummaries: TierRevenueDto[] = [];
      for (const t of tierRows) {
        const ticketCount = (await client.$queryRawUnsafe(
          `SELECT
             COUNT(*) FILTER (WHERE tk.status IN ('VALID','USED'))::int AS sold,
             COUNT(*) FILTER (WHERE tk.status = 'USED')::int AS scanned
           FROM evt_tickets tk
           JOIN evt_orders o ON o.id = tk.order_id
           WHERE tk.tier_id = $1::uuid AND o.status = 'CONFIRMED'`,
          t.tier_id,
        )) as Array<{ sold: number; scanned: number }>;
        const sold = Number(ticketCount[0]?.sold ?? 0);
        const scanned = Number(ticketCount[0]?.scanned ?? 0);
        tierSummaries.push({
          tierId: t.tier_id,
          tierName: t.tier_name,
          price: Number(t.price),
          quantitySold: sold,
          ticketsScanned: scanned,
          grossRevenue: Number((Number(t.price) * sold).toFixed(2)),
        });
      }

      return {
        eventId: event.id,
        eventTitle: event.title,
        eventDate: event.event_date,
        status: event.status as EventStatus,
        grossTicketSales: Number(grossSales.toFixed(2)),
        refundsIssued: Number(refundsIssued.toFixed(2)),
        netRevenue: Number(net.toFixed(2)),
        estimatedStripeFees: Number(estStripe.toFixed(2)),
        ordersConfirmed: confirmedOrders,
        ordersRefunded: refundedOrders,
        totalTicketsSold: totalSold,
        totalTicketsScanned: totalScanned,
        seasonPassAdmissions: seasonPassAdmits,
        compAdmissions: compAdmits,
        tiers: tierSummaries,
      };
    });
    return result;
  }

  /**
   * GET /events/revenue/summary?from=&to= — school-wide rollup by event
   * type for the supplied date window. Defaults to last 90 days when no
   * window is supplied. Confirmed + refunded orders both contribute to
   * the gross figure; refunds reduce net.
   */
  async summary(
    args: { from?: string; to?: string },
    actor: ResolvedActor,
  ): Promise<RevenueSummaryDto> {
    await this.assertReader(actor);
    const tenant = getCurrentTenant();
    const to = args.to ?? new Date().toISOString().slice(0, 10);
    const fromDate = args.from
      ? args.from
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT e.event_type,
                COUNT(o.id) FILTER (WHERE o.status = 'CONFIRMED')::int AS orders_confirmed,
                COALESCE(SUM(o.total_amount) FILTER (WHERE o.status IN ('CONFIRMED','REFUNDED')), 0)::numeric AS gross,
                COALESCE((SELECT SUM(r.refund_amount)
                          FROM evt_refunds r
                          JOIN evt_orders ro ON ro.id = r.order_id
                          JOIN evt_events re ON re.id = ro.event_id
                          WHERE re.school_id = $1::uuid
                            AND re.event_type = e.event_type
                            AND re.event_date >= $2::date AND re.event_date <= $3::date), 0)::numeric AS refunds,
                COALESCE(SUM(
                  (SELECT COUNT(*) FROM evt_tickets t
                   WHERE t.order_id = o.id AND t.status IN ('VALID','USED'))
                ) FILTER (WHERE o.status = 'CONFIRMED'), 0)::int AS tickets_sold
         FROM evt_events e
         LEFT JOIN evt_orders o ON o.event_id = e.id
         WHERE e.school_id = $1::uuid
           AND e.event_date >= $2::date AND e.event_date <= $3::date
         GROUP BY e.event_type
         ORDER BY e.event_type`,
        tenant.schoolId,
        fromDate,
        to,
      )) as Array<{
        event_type: string;
        orders_confirmed: number;
        gross: string | number;
        refunds: string | number;
        tickets_sold: number;
      }>;

      const byEventType: RevenueRowDto[] = rows.map((r) => {
        const gross = Number(r.gross);
        const refunds = Number(r.refunds);
        return {
          eventType: r.event_type as EventType,
          ordersConfirmed: Number(r.orders_confirmed),
          ticketsSold: Number(r.tickets_sold),
          grossRevenue: Number(gross.toFixed(2)),
          refundsIssued: Number(refunds.toFixed(2)),
          netRevenue: Number((gross - refunds).toFixed(2)),
        };
      });

      const totals = byEventType.reduce(
        (acc, r) => ({
          grossRevenue: acc.grossRevenue + r.grossRevenue,
          refundsIssued: acc.refundsIssued + r.refundsIssued,
          netRevenue: acc.netRevenue + r.netRevenue,
          ordersConfirmed: acc.ordersConfirmed + r.ordersConfirmed,
          ticketsSold: acc.ticketsSold + r.ticketsSold,
        }),
        {
          grossRevenue: 0,
          refundsIssued: 0,
          netRevenue: 0,
          ordersConfirmed: 0,
          ticketsSold: 0,
        },
      );

      return {
        schoolId: tenant.schoolId,
        from: fromDate,
        to,
        byEventType,
        totals: {
          grossRevenue: Number(totals.grossRevenue.toFixed(2)),
          refundsIssued: Number(totals.refundsIssued.toFixed(2)),
          netRevenue: Number(totals.netRevenue.toFixed(2)),
          ordersConfirmed: totals.ordersConfirmed,
          ticketsSold: totals.ticketsSold,
        },
      };
    });
  }
}
