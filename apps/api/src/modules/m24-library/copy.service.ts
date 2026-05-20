import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  ActiveCheckoutDto,
  BarcodeLookupResponseDto,
  CopyResponseDto,
  CreateCopyDto,
  UpdateCopyDto,
} from './dto/library.dto';
import { CatalogueItemService, rowToCopyDto } from './catalogue-item.service';

interface CopyRow {
  id: string;
  catalogue_item_id: string;
  location_id: string | null;
  location_name: string | null;
  barcode: string;
  condition: string;
  is_available: boolean;
  replacement_value: string | null;
  location_status: string;
  created_at: string;
  updated_at: string;
}

interface CheckoutLookupRow {
  checkout_id: string;
  patron_id: string;
  patron_first: string | null;
  patron_last: string | null;
  checkout_date: string;
  due_date: string;
  status: string;
  renewal_count: number;
  days_until_due: number;
}

const SELECT_COPY_BASE =
  'SELECT c.id::text AS id, c.catalogue_item_id::text AS catalogue_item_id, ' +
  'c.location_id::text AS location_id, l.name AS location_name, ' +
  'c.barcode, c.condition, c.is_available, ' +
  'c.replacement_value::text AS replacement_value, c.location_status, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_catalogue_copies c ' +
  'LEFT JOIN lib_locations l ON l.id = c.location_id ';

@Injectable()
export class CopyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly catalogue: CatalogueItemService,
  ) {}

  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-001:write',
    ]);
  }

  /**
   * Barcode lookup — THE KEYSTONE for the circulation desk. The
   * librarian scans a barcode, the service resolves the copy + the
   * parent catalogue item + the active checkout (if any) + the
   * pending hold count for the item — all in one round-trip. The
   * Step 6 CheckoutService.checkout reads this same shape on every
   * scan and uses it to validate availability before flipping the
   * copy state.
   */
  async lookupByBarcode(barcode: string, actor?: ResolvedActor): Promise<BarcodeLookupResponseDto> {
    const tenant = getCurrentTenant();
    const copyRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CopyRow[]>(
        SELECT_COPY_BASE +
          'JOIN lib_catalogue_items i ON i.id = c.catalogue_item_id ' +
          'WHERE c.barcode = $1 AND i.school_id = $2::uuid',
        barcode,
        tenant.schoolId,
      );
    });
    if (copyRows.length === 0) {
      throw new NotFoundException('Library copy with barcode "' + barcode + '" not found');
    }
    const copy = rowToCopyDto(copyRows[0]!);

    // Resolve the parent item with rollups + an active checkout (if any) +
    // the pending hold count, in two more round-trips.
    const item = await this.catalogue.loadItemOrFail(copy.catalogueItemId);

    // Identity strip per REVIEW-CYCLE12 BLOCKING 3: the barcode lookup
    // is gated on lib-001:read (catalogue read, held by every persona).
    // Returning `activeCheckout` with patron_id + patron_name to a
    // student / parent / general-staff caller leaks who has the book.
    // Only librarians (lib-002:write) and admins see the full
    // circulation-desk shape with active-checkout patron identity. Other
    // readers get the same DTO with `activeCheckout: null` plus a sentinel
    // `isCheckedOut` boolean derived from copy.is_available — they can
    // still tell the book is unavailable, but not who has it.
    const isLibrarian = actor ? await this.isLibrarian(actor) : false;
    let activeCheckout: ActiveCheckoutDto | null = null;
    if (isLibrarian) {
      const checkoutRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<CheckoutLookupRow[]>(
          'SELECT co.id::text AS checkout_id, co.patron_id::text AS patron_id, ' +
            'p.first_name AS patron_first, p.last_name AS patron_last, ' +
            "TO_CHAR(co.checkout_date, 'YYYY-MM-DD') AS checkout_date, " +
            "TO_CHAR(co.due_date, 'YYYY-MM-DD') AS due_date, " +
            'co.status, co.renewal_count, ' +
            '(co.due_date - CURRENT_DATE)::int AS days_until_due ' +
            'FROM lib_checkouts co ' +
            'LEFT JOIN platform.iam_person p ON p.id = co.patron_id ' +
            'WHERE co.copy_id = $1::uuid AND co.returned_at IS NULL ' +
            'ORDER BY co.checkout_date DESC LIMIT 1',
          copy.id,
        );
      });
      if (checkoutRows.length > 0) {
        const r = checkoutRows[0]!;
        activeCheckout = {
          checkoutId: r.checkout_id,
          patronId: r.patron_id,
          patronName: r.patron_first && r.patron_last ? r.patron_first + ' ' + r.patron_last : null,
          checkoutDate: r.checkout_date,
          dueDate: r.due_date,
          daysUntilDue: r.days_until_due,
          status: r.status,
          renewalCount: r.renewal_count,
        };
      }
    }

    return {
      copy,
      item,
      activeCheckout,
      pendingHoldsCount: item.activeHoldsCount,
      isCheckedOut: !copy.isAvailable,
    };
  }

  /**
   * Public for the controller — keeps the librarian-scope check in
   * one place. Mirrors the convention in checkout.service.ts.
   */
  async isLibrarian(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-002:write',
    ]);
  }

  async create(
    catalogueItemId: string,
    input: CreateCopyDto,
    actor: ResolvedActor,
  ): Promise<CopyResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can add catalogue copies');
    }
    // Validate the parent item exists in this tenant.
    await this.catalogue.loadItemOrFail(catalogueItemId);

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO lib_catalogue_copies (id, catalogue_item_id, location_id, barcode, condition, location_status, replacement_value) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
          id,
          catalogueItemId,
          input.locationId ?? null,
          input.barcode,
          input.condition ?? 'NEW',
          input.locationStatus ?? 'ON_SHELF',
          input.replacementValue ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A copy with barcode "' + input.barcode + '" already exists');
      }
      if (isFkViolation(err)) {
        throw new BadRequestException(
          'locationId does not match any active library location in this school',
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(id: string, input: UpdateCopyDto, actor: ResolvedActor): Promise<CopyResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can update catalogue copies');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM lib_catalogue_copies WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Catalogue copy ' + id);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown, cast?: string) => {
        updates.push(col + ' = $' + idx + (cast ? '::' + cast : ''));
        params.push(val);
        idx++;
      };
      if (input.condition !== undefined) set('condition', input.condition);
      if (input.locationId !== undefined) set('location_id', input.locationId, 'uuid');
      if (input.locationStatus !== undefined) set('location_status', input.locationStatus);
      if (input.isAvailable !== undefined) set('is_available', input.isAvailable);
      if (input.replacementValue !== undefined) set('replacement_value', input.replacementValue);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      try {
        await tx.$executeRawUnsafe(
          'UPDATE lib_catalogue_copies SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
          ...params,
        );
      } catch (err) {
        if (isFkViolation(err)) {
          throw new BadRequestException('locationId does not match any library location');
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<CopyResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CopyRow[]>(SELECT_COPY_BASE + 'WHERE c.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Catalogue copy ' + id);
    return rowToCopyDto(rows[0]!);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}

function isFkViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23503') return true;
  if (typeof e.message === 'string' && e.message.includes('23503')) return true;
  return false;
}
