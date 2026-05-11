import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ActorContextService } from '../iam/actor-context.service';
import { RecipeService } from './recipe.service';
import { InventoryService } from './inventory.service';
import { TransferService } from './transfer.service';
import { StaffMealService } from './staff-meal.service';
import {
  ChargeStaffMealDto,
  CreateIngredientDto,
  CreateInventoryGroupDto,
  CreateInventoryItemDto,
  CreateRecipeDto,
  CreateStaffMealAccountDto,
  CreateTransferRequestDto,
  InventoryGroupResponseDto,
  InventoryItemResponseDto,
  InventoryLevelResponseDto,
  InventoryTransactionResponseDto,
  ReceiveInventoryDto,
  RecipeCostResponseDto,
  RecipeResponseDto,
  RecipeScalingQueryDto,
  RecipeScalingResponseDto,
  StaffMealAccountResponseDto,
  StaffMealDeductionSummaryRowDto,
  StocktakeInventoryDto,
  TransferDecisionDto,
  TransferRequestResponseDto,
  TransferStatus,
  UpdateIngredientDto,
  UpdateInventoryGroupDto,
  UpdateInventoryItemDto,
  UpdateRecipeDto,
  UpdateStaffMealAccountDto,
  UsageInventoryDto,
  WasteInventoryDto,
} from './dto/food-service-advanced.dto';

interface AuthedRequest extends Request {
  user?: { sub: string; personId: string };
}

@ApiTags('food-service-advanced')
@Controller('api/v1')
export class FoodServiceAdvancedController {
  constructor(
    private readonly recipes: RecipeService,
    private readonly inventory: InventoryService,
    private readonly transfers: TransferService,
    private readonly staffMeals: StaffMealService,
    private readonly actors: ActorContextService,
  ) {}

  // ─── Recipes (FDS-003) ────────────────────────────────────────────

  @Get('food-service/recipes')
  @RequirePermission('fds-003:read')
  @ApiOperation({ summary: 'List recipes with optional category filter' })
  async listRecipes(
    @Query('category') category?: string,
    @Query('includeInactive') includeInactive?: string,
  ): Promise<RecipeResponseDto[]> {
    return this.recipes.list({
      category,
      includeInactive: includeInactive === 'true',
    });
  }

  @Get('food-service/recipes/:id')
  @RequirePermission('fds-003:read')
  async getRecipe(@Param('id') id: string): Promise<RecipeResponseDto> {
    return this.recipes.getById(id);
  }

  @Get('food-service/recipes/:id/cost')
  @RequirePermission('fds-003:read')
  @ApiOperation({
    summary:
      'Recipe cost breakdown — totalCost / costPerServing computed from ingredient unit_cost x quantity',
  })
  async getRecipeCost(@Param('id') id: string): Promise<RecipeCostResponseDto> {
    return this.recipes.getCost(id);
  }

  @Get('food-service/recipes/:id/scaling')
  @RequirePermission('fds-003:read')
  @ApiOperation({
    summary: 'Recipe scaling — given a target serving count, compute scaled ingredient quantities',
  })
  async getRecipeScaling(
    @Param('id') id: string,
    @Query() query: RecipeScalingQueryDto,
  ): Promise<RecipeScalingResponseDto> {
    return this.recipes.getScaling(id, query.targetServings);
  }

  @Post('food-service/recipes')
  @RequirePermission('fds-003:write')
  async createRecipe(
    @Body() body: CreateRecipeDto,
    @Req() req: AuthedRequest,
  ): Promise<RecipeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recipes.create(body, actor);
  }

  @Patch('food-service/recipes/:id')
  @RequirePermission('fds-003:write')
  async patchRecipe(
    @Param('id') id: string,
    @Body() body: UpdateRecipeDto,
    @Req() req: AuthedRequest,
  ): Promise<RecipeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recipes.patch(id, body, actor);
  }

  @Post('food-service/recipes/:id/ingredients')
  @RequirePermission('fds-003:write')
  @ApiOperation({
    summary:
      'Add ingredient to recipe. Recipe.allergens (UNION) + cost_per_serving auto-recomputed in the same tx.',
  })
  async addIngredient(
    @Param('id') recipeId: string,
    @Body() body: CreateIngredientDto,
    @Req() req: AuthedRequest,
  ): Promise<RecipeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recipes.addIngredient(recipeId, body, actor);
  }

  @Patch('food-service/recipe-ingredients/:id')
  @RequirePermission('fds-003:write')
  async patchIngredient(
    @Param('id') ingredientId: string,
    @Body() body: UpdateIngredientDto,
    @Req() req: AuthedRequest,
  ): Promise<RecipeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recipes.updateIngredient(ingredientId, body, actor);
  }

  @Delete('food-service/recipe-ingredients/:id')
  @RequirePermission('fds-003:write')
  async deleteIngredient(
    @Param('id') ingredientId: string,
    @Req() req: AuthedRequest,
  ): Promise<RecipeResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.recipes.deleteIngredient(ingredientId, actor);
  }

  // ─── Inventory groups + items (FDS-004) ────────────────────────────

  @Get('food-service/inventory/groups')
  @RequirePermission('fds-004:read')
  async listInventoryGroups(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<InventoryGroupResponseDto[]> {
    return this.inventory.listGroups({ includeInactive: includeInactive === 'true' });
  }

  @Post('food-service/inventory/groups')
  @RequirePermission('fds-004:write')
  async createInventoryGroup(
    @Body() body: CreateInventoryGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryGroupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.createGroup(body, actor);
  }

  @Patch('food-service/inventory/groups/:id')
  @RequirePermission('fds-004:write')
  async patchInventoryGroup(
    @Param('id') id: string,
    @Body() body: UpdateInventoryGroupDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryGroupResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.patchGroup(id, body, actor);
  }

  @Get('food-service/inventory/items')
  @RequirePermission('fds-004:read')
  async listInventoryItems(
    @Query('category') category?: string,
  ): Promise<InventoryItemResponseDto[]> {
    return this.inventory.listItems({ category });
  }

  @Post('food-service/inventory/items')
  @RequirePermission('fds-004:write')
  async createInventoryItem(
    @Body() body: CreateInventoryItemDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.createItem(body, actor);
  }

  @Patch('food-service/inventory/items/:id')
  @RequirePermission('fds-004:write')
  async patchInventoryItem(
    @Param('id') id: string,
    @Body() body: UpdateInventoryItemDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryItemResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.patchItem(id, body, actor);
  }

  // ─── Inventory levels (FDS-004) ───────────────────────────────────

  @Get('food-service/inventory/levels/:groupId')
  @RequirePermission('fds-004:read')
  async listInventoryLevels(
    @Param('groupId') groupId: string,
  ): Promise<InventoryLevelResponseDto[]> {
    return this.inventory.listLevels(groupId);
  }

  // ─── Inventory transactions (FDS-004) ─────────────────────────────

  @Post('food-service/inventory/receive')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'RECEIPT transaction (immutable). Locks the level row, increments stock, writes immutable audit row. Emits fds.inventory.low if the new level crosses below reorder_threshold (RECEIPT cannot cross downward, but the path is consistent).',
  })
  async receive(
    @Body() body: ReceiveInventoryDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.receive(body, actor);
  }

  @Post('food-service/inventory/usage')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'USAGE transaction (immutable). Decrements stock, writes audit row. Emits fds.inventory.low if the new level crosses below reorder_threshold.',
  })
  async usage(
    @Body() body: UsageInventoryDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.usage(body, actor);
  }

  @Post('food-service/inventory/waste')
  @RequirePermission('fds-004:write')
  async waste(
    @Body() body: WasteInventoryDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.waste(body, actor);
  }

  @Post('food-service/inventory/stocktake')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'STOCKTAKE transaction (immutable). Sets the absolute counted quantity, writes a signed delta as the audit row.',
  })
  async stocktake(
    @Body() body: StocktakeInventoryDto,
    @Req() req: AuthedRequest,
  ): Promise<InventoryTransactionResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.inventory.stocktake(body, actor);
  }

  @Get('food-service/inventory/transactions')
  @RequirePermission('fds-004:read')
  async listTransactions(
    @Query('groupId') groupId?: string,
    @Query('itemId') itemId?: string,
    @Query('limit') limit?: string,
  ): Promise<InventoryTransactionResponseDto[]> {
    return this.inventory.listTransactions({
      groupId,
      itemId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ─── Transfer requests (FDS-004) ──────────────────────────────────

  @Get('food-service/inventory/transfers')
  @RequirePermission('fds-004:read')
  async listTransfers(
    @Query('status') status?: TransferStatus,
  ): Promise<TransferRequestResponseDto[]> {
    return this.transfers.list({ status });
  }

  @Get('food-service/inventory/transfers/:id')
  @RequirePermission('fds-004:read')
  async getTransfer(@Param('id') id: string): Promise<TransferRequestResponseDto> {
    return this.transfers.getById(id);
  }

  @Post('food-service/inventory/transfers')
  @RequirePermission('fds-004:write')
  async createTransfer(
    @Body() body: CreateTransferRequestDto,
    @Req() req: AuthedRequest,
  ): Promise<TransferRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.create(body, actor);
  }

  @Patch('food-service/inventory/transfers/:id')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'Approve or reject a PENDING transfer request. reviewed_chk schema invariant stamps reviewed_by + reviewed_at atomically.',
  })
  async decideTransfer(
    @Param('id') id: string,
    @Body() body: TransferDecisionDto,
    @Req() req: AuthedRequest,
  ): Promise<TransferRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.decide(id, body, actor);
  }

  @Post('food-service/inventory/transfers/:id/complete')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'Complete an APPROVED transfer. Writes paired TRANSFER_OUT + TRANSFER_IN immutable transactions with a shared transfer_reference_id, applies signed deltas to both level rows, flips request to COMPLETED.',
  })
  async completeTransfer(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.complete(id, actor);
  }

  @Post('food-service/inventory/transfers/:id/cancel')
  @RequirePermission('fds-004:write')
  async cancelTransfer(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<TransferRequestResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.transfers.cancel(id, actor);
  }

  // ─── Staff meal accounts (FDS-004) ────────────────────────────────

  @Get('food-service/staff-meals')
  @RequirePermission('fds-004:read')
  async listStaffMeals(): Promise<StaffMealAccountResponseDto[]> {
    return this.staffMeals.list();
  }

  @Get('food-service/staff-meals/:employeeId')
  @RequirePermission('fds-004:read')
  async getStaffMealByEmployee(
    @Param('employeeId') employeeId: string,
  ): Promise<StaffMealAccountResponseDto> {
    return this.staffMeals.getByEmployee(employeeId);
  }

  @Post('food-service/staff-meals')
  @RequirePermission('fds-004:write')
  async createStaffMeal(
    @Body() body: CreateStaffMealAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffMealAccountResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.staffMeals.create(body, actor);
  }

  @Patch('food-service/staff-meals/:id')
  @RequirePermission('fds-004:write')
  async patchStaffMeal(
    @Param('id') id: string,
    @Body() body: UpdateStaffMealAccountDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffMealAccountResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.staffMeals.patch(id, body, actor);
  }

  @Post('food-service/staff-meals/:id/charge')
  @RequirePermission('fds-004:write')
  @ApiOperation({
    summary:
      'Apply a staff meal charge. PREPAID: balance >= amount required. PAYROLL: balance can go negative. COMPLIMENTARY: balance unchanged.',
  })
  async chargeStaffMeal(
    @Param('id') id: string,
    @Body() body: ChargeStaffMealDto,
    @Req() req: AuthedRequest,
  ): Promise<StaffMealAccountResponseDto> {
    const actor = await this.actors.resolveActor(req.user!.sub, req.user!.personId);
    return this.staffMeals.charge(id, body, actor);
  }

  @Get('food-service/staff-meals/reports/payroll-deductions')
  @RequirePermission('fds-004:read')
  @ApiOperation({
    summary:
      'Monthly payroll-deduction summary. Returns one row per PAYROLL account with a negative balance. P2-4 payroll job consumes this to settle staff meal deductions.',
  })
  async payrollDeductions(): Promise<StaffMealDeductionSummaryRowDto[]> {
    return this.staffMeals.payrollDeductions();
  }
}
