import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { assertCanManage } from './buildings.service';
import {
  CreateSpaceUtilisationDto,
  SpaceUtilisationResponseDto,
  SpaceUtilSource,
  UnderusedSpaceRowDto,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * SpaceUtilisationService — P2-18b Step 4.
 *
 * Per-(space, record_date, period) occupancy snapshots, the per-space
 * trend reader, and the underused-spaces dashboard. utilisation_rate
 * is materialised at insert time (occupancy / capacity, NULL when
 * capacity is zero) so dashboards filter without division-by-zero
 * juggling.
 */
@Injectable()
export class SpaceUtilisationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async record(
    input: CreateSpaceUtilisationDto,
    actor: ResolvedActor,
  ): Promise<SpaceUtilisationResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Space utilisation recording requires an authenticated person');
    }
    const id = generateId();
    const utilisationRate =
      input.capacity === 0 ? null : Number((input.occupancyCount / input.capacity).toFixed(4));
    if (utilisationRate !== null && utilisationRate > 1) {
      throw new BadRequestException(
        'occupancyCount (' +
          input.occupancyCount +
          ') exceeds capacity (' +
          input.capacity +
          '). Adjust occupancy or capacity before recording.',
      );
    }
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        const sp = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM fac_spaces WHERE id = $1::uuid LIMIT 1',
          input.spaceId,
        )) as Array<{ ok: number }>;
        if (sp.length === 0) {
          throw new BadRequestException('spaceId does not match a space in this school');
        }
        await client.$executeRawUnsafe(
          'INSERT INTO fac_space_utilization_records ' +
            '(id, space_id, record_date, period_id, occupancy_count, capacity, utilisation_rate, source, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6, $7, $8, $9)',
          id,
          input.spaceId,
          input.recordDate,
          input.periodId ?? null,
          input.occupancyCount,
          input.capacity,
          utilisationRate,
          input.source ?? 'MANUAL',
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'A utilisation record already exists for this (space, date, period) combination.',
        );
      }
      throw err;
    }
    return this.getRecord(id);
  }

  async getRecord(id: string): Promise<SpaceUtilisationResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(UTIL_SELECT + 'WHERE r.id = $1::uuid LIMIT 1', id);
    })) as UtilRow[];
    if (rows.length === 0) throw new NotFoundException('Utilisation record not found');
    return utilRowToDto(rows[0]!);
  }

  async listForSpace(
    spaceId: string,
    args: { fromDate?: string; toDate?: string },
  ): Promise<SpaceUtilisationResponseDto[]> {
    const where: string[] = ['r.space_id = $1::uuid'];
    const params: unknown[] = [spaceId];
    if (args.fromDate) {
      where.push('r.record_date >= $' + (params.length + 1) + '::date');
      params.push(args.fromDate);
    }
    if (args.toDate) {
      where.push('r.record_date <= $' + (params.length + 1) + '::date');
      params.push(args.toDate);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        UTIL_SELECT +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.record_date DESC, r.created_at DESC LIMIT 200',
        ...params,
      );
    })) as UtilRow[];
    return rows.map(utilRowToDto);
  }

  /**
   * Underused-spaces dashboard. Aggregates the trailing 30 days of
   * fac_space_utilization_records per space and surfaces those whose
   * average utilisation_rate is strictly less than 0.5. Only rows
   * where utilisation_rate is not NULL (capacity > 0) contribute to
   * the average. Ordered by lowest utilisation first.
   */
  async underused(): Promise<UnderusedSpaceRowDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT r.space_id::text AS space_id, ' +
          '(SELECT s.name FROM fac_spaces s WHERE s.id = r.space_id) AS space_name, ' +
          'AVG(r.utilisation_rate)::float AS avg_rate, ' +
          'COUNT(r.id)::int AS record_count, ' +
          'AVG(r.occupancy_count)::float AS avg_occupancy, ' +
          'AVG(r.capacity)::float AS avg_capacity ' +
          'FROM fac_space_utilization_records r ' +
          'JOIN fac_spaces s ON s.id = r.space_id ' +
          'JOIN fac_buildings b ON b.id = s.building_id ' +
          "WHERE b.school_id = $1::uuid AND r.record_date >= CURRENT_DATE - INTERVAL '30 days' AND r.utilisation_rate IS NOT NULL " +
          'GROUP BY r.space_id ' +
          'HAVING AVG(r.utilisation_rate) < 0.5 ' +
          'ORDER BY avg_rate ASC LIMIT 100',
        tenant.schoolId,
      );
    })) as Array<{
      space_id: string;
      space_name: string | null;
      avg_rate: number;
      record_count: number;
      avg_occupancy: number;
      avg_capacity: number;
    }>;
    return rows.map((r) => ({
      spaceId: r.space_id,
      spaceName: r.space_name ?? '(unnamed)',
      averageUtilisationRate: Number(r.avg_rate.toFixed(4)),
      recordCount: r.record_count,
      averageOccupancy: Number(r.avg_occupancy.toFixed(2)),
      averageCapacity: Number(r.avg_capacity.toFixed(2)),
    }));
  }
}

const UTIL_SELECT =
  'SELECT r.id::text AS id, r.space_id::text AS space_id, ' +
  '(SELECT name FROM fac_spaces WHERE id = r.space_id) AS space_name, ' +
  'r.record_date::text AS record_date, r.period_id::text AS period_id, ' +
  'r.occupancy_count, r.capacity, r.utilisation_rate::float AS utilisation_rate, ' +
  'r.source, r.notes ' +
  'FROM fac_space_utilization_records r ';

interface UtilRow {
  id: string;
  space_id: string;
  space_name: string | null;
  record_date: string;
  period_id: string | null;
  occupancy_count: number;
  capacity: number;
  utilisation_rate: number | null;
  source: string;
  notes: string | null;
}

function utilRowToDto(r: UtilRow): SpaceUtilisationResponseDto {
  return {
    id: r.id,
    spaceId: r.space_id,
    spaceName: r.space_name,
    recordDate: r.record_date,
    periodId: r.period_id,
    occupancyCount: r.occupancy_count,
    capacity: r.capacity,
    utilisationRate: r.utilisation_rate,
    source: r.source as SpaceUtilSource,
    notes: r.notes,
  };
}
