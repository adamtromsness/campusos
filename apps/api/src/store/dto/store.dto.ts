import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ─── Enums (kept in sync with the SQL CHECK constraints) ───

export type StoreType = 'STUDENT' | 'PUBLIC';
export type OrderType = 'STUDENT' | 'PARENT' | 'EXTERNAL';
export type OrderStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PROCESSING'
  | 'READY_FOR_PICKUP'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'BACKORDERED';
export type ShippingMethod = 'PICKUP' | 'SHIPPED';
export type PaymentStatus = 'PENDING' | 'CHARGED' | 'DEFERRED_BACKORDER' | 'REFUNDED';
export type LineStatus = 'IN_STOCK' | 'BACKORDERED' | 'FULFILLED' | 'CANCELLED';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'DECLINED';
export type LocationType = 'BUILDING' | 'DISTRICT';

const STORE_TYPES: StoreType[] = ['STUDENT', 'PUBLIC'];
const ORDER_TYPES: OrderType[] = ['STUDENT', 'PARENT', 'EXTERNAL'];
const ORDER_STATUSES: OrderStatus[] = [
  'PENDING_APPROVAL',
  'APPROVED',
  'PROCESSING',
  'READY_FOR_PICKUP',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'BACKORDERED',
];
const SHIPPING_METHODS: ShippingMethod[] = ['PICKUP', 'SHIPPED'];
const PAYMENT_STATUSES: PaymentStatus[] = ['PENDING', 'CHARGED', 'DEFERRED_BACKORDER', 'REFUNDED'];
const LINE_STATUSES: LineStatus[] = ['IN_STOCK', 'BACKORDERED', 'FULFILLED', 'CANCELLED'];
const LOCATION_TYPES: LocationType[] = ['BUILDING', 'DISTRICT'];

// ─── Stores ───

export class StoreDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty({ enum: STORE_TYPES }) storeType!: StoreType;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateStoreDto {
  @IsIn(STORE_TYPES) storeType!: StoreType;
  @IsString() @MaxLength(150) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export class UpdateStoreDto {
  @IsOptional() @IsString() @MaxLength(150) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ─── Products ───

export class InventoryRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() productId!: string;
  @ApiProperty({ enum: LOCATION_TYPES }) locationType!: LocationType;
  @ApiProperty() locationId!: string;
  @ApiProperty() quantityOnHand!: number;
  @ApiProperty() quantityReserved!: number;
  @ApiProperty() reorderPoint!: number;
  @ApiProperty() reorderQuantity!: number;
}

export class ProductDto {
  @ApiProperty() id!: string;
  @ApiProperty() storeId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiPropertyOptional({ nullable: true }) sku!: string | null;
  @ApiPropertyOptional({ nullable: true }) category!: string | null;
  @ApiProperty() price!: number;
  @ApiPropertyOptional({ nullable: true }) cost!: number | null;
  @ApiProperty({ type: [String] }) imageS3Keys!: string[];
  @ApiProperty() isActive!: boolean;
  @ApiProperty() backorderAllowed!: boolean;
  @ApiPropertyOptional({ nullable: true }) preferredSupplierId!: string | null;
  @ApiProperty({ type: [InventoryRowDto] }) inventory!: InventoryRowDto[];
  @ApiProperty() totalOnHand!: number;
  @ApiProperty() totalReserved!: number;
  @ApiProperty() totalAvailable!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateProductDto {
  @IsUUID() storeId!: string;
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(50) sku?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price!: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) cost?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) imageS3Keys?: string[];
  @IsOptional() @IsBoolean() backorderAllowed?: boolean;
  @IsOptional() @IsUUID() preferredSupplierId?: string;
}

export class UpdateProductDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(50) sku?: string;
  @IsOptional() @IsString() @MaxLength(80) category?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) price?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) cost?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) imageS3Keys?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() backorderAllowed?: boolean;
  @IsOptional() @IsUUID() preferredSupplierId?: string;
}

// ─── Inventory ───

export class AdjustInventoryDto {
  @IsInt() @Min(0) quantityOnHand!: number;
  @IsOptional() @IsInt() @Min(0) reorderPoint?: number;
  @IsOptional() @IsInt() @Min(0) reorderQuantity?: number;
}

// ─── Orders ───

export class OrderLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() productId!: string;
  @ApiPropertyOptional({ nullable: true }) productName!: string | null;
  @ApiPropertyOptional({ nullable: true }) productSku!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() lineTotal!: number;
  @ApiProperty({ enum: LINE_STATUSES }) lineStatus!: LineStatus;
}

export class OrderApprovalDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty() parentPersonId!: string;
  @ApiPropertyOptional({ nullable: true }) parentName!: string | null;
  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'DECLINED'] }) status!: ApprovalStatus;
  @ApiProperty() requestedAt!: string;
  @ApiPropertyOptional({ nullable: true }) respondedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) declineReason!: string | null;
}

export class OrderDto {
  @ApiProperty() id!: string;
  @ApiProperty() storeId!: string;
  @ApiPropertyOptional({ nullable: true }) storeName!: string | null;
  @ApiProperty({ enum: ORDER_TYPES }) orderType!: OrderType;
  @ApiPropertyOptional({ nullable: true }) customerPersonId!: string | null;
  @ApiPropertyOptional({ nullable: true }) customerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) externalCustomerId!: string | null;
  @ApiPropertyOptional({ nullable: true }) externalCustomerName!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentId!: string | null;
  @ApiPropertyOptional({ nullable: true }) studentName!: string | null;
  @ApiProperty() orderNumber!: string;
  @ApiProperty() orderDate!: string;
  @ApiProperty({ enum: ORDER_STATUSES }) status!: OrderStatus;
  @ApiProperty() subtotal!: number;
  @ApiProperty() shippingCost!: number;
  @ApiProperty() total!: number;
  @ApiProperty({ enum: SHIPPING_METHODS }) shippingMethod!: ShippingMethod;
  @ApiPropertyOptional({ nullable: true }) shippingOptionId!: string | null;
  @ApiPropertyOptional({ nullable: true }) shippingOptionName!: string | null;
  @ApiPropertyOptional({ nullable: true }) trackingNumber!: string | null;
  @ApiProperty({ enum: PAYMENT_STATUSES }) paymentStatus!: PaymentStatus;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty({ type: [OrderLineDto] }) lines!: OrderLineDto[];
  @ApiPropertyOptional({ type: OrderApprovalDto, nullable: true })
  approval!: OrderApprovalDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateOrderLineDto {
  @IsUUID() productId!: string;
  @IsInt() @Min(1) quantity!: number;
}

export class CreateOrderDto {
  @IsUUID() storeId!: string;
  @IsIn(ORDER_TYPES) orderType!: OrderType;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsUUID() externalCustomerId?: string;
  @IsOptional() @IsUUID() shippingOptionId?: string;
  @IsIn(SHIPPING_METHODS) shippingMethod!: ShippingMethod;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderLineDto)
  lines!: CreateOrderLineDto[];
}

export class FulfilOrderDto {
  @IsIn(['READY_FOR_PICKUP', 'SHIPPED']) toStatus!: 'READY_FOR_PICKUP' | 'SHIPPED';
  @IsOptional() @IsString() @MaxLength(80) trackingNumber?: string;
}

export class CancelOrderDto {
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class DeclineApprovalDto {
  @IsString() @MaxLength(2000) reason!: string;
}

// ─── External customers ───

export class ExternalCustomerDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional({ nullable: true }) phone!: string | null;
  @ApiPropertyOptional({ nullable: true }) shippingAddress!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() createdAt!: string;
}

export class CreateExternalCustomerDto {
  @IsString() @MaxLength(150) name!: string;
  @IsEmail() @MaxLength(200) email!: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(500) shippingAddress?: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

// ─── Shipping options ───

export class ShippingOptionDto {
  @ApiProperty() id!: string;
  @ApiProperty() storeId!: string;
  @ApiProperty() methodName!: string;
  @ApiPropertyOptional({ nullable: true }) estimatedDays!: number | null;
  @ApiProperty() flatRate!: number;
  @ApiProperty() isActive!: boolean;
}

export class CreateShippingOptionDto {
  @IsUUID() storeId!: string;
  @IsString() @MaxLength(80) methodName!: string;
  @IsOptional() @IsInt() @Min(0) estimatedDays?: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) flatRate!: number;
}

export class UpdateShippingOptionDto {
  @IsOptional() @IsString() @MaxLength(80) methodName?: string;
  @IsOptional() @IsInt() @Min(0) estimatedDays?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) flatRate?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ─── Revenue ───

export class RevenueRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() storeId!: string;
  @ApiPropertyOptional({ nullable: true }) storeName!: string | null;
  @ApiProperty() periodStart!: string;
  @ApiProperty() periodEnd!: string;
  @ApiProperty() totalOrders!: number;
  @ApiProperty() totalRevenue!: number;
  @ApiProperty() totalCost!: number;
  @ApiProperty() grossMargin!: number;
  @ApiProperty() computedAt!: string;
}

export class MaterialiseRevenueDto {
  @IsUUID() storeId!: string;
  @IsString() periodStart!: string;
  @IsString() periodEnd!: string;
}
