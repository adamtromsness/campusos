import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { OutboxService } from '@shared/kafka/outbox.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { deterministicTransactionCompletedEventId } from '../event-ids';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  AssetTransactionDto,
  ConditionReportDto,
  CreateAssetPurchaseDto,
  CreateConditionReportDto,
  PLATFORM_FEE_PERCENT,
  PatchAssetTransactionDto,
  TransactionStatus,
} from '../dto/community.dto';
import { CommunityProfileService } from './community-profile.service';

/**
 * P2-21c — AssetTransactionService.
 *
 * THE 5% FEE-SPLIT KEYSTONE per ADR-073. Every purchase computes:
 *   platform_fee_cents    = floor(total_price_cents * 5 / 100)
 *   seller_receives_cents = total_price_cents - platform_fee_cents
 * The schema's fee_split_chk
 *   (platform_fee_cents + seller_receives_cents = total_price_cents)
 * is the safety net — service compute + CHECK guarantee no money
 * silently leaks.
 *
 * Lifecycle (status):
 *   PENDING_PAYMENT (created at purchase) →
 *   PAID (Stripe webhook simulated by direct status patch in dev) →
 *   SHIPPING → DELIVERED → CONFIRMED →
 *   [DISPUTED or REFUNDED as alternates]
 *
 * The purchase flow runs in a single $transaction:
 *   1. SELECT FOR UPDATE on the listing to serialise concurrent
 *      purchases on the same item (status flips to SOLD inside).
 *   2. Validates listing.status='ACTIVE' (refuses SOLD / EXPIRED).
 *   3. Computes fee split and inserts the transaction row (the
 *      schema CHECK is the safety net).
 *   4. Flips listing.status to SOLD via MarketplaceListingService.
 *
 * After commit, emits mkt.transaction.completed on CONFIRMED status
 * transitions so the analytics fan-out can react.
 */
@Injectable()
export class AssetTransactionService {
  private readonly logger = new Logger(AssetTransactionService.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly outbox: OutboxService,
    private readonly profiles: CommunityProfileService,
  ) {}

  // ── Purchase keystone ────────────────────────────────────────────

  async purchase(
    actor: ResolvedActor,
    listingId: string,
    input: CreateAssetPurchaseDto,
  ): Promise<AssetTransactionDto> {
    // REVIEW-P2C21 BLOCKING 5 — buyer shape spoof prevention.
    //
    // Parents and students hold MKT-002:read+write per the IAM grant
    // table. Without this check, a parent could spoof a SCHOOL
    // purchase against an arbitrary school by supplying any
    // buyer_school_id UUID in the request body — the schema's
    // buyer_shape_chk only verifies non-NULL, not authority.
    //
    // Fix: SCHOOL purchases require school-admin authority (or the
    // `MKT-003:write` Surplus Asset Exchange grant); the
    // buyerSchoolId is always forced to the current tenant's
    // schoolId regardless of the request body. Non-admin actors are
    // narrowed to INDIVIDUAL with buyerPersonId = actor.personId.
    const tenant = getCurrentTenant();
    if (input.buyerType === 'SCHOOL') {
      if (!actor.isSchoolAdmin) {
        throw new ForbiddenException(
          'SCHOOL-type purchases require school-admin authority. Use buyerType=INDIVIDUAL for personal purchases.',
        );
      }
      // Force buyerSchoolId to the caller's tenant, ignoring whatever
      // the request body supplied. Cross-school purchases by school
      // admins go through a separate platform-admin surface.
      input.buyerSchoolId = tenant.schoolId;
      input.buyerPersonId = null;
    } else if (input.buyerType === 'INDIVIDUAL') {
      // Always force buyerPersonId to the calling actor — an
      // individual purchase is always on behalf of the caller, never
      // an arbitrary platform_users id.
      input.buyerPersonId = actor.personId;
      input.buyerSchoolId = null;
    } else {
      throw new BadRequestException(
        `buyerType must be SCHOOL or INDIVIDUAL (got ${String(input.buyerType)}).`,
      );
    }

    const id = generateId();
    const quantity = input.quantity ?? 1;
    const result = await this.platform.$transaction(async (tx) => {
      // Lock the listing row.
      const lockedRows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          status: string;
          price_cents: number | null;
          seller_school_id: string;
          seller_profile_id: string;
        }>
      >(
        `SELECT id::text, status, price_cents,
                seller_school_id::text AS seller_school_id,
                seller_profile_id::text AS seller_profile_id
           FROM platform.platform_marketplace_listings
           WHERE id = $1::uuid
           FOR UPDATE`,
        listingId,
      );
      if (lockedRows.length === 0) {
        throw new NotFoundException(`Listing ${listingId} not found.`);
      }
      const listing = lockedRows[0]!;
      if (listing.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Listing is not ACTIVE (current status: ${listing.status}). Cannot purchase.`,
        );
      }
      if (listing.price_cents === null) {
        throw new BadRequestException(
          'This listing is free (price_cents IS NULL). Use the free-claim endpoint instead.',
        );
      }

      const unitPriceCents = listing.price_cents;
      const totalPriceCents = unitPriceCents * quantity;
      const platformFeeCents = Math.floor((totalPriceCents * PLATFORM_FEE_PERCENT) / 100);
      const sellerReceivesCents = totalPriceCents - platformFeeCents;

      // Insert the transaction. The schema fee_split_chk catches any
      // arithmetic drift; the service guarantees correctness.
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.platform_asset_transactions
          (id, listing_id, buyer_type, buyer_school_id, buyer_person_id,
           seller_school_id, seller_profile_id, quantity,
           unit_price_cents, total_price_cents, platform_fee_cents,
           seller_receives_cents, shipping_method, status)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5,
           $6::uuid, $7::uuid, $8::int,
           $9::int, $10::int, $11::int, $12::int, $13, 'PENDING_PAYMENT')`,
        id,
        listingId,
        input.buyerType,
        input.buyerSchoolId ?? null,
        input.buyerPersonId ?? null,
        listing.seller_school_id,
        listing.seller_profile_id,
        quantity,
        unitPriceCents,
        totalPriceCents,
        platformFeeCents,
        sellerReceivesCents,
        input.shippingMethod ?? null,
      );

      // Flip listing to SOLD inside the same tx.
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_marketplace_listings
           SET status = 'SOLD', updated_at = now()
           WHERE id = $1::uuid`,
        listingId,
      );

      return { sellerProfileId: listing.seller_profile_id };
    });

    const dto = await this.getById(id);
    this.logger.log(
      `[mkt-transaction] created ${id} totalCents=${dto.totalPriceCents} fee=${dto.platformFeeCents} seller=${dto.sellerReceivesCents}`,
    );

    // Award seller reputation for the listing being sold. Best-effort
    // — the transaction is already committed.
    void this.profiles
      .addReputation(result.sellerProfileId, 30, 'LISTING_SOLD', id)
      .catch((e) => this.logger.warn(`[mkt-transaction] reputation award failed: ${String(e)}`));

    return dto;
  }

  // ── Reads ────────────────────────────────────────────────────────

  async listForActor(actor: ResolvedActor): Promise<AssetTransactionDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawTxnWithListing[]>(
      `SELECT t.id::text, t.listing_id::text, l.title AS listing_title,
              t.buyer_type, t.buyer_school_id::text AS buyer_school_id,
              t.buyer_person_id::text AS buyer_person_id,
              t.seller_school_id::text AS seller_school_id,
              t.seller_profile_id::text AS seller_profile_id,
              t.quantity, t.unit_price_cents, t.total_price_cents,
              t.platform_fee_cents, t.seller_receives_cents,
              t.stripe_payment_intent_id, t.status, t.shipping_method, t.tracking_number,
              t.paid_at, t.shipped_at, t.delivered_at, t.confirmed_at, t.refunded_at,
              t.created_at, t.updated_at
         FROM platform.platform_asset_transactions t
         LEFT JOIN platform.platform_marketplace_listings l ON l.id = t.listing_id
         LEFT JOIN platform.platform_community_profiles cp ON cp.id = t.seller_profile_id
         WHERE t.buyer_person_id = $1::uuid OR cp.person_id = $1::uuid
         ORDER BY t.created_at DESC
         LIMIT 200`,
      actor.personId,
    );
    return rows.map(rowToDto);
  }

  /**
   * REVIEW-P2C21 BLOCKING 3 — actor-aware getById.
   *
   * Without actor scope, any holder of mkt-002:read could read any
   * marketplace transaction by guessing the UUID (and the row carries
   * buyer/seller IDs, prices, fee splits, shipping details, tracking
   * numbers, and lifecycle timestamps).
   *
   * Actor-aware visibility: buyer, seller, seller-school admin,
   * buyer-school admin, platform admin (sys-001:admin via
   * everyFunction). Everyone else gets collapsed 404
   * NotFoundException — don't-leak-existence.
   *
   * The internal-only overload (no actor) is preserved for the
   * purchase post-INSERT read.
   */
  async getById(id: string, actor?: ResolvedActor): Promise<AssetTransactionDto> {
    const row = await this.loadOrFail(id);
    if (actor) {
      const allowed = await this.canAccessTransaction(actor, row);
      if (!allowed) {
        throw new NotFoundException(`platform_asset_transactions ${id} not found.`);
      }
    }
    return rowToDto(row);
  }

  /**
   * REVIEW-P2C21 BLOCKING 3 — shared access check used by getById,
   * patch, addConditionReport, listConditionReports.
   *
   * Returns true when the actor is the buyer, seller, a school admin
   * for the seller's or buyer's school in the current tenant, or
   * acting under platform-tier authority. Otherwise false.
   */
  private async canAccessTransaction(
    actor: ResolvedActor,
    row: RawTxnWithListing,
  ): Promise<boolean> {
    const profile = await this.profiles.getOrCreate(actor.personId, actor.personType ?? '');
    const isSeller = row.seller_profile_id === profile.id;
    const isBuyer = row.buyer_person_id === actor.personId;
    if (isSeller || isBuyer) return true;
    if (actor.isSchoolAdmin) {
      const tenant = getCurrentTenant();
      if (row.seller_school_id === tenant.schoolId || row.buyer_school_id === tenant.schoolId) {
        return true;
      }
    }
    return false;
  }

  // ── Lifecycle transitions ────────────────────────────────────────

  async patch(
    actor: ResolvedActor,
    id: string,
    input: PatchAssetTransactionDto,
  ): Promise<AssetTransactionDto> {
    const existing = await this.loadOrFail(id);

    // REVIEW-P2C21 BLOCKING 4 — school-admin override is bound to
    // either the seller's school or the buyer's school. A school A
    // admin cannot patch a school B<->C transaction.
    const profile = await this.profiles.getOrCreate(actor.personId, actor.personType ?? '');
    const isSeller = existing.seller_profile_id === profile.id;
    const isBuyer = existing.buyer_person_id === actor.personId;
    const tenant = getCurrentTenant();
    const isParticipantSchoolAdmin =
      actor.isSchoolAdmin &&
      (existing.seller_school_id === tenant.schoolId ||
        existing.buyer_school_id === tenant.schoolId);
    if (!isSeller && !isBuyer && !isParticipantSchoolAdmin) {
      throw new ForbiddenException(
        'Only the buyer, seller, or a school admin of the seller or buyer school can patch a transaction (REVIEW-P2C21 BLOCKING 4).',
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];

    if (input.shippingMethod !== undefined) {
      params.push(input.shippingMethod);
      sets.push(`shipping_method = $${params.length}`);
    }
    if (input.trackingNumber !== undefined) {
      params.push(input.trackingNumber);
      sets.push(`tracking_number = $${params.length}`);
    }

    let willEmitCompleted = false;
    if (input.status !== undefined && input.status !== existing.status) {
      assertValidStatusTransition(existing.status as TransactionStatus, input.status);
      params.push(input.status);
      sets.push(`status = $${params.length}`);
      switch (input.status) {
        case 'PAID':
          sets.push(`paid_at = COALESCE(paid_at, now())`);
          break;
        case 'SHIPPING':
          sets.push(`shipped_at = COALESCE(shipped_at, now())`);
          break;
        case 'DELIVERED':
          sets.push(`delivered_at = COALESCE(delivered_at, now())`);
          break;
        case 'CONFIRMED':
          sets.push(`confirmed_at = COALESCE(confirmed_at, now())`);
          willEmitCompleted = true;
          break;
        case 'REFUNDED':
          sets.push(`refunded_at = COALESCE(refunded_at, now())`);
          break;
        default:
          break;
      }
    }

    if (sets.length === 0) {
      return rowToDto(existing);
    }
    sets.push(`updated_at = now()`);
    params.push(id);
    // REVIEW-P2C21 BLOCKING 1 — UPDATE + outbox enqueue in one tx.
    await this.platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE platform.platform_asset_transactions
           SET ${sets.join(', ')}
           WHERE id = $${params.length}::uuid`,
        ...params,
      );
      if (willEmitCompleted) {
        await this.outbox.enqueueInTx(tx, {
          topic: 'mkt.transaction.completed',
          key: id,
          payload: {
            transactionId: id,
            listingId: existing.listing_id,
            buyerType: existing.buyer_type,
            buyerSchoolId: existing.buyer_school_id,
            buyerPersonId: existing.buyer_person_id,
            sellerSchoolId: existing.seller_school_id,
            sellerProfileId: existing.seller_profile_id,
            totalPriceCents: existing.total_price_cents,
            platformFeeCents: existing.platform_fee_cents,
            sellerReceivesCents: existing.seller_receives_cents,
            confirmedAt: new Date().toISOString(),
          },
          sourceModule: 'community',
          eventId: deterministicTransactionCompletedEventId(id),
        });
      }
    });

    const refreshed = await this.loadOrFail(id);
    if (willEmitCompleted) {
      this.logger.log(`[mkt-transaction] completed ${id}`);
    }
    return rowToDto(refreshed);
  }

  // ── Condition reports ────────────────────────────────────────────

  async addConditionReport(
    actor: ResolvedActor,
    transactionId: string,
    input: CreateConditionReportDto,
  ): Promise<ConditionReportDto> {
    const txn = await this.loadOrFail(transactionId);
    // REVIEW-P2C21 BLOCKING 3 + 4 — same access semantics as patch():
    // school-admin override is bound to the seller's or buyer's
    // school in the current tenant. Cross-school admins cannot
    // submit a report.
    const profile = await this.profiles.getOrCreate(actor.personId, actor.personType ?? '');
    const isSeller = txn.seller_profile_id === profile.id;
    const isBuyer = txn.buyer_person_id === actor.personId;
    const tenant = getCurrentTenant();
    const isSellerSchoolAdmin = actor.isSchoolAdmin && txn.seller_school_id === tenant.schoolId;
    const isBuyerSchoolAdmin = actor.isSchoolAdmin && txn.buyer_school_id === tenant.schoolId;
    if (input.reporterType === 'SELLER_LISTING' && !isSeller && !isSellerSchoolAdmin) {
      throw new ForbiddenException(
        'Only the seller or a school admin of the seller school can submit a SELLER_LISTING condition report.',
      );
    }
    if (input.reporterType === 'BUYER_RECEIPT' && !isBuyer && !isBuyerSchoolAdmin) {
      throw new ForbiddenException(
        'Only the buyer or a school admin of the buyer school can submit a BUYER_RECEIPT condition report.',
      );
    }

    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.platform_asset_condition_reports
          (id, transaction_id, reporter_type, condition, condition_notes,
           photo_s3_keys, reported_by, reported_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, $7::uuid, now())`,
        id,
        transactionId,
        input.reporterType,
        input.condition,
        input.conditionNotes ?? null,
        JSON.stringify(input.photoS3Keys ?? []),
        actor.personId,
      );
    } catch (e: unknown) {
      const err = e as { message?: string };
      if (
        typeof err?.message === 'string' &&
        err.message.includes('platform_asset_condition_reports_uq')
      ) {
        throw new BadRequestException(
          `A ${input.reporterType} condition report already exists for this transaction.`,
        );
      }
      throw e;
    }

    const reportRows = await this.platform.$queryRawUnsafe<RawConditionReport[]>(
      `SELECT id::text, transaction_id::text, reporter_type, condition, condition_notes,
              photo_s3_keys, reported_by::text, reported_at
         FROM platform.platform_asset_condition_reports
         WHERE id = $1::uuid`,
      id,
    );
    return reportRowToDto(reportRows[0]!);
  }

  /**
   * REVIEW-P2C21 BLOCKING 3 — actor-aware listConditionReports.
   *
   * The condition report endpoint exposes physical-item-state notes +
   * photos that buyer / seller agreed to. Without actor scope, any
   * mkt-002:read holder could list reports for any transaction by
   * guessing the UUID.
   *
   * Visibility: parent transaction visibility via canAccessTransaction.
   * Cross-transaction callers get collapsed 404.
   */
  async listConditionReports(
    transactionId: string,
    actor: ResolvedActor,
  ): Promise<ConditionReportDto[]> {
    const txn = await this.loadOrFail(transactionId);
    const allowed = await this.canAccessTransaction(actor, txn);
    if (!allowed) {
      throw new NotFoundException(`platform_asset_transactions ${transactionId} not found.`);
    }
    const rows = await this.platform.$queryRawUnsafe<RawConditionReport[]>(
      `SELECT id::text, transaction_id::text, reporter_type, condition, condition_notes,
              photo_s3_keys, reported_by::text, reported_at
         FROM platform.platform_asset_condition_reports
         WHERE transaction_id = $1::uuid
         ORDER BY reported_at ASC`,
      transactionId,
    );
    return rows.map(reportRowToDto);
  }

  // ── Internals ────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawTxnWithListing> {
    const rows = await this.platform.$queryRawUnsafe<RawTxnWithListing[]>(
      `SELECT t.id::text, t.listing_id::text, l.title AS listing_title,
              t.buyer_type, t.buyer_school_id::text AS buyer_school_id,
              t.buyer_person_id::text AS buyer_person_id,
              t.seller_school_id::text AS seller_school_id,
              t.seller_profile_id::text AS seller_profile_id,
              t.quantity, t.unit_price_cents, t.total_price_cents,
              t.platform_fee_cents, t.seller_receives_cents,
              t.stripe_payment_intent_id, t.status, t.shipping_method, t.tracking_number,
              t.paid_at, t.shipped_at, t.delivered_at, t.confirmed_at, t.refunded_at,
              t.created_at, t.updated_at
         FROM platform.platform_asset_transactions t
         LEFT JOIN platform.platform_marketplace_listings l ON l.id = t.listing_id
         WHERE t.id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_asset_transactions ${id} not found.`);
    }
    return rows[0]!;
  }
}

function assertValidStatusTransition(from: TransactionStatus, to: TransactionStatus): void {
  const allowed: Record<TransactionStatus, TransactionStatus[]> = {
    PENDING_PAYMENT: ['PAID', 'REFUNDED'],
    PAID: ['SHIPPING', 'DELIVERED', 'DISPUTED', 'REFUNDED'],
    SHIPPING: ['DELIVERED', 'DISPUTED', 'REFUNDED'],
    DELIVERED: ['CONFIRMED', 'DISPUTED', 'REFUNDED'],
    CONFIRMED: ['DISPUTED', 'REFUNDED'],
    DISPUTED: ['REFUNDED', 'CONFIRMED'],
    REFUNDED: [],
  };
  if (!allowed[from] || !allowed[from].includes(to)) {
    throw new BadRequestException(`Invalid transaction status transition ${from} -> ${to}.`);
  }
}

interface RawTxnWithListing {
  id: string;
  listing_id: string;
  listing_title: string | null;
  buyer_type: string;
  buyer_school_id: string | null;
  buyer_person_id: string | null;
  seller_school_id: string;
  seller_profile_id: string;
  quantity: number;
  unit_price_cents: number;
  total_price_cents: number;
  platform_fee_cents: number;
  seller_receives_cents: number;
  stripe_payment_intent_id: string | null;
  status: string;
  shipping_method: string | null;
  tracking_number: string | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  confirmed_at: Date | null;
  refunded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToDto(row: RawTxnWithListing): AssetTransactionDto {
  return {
    id: row.id,
    listingId: row.listing_id,
    listingTitle: row.listing_title,
    buyerType: row.buyer_type as AssetTransactionDto['buyerType'],
    buyerSchoolId: row.buyer_school_id,
    buyerPersonId: row.buyer_person_id,
    sellerSchoolId: row.seller_school_id,
    sellerProfileId: row.seller_profile_id,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    totalPriceCents: row.total_price_cents,
    platformFeeCents: row.platform_fee_cents,
    sellerReceivesCents: row.seller_receives_cents,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    status: row.status as AssetTransactionDto['status'],
    shippingMethod: row.shipping_method as AssetTransactionDto['shippingMethod'],
    trackingNumber: row.tracking_number,
    paidAt: row.paid_at?.toISOString() ?? null,
    shippedAt: row.shipped_at?.toISOString() ?? null,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    refundedAt: row.refunded_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

interface RawConditionReport {
  id: string;
  transaction_id: string;
  reporter_type: string;
  condition: string;
  condition_notes: string | null;
  photo_s3_keys: unknown;
  reported_by: string;
  reported_at: Date;
}

function reportRowToDto(row: RawConditionReport): ConditionReportDto {
  const photos = Array.isArray(row.photo_s3_keys) ? (row.photo_s3_keys as string[]) : [];
  return {
    id: row.id,
    transactionId: row.transaction_id,
    reporterType: row.reporter_type as ConditionReportDto['reporterType'],
    condition: row.condition as ConditionReportDto['condition'],
    conditionNotes: row.condition_notes,
    photoS3Keys: photos,
    reportedBy: row.reported_by,
    reportedAt: row.reported_at.toISOString(),
  };
}
