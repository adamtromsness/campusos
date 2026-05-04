import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  CategoryResponseDto,
  CreateCategoryDto,
  CreateSubcategoryDto,
  SubcategoryResponseDto,
  UpdateCategoryDto,
  UpdateSubcategoryDto,
} from './dto/ticket.dto';

interface CategoryRow {
  id: string;
  school_id: string;
  parent_category_id: string | null;
  name: string;
  icon: string | null;
  is_active: boolean;
}

interface SubcategoryRow {
  id: string;
  category_id: string;
  name: string;
  default_assignee_id: string | null;
  default_assignee_first: string | null;
  default_assignee_last: string | null;
  auto_assign_to_role: string | null;
  is_active: boolean;
}

const SELECT_SUBCATEGORY_BASE =
  'SELECT s.id::text AS id, s.category_id::text AS category_id, s.name, ' +
  's.default_assignee_id::text AS default_assignee_id, ' +
  'p.first_name AS default_assignee_first, p.last_name AS default_assignee_last, ' +
  's.auto_assign_to_role, s.is_active ' +
  'FROM tkt_subcategories s ' +
  'LEFT JOIN hr_employees e ON e.id = s.default_assignee_id ' +
  'LEFT JOIN platform.iam_person p ON p.id = e.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToSubDto(r: SubcategoryRow): SubcategoryResponseDto {
  return {
    id: r.id,
    categoryId: r.category_id,
    name: r.name,
    defaultAssigneeId: r.default_assignee_id,
    defaultAssigneeName: fullName(r.default_assignee_first, r.default_assignee_last),
    autoAssignToRole: r.auto_assign_to_role,
    isActive: r.is_active,
  };
}

@Injectable()
export class CategoryService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * List categories with their subcategories inlined. Active-only by default;
   * pass includeInactive to surface deactivated rows for admin maintenance.
   */
  async list(includeInactive: boolean): Promise<CategoryResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const cats = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, ' +
          'parent_category_id::text AS parent_category_id, name, icon, is_active ' +
          'FROM tkt_categories ' +
          (includeInactive ? '' : 'WHERE is_active = true ') +
          'ORDER BY parent_category_id NULLS FIRST, name',
      )) as CategoryRow[];

      const subs = (await client.$queryRawUnsafe(
        SELECT_SUBCATEGORY_BASE +
          (includeInactive ? '' : 'WHERE s.is_active = true ') +
          'ORDER BY s.name',
      )) as SubcategoryRow[];

      const subsByCategory = new Map<string, SubcategoryResponseDto[]>();
      for (const s of subs) {
        const list = subsByCategory.get(s.category_id) ?? [];
        list.push(rowToSubDto(s));
        subsByCategory.set(s.category_id, list);
      }

      return cats.map((c) => ({
        id: c.id,
        schoolId: c.school_id,
        parentCategoryId: c.parent_category_id,
        name: c.name,
        icon: c.icon,
        isActive: c.is_active,
        subcategories: subsByCategory.get(c.id) ?? [],
      }));
    });
  }

  async createCategory(input: CreateCategoryDto): Promise<CategoryResponseDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    if (input.parentCategoryId) {
      await this.assertCategoryExists(input.parentCategoryId);
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO tkt_categories (id, school_id, parent_category_id, name, icon) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
          id,
          tenant.schoolId,
          input.parentCategoryId ?? null,
          input.name,
          input.icon ?? null,
        );
      } catch (err) {
        throw this.translateUnique(err, 'Category', input.name);
      }
    });
    return this.getById(id);
  }

  async updateCategory(id: string, input: UpdateCategoryDto): Promise<CategoryResponseDto> {
    await this.assertCategoryExists(id);
    if (Object.keys(input).length === 0) return this.getById(id);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(input.name);
      idx++;
    }
    if (input.icon !== undefined) {
      if (input.icon === null) sets.push('icon = NULL');
      else {
        sets.push('icon = $' + idx);
        params.push(input.icon);
        idx++;
      }
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    sets.push('updated_at = now()');
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'UPDATE tkt_categories SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
          ...params,
          id,
        );
      } catch (err) {
        throw this.translateUnique(err, 'Category', input.name ?? '');
      }
    });
    return this.getById(id);
  }

  async createSubcategory(input: CreateSubcategoryDto): Promise<SubcategoryResponseDto> {
    await this.assertCategoryExists(input.categoryId);
    if (input.defaultAssigneeId) {
      await this.assertEmployeeExists(input.defaultAssigneeId);
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO tkt_subcategories (id, category_id, name, default_assignee_id, auto_assign_to_role) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)',
          id,
          input.categoryId,
          input.name,
          input.defaultAssigneeId ?? null,
          input.autoAssignToRole ?? null,
        );
      } catch (err) {
        throw this.translateUnique(err, 'Subcategory', input.name);
      }
    });
    return this.getSubcategoryById(id);
  }

  async updateSubcategory(
    id: string,
    input: UpdateSubcategoryDto,
  ): Promise<SubcategoryResponseDto> {
    await this.assertSubcategoryExists(id);
    if (input.defaultAssigneeId) {
      await this.assertEmployeeExists(input.defaultAssigneeId);
    }
    if (Object.keys(input).length === 0) return this.getSubcategoryById(id);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(input.name);
      idx++;
    }
    if (input.defaultAssigneeId !== undefined) {
      if (input.defaultAssigneeId === null) sets.push('default_assignee_id = NULL');
      else {
        sets.push('default_assignee_id = $' + idx + '::uuid');
        params.push(input.defaultAssigneeId);
        idx++;
      }
    }
    if (input.autoAssignToRole !== undefined) {
      if (input.autoAssignToRole === null) sets.push('auto_assign_to_role = NULL');
      else {
        sets.push('auto_assign_to_role = $' + idx);
        params.push(input.autoAssignToRole);
        idx++;
      }
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    sets.push('updated_at = now()');
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'UPDATE tkt_subcategories SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
          ...params,
          id,
        );
      } catch (err) {
        throw this.translateUnique(err, 'Subcategory', input.name ?? '');
      }
    });
    return this.getSubcategoryById(id);
  }

  /**
   * Internal helper used by TicketService at submission time. Returns the
   * subcategory with its denormalised assignee fields so the auto-assignment
   * chain can pick the path without a second DB hit.
   */
  async loadSubcategoryForAssignment(id: string): Promise<SubcategoryRow> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubcategoryRow[]>(
        SELECT_SUBCATEGORY_BASE + 'WHERE s.id = $1::uuid AND s.is_active = true',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Subcategory ' + id);
    return rows[0]!;
  }

  private async getById(id: string): Promise<CategoryResponseDto> {
    const all = await this.list(true);
    const match = all.find((c) => c.id === id);
    if (!match) throw new NotFoundException('Category ' + id);
    return match;
  }

  private async getSubcategoryById(id: string): Promise<SubcategoryResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SubcategoryRow[]>(
        SELECT_SUBCATEGORY_BASE + 'WHERE s.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Subcategory ' + id);
    return rowToSubDto(rows[0]!);
  }

  private async assertCategoryExists(id: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM tkt_categories WHERE id = $1::uuid LIMIT 1',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Category ' + id);
  }

  private async assertSubcategoryExists(id: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM tkt_subcategories WHERE id = $1::uuid LIMIT 1',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Subcategory ' + id);
  }

  private async assertEmployeeExists(id: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        id,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException('defaultAssigneeId does not match any hr_employees row');
    }
  }

  private translateUnique(err: unknown, entity: string, name: string): Error {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    const code = e?.meta?.code ?? e?.code;
    if (code === '23505' || (e?.message && e.message.includes('unique constraint'))) {
      return new BadRequestException(entity + ' name already exists: ' + name);
    }
    return err as Error;
  }
}
