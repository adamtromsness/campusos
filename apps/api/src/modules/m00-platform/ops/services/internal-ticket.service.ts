import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreateInternalTicketDto,
  CreateTicketCommentDto,
  InternalTicketCommentDto,
  InternalTicketDto,
  ListInternalTicketsArgs,
  PatchInternalTicketDto,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from '../dto/ops.dto';
import { OpsEmployeeService } from './ops-employee.service';

/**
 * P2-21b — InternalTicketService.
 *
 * CRUD + comments over ops_internal_tickets for CampusOS-the-company
 * cross-team work. Distinct from school helpdesk tkt_tickets (which
 * is tenant-scoped). Service-side state machine just validates the
 * status enum; lifecycle business rules (e.g. RESOLVED requires
 * description) are deferred until P2-21c if needed.
 */
@Injectable()
export class InternalTicketService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly employees: OpsEmployeeService,
  ) {}

  async list(args: ListInternalTicketsArgs = {}): Promise<InternalTicketDto[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.status) {
      params.push(args.status);
      where.push(`status = $${params.length}`);
    }
    if (args.priority) {
      params.push(args.priority);
      where.push(`priority = $${params.length}`);
    }
    if (args.assignedTo) {
      params.push(args.assignedTo);
      where.push(`assigned_to = $${params.length}::uuid`);
    }
    const whereSql = where.length === 0 ? '' : 'WHERE ' + where.join(' AND ');
    const rows = await this.platform.$queryRawUnsafe<RawTicketRow[]>(
      `SELECT id::text, title, description, category, priority, status,
              created_by::text, assigned_to::text, related_account_id::text,
              created_at, updated_at
         FROM platform.ops_internal_tickets
         ${whereSql}
         ORDER BY created_at DESC
         LIMIT 500`,
      ...params,
    );
    return rows.map(rowToTicketDto);
  }

  async getById(id: string): Promise<InternalTicketDto> {
    return rowToTicketDto(await this.loadOrFail(id));
  }

  async create(createdBy: string, input: CreateInternalTicketDto): Promise<InternalTicketDto> {
    await this.employees.loadOrFail(createdBy);
    if (input.assignedTo) await this.employees.loadOrFail(input.assignedTo);
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.ops_internal_tickets
        (id, title, description, category, priority, status, created_by,
         assigned_to, related_account_id)
       VALUES ($1::uuid, $2, $3, $4, $5, 'OPEN', $6::uuid, $7::uuid, $8::uuid)`,
      id,
      input.title,
      input.description,
      input.category,
      input.priority ?? 'MEDIUM',
      createdBy,
      input.assignedTo ?? null,
      input.relatedAccountId ?? null,
    );
    return this.getById(id);
  }

  async patch(id: string, input: PatchInternalTicketDto): Promise<InternalTicketDto> {
    await this.loadOrFail(id);
    if (input.assignedTo) await this.employees.loadOrFail(input.assignedTo);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };
    if (input.title !== undefined) push('title = $$', input.title);
    if (input.description !== undefined) push('description = $$', input.description);
    if (input.category !== undefined) push('category = $$', input.category);
    if (input.priority !== undefined) push('priority = $$', input.priority);
    if (input.status !== undefined) push('status = $$', input.status);
    if (input.assignedTo !== undefined) push('assigned_to = $$::uuid', input.assignedTo || null);
    if (input.relatedAccountId !== undefined)
      push('related_account_id = $$::uuid', input.relatedAccountId || null);

    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.ops_internal_tickets SET ${sets.join(', ')}
       WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return this.getById(id);
  }

  async listComments(ticketId: string): Promise<InternalTicketCommentDto[]> {
    await this.loadOrFail(ticketId);
    const rows = await this.platform.$queryRawUnsafe<RawCommentRow[]>(
      `SELECT id::text, ticket_id::text, author_id::text, comment_text, created_at
         FROM platform.ops_internal_ticket_comments
         WHERE ticket_id = $1::uuid
         ORDER BY created_at ASC`,
      ticketId,
    );
    return rows.map(rowToCommentDto);
  }

  async addComment(
    ticketId: string,
    authorId: string,
    input: CreateTicketCommentDto,
  ): Promise<InternalTicketCommentDto> {
    await this.loadOrFail(ticketId);
    await this.employees.loadOrFail(authorId);
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.ops_internal_ticket_comments (id, ticket_id, author_id, comment_text)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      id,
      ticketId,
      authorId,
      input.commentText,
    );
    const rows = await this.platform.$queryRawUnsafe<RawCommentRow[]>(
      `SELECT id::text, ticket_id::text, author_id::text, comment_text, created_at
         FROM platform.ops_internal_ticket_comments WHERE id = $1::uuid`,
      id,
    );
    return rowToCommentDto(rows[0]!);
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async loadOrFail(id: string): Promise<RawTicketRow> {
    const rows = await this.platform.$queryRawUnsafe<RawTicketRow[]>(
      `SELECT id::text, title, description, category, priority, status,
              created_by::text, assigned_to::text, related_account_id::text,
              created_at, updated_at
         FROM platform.ops_internal_tickets WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) {
      throw new NotFoundException(`ops_internal_tickets ${id} not found.`);
    }
    return rows[0]!;
  }
}

interface RawTicketRow {
  id: string;
  title: string;
  description: string;
  category: string;
  priority: string;
  status: string;
  created_by: string;
  assigned_to: string | null;
  related_account_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RawCommentRow {
  id: string;
  ticket_id: string;
  author_id: string;
  comment_text: string;
  created_at: Date;
}

function rowToTicketDto(row: RawTicketRow): InternalTicketDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category as TicketCategory,
    priority: row.priority as TicketPriority,
    status: row.status as TicketStatus,
    createdBy: row.created_by,
    assignedTo: row.assigned_to,
    relatedAccountId: row.related_account_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToCommentDto(row: RawCommentRow): InternalTicketCommentDto {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    commentText: row.comment_text,
    createdAt: row.created_at.toISOString(),
  };
}
