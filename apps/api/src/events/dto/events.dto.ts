import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const EVENT_TYPES = [
  'ATHLETIC_GAME',
  'PERFORMANCE',
  'DANCE',
  'FUNDRAISER',
  'GRADUATION',
  'ASSEMBLY',
  'COMMUNITY',
  'OTHER',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['DRAFT', 'ON_SALE', 'SOLD_OUT', 'COMPLETED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TICKET_STATUSES = ['VALID', 'USED', 'CANCELLED', 'REFUNDED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const SCAN_RESULTS = ['VALID', 'ALREADY_SCANNED', 'INVALID', 'EXPIRED'] as const;
export type ScanResult = (typeof SCAN_RESULTS)[number];

export const PASS_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED'] as const;
export type PassStatus = (typeof PASS_STATUSES)[number];

export const COMP_TYPES = [
  'ATHLETE',
  'COACH',
  'OFFICIAL',
  'MEDIA',
  'STAFF',
  'STUDENT',
  'VIP',
  'OTHER',
] as const;
export type CompType = (typeof COMP_TYPES)[number];

export const VOLUNTEER_STATUSES = ['SIGNED_UP', 'CONFIRMED', 'CANCELLED'] as const;
export type VolunteerStatus = (typeof VOLUNTEER_STATUSES)[number];

// ─── Events ───

export class CreateEventDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiProperty({ enum: EVENT_TYPES })
  @IsIn(EVENT_TYPES as unknown as string[])
  eventType!: EventType;

  @ApiProperty({ description: 'ISO date (YYYY-MM-DD)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  eventDate!: string;

  @ApiProperty({ description: 'HH:MM[:SS]' })
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/)
  startTime!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/)
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  venueId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  venueName?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  totalCapacity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  linkedGameId?: string;
}

export class UpdateEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  eventDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/)
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\d{2}:\d{2}(:\d{2})?$/)
  endTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  venueName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  totalCapacity?: number;

  @ApiPropertyOptional({ enum: EVENT_STATUSES })
  @IsOptional()
  @IsIn(EVENT_STATUSES as unknown as string[])
  status?: EventStatus;
}

// ─── Tiers ───

export class CreateTierDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  price!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  saleStartsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  saleEndsAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTierDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  saleStartsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  saleEndsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Orders + Tickets ───

export class PurchaseLineDto {
  @ApiProperty()
  @IsUUID('all')
  tierId!: string;

  @ApiProperty({ minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  quantity!: number;

  @ApiPropertyOptional({ description: 'Optional per-ticket holder names', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @IsString({ each: true })
  holderNames?: string[];
}

export class PurchaseDto {
  @ApiProperty({ type: [PurchaseLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];
}

export class ConfirmOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stripePaymentIntentId?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  cancellationReason?: string;
}

export class RefundOrderDto {
  @ApiProperty({ minimum: 0.01 })
  @IsNumber()
  @Min(0.01)
  refundAmount!: number;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}

// ─── Gate scan ───

export class GateScanDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  qrCodeToken!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('all')
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  scanSource?: string;
}

// ─── Season passes ───

export class CreateSeasonPassDto {
  @ApiProperty()
  @IsUUID('all')
  personId!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  passType!: string;

  @ApiPropertyOptional({ description: 'Specific events the pass admits; omit for all events' })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  eventsIncluded?: string[];

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  price!: number;

  @ApiProperty()
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, {
    message: 'academicYear must be like 2025-2026',
  })
  academicYear!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stripePaymentIntentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class SeasonPassGateCheckDto {
  @ApiProperty()
  @IsUUID('all')
  passId!: string;

  @ApiProperty()
  @IsUUID('all')
  eventId!: string;
}

// ─── Comp lists ───

export class AddCompEntryDto {
  @ApiProperty({ enum: COMP_TYPES })
  @IsIn(COMP_TYPES as unknown as string[])
  compType!: CompType;

  @ApiProperty()
  @IsUUID('all')
  personId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CompCheckDto {
  @ApiProperty()
  @IsUUID('all')
  eventId!: string;

  @ApiProperty()
  @IsUUID('all')
  personId!: string;
}

// ─── Volunteers ───

export class CreateVolunteerDto {
  @ApiProperty()
  @IsUUID('all')
  personId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateVolunteerDto {
  @ApiPropertyOptional({ enum: VOLUNTEER_STATUSES })
  @IsOptional()
  @IsIn(VOLUNTEER_STATUSES as unknown as string[])
  status?: VolunteerStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;

  @ApiPropertyOptional({ description: 'Stamp check-in timestamp when status flips to CONFIRMED' })
  @IsOptional()
  @IsBoolean()
  checkIn?: boolean;
}

// ─── Response shapes ───

export interface EventDto {
  id: string;
  schoolId: string;
  title: string;
  description: string | null;
  eventType: EventType;
  eventDate: string;
  startTime: string;
  endTime: string | null;
  venueId: string | null;
  venueName: string | null;
  totalCapacity: number | null;
  totalTierQuantity: number;
  linkedGameId: string | null;
  status: EventStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tiers?: TierDto[];
}

export interface TierDto {
  id: string;
  eventId: string;
  name: string;
  price: number;
  quantity: number;
  quantitySold: number;
  remaining: number;
  saleStartsAt: string | null;
  saleEndsAt: string | null;
  isActive: boolean;
}

export interface OrderDto {
  id: string;
  eventId: string;
  eventTitle: string | null;
  purchaserId: string;
  purchaserName: string | null;
  status: OrderStatus;
  totalAmount: number;
  stripePaymentIntentId: string | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
  tickets: TicketDto[];
}

export interface TicketDto {
  id: string;
  orderId: string;
  tierId: string;
  tierName: string | null;
  holderName: string | null;
  qrCodeToken: string;
  status: TicketStatus;
  scannedAt: string | null;
}

export interface RefundDto {
  id: string;
  orderId: string;
  refundAmount: number;
  reason: string;
  stripeRefundId: string | null;
  refundedBy: string;
  refundedAt: string;
}

export interface GateScanResultDto {
  scanResult: ScanResult;
  ticketId: string | null;
  holderName: string | null;
  tierName: string | null;
  eventTitle: string | null;
  scannedAt: string;
  message: string;
}

export interface SeasonPassDto {
  id: string;
  schoolId: string;
  personId: string;
  personName: string | null;
  passType: string;
  eventsIncluded: string[] | null;
  price: number;
  purchasedAt: string | null;
  stripePaymentIntentId: string | null;
  status: PassStatus;
  academicYear: string;
  notes: string | null;
}

export interface SeasonPassGateCheckResultDto {
  admitted: boolean;
  reason: string;
}

export interface CompEntryDto {
  id: string;
  eventId: string;
  compType: CompType;
  personId: string;
  personName: string | null;
  notes: string | null;
  addedBy: string;
  addedByName: string | null;
  addedAt: string;
}

export interface CompCheckResultDto {
  admitted: boolean;
  compType: CompType | null;
  personName: string | null;
}

export interface VolunteerDto {
  id: string;
  eventId: string;
  personId: string;
  personName: string | null;
  role: string | null;
  status: VolunteerStatus;
  checkInAt: string | null;
  notes: string | null;
}
