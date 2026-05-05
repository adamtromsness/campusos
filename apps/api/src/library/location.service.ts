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
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateLocationDto,
  LocationResponseDto,
  LocationType,
  UpdateLocationDto,
} from './dto/library.dto';

interface LocationRow {
  id: string;
  school_id: string;
  name: string;
  location_type: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_LOCATION_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, location_type, ' +
  'sort_order, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_locations ';

function rowToDto(r: LocationRow): LocationResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    locationType: r.location_type as LocationType,
    sortOrder: r.sort_order,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class LocationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Librarian scope: admin OR holds lib-001:write — the canonical
   * librarian signal for catalogue management. The IAM seed grants
   * lib-001:write only to Staff (covering the librarian) so the
   * service can use it as a single test.
   */
  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-001:write',
    ]);
  }

  async list(includeInactive = false): Promise<LocationResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_LOCATION_BASE, 'WHERE school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    if (!includeInactive) sql.push('AND is_active = true ');
    sql.push('ORDER BY sort_order ASC, name ASC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LocationRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async create(input: CreateLocationDto, actor: ResolvedActor): Promise<LocationResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can create library locations');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO lib_locations (id, school_id, name, location_type, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          tenant.schoolId,
          input.name,
          input.locationType,
          input.sortOrder ?? 0,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A library location named "' + input.name + '" already exists in this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateLocationDto,
    actor: ResolvedActor,
  ): Promise<LocationResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can update library locations');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM lib_locations WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Library location ' + id);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.name !== undefined) {
        updates.push('name = $' + idx);
        params.push(input.name);
        idx++;
      }
      if (input.locationType !== undefined) {
        updates.push('location_type = $' + idx);
        params.push(input.locationType);
        idx++;
      }
      if (input.sortOrder !== undefined) {
        updates.push('sort_order = $' + idx);
        params.push(input.sortOrder);
        idx++;
      }
      if (input.isActive !== undefined) {
        updates.push('is_active = $' + idx);
        params.push(input.isActive);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      try {
        await tx.$executeRawUnsafe(
          'UPDATE lib_locations SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A library location with that name already exists in this school',
          );
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<LocationResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LocationRow[]>(
        SELECT_LOCATION_BASE + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Library location ' + id);
    return rowToDto(rows[0]!);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
