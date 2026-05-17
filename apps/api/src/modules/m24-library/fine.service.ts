import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  FINE_STATUSES,
  FineResponseDto,
  FineStatus,
  FineType,
  WaiveFineDto,
} from './dto/library.dto';

interface FineRow {
  id: string;
  checkout_id: string;
  item_title: string | null;
  patron_id: string;
  patron_first: string | null;
  patron_last: string | null;
  fine_type: string;
  amount: string;
  days_overdue: number | null;
  status: string;
  invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_FINE_BASE =
  'SELECT f.id::text AS id, f.checkout_id::text AS checkout_id, ' +
  'i.title AS item_title, ' +
  'f.patron_id::text AS patron_id, p.first_name AS patron_first, p.last_name AS patron_last, ' +
  'f.fine_type, f.amount::text AS amount, f.days_overdue, f.status, ' +
  'f.invoice_id::text AS invoice_id, ' +
  'TO_CHAR(f.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(f.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_fines f ' +
  'LEFT JOIN lib_checkouts co ON co.id = f.checkout_id ' +
  'LEFT JOIN lib_catalogue_copies cp ON cp.id = co.copy_id ' +
  'LEFT JOIN lib_catalogue_items i ON i.id = cp.catalogue_item_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = f.patron_id ';

function rowToDto(r: FineRow): FineResponseDto {
  return {
    id: r.id,
    checkoutId: r.checkout_id,
    itemTitle: r.item_title,
    patronId: r.patron_id,
    patronName: r.patron_first && r.patron_last ? r.patron_first + ' ' + r.patron_last : null,
    fineType: r.fine_type as FineType,
    amount: Number(r.amount),
    daysOverdue: r.days_overdue,
    status: r.status as FineStatus,
    invoiceId: r.invoice_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class FineService {
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

  async list(
    actor: ResolvedActor,
    args: { status?: FineStatus; patronId?: string },
  ): Promise<FineResponseDto[]> {
    const isLibrarian = await this.hasLibrarianScope(actor);
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (!isLibrarian) {
      where.push('f.patron_id = $' + idx + '::uuid');
      params.push(actor.personId);
      idx++;
    } else if (args.patronId) {
      where.push('f.patron_id = $' + idx + '::uuid');
      params.push(args.patronId);
      idx++;
    }
    if (args.status) {
      where.push('f.status = $' + idx);
      params.push(args.status);
      idx++;
    } else if (isLibrarian) {
      // Default librarian view: outstanding fines first.
      // (no filter applied; ORDER BY status puts OUTSTANDING first below)
    }
    const sql =
      SELECT_FINE_BASE +
      (where.length > 0 ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      "ORDER BY CASE f.status WHEN 'OUTSTANDING' THEN 0 WHEN 'PAID' THEN 1 ELSE 2 END, f.created_at DESC LIMIT 200";
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<FineRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<FineResponseDto> {
    const fine = await this.loadOrFail(id);
    const isLibrarian = await this.hasLibrarianScope(actor);
    if (!isLibrarian && fine.patronId !== actor.personId) {
      // 404 don't-leak-existence row scope.
      throw new NotFoundException('Fine ' + id);
    }
    return fine;
  }

  /**
   * Mark a fine PAID. Librarian or admin only — the librarian
   * collects the cash / processes the card at the desk and flips
   * the row. The future Cycle 6 payment integration consumer will
   * write the matching pay_invoices row + flip this fine via the
   * same endpoint.
   */
  async pay(id: string, actor: ResolvedActor): Promise<FineResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can mark a fine PAID');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM lib_fines WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Fine ' + id);
      if (rows[0]!.status !== 'OUTSTANDING') {
        throw new BadRequestException(
          'Cannot pay a fine in status ' + rows[0]!.status + ' — only OUTSTANDING.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE lib_fines SET status = 'PAID', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Waive a fine. School admin only — the librarian cannot waive a
   * fine because the financial-write-off decision belongs to admin
   * authority. Reason is required.
   */
  async waive(id: string, body: WaiveFineDto, actor: ResolvedActor): Promise<FineResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can waive a library fine');
    }
    if (!body.reason || body.reason.trim().length === 0) {
      throw new BadRequestException('A waive reason is required');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM lib_fines WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Fine ' + id);
      if (rows[0]!.status !== 'OUTSTANDING') {
        throw new BadRequestException(
          'Cannot waive a fine in status ' + rows[0]!.status + ' — only OUTSTANDING.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE lib_fines SET status = 'WAIVED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.loadOrFail(id);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<FineResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<FineRow[]>(SELECT_FINE_BASE + 'WHERE f.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Fine ' + id);
    return rowToDto(rows[0]!);
  }
}

// Suppress unused lint
void FINE_STATUSES;
