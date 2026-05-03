import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_CATEGORIES = ['ACADEMIC', 'PERSONAL', 'ADMINISTRATIVE', 'ACKNOWLEDGEMENT'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_SOURCES = ['MANUAL', 'AUTO', 'SYSTEM'] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export class TaskResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() ownerId!: string;
  @ApiPropertyOptional({ nullable: true }) ownerName!: string | null;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: TASK_SOURCES }) source!: TaskSource;
  @ApiPropertyOptional({ nullable: true }) sourceRefId!: string | null;
  @ApiProperty({ enum: TASK_PRIORITIES }) priority!: TaskPriority;
  @ApiProperty({ enum: TASK_STATUSES }) status!: TaskStatus;
  @ApiPropertyOptional({ nullable: true }) dueAt!: string | null;
  @ApiProperty({ enum: TASK_CATEGORIES }) taskCategory!: TaskCategory;
  @ApiPropertyOptional({ nullable: true }) acknowledgementId!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdForId!: string | null;
  @ApiPropertyOptional({ nullable: true }) createdForName!: string | null;
  @ApiPropertyOptional({ nullable: true }) completedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class CreateTaskDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES, default: 'NORMAL' })
  @IsOptional()
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority?: TaskPriority;

  @ApiPropertyOptional({ enum: TASK_CATEGORIES, default: 'PERSONAL' })
  @IsOptional()
  @IsIn(TASK_CATEGORIES as unknown as string[])
  taskCategory?: TaskCategory;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp' })
  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @ApiPropertyOptional({
    description:
      'Optional assignee. When set and different from the caller, the task lands on the assignee’s list with createdForId pointing back to the caller.',
  })
  @IsOptional()
  @IsUUID()
  assigneeAccountId?: string;
}

export class UpdateTaskDto {
  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES as unknown as string[])
  status?: TaskStatus;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'ISO 8601 timestamp', nullable: true })
  @IsOptional()
  @IsDateString()
  dueAt?: string | null;
}

export class ListTasksQueryDto {
  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES as unknown as string[])
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: TASK_CATEGORIES })
  @IsOptional()
  @IsIn(TASK_CATEGORIES as unknown as string[])
  taskCategory?: TaskCategory;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority?: TaskPriority;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO timestamp — tasks due on or after this' })
  @IsOptional()
  @IsDateString()
  dueAfter?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD or ISO timestamp — tasks due on or before this' })
  @IsOptional()
  @IsDateString()
  dueBefore?: string;

  @ApiPropertyOptional({ description: 'Include DONE and CANCELLED tasks. Defaults false.' })
  @IsOptional()
  @Transform(function (params: { value: unknown }) {
    if (typeof params.value === 'boolean') return params.value;
    if (typeof params.value === 'string') return params.value === 'true';
    return false;
  })
  @IsBoolean()
  includeCompleted?: boolean;

  @ApiPropertyOptional({ description: 'Max rows; defaults 100, capped at 200' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

// ── Acknowledgements ──────────────────────────────────────────────

export const ACK_STATUSES = [
  'PENDING',
  'ACKNOWLEDGED',
  'ACKNOWLEDGED_WITH_DISPUTE',
  'EXPIRED',
] as const;
export type AcknowledgementStatus = (typeof ACK_STATUSES)[number];

export const ACK_SOURCE_TYPES = [
  'ANNOUNCEMENT',
  'DISCIPLINE_RECORD',
  'POLICY_DOCUMENT',
  'SIGNED_FORM',
  'CONSENT_REQUEST',
  'CUSTOM',
] as const;
export type AcknowledgementSourceType = (typeof ACK_SOURCE_TYPES)[number];

export class AcknowledgementResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() subjectId!: string;
  @ApiProperty({ enum: ACK_SOURCE_TYPES }) sourceType!: AcknowledgementSourceType;
  @ApiProperty() sourceRefId!: string;
  @ApiProperty() sourceTable!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ nullable: true }) bodyS3Key!: string | null;
  @ApiProperty() requiresDisputeOption!: boolean;
  @ApiProperty({ enum: ACK_STATUSES }) status!: AcknowledgementStatus;
  @ApiPropertyOptional({ nullable: true }) acknowledgedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) disputeReason!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiPropertyOptional({ nullable: true }) expiresAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class DisputeAcknowledgementDto {
  @ApiProperty({ description: 'Required when disputing — explains why', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason!: string;
}
