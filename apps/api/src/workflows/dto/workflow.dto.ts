import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'WITHDRAWN',
] as const;
export type ApprovalRequestStatus = (typeof REQUEST_STATUSES)[number];

export const STEP_STATUSES = ['AWAITING', 'APPROVED', 'REJECTED', 'SKIPPED'] as const;
export type ApprovalStepStatus = (typeof STEP_STATUSES)[number];

export const APPROVER_TYPES = ['SPECIFIC_USER', 'ROLE', 'MANAGER', 'DEPARTMENT_HEAD'] as const;
export type ApproverType = (typeof APPROVER_TYPES)[number];

export class ApprovalStepResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty() stepOrder!: number;
  @ApiProperty() approverId!: string;
  @ApiPropertyOptional({ nullable: true }) approverName!: string | null;
  @ApiProperty({ enum: STEP_STATUSES }) status!: ApprovalStepStatus;
  @ApiPropertyOptional({ nullable: true }) actionedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) comments!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ApprovalCommentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() requestId!: string;
  @ApiProperty() authorId!: string;
  @ApiPropertyOptional({ nullable: true }) authorName!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty() isRequesterVisible!: boolean;
  @ApiProperty() createdAt!: string;
}

export class ApprovalRequestResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty() templateName!: string;
  @ApiProperty() requesterId!: string;
  @ApiPropertyOptional({ nullable: true }) requesterName!: string | null;
  @ApiProperty() requestType!: string;
  @ApiPropertyOptional({ nullable: true }) referenceId!: string | null;
  @ApiPropertyOptional({ nullable: true }) referenceTable!: string | null;
  @ApiProperty({ enum: REQUEST_STATUSES }) status!: ApprovalRequestStatus;
  @ApiProperty() submittedAt!: string;
  @ApiPropertyOptional({ nullable: true }) resolvedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: [ApprovalStepResponseDto] }) steps!: ApprovalStepResponseDto[];
  @ApiProperty({ type: [ApprovalCommentResponseDto] }) comments!: ApprovalCommentResponseDto[];
}

export class SubmitApprovalDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  requestType!: string;

  @ApiPropertyOptional({ description: 'Domain-row id being approved (UUID)' })
  @IsOptional()
  @IsUUID()
  referenceId?: string;

  @ApiPropertyOptional({ description: 'Domain table name (e.g. hr_leave_requests)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceTable?: string;

  @ApiPropertyOptional({
    description: 'Optional override — admin only. Defaults to the calling user when omitted.',
  })
  @IsOptional()
  @IsUUID()
  requesterAccountId?: string;
}

export class ReviewStepDto {
  @ApiPropertyOptional({ description: 'Optional reviewer comment', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comments?: string;
}

export class CreateCommentDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({
    description:
      'When false, the comment is approver-internal only and the requester does not see it.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isRequesterVisible?: boolean;
}

export class ListApprovalsQueryDto {
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES as unknown as string[])
  status?: ApprovalRequestStatus;

  @ApiPropertyOptional({ description: 'Filter by request_type (e.g. LEAVE_REQUEST)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestType?: string;

  @ApiPropertyOptional({
    description:
      'Default: own (requester_id = caller). Pass mine=false as admin to see every row tenant-wide.',
  })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return true;
  })
  @IsBoolean()
  mine?: boolean;
}
