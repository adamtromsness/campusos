import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const TOUR_TYPES = [
  'GENERAL_OPEN_DAY',
  'INDIVIDUAL_FAMILY_TOUR',
  'VIRTUAL_TOUR',
  'SPECIALIST_TOUR',
] as const;
export type TourType = (typeof TOUR_TYPES)[number];

export const BOOKING_STATUSES = ['CONFIRMED', 'CANCELLED', 'NO_SHOW', 'COMPLETED'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const GUEST_TYPES = ['ADULT', 'CHILD', 'PROSPECTIVE_STUDENT'] as const;
export type GuestType = (typeof GUEST_TYPES)[number];

export class CreateTourSlotDto {
  @IsISO8601()
  tourDate!: string;

  @IsString()
  @MaxLength(8)
  startTime!: string;

  @IsString()
  @MaxLength(8)
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxBookings?: number;

  @IsOptional()
  @IsIn(TOUR_TYPES as unknown as string[])
  tourType?: TourType;

  @IsOptional()
  @IsUUID()
  ledByEmployeeId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingPoint?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateTourSlotDto {
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsBoolean()
  isCancelled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  meetingPoint?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsUUID()
  ledByEmployeeId?: string | null;
}

export class TourGuestInputDto {
  @IsIn(GUEST_TYPES as unknown as string[])
  guestType!: GuestType;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  age?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

export class CreateTourBookingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  familyName!: string;

  @IsEmail()
  @MaxLength(255)
  contactEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TourGuestInputDto)
  guests?: TourGuestInputDto[];
}

export class UpdateTourBookingDto {
  @IsOptional()
  @IsIn(BOOKING_STATUSES as unknown as string[])
  status?: BookingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cancellationReason?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class LinkApplicationDto {
  @IsUUID()
  applicationId!: string;
}

export interface TourSlotResponseDto {
  id: string;
  schoolId: string;
  tourDate: string;
  startTime: string;
  endTime: string;
  maxBookings: number;
  currentBookings: number;
  availableSpots: number;
  tourType: TourType;
  ledByEmployeeId: string | null;
  ledByName: string | null;
  meetingPoint: string | null;
  notes: string | null;
  isPublished: boolean;
  isCancelled: boolean;
  isFull: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TourGuestResponseDto {
  id: string;
  bookingId: string;
  guestType: GuestType;
  firstName: string;
  lastName: string;
  age: number | null;
  notes: string | null;
}

export interface TourBookingResponseDto {
  id: string;
  slotId: string;
  schoolId: string;
  bookedBy: string | null;
  familyName: string;
  contactEmail: string;
  contactPhone: string | null;
  status: BookingStatus;
  bookedAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  linkedApplicationId: string | null;
  notes: string | null;
  guests: TourGuestResponseDto[];
}
