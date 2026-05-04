import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ActivityType, TicketActivityResponseDto } from './dto/ticket.dto';

interface ActivityRow {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  actor_first: string | null;
  actor_last: string | null;
  activity_type: string;
  metadata: any;
  created_at: string;
}

const SELECT_ACTIVITY_BASE =
  'SELECT a.id::text AS id, a.ticket_id::text AS ticket_id, ' +
  'a.actor_id::text AS actor_id, ' +
  'p.first_name AS actor_first, p.last_name AS actor_last, ' +
  'a.activity_type, a.metadata, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM tkt_ticket_activity a ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = a.actor_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = pu.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: ActivityRow): TicketActivityResponseDto {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    actorId: r.actor_id,
    actorName: fullName(r.actor_first, r.actor_last),
    activityType: r.activity_type as ActivityType,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

/**
 * Activity log writer + reader. The audit log is **immutable by service-side
 * discipline** per ADR-010 — no UPDATE, no DELETE methods are exposed. The
 * Step 4 TicketService had a private recordActivity helper; Step 5 hoists
 * it here so CommentService and ProblemService can write through the same
 * path. The schema-side guarantee remains the multi-column CHECK on
 * activity_type plus the JSONB metadata default.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Read-only timeline of a ticket's audit log. Row-scoped — admin sees
   * everything; non-admin must be the requester or the assignee on the
   * underlying ticket. The 404 on missing ticket / forbidden access
   * matches the Cycle 7 don't-leak-existence pattern.
   */
  async list(ticketId: string, actor: ResolvedActor): Promise<TicketActivityResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // Row-scope guard. Reuses the requester / assignee predicate from
      // TicketService.getById.
      const tRows = (await client.$queryRawUnsafe(
        'SELECT requester_id::text AS requester_id, assignee_id::text AS assignee_id FROM tkt_tickets WHERE id = $1::uuid LIMIT 1',
        ticketId,
      )) as Array<{ requester_id: string; assignee_id: string | null }>;
      if (tRows.length === 0) throw new NotFoundException('Ticket ' + ticketId);
      const t = tRows[0]!;
      if (!actor.isSchoolAdmin) {
        const isRequester = t.requester_id === actor.accountId;
        const isAssignee = !!actor.employeeId && t.assignee_id === actor.employeeId;
        if (!isRequester && !isAssignee) throw new NotFoundException('Ticket ' + ticketId);
      }
      const rows = await client.$queryRawUnsafe<ActivityRow[]>(
        SELECT_ACTIVITY_BASE + 'WHERE a.ticket_id = $1::uuid ORDER BY a.created_at, a.id',
        ticketId,
      );
      return rows.map(rowToDto);
    });
  }

  /**
   * Write a single activity row. Always called inside an existing
   * tenant transaction so the audit row commits with the side effect
   * that produced it (status flip, comment insert, vendor assignment,
   * etc.). The caller passes the open `tx` they are already inside.
   *
   * Used by TicketService (lifecycle transitions), CommentService
   * (COMMENT entries on every comment write), and ProblemService
   * (REASSIGNMENT entries when problem-resolve batch-flips linked
   * tickets).
   */
  async record(
    tx: any,
    ticketId: string,
    actorId: string | null,
    activityType: ActivityType,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      'INSERT INTO tkt_ticket_activity (id, ticket_id, actor_id, activity_type, metadata) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb)',
      generateId(),
      ticketId,
      actorId,
      activityType,
      JSON.stringify(metadata),
    );
  }
}
