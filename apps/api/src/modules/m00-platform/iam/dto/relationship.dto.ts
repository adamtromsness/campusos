import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// ─── Enums ──────────────────────────────────────────────────────

export const RELATIONSHIP_TYPES = [
  'BIOLOGICAL_MOTHER',
  'BIOLOGICAL_FATHER',
  'BIOLOGICAL_CHILD',
  'ADOPTIVE_MOTHER',
  'ADOPTIVE_FATHER',
  'ADOPTIVE_CHILD',
  'STEP_MOTHER',
  'STEP_FATHER',
  'STEP_CHILD',
  'LEGAL_GUARDIAN',
  'LEGAL_WARD',
  'SPOUSE',
  'DOMESTIC_PARTNER',
  'GRANDPARENT',
  'GRANDCHILD',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Types a caller may create directly via POST. The reciprocal-only
 * types (BIOLOGICAL_CHILD, ADOPTIVE_CHILD, STEP_CHILD, LEGAL_WARD,
 * GRANDCHILD) are never created directly — they're auto-generated as
 * the reciprocal of a parent/guardian relationship. Creating them
 * directly would orphan the navigation (the spec: "don't allow
 * BIOLOGICAL_CHILD directly — that's auto-reciprocal only").
 */
export const CREATABLE_RELATIONSHIP_TYPES = [
  'BIOLOGICAL_MOTHER',
  'BIOLOGICAL_FATHER',
  'ADOPTIVE_MOTHER',
  'ADOPTIVE_FATHER',
  'STEP_MOTHER',
  'STEP_FATHER',
  'LEGAL_GUARDIAN',
  'SPOUSE',
  'DOMESTIC_PARTNER',
  'GRANDPARENT',
] as const;
export type CreatableRelationshipType = (typeof CREATABLE_RELATIONSHIP_TYPES)[number];

export const CUSTODY_ARRANGEMENTS = [
  'FULL',
  'JOINT',
  'WEEKDAYS',
  'WEEKENDS',
  'SUMMERS',
  'SUPERVISED',
  'NONE',
] as const;
export type CustodyArrangement = (typeof CUSTODY_ARRANGEMENTS)[number];

export const SIBLING_TYPES = [
  'FULL_SIBLING',
  'HALF_SIBLING',
  'STEP_SIBLING',
  'ADOPTIVE_SIBLING',
] as const;
export type SiblingType = (typeof SIBLING_TYPES)[number];

// ─── Request DTOs ───────────────────────────────────────────────

export class CreateRelationshipDto {
  // CampusOS user — when set, the auto-reciprocal is created on their
  // profile. Mutually-substitutable with relatedPersonName; at least
  // one must be present (enforced in the service).
  @ApiPropertyOptional() @IsOptional() @IsUUID() relatedPersonId?: string;

  // Name-only fallback for a non-CampusOS person (deceased / absent /
  // never-joining parent). No reciprocal row is created.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) relatedPersonName?: string;

  @ApiProperty({ enum: CREATABLE_RELATIONSHIP_TYPES })
  @IsIn(CREATABLE_RELATIONSHIP_TYPES as readonly string[])
  relationshipType!: CreatableRelationshipType;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isLegalCustody?: boolean;

  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  @IsOptional()
  @IsIn(CUSTODY_ARRANGEMENTS as readonly string[])
  custodyArrangement?: CustodyArrangement;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) custodyNotes?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimaryResidence?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;
}

export class UpdateRelationshipDto {
  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  @IsOptional()
  @IsIn(CUSTODY_ARRANGEMENTS as readonly string[])
  custodyArrangement?: CustodyArrangement;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) custodyNotes?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPrimaryResidence?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isLegalCustody?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsDateString() startDate?: string;

  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
}

export class VerifyRelationshipDto {
  @ApiProperty() @IsBoolean() verified!: boolean;
}

// ─── Response DTOs ──────────────────────────────────────────────

export class PersonSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiPropertyOptional() preferredName!: string | null;
  @ApiPropertyOptional() dateOfBirth!: string | null;
  // Derived from dateOfBirth at read time; null when DOB is unknown.
  @ApiPropertyOptional() age!: number | null;
}

export class RelationshipDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RELATIONSHIP_TYPES }) type!: RelationshipType;
  // null when the relationship is name-only (non-CampusOS person).
  @ApiPropertyOptional({ type: PersonSummaryDto }) relatedPerson!: PersonSummaryDto | null;
  @ApiPropertyOptional() relatedPersonName!: string | null;
  @ApiProperty() isLegalCustody!: boolean;
  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  custodyArrangement!: CustodyArrangement | null;
  @ApiPropertyOptional() custodyNotes!: string | null;
  @ApiProperty() isPrimaryResidence!: boolean;
  @ApiProperty() verified!: boolean;
  @ApiPropertyOptional() verifiedBy!: string | null;
  @ApiPropertyOptional() verifiedAt!: string | null;
  @ApiPropertyOptional() startDate!: string | null;
  @ApiPropertyOptional() endDate!: string | null;
}

export class DerivedSiblingDto {
  @ApiProperty({ type: PersonSummaryDto }) person!: PersonSummaryDto;
  @ApiProperty({ enum: SIBLING_TYPES }) siblingType!: SiblingType;
}

export class GetRelationshipsResponseDto {
  @ApiProperty({ type: [RelationshipDto] }) relationships!: RelationshipDto[];
  @ApiProperty({ type: [DerivedSiblingDto] }) derivedSiblings!: DerivedSiblingDto[];
  // Rendering hint for the UI (parent/guardian-only edit). The server
  // still enforces the same rule on every mutation — this is not the
  // security boundary. Computed + set by the controller, not the service.
  @ApiProperty() canEdit?: boolean;
}

export class FamilyTreeNodeDto {
  @ApiProperty({ type: RelationshipDto }) relationship!: RelationshipDto;
}

export class FamilyTreeDto {
  @ApiProperty({ type: PersonSummaryDto }) person!: PersonSummaryDto;
  @ApiProperty({ type: [RelationshipDto] }) parents!: RelationshipDto[];
  @ApiProperty({ type: [RelationshipDto] }) children!: RelationshipDto[];
  @ApiProperty({ type: [RelationshipDto] }) grandparents!: RelationshipDto[];
  @ApiProperty({ type: [RelationshipDto] }) grandchildren!: RelationshipDto[];
  @ApiProperty({ type: [RelationshipDto] }) spouses!: RelationshipDto[];
  @ApiProperty({ type: [RelationshipDto] }) other!: RelationshipDto[];
  @ApiProperty({ type: [DerivedSiblingDto] }) siblings!: DerivedSiblingDto[];
  // Rendering hint (parent/guardian-only edit); server-enforced on writes.
  @ApiProperty() canEdit?: boolean;
}
