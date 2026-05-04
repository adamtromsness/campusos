import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'VENDOR_ASSIGNED',
  'PENDING_REQUESTER',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const VENDOR_TYPES = [
  'IT_REPAIR',
  'FACILITIES_MAINTENANCE',
  'CLEANING',
  'ELECTRICAL',
  'PLUMBING',
  'HVAC',
  'SECURITY',
  'GROUNDS',
  'OTHER',
] as const;
export type VendorType = (typeof VENDOR_TYPES)[number];

// ─── Category DTOs ─────────────────────────────────────────────

export class SubcategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) defaultAssigneeId!: string | null;
  @ApiPropertyOptional({ nullable: true }) defaultAssigneeName!: string | null;
  @ApiPropertyOptional({ nullable: true }) autoAssignToRole!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiPropertyOptional({ nullable: true }) parentCategoryId!: string | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ nullable: true }) icon!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: [SubcategoryResponseDto] }) subcategories!: SubcategoryResponseDto[];
}

export class CreateCategoryDto {
  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional parent category for nesting.' })
  @IsOptional()
  @IsUUID()
  parentCategoryId?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 60, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateSubcategoryDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ description: 'hr_employees.id of the default assignee.' })
  @IsOptional()
  @IsUUID()
  defaultAssigneeId?: string;

  @ApiPropertyOptional({
    description:
      'IAM role token (UPPER_SNAKE) — resolved at submission time the same way the workflow engine resolves a ROLE-typed approver.',
    maxLength: 60,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  autoAssignToRole?: string;
}

export class UpdateSubcategoryDto {
  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ description: 'Set null to clear the default assignee.', nullable: true })
  @IsOptional()
  @IsUUID()
  defaultAssigneeId?: string | null;

  @ApiPropertyOptional({ maxLength: 60, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  autoAssignToRole?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── SLA DTOs ──────────────────────────────────────────────────

export class SlaPolicyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiProperty({ enum: TICKET_PRIORITIES }) priority!: TicketPriority;
  @ApiProperty() responseHours!: number;
  @ApiProperty() resolutionHours!: number;
}

export class UpsertSlaPolicyDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ enum: TICKET_PRIORITIES })
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority!: TicketPriority;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  responseHours!: number;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  resolutionHours!: number;
}

// ─── Vendor DTOs ───────────────────────────────────────────────

export class VendorResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() vendorName!: string;
  @ApiProperty({ enum: VENDOR_TYPES }) vendorType!: VendorType;
  @ApiPropertyOptional({ nullable: true }) contactName!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactEmail!: string | null;
  @ApiPropertyOptional({ nullable: true }) contactPhone!: string | null;
  @ApiPropertyOptional({ nullable: true }) website!: string | null;
  @ApiProperty() isPreferred!: boolean;
  @ApiPropertyOptional({ nullable: true }) notes!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class CreateVendorDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  vendorName!: string;

  @ApiProperty({ enum: VENDOR_TYPES })
  @IsIn(VENDOR_TYPES as unknown as string[])
  vendorType!: VendorType;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPreferred?: boolean;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateVendorDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  vendorName?: string;

  @ApiPropertyOptional({ enum: VENDOR_TYPES })
  @IsOptional()
  @IsIn(VENDOR_TYPES as unknown as string[])
  vendorType?: VendorType;

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactEmail?: string | null;

  @ApiPropertyOptional({ maxLength: 40, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @ApiPropertyOptional({ maxLength: 200, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPreferred?: boolean;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Ticket DTOs ───────────────────────────────────────────────

export class SlaSnapshotDto {
  @ApiPropertyOptional({ nullable: true }) policyId!: string | null;
  @ApiProperty() responseHours!: number | null;
  @ApiProperty() resolutionHours!: number | null;
  @ApiProperty() responseBreached!: boolean;
  @ApiProperty() resolutionBreached!: boolean;
  /** Hours remaining before the response window expires (negative = breached). Null when there is no policy or first_response_at is already populated. */
  @ApiProperty({ nullable: true }) responseHoursRemaining!: number | null;
  /** Hours remaining before the resolution window expires (negative = breached). Null when there is no policy or resolved_at is already populated. */
  @ApiProperty({ nullable: true }) resolutionHoursRemaining!: number | null;
}

export class TicketResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiPropertyOptional({ nullable: true }) subcategoryId!: string | null;
  @ApiPropertyOptional({ nullable: true }) subcategoryName!: string | null;
  @ApiProperty() requesterId!: string;
  @ApiPropertyOptional({ nullable: true }) requesterName!: string | null;
  @ApiPropertyOptional({ nullable: true }) assigneeId!: string | null;
  @ApiPropertyOptional({ nullable: true }) assigneeName!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorName!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorReference!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorAssignedAt!: string | null;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: TICKET_PRIORITIES }) priority!: TicketPriority;
  @ApiProperty({ enum: TICKET_STATUSES }) status!: TicketStatus;
  @ApiPropertyOptional({ nullable: true }) slaPolicyId!: string | null;
  @ApiPropertyOptional({ nullable: true }) locationId!: string | null;
  @ApiPropertyOptional({ nullable: true }) firstResponseAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) closedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: SlaSnapshotDto }) sla!: SlaSnapshotDto;
}

export class CreateTicketDto {
  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  subcategoryId?: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES, default: 'MEDIUM' })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority?: TicketPriority;

  @ApiPropertyOptional({ description: 'Optional sch_rooms.id reference.' })
  @IsOptional()
  @IsUUID()
  locationId?: string;
}

export class AssignTicketDto {
  @ApiProperty({ description: 'hr_employees.id of the new assignee.' })
  @IsUUID()
  assigneeEmployeeId!: string;
}

export class AssignVendorDto {
  @ApiProperty()
  @IsUUID()
  vendorId!: string;

  @ApiPropertyOptional({ maxLength: 80, description: 'Vendor work order or case number.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  vendorReference?: string;
}

export class ResolveTicketDto {
  @ApiPropertyOptional({
    description:
      'Optional resolution note. Persisted as a public ticket comment if provided so the requester sees it on the detail page.',
    maxLength: 4000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolution?: string;
}

export class CancelTicketDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

// ─── Comment / Activity / Problem DTOs ────────────────────────

export const ACTIVITY_TYPES = [
  'STATUS_CHANGE',
  'REASSIGNMENT',
  'COMMENT',
  'ATTACHMENT',
  'ESCALATION',
  'VENDOR_ASSIGNMENT',
  'SLA_BREACH',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const PROBLEM_STATUSES = ['OPEN', 'INVESTIGATING', 'KNOWN_ERROR', 'RESOLVED'] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export class TicketCommentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ticketId!: string;
  @ApiProperty() authorId!: string;
  @ApiPropertyOptional({ nullable: true }) authorName!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty() isInternal!: boolean;
  @ApiProperty() createdAt!: string;
}

export class CreateCommentDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiPropertyOptional({
    description:
      'Mark the comment internal so the requester does not see it. Staff-only — requesters cannot set this.',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class TicketActivityResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() ticketId!: string;
  @ApiPropertyOptional({ nullable: true }) actorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) actorName!: string | null;
  @ApiProperty({ enum: ACTIVITY_TYPES }) activityType!: ActivityType;
  @ApiProperty({ description: 'Free-form JSONB. Shape varies by activity_type.' })
  metadata!: Record<string, unknown>;
  @ApiProperty() createdAt!: string;
}

export class ProblemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiProperty({ enum: PROBLEM_STATUSES }) status!: ProblemStatus;
  @ApiPropertyOptional({ nullable: true }) rootCause!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolution!: string | null;
  @ApiPropertyOptional({ nullable: true }) workaround!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedToId!: string | null;
  @ApiPropertyOptional({ nullable: true }) assignedToName!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorId!: string | null;
  @ApiPropertyOptional({ nullable: true }) vendorName!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: [String] }) ticketIds!: string[];
}

export class CreateProblemDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description!: string;

  @ApiProperty()
  @IsUUID()
  categoryId!: string;

  @ApiPropertyOptional({ description: 'hr_employees.id of the investigator.' })
  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @ApiPropertyOptional({ description: 'tkt_vendors.id when escalated to a vendor.' })
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({
    description: 'Optional list of ticket ids to link at creation time.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  ticketIds?: string[];
}

export class UpdateProblemDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: PROBLEM_STATUSES })
  @IsOptional()
  @IsIn(PROBLEM_STATUSES as unknown as string[])
  status?: ProblemStatus;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  rootCause?: string | null;

  @ApiPropertyOptional({ maxLength: 4000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  workaround?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  assignedToId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsUUID()
  vendorId?: string | null;
}

export class LinkTicketsDto {
  @ApiProperty({ type: [String], description: 'Ticket ids to link to this problem.' })
  @IsArray()
  @ArrayMinSize(1)
  @IsUUID('all', { each: true })
  ticketIds!: string[];
}

export class ResolveProblemDto {
  @ApiProperty({
    maxLength: 4000,
    description: 'Required — the schema enforces root_cause NOT NULL on RESOLVED problems.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  rootCause!: string;

  @ApiProperty({
    maxLength: 4000,
    description: 'Required — the schema enforces resolution NOT NULL on RESOLVED problems.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  resolution!: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  workaround?: string;
}

export class ListProblemsQueryDto {
  @ApiPropertyOptional({ enum: PROBLEM_STATUSES })
  @IsOptional()
  @IsIn(PROBLEM_STATUSES as unknown as string[])
  status?: ProblemStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class ListTicketsQueryDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES as unknown as string[])
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES as unknown as string[])
  priority?: TicketPriority;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'hr_employees.id' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  vendorId?: string;

  @ApiPropertyOptional({ description: 'ISO date — inclusive lower bound on created_at.' })
  @IsOptional()
  @IsDateString()
  createdAfter?: string;

  @ApiPropertyOptional({ description: 'ISO date — exclusive upper bound on created_at.' })
  @IsOptional()
  @IsDateString()
  createdBefore?: string;

  @ApiPropertyOptional({ description: 'When true, include CLOSED + CANCELLED in default views.' })
  @IsOptional()
  @Type(() => Boolean)
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeTerminal?: boolean;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
