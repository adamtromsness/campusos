import {
  BadRequestException,
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
import {
  CreateProblemDto,
  LinkTicketsDto,
  ListProblemsQueryDto,
  ProblemResponseDto,
  ProblemStatus,
  ResolveProblemDto,
  UpdateProblemDto,
} from './dto/ticket.dto';

interface ProblemRow {
  id: string;
  school_id: string;
  title: string;
  description: string;
  category_id: string;
  category_name: string;
  status: string;
  root_cause: string | null;
  resolution: string | null;
  workaround: string | null;
  assigned_to_id: string | null;
  assigned_first: string | null;
  assigned_last: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  created_by: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PROBLEM_BASE =
  'SELECT pr.id::text AS id, pr.school_id::text AS school_id, ' +
  'pr.title, pr.description, ' +
  'pr.category_id::text AS category_id, c.name AS category_name, ' +
  'pr.status, pr.root_cause, pr.resolution, pr.workaround, ' +
  'pr.assigned_to_id::text AS assigned_to_id, ' +
  'p.first_name AS assigned_first, p.last_name AS assigned_last, ' +
  'pr.vendor_id::text AS vendor_id, v.vendor_name, ' +
  'pr.created_by::text AS created_by, ' +
  'TO_CHAR(pr.resolved_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS resolved_at, ' +
  'TO_CHAR(pr.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(pr.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM tkt_problems pr ' +
  'JOIN tkt_categories c ON c.id = pr.category_id ' +
  'LEFT JOIN hr_employees e ON e.id = pr.assigned_to_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = e.person_id ' +
  'LEFT JOIN tkt_vendors v ON v.id = pr.vendor_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: ProblemRow, ticketIds: string[]): ProblemResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    categoryId: r.category_id,
    categoryName: r.category_name,
    status: r.status as ProblemStatus,
    rootCause: r.root_cause,
    resolution: r.resolution,
    workaround: r.workaround,
    assignedToId: r.assigned_to_id,
    assignedToName: fullName(r.assigned_first, r.assigned_last),
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    createdBy: r.created_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ticketIds,
  };
}

const ACTIVE_TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'VENDOR_ASSIGNED', 'PENDING_REQUESTER'];

@Injectable()
export class ProblemService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Admin-only list of problems. Sort by status then most-recent. Each
   * row includes the linked ticket ids inline so the Step 9 Problem UI
   * can render the count without a second round-trip.
   */
  async list(query: ListProblemsQueryDto, actor: ResolvedActor): Promise<ProblemResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can browse problems');
    }
    const limit = Math.min(query.limit ?? 100, 200);
    const sql: string[] = [SELECT_PROBLEM_BASE, 'WHERE 1=1 '];
    const params: any[] = [];
    let idx = 1;
    if (query.status) {
      sql.push('AND pr.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.categoryId) {
      sql.push('AND pr.category_id = $' + idx + '::uuid ');
      params.push(query.categoryId);
      idx++;
    }
    sql.push(
      "ORDER BY CASE pr.status WHEN 'OPEN' THEN 0 WHEN 'INVESTIGATING' THEN 1 WHEN 'KNOWN_ERROR' THEN 2 ELSE 3 END, " +
        'pr.created_at DESC ',
    );
    sql.push('LIMIT ' + limit);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ProblemRow[]>(sql.join(''), ...params);
      if (rows.length === 0) return [];
      const links = await this.loadLinks(
        client,
        rows.map((r) => r.id),
      );
      return rows.map((r) => rowToDto(r, links.get(r.id) ?? []));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<ProblemResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can read problems');
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<ProblemRow[]>(
        SELECT_PROBLEM_BASE + 'WHERE pr.id = $1::uuid',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Problem ' + id);
      const links = await this.loadLinks(client, [id]);
      return rowToDto(rows[0]!, links.get(id) ?? []);
    });
  }

  /**
   * Create a problem. Optionally seed it with a list of ticket ids
   * (the Step 9 UI's "Create from ticket" button passes the source
   * ticket id here). Validates each ticket belongs to this tenant
   * before linking. Status defaults to OPEN.
   */
  async create(input: CreateProblemDto, actor: ResolvedActor): Promise<ProblemResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create problems');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    const ticketIds = input.ticketIds ?? [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate category.
      const cat = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM tkt_categories WHERE id = $1::uuid LIMIT 1',
        input.categoryId,
      )) as Array<{ ok: number }>;
      if (cat.length === 0) {
        throw new BadRequestException('categoryId does not match a category in this school');
      }
      // Mutual exclusion CHECK enforces this at the DB layer too, but
      // surface a friendlier error.
      if (input.assignedToId && input.vendorId) {
        throw new BadRequestException(
          'A problem can be assigned to an employee OR a vendor, not both',
        );
      }
      if (input.assignedToId) {
        const e = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
          input.assignedToId,
        )) as Array<{ ok: number }>;
        if (e.length === 0) {
          throw new BadRequestException('assignedToId does not match an hr_employees row');
        }
      }
      if (input.vendorId) {
        const v = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM tkt_vendors WHERE id = $1::uuid LIMIT 1',
          input.vendorId,
        )) as Array<{ ok: number }>;
        if (v.length === 0) {
          throw new BadRequestException('vendorId does not match a tkt_vendors row');
        }
      }
      if (ticketIds.length > 0) {
        await this.validateTicketIds(tx, ticketIds);
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO tkt_problems (id, school_id, title, description, category_id, status, ' +
          'assigned_to_id, vendor_id, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, 'OPEN', $6::uuid, $7::uuid, $8::uuid)",
        id,
        tenant.schoolId,
        input.title,
        input.description,
        input.categoryId,
        input.assignedToId ?? null,
        input.vendorId ?? null,
        actor.accountId,
      );

      for (const tid of ticketIds) {
        await tx.$executeRawUnsafe(
          'INSERT INTO tkt_problem_tickets (id, problem_id, ticket_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
          generateId(),
          id,
          tid,
        );
      }
    });

    return this.getById(id, actor);
  }

  /**
   * Patch problem fields. Status-only transitions are allowed via this
   * endpoint EXCEPT for OPEN → RESOLVED — RESOLVED requires root_cause
   * + resolution and triggers the batch-flip side effect, so callers
   * must use the dedicated /resolve endpoint instead. The schema's
   * multi-column resolved_chk would reject a half-populated RESOLVED
   * patch anyway; we surface a friendly 400.
   */
  async patch(
    id: string,
    input: UpdateProblemDto,
    actor: ResolvedActor,
  ): Promise<ProblemResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can edit problems');
    }
    if (input.status === 'RESOLVED') {
      throw new BadRequestException(
        'Use POST /problems/:id/resolve to transition a problem to RESOLVED — the batch ticket-flip is a separate code path',
      );
    }
    if (Object.keys(input).length === 0) return this.getById(id, actor);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    function pushNullable(column: string, value: string | null | undefined, cast?: string): void {
      if (value === undefined) return;
      if (value === null) sets.push(column + ' = NULL');
      else {
        sets.push(column + ' = $' + idx + (cast ?? ''));
        params.push(value);
        idx++;
      }
    }

    if (input.title !== undefined) {
      sets.push('title = $' + idx);
      params.push(input.title);
      idx++;
    }
    if (input.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.status !== undefined) {
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    pushNullable('root_cause', input.rootCause);
    pushNullable('workaround', input.workaround);
    pushNullable('assigned_to_id', input.assignedToId, '::uuid');
    pushNullable('vendor_id', input.vendorId, '::uuid');
    sets.push('updated_at = now()');

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM tkt_problems WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Problem ' + id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE tkt_problems SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
          ...params,
          id,
        );
      } catch (err) {
        const e = err as { meta?: { code?: string }; code?: string; message?: string };
        if (
          e?.meta?.code === '23514' ||
          e?.code === '23514' ||
          (e?.message ?? '').includes('tkt_problems_assigned_or_vendor_chk')
        ) {
          throw new BadRequestException(
            'A problem cannot be assigned to both an employee and a vendor — clear one before setting the other',
          );
        }
        throw err;
      }
    });
    return this.getById(id, actor);
  }

  /**
   * Add additional ticket links to an existing problem. Skips any ids
   * already linked (UNIQUE(problem_id, ticket_id) — the schema would
   * reject a duplicate but we surface a friendly summary instead).
   */
  async link(id: string, input: LinkTicketsDto, actor: ResolvedActor): Promise<ProblemResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can link tickets to a problem');
    }
    if (!input.ticketIds || input.ticketIds.length === 0) {
      throw new BadRequestException('ticketIds must not be empty');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM tkt_problems WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lock.length === 0) throw new NotFoundException('Problem ' + id);
      await this.validateTicketIds(tx, input.ticketIds);
      // Find which ids are already linked so we skip them.
      const existing = (await tx.$queryRawUnsafe(
        'SELECT ticket_id::text AS ticket_id FROM tkt_problem_tickets WHERE problem_id = $1::uuid',
        id,
      )) as Array<{ ticket_id: string }>;
      const existingSet = new Set(existing.map((r) => r.ticket_id));
      for (const tid of input.ticketIds) {
        if (existingSet.has(tid)) continue;
        await tx.$executeRawUnsafe(
          'INSERT INTO tkt_problem_tickets (id, problem_id, ticket_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
          generateId(),
          id,
          tid,
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE tkt_problems SET updated_at = now() WHERE id = $1::uuid',
        id,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Resolve a problem. Locks the problem row and every linked ticket
   * row in OPEN/IN_PROGRESS/VENDOR_ASSIGNED/PENDING_REQUESTER FOR
   * UPDATE inside one tx; flips the problem to RESOLVED with
   * root_cause + resolution + resolved_at populated; batch-flips every
   * matching ticket to RESOLVED with resolved_at = now() + writes a
   * STATUS_CHANGE activity row per ticket. Emits one
   * `tkt.ticket.resolved` event per affected ticket so the Cycle 7
   * TaskWorker can mark each linked auto-task DONE via the existing
   * tkt.ticket.resolved handler (a future Step 6 wiring).
   */
  async resolveBatch(
    id: string,
    input: ResolveProblemDto,
    actor: ResolvedActor,
  ): Promise<{ problem: ProblemResponseDto; ticketsFlipped: string[] }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can resolve problems');
    }
    const tenant = getCurrentTenant();
    let flipped: Array<{
      id: string;
      title: string;
      priority: string;
      status_before: string;
      assignee_id: string | null;
      requester_id: string;
    }> = [];

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock problem row.
      const probLock = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status, root_cause, resolution FROM tkt_problems WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        status: string;
        root_cause: string | null;
        resolution: string | null;
      }>;
      if (probLock.length === 0) throw new NotFoundException('Problem ' + id);
      const prob = probLock[0]!;
      if (prob.status === 'RESOLVED') {
        throw new BadRequestException('Problem is already RESOLVED');
      }

      // Find linked tickets and lock the active ones.
      flipped = (await tx.$queryRawUnsafe(
        'SELECT t.id::text AS id, t.title, t.priority, t.status AS status_before, ' +
          't.assignee_id::text AS assignee_id, t.requester_id::text AS requester_id ' +
          'FROM tkt_problem_tickets pt ' +
          'JOIN tkt_tickets t ON t.id = pt.ticket_id ' +
          'WHERE pt.problem_id = $1::uuid AND t.status = ANY($2) ' +
          'ORDER BY t.id ' +
          'FOR UPDATE OF t',
        id,
        ACTIVE_TICKET_STATUSES,
      )) as Array<{
        id: string;
        title: string;
        priority: string;
        status_before: string;
        assignee_id: string | null;
        requester_id: string;
      }>;

      // Flip the problem first.
      const updateClauses = ["status = 'RESOLVED'", 'root_cause = $1', 'resolution = $2'];
      const updateParams: any[] = [input.rootCause, input.resolution];
      let nextIdx = 3;
      if (input.workaround !== undefined) {
        updateClauses.push('workaround = $' + nextIdx);
        updateParams.push(input.workaround);
        nextIdx++;
      }
      updateClauses.push('resolved_at = now()');
      updateClauses.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE tkt_problems SET ' +
          updateClauses.join(', ') +
          ' WHERE id = $' +
          nextIdx +
          '::uuid',
        ...updateParams,
        id,
      );

      // Batch-flip the tickets.
      for (const t of flipped) {
        await tx.$executeRawUnsafe(
          "UPDATE tkt_tickets SET status = 'RESOLVED', resolved_at = now(), updated_at = now() WHERE id = $1::uuid",
          t.id,
        );
        await this.activity.record(tx, t.id, actor.accountId, 'STATUS_CHANGE', {
          from: t.status_before,
          to: 'RESOLVED',
          reason: 'batch resolved via problem ' + id,
          problem_id: id,
        });
      }
    });

    // Emit one tkt.ticket.resolved per flipped ticket — outside the tx
    // so a broker hiccup can't roll back the user's action. The Step 6
    // notification consumer + future tkt.ticket.resolved auto-task
    // hook will fan these out.
    for (const t of flipped) {
      void this.kafka.emit({
        topic: 'tkt.ticket.resolved',
        key: t.id,
        sourceModule: 'tickets',
        payload: {
          ticketId: t.id,
          schoolId: tenant.schoolId,
          title: t.title,
          priority: t.priority,
          status: 'RESOLVED',
          assigneeId: t.assignee_id,
          requesterId: t.requester_id,
          resolvedAt: new Date().toISOString(),
          resolvedViaProblemId: id,
          sourceRefId: t.id,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }

    const problem = await this.getById(id, actor);
    return { problem, ticketsFlipped: flipped.map((t) => t.id) };
  }

  private async loadLinks(client: any, problemIds: string[]): Promise<Map<string, string[]>> {
    if (problemIds.length === 0) return new Map();
    const rows = (await client.$queryRawUnsafe(
      'SELECT problem_id::text AS problem_id, ticket_id::text AS ticket_id ' +
        'FROM tkt_problem_tickets WHERE problem_id = ANY($1::uuid[]) ORDER BY ticket_id',
      problemIds,
    )) as Array<{ problem_id: string; ticket_id: string }>;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.problem_id) ?? [];
      list.push(r.ticket_id);
      out.set(r.problem_id, list);
    }
    return out;
  }

  private async validateTicketIds(tx: any, ticketIds: string[]): Promise<void> {
    if (ticketIds.length === 0) return;
    const rows = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id FROM tkt_tickets WHERE id = ANY($1::uuid[])',
      ticketIds,
    )) as Array<{ id: string }>;
    const found = new Set(rows.map((r) => r.id));
    const missing = ticketIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new BadRequestException('Unknown ticket ids: ' + missing.join(', '));
    }
  }
}
