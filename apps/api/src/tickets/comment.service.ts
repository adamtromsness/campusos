import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { ActivityService } from './activity.service';
import { CreateCommentDto, TicketCommentResponseDto } from './dto/ticket.dto';

interface CommentRow {
  id: string;
  ticket_id: string;
  author_id: string;
  author_first: string | null;
  author_last: string | null;
  body: string;
  is_internal: boolean;
  created_at: string;
}

const SELECT_COMMENT_BASE =
  'SELECT c.id::text AS id, c.ticket_id::text AS ticket_id, ' +
  'c.author_id::text AS author_id, ' +
  'p.first_name AS author_first, p.last_name AS author_last, ' +
  'c.body, c.is_internal, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM tkt_ticket_comments c ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = c.author_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = pu.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: CommentRow): TicketCommentResponseDto {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    authorId: r.author_id,
    authorName: fullName(r.author_first, r.author_last),
    body: r.body,
    isInternal: r.is_internal,
    createdAt: r.created_at,
  };
}

interface TicketStub {
  requesterId: string;
  assigneeId: string | null;
  status: string;
  firstResponseAt: string | null;
}

@Injectable()
export class CommentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * List comments on a ticket, oldest-first (matches the seed convention
   * and the typical conversation render order).
   *
   * Visibility model:
   *   - Admins see every comment.
   *   - The assignee on the ticket sees every comment (they need the
   *     internal staff thread to do their job).
   *   - The requester sees only `is_internal = false` rows.
   *   - Non-participant non-admins fail with 404 (don't leak existence
   *     of the ticket — same convention as TicketService.getById).
   */
  async list(
    ticketId: string,
    actor: ResolvedActor,
  ): Promise<TicketCommentResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const t = await this.loadTicketStub(client, ticketId);
      const role = this.scopeRole(t, actor);
      if (role === null) throw new NotFoundException('Ticket ' + ticketId);
      const sql =
        SELECT_COMMENT_BASE +
        'WHERE c.ticket_id = $1::uuid ' +
        (role === 'requester' ? 'AND c.is_internal = false ' : '') +
        'ORDER BY c.created_at, c.id';
      const rows = await client.$queryRawUnsafe<CommentRow[]>(sql, ticketId);
      return rows.map(rowToDto);
    });
  }

  /**
   * Post a new comment. Allowed by the requester, the assignee, or any
   * admin. Non-participants get 404 to match the row-scope read pattern.
   *
   * `is_internal=true` is staff-only — requesters who try to set it are
   * silently demoted to public. (We could 400 instead, but silently
   * demoting matches the requester's mental model: "I posted a comment,
   * here it is." Internal/public is a staff-side concern.)
   *
   * Side effects, all in one open `executeInTenantTransaction`:
   *   1. INSERT into `tkt_ticket_comments`.
   *   2. If this is the first staff comment on the ticket and
   *      `first_response_at` is currently NULL, bump it to now() so the
   *      SLA response clock stops. Staff = anyone other than the
   *      requester (assignee or admin).
   *   3. Activity row of type COMMENT with metadata `{is_internal}`.
   *
   * Outside the tx (best-effort): emit `tkt.ticket.commented` so the
   * Step 6 TicketNotificationConsumer can fan out a notification to the
   * other side of the conversation (requester → assignee, assignee →
   * requester) via the Cycle 3 NotificationQueueService.
   */
  async post(
    ticketId: string,
    input: CreateCommentDto,
    actor: ResolvedActor,
  ): Promise<TicketCommentResponseDto> {
    const tenant = getCurrentTenant();
    const commentId = generateId();
    let firstResponseBumped = false;
    let isInternalFinal = false;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const t = await this.loadTicketStub(tx, ticketId);
      const role = this.scopeRole(t, actor);
      if (role === null) throw new NotFoundException('Ticket ' + ticketId);
      if (t.status === 'CLOSED' || t.status === 'CANCELLED') {
        // Hard-stop on terminal tickets — comments on a closed ticket
        // should reopen first.
        throw new ForbiddenException(
          'Cannot comment on a ticket in status ' + t.status + '; reopen it first',
        );
      }

      // Demote internal flag for non-staff posters.
      const wantsInternal = !!input.isInternal;
      const canSetInternal = role !== 'requester';
      isInternalFinal = wantsInternal && canSetInternal;

      await tx.$executeRawUnsafe(
        'INSERT INTO tkt_ticket_comments (id, ticket_id, author_id, body, is_internal) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        commentId,
        ticketId,
        actor.accountId,
        input.body,
        isInternalFinal,
      );

      // First-response bump. Only staff comments stop the SLA response
      // clock — a requester self-replying does not count.
      if (role !== 'requester' && t.firstResponseAt === null) {
        await tx.$executeRawUnsafe(
          'UPDATE tkt_tickets SET first_response_at = now(), updated_at = now() WHERE id = $1::uuid',
          ticketId,
        );
        firstResponseBumped = true;
      } else {
        // Touch updated_at so list views resort by recent activity.
        await tx.$executeRawUnsafe(
          'UPDATE tkt_tickets SET updated_at = now() WHERE id = $1::uuid',
          ticketId,
        );
      }

      await this.activity.record(tx, ticketId, actor.accountId, 'COMMENT', {
        is_internal: isInternalFinal,
        first_response_bump: firstResponseBumped,
      });
    });

    void this.kafka.emit({
      topic: 'tkt.ticket.commented',
      key: ticketId,
      sourceModule: 'tickets',
      payload: {
        ticketId,
        schoolId: tenant.schoolId,
        commentId,
        authorId: actor.accountId,
        isInternal: isInternalFinal,
        firstResponseBumped,
        sourceRefId: ticketId,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });

    return this.loadOrFail(commentId);
  }

  /**
   * Internal helper used by ProblemService.resolveBatch (and any future
   * caller that needs an audit-only comment without going through the
   * full POST path). Writes the row + activity entry inside the supplied
   * tx — caller is responsible for the kafka emit if they want one.
   */
  async writeInTx(
    tx: any,
    ticketId: string,
    authorId: string,
    body: string,
    isInternal: boolean,
  ): Promise<string> {
    const commentId = generateId();
    await tx.$executeRawUnsafe(
      'INSERT INTO tkt_ticket_comments (id, ticket_id, author_id, body, is_internal) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
      commentId,
      ticketId,
      authorId,
      body,
      isInternal,
    );
    await this.activity.record(tx, ticketId, authorId, 'COMMENT', { is_internal: isInternal });
    return commentId;
  }

  private async loadTicketStub(
    client: any,
    ticketId: string,
  ): Promise<TicketStub> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT requester_id::text AS requester_id, assignee_id::text AS assignee_id, status, ' +
        'TO_CHAR(first_response_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS first_response_at ' +
        'FROM tkt_tickets WHERE id = $1::uuid LIMIT 1',
      ticketId,
    )) as Array<{
      requester_id: string;
      assignee_id: string | null;
      status: string;
      first_response_at: string | null;
    }>;
    if (rows.length === 0) throw new NotFoundException('Ticket ' + ticketId);
    return {
      requesterId: rows[0]!.requester_id,
      assigneeId: rows[0]!.assignee_id,
      status: rows[0]!.status,
      firstResponseAt: rows[0]!.first_response_at,
    };
  }

  /**
   * Determines the caller's relationship to the ticket. Returns null
   * when the caller is not a participant and not an admin (which the
   * caller translates to a 404 to avoid leaking existence).
   */
  private scopeRole(
    t: TicketStub,
    actor: ResolvedActor,
  ): 'admin' | 'requester' | 'assignee' | null {
    if (actor.isSchoolAdmin) return 'admin';
    if (t.requesterId === actor.accountId) return 'requester';
    if (!!actor.employeeId && t.assigneeId === actor.employeeId) return 'assignee';
    return null;
  }

  private async loadOrFail(id: string): Promise<TicketCommentResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CommentRow[]>(
        SELECT_COMMENT_BASE + 'WHERE c.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Comment ' + id);
    return rowToDto(rows[0]!);
  }
}
