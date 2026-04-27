import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ThreadParticipantInputDto {
  @ApiProperty({
    description:
      "Recipient's platform_users.id. The service validates that the resolved IAM role for " +
      'this user is one of the thread type allowed roles before creating the thread.',
  })
  @IsUUID()
  platformUserId!: string;

  @ApiPropertyOptional({
    enum: ['OWNER', 'PARTICIPANT', 'OBSERVER'],
    default: 'PARTICIPANT',
    description: 'Defaults to PARTICIPANT. The thread creator is always added as OWNER separately.',
  })
  @IsOptional()
  @IsIn(['OWNER', 'PARTICIPANT', 'OBSERVER'])
  role?: 'OWNER' | 'PARTICIPANT' | 'OBSERVER';
}

export class CreateThreadDto {
  @ApiProperty({ description: "msg_thread_types.id for this school's catalogue" })
  @IsUUID()
  threadTypeId!: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({
    type: [ThreadParticipantInputDto],
    description:
      'One or more recipients. The thread creator is automatically added as the OWNER and does not need to appear here.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ThreadParticipantInputDto)
  participants!: ThreadParticipantInputDto[];

  @ApiPropertyOptional({
    description:
      'Optional first message to post atomically with thread creation. ' +
      'If supplied the thread is created and the message is posted in one round-trip.',
  })
  @IsOptional()
  @IsString()
  initialMessage?: string;
}

export class ThreadParticipantDto {
  @ApiProperty() id!: string;
  @ApiProperty() platformUserId!: string;
  @ApiProperty({ enum: ['OWNER', 'PARTICIPANT', 'OBSERVER'] })
  role!: string;
  @ApiProperty({ nullable: true }) displayName!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty() isMuted!: boolean;
  @ApiProperty({ nullable: true }) lastReadAt!: string | null;
  @ApiProperty({ nullable: true }) leftAt!: string | null;
}

export class ThreadResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() schoolId!: string;
  @ApiProperty() threadTypeId!: string;
  @ApiProperty() threadTypeName!: string;
  @ApiProperty({ nullable: true }) subject!: string | null;
  @ApiProperty() createdBy!: string;
  @ApiProperty({ nullable: true }) lastMessageAt!: string | null;
  @ApiProperty() isArchived!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: [ThreadParticipantDto] })
  participants!: ThreadParticipantDto[];
  @ApiProperty({ description: 'Unread message count for the calling user (Redis-backed)' })
  unreadCount!: number;
}

export class ListThreadsQueryDto {
  @ApiPropertyOptional({
    description: 'Set true to include archived threads (defaults to false — active threads only)',
    default: false,
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;
}

export class ArchiveThreadDto {
  @ApiProperty({
    description: 'true to archive, false to unarchive',
  })
  @IsBoolean()
  isArchived!: boolean;
}
