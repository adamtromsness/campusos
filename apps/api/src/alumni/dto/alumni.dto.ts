import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Enums ────────────────────────────────────────────────────

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OutreachStatus =
  | 'PENDING'
  | 'SENT'
  | 'OPENED'
  | 'RESPONDED'
  | 'DONATED'
  | 'UNSUBSCRIBED';
export const OUTREACH_STATUSES: readonly OutreachStatus[] = [
  'PENDING',
  'SENT',
  'OPENED',
  'RESPONDED',
  'DONATED',
  'UNSUBSCRIBED',
] as const;

export type NewsCategory = 'ACHIEVEMENT' | 'EVENT' | 'OPPORTUNITY' | 'GENERAL';
export const NEWS_CATEGORIES: readonly NewsCategory[] = [
  'ACHIEVEMENT',
  'EVENT',
  'OPPORTUNITY',
  'GENERAL',
] as const;

export type ReunionStatus = 'PLANNING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED';
export const REUNION_STATUSES: readonly ReunionStatus[] = [
  'PLANNING',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
] as const;

// ── Profiles ──────────────────────────────────────────────────

export class AlumniProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() personId!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() graduationYear!: number;
  @ApiPropertyOptional() degreeProgramme!: string | null;
  @ApiPropertyOptional() currentEmployer!: string | null;
  @ApiPropertyOptional() currentTitle!: string | null;
  @ApiPropertyOptional() linkedinUrl!: string | null;
  @ApiPropertyOptional() contactEmail!: string | null;
  @ApiPropertyOptional() contactPhone!: string | null;
  @ApiProperty() isOptedIn!: boolean;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAlumniProfileDto {
  @IsUUID()
  @ApiProperty()
  personId!: string;
  @IsInt()
  @Min(1900)
  @Max(2100)
  @ApiProperty()
  graduationYear!: number;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  degreeProgramme?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  currentEmployer?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  currentTitle?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  linkedinUrl?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  contactEmail?: string;
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @ApiPropertyOptional()
  contactPhone?: string;
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  isOptedIn?: boolean;
}

export class UpdateAlumniProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  degreeProgramme?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  currentEmployer?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  currentTitle?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  linkedinUrl?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  contactEmail?: string;
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @ApiPropertyOptional()
  contactPhone?: string;
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  isOptedIn?: boolean;
}

export class AlumniTagDto {
  @ApiProperty() id!: string;
  @ApiProperty() alumniId!: string;
  @ApiProperty() tag!: string;
  @ApiProperty() createdAt!: string;
}

export class AddTagDto {
  @IsUUID()
  @ApiProperty()
  alumniId!: string;
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  @ApiProperty()
  tag!: string;
}

// ── Campaigns ─────────────────────────────────────────────────

export class CampaignDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() goalAmount!: number | null;
  @ApiProperty() reportingCurrency!: string;
  @ApiPropertyOptional() startDate!: string | null;
  @ApiPropertyOptional() endDate!: string | null;
  @ApiProperty() status!: CampaignStatus;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional() activatedAt!: string | null;
  @ApiPropertyOptional() completedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  /** Live raised total in reporting_currency. Cached in Redis. */
  @ApiProperty() raisedAmount!: number;
  @ApiProperty() recipientCount!: number;
  @ApiProperty() donationCount!: number;
}

export class CreateCampaignDto {
  @IsString()
  @Length(1, 200)
  @ApiProperty()
  title!: string;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional()
  goalAmount?: number;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  @ApiPropertyOptional()
  reportingCurrency?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  startDate?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  endDate?: string;
}

export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  title?: string;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsNumber()
  @Min(0)
  @ApiPropertyOptional()
  goalAmount?: number;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  startDate?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  endDate?: string;
  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED'])
  @ApiPropertyOptional()
  status?: CampaignStatus;
}

export class CampaignFunnelDto {
  @ApiProperty() campaignId!: string;
  @ApiProperty() pending!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() opened!: number;
  @ApiProperty() responded!: number;
  @ApiProperty() donated!: number;
  @ApiProperty() unsubscribed!: number;
  @ApiProperty() total!: number;
}

export class CampaignRaisedDto {
  @ApiProperty() campaignId!: string;
  @ApiProperty() raisedAmount!: number;
  @ApiProperty() reportingCurrency!: string;
  @ApiProperty() cached!: boolean;
}

export class AddRecipientsByTagDto {
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  @ApiProperty()
  tag!: string;
}

export class CampaignRecipientDto {
  @ApiProperty() id!: string;
  @ApiProperty() campaignId!: string;
  @ApiProperty() alumniId!: string;
  @ApiProperty() outreachStatus!: OutreachStatus;
  @ApiPropertyOptional() sentAt!: string | null;
  @ApiPropertyOptional() openedAt!: string | null;
  @ApiPropertyOptional() respondedAt!: string | null;
  @ApiPropertyOptional() donatedAt!: string | null;
  @ApiPropertyOptional() unsubscribedAt!: string | null;
}

export class UpdateRecipientStatusDto {
  @IsIn(['PENDING', 'SENT', 'OPENED', 'RESPONDED', 'DONATED', 'UNSUBSCRIBED'])
  @ApiProperty()
  status!: OutreachStatus;
}

// ── Donations ────────────────────────────────────────────────

export class DonationDto {
  @ApiProperty() id!: string;
  @ApiProperty() campaignId!: string;
  /**
   * Donor alumni id. When is_anonymous=true, this is suppressed for
   * non-admin callers and surfaced as null + displayName='Anonymous'.
   */
  @ApiPropertyOptional() donorAlumniId!: string | null;
  @ApiPropertyOptional() donorDisplayName!: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional() fxRateAtDonation!: number | null;
  @ApiProperty() amountInReportingCurrency!: number;
  @ApiPropertyOptional() paymentRef!: string | null;
  @ApiPropertyOptional() stripePaymentIntentId!: string | null;
  @ApiProperty() donatedAt!: string;
  @ApiProperty() isAnonymous!: boolean;
}

export class CreateDonationDto {
  @IsNumber()
  @Min(0.01)
  @ApiProperty()
  amount!: number;
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  @ApiProperty()
  currency!: string;
  @IsOptional()
  @IsNumber()
  @Min(0.0001)
  @ApiPropertyOptional()
  fxRateAtDonation?: number;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  paymentRef?: string;
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  stripePaymentIntentId?: string;
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  isAnonymous?: boolean;
}

// ── News ─────────────────────────────────────────────────────

export class AlumniNewsDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() authorId!: string;
  @ApiPropertyOptional() authorName!: string | null;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty() category!: NewsCategory;
  @ApiPropertyOptional() publishedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAlumniNewsDto {
  @IsString()
  @Length(1, 300)
  @ApiProperty()
  title!: string;
  @IsString()
  @Length(1, 20000)
  @ApiProperty()
  body!: string;
  @IsIn(['ACHIEVEMENT', 'EVENT', 'OPPORTUNITY', 'GENERAL'])
  @ApiProperty()
  category!: NewsCategory;
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  publish?: boolean;
}

export class UpdateAlumniNewsDto {
  @IsOptional()
  @IsString()
  @Length(1, 300)
  @ApiPropertyOptional()
  title?: string;
  @IsOptional()
  @IsString()
  @Length(1, 20000)
  @ApiPropertyOptional()
  body?: string;
  @IsOptional()
  @IsIn(['ACHIEVEMENT', 'EVENT', 'OPPORTUNITY', 'GENERAL'])
  @ApiPropertyOptional()
  category?: NewsCategory;
  @IsOptional()
  @IsBoolean()
  @ApiPropertyOptional()
  publish?: boolean;
}

// ── Reunions ─────────────────────────────────────────────────

export class ReunionGroupDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() graduationYear!: number;
  @ApiProperty() name!: string;
  @ApiProperty() organiserId!: string;
  @ApiPropertyOptional() organiserName!: string | null;
  @ApiPropertyOptional() eventDate!: string | null;
  @ApiPropertyOptional() rsvpDeadline!: string | null;
  @ApiProperty() status!: ReunionStatus;
  @ApiPropertyOptional() description!: string | null;
  @ApiPropertyOptional() venue!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateReunionGroupDto {
  @IsInt()
  @Min(1900)
  @Max(2100)
  @ApiProperty()
  graduationYear!: number;
  @IsString()
  @Length(1, 200)
  @ApiProperty()
  name!: string;
  @IsUUID()
  @ApiProperty()
  organiserId!: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  eventDate?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  rsvpDeadline?: string;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  venue?: string;
}

export class UpdateReunionGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  name?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  eventDate?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  rsvpDeadline?: string;
  @IsOptional()
  @IsIn(['PLANNING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'])
  @ApiPropertyOptional()
  status?: ReunionStatus;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  venue?: string;
}

// ── Alumni Events ────────────────────────────────────────────

export class AlumniEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() eventDate!: string;
  @ApiPropertyOptional() venue!: string | null;
  @ApiPropertyOptional() rsvpUrl!: string | null;
  /**
   * Soft display-only reference to P2-12 evt_events(id). The Step 6
   * service resolves this against the Events API at read time and
   * falls back to rsvp_url when the call fails or the row is missing.
   */
  @ApiPropertyOptional() evtEventId!: string | null;
  /** Populated only when evt_event_id resolves cleanly against Events. */
  @ApiPropertyOptional() ticketsAvailable!: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateAlumniEventDto {
  @IsString()
  @Length(1, 200)
  @ApiProperty()
  title!: string;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsString()
  @ApiProperty()
  eventDate!: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  venue?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  rsvpUrl?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  evtEventId?: string;
}

export class UpdateAlumniEventDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  @ApiPropertyOptional()
  title?: string;
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  @ApiPropertyOptional()
  description?: string;
  @IsOptional()
  @IsString()
  @ApiPropertyOptional()
  eventDate?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  venue?: string;
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @ApiPropertyOptional()
  rsvpUrl?: string;
  @IsOptional()
  @IsUUID()
  @ApiPropertyOptional()
  evtEventId?: string;
}
