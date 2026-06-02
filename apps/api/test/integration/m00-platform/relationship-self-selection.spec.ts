import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RelationshipService } from '@modules/m00-platform/iam/relationship.service';
import { PeopleSearchService } from '@modules/m00-platform/iam/people-search.service';

/**
 * DB-backed tests for the Set-Relationship modal "can't select self" fix.
 *
 *   - PeopleSearchService.includeSelf surfaces the caller (the
 *     parent-sets-self flow) while the default still excludes them.
 *   - RelationshipService.addRelationship UPGRADES an existing active edge
 *     in place when the selected person is already linked (e.g. the
 *     bootstrap LEGAL_GUARDIAN row): no duplicate, no 409, legal custody
 *     carried onto the parentage row.
 *   - The upgrade leaves isActiveGuardianOf true (PARENT_TYPES spans
 *     LEGAL_GUARDIAN + parentage), so edit rights are never stripped.
 *   - Setting the OTHER parent (no prior link) still creates a fresh row.
 *
 * Pattern mirrors relationships.spec.ts: services are instantiated
 * directly against a real PrismaClient; no Nest app / HTTP layer.
 */
describe('integration:m00-platform/relationship-self-selection', () => {
  let prisma: PrismaClient;
  let rel: RelationshipService;
  let people: PeopleSearchService;

  // People (last name doubles as a unique search token).
  const dad = generateId();
  const mom = generateId();
  const child = generateId();
  const searcher = generateId(); // caller for people-search tests
  const ALL_PEOPLE = [dad, mom, child, searcher];

  async function seedPerson(id: string, first: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, $2, 'Zelphwick', 'GUARDIAN', true)
       ON CONFLICT (id) DO NOTHING`,
      id,
      first,
    );
  }

  async function seedAccount(personId: string, email: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'T', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      generateId(),
      personId,
      email,
    );
  }

  // Bootstrap guardian edge a child-account creation grants: LEGAL_GUARDIAN
  // forward (child→guardian) + LEGAL_WARD reciprocal.
  async function seedGuardianEdge(childId: string, guardianId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_person_relationships
         (id, person_id, related_person_id, relationship_type, is_legal_custody, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'LEGAL_GUARDIAN', true, $3::uuid)`,
      generateId(),
      childId,
      guardianId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_person_relationships
         (id, person_id, related_person_id, relationship_type, is_legal_custody, created_by)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'LEGAL_WARD', true, $3::uuid)`,
      generateId(),
      guardianId,
      childId,
    );
  }

  async function cleanRels(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_person_relationships
        WHERE person_id = ANY($1::uuid[]) OR related_person_id = ANY($1::uuid[])`,
      ALL_PEOPLE,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    rel = new RelationshipService(prisma);
    people = new PeopleSearchService(prisma);

    await seedPerson(dad, 'Dadtest');
    await seedPerson(mom, 'Momtest');
    await seedPerson(child, 'Childtest');
    await seedPerson(searcher, 'Searchtest');
    // people-search INNER-joins platform_users; the caller + a target need
    // accounts to surface.
    await seedAccount(searcher, `searcher-${searcher.slice(-6)}@test.integration`);
    await seedAccount(dad, `dad-${dad.slice(-6)}@test.integration`);
  });

  afterAll(async () => {
    await cleanRels();
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE person_id = ANY($1::uuid[])`,
      ALL_PEOPLE,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
      ALL_PEOPLE,
    );
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanRels();
  });

  // ─── People-search includeSelf ────────────────────────────────

  it('people-search includeSelf=true returns the caller', async () => {
    const results = await people.search(searcher, 'Searchtest', true);
    expect(results.some((r) => r.id === searcher)).toBe(true);
  });

  it('people-search excludes the caller by default', async () => {
    const results = await people.search(searcher, 'Searchtest', false);
    expect(results.some((r) => r.id === searcher)).toBe(false);
  });

  // ─── Upgrade-in-place ─────────────────────────────────────────

  it('upgrades an existing guardian link in place when a parent sets parentage', async () => {
    await seedGuardianEdge(child, dad);

    const result = await rel.addRelationship(
      child,
      { relatedPersonId: dad, relationshipType: 'BIOLOGICAL_FATHER' },
      dad,
    );
    // No 409, no duplicate — the existing row is upgraded.
    expect(result.type).toBe('BIOLOGICAL_FATHER');
    // The guardian fact is carried onto the parentage row.
    expect(result.isLegalCustody).toBe(true);

    // Exactly one forward row child→dad remains, now BIOLOGICAL_FATHER.
    const fwd = await prisma.$queryRawUnsafe<Array<{ relationship_type: string }>>(
      `SELECT relationship_type FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND related_person_id = $2::uuid`,
      child,
      dad,
    );
    expect(fwd.length).toBe(1);
    expect(fwd[0]!.relationship_type).toBe('BIOLOGICAL_FATHER');

    // Reciprocal upgraded LEGAL_WARD → BIOLOGICAL_CHILD, still single row.
    const rec = await prisma.$queryRawUnsafe<Array<{ relationship_type: string }>>(
      `SELECT relationship_type FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND related_person_id = $2::uuid`,
      dad,
      child,
    );
    expect(rec.length).toBe(1);
    expect(rec[0]!.relationship_type).toBe('BIOLOGICAL_CHILD');
  });

  it('upgrade keeps the editor an active guardian (graph path intact)', async () => {
    await seedGuardianEdge(child, dad);
    expect(await rel.isActiveGuardianOf(dad, child)).toBe(true);

    await rel.addRelationship(
      child,
      { relatedPersonId: dad, relationshipType: 'BIOLOGICAL_FATHER' },
      dad,
    );
    // Still a guardian after LEGAL_GUARDIAN → BIOLOGICAL_FATHER.
    expect(await rel.isActiveGuardianOf(dad, child)).toBe(true);
  });

  it('creates a fresh row for the other parent when no prior link exists', async () => {
    await seedGuardianEdge(child, dad);

    // No relationship between child and mom yet → straight insert.
    const result = await rel.addRelationship(
      child,
      { relatedPersonId: mom, relationshipType: 'BIOLOGICAL_MOTHER' },
      dad,
    );
    expect(result.type).toBe('BIOLOGICAL_MOTHER');
    // legalCustody defaults to false when there was nothing to upgrade.
    expect(result.isLegalCustody).toBe(false);

    const rows = await prisma.$queryRawUnsafe<Array<{ relationship_type: string }>>(
      `SELECT relationship_type FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND related_person_id = $2::uuid`,
      child,
      mom,
    );
    expect(rows.length).toBe(1);
  });
});
