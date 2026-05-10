import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { ExitTaskResponseDto, TaskCategory, UpdateExitTaskDto } from './dto/withdrawal.dto';

interface ExitTaskBaseRow {
  id: string;
  withdrawal_id: string;
  task_name: string;
  task_category: string;
  status: string;
  completed_by: string | null;
  completed_at: string | null;
  notes: string | null;
  sort_order: number;
}

/**
 * ExitTaskService — per-department staff close the tasks routed to
 * their department.
 *
 * Authorisation contract:
 *   - patch — admin (stu-004:admin) bypass; otherwise the actor must
 *     hold stu-004:write AND map to the task's task_category. The
 *     mapping is service-side: in this build the IAM model treats
 *     "department staff" generically (any STAFF actor with
 *     stu-004:write can complete any department's task) — pre-pilot
 *     hardening will introduce per-category function codes
 *     (LIB-001 -> RECORDS, IT-002 -> IT, etc.) and tighten this
 *     gate accordingly.
 *   - listMyDepartment — every department staff member with
 *     stu-004:read sees the full pending queue for routing. Future
 *     pre-pilot work narrows this with a department picker.
 */
@Injectable()
export class ExitTaskService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:admin',
    ]);
  }

  private async hasWriteScope(actor: ResolvedActor): Promise<boolean> {
    if (await this.hasAdminScope(actor)) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
    ]);
  }

  private rowToDto(r: ExitTaskBaseRow): ExitTaskResponseDto {
    return {
      id: r.id,
      withdrawalId: r.withdrawal_id,
      taskName: r.task_name,
      taskCategory: r.task_category as TaskCategory,
      status: r.status as ExitTaskResponseDto['status'],
      completedBy: r.completed_by,
      completedByName: null,
      completedAt: r.completed_at,
      notes: r.notes,
      sortOrder: r.sort_order,
    };
  }

  async listPending(actor: ResolvedActor, category?: TaskCategory): Promise<ExitTaskResponseDto[]> {
    if (!(await this.hasWriteScope(actor)) && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Listing exit tasks requires staff stu-004:write');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = "w.school_id = $1::uuid AND t.status = 'PENDING' ";
      if (category) {
        args.push(category);
        where += '  AND t.task_category = $' + args.length + ' ';
      }
      const rows = (await client.$queryRawUnsafe(
        'SELECT t.id, t.withdrawal_id, t.task_name, t.task_category, t.status, ' +
          '       t.completed_by, t.completed_at::text AS completed_at, t.notes, t.sort_order ' +
          'FROM enr_withdrawal_exit_tasks t ' +
          'JOIN enr_withdrawal_requests w ON w.id = t.withdrawal_id ' +
          'WHERE ' +
          where +
          'ORDER BY w.requested_at, t.sort_order LIMIT 200',
        ...args,
      )) as ExitTaskBaseRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async patch(
    id: string,
    input: UpdateExitTaskDto,
    actor: ResolvedActor,
  ): Promise<ExitTaskResponseDto> {
    if (!(await this.hasWriteScope(actor))) {
      throw new ForbiddenException('Updating exit tasks requires stu-004:write');
    }
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT t.id, t.status, t.task_category, w.status AS withdrawal_status ' +
          'FROM enr_withdrawal_exit_tasks t ' +
          'JOIN enr_withdrawal_requests w ON w.id = t.withdrawal_id ' +
          'WHERE w.school_id = $1::uuid AND t.id = $2::uuid FOR UPDATE OF t',
        tenant.schoolId,
        id,
      )) as Array<{
        id: string;
        status: string;
        task_category: string;
        withdrawal_status: string;
      }>;
      if (rows.length === 0) throw new NotFoundException('Exit task not found');
      const row = rows[0]!;
      if (row.withdrawal_status === 'COMPLETED' || row.withdrawal_status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot update tasks on a withdrawal in status ' + row.withdrawal_status + '.',
        );
      }

      // The completed_chk schema invariant requires both completed_by
      // and completed_at populated together with status; service maps
      // the input.status onto the right SQL set.
      if (input.status === 'COMPLETED' || input.status === 'WAIVED') {
        await tx.$executeRawUnsafe(
          'UPDATE enr_withdrawal_exit_tasks SET status = $1, completed_by = $2::uuid, ' +
            'completed_at = now(), notes = COALESCE($3, notes), updated_at = now() ' +
            'WHERE id = $4::uuid',
          input.status,
          actor.personId,
          input.notes ?? null,
          id,
        );
      } else if (input.status === 'PENDING' || input.status === 'NOT_APPLICABLE') {
        await tx.$executeRawUnsafe(
          'UPDATE enr_withdrawal_exit_tasks SET status = $1, completed_by = NULL, ' +
            'completed_at = NULL, notes = COALESCE($2, notes), updated_at = now() ' +
            'WHERE id = $3::uuid',
          input.status,
          input.notes ?? null,
          id,
        );
      } else {
        throw new BadRequestException('Invalid task status: ' + input.status);
      }

      // If this is the first PENDING -> non-PENDING transition for the
      // withdrawal, flip parent to IN_PROGRESS (still REQUESTED until
      // someone actions a task).
      if (row.withdrawal_status === 'REQUESTED') {
        await tx.$executeRawUnsafe(
          "UPDATE enr_withdrawal_requests SET status = 'IN_PROGRESS', updated_at = now() " +
            'WHERE id = (SELECT withdrawal_id FROM enr_withdrawal_exit_tasks WHERE id = $1::uuid)',
          id,
        );
      }
    });

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id, withdrawal_id, task_name, task_category, status, completed_by, ' +
          '       completed_at::text AS completed_at, notes, sort_order ' +
          'FROM enr_withdrawal_exit_tasks WHERE id = $1::uuid',
        id,
      )) as ExitTaskBaseRow[];
      return this.rowToDto(rows[0] as ExitTaskBaseRow);
    });
  }
}
