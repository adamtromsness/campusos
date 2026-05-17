import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateSavedPaymentMethodDto,
  SavedPaymentMethodResponseDto,
  SavedPaymentMethodType,
} from './dto/billing-ops.dto';

interface PMRow {
  id: string;
  school_id: string;
  family_account_id: string;
  stripe_payment_method_id: string;
  method_type: string;
  card_last_four: string | null;
  card_brand: string | null;
  card_exp_month: number | null;
  card_exp_year: number | null;
  bank_last_four: string | null;
  is_default: boolean;
  added_at: string;
}

const SELECT_BASE =
  'SELECT id, school_id, family_account_id, stripe_payment_method_id, method_type, ' +
  'card_last_four, card_brand, card_exp_month, card_exp_year, bank_last_four, is_default, added_at ' +
  'FROM pay_saved_payment_methods ';

function rowToDto(r: PMRow): SavedPaymentMethodResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    familyAccountId: r.family_account_id,
    stripePaymentMethodId: r.stripe_payment_method_id,
    methodType: r.method_type as SavedPaymentMethodType,
    cardLastFour: r.card_last_four,
    cardBrand: r.card_brand,
    cardExpMonth: r.card_exp_month,
    cardExpYear: r.card_exp_year,
    bankLastFour: r.bank_last_four,
    isDefault: r.is_default,
    addedAt: r.added_at,
  };
}

/**
 * SavedPaymentMethodService — Phase 2 Cycle 6 (P2-6).
 *
 * Token-only Stripe payment method storage. Card numbers / CVCs /
 * PINs never touch the DB. Only the Stripe pm_ token + last-four
 * + brand are stored.
 *
 * Authorisation:
 *   - fin-001:read  — admin or family member sees own family's
 *                     methods (row-scoped via family_account.holder).
 *   - fin-001:write — admin or family member adds + removes own.
 */
@Injectable()
export class SavedPaymentMethodService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listForFamily(
    familyAccountId: string,
    actor: ResolvedActor,
  ): Promise<SavedPaymentMethodResponseDto[]> {
    await this.assertCanAccessFamily(familyAccountId, actor);
    // REVIEW-P2-6 MAJOR 3 — school predicate so a cross-school family
    // UUID never lists foreign payment methods.
    const schoolId = getCurrentTenant().schoolId;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PMRow[]>(
        SELECT_BASE +
          'WHERE school_id = $1::uuid AND family_account_id = $2::uuid AND removed_at IS NULL ' +
          'ORDER BY is_default DESC, added_at DESC',
        schoolId,
        familyAccountId,
      ),
    )) as PMRow[];
    return rows.map(rowToDto);
  }

  async create(
    body: CreateSavedPaymentMethodDto,
    actor: ResolvedActor,
  ): Promise<SavedPaymentMethodResponseDto> {
    await this.assertCanAccessFamily(body.familyAccountId, actor);
    const id = generateId();
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      if (body.isDefault) {
        // REVIEW-P2-6 MAJOR 3 — clear-default UPDATE carries the
        // school predicate so a cross-school admin can't strip the
        // default flag from a foreign-school family's primary card.
        await tx.$executeRawUnsafe(
          'UPDATE pay_saved_payment_methods SET is_default = false, added_at = added_at WHERE school_id = $1::uuid AND family_account_id = $2::uuid AND is_default = true AND removed_at IS NULL',
          schoolId,
          body.familyAccountId,
        );
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_saved_payment_methods (id, school_id, family_account_id, stripe_payment_method_id, method_type, card_last_four, card_brand, card_exp_month, card_exp_year, bank_last_four, is_default, added_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid)',
          id,
          schoolId,
          body.familyAccountId,
          body.stripePaymentMethodId,
          body.methodType ?? 'CARD',
          body.cardLastFour ?? null,
          body.cardBrand ?? null,
          body.cardExpMonth ?? null,
          body.cardExpYear ?? null,
          body.bankLastFour ?? null,
          body.isDefault ?? false,
          actor.accountId,
        );
      } catch (err) {
        if (err instanceof Error && /pay_saved_pm_stripe_id_uq|23505/.test(err.message)) {
          throw new BadRequestException(
            'Stripe payment method ' +
              body.stripePaymentMethodId +
              ' is already saved for this school',
          );
        }
        throw err;
      }
    });
    return this.getById(id, actor);
  }

  async getById(id: string, actor: ResolvedActor): Promise<SavedPaymentMethodResponseDto> {
    // REVIEW-P2-6 MAJOR 3 — collapse cross-school UUIDs to 404 BEFORE
    // any family-account check fires (don't-leak-existence).
    const schoolId = getCurrentTenant().schoolId;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<PMRow[]>(
        SELECT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid AND removed_at IS NULL',
        schoolId,
        id,
      ),
    )) as PMRow[];
    if (rows.length === 0) throw new NotFoundException('Saved payment method ' + id + ' not found');
    const dto = rowToDto(rows[0]!);
    await this.assertCanAccessFamily(dto.familyAccountId, actor);
    return dto;
  }

  async remove(id: string, actor: ResolvedActor): Promise<{ id: string; removed: boolean }> {
    const dto = await this.getById(id, actor);
    // REVIEW-P2-6 MAJOR 3 — soft-delete UPDATE carries the school
    // predicate so even if getById's gate were bypassed (defence in
    // depth), no cross-school row could be marked removed.
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE pay_saved_payment_methods SET removed_at = now() WHERE school_id = $1::uuid AND id = $2::uuid AND removed_at IS NULL',
        schoolId,
        dto.id,
      );
    });
    return { id: dto.id, removed: true };
  }

  private async assertCanAccessFamily(
    familyAccountId: string,
    actor: ResolvedActor,
  ): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (!actor.personId)
      throw new ForbiddenException('Cannot access family billing without a personId');
    // REVIEW-P2-6 MAJOR 3 — the existence check joins on school_id so
    // a cross-school family UUID returns a friendly 404 even if the
    // calling parent happens to share an iam_person between schools.
    const schoolId = getCurrentTenant().schoolId;
    const ok = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<unknown>>(
        'SELECT 1 FROM pay_family_accounts WHERE school_id = $1::uuid AND id = $2::uuid AND account_holder_id = $3::uuid LIMIT 1',
        schoolId,
        familyAccountId,
        actor.personId,
      ),
    )) as Array<unknown>;
    if (ok.length === 0) {
      throw new NotFoundException('Family account not found');
    }
  }
}
