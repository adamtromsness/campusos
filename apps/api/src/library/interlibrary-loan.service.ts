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
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateInterlibraryLoanDto,
  IllDirection,
  IllStatus,
  InterlibraryLoanResponseDto,
  ListIllArgsDto,
  UpdateInterlibraryLoanDto,
} from './dto/library-advanced.dto';

/**
 * P2-25a Step 5 — InterlibraryLoanService.
 *
 * Cross-institution loan tracking. Librarian-only writes; reads
 * gated on lib-002:read. The state machine walks REQUESTED →
 * IN_TRANSIT → ACTIVE → RETURNED. ACTIVE rows past due_date flip
 * to OVERDUE by the overdue sweep (separate worker — out of P2-25a
 * scope; the schema is ready). LOST is the librarian-only terminal
 * write-off.
 *
 * LENT rows require catalogue_item_id NOT NULL (the schema-side
 * direction_chk). BORROWED rows may carry NULL when the title is
 * not in our catalogue.
 */

interface IllRow {
  id: string;
  school_id: string;
  loan_direction: string;
  partner_institution: string;
  catalogue_item_id: string | null;
  title: string;
  author: string | null;
  isbn: string | null;
  request_date: string;
  received_date: string | null;
  sent_date: string | null;
  due_date: string | null;
  returned_date: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ILL_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, loan_direction, partner_institution, ' +
  'catalogue_item_id::text AS catalogue_item_id, title, author, isbn, ' +
  "TO_CHAR(request_date, 'YYYY-MM-DD') AS request_date, " +
  "TO_CHAR(received_date, 'YYYY-MM-DD') AS received_date, " +
  "TO_CHAR(sent_date, 'YYYY-MM-DD') AS sent_date, " +
  "TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, " +
  "TO_CHAR(returned_date, 'YYYY-MM-DD') AS returned_date, " +
  'status, notes, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_interlibrary_loans ';

function rowToIllDto(r: IllRow): InterlibraryLoanResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    loanDirection: r.loan_direction as IllDirection,
    partnerInstitution: r.partner_institution,
    catalogueItemId: r.catalogue_item_id,
    title: r.title,
    author: r.author,
    isbn: r.isbn,
    requestDate: r.request_date,
    receivedDate: r.received_date,
    sentDate: r.sent_date,
    dueDate: r.due_date,
    returnedDate: r.returned_date,
    status: r.status as IllStatus,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ALLOWED_TRANSITIONS: Record<IllStatus, IllStatus[]> = {
  REQUESTED: ['IN_TRANSIT', 'ACTIVE', 'LOST'],
  IN_TRANSIT: ['ACTIVE', 'LOST', 'RETURNED'],
  ACTIVE: ['RETURNED', 'OVERDUE', 'LOST'],
  RETURNED: [],
  OVERDUE: ['RETURNED', 'LOST'],
  LOST: [],
};

@Injectable()
export class InterlibraryLoanService {
  private readonly logger = new Logger(InterlibraryLoanService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  async list(args: ListIllArgsDto): Promise<InterlibraryLoanResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_ILL_BASE, 'WHERE school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;
    if (args.status) {
      sql.push('AND status = $' + idx + ' ');
      params.push(args.status);
      idx++;
    }
    if (args.loanDirection) {
      sql.push('AND loan_direction = $' + idx + ' ');
      params.push(args.loanDirection);
      idx++;
    }
    sql.push('ORDER BY request_date DESC, id ASC LIMIT 500');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<IllRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToIllDto);
  }

  async getById(id: string): Promise<InterlibraryLoanResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<IllRow[]>(
        SELECT_ILL_BASE + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Interlibrary loan ' + id);
    return rowToIllDto(rows[0]!);
  }

  async create(
    input: CreateInterlibraryLoanDto,
    actor: ResolvedActor,
  ): Promise<InterlibraryLoanResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException(
        'Only librarians or admins can create interlibrary loan records',
      );
    }
    if (input.loanDirection === 'LENT' && !input.catalogueItemId) {
      throw new BadRequestException('LENT loans require catalogueItemId (schema direction_chk)');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO lib_interlibrary_loans ' +
          '(id, school_id, loan_direction, partner_institution, catalogue_item_id, title, author, isbn, request_date, status, notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9::date, 'REQUESTED', $10)",
        id,
        tenant.schoolId,
        input.loanDirection,
        input.partnerInstitution,
        input.catalogueItemId ?? null,
        input.title,
        input.author ?? null,
        input.isbn ?? null,
        input.requestDate,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateInterlibraryLoanDto,
    actor: ResolvedActor,
  ): Promise<InterlibraryLoanResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException(
        'Only librarians or admins can update interlibrary loan records',
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM lib_interlibrary_loans WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Interlibrary loan ' + id);
      const current = lockRows[0]!.status as IllStatus;

      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown, cast?: string) => {
        updates.push(col + ' = $' + idx + (cast ? '::' + cast : ''));
        params.push(val);
        idx++;
      };

      if (input.status !== undefined && input.status !== current) {
        const allowed = ALLOWED_TRANSITIONS[current];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            'Cannot transition ILL from ' +
              current +
              ' to ' +
              input.status +
              ' — allowed next states: ' +
              (allowed.length === 0 ? '(terminal)' : allowed.join(', ')),
          );
        }
        set('status', input.status);
      }
      if (input.receivedDate !== undefined) set('received_date', input.receivedDate, 'date');
      if (input.sentDate !== undefined) set('sent_date', input.sentDate, 'date');
      if (input.dueDate !== undefined) set('due_date', input.dueDate, 'date');
      if (input.returnedDate !== undefined) set('returned_date', input.returnedDate, 'date');
      if (input.notes !== undefined) set('notes', input.notes);

      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE lib_interlibrary_loans SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
      this.logger.log(
        '[ill.patch] id=' +
          id.slice(0, 8) +
          (input.status ? ' status ' + current + ' → ' + input.status : ''),
      );
    });
    return this.getById(id);
  }

  /**
   * Sweep tenant-wide: ACTIVE rows past due_date → OVERDUE.
   * Returns the list of flipped ILL ids.
   */
  async sweepOverdueForCurrentTenant(): Promise<string[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        "UPDATE lib_interlibrary_loans SET status = 'OVERDUE', updated_at = now() " +
          "WHERE status = 'ACTIVE' AND due_date IS NOT NULL AND due_date < CURRENT_DATE " +
          'AND returned_date IS NULL ' +
          'RETURNING id::text AS id',
      );
    });
    return rows.map((r) => r.id);
  }

  async listOverdue(actor: ResolvedActor): Promise<InterlibraryLoanResponseDto[]> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException(
        'Only librarians or admins can read the overdue interlibrary loan dashboard',
      );
    }
    return this.list({ status: 'OVERDUE' });
  }
}
