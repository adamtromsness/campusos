import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// ── Enums ──
export type MenuItemCategory = 'MAIN' | 'SIDE' | 'DESSERT' | 'DRINK' | 'SNACK';
export type MealType = 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'SNACK';
export type PosDeviceType = 'CASHIER_STAFFED' | 'SELF_SERVICE_KIOSK' | 'MOBILE_CART';
export type PaymentMethod = 'LUNCH_ACCOUNT' | 'INVOICE' | 'CASH' | 'FREE_MEAL' | 'STAFF_ACCOUNT';
export type PatronType = 'STUDENT' | 'STAFF';
export type ReconciliationStatus = 'OPEN' | 'RECONCILED' | 'VARIANCE_FLAGGED';
export type AllergenSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type DietaryMealPlan = 'STANDARD' | 'VEGETARIAN' | 'VEGAN' | 'HALAL' | 'KOSHER' | 'OTHER';
export type DietaryUpdateChangeType =
  | 'ADD_RESTRICTION'
  | 'REMOVE_RESTRICTION'
  | 'ADD_ALLERGEN'
  | 'REMOVE_ALLERGEN'
  | 'CHANGE_MEAL_PLAN'
  | 'UPDATE_ELIGIBILITY';
export type DietaryUpdateStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type EligibilityApplicationType = 'INCOME_BASED' | 'CATEGORICAL' | 'DIRECT_CERTIFICATION';
export type EligibilityStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'DENIED' | 'WITHDRAWN';
export type EligibilityCategory = 'FREE' | 'REDUCED' | 'PAID' | 'DENIED';
export type UsdaClaimStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export type TempCheckLocation =
  | 'DELIVERY'
  | 'REFRIGERATOR'
  | 'FREEZER'
  | 'SERVING_LINE'
  | 'HOT_HOLD'
  | 'COLD_HOLD'
  | 'COOK_TEMP';

// ── Menu Cycles ──
export class CreateMenuCycleDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  cycleLengthDays?: number;
}

export class UpdateMenuCycleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MenuCycleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() cycleLengthDays!: number;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
}

// ── Menu Items ──
export class CreateMenuItemDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ['MAIN', 'SIDE', 'DESSERT', 'DRINK', 'SNACK'] })
  @IsIn(['MAIN', 'SIDE', 'DESSERT', 'DRINK', 'SNACK'])
  category!: MenuItemCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  unitCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  calories?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergenCodes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVegetarian?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVegan?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isGlutenFree?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPreorderable?: boolean;
}

export class UpdateMenuItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['MAIN', 'SIDE', 'DESSERT', 'DRINK', 'SNACK'] })
  @IsOptional()
  @IsIn(['MAIN', 'SIDE', 'DESSERT', 'DRINK', 'SNACK'])
  category?: MenuItemCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  unitCost?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  calories?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergenCodes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MenuItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() category!: MenuItemCategory;
  @ApiPropertyOptional() unitCost!: number | null;
  @ApiPropertyOptional() calories!: number | null;
  @ApiProperty({ type: [String] }) allergens!: string[];
  @ApiProperty({ type: [String] }) allergenCodes!: string[];
  @ApiProperty() isVegetarian!: boolean;
  @ApiProperty() isVegan!: boolean;
  @ApiProperty() isGlutenFree!: boolean;
  @ApiProperty() isPreorderable!: boolean;
  @ApiProperty() isActive!: boolean;
}

// ── Daily Menus ──
export class CreateDailyMenuDto {
  @ApiProperty()
  @IsISO8601()
  menuDate!: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  @IsIn(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'])
  mealType!: MealType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cycleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class AddDailyMenuItemDto {
  @ApiProperty()
  @IsUUID()
  menuItemId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  quantityPrepared?: number;
}

export class GenerateFromCycleDto {
  @ApiProperty()
  @IsUUID()
  cycleId!: string;

  @ApiProperty()
  @IsISO8601()
  startDate!: string;

  @ApiProperty()
  @IsISO8601()
  endDate!: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  @IsIn(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'])
  mealType!: MealType;
}

export class DailyMenuItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() dailyMenuId!: string;
  @ApiProperty() menuItemId!: string;
  @ApiPropertyOptional() menuItemName!: string | null;
  @ApiPropertyOptional() category!: MenuItemCategory | null;
  @ApiPropertyOptional() unitCost!: number | null;
  @ApiProperty({ type: [String] }) allergenCodes!: string[];
  @ApiPropertyOptional() quantityPrepared!: number | null;
  @ApiPropertyOptional() quantityServed!: number | null;
  @ApiPropertyOptional() quantityWasted!: number | null;
  @ApiProperty() isAvailable!: boolean;
}

export class DailyMenuResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() menuDate!: string;
  @ApiPropertyOptional() cycleId!: string | null;
  @ApiProperty() mealType!: MealType;
  @ApiPropertyOptional() notes!: string | null;
  @ApiPropertyOptional() items?: DailyMenuItemResponseDto[];
}

// ── POS Devices ──
export class CreatePosDeviceDto {
  @ApiProperty()
  @IsString()
  @Length(2, 200)
  deviceName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ enum: ['CASHIER_STAFFED', 'SELF_SERVICE_KIOSK', 'MOBILE_CART'] })
  @IsOptional()
  @IsIn(['CASHIER_STAFFED', 'SELF_SERVICE_KIOSK', 'MOBILE_CART'])
  deviceType?: PosDeviceType;
}

export class UpdatePosDeviceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  deviceName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PosDeviceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() deviceName!: string;
  @ApiPropertyOptional() location!: string | null;
  @ApiProperty() deviceType!: PosDeviceType;
  @ApiProperty() isActive!: boolean;
}

// ── Sessions ──
export class OpenSessionDto {
  @ApiProperty()
  @IsISO8601()
  serviceDate!: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  @IsIn(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'])
  mealType!: MealType;
}

export class SessionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() serviceDate!: string;
  @ApiProperty() mealType!: MealType;
  @ApiProperty() openedBy!: string;
  @ApiPropertyOptional() openedByName!: string | null;
  @ApiProperty() openedAt!: string;
  @ApiPropertyOptional() closedBy!: string | null;
  @ApiPropertyOptional() closedAt!: string | null;
  @ApiProperty() transactionCount!: number;
  @ApiProperty() totalSales!: number;
}

// ── Transactions ──
export class TransactionItemDto {
  @ApiProperty()
  @IsUUID()
  itemId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty()
  @IsNumber()
  price!: number;
}

export class CreateTransactionDto {
  @ApiProperty()
  @IsUUID()
  patronId!: string;

  @ApiPropertyOptional({ enum: ['STUDENT', 'STAFF'] })
  @IsOptional()
  @IsIn(['STUDENT', 'STAFF'])
  patronType?: PatronType;

  @ApiProperty()
  @IsUUID()
  sessionId!: string;

  @ApiProperty()
  @IsUUID()
  posDeviceId!: string;

  @ApiProperty({ type: [TransactionItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  items!: TransactionItemDto[];

  @ApiProperty({
    enum: ['LUNCH_ACCOUNT', 'INVOICE', 'CASH', 'FREE_MEAL', 'STAFF_ACCOUNT'],
  })
  @IsIn(['LUNCH_ACCOUNT', 'INVOICE', 'CASH', 'FREE_MEAL', 'STAFF_ACCOUNT'])
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ description: 'Required when an allergen CRITICAL match is overridden' })
  @IsOptional()
  @IsUUID()
  supervisorOverrideId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  overrideReason?: string;
}

export class TransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() patronId!: string;
  @ApiPropertyOptional() patronName!: string | null;
  @ApiProperty() patronType!: PatronType;
  @ApiProperty() sessionId!: string;
  @ApiProperty() posDeviceId!: string;
  @ApiProperty() items!: unknown;
  @ApiProperty() total!: number;
  @ApiProperty() paymentMethod!: PaymentMethod;
  @ApiProperty() allergenOverrideRequired!: boolean;
  @ApiPropertyOptional() supervisorOverrideId!: string | null;
  @ApiPropertyOptional() overrideReason!: string | null;
  @ApiProperty() servedAt!: string;
  @ApiPropertyOptional() warnings?: AllergenMatchDto[];
}

export class AllergenMatchDto {
  @ApiProperty() itemId!: string;
  @ApiPropertyOptional() itemName!: string | null;
  @ApiProperty({ type: [String] }) matchedAllergens!: string[];
  @ApiProperty() severity!: AllergenSeverity;
}

export class AllergenCheckResponseDto {
  @ApiProperty() patronId!: string;
  @ApiProperty({ type: [String] }) activeAllergens!: string[];
  @ApiProperty() criticalCount!: number;
  @ApiProperty() warningCount!: number;
  @ApiProperty() infoCount!: number;
}

// ── Reconciliation ──
export class UpdateReconciliationDto {
  @ApiProperty()
  @IsNumber()
  actualClosingBalance!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReconciliationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() sessionId!: string;
  @ApiProperty() posDeviceId!: string;
  @ApiProperty() openingBalance!: number;
  @ApiProperty() expectedClosingBalance!: number;
  @ApiPropertyOptional() actualClosingBalance!: number | null;
  @ApiPropertyOptional() variance!: number | null;
  @ApiPropertyOptional() reconciledBy!: string | null;
  @ApiPropertyOptional() reconciledAt!: string | null;
  @ApiProperty() status!: ReconciliationStatus;
}

// ── Dietary ──
export class UpdateDietaryProfileDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  dietaryRestrictions?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  freeMealEligible?: boolean;

  @ApiPropertyOptional({ enum: ['STANDARD', 'VEGETARIAN', 'VEGAN', 'HALAL', 'KOSHER', 'OTHER'] })
  @IsOptional()
  @IsIn(['STANDARD', 'VEGETARIAN', 'VEGAN', 'HALAL', 'KOSHER', 'OTHER'])
  mealPlanType?: DietaryMealPlan;
}

export class DietaryProfileResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ type: [String] }) dietaryRestrictions!: string[];
  @ApiProperty({ type: [String] }) allergens!: string[];
  @ApiProperty() freeMealEligible!: boolean;
  @ApiProperty() mealPlanType!: DietaryMealPlan;
}

export class CreateDietaryUpdateRequestDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({
    enum: [
      'ADD_RESTRICTION',
      'REMOVE_RESTRICTION',
      'ADD_ALLERGEN',
      'REMOVE_ALLERGEN',
      'CHANGE_MEAL_PLAN',
      'UPDATE_ELIGIBILITY',
    ],
  })
  @IsIn([
    'ADD_RESTRICTION',
    'REMOVE_RESTRICTION',
    'ADD_ALLERGEN',
    'REMOVE_ALLERGEN',
    'CHANGE_MEAL_PLAN',
    'UPDATE_ELIGIBILITY',
  ])
  changeType!: DietaryUpdateChangeType;

  @ApiProperty()
  @IsString()
  @Length(1, 500)
  proposedValue!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReviewDietaryUpdateDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewNotes?: string;
}

export class DietaryUpdateRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() submittedBy!: string;
  @ApiPropertyOptional() submittedByName!: string | null;
  @ApiProperty() changeType!: DietaryUpdateChangeType;
  @ApiProperty() proposedValue!: string;
  @ApiPropertyOptional() reason!: string | null;
  @ApiProperty() status!: DietaryUpdateStatus;
  @ApiPropertyOptional() reviewedBy!: string | null;
  @ApiPropertyOptional() reviewedAt!: string | null;
  @ApiPropertyOptional() reviewNotes!: string | null;
  @ApiProperty() createdAt!: string;
}

// ── Allergen alerts ──
export class AllergenAlertResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() schoolId!: string;
  @ApiProperty() allergenCode!: string;
  @ApiProperty() allergenDisplayName!: string;
  @ApiProperty() severity!: AllergenSeverity;
  @ApiProperty() sourceHealthAlertId!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() lastSyncedAt!: string;
}

// ── NSLP eligibility ──
export class CreateEligibilityApplicationDto {
  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  householdSize!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  annualHouseholdIncome?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  snapBenefitCaseNumber?: string;

  @ApiProperty({ enum: ['INCOME_BASED', 'CATEGORICAL', 'DIRECT_CERTIFICATION'] })
  @IsIn(['INCOME_BASED', 'CATEGORICAL', 'DIRECT_CERTIFICATION'])
  applicationType!: EligibilityApplicationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class DetermineEligibilityDto {
  @ApiProperty({ enum: ['FREE', 'REDUCED', 'PAID', 'DENIED'] })
  @IsIn(['FREE', 'REDUCED', 'PAID', 'DENIED'])
  eligibilityCategory!: EligibilityCategory;

  @ApiProperty()
  @IsISO8601()
  effectiveFrom!: string;

  @ApiProperty()
  @IsISO8601()
  effectiveTo!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class EligibilityDeterminationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() applicationId!: string;
  @ApiProperty() determinedBy!: string;
  @ApiProperty() determinedAt!: string;
  @ApiProperty() eligibilityCategory!: EligibilityCategory;
  @ApiProperty() effectiveFrom!: string;
  @ApiProperty() effectiveTo!: string;
  @ApiProperty() notificationSent!: boolean;
}

export class EligibilityApplicationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() studentId!: string;
  @ApiPropertyOptional() studentName!: string | null;
  @ApiProperty() submittedBy!: string;
  @ApiProperty() householdSize!: number;
  @ApiPropertyOptional() annualHouseholdIncome!: number | null;
  @ApiPropertyOptional() snapBenefitCaseNumber!: string | null;
  @ApiProperty() applicationType!: EligibilityApplicationType;
  @ApiProperty() status!: EligibilityStatus;
  @ApiProperty() submittedAt!: string;
  @ApiPropertyOptional({ type: () => EligibilityDeterminationResponseDto })
  determination?: EligibilityDeterminationResponseDto;
}

// ── USDA claims ──
export class GenerateUsdaClaimDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @ApiProperty({ description: 'YYYY-MM-DD; the day-component is ignored, only the month is used' })
  @IsISO8601()
  monthYear!: string;
}

export class UsdaClaimResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional() academicYearId!: string | null;
  @ApiProperty() monthYear!: string;
  @ApiProperty() freeMealsCount!: number;
  @ApiProperty() reducedMealsCount!: number;
  @ApiProperty() paidMealsCount!: number;
  @ApiPropertyOptional() reimbursementAmount!: number | null;
  @ApiProperty() status!: UsdaClaimStatus;
  @ApiPropertyOptional() submittedAt!: string | null;
}

// ── Temperature logs ──
export class CreateTemperatureLogDto {
  @ApiProperty({
    enum: [
      'DELIVERY',
      'REFRIGERATOR',
      'FREEZER',
      'SERVING_LINE',
      'HOT_HOLD',
      'COLD_HOLD',
      'COOK_TEMP',
    ],
  })
  @IsIn([
    'DELIVERY',
    'REFRIGERATOR',
    'FREEZER',
    'SERVING_LINE',
    'HOT_HOLD',
    'COLD_HOLD',
    'COOK_TEMP',
  ])
  checkLocation!: TempCheckLocation;

  @ApiProperty()
  @IsString()
  @Length(2, 200)
  locationName!: string;

  @ApiProperty()
  @IsNumber()
  temperatureCelsius!: number;

  @ApiProperty()
  @IsNumber()
  safeRangeMin!: number;

  @ApiProperty()
  @IsNumber()
  safeRangeMax!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  correctiveAction?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class TemperatureLogResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() checkLocation!: TempCheckLocation;
  @ApiProperty() locationName!: string;
  @ApiProperty() temperatureCelsius!: number;
  @ApiProperty() safeRangeMin!: number;
  @ApiProperty() safeRangeMax!: number;
  @ApiProperty() isCompliant!: boolean;
  @ApiPropertyOptional() correctiveAction!: string | null;
  @ApiProperty() loggedBy!: string;
  @ApiPropertyOptional() loggedByName!: string | null;
  @ApiProperty() loggedAt!: string;
}

// ── Production records ──
export class CreateProductionRecordDto {
  @ApiProperty()
  @IsISO8601()
  mealServiceDate!: string;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] })
  @IsIn(['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'])
  mealType!: MealType;

  @ApiProperty()
  @IsUUID()
  menuItemId!: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  quantityPrepared!: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  quantityServed!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  quantityLeftover?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  quantityWasted?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  meetsMealPattern?: boolean;
}

export class ProductionRecordResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() mealServiceDate!: string;
  @ApiProperty() mealType!: MealType;
  @ApiProperty() menuItemId!: string;
  @ApiPropertyOptional() menuItemName!: string | null;
  @ApiProperty() quantityPrepared!: number;
  @ApiProperty() quantityServed!: number;
  @ApiProperty() quantityLeftover!: number;
  @ApiProperty() quantityWasted!: number;
  @ApiProperty() meetsMealPattern!: boolean;
}
