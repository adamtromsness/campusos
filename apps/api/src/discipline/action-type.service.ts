import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  ActionTypeResponseDto,
  CreateActionTypeDto,
  UpdateActionTypeDto,
} from './dto/discipline.dto';

interface ActionTypeRow {
  id: string;
  school_id: string;
  name: string;
  requires_parent_notification: boolean;
  description: string | null;
  is_active: boolean;
}

const SELECT_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, requires_parent_notification, description, is_active ' +
  'FROM sis_discipline_action_types ';

function rowToDto(r: ActionTypeRow): ActionTypeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    requiresParentNotification: r.requires_parent_notification,
    description: r.description,
    isActive: r.is_active,
  };
}

@Injectable()
export class ActionTypeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(includeInactive: boolean): Promise<ActionTypeResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + (includeInactive ? '' : 'WHERE is_active = true ') + 'ORDER BY name',
      )) as ActionTypeRow[];
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<ActionTypeResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE id = $1::uuid',
        id,
      )) as ActionTypeRow[];
      if (rows.length === 0) throw new NotFoundException('Action type ' + id);
      return rowToDto(rows[0]!);
    });
  }

  async create(input: CreateActionTypeDto): Promise<ActionTypeResponseDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO sis_discipline_action_types (id, school_id, name, requires_parent_notification, description) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          tenant.schoolId,
          input.name,
          input.requiresParentNotification ?? false,
          input.description ?? null,
        );
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('An action type with this name already exists');
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  async update(id: string, input: UpdateActionTypeDto): Promise<ActionTypeResponseDto> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(input.name);
      idx++;
    }
    if (input.requiresParentNotification !== undefined) {
      sets.push('requires_parent_notification = $' + idx);
      params.push(input.requiresParentNotification);
      idx++;
    }
    if (input.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        const result = (await client.$executeRawUnsafe(
          'UPDATE sis_discipline_action_types SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            idx +
            '::uuid',
          ...params,
        )) as number;
        if (result === 0) throw new NotFoundException('Action type ' + id);
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('An action type with this name already exists');
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  /**
   * Internal helper used by ActionService when assigning a consequence.
   * Returns the action type row plus its parent-notification flag for the
   * fan-out path.
   */
  async assertActive(id: string): Promise<ActionTypeResponseDto> {
    const dto = await this.getById(id);
    if (!dto.isActive) {
      throw new BadRequestException('Action type ' + id + ' is not active');
    }
    return dto;
  }

  private isUniqueViolation(err: unknown): boolean {
    const errObj = err as { code?: string; meta?: { code?: string }; message?: string };
    return (
      errObj?.code === 'P2010' ||
      errObj?.meta?.code === '23505' ||
      (typeof errObj?.message === 'string' && errObj.message.includes('23505'))
    );
  }
}
