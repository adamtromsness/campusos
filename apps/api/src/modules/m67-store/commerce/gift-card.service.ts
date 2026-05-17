import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import {
  assertStoreAdmin,
  assertStoreCustomer,
  assertStoreReader,
  isUniqueViolation,
} from './access';
import { deterministicGiftCardDepletedEventId } from './event-ids';
import type {
  CancelGiftCardDto,
  GiftCardDetailDto,
  GiftCardDto,
  GiftCardStatus,
  GiftCardTransactionDto,
  GiftCardTransactionType,
  IssueGiftCardDto,
  RedeemGiftCardDto,
  TopUpGiftCardDto,
} from './dto/commerce-store.dto';

interface GiftCardRow {
  id: string;
  store_id: string;
  card_code: string;
  initial_balance_cents: number;
  current_balance_cents: number;
  purchased_by: string | null;
  recipient_email: string | null;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface GiftCardTxRow {
  id: string;
  card_id: string;
  transaction_type: string;
  amount_cents: number;
  order_id: string | null;
  performed_by: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * P2-29b — GiftCardService.
 *
 * Gift card issuance + redemption + top-up. The KEYSTONE is the
 * redeem path: a single UPDATE with the balance gate in the WHERE
 * clause:
 *
 *   UPDATE str_gift_cards
 *      SET current_balance_cents = current_balance_cents - $amount,
 *          status = CASE WHEN current_balance_cents - $amount = 0
 *                        THEN 'DEPLETED' ELSE status END,
 *          updated_at = now()
 *    WHERE card_code = $code
 *      AND status = 'ACTIVE'
 *      AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)
 *      AND current_balance_cents >= $amount
 *    RETURNING …
 *
 * Zero rows returned means one of the gates fired — insufficient
 * balance, expired, cancelled, or unknown card. The redemption is
 * rejected with a friendly 409 and the audit ledger row is NOT
 * written. The schema-side current_balance_cents >= 0 CHECK is the
 * belt-and-braces against any attempted negative-balance update.
 */
@Injectable()
export class GiftCardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private cardToDto(row: GiftCardRow): GiftCardDto {
    return {
      id: row.id,
      storeId: row.store_id,
      cardCode: row.card_code,
      initialBalanceCents: row.initial_balance_cents,
      currentBalanceCents: row.current_balance_cents,
      purchasedBy: row.purchased_by,
      recipientEmail: row.recipient_email,
      status: row.status as GiftCardStatus,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private txToDto(row: GiftCardTxRow): GiftCardTransactionDto {
    return {
      id: row.id,
      cardId: row.card_id,
      transactionType: row.transaction_type as GiftCardTransactionType,
      amountCents: row.amount_cents,
      orderId: row.order_id,
      performedBy: row.performed_by,
      notes: row.notes,
      createdAt: row.created_at,
    };
  }

  /**
   * 16-character upper-case alphanumeric card code excluding the
   * ambiguous characters I, O, 0, 1. Rejection set is small enough
   * that rejection sampling has near-zero impact.
   */
  private generateCardCode(): string {
    const allowed = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = randomBytes(20);
    let out = '';
    for (let i = 0; i < 16; i++) {
      out += allowed[buf[i]! % allowed.length];
    }
    return out;
  }

  async list(
    actor: ResolvedActor,
    storeId?: string,
    status?: GiftCardStatus,
  ): Promise<GiftCardDto[]> {
    await assertStoreReader(actor, this.permCheck, 'Gift card list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (storeId) {
        args.push(storeId);
        where += ` AND g.store_id = $${args.length}::uuid`;
      }
      if (status) {
        args.push(status);
        where += ` AND g.status = $${args.length}`;
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.store_id::text AS store_id, g.card_code,
                g.initial_balance_cents, g.current_balance_cents,
                g.purchased_by::text AS purchased_by, g.recipient_email,
                g.status, g.expires_at::text AS expires_at,
                g.created_at::text AS created_at,
                g.updated_at::text AS updated_at
           FROM str_gift_cards g
           JOIN str_stores s ON s.id = g.store_id
          WHERE s.school_id = $1::uuid${where}
          ORDER BY g.created_at DESC`,
        ...args,
      )) as GiftCardRow[];
      return rows.map((r) => this.cardToDto(r));
    });
  }

  async getByCode(actor: ResolvedActor, cardCode: string): Promise<GiftCardDetailDto> {
    await assertStoreCustomer(actor, this.permCheck, 'Gift card lookup');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const cardRows = (await client.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.store_id::text AS store_id, g.card_code,
                g.initial_balance_cents, g.current_balance_cents,
                g.purchased_by::text AS purchased_by, g.recipient_email,
                g.status, g.expires_at::text AS expires_at,
                g.created_at::text AS created_at,
                g.updated_at::text AS updated_at
           FROM str_gift_cards g
           JOIN str_stores s ON s.id = g.store_id
          WHERE s.school_id = $1::uuid AND g.card_code = $2`,
        tenant.schoolId,
        cardCode,
      )) as GiftCardRow[];
      if (cardRows.length === 0) throw new NotFoundException('Gift card not found');
      const head = this.cardToDto(cardRows[0]!);
      const txRows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, card_id::text AS card_id,
                transaction_type, amount_cents,
                order_id::text AS order_id,
                performed_by::text AS performed_by, notes,
                created_at::text AS created_at
           FROM str_gift_card_transactions
          WHERE card_id = $1::uuid
          ORDER BY created_at DESC`,
        head.id,
      )) as GiftCardTxRow[];
      return { ...head, transactions: txRows.map((r) => this.txToDto(r)) };
    });
  }

  async issue(actor: ResolvedActor, input: IssueGiftCardDto): Promise<GiftCardDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Gift card issue');
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
      // Generate card code with collision retry. Per the 32-character
      // alphabet and 16-character length the space is ~32^16 ≈ 1e24
      // so collisions are vanishingly rare, but UNIQUE catch is the
      // safety net.
      let attempts = 0;
      while (attempts < 5) {
        const id = generateId();
        const code = this.generateCardCode();
        try {
          const rows = (await tx.$queryRawUnsafe(
            `INSERT INTO str_gift_cards
               (id, store_id, card_code, initial_balance_cents,
                current_balance_cents, purchased_by, recipient_email, expires_at)
             VALUES ($1::uuid, $2::uuid, $3, $4::int, $4::int, $5::uuid, $6, $7::date)
             RETURNING id::text AS id, store_id::text AS store_id, card_code,
                       initial_balance_cents, current_balance_cents,
                       purchased_by::text AS purchased_by, recipient_email,
                       status, expires_at::text AS expires_at,
                       created_at::text AS created_at,
                       updated_at::text AS updated_at`,
            id,
            input.storeId,
            code,
            input.initialBalanceCents,
            input.purchasedBy ?? null,
            input.recipientEmail ?? null,
            input.expiresAt ?? null,
          )) as GiftCardRow[];
          const card = this.cardToDto(rows[0]!);
          // Log the PURCHASE ledger row inside same tx.
          await tx.$executeRawUnsafe(
            `INSERT INTO str_gift_card_transactions
               (id, card_id, transaction_type, amount_cents, performed_by, notes)
             VALUES ($1::uuid, $2::uuid, 'PURCHASE', $3::int, $4::uuid, $5)`,
            generateId(),
            card.id,
            input.initialBalanceCents,
            actor.employeeId ?? null,
            'Gift card issued',
          );
          return card;
        } catch (err) {
          if (isUniqueViolation(err)) {
            attempts++;
            continue;
          }
          throw err;
        }
      }
      throw new ConflictException('Could not generate a unique card code after 5 attempts');
    });
  }

  /**
   * KEYSTONE — atomic redemption.
   *
   * Single UPDATE with all gates in the WHERE — balance >= amount,
   * status = ACTIVE, not expired. Zero rows returned means one of
   * the gates fired and the redemption is rejected with no ledger
   * row written.
   *
   * On a successful redemption that drives the balance to zero the
   * status flips to DEPLETED in the same UPDATE (CASE expression)
   * and a str.gift_card.depleted outbox event is enqueued so the
   * downstream notification consumer can let the customer know.
   */
  async redeem(
    actor: ResolvedActor,
    input: RedeemGiftCardDto,
  ): Promise<{ card: GiftCardDto; transaction: GiftCardTransactionDto }> {
    await assertStoreCustomer(actor, this.permCheck, 'Gift card redeem');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Single atomic UPDATE with all gates in WHERE.
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE str_gift_cards g
            SET current_balance_cents = g.current_balance_cents - $1::int,
                status = CASE
                  WHEN g.current_balance_cents - $1::int = 0 THEN 'DEPLETED'
                  ELSE g.status
                END,
                updated_at = now()
           FROM str_stores s
          WHERE g.store_id = s.id
            AND s.school_id = $2::uuid
            AND g.card_code = $3
            AND g.status = 'ACTIVE'
            AND (g.expires_at IS NULL OR g.expires_at >= CURRENT_DATE)
            AND g.current_balance_cents >= $1::int
          RETURNING g.id::text AS id, g.store_id::text AS store_id, g.card_code,
                    g.initial_balance_cents, g.current_balance_cents,
                    g.purchased_by::text AS purchased_by, g.recipient_email,
                    g.status, g.expires_at::text AS expires_at,
                    g.created_at::text AS created_at,
                    g.updated_at::text AS updated_at`,
        input.amountCents,
        tenant.schoolId,
        input.cardCode,
      )) as GiftCardRow[];
      if (rows.length === 0) {
        throw new ConflictException(
          'Gift card cannot be redeemed: insufficient balance, expired, cancelled, or unknown card code',
        );
      }
      const card = this.cardToDto(rows[0]!);
      // Audit ledger row in same tx.
      const txId = generateId();
      const txRows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_gift_card_transactions
           (id, card_id, transaction_type, amount_cents, order_id, performed_by, notes)
         VALUES ($1::uuid, $2::uuid, 'REDEMPTION', $3::int, $4::uuid, $5::uuid, $6)
         RETURNING id::text AS id, card_id::text AS card_id,
                   transaction_type, amount_cents,
                   order_id::text AS order_id,
                   performed_by::text AS performed_by, notes,
                   created_at::text AS created_at`,
        txId,
        card.id,
        input.amountCents,
        input.orderId ?? null,
        actor.employeeId ?? null,
        input.notes ?? null,
      )) as GiftCardTxRow[];

      // Durable depleted event if the balance hit zero in this redemption.
      if (card.status === 'DEPLETED') {
        await this.outbox.enqueueInTx(tx, {
          topic: 'str.gift_card.depleted',
          payload: {
            giftCardId: card.id,
            storeId: card.storeId,
            schoolId: tenant.schoolId,
            cardCode: card.cardCode,
            initialBalanceCents: card.initialBalanceCents,
            finalRedemptionCents: input.amountCents,
            recipientEmail: card.recipientEmail,
            depletedAt: card.updatedAt,
            sourceRefId: card.id,
          },
          sourceModule: 'commerce',
          eventId: deterministicGiftCardDepletedEventId(card.id),
          tenantId: tenant.schoolId,
          tenantSubdomain: tenant.subdomain,
          key: card.id,
        });
      }

      return { card, transaction: this.txToDto(txRows[0]!) };
    });
  }

  async topUp(
    actor: ResolvedActor,
    id: string,
    input: TopUpGiftCardDto,
  ): Promise<{ card: GiftCardDto; transaction: GiftCardTransactionDto }> {
    await assertStoreAdmin(actor, this.permCheck, 'Gift card top-up');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the card. Cannot top up CANCELLED — once cancelled the
      // card is closed. A DEPLETED card can be topped back to ACTIVE.
      const cardRows = (await tx.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.status, g.initial_balance_cents, g.current_balance_cents
           FROM str_gift_cards g
           JOIN str_stores s ON s.id = g.store_id
          WHERE g.id = $1::uuid AND s.school_id = $2::uuid
          FOR UPDATE OF g`,
        id,
        tenant.schoolId,
      )) as Array<{
        id: string;
        status: string;
        initial_balance_cents: number;
        current_balance_cents: number;
      }>;
      if (cardRows.length === 0) throw new NotFoundException('Gift card not found');
      const row = cardRows[0]!;
      if (row.status === 'CANCELLED') {
        throw new BadRequestException('CANCELLED gift cards cannot be topped up');
      }
      const updated = (await tx.$queryRawUnsafe(
        `UPDATE str_gift_cards
            SET current_balance_cents = current_balance_cents + $1::int,
                status = CASE
                  WHEN status = 'DEPLETED' AND current_balance_cents + $1::int > 0 THEN 'ACTIVE'
                  ELSE status
                END,
                updated_at = now()
          WHERE id = $2::uuid
          RETURNING id::text AS id, store_id::text AS store_id, card_code,
                    initial_balance_cents, current_balance_cents,
                    purchased_by::text AS purchased_by, recipient_email,
                    status, expires_at::text AS expires_at,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        input.amountCents,
        id,
      )) as GiftCardRow[];
      const card = this.cardToDto(updated[0]!);
      const txId = generateId();
      const txRows = (await tx.$queryRawUnsafe(
        `INSERT INTO str_gift_card_transactions
           (id, card_id, transaction_type, amount_cents, performed_by, notes)
         VALUES ($1::uuid, $2::uuid, 'TOP_UP', $3::int, $4::uuid, $5)
         RETURNING id::text AS id, card_id::text AS card_id,
                   transaction_type, amount_cents,
                   order_id::text AS order_id,
                   performed_by::text AS performed_by, notes,
                   created_at::text AS created_at`,
        txId,
        id,
        input.amountCents,
        actor.employeeId ?? null,
        input.notes ?? null,
      )) as GiftCardTxRow[];
      return { card, transaction: this.txToDto(txRows[0]!) };
    });
  }

  async cancel(actor: ResolvedActor, id: string, input: CancelGiftCardDto): Promise<GiftCardDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Gift card cancel');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT g.id::text AS id, g.status
           FROM str_gift_cards g
           JOIN str_stores s ON s.id = g.store_id
          WHERE g.id = $1::uuid AND s.school_id = $2::uuid
          FOR UPDATE OF g`,
        id,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (existing.length === 0) throw new NotFoundException('Gift card not found');
      if (existing[0]!.status === 'CANCELLED') {
        throw new BadRequestException('Gift card is already CANCELLED');
      }
      // No ledger row on cancel — the schema requires amount_cents > 0
      // on gift_card_transactions so a zero-value cancel cannot land.
      // The head row's status flip + updated_at is the audit; the
      // reason is captured by the request log + caller-side notes.
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE str_gift_cards
            SET status = 'CANCELLED', updated_at = now()
          WHERE id = $1::uuid
          RETURNING id::text AS id, store_id::text AS store_id, card_code,
                    initial_balance_cents, current_balance_cents,
                    purchased_by::text AS purchased_by, recipient_email,
                    status, expires_at::text AS expires_at,
                    created_at::text AS created_at,
                    updated_at::text AS updated_at`,
        id,
      )) as GiftCardRow[];
      // Cancel reason is captured in the operator log for audit; the
      // dto suppresses it on the response. Suppress unused-arg warning.
      void input.reason;
      return this.cardToDto(rows[0]!);
    });
  }
}
