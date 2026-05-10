import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateClassMomentPhotoDto {
  @ApiProperty({ description: 'Pre-uploaded S3 key for this photo (signed URL pattern).' })
  @IsString()
  @MaxLength(500)
  s3Key!: string;

  @ApiPropertyOptional({ description: 'Display order within the moment (0 = first).' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSizeBytes?: number;
}

export class CreateClassMomentDto {
  @ApiPropertyOptional({ description: 'Caption shown above the photo carousel.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  caption?: string;

  @ApiProperty({ type: [CreateClassMomentPhotoDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateClassMomentPhotoDto)
  photos!: CreateClassMomentPhotoDto[];
}

export class CreateMomentReactionDto {
  @ApiProperty({ description: '3-value reaction enum: LIKE / LOVE / CELEBRATE.' })
  @IsString()
  @MaxLength(20)
  reactionType!: string;
}

export interface ClassMomentPhotoDto {
  id: string;
  s3Key: string;
  sortOrder: number;
  fileSizeBytes: number | null;
  createdAt: string;
}

export interface ClassMomentReactionDto {
  id: string;
  reactedBy: string;
  reactedByName: string | null;
  reactionType: 'LIKE' | 'LOVE' | 'CELEBRATE';
  createdAt: string;
}

export interface ClassMomentResponseDto {
  id: string;
  classId: string;
  className: string | null;
  postedBy: string;
  postedByName: string | null;
  caption: string | null;
  postedAt: string;
  isApproved: boolean;
  photos: ClassMomentPhotoDto[];
  reactions: ClassMomentReactionDto[];
  reactionCount: number;
  myReaction: 'LIKE' | 'LOVE' | 'CELEBRATE' | null;
}
