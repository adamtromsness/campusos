import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { prefixedTopic } from '../../kafka/event-envelope';
import { TenantPrismaService } from '../../tenant/tenant-prisma.service';
import { CheckpointService } from '../workers.service';
import {
  assertPayloadSchoolMatchesEnvelope,
  claimReadModelContribution,
  dispatchOperationsEvent,
  monthAnchor,
} from './operations-worker-base';
import type { UnwrappedEvent } from '../../notifications/consumers/notification-consumer-base';

/* =========================================================================
   P2-15a Operations Read-Model Workers (M110 Analytics .1, ADR-008)

   Each worker is the SINGLE WRITER to its target rpt_* table(s) and
   subscribes to exactly the documented Kafka topic(s). Workers run
   idempotent INSERT ON CONFLICT DO UPDATE against the rpt_*
   UNIQUE constraint, and record the committed offset to
   rpt_analytics_worker_checkpoints after each successful event.

   Source-module → consumer-group mapping (single-writer guarantee):

     ProcurementReadModelWorker   →  procurement-readmodel-worker
     StoreReadModelWorker          →  store-readmodel-worker
     FoodServiceReadModelWorker    →  food-service-readmodel-worker
     TransportReadModelWorker      →  transport-readmodel-worker
     FacilitiesReadModelWorker     →  facilities-readmodel-worker
     ITReadModelWorker             →  it-readmodel-worker
     LibraryReadModelWorker        →  library-readmodel-worker

   rpt_facilities_kpi is materialised nightly via
   FacilitiesReadModelWorker.materialiseKpi() — NOT a live consumer
   (per the plan, energy data lags the work-order stream so a daily
   roll-up is the right cadence). Every other rpt_* table is live-
   updated by the consumer.
   ========================================================================= */

/* ---- 1. Procurement: prc.po.issued + prc.receipt.completed --------------- */

interface PoIssuedPayload {
  poId: string;
  schoolId: string;
  vendorId: string;
  department?: string;
  totalAmount: number | string;
  issuedAt: string;
}

interface ReceiptCompletedPayload {
  receiptId: string;
  poId: string;
  schoolId: string;
  vendorId: string;
  department?: string;
  leadTimeDays?: number | string | null;
  completedAt: string;
}

@Injectable()
export class ProcurementReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(ProcurementReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'procurement-readmodel-worker';
  private static readonly SOURCE_TOPICS = ['prc.po.issued', 'prc.receipt.completed'];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: ProcurementReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: ProcurementReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<PoIssuedPayload | ReceiptCompletedPayload>(
      msg,
      ProcurementReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        const isReceipt = msg.topic.endsWith('prc.receipt.completed');
        await this.upsert(event, isReceipt);
        await this.checkpoints.record(
          ProcurementReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(
    event: UnwrappedEvent<PoIssuedPayload | ReceiptCompletedPayload>,
    isReceipt: boolean,
  ): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.vendorId) {
      this.logger.warn(
        '[' + ProcurementReadModelWorker.CONSUMER_GROUP + '] missing schoolId/vendorId — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        ProcurementReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = isReceipt
      ? monthAnchor((p as ReceiptCompletedPayload).completedAt)
      : monthAnchor((p as PoIssuedPayload).issuedAt);
    const department = p.department ?? 'UNKNOWN';
    const totalSpendDelta = isReceipt ? 0 : Number((p as PoIssuedPayload).totalAmount ?? 0);
    const leadTime = isReceipt ? Number((p as ReceiptCompletedPayload).leadTimeDays ?? 0) : null;
    const totalPosDelta = isReceipt ? 0 : 1;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        ProcurementReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_procurement_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_procurement_summary
          (id, school_id, period, department, vendor_id, total_pos, total_spend, avg_lead_time_days, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::uuid, $6, $7::numeric, $8::numeric, now())
         ON CONFLICT (school_id, period, department, vendor_id) DO UPDATE
           SET total_pos = rpt_procurement_summary.total_pos + EXCLUDED.total_pos,
               total_spend = rpt_procurement_summary.total_spend + EXCLUDED.total_spend,
               avg_lead_time_days = CASE
                 WHEN $9::numeric IS NULL THEN rpt_procurement_summary.avg_lead_time_days
                 WHEN rpt_procurement_summary.avg_lead_time_days IS NULL THEN $9::numeric
                 ELSE ((rpt_procurement_summary.avg_lead_time_days + $9::numeric) / 2)
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        period,
        department,
        p.vendorId,
        totalPosDelta,
        totalSpendDelta.toFixed(2),
        leadTime !== null ? leadTime.toFixed(2) : null,
        leadTime !== null ? leadTime.toFixed(2) : null,
      );
    });
  }
}

/* ---- 2. Store: str.order.completed --------------------------------------- */

interface StoreOrderCompletedPayload {
  orderId: string;
  schoolId: string;
  items: Array<{
    productId: string;
    quantity: number;
    revenue: number | string;
    costOfGoods?: number | string;
  }>;
  completedAt: string;
}

@Injectable()
export class StoreReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(StoreReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'store-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'str.order.completed';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(StoreReadModelWorker.SOURCE_TOPIC)],
      groupId: StoreReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<StoreOrderCompletedPayload>(
      msg,
      StoreReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          StoreReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<StoreOrderCompletedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !Array.isArray(p.items)) {
      this.logger.warn(
        '[' + StoreReadModelWorker.CONSUMER_GROUP + '] missing schoolId/items — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        StoreReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.completedAt);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        StoreReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_store_sales',
      );
      if (!claimed) return;
      for (const item of p.items) {
        const revenue = Number(item.revenue ?? 0);
        const cogs = Number(item.costOfGoods ?? 0);
        const margin = revenue > 0 ? (revenue - cogs) / revenue : null;
        await tx.$executeRawUnsafe(
          `INSERT INTO rpt_store_sales
            (id, school_id, period, product_id, units_sold, revenue, cost_of_goods, profit_margin, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6::numeric, $7::numeric, $8::numeric, now())
           ON CONFLICT (school_id, period, product_id) DO UPDATE
             SET units_sold = rpt_store_sales.units_sold + EXCLUDED.units_sold,
                 revenue = rpt_store_sales.revenue + EXCLUDED.revenue,
                 cost_of_goods = rpt_store_sales.cost_of_goods + EXCLUDED.cost_of_goods,
                 profit_margin = CASE
                   WHEN (rpt_store_sales.revenue + EXCLUDED.revenue) > 0
                   THEN ((rpt_store_sales.revenue + EXCLUDED.revenue - rpt_store_sales.cost_of_goods - EXCLUDED.cost_of_goods)
                         / (rpt_store_sales.revenue + EXCLUDED.revenue))
                   ELSE NULL
                 END,
                 generated_at = now()`,
          generateId(),
          p.schoolId,
          period,
          item.productId,
          item.quantity,
          revenue.toFixed(2),
          cogs.toFixed(2),
          margin === null ? null : margin.toFixed(4),
        );
      }
    });
  }
}

/* ---- 3. Food Service: fds.meal.served (writes meal_counts + nslp_summary) - */

interface MealServedPayload {
  mealServingId: string;
  schoolId: string;
  serviceDate: string;
  mealType: 'BREAKFAST' | 'LUNCH' | 'SNACK' | 'SUPPER';
  eligibilityCategory: 'FREE' | 'REDUCED' | 'PAID';
  reimbursementEstimate?: number | string;
  wasted?: boolean;
}

@Injectable()
export class FoodServiceReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(FoodServiceReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'food-service-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'fds.meal.served';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(FoodServiceReadModelWorker.SOURCE_TOPIC)],
      groupId: FoodServiceReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<MealServedPayload>(
      msg,
      FoodServiceReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          FoodServiceReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<MealServedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.serviceDate || !p.mealType) {
      this.logger.warn(
        '[' + FoodServiceReadModelWorker.CONSUMER_GROUP + '] missing schoolId/date/mealType — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        FoodServiceReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const isWaste = p.wasted === true;
    const free = !isWaste && p.eligibilityCategory === 'FREE' ? 1 : 0;
    const reduced = !isWaste && p.eligibilityCategory === 'REDUCED' ? 1 : 0;
    const paid = !isWaste && p.eligibilityCategory === 'PAID' ? 1 : 0;
    const total = free + reduced + paid;
    const waste = isWaste ? 1 : 0;
    const monthYear = monthAnchor(p.serviceDate);
    const reimb = Number(p.reimbursementEstimate ?? 0);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Per-day meal counts — claim contribution for this target table first
      const mealClaimed = await claimReadModelContribution(
        tx,
        FoodServiceReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_fds_meal_counts',
      );
      if (mealClaimed) {
        await tx.$executeRawUnsafe(
          `INSERT INTO rpt_fds_meal_counts
            (id, school_id, service_date, meal_type, total_served, free_count, reduced_count, paid_count, waste_count, generated_at)
           VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, now())
           ON CONFLICT (school_id, service_date, meal_type) DO UPDATE
             SET total_served = rpt_fds_meal_counts.total_served + EXCLUDED.total_served,
                 free_count = rpt_fds_meal_counts.free_count + EXCLUDED.free_count,
                 reduced_count = rpt_fds_meal_counts.reduced_count + EXCLUDED.reduced_count,
                 paid_count = rpt_fds_meal_counts.paid_count + EXCLUDED.paid_count,
                 waste_count = rpt_fds_meal_counts.waste_count + EXCLUDED.waste_count,
                 generated_at = now()`,
          generateId(),
          p.schoolId,
          p.serviceDate,
          p.mealType,
          total,
          free,
          reduced,
          paid,
          waste,
        );
      }

      // Monthly NSLP summary — separate contribution row per target table
      if (!isWaste) {
        const nslpClaimed = await claimReadModelContribution(
          tx,
          FoodServiceReadModelWorker.CONSUMER_GROUP,
          event.eventId,
          'rpt_fds_nslp_summary',
        );
        if (nslpClaimed) {
          await tx.$executeRawUnsafe(
            `INSERT INTO rpt_fds_nslp_summary
              (id, school_id, month_year, free_meals, reduced_meals, paid_meals, total_reimbursement_estimate, generated_at)
             VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::numeric, now())
             ON CONFLICT (school_id, month_year) DO UPDATE
               SET free_meals = rpt_fds_nslp_summary.free_meals + EXCLUDED.free_meals,
                   reduced_meals = rpt_fds_nslp_summary.reduced_meals + EXCLUDED.reduced_meals,
                   paid_meals = rpt_fds_nslp_summary.paid_meals + EXCLUDED.paid_meals,
                   total_reimbursement_estimate = rpt_fds_nslp_summary.total_reimbursement_estimate + EXCLUDED.total_reimbursement_estimate,
                   generated_at = now()`,
            generateId(),
            p.schoolId,
            monthYear,
            free,
            reduced,
            paid,
            reimb.toFixed(2),
          );
        }
      }
    });
  }
}

/* ---- 4. Transportation: trn.run.completed -------------------------------- */

interface RunCompletedPayload {
  runId: string;
  schoolId: string;
  routeId: string;
  riderCount: number;
  durationMinutes: number;
  onTime: boolean;
  completedAt: string;
}

@Injectable()
export class TransportReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(TransportReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'transport-readmodel-worker';
  private static readonly SOURCE_TOPIC = 'trn.run.completed';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic(TransportReadModelWorker.SOURCE_TOPIC)],
      groupId: TransportReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<RunCompletedPayload>(
      msg,
      TransportReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event);
        await this.checkpoints.record(
          TransportReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<RunCompletedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.routeId) {
      this.logger.warn(
        '[' + TransportReadModelWorker.CONSUMER_GROUP + '] missing schoolId/routeId — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        TransportReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(p.completedAt);
    const ridersDelta = Math.max(0, Number(p.riderCount ?? 0));
    const durationDelta = Math.max(0, Number(p.durationMinutes ?? 0));
    const onTimeDelta = p.onTime ? 1 : 0;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        TransportReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_trn_ridership_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_trn_ridership_summary
          (id, school_id, route_id, period, total_runs, total_riders, avg_riders_per_run, on_time_rate, avg_duration_minutes, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $5, $6::numeric, $7::numeric, $8::numeric, now())
         ON CONFLICT (school_id, route_id, period) DO UPDATE
           SET total_runs = rpt_trn_ridership_summary.total_runs + 1,
               total_riders = rpt_trn_ridership_summary.total_riders + EXCLUDED.total_riders,
               avg_riders_per_run = ((rpt_trn_ridership_summary.total_riders + EXCLUDED.total_riders)::numeric
                                     / (rpt_trn_ridership_summary.total_runs + 1)),
               on_time_rate = (
                 ((COALESCE(rpt_trn_ridership_summary.on_time_rate, 0) * rpt_trn_ridership_summary.total_runs) + $9)::numeric
                 / (rpt_trn_ridership_summary.total_runs + 1)
               ),
               avg_duration_minutes = (
                 ((COALESCE(rpt_trn_ridership_summary.avg_duration_minutes, 0) * rpt_trn_ridership_summary.total_runs) + EXCLUDED.avg_duration_minutes)::numeric
                 / (rpt_trn_ridership_summary.total_runs + 1)
               ),
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.routeId,
        period,
        ridersDelta,
        ridersDelta.toFixed(2),
        onTimeDelta.toFixed(4),
        durationDelta.toFixed(2),
        onTimeDelta,
      );
    });
  }
}

/* ---- 5. Facilities: condition (live) + KPI (nightly batch) --------------- */

interface InspectionCompletedPayload {
  inspectionId: string;
  schoolId: string;
  buildingId: string;
  spaceId: string;
  conditionScore: number | string;
  inspectionDate: string;
}

interface WorkOrderEventPayload {
  workOrderId: string;
  schoolId: string;
  buildingId: string;
  spaceId: string;
  status: 'OPEN' | 'COMPLETED' | 'OVERDUE';
  completedAt?: string;
  createdAt?: string;
  overdue?: boolean;
}

@Injectable()
export class FacilitiesReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(FacilitiesReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'facilities-readmodel-worker';
  private static readonly INSPECTION_TOPIC = 'fac.inspection.completed';
  private static readonly WORK_ORDER_TOPIC = 'fac.work_order.completed';

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [
        prefixedTopic(FacilitiesReadModelWorker.INSPECTION_TOPIC),
        prefixedTopic(FacilitiesReadModelWorker.WORK_ORDER_TOPIC),
      ],
      groupId: FacilitiesReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const isInspection = msg.topic.endsWith('fac.inspection.completed');
    await dispatchOperationsEvent<InspectionCompletedPayload | WorkOrderEventPayload>(
      msg,
      FacilitiesReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        if (isInspection) {
          await this.upsertInspection(event as UnwrappedEvent<InspectionCompletedPayload>);
        } else {
          await this.upsertWorkOrder(event as UnwrappedEvent<WorkOrderEventPayload>);
        }
        await this.checkpoints.record(
          FacilitiesReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsertInspection(event: UnwrappedEvent<InspectionCompletedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.buildingId || !p.spaceId) {
      this.logger.warn('[' + FacilitiesReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        FacilitiesReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const score = Math.min(10, Math.max(0, Number(p.conditionScore ?? 0)));
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        FacilitiesReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_facilities_condition',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_facilities_condition
          (id, school_id, building_id, space_id, last_inspection_date, condition_score, open_work_orders, overdue_work_orders, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::numeric, 0, 0, now())
         ON CONFLICT (school_id, building_id, space_id) DO UPDATE
           SET last_inspection_date = EXCLUDED.last_inspection_date,
               condition_score = EXCLUDED.condition_score,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.buildingId,
        p.spaceId,
        p.inspectionDate,
        score.toFixed(1),
      );
    });
  }

  async upsertWorkOrder(event: UnwrappedEvent<WorkOrderEventPayload>): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.buildingId || !p.spaceId) {
      this.logger.warn('[' + FacilitiesReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        FacilitiesReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    // For COMPLETED work orders, the row may have had an open WO counted upstream
    // and the consumer here decrements when status flips COMPLETED. For demo we
    // simply ensure a row exists. Real implementation would also consume
    // fac.work_order.created to bump open_work_orders.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        FacilitiesReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_facilities_condition',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_facilities_condition
          (id, school_id, building_id, space_id, condition_score, open_work_orders, overdue_work_orders, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 0, 0, now())
         ON CONFLICT (school_id, building_id, space_id) DO UPDATE
           SET open_work_orders = GREATEST(rpt_facilities_condition.open_work_orders - 1, 0),
               overdue_work_orders = CASE WHEN $5::boolean THEN GREATEST(rpt_facilities_condition.overdue_work_orders - 1, 0)
                                          ELSE rpt_facilities_condition.overdue_work_orders END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.buildingId,
        p.spaceId,
        p.overdue === true,
      );
    });
  }

  /**
   * Nightly batch — rpt_facilities_kpi is the only operations read model NOT
   * fed by a live consumer. Energy data lags the work-order stream so a
   * monthly roll-up is the right cadence per the plan.
   *
   * Takes the school_id explicitly so callers control the tenant context.
   * Aggregates from fac_work_orders for the supplied period (first day of
   * the month → first day of the next month).
   */
  async materialiseKpi(
    schoolId: string,
    period: string,
  ): Promise<{ rowsWritten: number; durationMs: number }> {
    const start = Date.now();
    const anchor = monthAnchor(period);
    let rowsWritten = 0;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        // REVIEW-P2C15 R1 BLOCKING 2 — school-scope the source aggregate so
        // cross-school work orders in a multi-school tenant cannot pollute the
        // current school's KPI row.
        `SELECT COUNT(*)::int AS total_work_orders,
                COUNT(*) FILTER (WHERE status = 'COMPLETED' AND completed_at IS NOT NULL)::int AS completed_on_time,
                AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 86400)::numeric AS avg_resolution_days
         FROM fac_work_orders
         WHERE school_id = $2::uuid
           AND created_at >= $1::date AND created_at < ($1::date + INTERVAL '1 month')`,
        anchor,
        schoolId,
      )) as Array<{
        total_work_orders: number;
        completed_on_time: number;
        avg_resolution_days: string | number | null;
      }>;
      const row = rows[0] ?? {
        total_work_orders: 0,
        completed_on_time: 0,
        avg_resolution_days: null,
      };
      await client.$executeRawUnsafe(
        `INSERT INTO rpt_facilities_kpi
          (id, school_id, period, total_work_orders, completed_on_time, avg_resolution_days, energy_cost, cost_per_sqft, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, 0, NULL, now())
         ON CONFLICT (school_id, period) DO UPDATE
           SET total_work_orders = EXCLUDED.total_work_orders,
               completed_on_time = EXCLUDED.completed_on_time,
               avg_resolution_days = EXCLUDED.avg_resolution_days,
               generated_at = now()`,
        generateId(),
        schoolId,
        anchor,
        row.total_work_orders,
        row.completed_on_time,
        row.avg_resolution_days === null ? null : Number(row.avg_resolution_days).toFixed(2),
      );
      rowsWritten = 1;
    });
    await this.checkpoints.record(
      FacilitiesReadModelWorker.CONSUMER_GROUP,
      'rpt_facilities_kpi_nightly',
      0,
      rowsWritten,
    );
    return { rowsWritten, durationMs: Date.now() - start };
  }
}

/* ---- 6. IT Fleet: tech.device.* ------------------------------------------ */

interface DeviceEventPayload {
  deviceId: string;
  schoolId: string;
  deviceType: string;
  status?: 'ACTIVE' | 'IN_REPAIR' | 'DECOMMISSIONED';
  eventType: 'PROVISIONED' | 'DEPROVISIONED' | 'INCIDENT' | 'STATUS_CHANGED';
  ageMonths?: number | string;
  occurredAt: string;
}

@Injectable()
export class ITReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(ITReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'it-readmodel-worker';
  private static readonly SOURCE_TOPICS = [
    'tech.device.provisioned',
    'tech.device.deprovisioned',
    'tech.device.incident',
  ];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: ITReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: ITReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    await dispatchOperationsEvent<DeviceEventPayload>(
      msg,
      ITReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event, msg.topic);
        await this.checkpoints.record(
          ITReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(event: UnwrappedEvent<DeviceEventPayload>, topic: string): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.deviceType) {
      this.logger.warn('[' + ITReadModelWorker.CONSUMER_GROUP + '] missing fields — drop');
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        ITReadModelWorker.CONSUMER_GROUP,
        topic,
        this.logger,
      )
    ) {
      return;
    }
    let totalDelta = 0;
    let activeDelta = 0;
    let repairDelta = 0;
    let decomDelta = 0;
    let incidentDelta = 0;
    if (topic.endsWith('tech.device.provisioned')) {
      totalDelta = 1;
      activeDelta = 1;
    } else if (topic.endsWith('tech.device.deprovisioned')) {
      activeDelta = -1;
      decomDelta = 1;
    } else if (topic.endsWith('tech.device.incident')) {
      incidentDelta = 1;
      if (p.status === 'IN_REPAIR') {
        activeDelta = -1;
        repairDelta = 1;
      }
    }

    const ageMonths = Number(p.ageMonths ?? 0);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        ITReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_tech_fleet_status',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_tech_fleet_status
          (id, school_id, device_type, total_devices, active, in_repair, decommissioned, avg_age_months, incident_rate, generated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, 0::numeric, now())
         ON CONFLICT (school_id, device_type) DO UPDATE
           SET total_devices = GREATEST(rpt_tech_fleet_status.total_devices + EXCLUDED.total_devices, 0),
               active = GREATEST(rpt_tech_fleet_status.active + $9, 0),
               in_repair = GREATEST(rpt_tech_fleet_status.in_repair + $10, 0),
               decommissioned = GREATEST(rpt_tech_fleet_status.decommissioned + $11, 0),
               avg_age_months = CASE
                 WHEN $12::numeric IS NULL OR $12::numeric = 0 THEN rpt_tech_fleet_status.avg_age_months
                 WHEN rpt_tech_fleet_status.avg_age_months IS NULL THEN $12::numeric
                 ELSE ((rpt_tech_fleet_status.avg_age_months + $12::numeric) / 2)
               END,
               incident_rate = CASE
                 WHEN GREATEST(rpt_tech_fleet_status.total_devices + EXCLUDED.total_devices, 1) > 0
                 THEN LEAST(
                   ((COALESCE(rpt_tech_fleet_status.incident_rate, 0)
                     * GREATEST(rpt_tech_fleet_status.total_devices, 1))
                    + $13)::numeric
                   / GREATEST(rpt_tech_fleet_status.total_devices + EXCLUDED.total_devices, 1),
                   1
                 )
                 ELSE NULL
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        p.deviceType,
        totalDelta,
        Math.max(activeDelta, 0),
        Math.max(repairDelta, 0),
        Math.max(decomDelta, 0),
        ageMonths > 0 ? ageMonths.toFixed(2) : null,
        activeDelta,
        repairDelta,
        decomDelta,
        ageMonths > 0 ? ageMonths.toFixed(2) : null,
        incidentDelta,
      );
    });
  }
}

/* ---- 7. Library: lib.checkout.created + lib.return.completed ------------- */

interface CheckoutCreatedPayload {
  checkoutId: string;
  schoolId: string;
  catalogueItemId: string;
  catalogueItemTitle?: string;
  createdAt: string;
}

interface ReturnCompletedPayload {
  checkoutId: string;
  schoolId: string;
  catalogueItemId: string;
  catalogueItemTitle?: string;
  loanDurationDays?: number | string;
  overdue?: boolean;
  returnedAt: string;
}

@Injectable()
export class LibraryReadModelWorker implements OnModuleInit {
  private readonly logger = new Logger(LibraryReadModelWorker.name);
  private static readonly CONSUMER_GROUP = 'library-readmodel-worker';
  private static readonly SOURCE_TOPICS = ['lib.checkout.created', 'lib.return.completed'];

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly checkpoints: CheckpointService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: LibraryReadModelWorker.SOURCE_TOPICS.map(prefixedTopic),
      groupId: LibraryReadModelWorker.CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const isReturn = msg.topic.endsWith('lib.return.completed');
    await dispatchOperationsEvent<CheckoutCreatedPayload | ReturnCompletedPayload>(
      msg,
      LibraryReadModelWorker.CONSUMER_GROUP,
      this.idempotency,
      this.logger,
      async (event) => {
        await this.upsert(event, isReturn);
        await this.checkpoints.record(
          LibraryReadModelWorker.CONSUMER_GROUP,
          msg.topic,
          msg.partition ?? 0,
          msg.offset !== undefined ? Number(msg.offset) : 0,
        );
      },
    );
  }

  async upsert(
    event: UnwrappedEvent<CheckoutCreatedPayload | ReturnCompletedPayload>,
    isReturn: boolean,
  ): Promise<void> {
    const p = event.payload;
    if (!p.schoolId || !p.catalogueItemId) {
      this.logger.warn(
        '[' + LibraryReadModelWorker.CONSUMER_GROUP + '] missing schoolId/itemId — drop',
      );
      return;
    }
    if (
      !assertPayloadSchoolMatchesEnvelope(
        event,
        p.schoolId,
        LibraryReadModelWorker.CONSUMER_GROUP,
        event.topic,
        this.logger,
      )
    ) {
      return;
    }
    const period = monthAnchor(
      isReturn ? (p as ReturnCompletedPayload).returnedAt : (p as CheckoutCreatedPayload).createdAt,
    );
    const title = p.catalogueItemTitle ?? p.catalogueItemId;
    const checkoutDelta = isReturn ? 0 : 1;
    const returnDelta = isReturn ? 1 : 0;
    const overdueDelta = isReturn && (p as ReturnCompletedPayload).overdue === true ? 1 : 0;
    const durationVal = isReturn
      ? Number((p as ReturnCompletedPayload).loanDurationDays ?? 0)
      : null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const claimed = await claimReadModelContribution(
        tx,
        LibraryReadModelWorker.CONSUMER_GROUP,
        event.eventId,
        'rpt_lib_circulation_summary',
      );
      if (!claimed) return;
      await tx.$executeRawUnsafe(
        `INSERT INTO rpt_lib_circulation_summary
          (id, school_id, period, total_checkouts, total_returns, overdue_count, popular_titles, avg_loan_duration_days, generated_at)
         VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::jsonb, $8::numeric, now())
         ON CONFLICT (school_id, period) DO UPDATE
           SET total_checkouts = rpt_lib_circulation_summary.total_checkouts + EXCLUDED.total_checkouts,
               total_returns = rpt_lib_circulation_summary.total_returns + EXCLUDED.total_returns,
               overdue_count = rpt_lib_circulation_summary.overdue_count + EXCLUDED.overdue_count,
               popular_titles = (
                 SELECT jsonb_agg(elem ORDER BY (elem->>'count')::int DESC)
                 FROM (
                   SELECT jsonb_build_object('title', t.title, 'count', sum(t.count)::int) AS elem
                   FROM (
                     SELECT (elem->>'title') AS title, ((elem->>'count')::int) AS count
                     FROM jsonb_array_elements(rpt_lib_circulation_summary.popular_titles) elem
                     UNION ALL
                     SELECT (elem->>'title'), ((elem->>'count')::int)
                     FROM jsonb_array_elements(EXCLUDED.popular_titles) elem
                   ) t
                   GROUP BY t.title
                   ORDER BY sum(t.count) DESC
                   LIMIT 10
                 ) merged
               ),
               avg_loan_duration_days = CASE
                 WHEN $9::numeric IS NULL THEN rpt_lib_circulation_summary.avg_loan_duration_days
                 WHEN rpt_lib_circulation_summary.avg_loan_duration_days IS NULL THEN $9::numeric
                 ELSE ((rpt_lib_circulation_summary.avg_loan_duration_days + $9::numeric) / 2)
               END,
               generated_at = now()`,
        generateId(),
        p.schoolId,
        period,
        checkoutDelta,
        returnDelta,
        overdueDelta,
        JSON.stringify(isReturn ? [] : [{ title, count: 1 }]),
        durationVal !== null ? durationVal.toFixed(2) : null,
        durationVal !== null ? durationVal.toFixed(2) : null,
      );
    });
  }
}
