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

// ─── Family-tree graph (blended single-generation diagram) ──────
//
// The family-tree view is a box-and-line diagram: a parent row on top, a
// child row below, an edge from each child to each of its own parents.
// Blended families mean parents differ per child, so the payload is a
// GRAPH (deduped parent union + per-child parent links), not a nested
// tree. Single generation only — grandparents / upward ancestry are out
// of scope and no longer in this payload (the full bucketed relationship
// list still lives at GET /people/:id/relationships).

export class FamilyTreeParentDto {
  // null when the parent is a name-only (non-CampusOS) person. The UI
  // still renders a box, using parentName.
  @ApiPropertyOptional() personId!: string | null;
  @ApiProperty() displayName!: string;
  // True for the row person when they appear in their own parent row.
  @ApiProperty() isSelf!: boolean;
  // Reserved for a future PLACEHOLDER family-child parent; always false
  // today. The empty *slot* (a child's unset second parent) is modelled
  // by a parentLink with parentPersonId:null, NOT by a parents[] entry.
  @ApiProperty() isPlaceholder!: boolean;
  // Server-resolved navigation target for the read-only tree's clickable
  // nodes. Present ONLY when the node has an accessible profile for the
  // current viewer (real person + the viewer may view it + a route the
  // viewer can actually reach). null for name-only parents, placeholder
  // slots, and real people the viewer is not permitted to view — the UI
  // renders those inert. Route is resolved server-side per person type,
  // so the client never branches on type or re-checks permissions.
  @ApiPropertyOptional() profileUrl!: string | null;
}

export class FamilyTreeParentLinkDto {
  // FK into parents[] by personId. null = a known-but-unspecified parent
  // slot (render a dashed placeholder + an edge to it). The slot is
  // meaningful — never omit it.
  @ApiPropertyOptional() parentPersonId!: string | null;
  // Name-only parent label, mirrored onto the link so the UI can match
  // it to the corresponding name-only parents[] box. null for linked or
  // unspecified slots.
  @ApiPropertyOptional() parentName!: string | null;
  // BIOLOGICAL_/ADOPTIVE_/STEP_ father|mother | LEGAL_GUARDIAN; null only
  // for an unspecified slot.
  @ApiPropertyOptional({ enum: RELATIONSHIP_TYPES }) relationshipType!: RelationshipType | null;
  @ApiProperty() legalCustody!: boolean;
  @ApiPropertyOptional({ enum: CUSTODY_ARRANGEMENTS })
  custodyArrangement!: CustodyArrangement | null;
  @ApiProperty() primaryResidence!: boolean;
}

export class FamilyTreeChildDto {
  @ApiProperty() personId!: string;
  @ApiProperty() displayName!: string;
  @ApiPropertyOptional() age!: number | null;
  // 1..n parent links, usually 2 (padded with null-slot links up to two
  // so a missing co-parent always renders a placeholder).
  @ApiProperty({ type: [FamilyTreeParentLinkDto] }) parentLinks!: FamilyTreeParentLinkDto[];
  // See FamilyTreeParentDto.profileUrl — present only when this child has an
  // accessible profile route for the current viewer (e.g. a guardian's
  // managed child → /family/children/:id); null otherwise.
  @ApiPropertyOptional() profileUrl!: string | null;
}

export class FamilyTreeDto {
  @ApiProperty() rootPersonId!: string;
  // Deduped union of every distinct parent across children[].parentLinks.
  // A parent shared by multiple children appears ONCE.
  @ApiProperty({ type: [FamilyTreeParentDto] }) parents!: FamilyTreeParentDto[];
  @ApiProperty({ type: [FamilyTreeChildDto] }) children!: FamilyTreeChildDto[];
  // Rendering hint (parent/guardian-only edit); server-enforced on writes.
  // The tree itself is read-only regardless of this flag.
  @ApiProperty() canEdit?: boolean;
}
