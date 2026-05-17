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
  CreateReadingListDto,
  CreateReadingListItemDto,
  ReadingListItemResponseDto,
  ReadingListItemType,
  ReadingListResponseDto,
  ReadingListType,
  UpdateReadingListDto,
  UpdateReadingListItemDto,
} from './dto/library.dto';

interface ListRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  list_type: string;
  created_by: string;
  creator_first: string | null;
  creator_last: string | null;
  target_class_id: string | null;
  target_grade_level: string | null;
  curriculum_unit_id: string | null;
  academic_year_id: string | null;
  is_published: boolean;
  published_at: string | null;
  item_count: number;
  created_at: string;
  updated_at: string;
}

interface ListItemRow {
  id: string;
  reading_list_id: string;
  catalogue_item_id: string;
  item_title: string | null;
  item_author: string | null;
  item_cover_image_url: string | null;
  item_type: string;
  sort_order: number;
  notes: string | null;
  added_by: string;
  added_first: string | null;
  added_last: string | null;
  created_at: string;
}

const SELECT_LIST_BASE =
  'SELECT l.id::text AS id, l.school_id::text AS school_id, l.name, l.description, ' +
  'l.list_type, l.created_by::text AS created_by, ' +
  'cp.first_name AS creator_first, cp.last_name AS creator_last, ' +
  'l.target_class_id::text AS target_class_id, ' +
  'l.target_grade_level, ' +
  'l.curriculum_unit_id::text AS curriculum_unit_id, ' +
  'l.academic_year_id::text AS academic_year_id, ' +
  'l.is_published, ' +
  'TO_CHAR(l.published_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS published_at, ' +
  '(SELECT count(*)::int FROM lib_reading_list_items i WHERE i.reading_list_id = l.id) AS item_count, ' +
  'TO_CHAR(l.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(l.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM lib_reading_lists l ' +
  'LEFT JOIN hr_employees ce ON ce.id = l.created_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = ce.person_id ';

const SELECT_LIST_ITEM_BASE =
  'SELECT i.id::text AS id, i.reading_list_id::text AS reading_list_id, ' +
  'i.catalogue_item_id::text AS catalogue_item_id, ' +
  'ci.title AS item_title, ci.author AS item_author, ci.cover_image_url AS item_cover_image_url, ' +
  'i.item_type, i.sort_order, i.notes, ' +
  'i.added_by::text AS added_by, ap.first_name AS added_first, ap.last_name AS added_last, ' +
  'TO_CHAR(i.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM lib_reading_list_items i ' +
  // REVIEW-P2C25 BLOCKING 4 — every item read joins through the
  // parent reading list so the school_id predicate can pin the row to
  // the current tenant.
  'JOIN lib_reading_lists l ON l.id = i.reading_list_id ' +
  'LEFT JOIN lib_catalogue_items ci ON ci.id = i.catalogue_item_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = i.added_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ';

function rowToListDto(r: ListRow): ReadingListResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    listType: r.list_type as ReadingListType,
    createdById: r.created_by,
    createdByName:
      r.creator_first && r.creator_last ? r.creator_first + ' ' + r.creator_last : null,
    targetClassId: r.target_class_id,
    targetGradeLevel: r.target_grade_level,
    curriculumUnitId: r.curriculum_unit_id,
    academicYearId: r.academic_year_id,
    isPublished: r.is_published,
    publishedAt: r.published_at,
    itemCount: r.item_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToItemDto(r: ListItemRow): ReadingListItemResponseDto {
  return {
    id: r.id,
    readingListId: r.reading_list_id,
    catalogueItemId: r.catalogue_item_id,
    itemTitle: r.item_title,
    itemAuthor: r.item_author,
    itemCoverImageUrl: r.item_cover_image_url,
    itemType: r.item_type as ReadingListItemType,
    sortOrder: r.sort_order,
    notes: r.notes,
    addedById: r.added_by,
    addedByName: r.added_first && r.added_last ? r.added_first + ' ' + r.added_last : null,
    createdAt: r.created_at,
  };
}

@Injectable()
export class ReadingListService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Reading list writer scope: admin OR non-student STAFF holding
   * lib-003:write. Granted to Teacher (curate class lists) + Staff
   * (librarian). Students hold lib-003:write per the IAM seed but
   * are explicitly not list authors — the personType guard is the
   * real gate.
   */
  private async hasWriterScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType === 'STUDENT') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'lib-003:write',
    ]);
  }

  /**
   * List reading lists. Published lists are visible to everyone with
   * lib-003:read; unpublished lists are visible only to writers
   * (librarian / teacher / admin) — keeps drafts staff-side.
   */
  async list(
    actor: ResolvedActor,
    args: {
      includeUnpublished?: boolean;
      listType?: string;
      targetGradeLevel?: string;
      curriculumUnitId?: string;
    },
  ): Promise<ReadingListResponseDto[]> {
    const tenant = getCurrentTenant();
    const isWriter = await this.hasWriterScope(actor);
    const sql: string[] = [SELECT_LIST_BASE, 'WHERE l.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;
    if (!args.includeUnpublished || !isWriter) {
      sql.push('AND l.is_published = true ');
    }
    if (args.listType) {
      sql.push('AND l.list_type = $' + idx + ' ');
      params.push(args.listType);
      idx++;
    }
    if (args.targetGradeLevel) {
      sql.push('AND l.target_grade_level = $' + idx + ' ');
      params.push(args.targetGradeLevel);
      idx++;
    }
    if (args.curriculumUnitId) {
      sql.push('AND l.curriculum_unit_id = $' + idx + '::uuid ');
      params.push(args.curriculumUnitId);
      idx++;
    }
    sql.push('ORDER BY l.created_at DESC LIMIT 200');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ListRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToListDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<ReadingListResponseDto> {
    const dto = await this.loadOrFail(id);
    const isWriter = await this.hasWriterScope(actor);
    if (!dto.isPublished && !isWriter) {
      throw new NotFoundException('Reading list ' + id);
    }
    const items = await this.listItems(id);
    return { ...dto, items };
  }

  async listItems(listId: string): Promise<ReadingListItemResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C25 BLOCKING 4 — bind via parent list's school_id.
      return client.$queryRawUnsafe<ListItemRow[]>(
        SELECT_LIST_ITEM_BASE +
          'WHERE i.reading_list_id = $1::uuid AND l.school_id = $2::uuid ' +
          'ORDER BY i.sort_order ASC, i.created_at ASC',
        listId,
        tenant.schoolId,
      );
    });
    return rows.map(rowToItemDto);
  }

  async create(input: CreateReadingListDto, actor: ResolvedActor): Promise<ReadingListResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException('Only librarians, teachers, or admins can create reading lists');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Reading list author must have an hr_employees row — actor.employeeId is null',
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO lib_reading_lists (id, school_id, name, description, list_type, created_by, target_class_id, target_grade_level, curriculum_unit_id, academic_year_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, $8, $9::uuid, $10::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.listType,
          actor.employeeId,
          input.targetClassId ?? null,
          input.targetGradeLevel ?? null,
          input.curriculumUnitId ?? null,
          input.academicYearId ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A reading list named "' +
            input.name +
            '" already exists in this school' +
            (input.academicYearId ? ' for the supplied academic year' : ''),
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  /**
   * Patch list metadata. The `is_published` flag is the canonical
   * publish path: when it flips, the multi-column `published_chk`
   * keystone requires `published_at` to be in lockstep — the
   * service stamps both atomically inside the tx.
   */
  async patch(
    id: string,
    input: UpdateReadingListDto,
    actor: ResolvedActor,
  ): Promise<ReadingListResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException('Only librarians, teachers, or admins can update reading lists');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, is_published FROM lib_reading_lists WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; is_published: boolean }>;
      if (lockRows.length === 0) throw new NotFoundException('Reading list ' + id);
      const wasPublished = lockRows[0]!.is_published;

      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.name !== undefined) set('name', input.name);
      if (input.description !== undefined) set('description', input.description);
      if (input.listType !== undefined) set('list_type', input.listType);
      if (input.targetClassId !== undefined) set('target_class_id', input.targetClassId);
      if (input.targetGradeLevel !== undefined) set('target_grade_level', input.targetGradeLevel);
      if (input.curriculumUnitId !== undefined) set('curriculum_unit_id', input.curriculumUnitId);

      // Multi-column published_chk keystone — when is_published flips,
      // stamp published_at in lockstep (set on publish, clear on unpublish).
      if (input.isPublished !== undefined) {
        if (input.isPublished && !wasPublished) {
          set('is_published', true);
          updates.push('published_at = now()');
        } else if (!input.isPublished && wasPublished) {
          set('is_published', false);
          updates.push('published_at = NULL');
        } else {
          set('is_published', input.isPublished);
        }
      }

      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      try {
        await tx.$executeRawUnsafe(
          'UPDATE lib_reading_lists SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
          ...params,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A reading list with that name already exists in this school',
          );
        }
        throw err;
      }
    });
    return this.loadOrFail(id);
  }

  async addItem(
    listId: string,
    input: CreateReadingListItemDto,
    actor: ResolvedActor,
  ): Promise<ReadingListItemResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can add items to a reading list',
      );
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Reading list editor must have an hr_employees row — actor.employeeId is null',
      );
    }
    const tenant = getCurrentTenant();
    await this.assertListExists(listId);

    // Validate the catalogue item exists in this tenant.
    const itemExists = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM lib_catalogue_items WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        input.catalogueItemId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
    if (!itemExists) {
      throw new NotFoundException('Catalogue item ' + input.catalogueItemId);
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO lib_reading_list_items (id, reading_list_id, catalogue_item_id, item_type, sort_order, added_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)',
          id,
          listId,
          input.catalogueItemId,
          input.itemType ?? 'RECOMMENDED',
          input.sortOrder ?? 0,
          actor.employeeId,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('This catalogue item is already on the reading list');
      }
      throw err;
    }
    return this.loadItemOrFail(id);
  }

  async patchItem(
    itemId: string,
    input: UpdateReadingListItemDto,
    actor: ResolvedActor,
  ): Promise<ReadingListItemResponseDto> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can update reading list items',
      );
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C25 BLOCKING 4 — JOIN through lib_reading_lists so the
      // FOR UPDATE lock only resolves for items whose parent list
      // belongs to the current tenant. Cross-school item UUIDs land 404.
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT i.id::text AS id FROM lib_reading_list_items i ' +
          'JOIN lib_reading_lists l ON l.id = i.reading_list_id ' +
          'WHERE i.id = $1::uuid AND l.school_id = $2::uuid FOR UPDATE OF i',
        itemId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Reading list item ' + itemId);
      const updates: string[] = [];
      const params: unknown[] = [itemId, tenant.schoolId];
      let idx = 3;
      const set = (col: string, val: unknown) => {
        updates.push(col + ' = $' + idx);
        params.push(val);
        idx++;
      };
      if (input.itemType !== undefined) set('item_type', input.itemType);
      if (input.sortOrder !== undefined) set('sort_order', input.sortOrder);
      if (input.notes !== undefined) set('notes', input.notes);
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      // Carry the school_id predicate on the UPDATE too — defence-in-
      // depth alongside the locked-row precondition.
      await tx.$executeRawUnsafe(
        'UPDATE lib_reading_list_items SET ' +
          updates.join(', ') +
          ' WHERE id = $1::uuid ' +
          'AND reading_list_id IN (SELECT id FROM lib_reading_lists WHERE id = lib_reading_list_items.reading_list_id AND school_id = $2::uuid)',
        ...params,
      );
    });
    return this.loadItemOrFail(itemId);
  }

  async removeItem(itemId: string, actor: ResolvedActor): Promise<void> {
    if (!(await this.hasWriterScope(actor))) {
      throw new ForbiddenException(
        'Only librarians, teachers, or admins can remove reading list items',
      );
    }
    const tenant = getCurrentTenant();
    // REVIEW-P2C25 BLOCKING 4 — DELETE only when the parent list
    // belongs to this school; cross-school item UUIDs return 0 rows.
    const r = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM lib_reading_list_items i ' +
          'USING lib_reading_lists l ' +
          'WHERE i.reading_list_id = l.id AND i.id = $1::uuid AND l.school_id = $2::uuid',
        itemId,
        tenant.schoolId,
      );
    });
    if (r === 0) throw new NotFoundException('Reading list item ' + itemId);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ReadingListResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ListRow[]>(
        SELECT_LIST_BASE + 'WHERE l.id = $1::uuid AND l.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Reading list ' + id);
    return rowToListDto(rows[0]!);
  }

  private async loadItemOrFail(itemId: string): Promise<ReadingListItemResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C25 BLOCKING 4 — SELECT_LIST_ITEM_BASE JOINs through
      // lib_reading_lists; carry the school predicate on the load.
      return client.$queryRawUnsafe<ListItemRow[]>(
        SELECT_LIST_ITEM_BASE + 'WHERE i.id = $1::uuid AND l.school_id = $2::uuid',
        itemId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Reading list item ' + itemId);
    return rowToItemDto(rows[0]!);
  }

  private async assertListExists(id: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM lib_reading_lists WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Reading list ' + id);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (typeof e.message === 'string' && e.message.includes('23505')) return true;
  return false;
}
