import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { generateId } from '@campusos/database';
import {
  AddToPoolDto,
  SchoolPoolMemberResponseDto,
  UpdatePoolMemberDto,
} from './dto/substitutes.dto';

interface PoolRow {
  id: string;
  substitute_id: string;
  substitute_name: string | null;
  overall_rating: string | null;
  status: string;
  suspended_until: string | null;
  suspension_reason: string | null;
  added_at: string;
}

const SELECT_POOL_BASE = `
  SELECT p.id::text AS id,
         p.substitute_id::text AS substitute_id,
         sp.display_name AS substitute_name,
         sp.overall_rating::text AS overall_rating,
         p.status,
         p.suspended_until::text AS suspended_until,
         p.suspension_reason,
         TO_CHAR(p.added_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS added_at
  FROM sub_school_pool p
  LEFT JOIN platform.platform_substitute_profiles sp ON sp.id = p.substitute_id
`;

/**
 * SchoolPoolService — P2-9 Step 6.
 *
 * Manages each school's curated pool of substitutes (sub_school_pool).
 * Admin-only writes — POST adds a substitute, PATCH suspends or removes.
 * Reads gated on sch-004:read for visibility into the school's pool.
 */
@Injectable()
export class SchoolPoolService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sch-004:write',
    ]);
  }

  async list(actor: ResolvedActor): Promise<SchoolPoolMemberResponseDto[]> {
    void actor; // controller-level @RequirePermission gates the read
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POOL_BASE + ' WHERE p.school_id = $1::uuid ORDER BY sp.display_name ASC',
        tenant.schoolId,
      )) as PoolRow[];
      return rows.map(this.rowToDto);
    });
  }

  async addToPool(input: AddToPoolDto, actor: ResolvedActor): Promise<SchoolPoolMemberResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can add substitutes to the pool.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO sub_school_pool (id, school_id, substitute_id, status, added_by, notes)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', $4::uuid, $5)`,
          id,
          tenant.schoolId,
          input.substituteId,
          actor.employeeId,
          input.notes ?? null,
        );
      } catch (e) {
        if (
          (e as { code?: string }).code === 'P2010' &&
          String(e).includes('sub_school_pool_school_sub_uq')
        ) {
          throw new ForbiddenException('Substitute is already in this school pool.');
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_POOL_BASE + ' WHERE p.id = $1::uuid',
        id,
      )) as PoolRow[];
      if (rows.length === 0) throw new NotFoundException('Pool entry not found after insert');
      return this.rowToDto(rows[0]!);
    });
  }

  async updatePoolMember(
    id: string,
    input: UpdatePoolMemberDto,
    actor: ResolvedActor,
  ): Promise<SchoolPoolMemberResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can update pool members.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        'SELECT id FROM sub_school_pool WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Pool entry not found');

      const updates: string[] = [];
      const params: unknown[] = [];
      let pIndex = 1;

      if (input.status !== undefined) {
        updates.push(`status = $${pIndex}`);
        params.push(input.status);
        pIndex++;

        if (input.status === 'SUSPENDED') {
          updates.push(`suspended_until = $${pIndex}::date`);
          params.push(input.suspendedUntil ?? null);
          pIndex++;
          updates.push(`suspension_reason = $${pIndex}`);
          params.push(input.suspensionReason ?? 'Manually suspended');
          pIndex++;
        } else {
          // Clear suspension fields on transitions away from SUSPENDED.
          updates.push('suspended_until = NULL');
          updates.push('suspension_reason = NULL');
        }
      } else if (input.suspendedUntil || input.suspensionReason) {
        if (input.suspendedUntil) {
          updates.push(`suspended_until = $${pIndex}::date`);
          params.push(input.suspendedUntil);
          pIndex++;
        }
        if (input.suspensionReason) {
          updates.push(`suspension_reason = $${pIndex}`);
          params.push(input.suspensionReason);
          pIndex++;
        }
      }

      if (updates.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_POOL_BASE + ' WHERE p.id = $1::uuid',
          id,
        )) as PoolRow[];
        return this.rowToDto(rows[0]!);
      }

      updates.push('updated_at = now()');
      params.push(id);

      await tx.$executeRawUnsafe(
        `UPDATE sub_school_pool SET ${updates.join(', ')} WHERE id = $${pIndex}::uuid`,
        ...params,
      );
      const rows = (await tx.$queryRawUnsafe(
        SELECT_POOL_BASE + ' WHERE p.id = $1::uuid',
        id,
      )) as PoolRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private rowToDto = (r: PoolRow): SchoolPoolMemberResponseDto => ({
    id: r.id,
    substituteId: r.substitute_id,
    substituteName: r.substitute_name,
    overallRating: r.overall_rating,
    status: r.status as SchoolPoolMemberResponseDto['status'],
    suspendedUntil: r.suspended_until,
    suspensionReason: r.suspension_reason,
    addedAt: r.added_at,
  });
}
