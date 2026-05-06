import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ActionItemResponseDto,
  ActionItemStatus,
  CreateActionItemDto,
  UpdateActionItemDto,
} from './dto/meeting.dto';
import { MeetingService } from './meeting.service';

interface ActionItemRow {
  id: string;
  meeting_id: string;
  meeting_title: string | null;
  assignee_id: string;
  assignee_name: string | null;
  description: string;
  due_date: string | null;
  status: string;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ACTION =
  'SELECT a.id::text AS id, a.meeting_id::text AS meeting_id, ' +
  '(SELECT title FROM mtg_meetings WHERE id = a.meeting_id) AS meeting_title, ' +
  'a.assignee_id::text AS assignee_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = a.assignee_id) AS assignee_name, ' +
  "a.description, TO_CHAR(a.due_date, 'YYYY-MM-DD') AS due_date, " +
  'a.status, ' +
  'TO_CHAR(a.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'a.created_by::text AS created_by, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_action_items a ';

function rowToDto(r: ActionItemRow): ActionItemResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    meetingTitle: r.meeting_title,
    assigneeId: r.assignee_id,
    assigneeName: r.assignee_name,
    description: r.description,
    dueDate: r.due_date,
    status: r.status as ActionItemStatus,
    completedAt: r.completed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class ActionItemService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly meetings: MeetingService,
  ) {}

  /**
   * "My action items" — assignee_id = me. Used by the parent and
   * teacher dashboards.
   */
  async listMine(
    actor: ResolvedActor,
    statusFilter?: ActionItemStatus,
  ): Promise<ActionItemResponseDto[]> {
    const sql: string[] = [SELECT_ACTION, 'WHERE a.assignee_id = $1::uuid '];
    const params: unknown[] = [actor.accountId];
    if (statusFilter) {
      params.push(statusFilter);
      sql.push('AND a.status = $' + params.length + ' ');
    }
    sql.push('ORDER BY a.due_date NULLS LAST, a.created_at DESC LIMIT 200');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql.join(''), ...params);
    })) as ActionItemRow[];
    return rows.map(rowToDto);
  }

  async listForMeeting(meetingId: string, actor: ResolvedActor): Promise<ActionItemResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      const ok = await this.meetings.isParticipantOrOrganiser(meetingId, actor.accountId);
      if (!ok) throw new NotFoundException('Meeting not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ACTION + 'WHERE a.meeting_id = $1::uuid ORDER BY a.created_at ASC',
        meetingId,
      );
    })) as ActionItemRow[];
    return rows.map(rowToDto);
  }

  async create(
    meetingId: string,
    input: CreateActionItemDto,
    actor: ResolvedActor,
  ): Promise<ActionItemResponseDto> {
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO mtg_action_items (id, meeting_id, assignee_id, description, due_date, status, completed_at, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, 'OPEN', NULL, $6::uuid)",
        id,
        meetingId,
        input.assigneeId,
        input.description,
        input.dueDate ?? null,
        actor.accountId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ACTION + 'WHERE a.id = $1::uuid', id);
    })) as ActionItemRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateActionItemDto,
    actor: ResolvedActor,
  ): Promise<ActionItemResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, meeting_id::text AS meeting_id, assignee_id::text AS assignee_id FROM mtg_action_items WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; meeting_id: string; assignee_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Action item not found');

      // Authorisation — assignee may update status and due date on own item.
      // Organiser/admin may update anything.
      const isAssignee = lock[0]!.assignee_id === actor.accountId;
      let isOrganiserOrAdmin = actor.isSchoolAdmin;
      if (!isOrganiserOrAdmin) {
        const m = (await tx.$queryRawUnsafe(
          'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
          lock[0]!.meeting_id,
        )) as Array<{ organiser_id: string }>;
        isOrganiserOrAdmin = m.length > 0 && m[0]!.organiser_id === actor.accountId;
      }
      if (!isAssignee && !isOrganiserOrAdmin) {
        throw new ForbiddenException(
          'Only the assignee, the meeting organiser, or an admin can update this action item',
        );
      }
      // Assignee-only path may not change the description
      if (!isOrganiserOrAdmin && input.description !== undefined) {
        throw new ForbiddenException('Only the organiser or admin can edit the description');
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (input.description !== undefined) {
        params.push(input.description);
        sets.push('description = $' + params.length);
      }
      if (input.dueDate !== undefined) {
        params.push(input.dueDate);
        sets.push('due_date = $' + params.length + '::date');
      }
      if (input.status !== undefined) {
        params.push(input.status);
        sets.push('status = $' + params.length);
        if (input.status === 'DONE' || input.status === 'CANCELLED') {
          sets.push('completed_at = COALESCE(completed_at, now())');
        } else {
          sets.push('completed_at = NULL');
        }
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE mtg_action_items SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === '23514') {
          throw new BadRequestException('Action item update violates a CHECK constraint');
        }
        throw e;
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ACTION + 'WHERE a.id = $1::uuid', id);
    })) as ActionItemRow[];
    return rowToDto(rows[0]!);
  }
}
