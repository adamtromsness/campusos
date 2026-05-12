import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreateOpsEmployeeDto,
  GrantPermissionDto,
  OpsEmployeeDto,
  OpsPermissionDto,
  OpsPermissionScope,
  PatchOpsEmployeeDto,
  OpsDepartment,
} from '../dto/ops.dto';

/**
 * P2-21b — OpsEmployeeService.
 *
 * CRUD over ops_employees + permission grant management on
 * ops_permissions. Used by:
 *  - The /internal/employees admin surface.
 *  - TenantAccessService.assertApproverHasInternalAdmin (verifies the
 *    approver holds INTERNAL_ADMIN at grant time).
 *  - All other internal services that need to validate the calling
 *    operator has a particular ops scope.
 *
 * Soft FK to platform.iam_person via person_id (UNIQUE — one
 * ops_employees row per canonical identity).
 */
@Injectable()
export class OpsEmployeeService {
  constructor(private readonly platform: PrismaClient) {}

  // ── Reads ─────────────────────────────────────────────────────────

  async list(
    args: { department?: OpsDepartment; includeInactive?: boolean } = {},
  ): Promise<OpsEmployeeDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.department) {
      params.push(args.department);
      where.push(`department = $${params.length}`);
    }
    if (!args.includeInactive) {
      where.push('is_active = true');
    }
    const whereSql = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
    const rows = await this.platform.$queryRawUnsafe<RawEmployeeRow[]>(
      `SELECT id::text, person_id::text, department, role, hire_date::text,
              is_active, created_at, updated_at
         FROM platform.ops_employees
         ${whereSql}
         ORDER BY hire_date DESC
         LIMIT 500`,
      ...params,
    );
    return rows.map(rowToOpsEmployeeDto);
  }

  async getById(id: string): Promise<OpsEmployeeDto> {
    return rowToOpsEmployeeDto(await this.loadOrFail(id));
  }

  async listPermissions(employeeId: string): Promise<OpsPermissionDto[]> {
    await this.loadOrFail(employeeId);
    const rows = await this.platform.$queryRawUnsafe<RawPermissionRow[]>(
      `SELECT id::text, employee_id::text, scope, granted_by::text, granted_at
         FROM platform.ops_permissions WHERE employee_id = $1::uuid
         ORDER BY granted_at DESC`,
      employeeId,
    );
    return rows.map(rowToPermissionDto);
  }

  // ── Writes ────────────────────────────────────────────────────────

  async create(input: CreateOpsEmployeeDto): Promise<OpsEmployeeDto> {
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.ops_employees
          (id, person_id, department, role, hire_date)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::date)`,
        id,
        input.personId,
        input.department,
        input.role,
        input.hireDate,
      );
    } catch (e: unknown) {
      throw translateUniqueViolation(e, 'An ops_employees row already exists for this person_id.');
    }
    return this.getById(id);
  }

  async patch(id: string, input: PatchOpsEmployeeDto): Promise<OpsEmployeeDto> {
    await this.loadOrFail(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };
    if (input.department !== undefined) push('department = $$', input.department);
    if (input.role !== undefined) push('role = $$', input.role);
    if (input.isActive !== undefined) push('is_active = $$', input.isActive);

    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.ops_employees SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return this.getById(id);
  }

  async grantPermission(
    employeeId: string,
    grantedBy: string,
    input: GrantPermissionDto,
  ): Promise<OpsPermissionDto> {
    await this.loadOrFail(employeeId);
    await this.loadOrFail(grantedBy);
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.ops_permissions (id, employee_id, scope, granted_by)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid)`,
        id,
        employeeId,
        input.scope,
        grantedBy,
      );
    } catch (e: unknown) {
      throw translateUniqueViolation(e, `Employee already holds the ${input.scope} scope.`);
    }
    const rows = await this.platform.$queryRawUnsafe<RawPermissionRow[]>(
      `SELECT id::text, employee_id::text, scope, granted_by::text, granted_at
         FROM platform.ops_permissions WHERE id = $1::uuid`,
      id,
    );
    return rowToPermissionDto(rows[0]!);
  }

  async revokePermission(permissionId: string): Promise<void> {
    const result = await this.platform.$executeRawUnsafe(
      `DELETE FROM platform.ops_permissions WHERE id = $1::uuid`,
      permissionId,
    );
    if (result === 0) {
      throw new NotFoundException(`ops_permissions ${permissionId} not found.`);
    }
  }

  /**
   * Resolve whether an employee currently holds a specific ops scope.
   * Used by TenantAccessService to verify approver has INTERNAL_ADMIN
   * before issuing a tenant access grant.
   */
  async hasScope(employeeId: string, scope: OpsPermissionScope): Promise<boolean> {
    const rows = await this.platform.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count FROM platform.ops_permissions
         WHERE employee_id = $1::uuid AND scope = $2`,
      employeeId,
      scope,
    );
    return (rows[0]?.count ?? 0) > 0;
  }

  // ── Internals ─────────────────────────────────────────────────────

  async loadOrFail(id: string): Promise<RawEmployeeRow> {
    const rows = await this.platform.$queryRawUnsafe<RawEmployeeRow[]>(
      `SELECT id::text, person_id::text, department, role, hire_date::text,
              is_active, created_at, updated_at
         FROM platform.ops_employees WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`ops_employees ${id} not found.`);
    }
    return rows[0]!;
  }
}

// ── Helpers + row mappers ────────────────────────────────────────────

function translateUniqueViolation(e: unknown, message: string): unknown {
  const err = e as { code?: string; meta?: { code?: string }; message?: string };
  if (
    err?.code === 'P2002' ||
    err?.meta?.code === '23505' ||
    err?.code === 'P2010' ||
    (typeof err?.message === 'string' && err.message.includes('23505'))
  ) {
    return new ConflictException(message);
  }
  // Surface schema CHECK violations as 400 with the constraint name so
  // the UI / CAT can see exactly which invariant tripped.
  if (typeof err?.message === 'string' && err.message.includes('23514')) {
    return new BadRequestException(message + ' (CHECK constraint violation)');
  }
  return e;
}

interface RawEmployeeRow {
  id: string;
  person_id: string;
  department: string;
  role: string;
  hire_date: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RawPermissionRow {
  id: string;
  employee_id: string;
  scope: string;
  granted_by: string;
  granted_at: Date;
}

export function rowToOpsEmployeeDto(row: RawEmployeeRow): OpsEmployeeDto {
  return {
    id: row.id,
    personId: row.person_id,
    department: row.department as OpsDepartment,
    role: row.role,
    hireDate: row.hire_date,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function rowToPermissionDto(row: RawPermissionRow): OpsPermissionDto {
  return {
    id: row.id,
    employeeId: row.employee_id,
    scope: row.scope as OpsPermissionScope,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at.toISOString(),
  };
}
