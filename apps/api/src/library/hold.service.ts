import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { CreateHoldDto, HoldResponseDto, HoldStatus } from './dto/library.dto';
import { CheckoutService } from './checkout.service';

interface HoldRow {
  id: string;
  catalogue_item_id: string;
  item_title: string | null;
  patron_id: string;
  patron_first: string | null;
  patron_last: string | null;
  placed_at: string;
  expires_at: string | null;
  status: string;
  notified_at: string | null;
  queue_position: number | null;
}

const SELECT_HOLD_BASE =
  'SELECT h.id::text AS id, h.catalogue_item_id::text AS catalogue_item_id, ' +
  'i.title AS item_title, h.patron_id::text AS patron_id, ' +
  'p.first_name AS patron_first, p.last_name AS patron_last, ' +
  'TO_CHAR(h.placed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS placed_at, ' +
  'TO_CHAR(h.expires_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS expires_at, ' +
  'h.status, ' +
  'TO_CHAR(h.notified_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS notified_at, ' +
  "CASE WHEN h.status = 'PENDING' THEN " +
  '(SELECT count(*)::int + 1 FROM lib_holds h2 ' +
  "WHERE h2.catalogue_item_id = h.catalogue_item_id AND h2.status = 'PENDING' AND h2.placed_at < h.placed_at) " +
  'ELSE NULL END AS queue_position ' +
  'FROM lib_holds h ' +
  'LEFT JOIN lib_catalogue_items i ON i.id = h.catalogue_item_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = h.patron_id ';

function rowToDto(r: HoldRow): HoldResponseDto {
  return {
    id: r.id,
    catalogueItemId: r.catalogue_item_id,
    itemTitle: r.item_title,
    patronId: r.patron_id,
    patronName: r.patron_first && r.patron_last ? r.patron_first + ' ' + r.patron_last : null,
    placedAt: r.placed_at,
    expiresAt: r.expires_at,
    status: r.status as HoldStatus,
    notifiedAt: r.notified_at,
    queuePosition: r.queue_position,
  };
}

@Injectable()
export class HoldService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly checkouts: CheckoutService,
  ) {}

  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  /**
   * Place a hold. Self-service when patronId is omitted (defaults to
   * actor.personId). Librarians can place holds on behalf of a
   * patron by passing an explicit patronId. Validates the catalogue
   * item exists in this tenant and has at least one copy. Refuses to
   * stack a duplicate PENDING/READY hold by the same patron on the
   * same item (no schema-side UNIQUE — the service-layer check is
   * sufficient because schools may legitimately re-place a CANCELLED
   * or EXPIRED hold).
   */
  async placeHold(input: CreateHoldDto, actor: ResolvedActor): Promise<HoldResponseDto> {
    const tenant = getCurrentTenant();
    const patronId = input.patronId ?? actor.personId;

    // If the caller asks to place a hold on someone else, require librarian scope.
    if (input.patronId && input.patronId !== actor.personId) {
      if (!(await this.hasLibrarianScope(actor))) {
        throw new ForbiddenException(
          'Only librarians or admins can place a hold on behalf of another patron',
        );
      }
    }

    if (!patronId) {
      throw new BadRequestException('patronId required (no actor.personId resolved)');
    }

    // Cross-tenant guard per REVIEW-CYCLE12 BLOCKING 4. The default
    // self-service path (patronId = actor.personId) is implicitly
    // tenant-scoped because the Auth + Tenant guard chain already
    // proved the actor belongs to this tenant. The librarian-on-
    // behalf path needs the explicit projection check so a librarian
    // can't place a hold for a person who is a `platform_students`
    // row in a different school but not enrolled here.
    if (input.patronId && input.patronId !== actor.personId) {
      await this.checkouts.assertPatronInCurrentTenant(input.patronId);
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate the catalogue item exists in this tenant + has at least one copy.
      const itemRows = (await tx.$queryRawUnsafe(
        'SELECT i.id::text AS id, ' +
          '(SELECT count(*)::int FROM lib_catalogue_copies c WHERE c.catalogue_item_id = i.id) AS total_copies ' +
          'FROM lib_catalogue_items i WHERE i.id = $1::uuid AND i.school_id = $2::uuid',
        input.catalogueItemId,
        tenant.schoolId,
      )) as Array<{ id: string; total_copies: number }>;
      if (itemRows.length === 0)
        throw new NotFoundException('Catalogue item ' + input.catalogueItemId);
      if (itemRows[0]!.total_copies === 0) {
        throw new BadRequestException(
          'Cannot place a hold on a catalogue item with no copies. The librarian must add at least one copy first.',
        );
      }

      // Refuse duplicate PENDING/READY hold from same patron.
      const existing = (await tx.$queryRawUnsafe(
        "SELECT id::text AS id FROM lib_holds WHERE catalogue_item_id = $1::uuid AND patron_id = $2::uuid AND status IN ('PENDING','READY') LIMIT 1",
        input.catalogueItemId,
        patronId,
      )) as Array<{ id: string }>;
      if (existing.length > 0) {
        throw new BadRequestException(
          'Patron already has a PENDING or READY hold on this item (id=' +
            existing[0]!.id +
            '). Cancel it before placing another.',
        );
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO lib_holds (id, catalogue_item_id, patron_id, placed_at, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'PENDING')",
        id,
        input.catalogueItemId,
        patronId,
      );
    });
    return this.getById(id);
  }

  async list(
    actor: ResolvedActor,
    args: { status?: HoldStatus; patronId?: string },
  ): Promise<HoldResponseDto[]> {
    const isLibrarian = await this.hasLibrarianScope(actor);
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (!isLibrarian) {
      where.push('h.patron_id = $' + idx + '::uuid');
      params.push(actor.personId);
      idx++;
    } else if (args.patronId) {
      where.push('h.patron_id = $' + idx + '::uuid');
      params.push(args.patronId);
      idx++;
    }
    if (args.status) {
      where.push('h.status = $' + idx);
      params.push(args.status);
      idx++;
    }
    const sql =
      SELECT_HOLD_BASE +
      (where.length > 0 ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      'ORDER BY h.placed_at DESC LIMIT 200';
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<HoldRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /**
   * Fetch a single hold. When `actor` is supplied (controller path)
   * this enforces row scope — librarians/admins see any hold in
   * tenant, patrons see only their own, non-owners get a 404
   * (don't-leak-existence per REVIEW-CYCLE12 BLOCKING 2). The
   * actor-less overload remains for internal post-mutation reloads
   * (placeHold / cancel / collect already passed authorisation).
   */
  async getById(id: string, actor?: ResolvedActor): Promise<HoldResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<HoldRow[]>(SELECT_HOLD_BASE + 'WHERE h.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Hold ' + id);
    const dto = rowToDto(rows[0]!);
    if (actor) {
      const isLibrarian = await this.hasLibrarianScope(actor);
      if (!isLibrarian && dto.patronId !== actor.personId) {
        throw new NotFoundException('Hold ' + id);
      }
    }
    return dto;
  }

  /**
   * Cancel a hold. Patron can cancel their own; librarian can cancel any.
   */
  async cancel(id: string, actor: ResolvedActor): Promise<HoldResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, patron_id::text AS patron_id, status FROM lib_holds WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; patron_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Hold ' + id);
      const h = rows[0]!;
      if (h.status === 'CANCELLED' || h.status === 'EXPIRED' || h.status === 'COLLECTED') {
        throw new BadRequestException('Hold is already in terminal status ' + h.status);
      }
      const isLibrarian = await this.hasLibrarianScope(actor);
      if (!isLibrarian && h.patron_id !== actor.personId) {
        throw new ForbiddenException('You can only cancel your own holds');
      }
      await tx.$executeRawUnsafe(
        "UPDATE lib_holds SET status = 'CANCELLED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.getById(id);
  }

  /**
   * Mark a hold as collected. Librarian only — happens at the desk
   * when the patron picks up the reserved copy. The Step 6 flow is:
   * (1) hold.status flipped to READY by CheckoutService.return when
   * the copy comes back; (2) HoldService.collect flips it to
   * COLLECTED; (3) the librarian creates a checkout for the patron
   * via the standard checkout endpoint. The collect transition does
   * NOT auto-create the checkout — that's a separate explicit step.
   */
  async collect(id: string, actor: ResolvedActor): Promise<HoldResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can mark a hold collected');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status FROM lib_holds WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Hold ' + id);
      if (rows[0]!.status !== 'READY') {
        throw new BadRequestException(
          'Cannot collect a hold in status ' +
            rows[0]!.status +
            ' — only READY holds can be collected.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE lib_holds SET status = 'COLLECTED', updated_at = now() WHERE id = $1::uuid",
        id,
      );
    });
    return this.getById(id);
  }
}
