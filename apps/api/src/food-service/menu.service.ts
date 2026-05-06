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
import {
  AddDailyMenuItemDto,
  CreateDailyMenuDto,
  CreateMenuCycleDto,
  CreateMenuItemDto,
  DailyMenuItemResponseDto,
  DailyMenuResponseDto,
  GenerateFromCycleDto,
  MealType,
  MenuCycleResponseDto,
  MenuItemCategory,
  MenuItemResponseDto,
  UpdateMenuCycleDto,
  UpdateMenuItemDto,
} from './dto/food-service.dto';

function assertCanManage(actor: ResolvedActor): void {
  if (actor.isSchoolAdmin) return;
  if (actor.personType === 'STAFF') return;
  throw new ForbiddenException('Only school admins or food service staff can manage menus');
}

@Injectable()
export class MenuCycleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<MenuCycleResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, cycle_length_days, is_active, created_at ' +
          'FROM fds_menu_cycles WHERE school_id = $1::uuid ORDER BY name',
        tenant.schoolId,
      );
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      description: string | null;
      cycle_length_days: number;
      is_active: boolean;
      created_at: Date;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      cycleLengthDays: r.cycle_length_days,
      isActive: r.is_active,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async create(input: CreateMenuCycleDto, actor: ResolvedActor): Promise<MenuCycleResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_menu_cycles (id, school_id, name, description, cycle_length_days, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, $6::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.cycleLengthDays ?? 5,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A menu cycle with this name already exists for this school');
      }
      throw err;
    }
    const list = await this.list();
    return list.find((c) => c.id === id)!;
  }

  async patch(
    cycleId: string,
    input: UpdateMenuCycleDto,
    actor: ResolvedActor,
  ): Promise<MenuCycleResponseDto> {
    assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(cycleId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fds_menu_cycles SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const list = await this.list();
    const found = list.find((c) => c.id === cycleId);
    if (!found) throw new NotFoundException('Menu cycle not found');
    return found;
  }
}

@Injectable()
export class MenuItemService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(args: {
    category?: MenuItemCategory;
    includeInactive?: boolean;
  }): Promise<MenuItemResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.category) {
      where.push('category = $' + (params.length + 1));
      params.push(args.category);
    }
    if (!args.includeInactive) where.push('is_active = true');

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, category, ' +
          'unit_cost, calories, allergens, allergen_codes, ' +
          'is_vegetarian, is_vegan, is_gluten_free, is_preorderable, is_active ' +
          'FROM fds_menu_items WHERE ' +
          where.join(' AND ') +
          ' ORDER BY category, name',
        ...params,
      );
    })) as MenuItemRow[];
    return rows.map(itemRowToDto);
  }

  async getById(id: string): Promise<MenuItemResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, category, ' +
          'unit_cost, calories, allergens, allergen_codes, ' +
          'is_vegetarian, is_vegan, is_gluten_free, is_preorderable, is_active ' +
          'FROM fds_menu_items WHERE id = $1::uuid LIMIT 1',
        id,
      );
    })) as MenuItemRow[];
    if (rows.length === 0) throw new NotFoundException('Menu item not found');
    return itemRowToDto(rows[0]!);
  }

  /**
   * Returns items containing ANY of the supplied allergen codes via
   * the GIN-indexed && (array overlap) operator. Used by the Step 6
   * UI to highlight items unsafe for a patron.
   */
  async allergenCheck(codes: string[]): Promise<MenuItemResponseDto[]> {
    if (codes.length === 0) return [];
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, description, category, ' +
          'unit_cost, calories, allergens, allergen_codes, ' +
          'is_vegetarian, is_vegan, is_gluten_free, is_preorderable, is_active ' +
          'FROM fds_menu_items WHERE school_id = $1::uuid AND is_active = true AND allergen_codes && $2::text[] ORDER BY name',
        tenant.schoolId,
        codes,
      );
    })) as MenuItemRow[];
    return rows.map(itemRowToDto);
  }

  async create(input: CreateMenuItemDto, actor: ResolvedActor): Promise<MenuItemResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO fds_menu_items (id, school_id, name, description, category, unit_cost, calories, allergens, allergen_codes, is_vegetarian, is_vegan, is_gluten_free, is_preorderable, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::text[], $9::text[], $10, $11, $12, $13, $14::uuid)',
        id,
        tenant.schoolId,
        input.name,
        input.description ?? null,
        input.category,
        input.unitCost ?? null,
        input.calories ?? null,
        input.allergens ?? [],
        input.allergenCodes ?? [],
        input.isVegetarian ?? false,
        input.isVegan ?? false,
        input.isGlutenFree ?? false,
        input.isPreorderable ?? true,
        actor.accountId,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateMenuItemDto,
    actor: ResolvedActor,
  ): Promise<MenuItemResponseDto> {
    assertCanManage(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.category !== undefined) {
      sets.push('category = $' + (params.length + 1));
      params.push(input.category);
    }
    if (input.unitCost !== undefined) {
      sets.push('unit_cost = $' + (params.length + 1));
      params.push(input.unitCost);
    }
    if (input.calories !== undefined) {
      sets.push('calories = $' + (params.length + 1));
      params.push(input.calories);
    }
    if (input.allergens !== undefined) {
      sets.push('allergens = $' + (params.length + 1) + '::text[]');
      params.push(input.allergens);
    }
    if (input.allergenCodes !== undefined) {
      sets.push('allergen_codes = $' + (params.length + 1) + '::text[]');
      params.push(input.allergenCodes);
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + (params.length + 1));
      params.push(input.isActive);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE fds_menu_items SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    return this.getById(id);
  }
}

@Injectable()
export class DailyMenuService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async getByDate(menuDate: string, mealType: MealType): Promise<DailyMenuResponseDto | null> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, menu_date, cycle_id::text AS cycle_id, meal_type, notes ' +
          'FROM fds_daily_menus WHERE school_id = $1::uuid AND menu_date = $2::date AND meal_type = $3 LIMIT 1',
        tenant.schoolId,
        menuDate,
        mealType,
      );
    })) as Array<{
      id: string;
      school_id: string;
      menu_date: Date;
      cycle_id: string | null;
      meal_type: string;
      notes: string | null;
    }>;
    if (rows.length === 0) return null;
    const r = rows[0]!;
    const items = await this.listItems(r.id);
    return {
      id: r.id,
      schoolId: r.school_id,
      menuDate: r.menu_date.toISOString().slice(0, 10),
      cycleId: r.cycle_id,
      mealType: r.meal_type as MealType,
      notes: r.notes,
      items,
    };
  }

  async listByDateRange(fromDate: string, toDate: string): Promise<DailyMenuResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, menu_date, cycle_id::text AS cycle_id, meal_type, notes ' +
          'FROM fds_daily_menus WHERE school_id = $1::uuid AND menu_date BETWEEN $2::date AND $3::date ' +
          'ORDER BY menu_date, meal_type',
        tenant.schoolId,
        fromDate,
        toDate,
      );
    })) as Array<{
      id: string;
      school_id: string;
      menu_date: Date;
      cycle_id: string | null;
      meal_type: string;
      notes: string | null;
    }>;
    const out: DailyMenuResponseDto[] = [];
    for (const r of rows) {
      const items = await this.listItems(r.id);
      out.push({
        id: r.id,
        schoolId: r.school_id,
        menuDate: r.menu_date.toISOString().slice(0, 10),
        cycleId: r.cycle_id,
        mealType: r.meal_type as MealType,
        notes: r.notes,
        items,
      });
    }
    return out;
  }

  async listItems(dailyMenuId: string): Promise<DailyMenuItemResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT dmi.id::text AS id, dmi.daily_menu_id::text AS daily_menu_id, dmi.menu_item_id::text AS menu_item_id, ' +
          'mi.name AS menu_item_name, mi.category AS category, mi.unit_cost, mi.allergen_codes, ' +
          'dmi.quantity_prepared, dmi.quantity_served, dmi.quantity_wasted, dmi.is_available ' +
          'FROM fds_daily_menu_items dmi LEFT JOIN fds_menu_items mi ON mi.id = dmi.menu_item_id ' +
          'WHERE dmi.daily_menu_id = $1::uuid ORDER BY mi.category, mi.name',
        dailyMenuId,
      );
    })) as Array<{
      id: string;
      daily_menu_id: string;
      menu_item_id: string;
      menu_item_name: string | null;
      category: string | null;
      unit_cost: number | null;
      allergen_codes: string[] | null;
      quantity_prepared: number | null;
      quantity_served: number | null;
      quantity_wasted: number | null;
      is_available: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      dailyMenuId: r.daily_menu_id,
      menuItemId: r.menu_item_id,
      menuItemName: r.menu_item_name,
      category: (r.category as MenuItemCategory) ?? null,
      unitCost: r.unit_cost !== null ? Number(r.unit_cost) : null,
      allergenCodes: r.allergen_codes ?? [],
      quantityPrepared: r.quantity_prepared,
      quantityServed: r.quantity_served,
      quantityWasted: r.quantity_wasted,
      isAvailable: r.is_available,
    }));
  }

  async create(input: CreateDailyMenuDto, actor: ResolvedActor): Promise<DailyMenuResponseDto> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_daily_menus (id, school_id, menu_date, cycle_id, meal_type, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6, $7::uuid)',
          id,
          tenant.schoolId,
          input.menuDate,
          input.cycleId ?? null,
          input.mealType,
          input.notes ?? null,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A daily menu already exists for this school + date + meal type',
        );
      }
      throw err;
    }
    const fetched = await this.getByDate(input.menuDate, input.mealType);
    if (!fetched) throw new NotFoundException('Daily menu not found after insert');
    return fetched;
  }

  async addItem(
    dailyMenuId: string,
    input: AddDailyMenuItemDto,
    actor: ResolvedActor,
  ): Promise<DailyMenuItemResponseDto> {
    assertCanManage(actor);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_daily_menu_items (id, daily_menu_id, menu_item_id, quantity_prepared, is_available) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, true)',
          id,
          dailyMenuId,
          input.menuItemId,
          input.quantityPrepared ?? null,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('This menu item is already on the daily menu');
      }
      throw err;
    }
    const items = await this.listItems(dailyMenuId);
    const found = items.find((it) => it.id === id);
    if (!found) throw new NotFoundException('Daily menu item not found after insert');
    return found;
  }

  /**
   * Bulk-generate empty daily menus for a date range driven by a
   * cycle. The cycle defines the cadence; per-day item assignments
   * are added separately via addItem.
   */
  async generateFromCycle(
    input: GenerateFromCycleDto,
    actor: ResolvedActor,
  ): Promise<{ created: number; skipped: number }> {
    assertCanManage(actor);
    const tenant = getCurrentTenant();
    const start = new Date(input.startDate);
    const end = new Date(input.endDate);
    if (end < start) throw new BadRequestException('endDate must be on or after startDate');

    let created = 0;
    let skipped = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO fds_daily_menus (id, school_id, menu_date, cycle_id, meal_type, created_by) ' +
              'VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6::uuid)',
            generateId(),
            tenant.schoolId,
            day,
            input.cycleId,
            input.mealType,
            actor.accountId,
          );
        });
        created++;
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          skipped++;
          continue;
        }
        throw err;
      }
    }
    return { created, skipped };
  }
}

interface MenuItemRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  category: string;
  unit_cost: number | null;
  calories: number | null;
  allergens: string[];
  allergen_codes: string[];
  is_vegetarian: boolean;
  is_vegan: boolean;
  is_gluten_free: boolean;
  is_preorderable: boolean;
  is_active: boolean;
}

function itemRowToDto(r: MenuItemRow): MenuItemResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    category: r.category as MenuItemCategory,
    unitCost: r.unit_cost !== null ? Number(r.unit_cost) : null,
    calories: r.calories,
    allergens: r.allergens,
    allergenCodes: r.allergen_codes,
    isVegetarian: r.is_vegetarian,
    isVegan: r.is_vegan,
    isGlutenFree: r.is_gluten_free,
    isPreorderable: r.is_preorderable,
    isActive: r.is_active,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === 'P2010' || e.meta?.code === '23505') return true;
  if (e.code === '23505') return true;
  return typeof e.message === 'string' && e.message.includes('23505');
}
