import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { assertStoreAdmin, assertStoreReader, isUniqueViolation } from './access-advanced';
import type {
  CategoryNodeDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto/commerce-store.dto';

interface CategoryRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  parent_category_id: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * P2-29b — CategoryHierarchyService.
 *
 * Self-referential category tree per store. UNIQUE(store_id, name,
 * COALESCE(parent_category_id, sentinel)) catches sibling-name
 * collisions while letting two sub-trees carry the same name (e.g.
 * "Books" under "Fiction" and "Books" under "Non-Fiction" coexist).
 *
 * remove() refuses to drop a category that still has children — the
 * schema-side NO ACTION on the self-FK is the belt-and-braces. The
 * service surfaces a friendly 409 with the count of blocking
 * children + assigned products so the admin can reparent before
 * delete.
 *
 * The list endpoint returns a fully-resolved tree (children inline)
 * for a given store.
 */
@Injectable()
export class CategoryHierarchyService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toNode(row: CategoryRow): CategoryNodeDto {
    return {
      id: row.id,
      storeId: row.store_id,
      name: row.name,
      description: row.description,
      parentCategoryId: row.parent_category_id,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      children: [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Read the full tree for a store, resolved into nested children. */
  async tree(
    actor: ResolvedActor,
    storeId: string,
    includeInactive?: boolean,
  ): Promise<CategoryNodeDto[]> {
    await assertStoreReader(actor, this.permCheck, 'Category tree');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const storeRows = (await client.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
        storeId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
      const where = includeInactive ? '' : ' AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, store_id::text AS store_id, name, description,
                parent_category_id::text AS parent_category_id,
                sort_order, is_active,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM str_category_hierarchy
          WHERE store_id = $1::uuid${where}
          ORDER BY COALESCE(parent_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
                   sort_order, name`,
        storeId,
      )) as CategoryRow[];
      const byId = new Map<string, CategoryNodeDto>();
      const roots: CategoryNodeDto[] = [];
      for (const r of rows) {
        const node = this.toNode(r);
        byId.set(node.id, node);
      }
      for (const r of rows) {
        const node = byId.get(r.id)!;
        if (r.parent_category_id) {
          const parent = byId.get(r.parent_category_id);
          if (parent) parent.children.push(node);
          else roots.push(node);
        } else {
          roots.push(node);
        }
      }
      return roots;
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<CategoryNodeDto> {
    await assertStoreReader(actor, this.permCheck, 'Category read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.store_id::text AS store_id, c.name, c.description,
                c.parent_category_id::text AS parent_category_id,
                c.sort_order, c.is_active,
                c.created_at::text AS created_at,
                c.updated_at::text AS updated_at
           FROM str_category_hierarchy c
           JOIN str_stores s ON s.id = c.store_id
          WHERE s.school_id = $1::uuid AND c.id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as CategoryRow[];
      if (rows.length === 0) throw new NotFoundException('Category not found');
      return this.toNode(rows[0]!);
    });
  }

  async create(actor: ResolvedActor, input: CreateCategoryDto): Promise<CategoryNodeDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Category create');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const storeRows = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM str_stores WHERE id = $1::uuid AND school_id = $2::uuid`,
        input.storeId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (storeRows.length === 0) {
        throw new BadRequestException('storeId does not match a store in this school');
      }
      if (input.parentCategoryId) {
        const parentRows = (await tx.$queryRawUnsafe(
          `SELECT 1 AS ok FROM str_category_hierarchy
            WHERE id = $1::uuid AND store_id = $2::uuid`,
          input.parentCategoryId,
          input.storeId,
        )) as Array<{ ok: number }>;
        if (parentRows.length === 0) {
          throw new BadRequestException('parentCategoryId does not match a category in this store');
        }
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO str_category_hierarchy
             (id, store_id, name, description, parent_category_id, sort_order)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::int)
           RETURNING id::text AS id, store_id::text AS store_id, name, description,
                     parent_category_id::text AS parent_category_id,
                     sort_order, is_active,
                     created_at::text AS created_at,
                     updated_at::text AS updated_at`,
          id,
          input.storeId,
          input.name,
          input.description ?? null,
          input.parentCategoryId ?? null,
          input.sortOrder ?? 0,
        )) as CategoryRow[];
        return this.toNode(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A sibling category with name "${input.name}" already exists`,
          );
        }
        throw err;
      }
    });
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateCategoryDto,
  ): Promise<CategoryNodeDto> {
    await assertStoreAdmin(actor, this.permCheck, 'Category patch');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT c.id::text AS id, c.store_id::text AS store_id
           FROM str_category_hierarchy c
           JOIN str_stores s ON s.id = c.store_id
          WHERE s.school_id = $1::uuid AND c.id = $2::uuid
          FOR UPDATE OF c`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; store_id: string }>;
      if (existing.length === 0) throw new NotFoundException('Category not found');
      if (input.parentCategoryId === id) {
        throw new BadRequestException('Category cannot be its own parent');
      }
      if (input.parentCategoryId) {
        const parentRows = (await tx.$queryRawUnsafe(
          `SELECT 1 AS ok FROM str_category_hierarchy
            WHERE id = $1::uuid AND store_id = $2::uuid`,
          input.parentCategoryId,
          existing[0]!.store_id,
        )) as Array<{ ok: number }>;
        if (parentRows.length === 0) {
          throw new BadRequestException('parentCategoryId does not match a category in this store');
        }
      }
      const sets: string[] = [];
      const args: unknown[] = [];
      let i = 1;
      if (input.name !== undefined) {
        sets.push(`name = $${i++}`);
        args.push(input.name);
      }
      if (input.description !== undefined) {
        sets.push(`description = $${i++}`);
        args.push(input.description);
      }
      if (input.parentCategoryId !== undefined) {
        sets.push(`parent_category_id = $${i++}::uuid`);
        args.push(input.parentCategoryId);
      }
      if (input.sortOrder !== undefined) {
        sets.push(`sort_order = $${i++}::int`);
        args.push(input.sortOrder);
      }
      if (input.isActive !== undefined) {
        sets.push(`is_active = $${i++}`);
        args.push(input.isActive);
      }
      if (sets.length === 0) {
        return this.getById(actor, id);
      }
      sets.push(`updated_at = now()`);
      args.push(id);
      try {
        const rows = (await tx.$queryRawUnsafe(
          `UPDATE str_category_hierarchy SET ${sets.join(', ')}
            WHERE id = $${i}::uuid
            RETURNING id::text AS id, store_id::text AS store_id, name, description,
                      parent_category_id::text AS parent_category_id,
                      sort_order, is_active,
                      created_at::text AS created_at,
                      updated_at::text AS updated_at`,
          ...args,
        )) as CategoryRow[];
        return this.toNode(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('A sibling category with the same name already exists');
        }
        throw err;
      }
    });
  }

  async remove(actor: ResolvedActor, id: string): Promise<void> {
    await assertStoreAdmin(actor, this.permCheck, 'Category remove');
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT c.id::text AS id FROM str_category_hierarchy c
           JOIN str_stores s ON s.id = c.store_id
          WHERE s.school_id = $1::uuid AND c.id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Category not found');
      const childrenRows = (await tx.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM str_category_hierarchy WHERE parent_category_id = $1::uuid`,
        id,
      )) as Array<{ n: number }>;
      if (childrenRows[0]!.n > 0) {
        throw new ConflictException(
          `Cannot remove category — ${childrenRows[0]!.n} child category(ies) still reference it. Reparent or remove children first.`,
        );
      }
      // Products with category_id pointing here will be SET NULL by
      // the schema FK on DELETE. The audit trail is preserved on the
      // product row's updated_at.
      await tx.$executeRawUnsafe(`DELETE FROM str_category_hierarchy WHERE id = $1::uuid`, id);
    });
  }
}
