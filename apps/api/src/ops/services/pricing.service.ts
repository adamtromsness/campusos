import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreatePricingBandDto,
  CreateSupportTierDto,
  PatchSupportTierDto,
  PricingBandDto,
  PricingHistoryDto,
  SupportTierDto,
  UpdatePricingBandDto,
} from '../dto/ops.dto';
import { OpsEmployeeService } from './ops-employee.service';

/**
 * P2-21b — PricingService.
 *
 * CRUD over platform_pricing_bands + platform_support_tiers, plus
 * append-only audit trail in platform_pricing_history.
 *
 * Update keystone — when a band's monthly_price_cents or
 * annual_price_cents changes via `update()`, the service writes a
 * platform_pricing_history row BEFORE the UPDATE inside a single
 * Prisma $transaction so the audit trail can never desync from the
 * band's current state. The history table has no UPDATE/DELETE
 * service paths exposed.
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly employees: OpsEmployeeService,
  ) {}

  // ── Bands ─────────────────────────────────────────────────────────

  async listBands(includeInactive = false): Promise<PricingBandDto[]> {
    const where = includeInactive ? '' : 'WHERE is_active = true';
    const rows = await this.platform.$queryRawUnsafe<RawBandRow[]>(
      `SELECT id::text, name, student_range_min, student_range_max,
              monthly_price_cents, annual_price_cents, is_active,
              created_at, updated_at
         FROM platform.platform_pricing_bands
         ${where}
         ORDER BY student_range_min ASC`,
    );
    return rows.map(rowToBandDto);
  }

  async getBand(id: string): Promise<PricingBandDto> {
    return rowToBandDto(await this.loadBandOrFail(id));
  }

  async createBand(input: CreatePricingBandDto): Promise<PricingBandDto> {
    if (
      input.studentRangeMax !== undefined &&
      input.studentRangeMax !== null &&
      input.studentRangeMax < input.studentRangeMin
    ) {
      throw new BadRequestException(
        'studentRangeMax must be >= studentRangeMin (or null for open-ended top band).',
      );
    }
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.platform_pricing_bands
          (id, name, student_range_min, student_range_max,
           monthly_price_cents, annual_price_cents)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        id,
        input.name,
        input.studentRangeMin,
        input.studentRangeMax ?? null,
        input.monthlyPriceCents,
        input.annualPriceCents,
      );
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (
        err?.code === 'P2002' ||
        err?.meta?.code === '23505' ||
        (typeof err?.message === 'string' && err.message.includes('23505'))
      ) {
        throw new ConflictException(`Pricing band with name "${input.name}" already exists.`);
      }
      throw e;
    }
    return this.getBand(id);
  }

  /**
   * Update a pricing band. If monthly_price_cents or
   * annual_price_cents change, a platform_pricing_history row is
   * written inside the SAME tx as the UPDATE so audit can never
   * desync. changedBy is required when prices change.
   */
  async updateBand(id: string, input: UpdatePricingBandDto): Promise<PricingBandDto> {
    const band = await this.loadBandOrFail(id);

    const priceChange =
      (input.monthlyPriceCents !== undefined &&
        input.monthlyPriceCents !== band.monthly_price_cents) ||
      (input.annualPriceCents !== undefined && input.annualPriceCents !== band.annual_price_cents);

    if (priceChange && !input.changedBy) {
      throw new BadRequestException(
        'changedBy is required when monthlyPriceCents or annualPriceCents changes — pricing history needs the responsible employee.',
      );
    }
    if (input.changedBy) {
      await this.employees.loadOrFail(input.changedBy);
    }

    const newRangeMin = input.studentRangeMin ?? band.student_range_min;
    const newRangeMax =
      input.studentRangeMax !== undefined ? input.studentRangeMax : band.student_range_max;
    if (newRangeMax !== null && newRangeMax !== undefined && newRangeMax < newRangeMin) {
      throw new BadRequestException(
        'studentRangeMax must be >= studentRangeMin (or null for open-ended top band).',
      );
    }

    await this.platform.$transaction(async (tx) => {
      if (priceChange) {
        const newMonthly = input.monthlyPriceCents ?? band.monthly_price_cents;
        const newAnnual = input.annualPriceCents ?? band.annual_price_cents;
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_pricing_history
            (id, band_id, previous_monthly_cents, new_monthly_cents,
             previous_annual_cents, new_annual_cents, effective_date, changed_by)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::uuid)`,
          generateId(),
          id,
          band.monthly_price_cents,
          newMonthly,
          band.annual_price_cents,
          newAnnual,
          input.effectiveDate ?? new Date().toISOString().slice(0, 10),
          input.changedBy,
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown): void => {
        params.push(value);
        sets.push(sql.replace('$$', `$${params.length}`));
      };
      if (input.name !== undefined) push('name = $$', input.name);
      if (input.studentRangeMin !== undefined)
        push('student_range_min = $$', input.studentRangeMin);
      if (input.studentRangeMax !== undefined)
        push('student_range_max = $$', input.studentRangeMax);
      if (input.monthlyPriceCents !== undefined)
        push('monthly_price_cents = $$', input.monthlyPriceCents);
      if (input.annualPriceCents !== undefined)
        push('annual_price_cents = $$', input.annualPriceCents);
      if (input.isActive !== undefined) push('is_active = $$', input.isActive);

      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        try {
          await tx.$executeRawUnsafe(
            `UPDATE platform.platform_pricing_bands SET ${sets.join(', ')}
             WHERE id = $${params.length}::uuid`,
            ...params,
          );
        } catch (e: unknown) {
          const err = e as { message?: string };
          if (
            typeof err?.message === 'string' &&
            (err.message.includes('23505') || err.message.includes('duplicate key'))
          ) {
            throw new ConflictException(
              `Pricing band with name "${input.name ?? band.name}" already exists.`,
            );
          }
          throw e;
        }
      }
    });

    return this.getBand(id);
  }

  async listHistoryForBand(id: string): Promise<PricingHistoryDto[]> {
    await this.loadBandOrFail(id);
    const rows = await this.platform.$queryRawUnsafe<RawHistoryRow[]>(
      `SELECT id::text, band_id::text, previous_monthly_cents, new_monthly_cents,
              previous_annual_cents, new_annual_cents, effective_date::text,
              changed_by::text, created_at
         FROM platform.platform_pricing_history
         WHERE band_id = $1::uuid
         ORDER BY effective_date DESC, created_at DESC`,
      id,
    );
    return rows.map(rowToHistoryDto);
  }

  async listAllHistory(): Promise<PricingHistoryDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawHistoryRow[]>(
      `SELECT id::text, band_id::text, previous_monthly_cents, new_monthly_cents,
              previous_annual_cents, new_annual_cents, effective_date::text,
              changed_by::text, created_at
         FROM platform.platform_pricing_history
         ORDER BY effective_date DESC, created_at DESC
         LIMIT 500`,
    );
    return rows.map(rowToHistoryDto);
  }

  // ── Support tiers ─────────────────────────────────────────────────

  async listSupportTiers(includeInactive = false): Promise<SupportTierDto[]> {
    const where = includeInactive ? '' : 'WHERE is_active = true';
    const rows = await this.platform.$queryRawUnsafe<RawSupportTierRow[]>(
      `SELECT id::text, name, response_time_hours, includes_phone,
              includes_dedicated_csm, monthly_addon_cents, is_active,
              created_at, updated_at
         FROM platform.platform_support_tiers
         ${where}
         ORDER BY response_time_hours ASC`,
    );
    return rows.map(rowToSupportTierDto);
  }

  async createSupportTier(input: CreateSupportTierDto): Promise<SupportTierDto> {
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.platform_support_tiers
          (id, name, response_time_hours, includes_phone, includes_dedicated_csm,
           monthly_addon_cents)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
        id,
        input.name,
        input.responseTimeHours,
        input.includesPhone ?? false,
        input.includesDedicatedCsm ?? false,
        input.monthlyAddonCents ?? 0,
      );
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (
        err?.code === 'P2002' ||
        err?.meta?.code === '23505' ||
        (typeof err?.message === 'string' && err.message.includes('23505'))
      ) {
        throw new ConflictException(`Support tier with name "${input.name}" already exists.`);
      }
      throw e;
    }
    return this.getSupportTier(id);
  }

  async patchSupportTier(id: string, input: PatchSupportTierDto): Promise<SupportTierDto> {
    await this.loadSupportTierOrFail(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };
    if (input.name !== undefined) push('name = $$', input.name);
    if (input.responseTimeHours !== undefined)
      push('response_time_hours = $$', input.responseTimeHours);
    if (input.includesPhone !== undefined) push('includes_phone = $$', input.includesPhone);
    if (input.includesDedicatedCsm !== undefined)
      push('includes_dedicated_csm = $$', input.includesDedicatedCsm);
    if (input.monthlyAddonCents !== undefined)
      push('monthly_addon_cents = $$', input.monthlyAddonCents);
    if (input.isActive !== undefined) push('is_active = $$', input.isActive);

    if (sets.length === 0) return this.getSupportTier(id);
    sets.push('updated_at = now()');
    params.push(id);
    try {
      await this.platform.$executeRawUnsafe(
        `UPDATE platform.platform_support_tiers SET ${sets.join(', ')}
         WHERE id = $${params.length}::uuid`,
        ...params,
      );
    } catch (e: unknown) {
      const err = e as { message?: string };
      if (typeof err?.message === 'string' && err.message.includes('23505')) {
        throw new ConflictException(`Support tier name conflict on "${input.name}".`);
      }
      throw e;
    }
    return this.getSupportTier(id);
  }

  async getSupportTier(id: string): Promise<SupportTierDto> {
    return rowToSupportTierDto(await this.loadSupportTierOrFail(id));
  }

  // ── Internals ─────────────────────────────────────────────────────

  async loadBandOrFail(id: string): Promise<RawBandRow> {
    const rows = await this.platform.$queryRawUnsafe<RawBandRow[]>(
      `SELECT id::text, name, student_range_min, student_range_max,
              monthly_price_cents, annual_price_cents, is_active,
              created_at, updated_at
         FROM platform.platform_pricing_bands WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_pricing_bands ${id} not found.`);
    }
    return rows[0]!;
  }

  private async loadSupportTierOrFail(id: string): Promise<RawSupportTierRow> {
    const rows = await this.platform.$queryRawUnsafe<RawSupportTierRow[]>(
      `SELECT id::text, name, response_time_hours, includes_phone,
              includes_dedicated_csm, monthly_addon_cents, is_active,
              created_at, updated_at
         FROM platform.platform_support_tiers WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`platform_support_tiers ${id} not found.`);
    }
    return rows[0]!;
  }
}

interface RawBandRow {
  id: string;
  name: string;
  student_range_min: number;
  student_range_max: number | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RawHistoryRow {
  id: string;
  band_id: string;
  previous_monthly_cents: number | null;
  new_monthly_cents: number;
  previous_annual_cents: number | null;
  new_annual_cents: number;
  effective_date: string;
  changed_by: string;
  created_at: Date;
}

interface RawSupportTierRow {
  id: string;
  name: string;
  response_time_hours: number;
  includes_phone: boolean;
  includes_dedicated_csm: boolean;
  monthly_addon_cents: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export function rowToBandDto(row: RawBandRow): PricingBandDto {
  return {
    id: row.id,
    name: row.name,
    studentRangeMin: row.student_range_min,
    studentRangeMax: row.student_range_max,
    monthlyPriceCents: row.monthly_price_cents,
    annualPriceCents: row.annual_price_cents,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToHistoryDto(row: RawHistoryRow): PricingHistoryDto {
  return {
    id: row.id,
    bandId: row.band_id,
    previousMonthlyCents: row.previous_monthly_cents,
    newMonthlyCents: row.new_monthly_cents,
    previousAnnualCents: row.previous_annual_cents,
    newAnnualCents: row.new_annual_cents,
    effectiveDate: row.effective_date,
    changedBy: row.changed_by,
    createdAt: row.created_at.toISOString(),
  };
}

export function rowToSupportTierDto(row: RawSupportTierRow): SupportTierDto {
  return {
    id: row.id,
    name: row.name,
    responseTimeHours: row.response_time_hours,
    includesPhone: row.includes_phone,
    includesDedicatedCsm: row.includes_dedicated_csm,
    monthlyAddonCents: row.monthly_addon_cents,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
