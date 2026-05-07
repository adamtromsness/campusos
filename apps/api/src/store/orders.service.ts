import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import type { PrismaClient } from '@prisma/client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ProductService } from './products.service';
import type {
  ApprovalStatus,
  CancelOrderDto,
  CreateOrderDto,
  DeclineApprovalDto,
  FulfilOrderDto,
  LineStatus,
  OrderApprovalDto,
  OrderDto,
  OrderLineDto,
  OrderStatus,
  OrderType,
  PaymentStatus,
  ShippingMethod,
} from './dto/store.dto';

interface OrderRow {
  id: string;
  store_id: string;
  store_name: string | null;
  order_type: string;
  customer_person_id: string | null;
  customer_name: string | null;
  external_customer_id: string | null;
  external_customer_name: string | null;
  student_id: string | null;
  student_name: string | null;
  order_number: string;
  order_date: string;
  status: string;
  subtotal: string | number;
  shipping_cost: string | number;
  total: string | number;
  shipping_method: string;
  shipping_option_id: string | null;
  shipping_option_name: string | null;
  tracking_number: string | null;
  payment_status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderLineRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  quantity: number;
  unit_price: string | number;
  line_total: string | number;
  line_status: string;
}

interface ApprovalRow {
  id: string;
  order_id: string;
  parent_person_id: string;
  parent_name: string | null;
  status: string;
  requested_at: string;
  responded_at: string | null;
  decline_reason: string | null;
}

const SELECT_ORDER_BASE = `
  SELECT o.id::text AS id,
         o.store_id::text AS store_id,
         (SELECT name FROM str_stores WHERE id = o.store_id) AS store_name,
         o.order_type,
         o.customer_person_id::text AS customer_person_id,
         (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = o.customer_person_id) AS customer_name,
         o.external_customer_id::text AS external_customer_id,
         (SELECT name FROM str_external_customers WHERE id = o.external_customer_id) AS external_customer_name,
         o.student_id::text AS student_id,
         (
           SELECT ip.first_name || ' ' || ip.last_name
           FROM sis_students ss
           JOIN platform.platform_students ps ON ps.id = ss.platform_student_id
           JOIN platform.iam_person ip ON ip.id = ps.person_id
           WHERE ss.id = o.student_id
         ) AS student_name,
         o.order_number,
         o.order_date::text AS order_date,
         o.status,
         o.subtotal,
         o.shipping_cost,
         o.total,
         o.shipping_method,
         o.shipping_option_id::text AS shipping_option_id,
         (SELECT method_name FROM str_shipping_options WHERE id = o.shipping_option_id) AS shipping_option_name,
         o.tracking_number,
         o.payment_status,
         o.notes,
         o.created_at::text AS created_at,
         o.updated_at::text AS updated_at
  FROM str_orders o
`;

/**
 * Allowed status transitions for the staff fulfilment + cancel paths.
 * The PENDING_APPROVAL → APPROVED transition is owned by ApprovalService;
 * APPROVED → PROCESSING happens automatically inside that flow.
 */
const FULFIL_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_APPROVAL: [],
  APPROVED: ['PROCESSING'],
  PROCESSING: ['READY_FOR_PICKUP', 'SHIPPED'],
  READY_FOR_PICKUP: ['COMPLETED'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  BACKORDERED: ['PROCESSING'],
};

@Injectable()
export class OrderService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly products: ProductService,
  ) {}

  private isStoreManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  private async loadLines(orderIds: string[]): Promise<Map<string, OrderLineDto[]>> {
    if (orderIds.length === 0) return new Map();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT ol.id::text AS id, ol.order_id::text AS order_id, ol.product_id::text AS product_id, p.name AS product_name, p.sku AS product_sku, ol.quantity, ol.unit_price, ol.line_total, ol.line_status FROM str_order_lines ol LEFT JOIN str_products p ON p.id = ol.product_id WHERE ol.order_id = ANY($1::uuid[]) ORDER BY ol.created_at`,
        orderIds,
      );
    })) as OrderLineRow[];
    const out = new Map<string, OrderLineDto[]>();
    for (const r of rows) {
      const dto: OrderLineDto = {
        id: r.id,
        orderId: r.order_id,
        productId: r.product_id,
        productName: r.product_name,
        productSku: r.product_sku,
        quantity: Number(r.quantity),
        unitPrice: Number(r.unit_price),
        lineTotal: Number(r.line_total),
        lineStatus: r.line_status as LineStatus,
      };
      const list = out.get(r.order_id) ?? [];
      list.push(dto);
      out.set(r.order_id, list);
    }
    return out;
  }

  private async loadApprovals(orderIds: string[]): Promise<Map<string, OrderApprovalDto>> {
    if (orderIds.length === 0) return new Map();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.order_id::text AS order_id, a.parent_person_id::text AS parent_person_id, (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = a.parent_person_id) AS parent_name, a.status, a.requested_at::text AS requested_at, a.responded_at::text AS responded_at, a.decline_reason FROM str_order_approvals a WHERE a.order_id = ANY($1::uuid[])`,
        orderIds,
      );
    })) as ApprovalRow[];
    const out = new Map<string, OrderApprovalDto>();
    for (const r of rows) {
      out.set(r.order_id, {
        id: r.id,
        orderId: r.order_id,
        parentPersonId: r.parent_person_id,
        parentName: r.parent_name,
        status: r.status as ApprovalStatus,
        requestedAt: r.requested_at,
        respondedAt: r.responded_at,
        declineReason: r.decline_reason,
      });
    }
    return out;
  }

  private async toDto(r: OrderRow): Promise<OrderDto> {
    const lines = (await this.loadLines([r.id])).get(r.id) ?? [];
    const approval = (await this.loadApprovals([r.id])).get(r.id) ?? null;
    return {
      id: r.id,
      storeId: r.store_id,
      storeName: r.store_name,
      orderType: r.order_type as OrderType,
      customerPersonId: r.customer_person_id,
      customerName: r.customer_name,
      externalCustomerId: r.external_customer_id,
      externalCustomerName: r.external_customer_name,
      studentId: r.student_id,
      studentName: r.student_name,
      orderNumber: r.order_number,
      orderDate: r.order_date,
      status: r.status as OrderStatus,
      subtotal: Number(r.subtotal),
      shippingCost: Number(r.shipping_cost),
      total: Number(r.total),
      shippingMethod: r.shipping_method as ShippingMethod,
      shippingOptionId: r.shipping_option_id,
      shippingOptionName: r.shipping_option_name,
      trackingNumber: r.tracking_number,
      paymentStatus: r.payment_status as PaymentStatus,
      notes: r.notes,
      lines,
      approval,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /**
   * Resolve the row-scope predicate for non-manager actors:
   *   - GUARDIAN sees orders where customer_person_id = actor.personId
   *     OR student_id is one of their linked sis_students (resolved
   *     inline via sis_student_guardians)
   *   - STUDENT sees own orders only (customer_person_id = actor.personId)
   *   - else nothing
   */
  private async buildVisibility(
    actor: ResolvedActor,
  ): Promise<{ where: string; params: unknown[] }> {
    if (this.isStoreManager(actor)) {
      return { where: '1=1', params: [] };
    }
    if (actor.personType === 'STUDENT') {
      return { where: 'o.customer_person_id = $%::uuid', params: [actor.personId] };
    }
    if (actor.personType === 'GUARDIAN') {
      // Parent sees orders they placed OR orders for any of their children
      return {
        where: `(o.customer_person_id = $%::uuid OR o.student_id IN (
          SELECT s.id FROM sis_students s
          JOIN platform.platform_students ps ON ps.id = s.platform_student_id
          JOIN sis_student_guardians sg ON sg.student_id = s.id
          JOIN sis_guardians g ON g.id = sg.guardian_id
          WHERE g.person_id = $%::uuid
        ))`,
        params: [actor.personId, actor.personId],
      };
    }
    // No visibility
    return { where: 'FALSE', params: [] };
  }

  async list(
    actor: ResolvedActor,
    filter?: { storeId?: string; status?: string; orderType?: string },
  ): Promise<OrderDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = [
      'EXISTS (SELECT 1 FROM str_stores s WHERE s.id = o.store_id AND s.school_id = $1::uuid)',
    ];
    const params: unknown[] = [tenant.schoolId];
    let i = 2;
    const vis = await this.buildVisibility(actor);
    if (vis.where !== '1=1' && vis.where !== 'FALSE') {
      // substitute $% with $i++ markers
      let scoped = vis.where;
      for (const p of vis.params) {
        scoped = scoped.replace('$%', `$${i++}`);
        params.push(p);
      }
      where.push(`(${scoped})`);
    } else if (vis.where === 'FALSE') {
      return [];
    }
    if (filter?.storeId) {
      where.push(`o.store_id = $${i++}::uuid`);
      params.push(filter.storeId);
    }
    if (filter?.status) {
      where.push(`o.status = $${i++}`);
      params.push(filter.status);
    }
    if (filter?.orderType) {
      where.push(`o.order_type = $${i++}`);
      params.push(filter.orderType);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ORDER_BASE +
          ` WHERE ${where.join(' AND ')} ORDER BY o.order_date DESC, o.created_at DESC LIMIT 200`,
        ...params,
      );
    })) as OrderRow[];
    const out: OrderDto[] = [];
    for (const r of rows) out.push(await this.toDto(r));
    return out;
  }

  async getById(id: string, actor: ResolvedActor): Promise<OrderDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ORDER_BASE +
          ` WHERE o.id = $1::uuid AND EXISTS (SELECT 1 FROM str_stores s WHERE s.id = o.store_id AND s.school_id = $2::uuid) LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as OrderRow[];
    if (rows.length === 0) throw new NotFoundException('Order not found');
    const r = rows[0]!;
    if (!this.isStoreManager(actor)) {
      // Row-scope: must match the visibility predicate
      const visible = await this.matchesVisibility(actor, r);
      if (!visible) throw new NotFoundException('Order not found');
    }
    return this.toDto(r);
  }

  private async matchesVisibility(actor: ResolvedActor, r: OrderRow): Promise<boolean> {
    if (actor.personType === 'STUDENT') {
      return r.customer_person_id === actor.personId;
    }
    if (actor.personType === 'GUARDIAN') {
      if (r.customer_person_id === actor.personId) return true;
      // child match
      if (!r.student_id) return false;
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          `SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1`,
          r.student_id,
          actor.personId,
        );
      })) as Array<unknown>;
      return rows.length > 0;
    }
    return false;
  }

  /**
   * THE PARENT APPROVAL GATE KEYSTONE.
   *
   * Creates a new order in one tenant tx:
   *   1. Resolves each line's product (price + cost + active + backorder)
   *   2. Checks inventory (sums across all locations for the product)
   *   3. INSERTs the order header + lines
   *   4. INSERTs an str_order_approvals row IF order_type='STUDENT'
   *      (the parent must approve before payment fires)
   *   5. Reserves inventory (quantity_reserved += quantity per line)
   *      EXCEPT for BACKORDERED lines (which carry no reservation)
   *
   * For PARENT and EXTERNAL orders, no approval row is created and
   * the order goes directly to APPROVED → PROCESSING. Payment-completed
   * Kafka emit fires AFTER the tx commits in those cases. For STUDENT
   * orders the emit fires from ApprovalService.approve.
   */
  async create(actor: ResolvedActor, input: CreateOrderDto): Promise<OrderDto> {
    if (!actor.personId) {
      throw new BadRequestException('Order creation requires a logged-in person');
    }
    // Validate caller / order_type combination
    if (
      input.orderType === 'STUDENT' &&
      actor.personType !== 'STUDENT' &&
      !this.isStoreManager(actor)
    ) {
      throw new ForbiddenException(
        "Only the student themselves or a store manager can place a STUDENT order on the student's behalf",
      );
    }
    if (
      input.orderType === 'PARENT' &&
      actor.personType !== 'GUARDIAN' &&
      !this.isStoreManager(actor)
    ) {
      throw new ForbiddenException('Only a parent or admin can place a PARENT order');
    }
    if (input.orderType === 'EXTERNAL' && !input.externalCustomerId) {
      throw new BadRequestException('externalCustomerId is required for EXTERNAL orders');
    }
    if (input.orderType !== 'EXTERNAL' && input.externalCustomerId) {
      throw new BadRequestException('externalCustomerId only applies to EXTERNAL orders');
    }
    if (input.orderType === 'STUDENT' && !input.studentId) {
      throw new BadRequestException('studentId is required for STUDENT orders');
    }
    if (input.shippingMethod === 'SHIPPED' && !input.shippingOptionId) {
      throw new BadRequestException('shippingOptionId is required when shippingMethod=SHIPPED');
    }
    if (input.shippingMethod === 'PICKUP' && input.shippingOptionId) {
      throw new BadRequestException('shippingOptionId must not be set when shippingMethod=PICKUP');
    }
    if (input.orderType === 'EXTERNAL' && input.shippingMethod !== 'SHIPPED') {
      throw new BadRequestException('EXTERNAL orders must use shippingMethod=SHIPPED');
    }

    const tenant = getCurrentTenant();
    const orderId = generateId();
    let parentPersonId: string | null = null;
    let createdShape: {
      orderType: OrderType;
      orderNumber: string;
      total: number;
      lines: Array<{ productId: string; quantity: number; unitPrice: number; lineTotal: number }>;
      pendingApproval: boolean;
    } | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate store + load store_type
      const storeRows = (await tx.$queryRawUnsafe(
        `SELECT store_type FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid AND is_active = true LIMIT 1`,
        input.storeId,
        tenant.schoolId,
      )) as Array<{ store_type: string }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match an active store in this school');
      }
      const storeType = storeRows[0]!.store_type;
      if (storeType === 'STUDENT' && input.orderType === 'EXTERNAL') {
        throw new BadRequestException('EXTERNAL orders must be placed against a PUBLIC store');
      }
      if (storeType === 'PUBLIC' && input.orderType === 'STUDENT') {
        throw new BadRequestException('STUDENT orders must be placed against a STUDENT store');
      }

      // For STUDENT orders, resolve the parent for the approval row.
      // Prefer the guardian with has_custody=true; fall back to any
      // portal-enabled guardian; fall back to any guardian. The schema
      // has no is_primary flag — we rank guardians by which is most
      // likely to receive the approval notification.
      if (input.orderType === 'STUDENT') {
        const parentRows = (await tx.$queryRawUnsafe(
          `SELECT g.person_id::text AS person_id FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1::uuid AND g.person_id IS NOT NULL ORDER BY sg.has_custody DESC, sg.portal_access DESC, sg.receives_reports DESC LIMIT 1`,
          input.studentId,
        )) as Array<{ person_id: string }>;
        if (parentRows.length === 0) {
          throw new BadRequestException(
            'No guardian found for this student. STUDENT orders require a parent to approve.',
          );
        }
        parentPersonId = parentRows[0]!.person_id;
      }

      // Resolve products + reserve inventory + compute totals
      let subtotal = 0;
      const linesToInsert: Array<{
        productId: string;
        productStoreId: string;
        quantity: number;
        unitPrice: number;
        lineTotal: number;
        cost: number | null;
        lineStatus: LineStatus;
      }> = [];
      const totalAvailableByProduct = new Map<string, number>();
      for (const line of input.lines) {
        const product = await this.products.loadForOrderInTx(tx, line.productId);
        if (!product.isActive) {
          throw new BadRequestException(`Product ${product.id} is inactive`);
        }
        if (product.storeId !== input.storeId) {
          throw new BadRequestException(
            `Product ${product.id} does not belong to the supplied storeId`,
          );
        }
        const invRows = (await tx.$queryRawUnsafe(
          `SELECT COALESCE(SUM(GREATEST(quantity_on_hand - quantity_reserved, 0)), 0)::int AS available FROM str_product_inventory WHERE product_id = $1::uuid`,
          product.id,
        )) as Array<{ available: number }>;
        const available = Number(invRows[0]!.available);
        totalAvailableByProduct.set(product.id, available);
        let lineStatus: LineStatus;
        if (line.quantity <= available) {
          lineStatus = 'IN_STOCK';
        } else if (product.backorderAllowed) {
          lineStatus = 'BACKORDERED';
        } else {
          throw new BadRequestException(
            `Insufficient stock for ${line.productId} — requested ${line.quantity}, available ${available}, backorder not allowed`,
          );
        }
        const lineTotal = Number((product.price * line.quantity).toFixed(2));
        subtotal += lineTotal;
        linesToInsert.push({
          productId: product.id,
          productStoreId: product.storeId,
          quantity: line.quantity,
          unitPrice: product.price,
          lineTotal,
          cost: product.cost,
          lineStatus,
        });
      }

      // Resolve shipping cost
      let shippingCost = 0;
      if (input.shippingMethod === 'SHIPPED' && input.shippingOptionId) {
        const shipRows = (await tx.$queryRawUnsafe(
          `SELECT flat_rate FROM str_shipping_options WHERE id = $1::uuid AND store_id = $2::uuid AND is_active = true LIMIT 1`,
          input.shippingOptionId,
          input.storeId,
        )) as Array<{ flat_rate: string | number }>;
        if (shipRows.length === 0) {
          throw new BadRequestException(
            'shippingOptionId does not match an active option for this store',
          );
        }
        shippingCost = Number(shipRows[0]!.flat_rate);
      }
      const total = Number((subtotal + shippingCost).toFixed(2));

      // Allocate order number — count of existing orders for the store + 1, padded
      const seqRows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM str_orders WHERE store_id = $1::uuid`,
        input.storeId,
      )) as Array<{ n: number }>;
      const year = new Date().getFullYear();
      const orderNumber = `STR-${year}-${String(Number(seqRows[0]!.n) + 1).padStart(4, '0')}`;

      const initialStatus: OrderStatus =
        input.orderType === 'STUDENT' ? 'PENDING_APPROVAL' : 'PROCESSING';
      const paymentStatus: PaymentStatus = linesToInsert.some((l) => l.lineStatus === 'BACKORDERED')
        ? 'DEFERRED_BACKORDER'
        : input.orderType === 'STUDENT'
          ? 'PENDING'
          : 'CHARGED';

      // INSERT order
      await tx.$executeRawUnsafe(
        `INSERT INTO str_orders (id, store_id, order_type, customer_person_id, external_customer_id, student_id, order_number, order_date, status, subtotal, shipping_cost, total, shipping_method, shipping_option_id, payment_status, notes) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6::uuid, $7, now(), $8, $9, $10, $11, $12, $13::uuid, $14, $15)`,
        orderId,
        input.storeId,
        input.orderType,
        input.orderType === 'EXTERNAL' ? null : actor.personId,
        input.orderType === 'EXTERNAL' ? input.externalCustomerId! : null,
        input.studentId ?? null,
        orderNumber,
        initialStatus,
        subtotal,
        shippingCost,
        total,
        input.shippingMethod,
        input.shippingMethod === 'SHIPPED' ? input.shippingOptionId! : null,
        paymentStatus,
        input.notes ?? null,
      );

      // INSERT lines + reserve inventory for non-backordered lines
      for (const line of linesToInsert) {
        await tx.$executeRawUnsafe(
          `INSERT INTO str_order_lines (id, order_id, product_id, quantity, unit_price, line_total, line_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
          generateId(),
          orderId,
          line.productId,
          line.quantity,
          line.unitPrice,
          line.lineTotal,
          line.lineStatus,
        );
        if (line.lineStatus !== 'BACKORDERED') {
          // Reserve from inventory: bump quantity_reserved on the row(s)
          // until the requested quantity is covered. Walk rows in
          // descending quantity_on_hand so we drain the largest stock
          // first.
          let remaining = line.quantity;
          const invRows = (await tx.$queryRawUnsafe(
            `SELECT id::text AS id, quantity_on_hand, quantity_reserved FROM str_product_inventory WHERE product_id = $1::uuid ORDER BY (quantity_on_hand - quantity_reserved) DESC FOR UPDATE`,
            line.productId,
          )) as Array<{ id: string; quantity_on_hand: number; quantity_reserved: number }>;
          for (const inv of invRows) {
            if (remaining <= 0) break;
            const free = Math.max(Number(inv.quantity_on_hand) - Number(inv.quantity_reserved), 0);
            const take = Math.min(free, remaining);
            if (take > 0) {
              await tx.$executeRawUnsafe(
                `UPDATE str_product_inventory SET quantity_reserved = quantity_reserved + $1, updated_at = now() WHERE id = $2::uuid`,
                take,
                inv.id,
              );
              remaining -= take;
            }
          }
        }
      }

      // INSERT approval row for STUDENT orders
      if (input.orderType === 'STUDENT' && parentPersonId) {
        await tx.$executeRawUnsafe(
          `INSERT INTO str_order_approvals (id, order_id, parent_person_id) VALUES ($1::uuid, $2::uuid, $3::uuid)`,
          generateId(),
          orderId,
          parentPersonId,
        );
      }

      createdShape = {
        orderType: input.orderType,
        orderNumber,
        total,
        lines: linesToInsert.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        })),
        pendingApproval: input.orderType === 'STUDENT',
      };
    });

    // For PARENT / EXTERNAL orders, fire the str.order.completed emit
    // immediately since payment goes through at order-creation time.
    // STUDENT orders emit later from ApprovalService.approve.
    if (createdShape !== null) {
      const shape = createdShape as {
        orderType: OrderType;
        orderNumber: string;
        total: number;
        lines: Array<{ productId: string; quantity: number; unitPrice: number; lineTotal: number }>;
        pendingApproval: boolean;
      };
      if (!shape.pendingApproval) {
        await this.kafka.emit({
          topic: 'str.order.completed',
          key: orderId,
          sourceModule: 'store',
          payload: this.buildCompletedPayload(orderId, shape, actor, input, tenant.schoolId),
        });
      }
    }
    return this.getById(orderId, actor);
  }

  private buildCompletedPayload(
    orderId: string,
    shape: NonNullable<{
      orderType: OrderType;
      orderNumber: string;
      total: number;
      lines: Array<{ productId: string; quantity: number; unitPrice: number; lineTotal: number }>;
    }>,
    actor: ResolvedActor,
    input: CreateOrderDto,
    schoolId: string,
  ) {
    return {
      orderId,
      schoolId,
      storeId: input.storeId,
      orderType: shape.orderType,
      orderNumber: shape.orderNumber,
      customerPersonId: shape.orderType === 'EXTERNAL' ? null : actor.personId,
      externalCustomerId: shape.orderType === 'EXTERNAL' ? input.externalCustomerId! : null,
      studentId: input.studentId ?? null,
      total: shape.total,
      lineItems: shape.lines,
      paymentMode: shape.orderType === 'EXTERNAL' ? 'EXTERNAL_CARD' : 'FAMILY_ACCOUNT',
      sourceRefId: orderId,
    };
  }

  /** Internal helper used by ApprovalService.approve to fire the emit after PENDING → PROCESSING. */
  async emitOrderCompletedAfterApproval(orderId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT o.id::text AS id, o.store_id::text AS store_id, o.order_type, o.order_number, o.customer_person_id::text AS customer_person_id, o.external_customer_id::text AS external_customer_id, o.student_id::text AS student_id, o.total FROM str_orders o WHERE o.id = $1::uuid LIMIT 1`,
        orderId,
      );
    })) as Array<{
      id: string;
      store_id: string;
      order_type: string;
      order_number: string;
      customer_person_id: string | null;
      external_customer_id: string | null;
      student_id: string | null;
      total: string | number;
    }>;
    if (rows.length === 0) return;
    const r = rows[0]!;
    const lineRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT product_id::text AS product_id, quantity, unit_price, line_total FROM str_order_lines WHERE order_id = $1::uuid`,
        orderId,
      );
    })) as Array<{
      product_id: string;
      quantity: number;
      unit_price: string | number;
      line_total: string | number;
    }>;
    await this.kafka.emit({
      topic: 'str.order.completed',
      key: orderId,
      sourceModule: 'store',
      payload: {
        orderId: r.id,
        schoolId: tenant.schoolId,
        storeId: r.store_id,
        orderType: r.order_type,
        orderNumber: r.order_number,
        customerPersonId: r.customer_person_id,
        externalCustomerId: r.external_customer_id,
        studentId: r.student_id,
        total: Number(r.total),
        lineItems: lineRows.map((l) => ({
          productId: l.product_id,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unit_price),
          lineTotal: Number(l.line_total),
        })),
        paymentMode: 'FAMILY_ACCOUNT',
        sourceRefId: r.id,
      },
    });
  }

  async fulfil(actor: ResolvedActor, orderId: string, input: FulfilOrderDto): Promise<OrderDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may fulfil orders');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM str_orders WHERE id = $1::uuid FOR UPDATE`,
        orderId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const current = rows[0]!.status as OrderStatus;
      const allowed = FULFIL_TRANSITIONS[current];
      if (!allowed.includes(input.toStatus)) {
        throw new BadRequestException(
          `Cannot transition from ${current} to ${input.toStatus}. Allowed: ${allowed.join(', ') || 'none'}.`,
        );
      }
      if (input.toStatus === 'SHIPPED') {
        await tx.$executeRawUnsafe(
          `UPDATE str_orders SET status = 'SHIPPED', tracking_number = $1, updated_at = now() WHERE id = $2::uuid`,
          input.trackingNumber ?? null,
          orderId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE str_orders SET status = $1, updated_at = now() WHERE id = $2::uuid`,
          input.toStatus,
          orderId,
        );
      }
    });
    return this.getById(orderId, actor);
  }

  async complete(actor: ResolvedActor, orderId: string): Promise<OrderDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may complete orders');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM str_orders WHERE id = $1::uuid FOR UPDATE`,
        orderId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const current = rows[0]!.status as OrderStatus;
      if (current !== 'READY_FOR_PICKUP' && current !== 'SHIPPED') {
        throw new BadRequestException(
          `Cannot complete an order in status ${current}. Order must be READY_FOR_PICKUP or SHIPPED.`,
        );
      }
      // Decrement quantity_on_hand by line.quantity for every IN_STOCK
      // / FULFILLED line, atomically with releasing the reservation.
      const lineRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, product_id::text AS product_id, quantity, line_status FROM str_order_lines WHERE order_id = $1::uuid AND line_status IN ('IN_STOCK', 'FULFILLED')`,
        orderId,
      )) as Array<{ id: string; product_id: string; quantity: number; line_status: string }>;
      for (const line of lineRows) {
        await this.releaseAndDecrement(tx, line.product_id, line.quantity);
        await tx.$executeRawUnsafe(
          `UPDATE str_order_lines SET line_status = 'FULFILLED', updated_at = now() WHERE id = $1::uuid`,
          line.id,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE str_orders SET status = 'COMPLETED', updated_at = now() WHERE id = $1::uuid`,
        orderId,
      );
    });
    return this.getById(orderId, actor);
  }

  async cancel(actor: ResolvedActor, orderId: string, input: CancelOrderDto): Promise<OrderDto> {
    if (!this.isStoreManager(actor)) {
      throw new ForbiddenException('Only store managers or admins may cancel orders');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT status FROM str_orders WHERE id = $1::uuid FOR UPDATE`,
        orderId,
      )) as Array<{ status: string }>;
      if (rows.length === 0) throw new NotFoundException('Order not found');
      const current = rows[0]!.status as OrderStatus;
      if (current === 'COMPLETED' || current === 'CANCELLED') {
        throw new BadRequestException(`Order is already ${current}`);
      }
      // Release reserved inventory for non-fulfilled lines
      await this.releaseAllReservations(tx, orderId);
      await tx.$executeRawUnsafe(
        `UPDATE str_orders SET status = 'CANCELLED', notes = COALESCE($1, notes), updated_at = now() WHERE id = $2::uuid`,
        input.reason ?? null,
        orderId,
      );
    });
    return this.getById(orderId, actor);
  }

  /** Used by ApprovalService.approve to flip PENDING_APPROVAL → PROCESSING. */
  async advanceFromApproval(orderId: string, paymentStatus: PaymentStatus): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE str_orders SET status = 'PROCESSING', payment_status = $1, updated_at = now() WHERE id = $2::uuid AND status = 'PENDING_APPROVAL'`,
        paymentStatus,
        orderId,
      );
    });
  }

  /** Used by ApprovalService.decline to flip PENDING_APPROVAL → CANCELLED + release inventory. */
  async cancelFromApprovalDecline(orderId: string): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.releaseAllReservations(tx, orderId);
      await tx.$executeRawUnsafe(
        `UPDATE str_orders SET status = 'CANCELLED', updated_at = now() WHERE id = $1::uuid AND status = 'PENDING_APPROVAL'`,
        orderId,
      );
    });
  }

  private async releaseAllReservations(tx: PrismaClient, orderId: string): Promise<void> {
    const lineRows = (await tx.$queryRawUnsafe(
      `SELECT product_id::text AS product_id, quantity, line_status FROM str_order_lines WHERE order_id = $1::uuid AND line_status IN ('IN_STOCK', 'FULFILLED')`,
      orderId,
    )) as Array<{ product_id: string; quantity: number; line_status: string }>;
    for (const line of lineRows) {
      let remaining = Number(line.quantity);
      const invRows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, quantity_reserved FROM str_product_inventory WHERE product_id = $1::uuid ORDER BY quantity_reserved DESC FOR UPDATE`,
        line.product_id,
      )) as Array<{ id: string; quantity_reserved: number }>;
      for (const inv of invRows) {
        if (remaining <= 0) break;
        const release = Math.min(Number(inv.quantity_reserved), remaining);
        if (release > 0) {
          await tx.$executeRawUnsafe(
            `UPDATE str_product_inventory SET quantity_reserved = quantity_reserved - $1, updated_at = now() WHERE id = $2::uuid`,
            release,
            inv.id,
          );
          remaining -= release;
        }
      }
    }
  }

  private async releaseAndDecrement(
    tx: PrismaClient,
    productId: string,
    quantity: number,
  ): Promise<void> {
    let remaining = quantity;
    const invRows = (await tx.$queryRawUnsafe(
      `SELECT id::text AS id, quantity_on_hand, quantity_reserved FROM str_product_inventory WHERE product_id = $1::uuid ORDER BY quantity_reserved DESC FOR UPDATE`,
      productId,
    )) as Array<{ id: string; quantity_on_hand: number; quantity_reserved: number }>;
    for (const inv of invRows) {
      if (remaining <= 0) break;
      const take = Math.min(Number(inv.quantity_reserved), remaining);
      if (take > 0) {
        await tx.$executeRawUnsafe(
          `UPDATE str_product_inventory SET quantity_reserved = quantity_reserved - $1, quantity_on_hand = quantity_on_hand - $1, updated_at = now() WHERE id = $2::uuid`,
          take,
          inv.id,
        );
        remaining -= take;
      }
    }
  }
}

@Injectable()
export class ApprovalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly orders: OrderService,
  ) {}

  async listForParent(actor: ResolvedActor): Promise<OrderApprovalDto[]> {
    if (!actor.personId) return [];
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.order_id::text AS order_id, a.parent_person_id::text AS parent_person_id, (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = a.parent_person_id) AS parent_name, a.status, a.requested_at::text AS requested_at, a.responded_at::text AS responded_at, a.decline_reason FROM str_order_approvals a JOIN str_orders o ON o.id = a.order_id JOIN str_stores s ON s.id = o.store_id WHERE a.parent_person_id = $1::uuid AND s.school_id = $2::uuid ORDER BY a.status = 'PENDING' DESC, a.requested_at DESC`,
        actor.personId,
        tenant.schoolId,
      );
    })) as ApprovalRow[];
    return rows.map((r) => ({
      id: r.id,
      orderId: r.order_id,
      parentPersonId: r.parent_person_id,
      parentName: r.parent_name,
      status: r.status as ApprovalStatus,
      requestedAt: r.requested_at,
      respondedAt: r.responded_at,
      declineReason: r.decline_reason,
    }));
  }

  async approve(actor: ResolvedActor, approvalId: string): Promise<OrderApprovalDto> {
    if (!actor.personId) {
      throw new BadRequestException('Approval requires a logged-in person');
    }
    let orderId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.order_id::text AS order_id, a.parent_person_id::text AS parent_person_id, a.status FROM str_order_approvals a WHERE a.id = $1::uuid FOR UPDATE`,
        approvalId,
      )) as Array<{ order_id: string; parent_person_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Approval not found');
      const r = rows[0]!;
      if (!actor.isSchoolAdmin && r.parent_person_id !== actor.personId) {
        throw new ForbiddenException('Only the assigned parent or an admin may approve this order');
      }
      if (r.status !== 'PENDING') {
        throw new BadRequestException(`Approval is already ${r.status}`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE str_order_approvals SET status = 'APPROVED', responded_at = now(), updated_at = now() WHERE id = $1::uuid`,
        approvalId,
      );
      orderId = r.order_id;
    });
    if (orderId) {
      await this.orders.advanceFromApproval(orderId, 'CHARGED');
      await this.orders.emitOrderCompletedAfterApproval(orderId);
    }
    return this.getApproval(approvalId);
  }

  async decline(
    actor: ResolvedActor,
    approvalId: string,
    input: DeclineApprovalDto,
  ): Promise<OrderApprovalDto> {
    if (!actor.personId) {
      throw new BadRequestException('Approval requires a logged-in person');
    }
    let orderId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT a.order_id::text AS order_id, a.parent_person_id::text AS parent_person_id, a.status FROM str_order_approvals a WHERE a.id = $1::uuid FOR UPDATE`,
        approvalId,
      )) as Array<{ order_id: string; parent_person_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Approval not found');
      const r = rows[0]!;
      if (!actor.isSchoolAdmin && r.parent_person_id !== actor.personId) {
        throw new ForbiddenException('Only the assigned parent or an admin may decline this order');
      }
      if (r.status !== 'PENDING') {
        throw new BadRequestException(`Approval is already ${r.status}`);
      }
      await tx.$executeRawUnsafe(
        `UPDATE str_order_approvals SET status = 'DECLINED', responded_at = now(), decline_reason = $1, updated_at = now() WHERE id = $2::uuid`,
        input.reason,
        approvalId,
      );
      orderId = r.order_id;
    });
    if (orderId) {
      await this.orders.cancelFromApprovalDecline(orderId);
    }
    return this.getApproval(approvalId);
  }

  private async getApproval(id: string): Promise<OrderApprovalDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.order_id::text AS order_id, a.parent_person_id::text AS parent_person_id, (SELECT first_name || ' ' || last_name FROM platform.iam_person WHERE id = a.parent_person_id) AS parent_name, a.status, a.requested_at::text AS requested_at, a.responded_at::text AS responded_at, a.decline_reason FROM str_order_approvals a WHERE a.id = $1::uuid LIMIT 1`,
        id,
      );
    })) as ApprovalRow[];
    if (rows.length === 0) throw new NotFoundException('Approval not found');
    const r = rows[0]!;
    return {
      id: r.id,
      orderId: r.order_id,
      parentPersonId: r.parent_person_id,
      parentName: r.parent_name,
      status: r.status as ApprovalStatus,
      requestedAt: r.requested_at,
      respondedAt: r.responded_at,
      declineReason: r.decline_reason,
    };
  }
}
