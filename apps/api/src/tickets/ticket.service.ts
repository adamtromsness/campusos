import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CategoryService } from './category.service';
import { SlaService } from './sla.service';
import { VendorService } from './vendor.service';
import { ActivityService } from './activity.service';
import { roleTokenToName } from '../workflows/workflow-engine.service';
import {
  AssignTicketDto,
  AssignVendorDto,
  CancelTicketDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  ResolveTicketDto,
  TicketPriority,
  TicketResponseDto,
  TicketStatus,
} from './dto/ticket.dto';

interface TicketRow {
  id: string;
  school_id: string;
  category_id: string;
  category_name: string;
  subcategory_id: string | null;
  subcategory_name: string | null;
  requester_id: string;
  requester_first: string | null;
  requester_last: string | null;
  assignee_id: string | null;
  assignee_first: string | null;
  assignee_last: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  vendor_reference: string | null;
  vendor_assigned_at: string | null;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  sla_policy_id: string | null;
  sla_response_hours: number | null;
  sla_resolution_hours: number | null;
  location_id: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_TICKET_BASE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, ' +
  't.category_id::text AS category_id, c.name AS category_name, ' +
  't.subcategory_id::text AS subcategory_id, sc.name AS subcategory_name, ' +
  't.requester_id::text AS requester_id, ' +
  'rp.first_name AS requester_first, rp.last_name AS requester_last, ' +
  't.assignee_id::text AS assignee_id, ' +
  'ap.first_name AS assignee_first, ap.last_name AS assignee_last, ' +
  't.vendor_id::text AS vendor_id, v.vendor_name, ' +
  't.vendor_reference, ' +
  'TO_CHAR(t.vendor_assigned_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS vendor_assigned_at, ' +
  't.title, t.description, t.priority, t.status, ' +
  't.sla_policy_id::text AS sla_policy_id, ' +
  'sla.response_hours AS sla_response_hours, sla.resolution_hours AS sla_resolution_hours, ' +
  't.location_id::text AS location_id, ' +
  'TO_CHAR(t.first_response_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS first_response_at, ' +
  'TO_CHAR(t.resolved_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS resolved_at, ' +
  'TO_CHAR(t.closed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS closed_at, ' +
  'TO_CHAR(t.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(t.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM tkt_tickets t ' +
  'JOIN tkt_categories c ON c.id = t.category_id ' +
  'LEFT JOIN tkt_subcategories sc ON sc.id = t.subcategory_id ' +
  'LEFT JOIN platform.platform_users rpu ON rpu.id = t.requester_id ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = rpu.person_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = t.assignee_id ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ' +
  'LEFT JOIN tkt_vendors v ON v.id = t.vendor_id ' +
  'LEFT JOIN tkt_sla_policies sla ON sla.id = t.sla_policy_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: TicketRow): TicketResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    categoryId: r.category_id,
    categoryName: r.category_name,
    subcategoryId: r.subcategory_id,
    subcategoryName: r.subcategory_name,
    requesterId: r.requester_id,
    requesterName: fullName(r.requester_first, r.requester_last),
    assigneeId: r.assignee_id,
    assigneeName: fullName(r.assignee_first, r.assignee_last),
    vendorId: r.vendor_id,
    vendorName: r.vendor_name,
    vendorReference: r.vendor_reference,
    vendorAssignedAt: r.vendor_assigned_at,
    title: r.title,
    description: r.description,
    priority: r.priority as TicketPriority,
    status: r.status as TicketStatus,
    slaPolicyId: r.sla_policy_id,
    locationId: r.location_id,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sla: SlaService.computeSnapshot(
      {
        createdAt: r.created_at,
        firstResponseAt: r.first_response_at,
        resolvedAt: r.resolved_at,
        responseHours: r.sla_response_hours,
        resolutionHours: r.sla_resolution_hours,
      },
      r.sla_policy_id,
    ),
  };
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly categories: CategoryService,
    private readonly sla: SlaService,
    private readonly vendors: VendorService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * List tickets visible to the caller. Admins see every ticket in the
   * tenant; non-admins see tickets they raised (requester) or are assigned
   * to (assignee). The CLOSED + CANCELLED rows are filtered out by default
   * for the to-do queue surface; pass includeTerminal=true to see them.
   */
  async list(query: ListTicketsQueryDto, actor: ResolvedActor): Promise<TicketResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const sql: string[] = [SELECT_TICKET_BASE, 'WHERE 1=1 '];
    const params: any[] = [];
    let idx = 1;

    if (!actor.isSchoolAdmin) {
      // Row scope: requester OR assignee. The assignee is hr_employees.id;
      // requester is platform_users.id. Two predicate paths because the
      // referenced columns are different identity types.
      sql.push('AND (t.requester_id = $' + idx + '::uuid');
      params.push(actor.accountId);
      idx++;
      if (actor.employeeId) {
        sql.push(' OR t.assignee_id = $' + idx + '::uuid');
        params.push(actor.employeeId);
        idx++;
      }
      sql.push(') ');
    }
    if (query.status) {
      sql.push('AND t.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    } else if (!query.includeTerminal) {
      sql.push("AND t.status NOT IN ('CLOSED', 'CANCELLED') ");
    }
    if (query.priority) {
      sql.push('AND t.priority = $' + idx + ' ');
      params.push(query.priority);
      idx++;
    }
    if (query.categoryId) {
      sql.push('AND t.category_id = $' + idx + '::uuid ');
      params.push(query.categoryId);
      idx++;
    }
    if (query.assigneeId) {
      sql.push('AND t.assignee_id = $' + idx + '::uuid ');
      params.push(query.assigneeId);
      idx++;
    }
    if (query.vendorId) {
      sql.push('AND t.vendor_id = $' + idx + '::uuid ');
      params.push(query.vendorId);
      idx++;
    }
    if (query.createdAfter) {
      sql.push('AND t.created_at >= $' + idx + '::timestamptz ');
      params.push(query.createdAfter);
      idx++;
    }
    if (query.createdBefore) {
      sql.push('AND t.created_at < $' + idx + '::timestamptz ');
      params.push(query.createdBefore);
      idx++;
    }
    sql.push(
      // CRITICAL/HIGH first then chronological — surfaces escalations.
      "ORDER BY CASE t.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, " +
        't.created_at DESC ',
    );
    sql.push('LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TicketRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<TicketResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TicketRow[]>(SELECT_TICKET_BASE + 'WHERE t.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Ticket ' + id);
    const row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      const isRequester = row.requester_id === actor.accountId;
      const isAssignee = !!actor.employeeId && row.assignee_id === actor.employeeId;
      if (!isRequester && !isAssignee) throw new NotFoundException('Ticket ' + id);
    }
    return rowToDto(row);
  }

  /**
   * Submit a new ticket. Auto-assignment chain at submission time:
   *   1. If subcategory has default_assignee_id (a hr_employees row), assign there.
   *   2. Else if subcategory has auto_assign_to_role, resolve the role
   *      (same lookup the WorkflowEngineService uses for ROLE-typed
   *      approvers) and map the resolved platform_users.id back to an
   *      hr_employees.id via the iam_person bridge.
   *   3. Else leave assignee NULL — the ticket lands in the admin queue.
   *
   * SLA policy auto-link: lookup tkt_sla_policies WHERE (school, category,
   * priority). If a policy exists, denormalise its id onto the ticket; if
   * not, the ticket flies blind and the admin UI will suggest configuring
   * a policy.
   *
   * On successful auto-assignment, status flips OPEN → IN_PROGRESS and
   * first_response_at is populated (subcategory default counts as the
   * first response — the system is acknowledging the ticket on behalf of
   * the assignee). Emits tkt.ticket.submitted always; emits
   * tkt.ticket.assigned when an internal assignee was resolved (this is
   * the topic the Cycle 7 TaskWorker subscribes to via the seeded rule).
   */
  async create(input: CreateTicketDto, actor: ResolvedActor): Promise<TicketResponseDto> {
    const tenant = getCurrentTenant();
    const ticketId = generateId();
    const priority = input.priority ?? 'MEDIUM';

    // Validate category + subcategory belong to this tenant + are active.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const cat = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM tkt_categories WHERE id = $1::uuid AND is_active = true LIMIT 1',
        input.categoryId,
      )) as Array<{ ok: number }>;
      if (cat.length === 0) {
        throw new BadRequestException(
          'categoryId does not match an active category in this school',
        );
      }
      if (input.subcategoryId) {
        const sub = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM tkt_subcategories WHERE id = $1::uuid AND category_id = $2::uuid AND is_active = true LIMIT 1',
          input.subcategoryId,
          input.categoryId,
        )) as Array<{ ok: number }>;
        if (sub.length === 0) {
          throw new BadRequestException(
            'subcategoryId does not match an active subcategory under the chosen category',
          );
        }
      }
    });

    // Auto-assignment chain.
    let assigneeEmployeeId: string | null = null;
    if (input.subcategoryId) {
      const sub = await this.categories.loadSubcategoryForAssignment(input.subcategoryId);
      if (sub.default_assignee_id) {
        assigneeEmployeeId = sub.default_assignee_id;
      } else if (sub.auto_assign_to_role) {
        assigneeEmployeeId = await this.resolveRoleToEmployee(
          sub.auto_assign_to_role,
          tenant.schoolId,
        );
      }
    }

    // SLA policy auto-link.
    const policy = await this.sla.lookupPolicyId(input.categoryId, priority);

    // Initial status: if we resolved an internal assignee, the ticket
    // skips OPEN and enters IN_PROGRESS with first_response_at = now()
    // (the system acknowledges on the assignee's behalf). Otherwise the
    // ticket lands in OPEN and waits for the admin queue.
    const status: TicketStatus = assigneeEmployeeId ? 'IN_PROGRESS' : 'OPEN';
    const firstResponseAt = assigneeEmployeeId ? new Date().toISOString() : null;

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO tkt_tickets (id, school_id, category_id, subcategory_id, requester_id, ' +
          'assignee_id, title, description, priority, status, sla_policy_id, location_id, ' +
          'first_response_at) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11::uuid, $12::uuid, $13::timestamptz)',
        ticketId,
        tenant.schoolId,
        input.categoryId,
        input.subcategoryId ?? null,
        actor.accountId,
        assigneeEmployeeId,
        input.title,
        input.description ?? null,
        priority,
        status,
        policy?.id ?? null,
        input.locationId ?? null,
        firstResponseAt,
      );
      // Activity row: ticket submitted.
      await this.recordActivity(client, ticketId, actor.accountId, 'STATUS_CHANGE', {
        from: null,
        to: status,
        reason: 'submitted',
      });
      if (assigneeEmployeeId) {
        await this.recordActivity(client, ticketId, actor.accountId, 'REASSIGNMENT', {
          from_assignee_id: null,
          to_assignee_id: assigneeEmployeeId,
          reason: 'auto-assigned at submission',
        });
      }
    });

    const dto = await this.loadOrFail(ticketId);
    void this.kafka.emit({
      topic: 'tkt.ticket.submitted',
      key: ticketId,
      sourceModule: 'tickets',
      payload: {
        ticketId,
        schoolId: tenant.schoolId,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId ?? null,
        title: dto.title,
        priority: dto.priority,
        status: dto.status,
        requesterId: actor.accountId,
        slaPolicyId: dto.slaPolicyId,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    if (assigneeEmployeeId) {
      await this.emitAssigned(dto, assigneeEmployeeId, actor.accountId);
    }
    return dto;
  }

  /**
   * Admin reassigns the ticket to an internal employee. Clears any vendor
   * assignment in the same UPDATE so the schema's assignee_or_vendor_chk
   * stays satisfied. Records first_response_at if this is the first
   * acknowledgement (catches the case where the ticket sat in OPEN
   * without auto-assignment).
   */
  async assign(
    id: string,
    input: AssignTicketDto,
    actor: ResolvedActor,
  ): Promise<TicketResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can reassign tickets');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status, assignee_id::text AS assignee_id, first_response_at FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        id: string;
        status: string;
        assignee_id: string | null;
        first_response_at: string | null;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status === 'CLOSED' || row.status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot reassign a ticket in status ' + row.status + '; reopen first',
        );
      }
      // Verify the supplied employee exists in this tenant.
      const empRows = (await tx.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        input.assigneeEmployeeId,
      )) as Array<{ ok: number }>;
      if (empRows.length === 0) {
        throw new BadRequestException('assigneeEmployeeId does not match any hr_employees row');
      }
      const updateClauses = [
        "status = 'IN_PROGRESS'",
        'assignee_id = $1::uuid',
        'vendor_id = NULL',
        'vendor_reference = NULL',
        'vendor_assigned_at = NULL',
        'updated_at = now()',
      ];
      if (row.first_response_at === null) {
        updateClauses.push('first_response_at = now()');
      }
      await tx.$executeRawUnsafe(
        'UPDATE tkt_tickets SET ' + updateClauses.join(', ') + ' WHERE id = $2::uuid',
        input.assigneeEmployeeId,
        id,
      );
      await this.recordActivity(tx, id, actor.accountId, 'REASSIGNMENT', {
        from_assignee_id: row.assignee_id,
        to_assignee_id: input.assigneeEmployeeId,
      });
    });
    const dto = await this.loadOrFail(id);
    await this.emitAssigned(dto, input.assigneeEmployeeId, actor.accountId);
    return dto;
  }

  /**
   * Admin escalates the ticket to an external vendor. Clears the internal
   * assignee (the schema's mutex CHECK), sets vendor_id +
   * vendor_assigned_at + optional vendor_reference, flips status to
   * VENDOR_ASSIGNED. Does NOT emit tkt.ticket.assigned because the
   * Cycle 7 auto-task rule is keyed to internal employees — vendors
   * don't have a Tasks app today.
   */
  async assignVendor(
    id: string,
    input: AssignVendorDto,
    actor: ResolvedActor,
  ): Promise<TicketResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can assign tickets to a vendor');
    }
    await this.vendors.assertActive(input.vendorId);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, assignee_id::text AS assignee_id, vendor_id::text AS vendor_id, first_response_at FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        status: string;
        assignee_id: string | null;
        vendor_id: string | null;
        first_response_at: string | null;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status === 'CLOSED' || row.status === 'CANCELLED') {
        throw new BadRequestException('Cannot assign a vendor to a ticket in status ' + row.status);
      }
      const updateClauses = [
        "status = 'VENDOR_ASSIGNED'",
        'assignee_id = NULL',
        'vendor_id = $1::uuid',
        'vendor_reference = $2',
        'vendor_assigned_at = now()',
        'updated_at = now()',
      ];
      if (row.first_response_at === null) {
        updateClauses.push('first_response_at = now()');
      }
      await tx.$executeRawUnsafe(
        'UPDATE tkt_tickets SET ' + updateClauses.join(', ') + ' WHERE id = $3::uuid',
        input.vendorId,
        input.vendorReference ?? null,
        id,
      );
      await this.recordActivity(tx, id, actor.accountId, 'VENDOR_ASSIGNMENT', {
        vendor_id: input.vendorId,
        vendor_reference: input.vendorReference ?? null,
      });
      await this.recordActivity(tx, id, actor.accountId, 'REASSIGNMENT', {
        from_assignee_id: row.assignee_id,
        from_vendor_id: row.vendor_id,
        to_vendor_id: input.vendorId,
      });
    });
    return this.loadOrFail(id);
  }

  /**
   * Resolve the ticket. Allowed by the assignee or any admin. Sets
   * resolved_at = now(); status flips to RESOLVED. Emits
   * tkt.ticket.resolved so the Cycle 7 TaskWorker can mark the linked
   * auto-task DONE (matching by source_ref_id = ticket id).
   *
   * The optional resolution note lands as a public ticket comment so the
   * requester sees it. The Step 5 CommentService is the canonical writer
   * for thread comments; for now we inline the INSERT + activity row.
   */
  async resolve(
    id: string,
    input: ResolveTicketDto,
    actor: ResolvedActor,
  ): Promise<TicketResponseDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, assignee_id::text AS assignee_id, requester_id::text AS requester_id FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; assignee_id: string | null; requester_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status === 'RESOLVED' || row.status === 'CLOSED' || row.status === 'CANCELLED') {
        throw new BadRequestException('Cannot resolve a ticket in status ' + row.status);
      }
      const isAssignee = !!actor.employeeId && row.assignee_id === actor.employeeId;
      if (!actor.isSchoolAdmin && !isAssignee) {
        throw new ForbiddenException('Only the assignee or an admin can resolve this ticket');
      }
      await tx.$executeRawUnsafe(
        "UPDATE tkt_tickets SET status = 'RESOLVED', resolved_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
      if (input.resolution && input.resolution.trim().length > 0) {
        await tx.$executeRawUnsafe(
          'INSERT INTO tkt_ticket_comments (id, ticket_id, author_id, body, is_internal) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, false)',
          generateId(),
          id,
          actor.accountId,
          input.resolution,
        );
        await this.recordActivity(tx, id, actor.accountId, 'COMMENT', {
          is_internal: false,
          reason: 'resolution note',
        });
      }
      await this.recordActivity(tx, id, actor.accountId, 'STATUS_CHANGE', {
        from: row.status,
        to: 'RESOLVED',
      });
    });
    const dto = await this.loadOrFail(id);
    void this.kafka.emit({
      topic: 'tkt.ticket.resolved',
      key: id,
      sourceModule: 'tickets',
      payload: {
        ticketId: id,
        schoolId: tenant.schoolId,
        title: dto.title,
        priority: dto.priority,
        status: dto.status,
        assigneeId: dto.assigneeId,
        requesterId: dto.requesterId,
        resolvedAt: dto.resolvedAt,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    return dto;
  }

  /**
   * Close the ticket. Admin or requester only. Status RESOLVED → CLOSED;
   * sets closed_at = now(). The schema's resolved_chk requires resolved_at
   * to be populated already (close-after-resolve), so the only legal
   * source state is RESOLVED.
   */
  async close(id: string, actor: ResolvedActor): Promise<TicketResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, requester_id::text AS requester_id FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; requester_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status !== 'RESOLVED') {
        throw new BadRequestException(
          'Only RESOLVED tickets can be closed; this one is ' + row.status,
        );
      }
      const isRequester = row.requester_id === actor.accountId;
      if (!actor.isSchoolAdmin && !isRequester) {
        throw new ForbiddenException('Only the requester or an admin can close this ticket');
      }
      await tx.$executeRawUnsafe(
        "UPDATE tkt_tickets SET status = 'CLOSED', closed_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.recordActivity(tx, id, actor.accountId, 'STATUS_CHANGE', {
        from: 'RESOLVED',
        to: 'CLOSED',
      });
    });
    return this.loadOrFail(id);
  }

  /**
   * Reopen a RESOLVED ticket. Requester or admin. Clears resolved_at and
   * flips status back to OPEN; the ticket goes back into the working
   * queue. CLOSED is terminal — once a requester confirms close, only
   * admin can resurrect (admin path: assign + resolve again).
   */
  async reopen(id: string, actor: ResolvedActor): Promise<TicketResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, requester_id::text AS requester_id FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; requester_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status !== 'RESOLVED') {
        throw new BadRequestException(
          'Only RESOLVED tickets can be reopened; this one is ' + row.status,
        );
      }
      const isRequester = row.requester_id === actor.accountId;
      if (!actor.isSchoolAdmin && !isRequester) {
        throw new ForbiddenException('Only the requester or an admin can reopen this ticket');
      }
      await tx.$executeRawUnsafe(
        "UPDATE tkt_tickets SET status = 'OPEN', resolved_at = NULL, updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.recordActivity(tx, id, actor.accountId, 'STATUS_CHANGE', {
        from: 'RESOLVED',
        to: 'OPEN',
        reason: 'reopened by requester or admin',
      });
    });
    return this.loadOrFail(id);
  }

  /**
   * Cancel the ticket. Requester or admin. Allowed only from working
   * states (OPEN / IN_PROGRESS / VENDOR_ASSIGNED / PENDING_REQUESTER) —
   * cancelling a RESOLVED ticket is not the right shape (use close
   * instead). Sets closed_at = now(), keeps resolved_at NULL per the
   * resolved_chk lifecycle invariant.
   */
  async cancel(
    id: string,
    input: CancelTicketDto,
    actor: ResolvedActor,
  ): Promise<TicketResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status, requester_id::text AS requester_id FROM tkt_tickets WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string; requester_id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Ticket ' + id);
      const row = lockRows[0]!;
      if (row.status === 'RESOLVED' || row.status === 'CLOSED' || row.status === 'CANCELLED') {
        throw new BadRequestException(
          'Cannot cancel a ticket in status ' + row.status + '; close it instead',
        );
      }
      const isRequester = row.requester_id === actor.accountId;
      if (!actor.isSchoolAdmin && !isRequester) {
        throw new ForbiddenException('Only the requester or an admin can cancel this ticket');
      }
      await tx.$executeRawUnsafe(
        "UPDATE tkt_tickets SET status = 'CANCELLED', closed_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
      await this.recordActivity(tx, id, actor.accountId, 'STATUS_CHANGE', {
        from: row.status,
        to: 'CANCELLED',
        reason: input.reason ?? null,
      });
    });
    return this.loadOrFail(id);
  }

  /**
   * Local alias — Step 5 hoisted recordActivity into ActivityService so
   * CommentService and ProblemService can write through the same path.
   * TicketService keeps a thin private wrapper so existing call sites
   * stay readable; the actual work happens in ActivityService.record().
   */
  private async recordActivity(
    tx: any,
    ticketId: string,
    actorId: string | null,
    activityType:
      | 'STATUS_CHANGE'
      | 'REASSIGNMENT'
      | 'COMMENT'
      | 'ATTACHMENT'
      | 'ESCALATION'
      | 'VENDOR_ASSIGNMENT'
      | 'SLA_BREACH',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.activity.record(tx, ticketId, actorId, activityType, metadata);
  }

  /**
   * ROLE → hr_employees.id. Reuses the workflow-engine roleTokenToName
   * helper so the resolution rules stay consistent with the approval
   * engine. Maps token → role name → first ACTIVE iam_role_assignment
   * holder on the school+platform scope chain → bridges through
   * iam_person → hr_employees. Returns null when no holder has an
   * hr_employees row (e.g. the role only resolves to admin@ which is
   * intentionally not bridged per Cycle 4 Step 0).
   */
  private async resolveRoleToEmployee(roleToken: string, schoolId: string): Promise<string | null> {
    const roleName = roleTokenToName(roleToken);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT he.id::text AS id ' +
          'FROM platform.iam_role_assignment ra ' +
          'JOIN platform.roles r ON r.id = ra.role_id ' +
          'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
          'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
          'JOIN platform.platform_users pu ON pu.id = ra.account_id ' +
          'JOIN hr_employees he ON he.person_id = pu.person_id ' +
          "WHERE ra.status = 'ACTIVE' AND r.name = $1 " +
          "AND ((stp.code = 'SCHOOL' AND sc.entity_id = $2::uuid) OR stp.code = 'PLATFORM') " +
          'ORDER BY he.id LIMIT 1',
        roleName,
        schoolId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        this.logger.log(
          '[ticket-service] role ' +
            roleToken +
            ' resolved no hr_employees holder — leaving ticket unassigned',
        );
        return null;
      }
      return rows[0]!.id;
    });
  }

  /**
   * Emit tkt.ticket.assigned with the assignee's platform_users.id (NOT
   * hr_employees.id) on the payload. The Cycle 7 TaskWorker resolves the
   * recipient via payload.recipientAccountId / accountId and the seeded
   * auto-task rule has target_role=NULL so the fallback path activates.
   * If the assignee's hr_employees row has no platform_users link (rare
   * but possible — a school could have an employee who is not a portal
   * user), we log + skip the emit; the assignment still happens, but no
   * auto-task is created.
   */
  private async emitAssigned(
    dto: TicketResponseDto,
    assigneeEmployeeId: string,
    actorAccountId: string,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const accountId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT pu.id::text AS id FROM hr_employees he ' +
          'JOIN platform.platform_users pu ON pu.person_id = he.person_id ' +
          'WHERE he.id = $1::uuid LIMIT 1',
        assigneeEmployeeId,
      )) as Array<{ id: string }>;
      return rows.length > 0 ? rows[0]!.id : null;
    });
    if (!accountId) {
      this.logger.log(
        '[ticket-service] assignee ' +
          assigneeEmployeeId +
          ' has no portal account — skipping tkt.ticket.assigned emit',
      );
      return;
    }
    void this.kafka.emit({
      topic: 'tkt.ticket.assigned',
      key: dto.id,
      sourceModule: 'tickets',
      payload: {
        ticketId: dto.id,
        schoolId: tenant.schoolId,
        ticket_title: dto.title,
        priority: dto.priority,
        resolution_hours: dto.sla.resolutionHours,
        assigneeEmployeeId,
        accountId,
        recipientAccountId: accountId,
        actorAccountId,
        sourceRefId: dto.id,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
  }

  private async loadOrFail(id: string): Promise<TicketResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TicketRow[]>(SELECT_TICKET_BASE + 'WHERE t.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Ticket ' + id);
    return rowToDto(rows[0]!);
  }
}
