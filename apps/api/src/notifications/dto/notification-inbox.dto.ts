import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class NotificationItemDto {
  @ApiProperty({ nullable: true, description: 'msg_notification_queue.id, when known.' })
  id!: string | null;
  @ApiProperty({ description: 'Notification type, e.g. attendance.tardy, message.posted.' })
  type!: string;
  @ApiProperty({ description: 'ISO-8601 timestamp the recipient was notified.' })
  occurredAt!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Per-type payload. Always carries a deep_link or deep_link_* field for the UI to ' +
      'navigate to the source record.',
  })
  payload!: Record<string, unknown>;
  @ApiProperty({ description: 'true when occurredAt <= lastReadAt' })
  isRead!: boolean;
}

export class NotificationInboxResponseDto {
  @ApiProperty({ description: 'Number of items delivered after lastReadAt. Capped at 100.' })
  unreadCount!: number;
  @ApiProperty({ type: [NotificationItemDto] })
  items!: NotificationItemDto[];
  @ApiProperty({
    description: 'Epoch milliseconds the user last marked the bell read. 0 = never.',
  })
  lastReadAt!: number;
}

export class NotificationHistoryResponseDto {
  @ApiProperty({ type: [NotificationItemDto] })
  items!: NotificationItemDto[];
  @ApiProperty({
    nullable: true,
    description: 'Pass to ?before= to fetch the next page. null when no more rows.',
  })
  nextCursor!: string | null;
  @ApiProperty() lastReadAt!: number;
}

export class NotificationHistoryQueryDto {
  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Filter by notification type. Exact match against ' +
      'msg_notification_queue.notification_type (e.g. "grade.published").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @ApiPropertyOptional({
    description: 'Keyset cursor — ISO-8601 timestamp from a previous page.',
  })
  @IsOptional()
  @IsString()
  before?: string;
}

export class MarkAllReadResponseDto {
  @ApiProperty({ description: 'Epoch milliseconds the lastread key was set to.' })
  lastReadAt!: number;
}
