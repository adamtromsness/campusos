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
  CreateIngredientDto,
  CreateRecipeDto,
  IngredientResponseDto,
  RecipeCostResponseDto,
  RecipeResponseDto,
  RecipeScalingResponseDto,
  UpdateIngredientDto,
  UpdateRecipeDto,
} from './dto/food-service-advanced.dto';
import { isUniqueViolation } from './food-service.errors';

/**
 * RecipeService — Recipe + Ingredient CRUD with auto-computed
 * allergens and cost_per_serving on every ingredient change.
 *
 * allergens auto-compute = UNION of fds_recipe_ingredients.allergens
 * across the recipe.
 *
 * cost_per_serving auto-compute = SUM(unit_cost * quantity) /
 * serving_yield, rounded to 2dp. Ingredients with NULL unit_cost
 * are skipped (the schema allows it; the service treats it as zero
 * for the aggregate and surfaces missing-cost lines as NULL in the
 * cost breakdown).
 *
 * Both updates happen inside the same locked tenant transaction
 * that writes the ingredient mutation, so the parent recipe row is
 * always consistent with its ingredients.
 */
@Injectable()
export class RecipeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException('Only school admins or food service staff can manage recipes');
  }

  async list(args: { category?: string; includeInactive?: boolean }): Promise<RecipeResponseDto[]> {
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
        'SELECT id::text AS id, school_id::text AS school_id, name, category, serving_yield, ' +
          'prep_time_minutes, cook_time_minutes, instructions, allergens, cost_per_serving, ' +
          'menu_item_id::text AS menu_item_id, is_active, created_by::text AS created_by, created_at ' +
          'FROM fds_recipes WHERE ' +
          where.join(' AND ') +
          ' ORDER BY category, name',
        ...params,
      );
    })) as RecipeRow[];
    return rows.map(recipeRowToDto);
  }

  async getById(id: string): Promise<RecipeResponseDto> {
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const recipeRows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, school_id::text AS school_id, name, category, serving_yield, ' +
          'prep_time_minutes, cook_time_minutes, instructions, allergens, cost_per_serving, ' +
          'menu_item_id::text AS menu_item_id, is_active, created_by::text AS created_by, created_at ' +
          'FROM fds_recipes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      )) as RecipeRow[];
      if (recipeRows.length === 0) return null;
      const ingredientRows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, recipe_id::text AS recipe_id, inventory_item_id::text AS inventory_item_id, ' +
          'ingredient_name, quantity, unit, allergens, unit_cost, notes ' +
          'FROM fds_recipe_ingredients WHERE recipe_id = $1::uuid ORDER BY ingredient_name',
        id,
      )) as IngredientRow[];
      return { recipe: recipeRows[0]!, ingredients: ingredientRows };
    });
    if (!result) throw new NotFoundException('Recipe not found');
    const dto = recipeRowToDto(result.recipe);
    dto.ingredients = result.ingredients.map(ingredientRowToDto);
    return dto;
  }

  async create(input: CreateRecipeDto, actor: ResolvedActor): Promise<RecipeResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO fds_recipes (id, school_id, name, category, serving_yield, prep_time_minutes, cook_time_minutes, instructions, allergens, cost_per_serving, menu_item_id, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, ARRAY[]::TEXT[], NULL, $9::uuid, true, $10::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.category,
          input.servingYield,
          input.prepTimeMinutes ?? null,
          input.cookTimeMinutes ?? null,
          input.instructions ?? null,
          input.menuItemId ?? null,
          actor.accountId,
        );
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException('A recipe with this configuration already exists');
      }
      throw err;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateRecipeDto,
    actor: ResolvedActor,
  ): Promise<RecipeResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      sets.push(col + ' = $' + (params.length + 1));
      params.push(val);
    };
    if (input.name !== undefined) push('name', input.name);
    if (input.category !== undefined) push('category', input.category);
    if (input.servingYield !== undefined) push('serving_yield', input.servingYield);
    if (input.prepTimeMinutes !== undefined) push('prep_time_minutes', input.prepTimeMinutes);
    if (input.cookTimeMinutes !== undefined) push('cook_time_minutes', input.cookTimeMinutes);
    if (input.instructions !== undefined) push('instructions', input.instructions);
    if (input.menuItemId !== undefined) {
      sets.push('menu_item_id = $' + (params.length + 1) + '::uuid');
      params.push(input.menuItemId);
    }
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE fds_recipes SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          (params.length - 1) +
          '::uuid AND school_id = $' +
          params.length +
          '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Recipe not found');
    });
    // If serving_yield changed, recompute cost_per_serving so the
    // recipe row stays consistent with its ingredients.
    if (input.servingYield !== undefined) {
      await this.recomputeAllergensAndCost(id);
    }
    return this.getById(id);
  }

  async addIngredient(
    recipeId: string,
    input: CreateIngredientDto,
    actor: ResolvedActor,
  ): Promise<RecipeResponseDto> {
    this.assertCanManage(actor);
    const ingredientId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the parent recipe so concurrent ingredient writes serialise
      // on the recomputation.
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, school_id, serving_yield FROM fds_recipes WHERE id = $1::uuid FOR UPDATE',
        recipeId,
      )) as Array<{ id: string; school_id: string; serving_yield: number }>;
      if (locked.length === 0) throw new NotFoundException('Recipe not found');
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO fds_recipe_ingredients (id, recipe_id, inventory_item_id, ingredient_name, quantity, unit, allergens, unit_cost, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[], $8, $9)',
          ingredientId,
          recipeId,
          input.inventoryItemId ?? null,
          input.ingredientName,
          input.quantity,
          input.unit,
          input.allergens ?? [],
          input.unitCost ?? null,
          input.notes ?? null,
        );
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'An ingredient with this name already exists on this recipe',
          );
        }
        throw err;
      }
      await this.recomputeAllergensAndCostInTx(tx, recipeId);
    });
    return this.getById(recipeId);
  }

  async updateIngredient(
    ingredientId: string,
    input: UpdateIngredientDto,
    actor: ResolvedActor,
  ): Promise<RecipeResponseDto> {
    this.assertCanManage(actor);
    let recipeId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const parent = (await tx.$queryRawUnsafe(
        'SELECT i.recipe_id::text AS recipe_id FROM fds_recipe_ingredients i ' +
          'JOIN fds_recipes r ON r.id = i.recipe_id WHERE i.id = $1::uuid FOR UPDATE OF r',
        ingredientId,
      )) as Array<{ recipe_id: string }>;
      if (parent.length === 0) throw new NotFoundException('Ingredient not found');
      recipeId = parent[0]!.recipe_id;

      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, val: unknown): void => {
        sets.push(col + ' = $' + (params.length + 1));
        params.push(val);
      };
      if (input.inventoryItemId !== undefined) {
        sets.push('inventory_item_id = $' + (params.length + 1) + '::uuid');
        params.push(input.inventoryItemId);
      }
      if (input.ingredientName !== undefined) push('ingredient_name', input.ingredientName);
      if (input.quantity !== undefined) push('quantity', input.quantity);
      if (input.unit !== undefined) push('unit', input.unit);
      if (input.allergens !== undefined) {
        sets.push('allergens = $' + (params.length + 1) + '::text[]');
        params.push(input.allergens);
      }
      if (input.unitCost !== undefined) push('unit_cost', input.unitCost);
      if (input.notes !== undefined) push('notes', input.notes);
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(ingredientId);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE fds_recipe_ingredients SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'An ingredient with this name already exists on this recipe',
          );
        }
        throw err;
      }
      await this.recomputeAllergensAndCostInTx(tx, recipeId);
    });
    return this.getById(recipeId);
  }

  async deleteIngredient(ingredientId: string, actor: ResolvedActor): Promise<RecipeResponseDto> {
    this.assertCanManage(actor);
    let recipeId = '';
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const parent = (await tx.$queryRawUnsafe(
        'SELECT i.recipe_id::text AS recipe_id FROM fds_recipe_ingredients i ' +
          'JOIN fds_recipes r ON r.id = i.recipe_id WHERE i.id = $1::uuid FOR UPDATE OF r',
        ingredientId,
      )) as Array<{ recipe_id: string }>;
      if (parent.length === 0) throw new NotFoundException('Ingredient not found');
      recipeId = parent[0]!.recipe_id;
      await tx.$executeRawUnsafe(
        'DELETE FROM fds_recipe_ingredients WHERE id = $1::uuid',
        ingredientId,
      );
      await this.recomputeAllergensAndCostInTx(tx, recipeId);
    });
    return this.getById(recipeId);
  }

  /**
   * Cost breakdown — surfaces NULL line costs as nulls so the UI
   * can highlight missing ingredient pricing.
   */
  async getCost(id: string): Promise<RecipeCostResponseDto> {
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const recipe = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, serving_yield FROM fds_recipes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; serving_yield: number }>;
      if (recipe.length === 0) return null;
      const ings = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, ingredient_name, quantity, unit, unit_cost FROM fds_recipe_ingredients WHERE recipe_id = $1::uuid ORDER BY ingredient_name',
        id,
      )) as Array<{
        id: string;
        ingredient_name: string;
        quantity: number;
        unit: string;
        unit_cost: number | null;
      }>;
      return { recipe: recipe[0]!, ings };
    });
    if (!result) throw new NotFoundException('Recipe not found');
    const breakdown = result.ings.map((i) => ({
      ingredientId: i.id,
      ingredientName: i.ingredient_name,
      quantity: numFromDecimal(i.quantity),
      unit: i.unit,
      unitCost: i.unit_cost === null ? null : numFromDecimal(i.unit_cost),
      lineCost:
        i.unit_cost === null
          ? null
          : Math.round(numFromDecimal(i.unit_cost) * numFromDecimal(i.quantity) * 100) / 100,
    }));
    const totalCost =
      Math.round(breakdown.reduce((sum, b) => sum + (b.lineCost ?? 0), 0) * 100) / 100;
    const costPerServing = Math.round((totalCost / result.recipe.serving_yield) * 100) / 100;
    return {
      recipeId: result.recipe.id,
      servingYield: result.recipe.serving_yield,
      totalCost,
      costPerServing,
      breakdown,
    };
  }

  /**
   * Recipe scaling — given target servings, compute per-ingredient
   * scaled quantities. The schema serving_yield is the canonical
   * "as-written" yield.
   */
  async getScaling(id: string, targetServings: number): Promise<RecipeScalingResponseDto> {
    if (targetServings <= 0) {
      throw new BadRequestException('targetServings must be > 0');
    }
    const tenant = getCurrentTenant();
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const recipe = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, serving_yield FROM fds_recipes WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      )) as Array<{ id: string; serving_yield: number }>;
      if (recipe.length === 0) return null;
      const ings = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, ingredient_name, quantity, unit FROM fds_recipe_ingredients WHERE recipe_id = $1::uuid ORDER BY ingredient_name',
        id,
      )) as Array<{ id: string; ingredient_name: string; quantity: number; unit: string }>;
      return { recipe: recipe[0]!, ings };
    });
    if (!result) throw new NotFoundException('Recipe not found');
    const scaleFactor = targetServings / result.recipe.serving_yield;
    const scaledIngredients = result.ings.map((i) => ({
      ingredientId: i.id,
      ingredientName: i.ingredient_name,
      scaledQuantity: Math.round(numFromDecimal(i.quantity) * scaleFactor * 1000) / 1000,
      unit: i.unit,
    }));
    return {
      recipeId: result.recipe.id,
      originalServings: result.recipe.serving_yield,
      targetServings,
      scaleFactor: Math.round(scaleFactor * 10000) / 10000,
      scaledIngredients,
    };
  }

  /**
   * Recomputes recipe.allergens (UNION of ingredient allergens) and
   * recipe.cost_per_serving (SUM(unit_cost * quantity) / serving_yield)
   * INSIDE an open tenant transaction. Used by every ingredient
   * mutation path.
   */
  private async recomputeAllergensAndCostInTx(
    tx: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
      $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    recipeId: string,
  ): Promise<void> {
    const ings = (await tx.$queryRawUnsafe(
      'SELECT allergens, quantity, unit_cost FROM fds_recipe_ingredients WHERE recipe_id = $1::uuid',
      recipeId,
    )) as Array<{ allergens: string[]; quantity: number; unit_cost: number | null }>;
    const allergenSet = new Set<string>();
    let totalCost = 0;
    let hasAnyCost = false;
    for (const i of ings) {
      for (const a of i.allergens ?? []) if (a) allergenSet.add(a);
      if (i.unit_cost !== null) {
        hasAnyCost = true;
        totalCost += numFromDecimal(i.unit_cost) * numFromDecimal(i.quantity);
      }
    }
    const aggregateAllergens = Array.from(allergenSet).sort();
    const recipe = (await tx.$queryRawUnsafe(
      'SELECT serving_yield FROM fds_recipes WHERE id = $1::uuid',
      recipeId,
    )) as Array<{ serving_yield: number }>;
    const yieldVal = recipe[0]?.serving_yield ?? 1;
    const costPerServing = hasAnyCost ? Math.round((totalCost / yieldVal) * 100) / 100 : null;
    await tx.$executeRawUnsafe(
      'UPDATE fds_recipes SET allergens = $1::text[], cost_per_serving = $2, updated_at = now() WHERE id = $3::uuid',
      aggregateAllergens,
      costPerServing,
      recipeId,
    );
  }

  /**
   * Wraps recomputeAllergensAndCostInTx in a short tenant transaction
   * for callers (e.g. PATCH /recipes/:id when serving_yield changes)
   * that need to refresh aggregates outside an ingredient mutation.
   */
  private async recomputeAllergensAndCost(recipeId: string): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.recomputeAllergensAndCostInTx(tx, recipeId);
    });
  }
}

// ─── row → DTO helpers ──────────────────────────────────────────────────

interface RecipeRow {
  id: string;
  school_id: string;
  name: string;
  category: string;
  serving_yield: number;
  prep_time_minutes: number | null;
  cook_time_minutes: number | null;
  instructions: string | null;
  allergens: string[];
  cost_per_serving: number | null;
  menu_item_id: string | null;
  is_active: boolean;
  created_by: string;
  created_at: Date;
}

interface IngredientRow {
  id: string;
  recipe_id: string;
  inventory_item_id: string | null;
  ingredient_name: string;
  quantity: number;
  unit: string;
  allergens: string[];
  unit_cost: number | null;
  notes: string | null;
}

function recipeRowToDto(r: RecipeRow): RecipeResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    category: r.category as RecipeResponseDto['category'],
    servingYield: r.serving_yield,
    prepTimeMinutes: r.prep_time_minutes,
    cookTimeMinutes: r.cook_time_minutes,
    instructions: r.instructions,
    allergens: r.allergens ?? [],
    costPerServing: r.cost_per_serving === null ? null : numFromDecimal(r.cost_per_serving),
    menuItemId: r.menu_item_id,
    isActive: r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
  };
}

function ingredientRowToDto(r: IngredientRow): IngredientResponseDto {
  return {
    id: r.id,
    recipeId: r.recipe_id,
    inventoryItemId: r.inventory_item_id,
    ingredientName: r.ingredient_name,
    quantity: numFromDecimal(r.quantity),
    unit: r.unit,
    allergens: r.allergens ?? [],
    unitCost: r.unit_cost === null ? null : numFromDecimal(r.unit_cost),
    notes: r.notes,
  };
}

/**
 * Prisma returns NUMERIC columns as strings via $queryRawUnsafe.
 * Convert defensively so callers always get a JS number.
 */
function numFromDecimal(v: number | string): number {
  if (typeof v === 'number') return v;
  return Number(v);
}
