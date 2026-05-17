import {
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
  CreateSustainabilityInitiativeDto,
  SustainabilityCategory,
  SustainabilityInitiativeResponseDto,
  SustainabilityStatus,
  UpdateSustainabilityInitiativeDto,
} from './dto/facilities.dto';

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}

/**
 * SustainabilityService — P2-18b Step 4.
 *
 * CRUD for sustainability initiatives + the dashboard endpoint that
 * surfaces ACTIVE initiatives ordered by start_date DESC.
 */
@Injectable()
export class SustainabilityService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async list(args: {
    status?: SustainabilityStatus;
    category?: SustainabilityCategory;
  }): Promise<SustainabilityInitiativeResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['s.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      where.push('s.status = $' + (params.length + 1));
      params.push(args.status);
    }
    if (args.category) {
      where.push('s.category = $' + (params.length + 1));
      params.push(args.category);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SUST_SELECT + 'WHERE ' + where.join(' AND ') + ' ORDER BY s.start_date DESC',
        ...params,
      );
    })) as SustRow[];
    return rows.map(sustRowToDto);
  }

  async getById(id: string): Promise<SustainabilityInitiativeResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SUST_SELECT + 'WHERE s.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    })) as SustRow[];
    if (rows.length === 0) throw new NotFoundException('Initiative not found in this school');
    return sustRowToDto(rows[0]!);
  }

  async create(
    input: CreateSustainabilityInitiativeDto,
    actor: ResolvedActor,
  ): Promise<SustainabilityInitiativeResponseDto> {
    await assertCanManage(actor, this.permCheck);
    if (!actor.personId) {
      throw new ForbiddenException('Initiative creation requires an authenticated person');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fac_sustainability_initiatives ' +
            '(id, school_id, name, description, category, start_date, target_completion_date, target_reduction_percent, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.category,
          input.startDate,
          input.targetCompletionDate ?? null,
          input.targetReductionPercent ?? null,
          actor.personId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException(
          'An initiative named "' + input.name + '" already exists in this school.',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateSustainabilityInitiativeDto,
    actor: ResolvedActor,
  ): Promise<SustainabilityInitiativeResponseDto> {
    await assertCanManage(actor, this.permCheck);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.outcomeNotes !== undefined) {
      sets.push('outcome_notes = $' + (params.length + 1));
      params.push(input.outcomeNotes);
    }
    if (input.targetCompletionDate !== undefined) {
      sets.push('target_completion_date = $' + (params.length + 1) + '::date');
      params.push(input.targetCompletionDate);
    }
    if (input.targetReductionPercent !== undefined) {
      sets.push('target_reduction_percent = $' + (params.length + 1));
      params.push(input.targetReductionPercent);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id, tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fac_sustainability_initiatives SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('Another initiative already uses that name.');
      }
      throw err;
    }
    return this.getById(id);
  }

  async dashboard(): Promise<SustainabilityInitiativeResponseDto[]> {
    return this.list({ status: 'ACTIVE' });
  }
}

const SUST_SELECT =
  'SELECT s.id::text AS id, s.school_id::text AS school_id, s.name, s.description, ' +
  's.category, s.start_date::text AS start_date, ' +
  's.target_completion_date::text AS target_completion_date, ' +
  's.target_reduction_percent::float AS target_reduction_percent, s.status, s.outcome_notes, ' +
  's.created_by::text AS created_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip WHERE ip.id = s.created_by) AS created_by_name " +
  'FROM fac_sustainability_initiatives s ';

interface SustRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  category: string;
  start_date: string;
  target_completion_date: string | null;
  target_reduction_percent: number | null;
  status: string;
  outcome_notes: string | null;
  created_by: string;
  created_by_name: string | null;
}

function sustRowToDto(r: SustRow): SustainabilityInitiativeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    category: r.category as SustainabilityCategory,
    startDate: r.start_date,
    targetCompletionDate: r.target_completion_date,
    targetReductionPercent: r.target_reduction_percent,
    status: r.status as SustainabilityStatus,
    outcomeNotes: r.outcome_notes,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
  };
}
