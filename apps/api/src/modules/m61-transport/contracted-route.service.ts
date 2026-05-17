import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  ContractedRouteFrequency,
  ContractedRouteResponseDto,
  CreateContractedRouteDto,
  UpdateContractedRouteDto,
} from './dto/route-generation.dto';

interface ContractedRouteRow {
  id: string;
  route_id: string;
  route_name: string | null;
  contractor_id: string | null;
  contract_reference: string | null;
  contract_start_date: Date;
  contract_end_date: Date;
  daily_rate: string | null;
  payment_frequency: string;
  performance_rating: string | null;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_BASE =
  'SELECT c.id::text AS id, c.route_id::text AS route_id, ' +
  '(SELECT name FROM trn_routes WHERE id = c.route_id) AS route_name, ' +
  'c.contractor_id::text AS contractor_id, c.contract_reference, ' +
  'c.contract_start_date, c.contract_end_date, ' +
  'c.daily_rate::text AS daily_rate, c.payment_frequency, ' +
  'c.performance_rating::text AS performance_rating, c.notes, c.is_active, ' +
  'c.created_by::text AS created_by, c.created_at, c.updated_at ' +
  'FROM trn_contracted_routes c ';

function rowToDto(r: ContractedRouteRow): ContractedRouteResponseDto {
  return {
    id: r.id,
    routeId: r.route_id,
    routeName: r.route_name,
    contractorId: r.contractor_id,
    contractReference: r.contract_reference,
    contractStartDate: r.contract_start_date.toISOString().slice(0, 10),
    contractEndDate: r.contract_end_date.toISOString().slice(0, 10),
    dailyRate: r.daily_rate === null ? null : Number(r.daily_rate),
    paymentFrequency: r.payment_frequency as ContractedRouteFrequency,
    performanceRating: r.performance_rating === null ? null : Number(r.performance_rating),
    notes: r.notes,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string } | null;
  if (!e) return false;
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * ContractedRouteService — third-party contractor metadata for routes
 * operated by external bus companies.
 *
 * UNIQUE(route_id) so each route may carry at most one active
 * contract row. Performance rating bound 0..5 with one decimal is the
 * TC-recorded service score.
 */
@Injectable()
export class ContractedRouteService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage contracted routes',
    );
  }

  async list(args: { activeOnly?: boolean }): Promise<ContractedRouteResponseDto[]> {
    const where = args.activeOnly ? 'WHERE c.is_active = true' : '';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_BASE + where + ' ORDER BY c.contract_start_date DESC LIMIT 200',
      );
    })) as ContractedRouteRow[];
    return rows.map(rowToDto);
  }

  async getById(contractId: string): Promise<ContractedRouteResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_BASE + 'WHERE c.id = $1::uuid LIMIT 1', contractId);
    })) as ContractedRouteRow[];
    if (rows.length === 0) throw new NotFoundException('Contracted route not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateContractedRouteDto,
    actor: ResolvedActor,
  ): Promise<ContractedRouteResponseDto> {
    this.assertCanManage(actor);
    if (input.contractEndDate < input.contractStartDate) {
      throw new BadRequestException('contractEndDate must be on or after contractStartDate');
    }
    // Validate route exists in this tenant
    const routeRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_routes WHERE id = $1::uuid LIMIT 1',
        input.routeId,
      );
    })) as Array<{ ok: number }>;
    if (routeRows.length === 0) {
      throw new BadRequestException('routeId does not match a route in this school');
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO trn_contracted_routes (id, route_id, contractor_id, contract_reference, contract_start_date, contract_end_date, daily_rate, payment_frequency, notes, created_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::numeric, COALESCE($8, 'MONTHLY'), $9, $10::uuid)",
          id,
          input.routeId,
          input.contractorId ?? null,
          input.contractReference ?? null,
          input.contractStartDate,
          input.contractEndDate,
          input.dailyRate ?? null,
          input.paymentFrequency ?? null,
          input.notes ?? null,
          actor.accountId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A contract already exists for this route — only one contract per route is allowed',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    contractId: string,
    input: UpdateContractedRouteDto,
    actor: ResolvedActor,
  ): Promise<ContractedRouteResponseDto> {
    this.assertCanManage(actor);

    const sets: string[] = [];
    const params: unknown[] = [];
    function add(col: string, cast: string, val: unknown): void {
      params.push(val);
      sets.push(col + ' = $' + params.length + cast);
    }
    if (input.contractorId !== undefined) add('contractor_id', '::uuid', input.contractorId);
    if (input.contractReference !== undefined)
      add('contract_reference', '', input.contractReference);
    if (input.contractEndDate !== undefined)
      add('contract_end_date', '::date', input.contractEndDate);
    if (input.dailyRate !== undefined) add('daily_rate', '::numeric', input.dailyRate);
    if (input.paymentFrequency !== undefined) add('payment_frequency', '', input.paymentFrequency);
    if (input.performanceRating !== undefined)
      add('performance_rating', '::numeric', input.performanceRating);
    if (input.isActive !== undefined) add('is_active', '::boolean', input.isActive);
    if (input.notes !== undefined) add('notes', '', input.notes);

    if (sets.length === 0) {
      return this.getById(contractId);
    }
    sets.push('updated_at = now()');
    params.push(contractId);

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE trn_contracted_routes SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.getById(contractId);
  }
}
