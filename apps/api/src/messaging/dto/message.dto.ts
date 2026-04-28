import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class PostMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}

export class EditMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 8000 })
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;
}

export class ListMessagesQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'ISO-8601 timestamp. Returns messages with `created_at < before` ordered ' +
      'newest-first. Used by the thread view for keyset pagination.',
  })
  @IsOptional()
  @IsString()
  before?: string;
}

export class MessageResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() threadId!: string;
  @ApiProperty() senderId!: string;
  @ApiProperty({ nullable: true }) senderName!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty() isEdited!: boolean;
  @ApiProperty({ nullable: true }) editedAt!: string | null;
  @ApiProperty() isDeleted!: boolean;
  @ApiProperty({ nullable: true }) deletedAt!: string | null;
  @ApiProperty({ enum: ['CLEAN', 'FLAGGED', 'BLOCKED', 'ESCALATED'] })
  moderationStatus!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class MarkThreadReadResponseDto {
  @ApiProperty() threadId!: string;
  @ApiProperty({ description: 'Number of msg_message_reads rows newly inserted' })
  marked!: number;
  @ApiProperty() unreadCount!: number;
}

export class UnreadCountResponseDto {
  @ApiProperty() total!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Per-thread unread counts. Excludes threads with zero unread.',
  })
  byThread!: Record<string, number>;
}
