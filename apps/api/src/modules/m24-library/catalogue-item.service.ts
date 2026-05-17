import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CatalogueItemResponseDto,
  CatalogueItemSearchHitDto,
  CopyCondition,
  CopyLocationStatus,
  CopyResponseDto,
  CreateCatalogueItemDto,
  UpdateCatalogueItemDto,
} from './dto/library.dto';

interface ItemRow {
  id: string;
  school_id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  publisher: string | null;
  publish_year: number | null;
  category: string | null;
  dewey_decimal: string | null;
  description: string | null;
  cover_image_url: string | null;
  total_copies: number;
  available_copies: number;
  active_holds_count: number;
  average_rating: number | null;
  review_count: number;
  created_at: string;
  updated_at: string;
}

interface SearchHitRow {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  category: string | null;
  dewey_decimal: string | null;
  cover_image_url: string | null;
  total_copies: number;
  available_copies: number;
  average_rating: number | null;
  review_count: number;
}

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

const SELECT_ITEM_BASE =
  'SELECT i.id::text AS id, i.school_id::text AS school_id, ' +
  'i.title, i.author, i.isbn, i.publisher, i.publish_year, ' +
  'i.category, i.dewey_decimal, i.description, i.cover_image_url, ' +
  '(SELECT count(*)::int FROM lib_catalogue_copies c WHERE c.catalogue_item_id = i.id) AS total_copies, ' +
  '(SELECT count(*)::int FROM lib_catalogue_copies c WHERE c.catalogue_item_id = i.id AND c.is_available = true) AS available_copies, ' +
  "(SELECT count(*)::int FROM lib_holds h WHERE h.catalogue_item_id = i.id AND h.status IN ('PENDING','READY')) AS active_holds_count, " +
  '(SELECT ROUND(AVG(r.rating)::numeric, 2) FROM lib_reviews r WHERE r.item_id = i.id AND r.is_approved = true)::float AS average_rating, ' +
  '(SELECT count(*)::int FROM lib_reviews r WHERE r.item_id = i.id AND r.is_approved = true) AS review_count, ' +
  'TO_CHAR(i.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(i.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_catalogue_items i ';

const SELECT_COPY_BASE =
  'SELECT c.id::text AS id, c.catalogue_item_id::text AS catalogue_item_id, ' +
  'c.location_id::text AS location_id, l.name AS location_name, ' +
  'c.barcode, c.condition, c.is_available, ' +
  'c.replacement_value::text AS replacement_value, c.location_status, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_catalogue_copies c ' +
  'LEFT JOIN lib_locations l ON l.id = c.location_id ';

function rowToItemDto(r: ItemRow): CatalogueItemResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    author: r.author,
    isbn: r.isbn,
    publisher: r.publisher,
    publishYear: r.publish_year,
    category: r.category,
    deweyDecimal: r.dewey_decimal,
    description: r.description,
    coverImageUrl: r.cover_image_url,
    totalCopies: r.total_copies,
    availableCopies: r.available_copies,
    activeHoldsCount: r.active_holds_count,
    averageRating: r.average_rating,
    reviewCount: r.review_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToSearchHitDto(r: SearchHitRow): CatalogueItemSearchHitDto {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    isbn: r.isbn,
    category: r.category,
    deweyDecimal: r.dewey_decimal,
    coverImageUrl: r.cover_image_url,
    totalCopies: r.total_copies,
    availableCopies: r.available_copies,
    averageRating: r.average_rating,
    reviewCount: r.review_count,
  };
}

export function rowToCopyDto(r: CopyRow): CopyResponseDto {
  return {
    id: r.id,
    catalogueItemId: r.catalogue_item_id,
    locationId: r.location_id,
    locationName: r.location_name,
    barcode: r.barcode,
    condition: r.condition as CopyCondition,
    isAvailable: r.is_available,
    replacementValue: r.replacement_value === null ? null : Number(r.replacement_value),
    locationStatus: r.location_status as CopyLocationStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class CatalogueItemService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Librarian scope: admin OR holds lib-001:write.
   */
  private async hasLibrarianScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-001:write',
    ]);
  }

  /**
   * Catalogue search — the GIN INDEX keystone from Step 1. When `q`
   * is supplied, the query uses `to_tsvector('english', title || ' '
   * || COALESCE(author, '')) @@ plainto_tsquery('english', $q)` and
   * orders by `ts_rank` DESC. The search is forgiving — partial words
   * + author surnames + title keywords all match because
   * `plainto_tsquery` parses the input into a normalised query.
   *
   * Without `q`, returns the alphabetical-by-title browse window
   * filtered by `category` and `author` substrings.
   */
  async search(args: {
    q?: string;
    category?: string;
    author?: string;
    limit?: number;
  }): Promise<CatalogueItemSearchHitDto[]> {
    const tenant = getCurrentTenant();
    const limit = Math.min(args.limit ?? 50, 200);
    const params: unknown[] = [tenant.schoolId];
    let paramIdx = 2;

    const where: string[] = ['i.school_id = $1::uuid'];
    let orderBy = 'ORDER BY i.title ASC';

    if (args.q && args.q.trim().length > 0) {
      const q = args.q.trim();
      where.push(
        "to_tsvector('english', i.title || ' ' || COALESCE(i.author, '')) @@ plainto_tsquery('english', $" +
          paramIdx +
          ')',
      );
      params.push(q);
      paramIdx++;
      // Use ts_rank against the same expression for ordering.
      orderBy =
        "ORDER BY ts_rank(to_tsvector('english', i.title || ' ' || COALESCE(i.author, '')), plainto_tsquery('english', $" +
        (paramIdx - 1) +
        ')) DESC, i.title ASC';
    }

    if (args.category && args.category.trim().length > 0) {
      where.push('i.category = $' + paramIdx);
      params.push(args.category.trim());
      paramIdx++;
    }
    if (args.author && args.author.trim().length > 0) {
      where.push('i.author ILIKE $' + paramIdx);
      params.push('%' + args.author.trim() + '%');
      paramIdx++;
    }

    const sql =
      'SELECT i.id::text AS id, i.title, i.author, i.isbn, i.category, i.dewey_decimal, i.cover_image_url, ' +
      '(SELECT count(*)::int FROM lib_catalogue_copies c WHERE c.catalogue_item_id = i.id) AS total_copies, ' +
      '(SELECT count(*)::int FROM lib_catalogue_copies c WHERE c.catalogue_item_id = i.id AND c.is_available = true) AS available_copies, ' +
      '(SELECT ROUND(AVG(r.rating)::numeric, 2) FROM lib_reviews r WHERE r.item_id = i.id AND r.is_approved = true)::float AS average_rating, ' +
      '(SELECT count(*)::int FROM lib_reviews r WHERE r.item_id = i.id AND r.is_approved = true) AS review_count ' +
      'FROM lib_catalogue_items i ' +
      'WHERE ' +
      where.join(' AND ') +
      ' ' +
      orderBy +
      ' LIMIT ' +
      limit;

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SearchHitRow[]>(sql, ...params);
    });
    return rows.map(rowToSearchHitDto);
  }

  async getById(id: string, includeCopies = true): Promise<CatalogueItemResponseDto> {
    const dto = await this.loadOrFail(id);
    if (!includeCopies) return dto;
    const copies = await this.listCopies(id);
    return { ...dto, copies };
  }

  async listCopies(itemId: string): Promise<CopyResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CopyRow[]>(
        SELECT_COPY_BASE + 'WHERE c.catalogue_item_id = $1::uuid ORDER BY c.barcode ASC',
        itemId,
      );
    });
    return rows.map(rowToCopyDto);
  }

  async create(
    input: CreateCatalogueItemDto,
    actor: ResolvedActor,
  ): Promise<CatalogueItemResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can create catalogue items');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO lib_catalogue_items (id, school_id, title, author, isbn, publisher, publish_year, category, dewey_decimal, description, cover_image_url) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        id,
        tenant.schoolId,
        input.title,
        input.author ?? null,
        input.isbn ?? null,
        input.publisher ?? null,
        input.publishYear ?? null,
        input.category ?? null,
        input.deweyDecimal ?? null,
        input.description ?? null,
        input.coverImageUrl ?? null,
      );
    });
    return this.getById(id, false);
  }

  async patch(
    id: string,
    input: UpdateCatalogueItemDto,
    actor: ResolvedActor,
  ): Promise<CatalogueItemResponseDto> {
    if (!(await this.hasLibrarianScope(actor))) {
      throw new ForbiddenException('Only librarians or admins can update catalogue items');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM lib_catalogue_items WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Catalogue item ' + id);
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.title !== undefined) set('title', input.title);
      if (input.author !== undefined) set('author', input.author);
      if (input.isbn !== undefined) set('isbn', input.isbn);
      if (input.publisher !== undefined) set('publisher', input.publisher);
      if (input.publishYear !== undefined) set('publish_year', input.publishYear);
      if (input.category !== undefined) set('category', input.category);
      if (input.deweyDecimal !== undefined) set('dewey_decimal', input.deweyDecimal);
      if (input.description !== undefined) set('description', input.description);
      if (input.coverImageUrl !== undefined) set('cover_image_url', input.coverImageUrl);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      await tx.$executeRawUnsafe(
        'UPDATE lib_catalogue_items SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.getById(id, true);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<CatalogueItemResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ItemRow[]>(
        SELECT_ITEM_BASE + 'WHERE i.id = $1::uuid AND i.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Catalogue item ' + id);
    return rowToItemDto(rows[0]!);
  }

  /**
   * Public helper for CopyService — resolves an item id to its DTO
   * without copies inlined. Used when loading the parent item for a
   * barcode lookup.
   */
  async loadItemOrFail(id: string): Promise<CatalogueItemResponseDto> {
    return this.loadOrFail(id);
  }
}
