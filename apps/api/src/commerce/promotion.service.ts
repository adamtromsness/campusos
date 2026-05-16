import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { OutboxService } from '../kafka/outbox.service';
import {
  assertStoreAdmin,
  assertStoreCustomer,
  assertStoreReader,
  isUniqueViolation,
} from './access';
import { deterministicPromotionRedeemedEventId } from './event-ids';
import type {
  ApplyPromoCodeDto,
  CreatePromotionDto,
  PromotionDetailDto,
  PromotionDiscountType,
  PromotionDto,
  UpdatePromotionDto,
} from './dto/commerce-store.dto';

interface PromotionRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  discount_type: string;
  discount_value: string | number;
  min_order_amount: string | number | null;
  promo_code: string | null;
  starts_at: string;
  ends_at: string;
  max_uses: number | null;
  current_uses: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * P2-29b — PromotionService.
 *
 * Per-store discount promotion with 4-value discount_type CHECK and
 * the keystone atomic max_uses enforcement via the SQL pattern
 *
 *   UPDATE str_promotions
 *      SET current_uses = current_uses + 1, updated_at = now()
 *    WHERE id = $1::uuid
 *      AND store_id = $2::uuid
 *      AND is_active = true
 *      AND starts_at <= now()
 *      AND ends_at > now()
 *      AND (max_uses IS NULL OR current_uses < max_uses)
 *    RETURNING current_uses
 *
 * Zero rows returned means one of the gates fired — the promotion
 * is inactive, outside its date range, or its max_uses is exhausted.
 * Either way the redemption is rejected and no use is consumed.
 *
 * On a successful atomic increment the service emits
 * str.promotion.code_redeemed via the durable outbox with a
 * deterministic event_id keyed on (promotionId, current_uses_after)
 * so retries dedup cleanly.
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private toDto(row: PromotionRow): PromotionDto {
    return {
      id: row.id,
      storeId: row.store_id,
      name: row.name,
      description: row.description,
      discountType: row.discount_type as PromotionDiscountType,
      discountValue: Number(row.discount_value),
      minOrderAmount: row.min_order_amount === null ? null : Number(row.min_order_amount),
      promoCode: row.promo_code,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      maxUses: row.max_uses,
      currentUses: row.current_uses,
      isActive: row.is_active,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async assertStoreInTenant(tx: unknown, storeId: string, schoolId: string): Promise<void> {
    const client = tx as {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    };
    const rows = (await client.$queryRawUnsafe(
      `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
      storeId,
      schoolId,
    )) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException(`storeId does not match a store in this school`);
    }
  }

  async list(
    actor: ResolvedActor,
    storeId?: string,
    includeInactive?: boolean,
  ): Promise<PromotionDto[]> {
    await assertStoreReader(actor, this.permCheck, 'Promotion list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (storeId) {
        args.push(storeId);
        where += ` AND p.store_id = $${args.length}::uuid`;
      }
      if (!includeInactive) {
        where += ` AND p.is_active = true`;
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.store_id::text AS store_id, p.name,
                p.description, p.discount_type, p.discount_value,
                p.min_order_amount, p.promo_code,
                p.starts_at::text AS starts_at,
                p.ends_at::text AS ends_at,
                p.max_uses, p.current_uses, p.is_active,
                p.created_by::text AS created_by,
                p.created_at::text AS created_at,
                p.updated_at::text AS updated_at
           FROM str_promotions p
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid${where}
          ORDER BY p.starts_at DESC`,
        ...args,
      )) as PromotionRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<PromotionDetailDto> {
    await assertStoreReader(actor, this.permCheck, 'Promotion read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.store_id::text AS store_id, p.name,
                p.description, p.discount_type, p.discount_value,
                p.min_order_amount, p.promo_code,
                p.starts_at::text AS starts_at,
                p.ends_at::text AS ends_at,
                p.max_uses, p.current_uses, p.is_active,
                p.created_by::text AS created_by,
                p.created_at::text AS created_at,
                p.updated_at::text AS updated_at
           FROM str_promotions p
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid AND p.id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as PromotionRow[];
      if (rows.length === 0) throw new NotFoundException('Promotion not found');
      const head = this.toDto(rows[0]!);
      const products = (await client.$queryRawUnsafe(
        `SELECT product_id::text AS product_id
           FROM str_promotion_products
          WHERE promotion_id = $1::uuid
          ORDER BY created_at`,
        id,
      )) as Array<{ product_id: string }>;
      return { ...head, productIds: products.map((p) => p.product_id) };
    });
  }

  async create(actor: ResolvedActor, input: CreatePromotionDto): Promise<PromotionDetailDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Promotion create');
    const tenant = getCurrentTenant();
    if (input.discountType === 'PERCENTAGE' && input.discountValue > 100) {
      throw new BadRequestException('PERCENTAGE discount_value must be 0..100');
    }
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw new BadRequestException('endsAt must be strictly after startsAt');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.assertStoreInTenant(tx, input.storeId, tenant.schoolId);
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO str_promotions
             (id, store_id, name, description, discount_type, discount_value,
              min_order_amount, promo_code, starts_at, ends_at, max_uses, created_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::numeric, $7::numeric, $8,
                   $9::timestamptz, $10::timestamptz, $11::int, $12::uuid)
           RETURNING id::text AS id, store_id::text AS store_id, name,
                     description, discount_type, discount_value,
                     min_order_amount, promo_code,
                     starts_at::text AS starts_at,
                     ends_at::text AS ends_at,
                     max_uses, current_uses, is_active,
                     created_by::text AS created_by,
                     created_at::text AS created_at,
                     updated_at::text AS updated_at`,
          id,
          input.storeId,
          input.name,
          input.description ?? null,
          input.discountType,
          input.discountValue,
          input.minOrderAmount ?? null,
          input.promoCode ?? null,
          input.startsAt,
          input.endsAt,
          input.maxUses ?? null,
          actor.employeeId ?? null,
        )) as PromotionRow[];
        const head = this.toDto(rows[0]!);
        const productIds = input.productIds ?? [];
        if (productIds.length > 0) {
          // Validate every productId belongs to the same store.
          const valid = (await tx.$queryRawUnsafe(
            `SELECT id::text AS id FROM str_products
              WHERE store_id = $1::uuid AND id = ANY($2::uuid[])`,
            input.storeId,
            productIds,
          )) as Array<{ id: string }>;
          if (valid.length !== productIds.length) {
            throw new BadRequestException(
              'productIds contains one or more products that do not belong to this store',
            );
          }
          for (const productId of productIds) {
            await tx.$executeRawUnsafe(
              `INSERT INTO str_promotion_products (id, promotion_id, product_id)
               VALUES ($1::uuid, $2::uuid, $3::uuid)`,
              generateId(),
              id,
              productId,
            );
          }
        }
        return { ...head, productIds };
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A promotion with promo_code "${input.promoCode}" already exists for this store`,
          );
        }
        throw err;
      }
    });
  }

  async patch(actor: ResolvedActor, id: string, input: UpdatePromotionDto): Promise<PromotionDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Promotion patch');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT p.id::text AS id, p.discount_type, p.starts_at::text AS starts_at,
                p.ends_at::text AS ends_at
           FROM str_promotions p
           JOIN str_stores s ON s.id = p.store_id
          WHERE s.school_id = $1::uuid AND p.id = $2::uuid
          FOR UPDATE OF p`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; discount_type: string; starts_at: string; ends_at: string }>;
      if (existing.length === 0) throw new NotFoundException('Promotion not found');
      const row = existing[0]!;
      const sets: string[] = [];
      const args: unknown[] = [];
      let i = 1;
      if (input.name !== undefined) {
        sets.push(`name = $${i++}`);
        args.push(input.name);
      }
      if (input.description !== undefined) {
        sets.push(`description = $${i++}`);
        args.push(input.description);
      }
      if (input.discountValue !== undefined) {
        if (row.discount_type === 'PERCENTAGE' && input.discountValue > 100) {
          throw new BadRequestException('PERCENTAGE discount_value must be 0..100');
        }
        sets.push(`discount_value = $${i++}::numeric`);
        args.push(input.discountValue);
      }
      if (input.minOrderAmount !== undefined) {
        sets.push(`min_order_amount = $${i++}::numeric`);
        args.push(input.minOrderAmount);
      }
      if (input.startsAt !== undefined || input.endsAt !== undefined) {
        const startsAt = input.startsAt ?? row.starts_at;
        const endsAt = input.endsAt ?? row.ends_at;
        if (new Date(endsAt) <= new Date(startsAt)) {
          throw new BadRequestException('endsAt must be strictly after startsAt');
        }
        if (input.startsAt !== undefined) {
          sets.push(`starts_at = $${i++}::timestamptz`);
          args.push(input.startsAt);
        }
        if (input.endsAt !== undefined) {
          sets.push(`ends_at = $${i++}::timestamptz`);
          args.push(input.endsAt);
        }
      }
      if (input.maxUses !== undefined) {
        sets.push(`max_uses = $${i++}::int`);
        args.push(input.maxUses);
      }
      if (input.isActive !== undefined) {
        sets.push(`is_active = $${i++}`);
        args.push(input.isActive);
      }
      if (sets.length === 0) {
        const reread = await this.getById(actor, id);
        return reread;
      }
      sets.push(`updated_at = now()`);
      // REVIEW-P2C29 Round 1 BLOCKING 3: carry the school predicate
      // into the UPDATE statement itself, not just into the
      // pre-lock SELECT. The Phase 2 standard requires that every
      // tenant mutation joins back to the school via the owning
      // parent so a single grep catches the contract.
      args.push(id, tenant.schoolId);
      const idArg = i++;
      const schoolArg = i;
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE str_promotions p
            SET ${sets.join(', ')}
           FROM str_stores s
          WHERE s.id = p.store_id
            AND p.id = $${idArg}::uuid
            AND s.school_id = $${schoolArg}::uuid
          RETURNING p.id::text AS id, p.store_id::text AS store_id, p.name,
                    p.description, p.discount_type, p.discount_value,
                    p.min_order_amount, p.promo_code,
                    p.starts_at::text AS starts_at,
                    p.ends_at::text AS ends_at,
                    p.max_uses, p.current_uses, p.is_active,
                    p.created_by::text AS created_by,
                    p.created_at::text AS created_at,
                    p.updated_at::text AS updated_at`,
        ...args,
      )) as PromotionRow[];
      return this.toDto(rows[0]!);
    });
  }

  /**
   * KEYSTONE — atomic promo code application.
   *
   * Runs a single UPDATE that bundles every validation gate into
   * the WHERE clause: active flag, date window, max_uses cap. Zero
   * rows returned means one of the gates fired — the redemption is
   * rejected with a friendly 409 and NO use is consumed. On success
   * RETURNING gives the post-increment current_uses, which keys the
   * deterministic outbox event id so retries dedup cleanly.
   *
   * The actor is intentionally NOT a store admin gate — this is the
   * customer-facing checkout path; any authenticated store user can
   * apply a promo code. Customer affiliation with the order is the
   * caller's concern (the future Cycle 28 OrderService consumer).
   */
  async applyPromoCode(actor: ResolvedActor, input: ApplyPromoCodeDto): Promise<PromotionDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Apply promo code');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.assertStoreInTenant(tx, input.storeId, tenant.schoolId);
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE str_promotions
            SET current_uses = current_uses + 1,
                updated_at = now()
          WHERE store_id = $1::uuid
            AND promo_code = $2
            AND is_active = true
            AND starts_at <= now()
            AND ends_at > now()
            AND (max_uses IS NULL OR current_uses < max_uses)
          RETURNING id::text AS id, store_id::text AS store_id, name,
                    description, discount_type, discount_value,
                    min_order_amount, promo_code,
                    starts_at::text AS starts_at,
                    ends_at::text AS ends_at,
                    max_uses, current_uses, is_active,
                    created_by::text AS created_by,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        input.storeId,
        input.promoCode,
      )) as PromotionRow[];
      if (rows.length === 0) {
        // Look up the row to discriminate the failure mode for the
        // operator log. We do NOT surface this detail to the caller —
        // a generic 409 is the user-facing message.
        throw new ConflictException(
          'Promo code is invalid, inactive, outside its date range, or fully redeemed',
        );
      }
      const dto = this.toDto(rows[0]!);
      // Durable emit with deterministic event id keyed on
      // (promotionId, current_uses_after) so each successful
      // redemption is a fresh envelope.
      await this.outbox.enqueueInTx(tx, {
        topic: 'str.promotion.code_redeemed',
        payload: {
          promotionId: dto.id,
          storeId: dto.storeId,
          schoolId: tenant.schoolId,
          promoCode: dto.promoCode,
          discountType: dto.discountType,
          discountValue: dto.discountValue,
          currentUses: dto.currentUses,
          maxUses: dto.maxUses,
          customerAccountId: actor.accountId,
          sourceRefId: dto.id,
        },
        sourceModule: 'commerce',
        eventId: deterministicPromotionRedeemedEventId(dto.id, dto.currentUses),
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
        key: dto.id,
      });
      return dto;
    });
  }
}
