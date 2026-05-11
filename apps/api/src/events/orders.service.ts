import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { EventService } from './events.service';
import type {
  CancelOrderDto,
  ConfirmOrderDto,
  OrderDto,
  OrderStatus,
  PurchaseDto,
  RefundDto,
  RefundOrderDto,
  TicketDto,
  TicketStatus,
} from './dto/events.dto';

interface OrderRow {
  id: string;
  event_id: string;
  event_title: string | null;
  purchaser_id: string;
  purchaser_name: string | null;
  status: string;
  total_amount: string | number;
  stripe_payment_intent_id: string | null;
  expires_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
}

interface TicketRow {
  id: string;
  order_id: string;
  tier_id: string;
  tier_name: string | null;
  holder_name: string | null;
  qr_code_token: string;
  status: string;
  scanned_at: string | null;
}

interface RefundRow {
  id: string;
  order_id: string;
  refund_amount: string | number;
  reason: string;
  stripe_refund_id: string | null;
  refunded_by: string;
  refunded_at: string;
}

const ORDER_EXPIRY_MINUTES = 15;
const QR_TOKEN_BYTES = 24; // 48 hex chars

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
    private readonly events: EventService,
  ) {}

  private async isWriter(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:write',
      'evt-001:admin',
    ]);
  }

  private rowToDto(r: OrderRow, tickets: TicketDto[]): OrderDto {
    return {
      id: r.id,
      eventId: r.event_id,
      eventTitle: r.event_title,
      purchaserId: r.purchaser_id,
      purchaserName: r.purchaser_name,
      status: r.status as OrderStatus,
      totalAmount: Number(r.total_amount),
      stripePaymentIntentId: r.stripe_payment_intent_id,
      expiresAt: r.expires_at,
      confirmedAt: r.confirmed_at,
      cancelledAt: r.cancelled_at,
      cancellationReason: r.cancellation_reason,
      createdAt: r.created_at,
      tickets,
    };
  }

  private ticketRowToDto(r: TicketRow): TicketDto {
    return {
      id: r.id,
      orderId: r.order_id,
      tierId: r.tier_id,
      tierName: r.tier_name,
      holderName: r.holder_name,
      qrCodeToken: r.qr_code_token,
      status: r.status as TicketStatus,
      scannedAt: r.scanned_at,
    };
  }

  private async loadTickets(orderIds: string[]): Promise<Map<string, TicketDto[]>> {
    if (orderIds.length === 0) return new Map();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT t.id::text AS id, t.order_id::text AS order_id, t.tier_id::text AS tier_id,
                (SELECT name FROM evt_ticket_tiers WHERE id = t.tier_id) AS tier_name,
                t.holder_name, t.qr_code_token, t.status, t.scanned_at::text AS scanned_at
         FROM evt_tickets t
         WHERE t.order_id = ANY($1::uuid[])
         ORDER BY t.created_at ASC`,
        orderIds,
      );
    })) as TicketRow[];
    const out = new Map<string, TicketDto[]>();
    for (const r of rows) {
      const list = out.get(r.order_id) ?? [];
      list.push(this.ticketRowToDto(r));
      out.set(r.order_id, list);
    }
    return out;
  }

  async list(
    actor: ResolvedActor,
    filters?: { eventId?: string; status?: OrderStatus; mine?: boolean },
  ): Promise<OrderDto[]> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    const where: string[] = [
      'EXISTS (SELECT 1 FROM evt_events e WHERE e.id = o.event_id AND e.school_id = $1::uuid)',
    ];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    if (!writer || filters?.mine) {
      where.push(`o.purchaser_id = $${i++}::uuid`);
      params.push(actor.personId);
    }
    if (filters?.eventId) {
      where.push(`o.event_id = $${i++}::uuid`);
      params.push(filters.eventId);
    }
    if (filters?.status) {
      where.push(`o.status = $${i++}`);
      params.push(filters.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.event_id::text AS event_id,
                (SELECT title FROM evt_events WHERE id = o.event_id) AS event_title,
                o.purchaser_id::text AS purchaser_id,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = o.purchaser_id) AS purchaser_name,
                o.status, o.total_amount,
                o.stripe_payment_intent_id, o.expires_at::text AS expires_at,
                o.confirmed_at::text AS confirmed_at, o.cancelled_at::text AS cancelled_at,
                o.cancellation_reason, o.created_at::text AS created_at
         FROM evt_orders o
         WHERE ${where.join(' AND ')}
         ORDER BY o.created_at DESC LIMIT 200`,
        ...params,
      );
    })) as OrderRow[];
    const tickets = await this.loadTickets(rows.map((r) => r.id));
    return rows.map((r) => this.rowToDto(r, tickets.get(r.id) ?? []));
  }

  async getById(id: string, actor: ResolvedActor): Promise<OrderDto> {
    const tenant = getCurrentTenant();
    const writer = await this.isWriter(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.event_id::text AS event_id,
                (SELECT title FROM evt_events WHERE id = o.event_id) AS event_title,
                o.purchaser_id::text AS purchaser_id,
                (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = o.purchaser_id) AS purchaser_name,
                o.status, o.total_amount,
                o.stripe_payment_intent_id, o.expires_at::text AS expires_at,
                o.confirmed_at::text AS confirmed_at, o.cancelled_at::text AS cancelled_at,
                o.cancellation_reason, o.created_at::text AS created_at
         FROM evt_orders o
         WHERE o.id = $1::uuid
           AND EXISTS (SELECT 1 FROM evt_events e WHERE e.id = o.event_id AND e.school_id = $2::uuid)
         LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as OrderRow[];
    if (rows.length === 0) throw new NotFoundException('Order not found');
    const row = rows[0]!;
    if (!writer && row.purchaser_id !== actor.personId) {
      throw new NotFoundException('Order not found');
    }
    const tickets = await this.loadTickets([row.id]);
    return this.rowToDto(row, tickets.get(row.id) ?? []);
  }

  /**
   * THE ATOMIC TICKET SALE KEYSTONE.
   *
   * For each (tier, quantity) pair, runs the single UPDATE:
   *
   *   UPDATE evt_ticket_tiers
   *   SET quantity_sold = quantity_sold + $qty
   *   WHERE id = $tier_id AND quantity_sold + $qty <= quantity
   *
   * NEVER select then update. If the UPDATE returns 0 rows, the tier
   * is sold out and we throw 409 Sold Out. The schema-side sold_chk
   * (quantity_sold <= quantity) is the belt-and-braces — even if the
   * service-layer math drifts the database can never accept an
   * oversell.
   *
   * Creates the order in PENDING status with expires_at = now() +
   * 15 minutes plus one ticket row per seat purchased, each carrying
   * a 48-char hex qr_code_token. The OrderExpiryWorker cancels stale
   * PENDING orders + decrements tier.quantity_sold + cancels the
   * Stripe PaymentIntent.
   *
   * The Stripe PaymentIntent itself is a stub in this cycle —
   * mirrors the Cycle 6 + Cycle 28 stub pattern. A future integration
   * cycle wires the actual Stripe call into the same tx via the
   * existing Cycle 6 StripeService.
   */
  async purchase(eventId: string, input: PurchaseDto, actor: ResolvedActor): Promise<OrderDto> {
    const tenant = getCurrentTenant();

    // Pre-validate the event is ON_SALE
    const eventRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, status, title FROM evt_events
         WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        eventId,
        tenant.schoolId,
      );
    })) as Array<{ id: string; status: string; title: string }>;
    if (eventRows.length === 0) throw new NotFoundException('Event not found');
    if (eventRows[0]!.status !== 'ON_SALE') {
      throw new BadRequestException(
        `Tickets cannot be purchased — event status is ${eventRows[0]!.status}.`,
      );
    }

    const orderId = generateId();
    const expiresAt = new Date(Date.now() + ORDER_EXPIRY_MINUTES * 60_000).toISOString();
    let totalAmount = 0;
    const ticketsToCreate: Array<{
      id: string;
      tierId: string;
      holderName: string | null;
      token: string;
    }> = [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // For each requested (tier, quantity) pair: lookup tier price + run the atomic UPDATE
      for (const line of input.lines) {
        const tierRows = (await tx.$queryRawUnsafe(
          `SELECT t.id::text AS id, t.event_id::text AS event_id, t.name,
                  t.price, t.quantity, t.quantity_sold, t.is_active,
                  t.sale_starts_at, t.sale_ends_at
           FROM evt_ticket_tiers t
           JOIN evt_events e ON e.id = t.event_id
           WHERE t.id = $1::uuid AND e.school_id = $2::uuid AND t.event_id = $3::uuid LIMIT 1`,
          line.tierId,
          tenant.schoolId,
          eventId,
        )) as Array<{
          id: string;
          event_id: string;
          name: string;
          price: string | number;
          quantity: number;
          quantity_sold: number;
          is_active: boolean;
          sale_starts_at: string | null;
          sale_ends_at: string | null;
        }>;
        if (tierRows.length === 0) {
          throw new BadRequestException(
            `Tier ${line.tierId} does not belong to event ${eventId} in this school.`,
          );
        }
        const tier = tierRows[0]!;
        if (!tier.is_active) {
          throw new BadRequestException(`Tier "${tier.name}" is not on sale.`);
        }
        const now = new Date();
        if (tier.sale_starts_at && new Date(tier.sale_starts_at) > now) {
          throw new BadRequestException(`Tier "${tier.name}" sale has not started yet.`);
        }
        if (tier.sale_ends_at && new Date(tier.sale_ends_at) < now) {
          throw new BadRequestException(`Tier "${tier.name}" sale has ended.`);
        }

        // THE ATOMIC TICKET SALE — single UPDATE, never SELECT-then-UPDATE.
        const result = (await tx.$queryRawUnsafe(
          `UPDATE evt_ticket_tiers
           SET quantity_sold = quantity_sold + $1, updated_at = now()
           WHERE id = $2::uuid AND quantity_sold + $1 <= quantity
           RETURNING quantity_sold AS new_sold`,
          line.quantity,
          line.tierId,
        )) as Array<{ new_sold: number }>;
        if (result.length === 0) {
          // 0 rows means the WHERE clause failed: tier is sold out
          // OR the requested quantity would exceed remaining capacity.
          throw new ConflictException(
            `Tier "${tier.name}" is sold out or has insufficient remaining capacity (requested ${line.quantity}).`,
          );
        }

        const linePrice = Number(tier.price);
        totalAmount += linePrice * line.quantity;
        for (let k = 0; k < line.quantity; k++) {
          ticketsToCreate.push({
            id: generateId(),
            tierId: line.tierId,
            holderName: line.holderNames?.[k] ?? null,
            token: randomBytes(QR_TOKEN_BYTES).toString('hex'),
          });
        }
      }

      // INSERT order PENDING. The Stripe PaymentIntent is stubbed in dev
      // mode — `pi_dev_evt_*` mirrors the Cycle 6 `pi_dev_*` shape from
      // PaymentService, so the same Stripe wire-up path is reusable
      // when a real Stripe integration cycle lands. The Cycle 6 dev
      // stub auto-completes CARD payments at insert time; the Events
      // module keeps an explicit PENDING phase so the OrderExpiryWorker
      // sweep + the gate-side confirmation flow can be exercised under
      // test. Set STRIPE_DEV_AUTO_CONFIRM=true to mirror the Cycle 6
      // auto-complete behaviour and skip the webhook step entirely.
      const stripeIntentId = `pi_dev_evt_${orderId.replace(/-/g, '').slice(0, 16)}`;
      const autoConfirm = process.env.STRIPE_DEV_AUTO_CONFIRM === 'true';
      await tx.$executeRawUnsafe(
        `INSERT INTO evt_orders
         (id, event_id, purchaser_id, status, total_amount, stripe_payment_intent_id,
          expires_at, confirmed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                 $7::timestamptz, $8::timestamptz)`,
        orderId,
        eventId,
        actor.personId,
        autoConfirm ? 'CONFIRMED' : 'PENDING',
        Number(totalAmount.toFixed(2)),
        stripeIntentId,
        autoConfirm ? null : expiresAt,
        autoConfirm ? new Date().toISOString() : null,
      );

      // INSERT every ticket
      for (const t of ticketsToCreate) {
        await tx.$executeRawUnsafe(
          `INSERT INTO evt_tickets (id, order_id, tier_id, holder_name, qr_code_token, status)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'VALID')`,
          t.id,
          orderId,
          t.tierId,
          t.holderName,
          t.token,
        );
      }
    });

    return this.getById(orderId, actor);
  }

  /**
   * Confirm a PENDING order. Stripe webhook callback. Atomic flip
   * PENDING → CONFIRMED with confirmed_at stamped per the multi-column
   * confirmed_chk lockstep. Emits evt.order.confirmed after tx commits.
   */
  async confirm(id: string, input: ConfirmOrderDto, actor: ResolvedActor): Promise<OrderDto> {
    const tenant = getCurrentTenant();
    let emitNeeded = false;
    let total = 0;
    let eventId = '';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.event_id::text AS event_id, o.status,
                o.total_amount, o.purchaser_id::text AS purchaser_id
         FROM evt_orders o
         JOIN evt_events e ON e.id = o.event_id
         WHERE o.id = $1::uuid AND e.school_id = $2::uuid
         FOR UPDATE OF o`,
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        event_id: string;
        status: string;
        total_amount: string | number;
        purchaser_id: string;
      }>;
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const order = rows[0]!;
      // Allow purchaser or writer to confirm. The Stripe webhook path
      // would route through a service-level account holding writer scope.
      const writer = await this.isWriter(actor);
      if (!writer && order.purchaser_id !== actor.personId) {
        throw new ForbiddenException('Only the purchaser or admin can confirm this order.');
      }
      if (order.status === 'CONFIRMED') {
        return; // idempotent — already confirmed
      }
      if (order.status !== 'PENDING') {
        throw new BadRequestException(
          `Order cannot be confirmed — current status is ${order.status}.`,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE evt_orders
         SET status = 'CONFIRMED', confirmed_at = now(), updated_at = now(),
             stripe_payment_intent_id = COALESCE($2, stripe_payment_intent_id),
             expires_at = NULL
         WHERE id = $1::uuid`,
        id,
        input.stripePaymentIntentId ?? null,
      );
      emitNeeded = true;
      total = Number(order.total_amount);
      eventId = order.event_id;
    });

    if (emitNeeded) {
      try {
        await this.kafka.emit({
          topic: 'evt.order.confirmed',
          key: id,
          sourceModule: 'events',
          payload: {
            orderId: id,
            eventId,
            schoolId: tenant.schoolId,
            purchaserId: actor.personId,
            totalAmount: total,
            confirmedAt: new Date().toISOString(),
          },
        });
      } catch (e: unknown) {
        this.logger.warn(`[events] evt.order.confirmed emit failed: ${String(e)}`);
      }
      // Recheck SOLD_OUT auto-flip
      await this.events.maybeAutoFlipSoldOut(eventId);
    }
    return this.getById(id, actor);
  }

  /**
   * Cancel an order — decrements tier.quantity_sold for each linked
   * ticket inside one tenant tx, flips tickets to CANCELLED, stamps
   * cancelled_at on the order. The OrderExpiryWorker uses this method
   * with a system-actor identity for expired PENDING sweeps.
   */
  async cancel(
    id: string,
    input: CancelOrderDto,
    actor: ResolvedActor | null,
  ): Promise<OrderDto | null> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.event_id::text AS event_id, o.status,
                o.purchaser_id::text AS purchaser_id
         FROM evt_orders o
         JOIN evt_events e ON e.id = o.event_id
         WHERE o.id = $1::uuid AND e.school_id = $2::uuid
         FOR UPDATE OF o`,
        id,
        tenant.schoolId,
      )) as Array<{ id: string; event_id: string; status: string; purchaser_id: string }>;
      if (rows.length === 0) {
        if (actor === null) return; // worker — silently skip
        throw new NotFoundException('Order not found');
      }
      const order = rows[0]!;
      if (actor !== null) {
        const writer = await this.isWriter(actor);
        if (!writer && order.purchaser_id !== actor.personId) {
          throw new ForbiddenException('Only the purchaser or admin can cancel this order.');
        }
      }
      if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
        return; // idempotent
      }

      // Decrement tier.quantity_sold for each linked ticket
      await tx.$executeRawUnsafe(
        `UPDATE evt_ticket_tiers t
         SET quantity_sold = GREATEST(0, t.quantity_sold - tk.cnt), updated_at = now()
         FROM (
           SELECT tier_id, COUNT(*)::int AS cnt FROM evt_tickets
           WHERE order_id = $1::uuid AND status IN ('VALID', 'USED') GROUP BY tier_id
         ) tk
         WHERE t.id = tk.tier_id`,
        id,
      );
      // Flip tickets to CANCELLED, preserve scanned_at NULL on already-cancelled
      await tx.$executeRawUnsafe(
        `UPDATE evt_tickets SET status = 'CANCELLED', scanned_at = NULL, updated_at = now()
         WHERE order_id = $1::uuid AND status IN ('VALID', 'USED')`,
        id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE evt_orders
         SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(),
             cancellation_reason = COALESCE($2, cancellation_reason),
             expires_at = NULL
         WHERE id = $1::uuid`,
        id,
        input.cancellationReason ?? null,
      );
    });
    if (actor === null) return null;
    return this.getById(id, actor);
  }
}

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'evt-001:admin',
      'evt-001:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Refund issuance requires evt-001:write or admin scope.');
    }
  }

  async listForOrder(orderId: string, actor: ResolvedActor): Promise<RefundDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT r.id::text AS id, r.order_id::text AS order_id, r.refund_amount,
                r.reason, r.stripe_refund_id, r.refunded_by::text AS refunded_by,
                r.refunded_at::text AS refunded_at
         FROM evt_refunds r
         JOIN evt_orders o ON o.id = r.order_id
         JOIN evt_events e ON e.id = o.event_id
         WHERE r.order_id = $1::uuid AND e.school_id = $2::uuid
         ORDER BY r.refunded_at DESC`,
        orderId,
        tenant.schoolId,
      );
    })) as RefundRow[];
    // Non-writers see only own-order refunds
    const orderRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT o.purchaser_id::text AS pid FROM evt_orders o
         JOIN evt_events e ON e.id = o.event_id
         WHERE o.id = $1::uuid AND e.school_id = $2::uuid LIMIT 1`,
        orderId,
        tenant.schoolId,
      );
    })) as Array<{ pid: string }>;
    if (orderRows.length === 0) return [];
    if (!actor.isSchoolAdmin && orderRows[0]!.pid !== actor.personId) {
      const tenant2 = getCurrentTenant();
      const writer = await this.permissions.hasAnyPermissionInTenant(
        actor.accountId,
        tenant2.schoolId,
        ['evt-001:write', 'evt-001:admin'],
      );
      if (!writer) return [];
    }
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      refundAmount: Number(r.refund_amount),
      reason: r.reason,
      stripeRefundId: r.stripe_refund_id,
      refundedBy: r.refunded_by,
      refundedAt: r.refunded_at,
    }));
  }

  /**
   * Issue a refund. Admin-only. Inside one tenant tx:
   *   - Lock the order FOR UPDATE
   *   - Validate the refund_amount does not exceed total - prior refunds
   *   - INSERT evt_refunds row
   *   - Flip every VALID + USED ticket on the order to REFUNDED
   *   - Decrement tier.quantity_sold for each ticket
   *   - Update order.status = REFUNDED (preserves confirmed_at per
   *     confirmed_chk; stamps cancelled_at)
   *   - Emit evt.refund.issued for GL posting
   *
   * Refunds are CASCADE-deleted with the parent order so a hard-deleted
   * order also drops its refund audit; production never hard-deletes
   * orders (CANCELLED + REFUNDED are the audit-preserving paths).
   */
  async issue(orderId: string, input: RefundOrderDto, actor: ResolvedActor): Promise<RefundDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const refundId = generateId();
    const stripeRefundId = `re_dev_evt_${refundId.replace(/-/g, '').slice(0, 16)}`;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const orderRows = (await tx.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.event_id::text AS event_id, o.status, o.total_amount,
                o.purchaser_id::text AS purchaser_id, o.stripe_payment_intent_id
         FROM evt_orders o
         JOIN evt_events e ON e.id = o.event_id
         WHERE o.id = $1::uuid AND e.school_id = $2::uuid
         FOR UPDATE OF o`,
        orderId,
        tenant.schoolId,
      )) as Array<{
        id: string;
        event_id: string;
        status: string;
        total_amount: string | number;
        purchaser_id: string;
        stripe_payment_intent_id: string | null;
      }>;
      if (orderRows.length === 0) throw new NotFoundException('Order not found');
      const order = orderRows[0]!;
      if (order.status === 'PENDING' || order.status === 'CANCELLED') {
        throw new BadRequestException(
          `Refund cannot be issued on an order with status ${order.status}.`,
        );
      }
      const priorRows = (await tx.$queryRawUnsafe(
        `SELECT COALESCE(SUM(refund_amount), 0)::numeric AS sum FROM evt_refunds WHERE order_id = $1::uuid`,
        orderId,
      )) as Array<{ sum: string | number }>;
      const prior = Number(priorRows[0]!.sum);
      const total = Number(order.total_amount);
      if (prior + input.refundAmount > total + 0.001) {
        throw new BadRequestException(
          `Refund amount would exceed order total. Remaining refundable: $${(total - prior).toFixed(2)}.`,
        );
      }

      await tx.$executeRawUnsafe(
        `INSERT INTO evt_refunds (id, order_id, refund_amount, reason, stripe_refund_id, refunded_by, refunded_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, now())`,
        refundId,
        orderId,
        input.refundAmount,
        input.reason,
        stripeRefundId,
        actor.personId,
      );

      // Full refund? Flip every active ticket to REFUNDED + decrement tier counts.
      const isFullRefund = prior + input.refundAmount >= total - 0.001;
      if (isFullRefund) {
        await tx.$executeRawUnsafe(
          `UPDATE evt_ticket_tiers t
           SET quantity_sold = GREATEST(0, t.quantity_sold - tk.cnt), updated_at = now()
           FROM (
             SELECT tier_id, COUNT(*)::int AS cnt FROM evt_tickets
             WHERE order_id = $1::uuid AND status IN ('VALID','USED') GROUP BY tier_id
           ) tk
           WHERE t.id = tk.tier_id`,
          orderId,
        );
        // Tickets that were already USED must clear scanned_at to satisfy
        // evt_tickets_scanned_chk on the new REFUNDED status.
        await tx.$executeRawUnsafe(
          `UPDATE evt_tickets SET status = 'REFUNDED', scanned_at = NULL, updated_at = now()
           WHERE order_id = $1::uuid AND status IN ('VALID', 'USED')`,
          orderId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE evt_orders
           SET status = 'REFUNDED', cancelled_at = COALESCE(cancelled_at, now()),
               cancellation_reason = COALESCE(cancellation_reason, $2),
               updated_at = now()
           WHERE id = $1::uuid`,
          orderId,
          input.reason,
        );
      }
    });

    try {
      await this.kafka.emit({
        topic: 'evt.refund.issued',
        key: refundId,
        sourceModule: 'events',
        payload: {
          refundId,
          orderId,
          schoolId: tenant.schoolId,
          refundAmount: input.refundAmount,
          reason: input.reason,
          refundedBy: actor.personId,
          stripeRefundId,
          refundedAt: new Date().toISOString(),
        },
      });
    } catch (e: unknown) {
      this.logger.warn(`[events] evt.refund.issued emit failed: ${String(e)}`);
    }

    const list = await this.listForOrder(orderId, actor);
    const refund = list.find((r) => r.id === refundId);
    if (!refund) throw new NotFoundException('Refund vanished after issue');
    return refund;
  }
}
