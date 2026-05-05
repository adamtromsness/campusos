import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  AlertChannel,
  AlertSeverity,
  AlertTypeResponseDto,
  CreateAlertTypeDto,
  UpdateAlertTypeDto,
} from './dto/emergency-alert.dto';

interface AlertTypeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  severity: string;
  default_channels: string[];
  requires_acknowledgement: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_TYPE =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, severity, ' +
  'default_channels, requires_acknowledgement, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM msg_alert_types ';

function rowToDto(r: AlertTypeRow): AlertTypeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    severity: r.severity as AlertSeverity,
    defaultChannels: r.default_channels as AlertChannel[],
    requiresAcknowledgement: r.requires_acknowledgement,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class AlertTypeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(includeInactive: boolean): Promise<AlertTypeResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql =
      SELECT_TYPE +
      'WHERE school_id = $1::uuid ' +
      (includeInactive ? '' : 'AND is_active = true ') +
      'ORDER BY severity DESC, name ASC';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertTypeRow[]>(sql, tenant.schoolId);
    });
    return rows.map(rowToDto);
  }

  async loadActiveOrFail(id: string): Promise<AlertTypeResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertTypeRow[]>(
        SELECT_TYPE + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Alert type not found');
    if (!rows[0]!.is_active) {
      throw new BadRequestException(
        'Alert type "' + rows[0]!.name + '" is inactive. Reactivate before issuing alerts.',
      );
    }
    return rowToDto(rows[0]!);
  }

  async create(input: CreateAlertTypeDto, actor: ResolvedActor): Promise<AlertTypeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create alert types');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO msg_alert_types (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, true)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.severity,
          input.defaultChannels,
          input.requiresAcknowledgement ?? false,
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException(
          'An alert type named "' + input.name + '" already exists in this school.',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertTypeRow[]>(SELECT_TYPE + 'WHERE id = $1::uuid', id);
    });
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateAlertTypeDto,
    actor: ResolvedActor,
  ): Promise<AlertTypeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can edit alert types');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push('name = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.severity !== undefined) {
      params.push(input.severity);
      sets.push('severity = $' + params.length);
    }
    if (input.defaultChannels !== undefined) {
      params.push(input.defaultChannels);
      sets.push('default_channels = $' + params.length + '::text[]');
    }
    if (input.requiresAcknowledgement !== undefined) {
      params.push(input.requiresAcknowledgement);
      sets.push('requires_acknowledgement = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<AlertTypeRow[]>(SELECT_TYPE + 'WHERE id = $1::uuid', id);
      });
      if (rows.length === 0) throw new NotFoundException('Alert type not found');
      return rowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    try {
      const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE msg_alert_types SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
      if (updated === 0) throw new NotFoundException('Alert type not found');
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException(
          'An alert type with that name already exists in this school.',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertTypeRow[]>(SELECT_TYPE + 'WHERE id = $1::uuid', id);
    });
    return rowToDto(rows[0]!);
  }
}
