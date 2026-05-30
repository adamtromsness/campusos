import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreateRelationshipDto,
  CREATABLE_RELATIONSHIP_TYPES,
  DerivedSiblingDto,
  FamilyTreeDto,
  GetRelationshipsResponseDto,
  PersonSummaryDto,
  RelationshipDto,
  RelationshipType,
  SiblingType,
  UpdateRelationshipDto,
} from './dto/relationship.dto';

/**
 * The reciprocal relationship to auto-create when a caller adds a
 * parent/guardian/spouse relationship. Every CREATABLE type maps to
 * exactly one reciprocal type. SPOUSE / DOMESTIC_PARTNER are symmetric.
 */
const RECIPROCAL_ON_CREATE: Record<string, RelationshipType> = {
  BIOLOGICAL_MOTHER: 'BIOLOGICAL_CHILD',
  BIOLOGICAL_FATHER: 'BIOLOGICAL_CHILD',
  ADOPTIVE_MOTHER: 'ADOPTIVE_CHILD',
  ADOPTIVE_FATHER: 'ADOPTIVE_CHILD',
  STEP_MOTHER: 'STEP_CHILD',
  STEP_FATHER: 'STEP_CHILD',
  LEGAL_GUARDIAN: 'LEGAL_WARD',
  GRANDPARENT: 'GRANDCHILD',
  SPOUSE: 'SPOUSE',
  DOMESTIC_PARTNER: 'DOMESTIC_PARTNER',
};

/**
 * Candidate reciprocal types for finding the OTHER side of an existing
 * row (update / delete). A parent→child row maps to a single reciprocal
 * type; a child→parent reciprocal row (e.g. BIOLOGICAL_CHILD) maps back
 * to two candidates (MOTHER or FATHER) because the stored row doesn't
 * record which. The (person_id, related_person_id, type) partial unique
 * still makes the lookup resolve to exactly one row for a given pair.
 */
const RECIPROCAL_CANDIDATES: Record<string, RelationshipType[]> = {
  BIOLOGICAL_MOTHER: ['BIOLOGICAL_CHILD'],
  BIOLOGICAL_FATHER: ['BIOLOGICAL_CHILD'],
  ADOPTIVE_MOTHER: ['ADOPTIVE_CHILD'],
  ADOPTIVE_FATHER: ['ADOPTIVE_CHILD'],
  STEP_MOTHER: ['STEP_CHILD'],
  STEP_FATHER: ['STEP_CHILD'],
  LEGAL_GUARDIAN: ['LEGAL_WARD'],
  GRANDPARENT: ['GRANDCHILD'],
  SPOUSE: ['SPOUSE'],
  DOMESTIC_PARTNER: ['DOMESTIC_PARTNER'],
  BIOLOGICAL_CHILD: ['BIOLOGICAL_MOTHER', 'BIOLOGICAL_FATHER'],
  ADOPTIVE_CHILD: ['ADOPTIVE_MOTHER', 'ADOPTIVE_FATHER'],
  STEP_CHILD: ['STEP_MOTHER', 'STEP_FATHER'],
  LEGAL_WARD: ['LEGAL_GUARDIAN'],
  GRANDCHILD: ['GRANDPARENT'],
};

const PARENT_TYPES = [
  'BIOLOGICAL_MOTHER',
  'BIOLOGICAL_FATHER',
  'ADOPTIVE_MOTHER',
  'ADOPTIVE_FATHER',
  'STEP_MOTHER',
  'STEP_FATHER',
  'LEGAL_GUARDIAN',
];
const CHILD_TYPES = ['BIOLOGICAL_CHILD', 'ADOPTIVE_CHILD', 'STEP_CHILD', 'LEGAL_WARD'];
const SPOUSE_TYPES = ['SPOUSE', 'DOMESTIC_PARTNER'];
// Biological + adoptive parent types only — the basis for sibling
// derivation (step + legal parents don't make children siblings).
const BIO_ADOPTIVE_PARENT_TYPES = [
  'BIOLOGICAL_MOTHER',
  'BIOLOGICAL_FATHER',
  'ADOPTIVE_MOTHER',
  'ADOPTIVE_FATHER',
];

interface RelationshipRow {
  id: string;
  person_id: string;
  related_person_id: string | null;
  related_person_name: string | null;
  relationship_type: string;
  is_legal_custody: boolean;
  custody_arrangement: string | null;
  custody_notes: string | null;
  is_primary_residence: boolean;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  start_date: string | null;
  end_date: string | null;
  rp_first_name: string | null;
  rp_last_name: string | null;
  rp_preferred_name: string | null;
  rp_date_of_birth: string | null;
}

/**
 * RelationshipService — family structure (Step 2).
 *
 * Owns platform_person_relationships: biological / legal / step-family
 * relationships between people, distinct from the household model. CRUD
 * with auto-reciprocal maintenance, plus derived sibling detection and a
 * family-tree projection. See docs/campusos-family-structure-design.html.
 *
 * Authorisation is the controller's job — this service trusts its
 * caller. The one auth helper that lives here (isGuardianOf) is shared
 * by every controller method and reads the household tables.
 */
@Injectable()
export class RelationshipService {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Auth helper (household-derived) ──────────────────────────

  /**
   * True when `callerPersonId` is a parent/guardian of `personId`: an
   * ACTIVE member of a family that holds `personId` as a LINKED child.
   * Mirrors the household ownership model used by FamilyChildrenService.
   */
  async isGuardianOf(callerPersonId: string, personId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ ok: number }>>(
      `SELECT 1 AS ok
         FROM platform.platform_family_members m
         JOIN platform.platform_family_children c ON c.family_id = m.family_id
        WHERE m.person_id = $1::uuid AND m.status = 'ACTIVE'
          AND c.person_id = $2::uuid AND c.status = 'LINKED'
        LIMIT 1`,
      callerPersonId,
      personId,
    );
    return rows.length > 0;
  }

  /**
   * True when `callerPersonId` is an active guardian of `personId` — the
   * union of two signals (the edit-permission predicate, Family Structure
   * on Profiles spec Step 1):
   *
   *   1. Household link — caller is an ACTIVE family member and `personId`
   *      is a LINKED child of that family (isGuardianOf above). This is the
   *      bootstrapping path: it lets a parent record the child's FIRST
   *      relationship before any graph edge exists.
   *   2. Relationship graph — a current parent/guardian relationship FROM
   *      `personId` TO the caller (the caller is recorded as the person's
   *      LEGAL_GUARDIAN / BIOLOGICAL_* / ADOPTIVE_* / STEP_* parent), with
   *      end_date IS NULL.
   */
  async isActiveGuardianOf(callerPersonId: string, personId: string): Promise<boolean> {
    if (await this.isGuardianOf(callerPersonId, personId)) return true;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ ok: number }>>(
      `SELECT 1 AS ok
         FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid
          AND related_person_id = $2::uuid
          AND relationship_type = ANY($3::text[])
          AND end_date IS NULL
        LIMIT 1`,
      personId,
      callerPersonId,
      PARENT_TYPES,
    );
    return rows.length > 0;
  }

  // ─── A) addRelationship ───────────────────────────────────────

  async addRelationship(
    personId: string,
    dto: CreateRelationshipDto,
    createdBy: string,
  ): Promise<RelationshipDto> {
    const type = dto.relationshipType;
    if (!(CREATABLE_RELATIONSHIP_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(
        `relationshipType '${type}' cannot be created directly; it is an auto-reciprocal type.`,
      );
    }

    const relatedPersonId = dto.relatedPersonId ?? null;
    const relatedPersonName = dto.relatedPersonName?.trim() || null;
    if (!relatedPersonId && !relatedPersonName) {
      throw new BadRequestException(
        'Provide either relatedPersonId (a CampusOS user) or relatedPersonName.',
      );
    }
    if (relatedPersonId && relatedPersonId === personId) {
      throw new BadRequestException('A person cannot be related to themselves.');
    }

    // The subject person must exist.
    await this.requirePersonExists(personId);
    if (relatedPersonId) await this.requirePersonExists(relatedPersonId);

    const forwardId = generateId();
    const reciprocalType = RECIPROCAL_ON_CREATE[type]!;
    const isLegalCustody = dto.isLegalCustody ?? false;
    const custodyArrangement = dto.custodyArrangement ?? null;
    const custodyNotes = dto.custodyNotes?.trim() || null;
    const isPrimaryResidence = dto.isPrimaryResidence ?? false;
    const startDate = dto.startDate ?? null;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO platform.platform_person_relationships
             (id, person_id, related_person_id, related_person_name, relationship_type,
              is_legal_custody, custody_arrangement, custody_notes, is_primary_residence,
              start_date, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::date, $11::uuid)`,
          forwardId,
          personId,
          relatedPersonId,
          relatedPersonName,
          type,
          isLegalCustody,
          custodyArrangement,
          custodyNotes,
          isPrimaryResidence,
          startDate,
          createdBy,
        );

        // No reciprocal for name-only relationships — the non-CampusOS
        // person has no profile to show it on.
        if (relatedPersonId) {
          await tx.$executeRawUnsafe(
            `INSERT INTO platform.platform_person_relationships
               (id, person_id, related_person_id, related_person_name, relationship_type,
                is_legal_custody, custody_arrangement, custody_notes, is_primary_residence,
                start_date, created_by)
             VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, $4, $5, $6, $7, $8, $9::date, $10::uuid)`,
            generateId(),
            relatedPersonId,
            personId,
            reciprocalType,
            isLegalCustody,
            custodyArrangement,
            custodyNotes,
            isPrimaryResidence,
            startDate,
            createdBy,
          );
        }
      });
    } catch (err: unknown) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('That relationship already exists.');
      }
      throw err;
    }

    return this.getRelationshipById(forwardId);
  }

  // ─── B) updateRelationship ────────────────────────────────────

  async updateRelationship(
    personId: string,
    relationshipId: string,
    dto: UpdateRelationshipDto,
  ): Promise<RelationshipDto> {
    const row = await this.requireOwnedRow(relationshipId, personId);

    // Only custody / notes / dates are updatable. relationship_type is
    // immutable — delete and recreate to change it.
    const set: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    const add = (col: string, val: unknown, cast = '') => {
      set.push(`${col} = $${i++}${cast}`);
      args.push(val);
    };
    if (dto.custodyArrangement !== undefined) add('custody_arrangement', dto.custodyArrangement);
    if (dto.custodyNotes !== undefined) add('custody_notes', dto.custodyNotes?.trim() || null);
    if (dto.isPrimaryResidence !== undefined) add('is_primary_residence', dto.isPrimaryResidence);
    if (dto.isLegalCustody !== undefined) add('is_legal_custody', dto.isLegalCustody);
    if (dto.startDate !== undefined) add('start_date', dto.startDate ?? null, '::date');
    if (dto.endDate !== undefined) add('end_date', dto.endDate ?? null, '::date');

    if (set.length === 0) return this.getRelationshipById(relationshipId);

    await this.prisma.$transaction(async (tx) => {
      await this.applyUpdate(tx, relationshipId, set, args);
      if (row.related_person_id) {
        const reciprocalId = await this.findReciprocalId(tx, row);
        if (reciprocalId) await this.applyUpdate(tx, reciprocalId, set, args);
      }
    });

    return this.getRelationshipById(relationshipId);
  }

  // ─── C) deleteRelationship ────────────────────────────────────

  async deleteRelationship(personId: string, relationshipId: string): Promise<void> {
    const row = await this.requireOwnedRow(relationshipId, personId);
    await this.prisma.$transaction(async (tx) => {
      if (row.related_person_id) {
        const reciprocalId = await this.findReciprocalId(tx, row);
        if (reciprocalId) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.platform_person_relationships WHERE id = $1::uuid`,
            reciprocalId,
          );
        }
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM platform.platform_person_relationships WHERE id = $1::uuid`,
        relationshipId,
      );
    });
  }

  // ─── verify (school-admin) ────────────────────────────────────

  async verifyRelationship(
    personId: string,
    relationshipId: string,
    verifierPersonId: string,
    verified: boolean,
  ): Promise<RelationshipDto> {
    const row = await this.requireOwnedRow(relationshipId, personId);
    const set = ['verified = $1', 'verified_by = $2::uuid', 'verified_at = $3'];
    const args: unknown[] = [
      verified,
      verified ? verifierPersonId : null,
      verified ? new Date() : null,
    ];

    await this.prisma.$transaction(async (tx) => {
      await this.applyUpdate(tx, relationshipId, [...set], [...args]);
      if (row.related_person_id) {
        const reciprocalId = await this.findReciprocalId(tx, row);
        if (reciprocalId) await this.applyUpdate(tx, reciprocalId, [...set], [...args]);
      }
    });

    return this.getRelationshipById(relationshipId);
  }

  // ─── D) getRelationships (direct + derived siblings) ──────────

  async getRelationships(personId: string): Promise<GetRelationshipsResponseDto> {
    const rows = await this.prisma.$queryRawUnsafe<RelationshipRow[]>(
      this.selectSql() + ' WHERE r.person_id = $1::uuid ORDER BY r.created_at ASC',
      personId,
    );
    return {
      relationships: rows.map((r) => this.toDto(r)),
      derivedSiblings: await this.computeSiblings(personId),
    };
  }

  /**
   * Sibling derivation (never stored — computed from shared parents):
   *   FULL_SIBLING     — shares both biological parents
   *   HALF_SIBLING     — shares exactly one biological parent
   *   ADOPTIVE_SIBLING — shares an adoptive parent (no shared bio parent)
   *   STEP_SIBLING     — no shared parent, but a parent's spouse/partner
   *                      is the candidate's biological/adoptive parent
   * Deduplicated: each sibling appears once, classified by strongest tie.
   */
  private async computeSiblings(personId: string): Promise<DerivedSiblingDto[]> {
    const parentRows = await this.prisma.$queryRawUnsafe<
      Array<{ parent_id: string; relationship_type: string }>
    >(
      `SELECT related_person_id::text AS parent_id, relationship_type
         FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid
          AND relationship_type = ANY($2::text[])
          AND related_person_id IS NOT NULL
          AND end_date IS NULL`,
      personId,
      BIO_ADOPTIVE_PARENT_TYPES,
    );
    if (parentRows.length === 0) return [];

    const bioParents = new Set(
      parentRows
        .filter((r) => r.relationship_type.startsWith('BIOLOGICAL'))
        .map((r) => r.parent_id),
    );
    const adoptiveParents = new Set(
      parentRows.filter((r) => r.relationship_type.startsWith('ADOPTIVE')).map((r) => r.parent_id),
    );
    const allParentIds = Array.from(new Set([...bioParents, ...adoptiveParents]));

    // Spouses/partners of the person's parents → step-parent candidates.
    const spouseRows = await this.prisma.$queryRawUnsafe<Array<{ spouse_id: string }>>(
      `SELECT DISTINCT related_person_id::text AS spouse_id
         FROM platform.platform_person_relationships
        WHERE person_id = ANY($1::uuid[])
          AND relationship_type = ANY($2::text[])
          AND related_person_id IS NOT NULL
          AND end_date IS NULL`,
      allParentIds,
      SPOUSE_TYPES,
    );
    const stepParentIds = new Set(
      spouseRows
        .map((r) => r.spouse_id)
        .filter((id) => !bioParents.has(id) && !adoptiveParents.has(id)),
    );

    const searchParentIds = Array.from(new Set([...allParentIds, ...stepParentIds]));
    const candidateRows = await this.prisma.$queryRawUnsafe<
      Array<{ sibling_id: string; parent_id: string; relationship_type: string }>
    >(
      `SELECT person_id::text AS sibling_id, related_person_id::text AS parent_id, relationship_type
         FROM platform.platform_person_relationships
        WHERE related_person_id = ANY($1::uuid[])
          AND relationship_type = ANY($2::text[])
          AND person_id <> $3::uuid
          AND end_date IS NULL`,
      searchParentIds,
      BIO_ADOPTIVE_PARENT_TYPES,
      personId,
    );
    if (candidateRows.length === 0) return [];

    const agg = new Map<string, { bio: Set<string>; adoptive: Set<string>; step: boolean }>();
    for (const c of candidateRows) {
      let e = agg.get(c.sibling_id);
      if (!e) {
        e = { bio: new Set(), adoptive: new Set(), step: false };
        agg.set(c.sibling_id, e);
      }
      const isBioType = c.relationship_type.startsWith('BIOLOGICAL');
      const isAdoptiveType = c.relationship_type.startsWith('ADOPTIVE');
      if (isBioType && bioParents.has(c.parent_id)) e.bio.add(c.parent_id);
      else if (isAdoptiveType && adoptiveParents.has(c.parent_id)) e.adoptive.add(c.parent_id);
      else if (stepParentIds.has(c.parent_id)) e.step = true;
    }

    const classified: Array<{ siblingId: string; siblingType: SiblingType }> = [];
    for (const [siblingId, e] of agg) {
      let t: SiblingType | null = null;
      if (e.bio.size >= 2) t = 'FULL_SIBLING';
      else if (e.bio.size === 1) t = 'HALF_SIBLING';
      else if (e.adoptive.size >= 1) t = 'ADOPTIVE_SIBLING';
      else if (e.step) t = 'STEP_SIBLING';
      if (t) classified.push({ siblingId, siblingType: t });
    }
    if (classified.length === 0) return [];

    const summaries = await this.loadPersonSummaries(classified.map((c) => c.siblingId));
    return classified
      .map((c) => {
        const person = summaries.get(c.siblingId);
        return person ? { person, siblingType: c.siblingType } : null;
      })
      .filter((s): s is DerivedSiblingDto => s !== null)
      .sort((a, b) =>
        (a.person.lastName + a.person.firstName).localeCompare(
          b.person.lastName + b.person.firstName,
        ),
      );
  }

  // ─── E) getFamilyTree ─────────────────────────────────────────

  async getFamilyTree(personId: string): Promise<FamilyTreeDto> {
    const person = await this.loadPersonSummary(personId);
    if (!person) throw new NotFoundException('Person not found');
    const { relationships, derivedSiblings } = await this.getRelationships(personId);

    const inGroup = (types: string[]) => relationships.filter((r) => types.includes(r.type));
    const grouped = new Set([
      ...PARENT_TYPES,
      ...CHILD_TYPES,
      ...SPOUSE_TYPES,
      'GRANDPARENT',
      'GRANDCHILD',
    ]);

    return {
      person,
      parents: inGroup(PARENT_TYPES),
      children: inGroup(CHILD_TYPES),
      grandparents: inGroup(['GRANDPARENT']),
      grandchildren: inGroup(['GRANDCHILD']),
      spouses: inGroup(SPOUSE_TYPES),
      other: relationships.filter((r) => !grouped.has(r.type)),
      siblings: derivedSiblings,
    };
  }

  // ─── Internal helpers ─────────────────────────────────────────

  async getRelationshipById(id: string): Promise<RelationshipDto> {
    const rows = await this.prisma.$queryRawUnsafe<RelationshipRow[]>(
      this.selectSql() + ' WHERE r.id = $1::uuid LIMIT 1',
      id,
    );
    if (rows.length === 0) throw new NotFoundException('Relationship not found');
    return this.toDto(rows[0]!);
  }

  private async requireOwnedRow(
    relationshipId: string,
    personId: string,
  ): Promise<RelationshipRow> {
    const rows = await this.prisma.$queryRawUnsafe<RelationshipRow[]>(
      this.selectSql() + ' WHERE r.id = $1::uuid LIMIT 1',
      relationshipId,
    );
    const row = rows[0];
    // 404 (not 403) when the row belongs to another person's perspective
    // so we don't leak the existence of someone else's relationship.
    if (!row || row.person_id !== personId) {
      throw new NotFoundException('Relationship not found');
    }
    return row;
  }

  private async findReciprocalId(
    tx: Pick<PrismaClient, '$queryRawUnsafe'>,
    row: RelationshipRow,
  ): Promise<string | null> {
    if (!row.related_person_id) return null;
    const candidates = RECIPROCAL_CANDIDATES[row.relationship_type] ?? [];
    if (candidates.length === 0) return null;
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id
         FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND related_person_id = $2::uuid
          AND relationship_type = ANY($3::text[])
        LIMIT 1`,
      row.related_person_id,
      row.person_id,
      candidates,
    );
    return rows[0]?.id ?? null;
  }

  private async applyUpdate(
    tx: Pick<PrismaClient, '$executeRawUnsafe'>,
    id: string,
    set: string[],
    args: unknown[],
  ): Promise<void> {
    const clauses = [...set, 'updated_at = now()'];
    await tx.$executeRawUnsafe(
      `UPDATE platform.platform_person_relationships SET ${clauses.join(', ')} WHERE id = $${
        args.length + 1
      }::uuid`,
      ...args,
      id,
    );
  }

  private async requirePersonExists(personId: string): Promise<void> {
    const p = await this.prisma.iamPerson.findUnique({
      where: { id: personId },
      select: { id: true },
    });
    if (!p) throw new BadRequestException('Person not found');
  }

  private async loadPersonSummary(personId: string): Promise<PersonSummaryDto | null> {
    const map = await this.loadPersonSummaries([personId]);
    return map.get(personId) ?? null;
  }

  private async loadPersonSummaries(ids: string[]): Promise<Map<string, PersonSummaryDto>> {
    const map = new Map<string, PersonSummaryDto>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        first_name: string;
        last_name: string;
        preferred_name: string | null;
        date_of_birth: string | null;
      }>
    >(
      `SELECT id::text AS id, first_name, last_name, preferred_name, date_of_birth::text AS date_of_birth
         FROM platform.iam_person
        WHERE id = ANY($1::uuid[])`,
      Array.from(new Set(ids)),
    );
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        firstName: r.first_name,
        lastName: r.last_name,
        preferredName: r.preferred_name,
        dateOfBirth: r.date_of_birth,
        age: computeAge(r.date_of_birth),
      });
    }
    return map;
  }

  private selectSql(): string {
    return `SELECT r.id::text AS id,
                   r.person_id::text AS person_id,
                   r.related_person_id::text AS related_person_id,
                   r.related_person_name,
                   r.relationship_type,
                   r.is_legal_custody,
                   r.custody_arrangement,
                   r.custody_notes,
                   r.is_primary_residence,
                   r.verified,
                   r.verified_by::text AS verified_by,
                   r.verified_at::text AS verified_at,
                   r.start_date::text AS start_date,
                   r.end_date::text AS end_date,
                   rp.first_name AS rp_first_name,
                   rp.last_name AS rp_last_name,
                   rp.preferred_name AS rp_preferred_name,
                   rp.date_of_birth::text AS rp_date_of_birth
              FROM platform.platform_person_relationships r
              LEFT JOIN platform.iam_person rp ON rp.id = r.related_person_id`;
  }

  private toDto(r: RelationshipRow): RelationshipDto {
    const relatedPerson: PersonSummaryDto | null = r.related_person_id
      ? {
          id: r.related_person_id,
          firstName: r.rp_first_name ?? '',
          lastName: r.rp_last_name ?? '',
          preferredName: r.rp_preferred_name,
          dateOfBirth: r.rp_date_of_birth,
          age: computeAge(r.rp_date_of_birth),
        }
      : null;
    return {
      id: r.id,
      type: r.relationship_type as RelationshipType,
      relatedPerson,
      relatedPersonName: r.related_person_name,
      isLegalCustody: r.is_legal_custody,
      custodyArrangement: (r.custody_arrangement as RelationshipDto['custodyArrangement']) ?? null,
      custodyNotes: r.custody_notes,
      isPrimaryResidence: r.is_primary_residence,
      verified: r.verified,
      verifiedBy: r.verified_by,
      verifiedAt: r.verified_at,
      startDate: r.start_date,
      endDate: r.end_date,
    };
  }

  private isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: string; meta?: { code?: string } }).code;
    const sqlState = (err as { meta?: { code?: string } }).meta?.code;
    return code === 'P2002' || sqlState === '23505';
  }
}

/** Whole years between a YYYY-MM-DD date and today; null when unknown. */
function computeAge(dateOfBirth: string | null): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}
