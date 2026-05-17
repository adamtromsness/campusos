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
  DepreciationMethod,
  DisposalMethod,
  FleetReplacementRowDto,
  RecordDisposalDto,
  UpdateVehicleLifecycleDto,
  VehicleLifecycleResponseDto,
} from './dto/fleet-maintenance.dto';

interface LifecycleRow {
  id: string;
  vehicle_id: string;
  vehicle_registration: string;
  purchase_date: Date | null;
  purchase_price: string | null;
  expected_life_years: number | null;
  expected_life_miles: number | null;
  depreciation_method: string;
  current_book_value: string | null;
  book_value_computed_at: Date | null;
  disposal_date: Date | null;
  disposal_value: string | null;
  disposal_method: string | null;
  disposal_notes: string | null;
}

const APPROACHING_REPLACEMENT_THRESHOLD = 0.85;

const SELECT_LIFECYCLE_BASE =
  'SELECT l.id::text AS id, l.vehicle_id::text AS vehicle_id, v.registration AS vehicle_registration, ' +
  'l.purchase_date, l.purchase_price::text AS purchase_price, ' +
  'l.expected_life_years, l.expected_life_miles, l.depreciation_method, ' +
  'l.current_book_value::text AS current_book_value, l.book_value_computed_at, ' +
  'l.disposal_date, l.disposal_value::text AS disposal_value, l.disposal_method, l.disposal_notes ' +
  'FROM trn_vehicle_lifecycle l JOIN trn_vehicles v ON v.id = l.vehicle_id ';

function rowToDto(r: LifecycleRow): VehicleLifecycleResponseDto {
  const now = new Date();
  let ageYears: number | null = null;
  let remainingLifeYears: number | null = null;
  let approachingReplacement = false;
  if (r.purchase_date) {
    const days = (now.getTime() - r.purchase_date.getTime()) / (1000 * 60 * 60 * 24);
    ageYears = Math.round((days / 365.25) * 10) / 10;
    if (r.expected_life_years !== null) {
      remainingLifeYears = Math.round((r.expected_life_years - ageYears) * 10) / 10;
      if (ageYears >= r.expected_life_years * APPROACHING_REPLACEMENT_THRESHOLD) {
        approachingReplacement = true;
      }
    }
  }
  return {
    id: r.id,
    vehicleId: r.vehicle_id,
    vehicleRegistration: r.vehicle_registration,
    purchaseDate: r.purchase_date ? r.purchase_date.toISOString().slice(0, 10) : null,
    purchasePrice: r.purchase_price === null ? null : Number(r.purchase_price),
    expectedLifeYears: r.expected_life_years,
    expectedLifeMiles: r.expected_life_miles,
    depreciationMethod: r.depreciation_method as DepreciationMethod,
    currentBookValue: r.current_book_value === null ? null : Number(r.current_book_value),
    bookValueComputedAt: r.book_value_computed_at ? r.book_value_computed_at.toISOString() : null,
    disposalDate: r.disposal_date ? r.disposal_date.toISOString().slice(0, 10) : null,
    disposalValue: r.disposal_value === null ? null : Number(r.disposal_value),
    disposalMethod: r.disposal_method ? (r.disposal_method as DisposalMethod) : null,
    disposalNotes: r.disposal_notes,
    ageYears,
    remainingLifeYears,
    approachingReplacement,
  };
}

@Injectable()
export class VehicleLifecycleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage vehicle lifecycle data',
    );
  }

  async getForVehicle(vehicleId: string): Promise<VehicleLifecycleResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_LIFECYCLE_BASE + 'WHERE l.vehicle_id = $1::uuid LIMIT 1',
        vehicleId,
      );
    })) as LifecycleRow[];
    if (rows.length === 0) {
      throw new NotFoundException('Vehicle lifecycle row not found for this vehicle');
    }
    return rowToDto(rows[0]!);
  }

  async upsert(
    vehicleId: string,
    input: UpdateVehicleLifecycleDto,
    actor: ResolvedActor,
  ): Promise<VehicleLifecycleResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const vRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
        vehicleId,
      )) as Array<{ id: string }>;
      if (vRows.length === 0) throw new NotFoundException('Vehicle not found');

      const existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM trn_vehicle_lifecycle WHERE vehicle_id = $1::uuid LIMIT 1',
        vehicleId,
      )) as Array<{ id: string }>;

      if (existing.length === 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_vehicle_lifecycle (id, vehicle_id, purchase_date, purchase_price, expected_life_years, expected_life_miles, depreciation_method, current_book_value, book_value_computed_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9::timestamptz)',
          generateId(),
          vehicleId,
          input.purchaseDate ?? null,
          input.purchasePrice ?? null,
          input.expectedLifeYears ?? null,
          input.expectedLifeMiles ?? null,
          input.depreciationMethod ?? 'STRAIGHT_LINE',
          input.currentBookValue ?? input.purchasePrice ?? null,
          input.currentBookValue !== undefined ? new Date().toISOString() : null,
        );
      } else {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.purchaseDate !== undefined) {
          sets.push('purchase_date = $' + (params.length + 1) + '::date');
          params.push(input.purchaseDate);
        }
        if (input.purchasePrice !== undefined) {
          sets.push('purchase_price = $' + (params.length + 1));
          params.push(input.purchasePrice);
        }
        if (input.expectedLifeYears !== undefined) {
          sets.push('expected_life_years = $' + (params.length + 1));
          params.push(input.expectedLifeYears);
        }
        if (input.expectedLifeMiles !== undefined) {
          sets.push('expected_life_miles = $' + (params.length + 1));
          params.push(input.expectedLifeMiles);
        }
        if (input.depreciationMethod !== undefined) {
          sets.push('depreciation_method = $' + (params.length + 1));
          params.push(input.depreciationMethod);
        }
        if (input.currentBookValue !== undefined) {
          sets.push('current_book_value = $' + (params.length + 1));
          params.push(input.currentBookValue);
          sets.push('book_value_computed_at = now()');
        }
        if (sets.length === 0) return;
        sets.push('updated_at = now()');
        params.push(vehicleId);
        await tx.$executeRawUnsafe(
          'UPDATE trn_vehicle_lifecycle SET ' +
            sets.join(', ') +
            ' WHERE vehicle_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      }
    });
    return this.getForVehicle(vehicleId);
  }

  async recordDisposal(
    vehicleId: string,
    input: RecordDisposalDto,
    actor: ResolvedActor,
  ): Promise<VehicleLifecycleResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id, disposal_date FROM trn_vehicle_lifecycle WHERE vehicle_id = $1::uuid FOR UPDATE',
        vehicleId,
      )) as Array<{ id: string; disposal_date: Date | null }>;
      if (rows.length === 0) {
        throw new NotFoundException('Lifecycle row not found — create it first via PATCH');
      }
      if (rows[0]!.disposal_date !== null) {
        throw new BadRequestException('Vehicle has already been disposed');
      }
      await tx.$executeRawUnsafe(
        'UPDATE trn_vehicle_lifecycle SET disposal_date = $1::date, disposal_method = $2, ' +
          'disposal_value = $3, disposal_notes = $4, updated_at = now() WHERE vehicle_id = $5::uuid',
        input.disposalDate,
        input.disposalMethod,
        input.disposalValue ?? null,
        input.disposalNotes ?? null,
        vehicleId,
      );
      // Also flip the vehicle to RETIRED so it no longer appears in
      // active dispatch surfaces.
      await tx.$executeRawUnsafe(
        "UPDATE trn_vehicles SET status = 'RETIRED', updated_at = now() WHERE id = $1::uuid",
        vehicleId,
      );
    });
    return this.getForVehicle(vehicleId);
  }

  async replacementPlanning(): Promise<FleetReplacementRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_LIFECYCLE_BASE +
          'WHERE v.school_id = $1::uuid AND l.disposal_date IS NULL ' +
          'ORDER BY (CASE WHEN l.purchase_date IS NULL THEN 0 ELSE EXTRACT(YEAR FROM age(now(), l.purchase_date)) END) DESC ' +
          'LIMIT 200',
        tenant.schoolId,
      );
    })) as LifecycleRow[];
    return rows.map((r) => {
      const dto = rowToDto(r);
      return {
        vehicleId: dto.vehicleId,
        vehicleRegistration: dto.vehicleRegistration,
        ageYears: dto.ageYears,
        expectedLifeYears: dto.expectedLifeYears,
        remainingLifeYears: dto.remainingLifeYears,
        currentBookValue: dto.currentBookValue,
        approachingReplacement: dto.approachingReplacement,
      };
    });
  }
}
