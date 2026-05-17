import {
  BadRequestException,
  ConflictException,
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  assertCustomerAffiliatedWithSchool,
  assertStoreAdmin,
  assertStoreCustomer,
  isUniqueViolation,
} from '../orders/access-advanced';
import type {
  AdjustLoyaltyPointsDto,
  EarnLoyaltyPointsDto,
  LoyaltyBalanceDto,
  LoyaltyConfigDto,
  LoyaltyTransactionDto,
  LoyaltyTransactionType,
  RedeemLoyaltyPointsDto,
  UpsertLoyaltyConfigDto,
} from '../orders/dto/commerce-store.dto';

interface ConfigRow {
  id: string;
  store_id: string;
  points_per_dollar: number;
  redemption_rate_cents: number;
  min_redemption_points: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface TransactionRow {
  id: string;
  store_id: string;
  customer_person_id: string;
  transaction_type: string;
  points: number;
  order_id: string | null;
  description: string | null;
  created_at: string;
}

/**
 * P2-29b — LoyaltyService.
 *
 * Per-store loyalty programme. Configuration (points_per_dollar,
 * redemption_rate_cents, min_redemption_points, is_enabled) lives
 * in str_loyalty_config. Transactions are append-only rows on
 * str_loyalty_transactions; the customer's balance is computed
 * fresh on every read as
 *
 *   balance = SUM(points WHERE type IN (EARNED, ADJUSTMENT))
 *           - SUM(points WHERE type = REDEEMED)
 *
 * with no denormalisation, so the ledger is the canonical source
 * of truth.
 *
 * Redemption is atomic: the service locks the customer's
 * transaction history with FOR UPDATE inside the same tenant tx
 * as the insert, re-computes the balance under the lock, validates
 * (>= min_redemption_points AND >= requested points), then writes
 * the REDEEMED row. Concurrent redemptions serialise on the lock
 * so a customer cannot drain their balance twice.
 */
@Injectable()
export class LoyaltyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private configToDto(row: ConfigRow): LoyaltyConfigDto {
    return {
      id: row.id,
      storeId: row.store_id,
      pointsPerDollar: row.points_per_dollar,
      redemptionRateCents: row.redemption_rate_cents,
      minRedemptionPoints: row.min_redemption_points,
      isEnabled: row.is_enabled,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private txToDto(row: TransactionRow): LoyaltyTransactionDto {
    return {
      id: row.id,
      storeId: row.store_id,
      customerPersonId: row.customer_person_id,
      transactionType: row.transaction_type as LoyaltyTransactionType,
      points: row.points,
      orderId: row.order_id,
      description: row.description,
      createdAt: row.created_at,
    };
  }

  private async loadConfigInTx(tx: unknown, storeId: string, schoolId: string): Promise<ConfigRow> {
    const client = tx as {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    };
    const rows = (await client.$queryRawUnsafe(
      `SELECT c.id::text AS id, c.store_id::text AS store_id,
              c.points_per_dollar, c.redemption_rate_cents,
              c.min_redemption_points, c.is_enabled,
              c.created_at::text AS created_at,
              c.updated_at::text AS updated_at
         FROM str_loyalty_config c
         JOIN str_stores s ON s.id = c.store_id
        WHERE c.store_id = $1::uuid AND s.school_id = $2::uuid`,
      storeId,
      schoolId,
    )) as ConfigRow[];
    if (rows.length === 0) {
      throw new NotFoundException(
        `No loyalty config for this store. Admin must call PUT /commerce/loyalty/config first.`,
      );
    }
    return rows[0]!;
  }

  async getConfig(actor: ResolvedActor, storeId: string): Promise<LoyaltyConfigDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Loyalty config read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.store_id::text AS store_id,
                c.points_per_dollar, c.redemption_rate_cents,
                c.min_redemption_points, c.is_enabled,
                c.created_at::text AS created_at,
                c.updated_at::text AS updated_at
           FROM str_loyalty_config c
           JOIN str_stores s ON s.id = c.store_id
          WHERE c.store_id = $1::uuid AND s.school_id = $2::uuid`,
        storeId,
        tenant.schoolId,
      )) as ConfigRow[];
      if (rows.length === 0) throw new NotFoundException('Loyalty config not found');
      return this.configToDto(rows[0]!);
    });
  }

  async upsertConfig(
    actor: ResolvedActor,
    input: UpsertLoyaltyConfigDto,
  ): Promise<LoyaltyConfigDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Loyalty config write');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const storeRows = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
        input.storeId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO str_loyalty_config
             (id, store_id, points_per_dollar, redemption_rate_cents,
              min_redemption_points, is_enabled)
           VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5::int, $6)
           ON CONFLICT (store_id) DO UPDATE
             SET points_per_dollar = EXCLUDED.points_per_dollar,
                 redemption_rate_cents = EXCLUDED.redemption_rate_cents,
                 min_redemption_points = EXCLUDED.min_redemption_points,
                 is_enabled = EXCLUDED.is_enabled,
                 updated_at = now()
           RETURNING id::text AS id, store_id::text AS store_id,
                     points_per_dollar, redemption_rate_cents,
                     min_redemption_points, is_enabled,
                     created_at::text AS created_at,
                     updated_at::text AS updated_at`,
          id,
          input.storeId,
          input.pointsPerDollar,
          input.redemptionRateCents,
          input.minRedemptionPoints,
          input.isEnabled,
        )) as ConfigRow[];
        return this.configToDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('Loyalty config already exists for this store');
        }
        throw err;
      }
    });
  }

  /** Aggregate balance for (store, customer). */
  async getBalance(
    actor: ResolvedActor,
    storeId: string,
    customerPersonId: string,
  ): Promise<LoyaltyBalanceDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Loyalty balance');
    const tenant = getCurrentTenant();
    // Customers may only read their own balance; admins read all.
    if (!actor.isSchoolAdmin && actor.personId !== customerPersonId) {
      const isAdmin = await this.permCheck.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['str-001:admin', 'str-001:write'],
      );
      if (!isAdmin) {
        throw new ForbiddenException('Customers may only read their own loyalty balance');
      }
    }
    // REVIEW-P2C29 Round 1 BLOCKING 1: validate the customerPersonId
    // is affiliated with the current school. School A admin reading
    // a School B person's balance is refused with a 400.
    await assertCustomerAffiliatedWithSchool(this.tenantPrisma, customerPersonId);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Verify store in tenant.
      const storeRows = (await client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
        storeId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           COALESCE(SUM(CASE WHEN transaction_type = 'EARNED' THEN points ELSE 0 END), 0)::int AS earned,
           COALESCE(SUM(CASE WHEN transaction_type = 'REDEEMED' THEN points ELSE 0 END), 0)::int AS redeemed,
           COALESCE(SUM(CASE WHEN transaction_type = 'ADJUSTMENT' THEN points ELSE 0 END), 0)::int AS adjusted
         FROM str_loyalty_transactions
        WHERE store_id = $1::uuid
          AND customer_person_id = $2::uuid`,
        storeId,
        customerPersonId,
      )) as Array<{ earned: number; redeemed: number; adjusted: number }>;
      const r = rows[0]!;
      return {
        storeId,
        customerPersonId,
        balance: r.earned + r.adjusted - r.redeemed,
        totalEarned: r.earned,
        totalRedeemed: r.redeemed,
        totalAdjusted: r.adjusted,
      };
    });
  }

  async listTransactions(
    actor: ResolvedActor,
    storeId: string,
    customerPersonId: string,
    limit?: number,
  ): Promise<LoyaltyTransactionDto[]> {
    await assertStoreCustomer(actor, this.permCheck, 'Loyalty transaction list');
    const tenant = getCurrentTenant();
    if (!actor.isSchoolAdmin && actor.personId !== customerPersonId) {
      const isAdmin = await this.permCheck.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['str-001:admin', 'str-001:write'],
      );
      if (!isAdmin) {
        throw new ForbiddenException('Customers may only read their own loyalty history');
      }
    }
    // REVIEW-P2C29 Round 1 BLOCKING 1: validate the customerPersonId
    // is affiliated with the current school before reading history.
    await assertCustomerAffiliatedWithSchool(this.tenantPrisma, customerPersonId);
    const cap = limit && limit > 0 && limit <= 500 ? limit : 100;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT t.id::text AS id, t.store_id::text AS store_id,
                t.customer_person_id::text AS customer_person_id,
                t.transaction_type, t.points,
                t.order_id::text AS order_id, t.description,
                t.created_at::text AS created_at
           FROM str_loyalty_transactions t
           JOIN str_stores s ON s.id = t.store_id
          WHERE s.school_id = $1::uuid
            AND t.store_id = $2::uuid
            AND t.customer_person_id = $3::uuid
          ORDER BY t.created_at DESC
          LIMIT $4::int`,
        tenant.schoolId,
        storeId,
        customerPersonId,
        cap,
      )) as TransactionRow[];
      return rows.map((r) => this.txToDto(r));
    });
  }

  /** Admin or system path — log points earned on a purchase. */
  async earn(actor: ResolvedActor, input: EarnLoyaltyPointsDto): Promise<LoyaltyTransactionDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Loyalty earn');
    // REVIEW-P2C29 Round 1 BLOCKING 1: a store admin in school A can
    // no longer log earned points for a person in school B by guessing
    // an iam_person UUID — the helper validates affiliation.
    await assertCustomerAffiliatedWithSchool(this.tenantPrisma, input.customerPersonId);
    return this.insertTransaction(input.storeId, input.customerPersonId, 'EARNED', input.points, {
      orderId: input.orderId ?? null,
      description: input.description ?? null,
      createdBy: actor.employeeId,
    });
  }

  /**
   * KEYSTONE — atomic redemption.
   *
   * Locks the customer's transaction history with FOR UPDATE on the
   * full row set inside the same tenant tx as the REDEEMED insert.
   * Re-computes the balance under the lock and refuses if either
   *   balance < points  OR  points < min_redemption_points  OR
   *   config.is_enabled = false.
   *
   * The schema-side str_lt_points_chk CHECK rejects zero/negative
   * point rows as the belt-and-braces.
   */
  async redeem(
    actor: ResolvedActor,
    input: RedeemLoyaltyPointsDto,
  ): Promise<LoyaltyTransactionDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Loyalty redeem');
    const tenant = getCurrentTenant();
    if (!actor.isSchoolAdmin && actor.personId !== input.customerPersonId) {
      const isAdmin = await this.permCheck.hasAnyPermissionInTenant(
        actor.accountId,
        tenant.schoolId,
        ['str-001:admin', 'str-001:write'],
      );
      if (!isAdmin) {
        throw new ForbiddenException('Customers may only redeem their own loyalty points');
      }
    }
    // REVIEW-P2C29 Round 1 BLOCKING 1: validate the customerPersonId
    // is affiliated with the current school. A customer who somehow
    // reaches str-002:read in a different school's tenant can no
    // longer redeem against their own iam_person in this tenant.
    await assertCustomerAffiliatedWithSchool(this.tenantPrisma, input.customerPersonId);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const config = await this.loadConfigInTx(tx, input.storeId, tenant.schoolId);
      if (!config.is_enabled) {
        throw new BadRequestException('Loyalty programme is not enabled for this store');
      }
      if (input.points < config.min_redemption_points) {
        throw new BadRequestException(
          `Minimum redemption is ${config.min_redemption_points} points (requested ${input.points})`,
        );
      }
      // REVIEW-P2C29 hardening — lock every transaction row for this
      // (store, customer) tuple so concurrent redemptions serialise,
      // then aggregate the balance via Postgres SUM under the lock
      // via a CTE wrapper. This replaces the prior in-memory loop
      // over an unbounded row set, which CodeQL flagged under
      // js/loop-bound-injection. The aggregation runs server-side so
      // even a customer with thousands of historical transactions
      // returns one row from the DB, and the FOR UPDATE in the CTE
      // still locks every contributing row to keep concurrent
      // redemptions serialised on the customer's ledger.
      const aggRows = (await tx.$queryRawUnsafe(
        `WITH locked AS (
           SELECT transaction_type, points
             FROM str_loyalty_transactions
            WHERE store_id = $1::uuid AND customer_person_id = $2::uuid
            FOR UPDATE
         )
         SELECT
           COALESCE(SUM(CASE WHEN transaction_type = 'EARNED' THEN points ELSE 0 END), 0)::int AS earned,
           COALESCE(SUM(CASE WHEN transaction_type = 'REDEEMED' THEN points ELSE 0 END), 0)::int AS redeemed,
           COALESCE(SUM(CASE WHEN transaction_type = 'ADJUSTMENT' THEN points ELSE 0 END), 0)::int AS adjusted
         FROM locked`,
        input.storeId,
        input.customerPersonId,
      )) as Array<{ earned: number; redeemed: number; adjusted: number }>;
      const agg = aggRows[0] ?? { earned: 0, redeemed: 0, adjusted: 0 };
      const balance = Number(agg.earned) + Number(agg.adjusted) - Number(agg.redeemed);
      if (balance < input.points) {
        throw new BadRequestException(
          `Insufficient loyalty balance (have ${balance}, need ${input.points})`,
        );
      }
      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_loyalty_transactions
           (id, store_id, customer_person_id, transaction_type, points,
            order_id, description, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'REDEEMED', $4::int,
                 $5::uuid, $6, $7::uuid)
         RETURNING id::text AS id, store_id::text AS store_id,
                   customer_person_id::text AS customer_person_id,
                   transaction_type, points,
                   order_id::text AS order_id, description,
                   created_at::text AS created_at`,
        id,
        input.storeId,
        input.customerPersonId,
        input.points,
        input.orderId ?? null,
        input.description ?? null,
        actor.employeeId ?? null,
      )) as TransactionRow[];
      return this.txToDto(rows[0]!);
    });
  }

  /** Admin-only — manual adjustment (correction). */
  async adjust(
    actor: ResolvedActor,
    input: AdjustLoyaltyPointsDto,
  ): Promise<LoyaltyTransactionDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Loyalty adjust');
    // REVIEW-P2C29 Round 1 BLOCKING 1: admin in school A can no
    // longer adjust loyalty points for a person in school B.
    await assertCustomerAffiliatedWithSchool(this.tenantPrisma, input.customerPersonId);
    return this.insertTransaction(
      input.storeId,
      input.customerPersonId,
      'ADJUSTMENT',
      input.points,
      {
        orderId: null,
        description: input.description,
        createdBy: actor.employeeId,
      },
    );
  }

  private async insertTransaction(
    storeId: string,
    customerPersonId: string,
    type: LoyaltyTransactionType,
    points: number,
    opts: { orderId: string | null; description: string | null; createdBy: string | null },
  ): Promise<LoyaltyTransactionDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const storeRows = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
        storeId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_loyalty_transactions
           (id, store_id, customer_person_id, transaction_type, points,
            order_id, description, created_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::int, $6::uuid, $7, $8::uuid)
         RETURNING id::text AS id, store_id::text AS store_id,
                   customer_person_id::text AS customer_person_id,
                   transaction_type, points,
                   order_id::text AS order_id, description,
                   created_at::text AS created_at`,
        id,
        storeId,
        customerPersonId,
        type,
        points,
        opts.orderId,
        opts.description,
        opts.createdBy,
      )) as TransactionRow[];
      return this.txToDto(rows[0]!);
    });
  }
}
