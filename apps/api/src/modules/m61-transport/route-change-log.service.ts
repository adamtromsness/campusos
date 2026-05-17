import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import type { RouteChangeLogResponseDto, RouteChangeLogType } from './dto/transport.dto';

interface RouteChangeLogRow {
  id: string;
  route_id: string;
  changed_by: string;
  changed_by_name: string | null;
  changed_at: Date;
  change_type: string;
  stop_id: string | null;
  student_id: string | null;
  old_value: unknown;
  new_value: unknown;
  reason: string | null;
}

const SELECT_LOG_BASE =
  'SELECT l.id::text AS id, l.route_id::text AS route_id, l.changed_by::text AS changed_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = l.changed_by) AS changed_by_name, ' +
  'l.changed_at, l.change_type, l.stop_id::text AS stop_id, l.student_id::text AS student_id, ' +
  'l.old_value, l.new_value, l.reason ' +
  'FROM trn_route_change_log l ';

function rowToDto(r: RouteChangeLogRow): RouteChangeLogResponseDto {
  return {
    id: r.id,
    routeId: r.route_id,
    changedBy: r.changed_by,
    changedByName: r.changed_by_name,
    changedAt: r.changed_at.toISOString(),
    changeType: r.change_type as RouteChangeLogType,
    stopId: r.stop_id,
    studentId: r.student_id,
    oldValue: r.old_value as Record<string, unknown> | null,
    newValue: r.new_value as Record<string, unknown> | null,
    reason: r.reason,
  };
}

/**
 * Sole writer to trn_route_change_log. IMMUTABLE per ADR-010 — no
 * UPDATE / no DELETE methods exposed at the application layer.
 *
 * Other services call recordChange(tx, ...) inside the same tenant
 * transaction that performs the route mutation, so the log entry
 * lands atomically with the change. Failures roll back together.
 */
@Injectable()
export class RouteChangeLogService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Record a route change inside an open tenant tx. Caller passes the
   * tenant-scoped tx so the log row commits or rolls back with the
   * mutation that triggered it.
   */
  async recordChange(
    tx: Prisma.TransactionClient,
    args: {
      routeId: string;
      changedBy: string;
      changeType: RouteChangeLogType;
      stopId?: string | null;
      studentId?: string | null;
      oldValue?: Record<string, unknown> | null;
      newValue?: Record<string, unknown> | null;
      reason?: string | null;
    },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'INSERT INTO trn_route_change_log (id, route_id, changed_by, change_type, stop_id, student_id, old_value, new_value, reason) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::jsonb, $8::jsonb, $9)',
      generateId(),
      args.routeId,
      args.changedBy,
      args.changeType,
      args.stopId ?? null,
      args.studentId ?? null,
      args.oldValue ? JSON.stringify(args.oldValue) : null,
      args.newValue ? JSON.stringify(args.newValue) : null,
      args.reason ?? null,
    );
  }

  /**
   * Read the change log for a route. Anyone with trn-001:read can
   * read the log on a route they can see; the controller gate +
   * RouteService.assertCanReadRoute composition handles row scope.
   */
  async listForRoute(routeId: string, actor: ResolvedActor): Promise<RouteChangeLogResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only school admins or staff can read the route change log');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_LOG_BASE + 'WHERE l.route_id = $1::uuid ORDER BY l.changed_at DESC LIMIT 500',
        routeId,
      );
    })) as RouteChangeLogRow[];
    return rows.map(rowToDto);
  }

  // No update() / no delete() — IMMUTABLE per ADR-010.
  // Reviewers verify by grep: there are no mutation methods on this class
  // beyond recordChange() which only INSERTs, never UPDATEs.

  async assertRouteExists(routeId: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_routes WHERE id = $1::uuid LIMIT 1',
        routeId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) throw new NotFoundException('Route not found');
  }
}
