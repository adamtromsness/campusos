import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// ── Enums ────────────────────────────────────────────────────

export type PublicationType =
  | 'NEWSLETTER'
  | 'BULLETIN'
  | 'ANNOUNCEMENT'
  | 'MAGAZINE'
  | 'PROGRAM'
  | 'REPORT';
export const PUBLICATION_TYPES: readonly PublicationType[] = [
  'NEWSLETTER',
  'BULLETIN',
  'ANNOUNCEMENT',
  'MAGAZINE',
  'PROGRAM',
  'REPORT',
] as const;

export type SeriesFrequency =
  | 'DAILY'
  | 'WEEKLY'
  | 'FORTNIGHTLY'
  | 'MONTHLY'
  | 'TERMLY'
  | 'ANNUAL'
  | 'IRREGULAR';
export const SERIES_FREQUENCIES: readonly SeriesFrequency[] = [
  'DAILY',
  'WEEKLY',
  'FORTNIGHTLY',
  'MONTHLY',
  'TERMLY',
  'ANNUAL',
  'IRREGULAR',
] as const;

export type PublicationStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
export const PUBLICATION_STATUSES: readonly PublicationStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const;

export type CollaboratorRole = 'EDITOR' | 'CONTRIBUTOR' | 'REVIEWER' | 'VIEWER';
export const COLLABORATOR_ROLES: readonly CollaboratorRole[] = [
  'EDITOR',
  'CONTRIBUTOR',
  'REVIEWER',
  'VIEWER',
] as const;

export type SectionType = 'ARTICLE' | 'ANNOUNCEMENT' | 'PHOTO_GALLERY' | 'CALENDAR' | 'CUSTOM';
export const SECTION_TYPES: readonly SectionType[] = [
  'ARTICLE',
  'ANNOUNCEMENT',
  'PHOTO_GALLERY',
  'CALENDAR',
  'CUSTOM',
] as const;

export type DistributionRuleType = 'ROLE' | 'GRADE' | 'CLASS' | 'GROUP_MEMBERSHIP';
export const DISTRIBUTION_RULE_TYPES: readonly DistributionRuleType[] = [
  'ROLE',
  'GRADE',
  'CLASS',
  'GROUP_MEMBERSHIP',
] as const;

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'OPENED' | 'BOUNCED';

export type SubscriptionStatus = 'SUBSCRIBED' | 'UNSUBSCRIBED';

// ── DTOs ─────────────────────────────────────────────────────

export class SeriesDto {
  id!: string;
  schoolId!: string;
  title!: string;
  description!: string | null;
  publicationType!: PublicationType;
  frequency!: SeriesFrequency;
  seriesLogoS3Key!: string | null;
  isActive!: boolean;
  createdById!: string | null;
  createdByName!: string | null;
  editionCount!: number;
  subscriberCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateSeriesDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: PUBLICATION_TYPES })
  @IsIn(PUBLICATION_TYPES as unknown as string[])
  publicationType!: PublicationType;

  @ApiProperty({ enum: SERIES_FREQUENCIES })
  @IsIn(SERIES_FREQUENCIES as unknown as string[])
  frequency!: SeriesFrequency;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seriesLogoS3Key?: string;
}

export class UpdateSeriesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: SERIES_FREQUENCIES })
  @IsOptional()
  @IsIn(SERIES_FREQUENCIES as unknown as string[])
  frequency?: SeriesFrequency;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class EditionDto {
  id!: string;
  seriesId!: string;
  editionNumber!: number;
  editionLabel!: string | null;
  theme!: string | null;
  coverImageS3Key!: string | null;
  editorialNote!: string | null;
  status!: PublicationStatus;
  scheduledPublishAt!: string | null;
  publishedAt!: string | null;
  editorId!: string | null;
  editorName!: string | null;
  approvalRequestId!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateEditionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  editionLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  theme?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverImageS3Key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  editorialNote?: string;
}

export class UpdateEditionDto extends CreateEditionDto {
  @ApiPropertyOptional({ enum: PUBLICATION_STATUSES })
  @IsOptional()
  @IsIn(PUBLICATION_STATUSES as unknown as string[])
  status?: PublicationStatus;
}

export class PublicationCollaboratorDto {
  id!: string;
  publicationId!: string;
  userId!: string;
  userName!: string | null;
  role!: CollaboratorRole;
  invitedById!: string | null;
  invitedAt!: string;
  acceptedAt!: string | null;
}

export class PublicationDto {
  id!: string;
  schoolId!: string;
  title!: string;
  publicationType!: PublicationType;
  seriesId!: string | null;
  seriesTitle!: string | null;
  editionId!: string | null;
  editionNumber!: number | null;
  createdById!: string | null;
  createdByName!: string | null;
  status!: PublicationStatus;
  scheduledPublishAt!: string | null;
  publishedAt!: string | null;
  approvalRequestId!: string | null;
  sectionCount!: number;
  pendingSectionCount!: number;
  recipientCount!: number;
  createdAt!: string;
  updatedAt!: string;
}

export class PublicationDetailDto extends PublicationDto {
  collaborators!: PublicationCollaboratorDto[];
}

export class CreatePublicationDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiProperty({ enum: PUBLICATION_TYPES })
  @IsIn(PUBLICATION_TYPES as unknown as string[])
  publicationType!: PublicationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  seriesId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  editionId?: string;
}

export class UpdatePublicationStatusDto {
  @ApiProperty({ enum: PUBLICATION_STATUSES })
  @IsIn(PUBLICATION_STATUSES as unknown as string[])
  status!: PublicationStatus;
}

export class InviteCollaboratorDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;

  @ApiProperty({ enum: COLLABORATOR_ROLES })
  @IsIn(COLLABORATOR_ROLES as unknown as string[])
  role!: CollaboratorRole;
}

// ── Sections ────────────────────────────────────────────────

export class SectionContributorDto {
  id!: string;
  sectionId!: string;
  contributorId!: string;
  contributorName!: string | null;
  contributionNote!: string | null;
  contributedAt!: string;
}

export class SectionDto {
  id!: string;
  publicationId!: string;
  title!: string;
  body!: string | null;
  sectionType!: SectionType;
  ownerId!: string | null;
  ownerName!: string | null;
  sortOrder!: number;
  isApproved!: boolean;
  contributors!: SectionContributorDto[];
  createdAt!: string;
  updatedAt!: string;
}

export class CreateSectionDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ enum: SECTION_TYPES })
  @IsOptional()
  @IsIn(SECTION_TYPES as unknown as string[])
  sectionType?: SectionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  ownerEmployeeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateSectionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ enum: SECTION_TYPES })
  @IsOptional()
  @IsIn(SECTION_TYPES as unknown as string[])
  sectionType?: SectionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class AddContributorDto {
  @ApiProperty()
  @IsUUID()
  contributorId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contributionNote?: string;
}

export class SectionCommentDto {
  id!: string;
  sectionId!: string;
  authorId!: string;
  authorName!: string | null;
  body!: string;
  isResolved!: boolean;
  resolvedById!: string | null;
  resolvedAt!: string | null;
  parentCommentId!: string | null;
  createdAt!: string;
}

export class CreateCommentDto {
  @ApiProperty()
  @IsString()
  @Length(1, 5000)
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentCommentId?: string;
}

// ── Distribution ────────────────────────────────────────────

export class DistributionRuleDto {
  id!: string;
  distributionListId!: string;
  ruleType!: DistributionRuleType;
  ruleValue!: string;
}

export class DistributionListDto {
  id!: string;
  publicationId!: string;
  listName!: string;
  isActive!: boolean;
  rules!: DistributionRuleDto[];
}

export class CreateDistributionListDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  listName!: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  rules?: { ruleType: DistributionRuleType; ruleValue: string }[];
}

export class CreateDistributionRuleDto {
  @ApiProperty({ enum: DISTRIBUTION_RULE_TYPES })
  @IsIn(DISTRIBUTION_RULE_TYPES as unknown as string[])
  ruleType!: DistributionRuleType;

  @ApiProperty()
  @IsString()
  @Length(1, 200)
  ruleValue!: string;
}

export class DistributionRecipientDto {
  id!: string;
  publicationId!: string;
  recipientId!: string;
  recipientName!: string | null;
  deliveryStatus!: DeliveryStatus;
  deliveredAt!: string | null;
  openedAt!: string | null;
  bouncedReason!: string | null;
}

export class DistributionStatusDto {
  publicationId!: string;
  totalRecipients!: number;
  pending!: number;
  delivered!: number;
  opened!: number;
  bounced!: number;
}

export class AudiencePreviewDto {
  totalRecipients!: number;
  excludedUnsubscribed!: number;
  sampleNames!: string[];
}

export class SubscriptionDto {
  id!: string;
  seriesId!: string;
  seriesTitle!: string | null;
  subscriberId!: string;
  subscriberName!: string | null;
  status!: SubscriptionStatus;
  subscribedAt!: string;
  unsubscribedAt!: string | null;
}

// ── Phase 2 Cycle 26 — Publications Advanced ─────────────────

export type VersionTrigger = 'STATUS_CHANGE' | 'MANUAL_CHECKPOINT' | 'REVERT';
export const VERSION_TRIGGERS: readonly VersionTrigger[] = [
  'STATUS_CHANGE',
  'MANUAL_CHECKPOINT',
  'REVERT',
] as const;

export type ScheduledStatus = 'SCHEDULED' | 'PUBLISHED' | 'CANCELLED';
export const SCHEDULED_STATUSES: readonly ScheduledStatus[] = [
  'SCHEDULED',
  'PUBLISHED',
  'CANCELLED',
] as const;

export type AnalyticsEventType = 'VIEW' | 'OPEN' | 'LINK_CLICK' | 'BOUNCE';
export const ANALYTICS_EVENT_TYPES: readonly AnalyticsEventType[] = [
  'VIEW',
  'OPEN',
  'LINK_CLICK',
  'BOUNCE',
] as const;

export class PublicationVersionDto {
  id!: string;
  publicationId!: string;
  versionNumber!: number;
  trigger!: VersionTrigger;
  revertedFromVersion!: number | null;
  versionNote!: string | null;
  createdById!: string;
  createdByName!: string | null;
  createdAt!: string;
}

export class PublicationVersionDetailDto extends PublicationVersionDto {
  snapshotContent!: Record<string, unknown>;
}

export class CreateCheckpointDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  versionNote?: string;
}

export class RevertToVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  versionNote?: string;
}

export class TemplateDto {
  id!: string;
  schoolId!: string | null;
  name!: string;
  description!: string | null;
  publicationType!: PublicationType;
  templateContent!: Record<string, unknown>;
  isSystem!: boolean;
  isActive!: boolean;
  parentTemplateId!: string | null;
  createdById!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateTemplateDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: PUBLICATION_TYPES })
  @IsIn(PUBLICATION_TYPES as unknown as string[])
  publicationType!: PublicationType;

  @ApiProperty()
  templateContent!: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  templateContent?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateFromTemplateDto {
  @ApiProperty()
  @IsString()
  @Length(1, 300)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  seriesId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  editionId?: string;
}

export class ScheduledPublicationDto {
  id!: string;
  publicationId!: string;
  publicationTitle!: string | null;
  scheduledAt!: string;
  timezone!: string;
  status!: ScheduledStatus;
  scheduledById!: string;
  scheduledByName!: string | null;
  cancelledAt!: string | null;
  cancelledById!: string | null;
  cancellationReason!: string | null;
  publishedAt!: string | null;
  workerAttempts!: number;
  lastError!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

export class CreateScheduledPublicationDto {
  @ApiProperty()
  @IsString()
  scheduledAt!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 80)
  timezone?: string;
}

export class CancelScheduledPublicationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  cancellationReason?: string;
}

export class PublicationAnalyticsDto {
  publicationId!: string;
  totalRecipients!: number;
  totalViews!: number;
  uniqueViews!: number;
  totalOpens!: number;
  totalLinkClicks!: number;
  totalBounces!: number;
  avgReadTimeSeconds!: number | null;
  lastEventAt!: string | null;
  lastUpdatedAt!: string;
}

export class IngestAnalyticsEventDto {
  @ApiProperty({ enum: ANALYTICS_EVENT_TYPES })
  @IsIn(ANALYTICS_EVENT_TYPES as unknown as string[])
  eventType!: AnalyticsEventType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  recipientAccountId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  readTimeSeconds?: number;
}
