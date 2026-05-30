import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RelationshipService } from '@modules/m00-platform/iam/relationship.service';
import { RelationshipController } from '@modules/m00-platform/iam/relationship.controller';
import type { ActorContextService } from '@modules/m00-platform/iam/actor-context.service';
import type { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';

/**
 * DB-backed integration tests for the family-structure feature
 * (Steps 2-3). Exercises the RelationshipService — auto-reciprocal
 * maintenance, sibling derivation (full / half / step / adoptive),
 * custody updates, verification — plus the controller's household-based
 * cross-family isolation guard.
 */
describe('integration:m00-platform/relationships', () => {
  let prisma: PrismaClient;
  let svc: RelationshipService;
  let controller: RelationshipController;

  // Drives the stubbed actor (school-admin status, used by view + verify)
  // and the caller's derived personas (used by the canEdit predicate).
  // Reset before each test to a plain PARENT caller; individual tests flip
  // them to exercise the edit-permission rule.
  const actorOverride: { isSchoolAdmin: boolean } = { isSchoolAdmin: false };
  let personaOverride: string[] = ['PARENT'];

  // People. Names double as a readable map of the test family graph.
  const adam = generateId(); // father
  const ashley = generateId(); // mother
  const carlos = generateId(); // other father (half-sibling case)
  const sarah = generateId(); // step-mother (adam's spouse)
  const emmaDad = generateId(); // emma's biological father (unrelated)
  const scout = generateId(); // subject child
  const thatcher = generateId(); // full sibling of scout
  const jake = generateId(); // maternal half-sibling of scout
  const emma = generateId(); // step-sibling of scout (sarah's child)
  const scout2 = generateId(); // for name-only parent test
  const userB = generateId(); // unrelated guardian (cross-family isolation)
  // Account ids (platform_users.id) for reqFor; resolveActor is stubbed so
  // these need not exist in the DB.
  const adamAccount = generateId();
  const scoutAccount = generateId();
  const userBAccount = generateId();

  const ALL_PEOPLE = [
    adam,
    ashley,
    carlos,
    sarah,
    emmaDad,
    scout,
    thatcher,
    jake,
    emma,
    scout2,
    userB,
  ];

  // A household owned by adam, with scout as a LINKED child — backs the
  // controller's isGuardianOf authorisation check.
  const familyId = generateId();

  async function seedPerson(id: string, first: string, dob: string | null): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active, date_of_birth)
       VALUES ($1::uuid, $2, 'Tromsness', 'GUARDIAN', true, $3::date)
       ON CONFLICT (id) DO NOTHING`,
      id,
      first,
      dob,
    );
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    svc = new RelationshipService(prisma);
    // Stub the actor resolution (admin status, used by view + verify) and
    // the persona lookup (used by canEdit) so we stay out of tenant
    // context. The guardian-of check (isActiveGuardianOf) is the real
    // DB-backed service. Overrides are set per test.
    const actorStub = {
      resolveActor: async (_accountId: string, personId: string) => ({
        accountId: _accountId,
        personId,
        employeeId: null,
        personType: null,
        isSchoolAdmin: actorOverride.isSchoolAdmin,
      }),
    } as unknown as ActorContextService;
    const personaStub = {
      getActivePersonas: async () =>
        personaOverride.map((type) => ({ id: '', type, schoolId: null, label: type })),
    } as unknown as PersonaResolutionService;
    controller = new RelationshipController(svc, actorStub, personaStub);

    await seedPerson(adam, 'Adam', '1985-04-10');
    await seedPerson(ashley, 'Ashley', '1986-06-15');
    await seedPerson(carlos, 'Carlos', '1984-01-20');
    await seedPerson(sarah, 'Sarah', '1988-09-05');
    await seedPerson(emmaDad, 'Bruno', '1983-02-02');
    await seedPerson(scout, 'Scout', '2012-03-01');
    await seedPerson(thatcher, 'Thatcher', '2014-07-12');
    await seedPerson(jake, 'Jake', '2013-05-09');
    await seedPerson(emma, 'Emma', '2015-11-30');
    await seedPerson(scout2, 'Riley', '2016-08-08');
    await seedPerson(userB, 'Unrelated', '1990-01-01');

    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users
         (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, 'User B', 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      userBAccount,
      userB,
      `relationships-userB-${userB.slice(-6)}@test.integration`,
    );

    // Household: adam is an ACTIVE head-of-household, scout is a LINKED
    // child. userB is NOT a member.
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
       VALUES ($1::uuid, 'Tromsness', 'en', true) ON CONFLICT (id) DO NOTHING`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, status, joined_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, 'ACTIVE', now())
       ON CONFLICT (id) DO NOTHING`,
      generateId(),
      familyId,
      adam,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_children
         (id, family_id, person_id, first_name, last_name, status, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'Scout', 'Tromsness', 'LINKED', now())
       ON CONFLICT (id) DO NOTHING`,
      generateId(),
      familyId,
      scout,
    );
  });

  afterAll(async () => {
    await cleanRels();
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_children WHERE family_id = $1::uuid`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_family_members WHERE family_id = $1::uuid`,
      familyId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id = $1::uuid`,
      familyId,
    );
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

  async function cleanRels(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_person_relationships
        WHERE person_id = ANY($1::uuid[]) OR related_person_id = ANY($1::uuid[])`,
      ALL_PEOPLE,
    );
  }

  // Each test starts from a clean relationship graph and a plain PARENT
  // caller (tests that need a student/substitute/admin caller flip the
  // overrides).
  beforeEach(async () => {
    personaOverride = ['PARENT'];
    actorOverride.isSchoolAdmin = false;
    await cleanRels();
  });

  async function countRows(personId: string, type: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid AND relationship_type = $2`,
      personId,
      type,
    );
    return Number(rows[0]!.n);
  }

  // ─── Reciprocals ──────────────────────────────────────────────

  it('add biological mother → reciprocal BIOLOGICAL_CHILD created on the mother', async () => {
    const rel = await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    expect(rel.type).toBe('BIOLOGICAL_MOTHER');
    expect(rel.relatedPerson?.id).toBe(ashley);

    const motherSide = await svc.getRelationships(ashley);
    const child = motherSide.relationships.find((r) => r.type === 'BIOLOGICAL_CHILD');
    expect(child).toBeDefined();
    expect(child!.relatedPerson?.id).toBe(scout);
  });

  it('add biological father → reciprocal BIOLOGICAL_CHILD created on the father', async () => {
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    const fatherSide = await svc.getRelationships(adam);
    expect(
      fatherSide.relationships.some(
        (r) => r.type === 'BIOLOGICAL_CHILD' && r.relatedPerson?.id === scout,
      ),
    ).toBe(true);
  });

  it('add name-only parent → no reciprocal created', async () => {
    const rel = await svc.addRelationship(
      scout2,
      { relatedPersonName: 'Linda Chen', relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    expect(rel.relatedPerson).toBeNull();
    expect(rel.relatedPersonName).toBe('Linda Chen');
    // No CampusOS person → nothing to attach a reciprocal to. Scope the
    // count to scout2 (cleaned in beforeEach) so seed/other-test data
    // can't pollute it: exactly one row touches scout2 — the forward
    // name-only row — and none has scout2 as related_person_id (which a
    // reciprocal would).
    const touching = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM platform.platform_person_relationships
        WHERE person_id = $1::uuid OR related_person_id = $1::uuid`,
      scout2,
    );
    expect(Number(touching[0]!.n)).toBe(1);
  });

  it('delete relationship → both sides removed', async () => {
    const rel = await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    expect(await countRows(ashley, 'BIOLOGICAL_CHILD')).toBe(1);
    await svc.deleteRelationship(scout, rel.id);
    expect(await countRows(scout, 'BIOLOGICAL_MOTHER')).toBe(0);
    expect(await countRows(ashley, 'BIOLOGICAL_CHILD')).toBe(0);
  });

  it('update custody → both sides updated', async () => {
    const rel = await svc.addRelationship(
      scout,
      {
        relatedPersonId: ashley,
        relationshipType: 'BIOLOGICAL_MOTHER',
        custodyArrangement: 'FULL',
      },
      adam,
    );
    await svc.updateRelationship(scout, rel.id, {
      custodyArrangement: 'JOINT',
      custodyNotes: 'Alternating weeks',
      isPrimaryResidence: true,
    });
    const forward = await svc.getRelationshipById(rel.id);
    expect(forward.custodyArrangement).toBe('JOINT');
    expect(forward.custodyNotes).toBe('Alternating weeks');
    expect(forward.isPrimaryResidence).toBe(true);

    const motherSide = await svc.getRelationships(ashley);
    const reciprocal = motherSide.relationships.find((r) => r.type === 'BIOLOGICAL_CHILD');
    expect(reciprocal!.custodyArrangement).toBe('JOINT');
    expect(reciprocal!.custodyNotes).toBe('Alternating weeks');
  });

  it('get relationships → returns direct relationships + derived siblings', async () => {
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    await svc.addRelationship(
      thatcher,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      thatcher,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );

    const result = await svc.getRelationships(scout);
    expect(result.relationships).toHaveLength(2);
    expect(result.derivedSiblings.some((s) => s.person.id === thatcher)).toBe(true);
  });

  // ─── Sibling derivation ───────────────────────────────────────

  it('same mother + father → FULL_SIBLING', async () => {
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    await svc.addRelationship(
      thatcher,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      thatcher,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );

    const sib = (await svc.getRelationships(scout)).derivedSiblings.find(
      (s) => s.person.id === thatcher,
    );
    expect(sib?.siblingType).toBe('FULL_SIBLING');
    // Age is derived from DOB on the summary.
    expect(sib?.person.age).toBeGreaterThan(0);
  });

  it('same mother, different father → HALF_SIBLING', async () => {
    // scout: mother ashley, father adam. jake: mother ashley, father carlos.
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    await svc.addRelationship(
      jake,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      jake,
      { relatedPersonId: carlos, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );

    const sib = (await svc.getRelationships(scout)).derivedSiblings.find(
      (s) => s.person.id === jake,
    );
    expect(sib?.siblingType).toBe('HALF_SIBLING');
  });

  it('parent’s spouse’s child from another relationship → STEP_SIBLING', async () => {
    // scout: adam + ashley. adam married sarah. emma: sarah + emmaDad.
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    await svc.addRelationship(adam, { relatedPersonId: sarah, relationshipType: 'SPOUSE' }, adam);
    await svc.addRelationship(
      emma,
      { relatedPersonId: sarah, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      emma,
      { relatedPersonId: emmaDad, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );

    const sib = (await svc.getRelationships(scout)).derivedSiblings.find(
      (s) => s.person.id === emma,
    );
    expect(sib?.siblingType).toBe('STEP_SIBLING');
  });

  // ─── Verification ─────────────────────────────────────────────

  it('verify relationship → verified=true, verified_by set', async () => {
    const rel = await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    expect(rel.verified).toBe(false);
    const verified = await svc.verifyRelationship(scout, rel.id, adam, true);
    expect(verified.verified).toBe(true);
    expect(verified.verifiedBy).toBe(adam);
    expect(verified.verifiedAt).not.toBeNull();
  });

  // ─── Validation ───────────────────────────────────────────────

  it('duplicate relationship (same person, related, type) → 409', async () => {
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await expect(
      svc.addRelationship(
        scout,
        { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
        adam,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('relating a person to themselves → 400', async () => {
    await expect(
      svc.addRelationship(
        scout,
        { relatedPersonId: scout, relationshipType: 'BIOLOGICAL_MOTHER' },
        adam,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reciprocal-only type via direct create → 400', async () => {
    await expect(
      svc.addRelationship(
        scout,
        { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_CHILD' as never },
        adam,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── Edit permissions (persona-based, parent/guardian-only) ──

  it('Parent persona on own profile → canEdit:true; POST/PATCH/DELETE succeed', async () => {
    personaOverride = ['PARENT'];
    const asSelf = await controller.list(reqFor(adam, adamAccount), adam);
    expect(asSelf.canEdit).toBe(true);
    const rel = await controller.create(reqFor(adam, adamAccount), adam, {
      relatedPersonId: ashley,
      relationshipType: 'SPOUSE',
    });
    expect(rel.type).toBe('SPOUSE');
    const patched = await controller.update(reqFor(adam, adamAccount), adam, rel.id, {
      custodyNotes: 'married 2010',
    });
    expect(patched.custodyNotes).toBe('married 2010');
    await expect(
      controller.remove(reqFor(adam, adamAccount), adam, rel.id),
    ).resolves.toBeUndefined();
  });

  it('Parent persona can POST/PATCH/DELETE on their child’s profile', async () => {
    personaOverride = ['PARENT'];
    // adam is scout's head-of-household → active guardian via household.
    const rel = await controller.create(reqFor(adam, adamAccount), scout, {
      relatedPersonId: ashley,
      relationshipType: 'BIOLOGICAL_MOTHER',
      custodyArrangement: 'JOINT',
    });
    expect(rel.type).toBe('BIOLOGICAL_MOTHER');
    const patched = await controller.update(reqFor(adam, adamAccount), scout, rel.id, {
      custodyArrangement: 'FULL',
    });
    expect(patched.custodyArrangement).toBe('FULL');
    await expect(
      controller.remove(reqFor(adam, adamAccount), scout, rel.id),
    ).resolves.toBeUndefined();
  });

  it('Parent + Substitute personas → still edit-eligible (Substitute is noise)', async () => {
    personaOverride = ['PARENT', 'SUBSTITUTE'];
    const resp = await controller.list(reqFor(adam, adamAccount), scout);
    expect(resp.canEdit).toBe(true);
    const rel = await controller.create(reqFor(adam, adamAccount), scout, {
      relatedPersonId: ashley,
      relationshipType: 'BIOLOGICAL_MOTHER',
    });
    expect(rel.type).toBe('BIOLOGICAL_MOTHER');
  });

  it('Substitute-only persona → canEdit:false; mutations → 403', async () => {
    personaOverride = ['SUBSTITUTE'];
    const resp = await controller.list(reqFor(adam, adamAccount), scout);
    expect(resp.canEdit).toBe(false);
    await expect(
      controller.create(reqFor(adam, adamAccount), scout, {
        relatedPersonId: ashley,
        relationshipType: 'BIOLOGICAL_MOTHER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('Student persona on own profile → canEdit:false; mutations → 403', async () => {
    personaOverride = ['STUDENT'];
    const asSelf = await controller.list(reqFor(scout, scoutAccount), scout);
    expect(asSelf.canEdit).toBe(false);
    await expect(
      controller.create(reqFor(scout, scoutAccount), scout, {
        relatedPersonId: ashley,
        relationshipType: 'BIOLOGICAL_MOTHER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('school admin → canEdit:false; mutations → 403; verify → 200', async () => {
    const seeded = await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    personaOverride = ['STAFF'];
    actorOverride.isSchoolAdmin = true;
    const asAdmin = await controller.list(reqFor(userB, userBAccount), scout);
    expect(asAdmin.canEdit).toBe(false);
    await expect(
      controller.update(reqFor(userB, userBAccount), scout, seeded.id, {
        custodyArrangement: 'FULL',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // verify is the admin's one sanctioned mutation.
    const verified = await controller.verify(reqFor(userB, userBAccount), scout, seeded.id, {
      verified: true,
    });
    expect(verified.verified).toBe(true);
  });

  it('newly created child by a parent → creator is active guardian, canEdit:true', async () => {
    // The household fixture mirrors child creation: adam (HEAD_OF_HOUSEHOLD,
    // a guardian role) over the LINKED child scout — exactly the link the
    // create-child flow establishes. The creator can edit immediately.
    expect(await svc.isActiveGuardianOf(adam, scout)).toBe(true);
    personaOverride = ['PARENT'];
    const resp = await controller.list(reqFor(adam, adamAccount), scout);
    expect(resp.canEdit).toBe(true);
    const rel = await controller.create(reqFor(adam, adamAccount), scout, {
      relatedPersonId: adam,
      relationshipType: 'BIOLOGICAL_FATHER',
    });
    expect(rel.type).toBe('BIOLOGICAL_FATHER');
  });

  it('sibling student co-resident in the same household cannot edit another child → 403', async () => {
    // Make jake an ACTIVE household member of scout's family in a STUDENT
    // role — a co-resident, not a guardian. Even with a (hypothetical)
    // parent persona the household role gate denies; with a STUDENT
    // persona it's doubly denied.
    const siblingMemberId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_family_members
         (id, family_id, person_id, member_role, is_primary_contact, status, joined_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'STUDENT', false, 'ACTIVE', now())
       ON CONFLICT (id) DO NOTHING`,
      siblingMemberId,
      familyId,
      jake,
    );
    try {
      expect(await svc.isActiveGuardianOf(jake, scout)).toBe(false);
      personaOverride = ['STUDENT'];
      await expect(
        controller.create(reqFor(jake, generateId()), scout, {
          relatedPersonId: ashley,
          relationshipType: 'BIOLOGICAL_MOTHER',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE id = $1::uuid`,
        siblingMemberId,
      );
    }
  });

  it('cross-family isolation: a parent cannot edit another family’s child', async () => {
    personaOverride = ['PARENT'];
    // userB has a PARENT persona but is not a guardian of scout (not in
    // scout's household, no parent relationship) → Forbidden.
    await expect(
      controller.create(reqFor(userB, userBAccount), scout, {
        relatedPersonId: ashley,
        relationshipType: 'BIOLOGICAL_MOTHER',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─── Family tree ──────────────────────────────────────────────

  it('getFamilyTree buckets relationships by category', async () => {
    await svc.addRelationship(
      scout,
      { relatedPersonId: ashley, relationshipType: 'BIOLOGICAL_MOTHER' },
      adam,
    );
    await svc.addRelationship(
      scout,
      { relatedPersonId: adam, relationshipType: 'BIOLOGICAL_FATHER' },
      adam,
    );
    const tree = await svc.getFamilyTree(scout);
    expect(tree.person.id).toBe(scout);
    expect(tree.parents).toHaveLength(2);
    expect(tree.children).toHaveLength(0);
  });

  function reqFor(personId: string, accountId: string): any {
    return {
      headers: {},
      user: {
        sub: accountId,
        personId,
        email: 'x@test',
        displayName: 'T',
        sessionId: generateId(),
      },
    };
  }
});
