import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * P2-10a DTOs — Food Service Advanced sub-cycle a.
 * Recipes + Inventory + Transfers + Staff meal accounts.
 */

export type RecipeCategory =
  | 'ENTREE'
  | 'SIDE'
  | 'VEGETABLE'
  | 'FRUIT'
  | 'GRAIN'
  | 'DAIRY'
  | 'BEVERAGE'
  | 'SNACK'
  | 'DESSERT';

export const RECIPE_CATEGORIES: RecipeCategory[] = [
  'ENTREE',
  'SIDE',
  'VEGETABLE',
  'FRUIT',
  'GRAIN',
  'DAIRY',
  'BEVERAGE',
  'SNACK',
  'DESSERT',
];

export type InventoryGroupType =
  | 'LUNCH'
  | 'BREAKFAST'
  | 'SNACK'
  | 'CONCESSIONS'
  | 'CATERING'
  | 'OTHER';

export const INVENTORY_GROUP_TYPES: InventoryGroupType[] = [
  'LUNCH',
  'BREAKFAST',
  'SNACK',
  'CONCESSIONS',
  'CATERING',
  'OTHER',
];

export type InventoryCategory =
  | 'PROTEIN'
  | 'DAIRY'
  | 'GRAIN'
  | 'VEGETABLE'
  | 'FRUIT'
  | 'CONDIMENT'
  | 'BEVERAGE'
  | 'PACKAGING'
  | 'OTHER';

export const INVENTORY_CATEGORIES: InventoryCategory[] = [
  'PROTEIN',
  'DAIRY',
  'GRAIN',
  'VEGETABLE',
  'FRUIT',
  'CONDIMENT',
  'BEVERAGE',
  'PACKAGING',
  'OTHER',
];

export type InventoryTransactionType =
  | 'RECEIPT'
  | 'USAGE'
  | 'WASTE'
  | 'ADJUSTMENT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'STOCKTAKE';

export type TransferStatus = 'PENDING' | 'APPROVED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED';

export type StaffMealDeductionMethod = 'PAYROLL' | 'PREPAID' | 'COMPLIMENTARY';

// ─── Recipe DTOs ─────────────────────────────────────────────────────────

export class CreateRecipeDto {
  @ApiProperty() @IsString() @MaxLength(160) name!: string;

  @ApiProperty({ enum: RECIPE_CATEGORIES })
  @IsIn(RECIPE_CATEGORIES)
  category!: RecipeCategory;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  servingYield!: number;

  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) prepTimeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) cookTimeMinutes?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() menuItemId?: string | null;
}

export class UpdateRecipeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) name?: string;
  @ApiPropertyOptional({ enum: RECIPE_CATEGORIES })
  @IsOptional()
  @IsIn(RECIPE_CATEGORIES)
  category?: RecipeCategory;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) servingYield?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) prepTimeMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) cookTimeMinutes?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() instructions?: string | null;
  @ApiPropertyOptional() @IsOptional() menuItemId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateIngredientDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() inventoryItemId?: string | null;
  @ApiProperty() @IsString() @MaxLength(160) ingredientName!: string;
  @ApiProperty({ minimum: 0.001 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @ApiProperty() @IsString() @MaxLength(40) unit!: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @IsString({ each: true })
  allergens?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) unitCost?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdateIngredientDto {
  @ApiPropertyOptional() @IsOptional() inventoryItemId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) ingredientName?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) unit?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) unitCost?:
    | number
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string | null;
}

export class RecipeScalingQueryDto {
  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetServings!: number;
}

export class IngredientResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() recipeId!: string;
  @ApiPropertyOptional() inventoryItemId!: string | null;
  @ApiProperty() ingredientName!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unit!: string;
  @ApiProperty({ type: [String] }) allergens!: string[];
  @ApiPropertyOptional() unitCost!: number | null;
  @ApiPropertyOptional() notes!: string | null;
}

export class RecipeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: RECIPE_CATEGORIES }) category!: RecipeCategory;
  @ApiProperty() servingYield!: number;
  @ApiPropertyOptional() prepTimeMinutes!: number | null;
  @ApiPropertyOptional() cookTimeMinutes!: number | null;
  @ApiPropertyOptional() instructions!: string | null;
  @ApiProperty({ type: [String] }) allergens!: string[];
  @ApiPropertyOptional() costPerServing!: number | null;
  @ApiPropertyOptional() menuItemId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
  @ApiPropertyOptional({ type: [IngredientResponseDto] })
  ingredients?: IngredientResponseDto[];
}

export class RecipeCostResponseDto {
  @ApiProperty() recipeId!: string;
  @ApiProperty() servingYield!: number;
  @ApiProperty() totalCost!: number;
  @ApiProperty() costPerServing!: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: 'Per-ingredient cost breakdown',
  })
  breakdown!: Array<{
    ingredientId: string;
    ingredientName: string;
    quantity: number;
    unit: string;
    unitCost: number | null;
    lineCost: number | null;
  }>;
}

export class RecipeScalingResponseDto {
  @ApiProperty() recipeId!: string;
  @ApiProperty() originalServings!: number;
  @ApiProperty() targetServings!: number;
  @ApiProperty() scaleFactor!: number;
  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
  })
  scaledIngredients!: Array<{
    ingredientId: string;
    ingredientName: string;
    scaledQuantity: number;
    unit: string;
  }>;
}

// ─── Inventory DTOs ──────────────────────────────────────────────────────

export class CreateInventoryGroupDto {
  @ApiProperty() @IsString() @MaxLength(160) name!: string;
  @ApiProperty({ enum: INVENTORY_GROUP_TYPES })
  @IsIn(INVENTORY_GROUP_TYPES)
  groupType!: InventoryGroupType;
  @ApiPropertyOptional() @IsOptional() @IsString() location?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() managedBy?: string;
}

export class UpdateInventoryGroupDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) name?: string;
  @ApiPropertyOptional({ enum: INVENTORY_GROUP_TYPES })
  @IsOptional()
  @IsIn(INVENTORY_GROUP_TYPES)
  groupType?: InventoryGroupType;
  @ApiPropertyOptional() @IsOptional() location?: string | null;
  @ApiPropertyOptional() @IsOptional() managedBy?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class InventoryGroupResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: INVENTORY_GROUP_TYPES }) groupType!: InventoryGroupType;
  @ApiPropertyOptional() location!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiPropertyOptional() managedBy!: string | null;
}

export class CreateInventoryItemDto {
  @ApiProperty() @IsString() @MaxLength(160) name!: string;
  @ApiProperty() @IsString() @MaxLength(40) unit!: string;
  @ApiProperty({ enum: INVENTORY_CATEGORIES })
  @IsIn(INVENTORY_CATEGORIES)
  category!: InventoryCategory;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergenCodes?: string[];
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  reorderThreshold?: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() preferredVendorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost?: number;
}

export class UpdateInventoryItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(160) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) unit?: string;
  @ApiPropertyOptional({ enum: INVENTORY_CATEGORIES })
  @IsOptional()
  @IsIn(INVENTORY_CATEGORIES)
  category?: InventoryCategory;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergenCodes?: string[];
  @ApiPropertyOptional() @IsOptional() reorderThreshold?: number | null;
  @ApiPropertyOptional() @IsOptional() preferredVendorId?: string | null;
  @ApiPropertyOptional() @IsOptional() unitCost?: number | null;
}

export class InventoryItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() unit!: string;
  @ApiProperty({ enum: INVENTORY_CATEGORIES }) category!: InventoryCategory;
  @ApiProperty({ type: [String] }) allergenCodes!: string[];
  @ApiPropertyOptional() reorderThreshold!: number | null;
  @ApiPropertyOptional() preferredVendorId!: string | null;
  @ApiPropertyOptional() unitCost!: number | null;
}

export class InventoryLevelResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() itemId!: string;
  @ApiProperty() itemName!: string;
  @ApiProperty() unit!: string;
  @ApiProperty() category!: InventoryCategory;
  @ApiProperty() quantityOnHand!: number;
  @ApiPropertyOptional() reorderThreshold!: number | null;
  @ApiProperty() belowReorderThreshold!: boolean;
  @ApiPropertyOptional() lastCountedAt!: string | null;
}

export class ReceiveInventoryDto {
  @ApiProperty() @IsUUID() groupId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 0.001 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UsageInventoryDto {
  @ApiProperty() @IsUUID() groupId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 0.001 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsUUID() relatedSessionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class WasteInventoryDto {
  @ApiProperty() @IsUUID() groupId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 0.001 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class StocktakeInventoryDto {
  @ApiProperty() @IsUUID() groupId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 0 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  countedQuantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class InventoryTransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() groupId!: string;
  @ApiProperty() itemId!: string;
  @ApiProperty() transactionType!: InventoryTransactionType;
  @ApiProperty() quantityDelta!: number;
  @ApiProperty() performedBy!: string;
  @ApiProperty() transactionAt!: string;
  @ApiPropertyOptional() transferReferenceId!: string | null;
  @ApiPropertyOptional() relatedSessionId!: string | null;
  @ApiPropertyOptional() notes!: string | null;
}

// ─── Transfer DTOs ───────────────────────────────────────────────────────

export class CreateTransferRequestDto {
  @ApiProperty() @IsUUID() fromGroupId!: string;
  @ApiProperty() @IsUUID() toGroupId!: string;
  @ApiProperty() @IsUUID() itemId!: string;
  @ApiProperty({ minimum: 0.001 })
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class TransferDecisionDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class TransferRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() fromGroupId!: string;
  @ApiProperty() toGroupId!: string;
  @ApiProperty() itemId!: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() reason!: string | null;
  @ApiProperty() status!: TransferStatus;
  @ApiProperty() requestedBy!: string;
  @ApiPropertyOptional() reviewedBy!: string | null;
  @ApiPropertyOptional() reviewedAt!: string | null;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiPropertyOptional() transferReferenceId!: string | null;
}

// ─── Staff meal DTOs ─────────────────────────────────────────────────────

export class CreateStaffMealAccountDto {
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiPropertyOptional({ enum: ['PAYROLL', 'PREPAID', 'COMPLIMENTARY'] })
  @IsOptional()
  @IsIn(['PAYROLL', 'PREPAID', 'COMPLIMENTARY'])
  deductionMethod?: StaffMealDeductionMethod;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  dailyLimit?: number;
}

export class UpdateStaffMealAccountDto {
  @ApiPropertyOptional({ enum: ['PAYROLL', 'PREPAID', 'COMPLIMENTARY'] })
  @IsOptional()
  @IsIn(['PAYROLL', 'PREPAID', 'COMPLIMENTARY'])
  deductionMethod?: StaffMealDeductionMethod;
  @ApiPropertyOptional() @IsOptional() dailyLimit?: number | null;
}

export class ChargeStaffMealDto {
  @ApiProperty({ minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1000)
  amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class StaffMealAccountResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;
  @ApiPropertyOptional() schoolId!: string | null;
  @ApiProperty() balance!: number;
  @ApiProperty({ enum: ['PAYROLL', 'PREPAID', 'COMPLIMENTARY'] })
  deductionMethod!: StaffMealDeductionMethod;
  @ApiPropertyOptional() dailyLimit!: number | null;
}

export class StaffMealDeductionSummaryRowDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty() chargeCount!: number;
  @ApiProperty() totalAmount!: number;
}

// ─── P2-10b Pre-order DTOs ──────────────────────────────────────────────

export type PreorderMealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';

export const PREORDER_MEAL_TYPES: PreorderMealType[] = ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'];

export type PreorderStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';

export class CreatePreorderWindowDto {
  @ApiProperty() @IsString() serviceDate!: string;
  @ApiProperty({ enum: PREORDER_MEAL_TYPES })
  @IsIn(PREORDER_MEAL_TYPES)
  mealType!: PreorderMealType;
  @ApiProperty() @IsString() opensAt!: string;
  @ApiProperty() @IsString() closesAt!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class UpdatePreorderWindowDto {
  @ApiPropertyOptional() @IsOptional() @IsString() opensAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() closesAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class PreorderWindowResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() serviceDate!: string;
  @ApiProperty() mealType!: PreorderMealType;
  @ApiProperty() opensAt!: string;
  @ApiProperty() closesAt!: string;
  @ApiProperty() isOpen!: boolean;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty() createdAt!: string;
}

export class PreorderItemInputDto {
  @ApiProperty() @IsUUID() menuItemId!: string;
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CreatePreorderDto {
  @ApiProperty() @IsUUID() studentId!: string;
  @ApiProperty() @IsUUID() preorderWindowId!: string;
  @ApiProperty({ type: () => [PreorderItemInputDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @Type(() => PreorderItemInputDto)
  items!: PreorderItemInputDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class CancelPreorderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() reason?: string;
}

export class PreorderItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() preorderId!: string;
  @ApiProperty() menuItemId!: string;
  @ApiPropertyOptional() menuItemName!: string | null;
  @ApiPropertyOptional() menuItemAllergens!: string[] | null;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() notes!: string | null;
}

export class PreorderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() preorderWindowId!: string;
  @ApiProperty() serviceDate!: string;
  @ApiProperty() mealType!: PreorderMealType;
  @ApiProperty() orderedBy!: string;
  @ApiProperty({ enum: ['PENDING', 'CONFIRMED', 'CANCELLED'] })
  status!: PreorderStatus;
  @ApiProperty() allergenCheckPassed!: boolean;
  @ApiProperty({ type: [String] }) blockingAllergens!: string[];
  @ApiProperty({ type: [String] }) warningAllergens!: string[];
  @ApiPropertyOptional() confirmedAt!: string | null;
  @ApiPropertyOptional() cancelledAt!: string | null;
  @ApiPropertyOptional() cancellationReason!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiProperty({ type: () => [PreorderItemResponseDto] })
  items!: PreorderItemResponseDto[];
  @ApiProperty() createdAt!: string;
}

export class GenerateProductionReportDto {
  @ApiProperty() @IsString() serviceDate!: string;
  @ApiProperty({ enum: PREORDER_MEAL_TYPES })
  @IsIn(PREORDER_MEAL_TYPES)
  mealType!: PreorderMealType;
}

export class ProductionReportItemRowDto {
  @ApiProperty() menuItemId!: string;
  @ApiPropertyOptional() menuItemName!: string | null;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty() orderCount!: number;
}

export class ProductionReportDietaryRowDto {
  @ApiProperty() allergen!: string;
  @ApiProperty() affectedOrders!: number;
}

export class ProductionReportResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() serviceDate!: string;
  @ApiProperty() mealType!: PreorderMealType;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalItems!: number;
  @ApiProperty({ type: () => [ProductionReportItemRowDto] })
  itemBreakdown!: ProductionReportItemRowDto[];
  @ApiProperty({ type: () => [ProductionReportDietaryRowDto] })
  dietaryBreakdown!: ProductionReportDietaryRowDto[];
  @ApiProperty() generatedBy!: string;
  @ApiProperty() generatedAt!: string;
}
