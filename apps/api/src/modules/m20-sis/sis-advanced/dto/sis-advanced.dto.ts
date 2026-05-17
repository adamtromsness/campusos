import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ─── Enum const arrays ───

export const AVATAR_STATUSES = ['PENDING_APPROVAL', 'APPROVED', 'REJECTED'] as const;
export type AvatarStatus = (typeof AVATAR_STATUSES)[number];

export const CUSTOM_FIELD_ENTITY_TYPES = ['STUDENT', 'STAFF', 'GUARDIAN', 'CLASS'] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'ENUM',
  'MULTI_SELECT',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const PARENT_UPDATE_TARGETS = [
  'STUDENT_INFO',
  'GUARDIAN_INFO',
  'EMERGENCY_CONTACT',
] as const;
export type ParentUpdateTarget = (typeof PARENT_UPDATE_TARGETS)[number];

export const PARENT_UPDATE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED'] as const;
export type ParentUpdateStatus = (typeof PARENT_UPDATE_STATUSES)[number];

export const STUDENT_NOTE_TYPES = [
  'ACADEMIC',
  'BEHAVIOURAL',
  'PASTORAL',
  'ADMINISTRATIVE',
  'CONFIDENTIAL',
  'WELLBEING',
  'GENERAL',
] as const;
export type StudentNoteType = (typeof STUDENT_NOTE_TYPES)[number];

export const STUDENT_PHOTO_TYPES = ['OFFICIAL', 'YEARBOOK', 'ID_CARD'] as const;
export type StudentPhotoType = (typeof STUDENT_PHOTO_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  'MARRIED',
  'DIVORCED',
  'SEPARATED',
  'COHABITING',
  'STEP_PARENT',
  'OTHER',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const CUSTODY_ARRANGEMENTS = ['JOINT', 'SOLE_A', 'SOLE_B', 'OTHER'] as const;
export type CustodyArrangement = (typeof CUSTODY_ARRANGEMENTS)[number];

// ─── Student Profile ───

export class UpdateStudentProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  currentlyReading?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  favouriteSong?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  interests?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  motto?: string;
}

export class UploadAvatarDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  s3Key!: string;
}

export class ReviewAvatarDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reviewNotes?: string;
}

export class StudentProfileDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiPropertyOptional()
  bio!: string | null;

  @ApiPropertyOptional()
  currentlyReading!: string | null;

  @ApiPropertyOptional()
  favouriteSong!: string | null;

  @ApiProperty({ type: [String] })
  interests!: string[];

  @ApiPropertyOptional()
  motto!: string | null;

  @ApiPropertyOptional()
  avatarS3Key!: string | null;

  @ApiProperty({ enum: AVATAR_STATUSES })
  avatarStatus!: AvatarStatus;

  @ApiPropertyOptional()
  avatarReviewedBy!: string | null;

  @ApiPropertyOptional()
  avatarReviewedAt!: string | null;

  @ApiPropertyOptional()
  avatarReviewNotes!: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;
}

// ─── Custom Field Definitions ───

export class CreateCustomFieldDefinitionDto {
  @ApiProperty({ enum: CUSTOM_FIELD_ENTITY_TYPES })
  @IsIn(CUSTOM_FIELD_ENTITY_TYPES as unknown as string[])
  entityType!: CustomFieldEntityType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fieldName!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fieldLabel!: string;

  @ApiProperty({ enum: CUSTOM_FIELD_TYPES })
  @IsIn(CUSTOM_FIELD_TYPES as unknown as string[])
  fieldType!: CustomFieldType;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  enumOptions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVisibleToParent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCustomFieldDefinitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fieldLabel?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enumOptions?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVisibleToParent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CustomFieldDefinitionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  schoolId!: string;

  @ApiProperty({ enum: CUSTOM_FIELD_ENTITY_TYPES })
  entityType!: CustomFieldEntityType;

  @ApiProperty()
  fieldName!: string;

  @ApiProperty()
  fieldLabel!: string;

  @ApiProperty({ enum: CUSTOM_FIELD_TYPES })
  fieldType!: CustomFieldType;

  @ApiPropertyOptional({ type: [String] })
  enumOptions!: string[] | null;

  @ApiProperty()
  isRequired!: boolean;

  @ApiProperty()
  isVisibleToParent!: boolean;

  @ApiProperty()
  sortOrder!: number;

  @ApiProperty()
  isActive!: boolean;
}

// ─── Custom Field Values ───

export class CustomFieldValueInputDto {
  @ApiProperty()
  @IsUUID()
  definitionId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  value?: string | number | boolean | string[] | null;
}

export class UpsertCustomFieldValuesDto {
  @ApiProperty({ enum: CUSTOM_FIELD_ENTITY_TYPES })
  @IsIn(CUSTOM_FIELD_ENTITY_TYPES as unknown as string[])
  entityType!: CustomFieldEntityType;

  @ApiProperty()
  @IsUUID()
  entityId!: string;

  @ApiProperty({ type: [CustomFieldValueInputDto] })
  @IsArray()
  values!: CustomFieldValueInputDto[];
}

export class CustomFieldValueDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  definitionId!: string;

  @ApiProperty()
  fieldName!: string;

  @ApiProperty()
  fieldLabel!: string;

  @ApiProperty({ enum: CUSTOM_FIELD_TYPES })
  fieldType!: CustomFieldType;

  @ApiProperty()
  entityId!: string;

  @ApiPropertyOptional()
  value!: string | number | boolean | string[] | null;
}

// ─── Parent Update Requests ───

export class SubmitParentUpdateDto {
  @ApiProperty({ enum: PARENT_UPDATE_TARGETS })
  @IsIn(PARENT_UPDATE_TARGETS as unknown as string[])
  targetType!: ParentUpdateTarget;

  @ApiProperty()
  @IsUUID()
  targetId!: string;

  @ApiProperty()
  @IsObject()
  proposedChanges!: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  changeReason?: string;
}

export class ReviewParentUpdateDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewerNotes?: string;
}

export class ParentUpdateRequestDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  schoolId!: string;

  @ApiProperty()
  submittedBy!: string;

  @ApiProperty({ enum: PARENT_UPDATE_TARGETS })
  targetType!: ParentUpdateTarget;

  @ApiProperty()
  targetId!: string;

  @ApiProperty()
  proposedChanges!: Record<string, unknown>;

  @ApiPropertyOptional()
  changeReason!: string | null;

  @ApiProperty({ enum: PARENT_UPDATE_STATUSES })
  status!: ParentUpdateStatus;

  @ApiPropertyOptional()
  reviewedBy!: string | null;

  @ApiPropertyOptional()
  reviewedAt!: string | null;

  @ApiPropertyOptional()
  reviewerNotes!: string | null;

  @ApiPropertyOptional()
  appliedAt!: string | null;

  @ApiProperty()
  createdAt!: string;
}

// ─── Auto-Approval Rules ───

export class UpsertAutoApprovalRuleDto {
  @ApiProperty({ enum: PARENT_UPDATE_TARGETS })
  @IsIn(PARENT_UPDATE_TARGETS as unknown as string[])
  targetType!: ParentUpdateTarget;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fieldName!: string;

  @ApiProperty()
  @IsBoolean()
  autoApprove!: boolean;
}

export class AutoApprovalRuleDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  schoolId!: string;

  @ApiProperty({ enum: PARENT_UPDATE_TARGETS })
  targetType!: ParentUpdateTarget;

  @ApiProperty()
  fieldName!: string;

  @ApiProperty()
  autoApprove!: boolean;
}

// ─── Student Notes ───

export class CreateStudentNoteDto {
  @ApiProperty({ enum: STUDENT_NOTE_TYPES })
  @IsIn(STUDENT_NOTE_TYPES as unknown as string[])
  noteType!: StudentNoteType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  noteText!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVisibleToParent?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isConfidential?: boolean;
}

export class StudentNoteDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiProperty()
  authorId!: string;

  @ApiPropertyOptional()
  authorName!: string | null;

  @ApiProperty({ enum: STUDENT_NOTE_TYPES })
  noteType!: StudentNoteType;

  @ApiProperty()
  noteText!: string;

  @ApiProperty()
  isVisibleToParent!: boolean;

  @ApiProperty()
  isConfidential!: boolean;

  @ApiProperty()
  createdAt!: string;
}

// ─── Family Relationships ───

export class CreateFamilyRelationshipDto {
  @ApiProperty()
  @IsUUID()
  familyId!: string;

  @ApiProperty()
  @IsUUID()
  guardianAId!: string;

  @ApiProperty()
  @IsUUID()
  guardianBId!: string;

  @ApiProperty({ enum: RELATIONSHIP_TYPES })
  @IsIn(RELATIONSHIP_TYPES as unknown as string[])
  relationshipType!: RelationshipType;

  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  @IsOptional()
  @IsIn(CUSTODY_ARRANGEMENTS as unknown as string[])
  custodyArrangement?: CustodyArrangement;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateFamilyRelationshipDto {
  @ApiPropertyOptional({ enum: RELATIONSHIP_TYPES })
  @IsOptional()
  @IsIn(RELATIONSHIP_TYPES as unknown as string[])
  relationshipType?: RelationshipType;

  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  @IsOptional()
  @IsIn(CUSTODY_ARRANGEMENTS as unknown as string[])
  custodyArrangement?: CustodyArrangement;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class FamilyRelationshipDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  familyId!: string;

  @ApiProperty()
  guardianAId!: string;

  @ApiProperty()
  guardianBId!: string;

  @ApiProperty({ enum: RELATIONSHIP_TYPES })
  relationshipType!: RelationshipType;

  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  custodyArrangement!: CustodyArrangement | null;

  @ApiPropertyOptional()
  notes!: string | null;
}

// ─── Student Photos ───

export class UpsertStudentPhotoDto {
  @ApiProperty({ enum: STUDENT_PHOTO_TYPES })
  @IsIn(STUDENT_PHOTO_TYPES as unknown as string[])
  photoType!: StudentPhotoType;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  s3Key!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  academicYear!: string;
}

export class StudentPhotoDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  studentId!: string;

  @ApiProperty({ enum: STUDENT_PHOTO_TYPES })
  photoType!: StudentPhotoType;

  @ApiProperty()
  s3Key!: string;

  @ApiProperty()
  academicYear!: string;

  @ApiProperty()
  isCurrent!: boolean;
}
