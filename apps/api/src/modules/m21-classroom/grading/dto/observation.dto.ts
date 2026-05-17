import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const OBSERVATION_TYPES = ['PROGRESS', 'CONCERN', 'COMMENDATION'] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export class CreateObservationDto {
  @ApiProperty()
  @IsUUID()
  classId!: string;

  @ApiProperty()
  @IsUUID()
  studentId!: string;

  @ApiProperty({ minLength: 1, maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  noteText!: string;

  @ApiProperty({ enum: OBSERVATION_TYPES })
  @IsIn(OBSERVATION_TYPES as unknown as string[])
  noteType!: ObservationType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isSharedWithParent?: boolean;
}

export class UpdateObservationDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  noteText?: string;

  @ApiPropertyOptional({ enum: OBSERVATION_TYPES })
  @IsOptional()
  @IsIn(OBSERVATION_TYPES as unknown as string[])
  noteType?: ObservationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isSharedWithParent?: boolean;
}

export interface ObservationResponseDto {
  id: string;
  classId: string;
  className: string | null;
  studentId: string;
  studentName: string | null;
  teacherId: string;
  teacherName: string | null;
  noteText: string;
  noteType: ObservationType;
  isSharedWithParent: boolean;
  createdAt: string;
  updatedAt: string;
}
