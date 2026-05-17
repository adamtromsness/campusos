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
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreateIncidentTypeDto,
  IncidentSeverity,
  IncidentTypeDto,
  UpdateIncidentTypeDto,
} from './dto/incident.dto';

interface TypeRow {
  id: string;
  school_id: string | null;
  code: string;
  name: string;
  severity: string;
  requires_lockdown: boolean;
  notification_template: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_TYPE_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, code, name, severity, ' +
  '       requires_lockdown, notification_template, is_active, ' +
  '       created_at::text AS created_at, updated_at::text AS updated_at ' +
  'FROM inc_incident_types ';

@Injectable()
export class IncidentTypeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive = false): Promise<IncidentTypeDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? '(school_id IS NULL OR school_id = $1::uuid)'
        : '(school_id IS NULL OR school_id = $1::uuid) AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_TYPE_BASE + 'WHERE ' + where + ' ORDER BY severity DESC, code',
        tenant.schoolId,
      )) as TypeRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<IncidentTypeDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_TYPE_BASE +
          'WHERE id = $1::uuid AND (school_id IS NULL OR school_id = $2::uuid) LIMIT 1',
        id,
        tenant.schoolId,
      )) as TypeRow[];
      if (rows.length === 0) throw new NotFoundException('Incident type not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateIncidentTypeDto, actor: ResolvedActor): Promise<IncidentTypeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO inc_incident_types ' +
            '(id, school_id, code, name, severity, requires_lockdown, notification_template) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
          id,
          tenant.schoolId,
          input.code,
          input.name,
          input.severity,
          input.requiresLockdown ?? false,
          input.notificationTemplate ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'Incident type code "' + input.code + '" already exists for this school',
          );
        }
        throw err;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_TYPE_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as TypeRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(
    id: string,
    input: UpdateIncidentTypeDto,
    actor: ResolvedActor,
  ): Promise<IncidentTypeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id FROM inc_incident_types ' +
          'WHERE id = $1::uuid AND (school_id IS NULL OR school_id = $2::uuid) FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; school_id: string | null }>;
      if (lock.length === 0) throw new NotFoundException('Incident type not found');

      // Schools may patch only their own rows. Platform default rows (school_id IS NULL)
      // are read-only at the tenant API; cross-tenant edits would require a platform-tier
      // surface that this cycle does not ship.
      if (lock[0]!.school_id === null) {
        throw new ForbiddenException('Platform default incident types are read-only.');
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (sql: string, value: unknown) => {
        sets.push(sql + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.name !== undefined) push('name', input.name);
      if (input.severity !== undefined) push('severity', input.severity);
      if (input.requiresLockdown !== undefined) push('requires_lockdown', input.requiresLockdown);
      if (input.notificationTemplate !== undefined)
        push('notification_template', input.notificationTemplate);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_TYPE_BASE + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as TypeRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(id, tenant.schoolId);
      await tx.$executeRawUnsafe(
        'UPDATE inc_incident_types SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          n +
          '::uuid AND school_id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );

      const rows = (await tx.$queryRawUnsafe(
        SELECT_TYPE_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as TypeRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:admin',
      'saf-003:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Incident type catalogue management requires saf-001:admin or saf-003:admin.',
      );
    }
  }

  private rowToDto(r: TypeRow): IncidentTypeDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      code: r.code,
      name: r.name,
      severity: r.severity as IncidentSeverity,
      requiresLockdown: r.requires_lockdown,
      notificationTemplate: r.notification_template,
      isActive: r.is_active,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === 'P2010' || code === '23505') return true;
  const meta = (err as { meta?: { code?: string } }).meta;
  if (meta && meta.code === '23505') return true;
  const msg = (err as { message?: string }).message;
  if (typeof msg === 'string' && msg.includes('23505')) return true;
  return false;
}
