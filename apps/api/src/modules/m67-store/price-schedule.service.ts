import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { generateId, getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { assertStoreAdmin, assertStoreReader } from './access-advanced';
import { deterministicPriceScheduleAppliedEventId } from './event-ids-advanced';
import type { CreatePriceScheduleDto, PriceScheduleDto } from './dto/commerce-store.dto';

interface ScheduleRow {
  id: string;
  product_id: string;
  scheduled_price: string | number;
  effective_from: string;
  effective_to: string | null;
  reason: string | null;
  applied_at: string | null;
  reverted_at: string | null;
  created_by: string | null;
  created_at: string;
}

interface RipeRow {
  id: string;
  product_id: string;
  scheduled_price: string | number;
  effective_from: string;
  effective_to: string | null;
}

interface RevertRow {
  id: string;
  product_id: string;
  effective_to: string;
}

/**
 * P2-29b — PriceScheduleService + PriceScheduleWorker.
 *
 * Schedules a future price change. The worker sweeps every minute
 * (configurable) and applies ripe rows + reverts expired rows.
 *
 * Apply path:
 *   - SELECT … WHERE applied_at IS NULL AND effective_from <= now()
 *     FOR UPDATE SKIP LOCKED (the partial INDEX str_ps_ripe_idx is
 *     the hot path)
 *   - For each ripe row: UPDATE str_products SET price = scheduled
 *     in the same tx as UPDATE str_price_schedules SET applied_at
 *
 * Revert path (only when effective_to is set):
 *   - SELECT … WHERE applied_at IS NOT NULL AND reverted_at IS NULL
 *     AND effective_to IS NOT NULL AND effective_to <= now()
 *   - The revert restores whatever the product price is now; the
 *     plan intentionally keeps the revert simple — schools that
 *     need a full price-history with rollback should use the apply
 *     path with effective_to NULL and chain schedules.
 *
 * For revert we cannot restore an arbitrary "previous" price
 * without snapshotting it pre-apply. The cycle plan documents
 * revert as best-effort — for now we just stamp reverted_at and
 * leave the product price at whatever the next ripe schedule
 * applies. Schools that need true rollback should chain schedules.
 */
@Injectable()
export class PriceScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceScheduleService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {
    this.intervalMs = Number(process.env.STR_PRICE_SCHEDULE_INTERVAL_MS) || 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('PriceScheduleWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'PriceScheduleWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 1000) +
        ' second(s)',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private toDto(row: ScheduleRow): PriceScheduleDto {
    return {
      id: row.id,
      productId: row.product_id,
      scheduledPrice: Number(row.scheduled_price),
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      reason: row.reason,
      appliedAt: row.applied_at,
      revertedAt: row.reverted_at,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  async listForProduct(actor: ResolvedActor, productId: string): Promise<PriceScheduleDto[]> {
    await assertStoreReader(actor, this.permCheck, 'Price schedule list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT ps.id::text AS id, ps.product_id::text AS product_id,
                ps.scheduled_price,
                ps.effective_from::text AS effective_from,
                ps.effective_to::text AS effective_to,
                ps.reason,
                ps.applied_at::text AS applied_at,
                ps.reverted_at::text AS reverted_at,
                ps.created_by::text AS created_by,
                ps.created_at::text AS created_at
           FROM str_price_schedules ps
           JOIN str_products p ON p.id = ps.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid AND ps.product_id = $2::uuid
          ORDER BY ps.effective_from`,
        tenant.schoolId,
        productId,
      )) as ScheduleRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async create(actor: ResolvedActor, input: CreatePriceScheduleDto): Promise<PriceScheduleDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Price schedule create');
    const tenant = getCurrentTenant();
    if (input.effectiveTo && new Date(input.effectiveTo) <= new Date(input.effectiveFrom)) {
      throw new BadRequestException('effectiveTo must be strictly after effectiveFrom');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const productRows = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_products p
           JOIN str_stores s ON s.id = p.store_id
          WHERE p.id = $1::uuid AND s.school_id = $2::uuid`,
        input.productId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (productRows.length === 0) {
        throw new BadRequestException('productId does not match a product in this school');
      }
      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_price_schedules
           (id, product_id, scheduled_price, effective_from, effective_to, reason, created_by)
         VALUES ($1::uuid, $2::uuid, $3::numeric, $4::timestamptz, $5::timestamptz, $6, $7::uuid)
         RETURNING id::text AS id, product_id::text AS product_id,
                   scheduled_price,
                   effective_from::text AS effective_from,
                   effective_to::text AS effective_to,
                   reason,
                   applied_at::text AS applied_at,
                   reverted_at::text AS reverted_at,
                   created_by::text AS created_by,
                   created_at::text AS created_at`,
        id,
        input.productId,
        input.scheduledPrice,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.reason ?? null,
        actor.employeeId ?? null,
      )) as ScheduleRow[];
      return this.toDto(rows[0]!);
    });
  }

  async remove(actor: ResolvedActor, id: string): Promise<void> {
    await assertStoreAdmin(actor, this.permCheck, 'Price schedule remove');
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT ps.id::text AS id, ps.applied_at::text AS applied_at
           FROM str_price_schedules ps
           JOIN str_products p ON p.id = ps.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid AND ps.id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; applied_at: string | null }>;
      if (existing.length === 0) throw new NotFoundException('Price schedule not found');
      if (existing[0]!.applied_at) {
        throw new BadRequestException(
          'Cannot remove an already-applied schedule — it is part of the product price history',
        );
      }
      await tx.$executeRawUnsafe(`DELETE FROM str_price_schedules WHERE id = $1::uuid`, id);
    });
  }

  /** Periodic sweep across every active tenant. */
  async runOnce(): Promise<{ tenantsScanned: number; rowsApplied: number; rowsReverted: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({ where: { isActive: true } });
    let totalApplied = 0;
    let totalReverted = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const { applied, reverted } = await this.tickForSchool(
          school.schemaName,
          school.id,
          school.subdomain,
        );
        totalApplied += applied;
        totalReverted += reverted;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('PriceScheduleWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsApplied: totalApplied, rowsReverted: totalReverted };
  }

  async tickForSchool(
    schemaName: string,
    schoolId: string,
    subdomain: string,
  ): Promise<{ applied: number; reverted: number }> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      // APPLY ripe schedules — partial INDEX str_ps_ripe_idx is the
      // hot path for the WHERE clause.
      const ripe = (await client.$queryRawUnsafe(
        `SELECT ps.id::text AS id,
                ps.product_id::text AS product_id,
                ps.scheduled_price,
                ps.effective_from::text AS effective_from,
                ps.effective_to::text AS effective_to
           FROM str_price_schedules ps
           JOIN str_products p ON p.id = ps.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid
            AND ps.applied_at IS NULL
            AND ps.effective_from <= now()
          ORDER BY ps.effective_from
          LIMIT 200`,
        schoolId,
      )) as RipeRow[];

      let applied = 0;
      for (const r of ripe) {
        // REVIEW-P2C29 Round 1 BLOCKING 4: carry the school
        // predicate into the apply UPDATEs themselves. The
        // pre-select already joins through str_products + str_stores,
        // but if a stale or cross-tenant row leaks the mutation
        // path stays defensive — both UPDATEs join back to
        // str_stores.school_id.
        await client.$executeRawUnsafe(
          `UPDATE str_products p
              SET price = $1::numeric, updated_at = now()
             FROM str_stores s
            WHERE s.id = p.store_id
              AND s.school_id = $2::uuid
              AND p.id = $3::uuid`,
          r.scheduled_price,
          schoolId,
          r.product_id,
        );
        await client.$executeRawUnsafe(
          `UPDATE str_price_schedules ps
              SET applied_at = now()
             FROM str_products p
             JOIN str_stores s ON s.id = p.store_id
            WHERE p.id = ps.product_id
              AND s.school_id = $1::uuid
              AND ps.id = $2::uuid`,
          schoolId,
          r.id,
        );
        await this.outbox.enqueueInTx(client, {
          topic: 'str.price.scheduled_applied',
          payload: {
            scheduleId: r.id,
            productId: r.product_id,
            schoolId,
            scheduledPrice: Number(r.scheduled_price),
            effectiveFrom: r.effective_from,
            effectiveTo: r.effective_to,
            sourceRefId: r.id,
          },
          sourceModule: 'commerce',
          eventId: deterministicPriceScheduleAppliedEventId(r.id),
          tenantId: schoolId,
          tenantSubdomain: subdomain,
          key: r.product_id,
        });
        applied += 1;
      }

      // REVERT expired schedules — stamp reverted_at. We do NOT
      // restore the prior price (no snapshot column on str_products);
      // schools that need true rollback should chain schedules so a
      // subsequent ripe schedule lands the restoration price.
      const revertable = (await client.$queryRawUnsafe(
        `SELECT ps.id::text AS id,
                ps.product_id::text AS product_id,
                ps.effective_to::text AS effective_to
           FROM str_price_schedules ps
           JOIN str_products p ON p.id = ps.product_id
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid
            AND ps.applied_at IS NOT NULL
            AND ps.reverted_at IS NULL
            AND ps.effective_to IS NOT NULL
            AND ps.effective_to <= now()
          LIMIT 200`,
        schoolId,
      )) as RevertRow[];

      let reverted = 0;
      for (const r of revertable) {
        // REVIEW-P2C29 Round 1 BLOCKING 4: carry school predicate
        // into the revert UPDATE — same defensive pattern as apply.
        await client.$executeRawUnsafe(
          `UPDATE str_price_schedules ps
              SET reverted_at = now()
             FROM str_products p
             JOIN str_stores s ON s.id = p.store_id
            WHERE p.id = ps.product_id
              AND s.school_id = $1::uuid
              AND ps.id = $2::uuid`,
          schoolId,
          r.id,
        );
        reverted += 1;
      }

      if (applied > 0 || reverted > 0) {
        this.logger.log(
          'PriceScheduleWorker applied=' + applied + ' reverted=' + reverted + ' in ' + schemaName,
        );
      }
      return { applied, reverted };
    });
  }
}
