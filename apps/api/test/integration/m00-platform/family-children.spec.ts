import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, HttpException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FamilyChildrenService } from '@modules/m00-platform/households/family-children.service';
import { FamilyChildrenController } from '@modules/m00-platform/households/family-children.controller';
import { FamiliesController } from '@modules/m00-platform/households/families.controller';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { UpdateFamilyContactPreferencesDto } from '@modules/m00-platform/households/dto/family-child.dto';
import { RedisService } from '@shared/cache';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

/**
 * DB-backed integration tests for FamilyChildrenService — Step 5 of the
 * persona-registration design. Covers CRUD, cross-family isolation,
 * and the LINKED read-only guard.
 *
 * Step 6 (account creation, link send, accept code) lives in
 * child-linking.spec.ts so the surface area per spec stays small.
 */
describe('integration:m00-platform/family-children', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let redis: RedisService;
  let service: FamilyChildrenService;
  let controller: FamilyChildrenController;

  // Two users in two separate families to exercise cross-family
  // isolation.
  const userAPersonId = generateId();
  const userAAccountId = generateId();
  const userBPersonId = generateId();
  const userBAccountId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    redis = new RedisService();
    await redis.onModuleInit();
    const personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    service = new FamilyChildrenService(prisma, personaResolution, redis);
    controller = new FamilyChildrenController(service);

    for (const { personId, accountId, label } of [
      { personId: userAPersonId, accountId: userAAccountId, label: 'A' },
      { personId: userBPersonId, accountId: userBAccountId, label: 'B' },
    ]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, $2, 'Parent', 'GUARDIAN', true)
         ON CONFLICT (id) DO NOTHING`,
        personId,
        label,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false)
         ON CONFLICT (id) DO NOTHING`,
        accountId,
        personId,
        `family-children-${label}-${personId.slice(-6)}@test.integration`,
        `User ${label}`,
      );
    }
  });

  afterAll(async () => {
    for (const personId of [userAPersonId, userBPersonId]) {
      // platform_child_* all FK family_id → platform_families; drop
      // them before the family cleanup below.
      for (const table of [
        'platform_child_medical_info',
        'platform_child_emergency_contacts',
        'platform_child_dietary_info',
      ]) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM platform.${table} WHERE family_id IN
             (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
          personId,
        );
      }
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_families WHERE id NOT IN
           (SELECT family_id FROM platform.platform_family_members)`,
      );
    }
    // Drop persona-cache rows from any link-accept flows that called
    // refreshPersonaCacheSafe. platform_personas FKs iam_person, so
    // these have to go before the iam_person delete below.
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
        personId,
      );
    }
    // Drop any invitations issued by or targeted at these users —
    // platform_invitations FKs iam_person via both inviter_person_id
    // and target_person_id.
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations
         WHERE inviter_person_id = $1::uuid OR target_person_id = $1::uuid`,
        personId,
      );
    }
    // Managed minor accounts have managed_by_person_id = test user
    // with ON DELETE RESTRICT, so wipe them before the iam_person
    // delete below. The associated iam_person rows are then orphans
    // we also need to drop — collect their ids first.
    const managedRows = await prisma.$queryRawUnsafe<Array<{ person_id: string }>>(
      `SELECT person_id::text AS person_id FROM platform.platform_users
       WHERE managed_by_person_id = $1::uuid OR managed_by_person_id = $2::uuid`,
      userAPersonId,
      userBPersonId,
    );
    const managedPersonIds = managedRows.map((r) => r.person_id);
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE managed_by_person_id = $1::uuid`,
        personId,
      );
    }
    if (managedPersonIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_personas WHERE person_id = ANY($1::uuid[])`,
        managedPersonIds,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        managedPersonIds,
      );
    }
    for (const accountId of [userAAccountId, userBAccountId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE id = $1::uuid`,
        accountId,
      );
    }
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        personId,
      );
    }
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clear the per-account link-accept rate-limit counter — the new
    // GUARDIAN_INVITE + update-LINKED tests fire enough accepts on
    // userBAccountId that the 5-per-15-minute window in
    // assertLinkRateLimit trips otherwise.
    await redis.cacheInvalidate(
      'family:link-attempts:' + userAAccountId,
      'family:link-attempts:' + userBAccountId,
    );
    // Tear down everything we created on behalf of the two test
    // users, in FK-safe order.
    //
    // The createAccountForChild + createAccountForMember flows
    // synthesise iam_person + platform_users rows whose
    // managed_by_person_id points back to one of the test users.
    // UNIQUE(email) on platform_users would otherwise collide on
    // re-runs that reuse the same synthetic + parent-typed emails.
    //
    // The broader "orphan iam_person" sweep we tried earlier
    // misfired because other modules' test fixtures (sis_students,
    // hr_employees, etc.) create iam_person rows too, and the
    // platform.platform_students FK refused our DELETE. Track only
    // the ids we touched here.
    // Track every iam_person we'll need to delete: rows synthesised
    // by createAccountForChild / createAccountForMember (managed_by =
    // a test user) AND rows referenced by family_children in the
    // test users' families (e.g. createChildAccount minors that
    // managed_by catches; FAMILY_INVITE accept paths that don't
    // create new iam_person rows are not in this set and aren't
    // ours to delete anyway).
    const managedRows = await prisma.$queryRawUnsafe<Array<{ person_id: string }>>(
      `SELECT person_id::text AS person_id FROM platform.platform_users
       WHERE managed_by_person_id = $1::uuid OR managed_by_person_id = $2::uuid`,
      userAPersonId,
      userBPersonId,
    );
    const managedPersonIds = managedRows.map((r) => r.person_id);
    // Wipe the new child-section rows — these tables FK family_id
    // → platform_families and only this test writes to them today,
    // so a full nuke is the simplest way to avoid orphan rows from
    // a previous failed run blocking the family_members /
    // platform_families cleanup further down.
    for (const table of [
      'platform_child_medical_info',
      'platform_child_emergency_contacts',
      'platform_child_dietary_info',
    ]) {
      await prisma.$executeRawUnsafe(`DELETE FROM platform.${table}`);
    }
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE managed_by_person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      // Delete every member row in the test user's family — not just
      // their own. createAccountForMember adds rows whose person_id
      // is a synthesised managed user (not the test user), and
      // sendMemberInvite leaves rows with person_id NULL; both must
      // be wiped before we can drop the managed iam_persons further
      // below.
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      // Reset persona-cache so each test starts from 0 personas. The
      // accept-flow tests refresh the parent's cache on success; without
      // this wipe a re-run would see a stale PARENT row.
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
        personId,
      );
    }
    // Drop persona-cache + iam_person rows for the managed accounts
    // we just deleted. By this point: platform_users / family_members /
    // family_children references are gone; only platform_personas could
    // still hold a pointer. Wipe in that order.
    if (managedPersonIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_personas WHERE person_id = ANY($1::uuid[])`,
        managedPersonIds,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        managedPersonIds,
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_families WHERE id NOT IN
         (SELECT family_id FROM platform.platform_family_members)`,
    );
  });

  function reqFor(personId: string, accountId: string): any {
    return {
      headers: {},
      user: {
        sub: accountId,
        personId,
        email: 'irrelevant@test',
        displayName: 'Test',
        sessionId: generateId(),
      },
    };
  }

  const reqA = () => reqFor(userAPersonId, userAAccountId);
  const reqB = () => reqFor(userBPersonId, userBAccountId);

  // ─── GET /family/children ──────────────────────────────────

  it('list with no family yet → empty array (no implicit family creation)', async () => {
    const result = await controller.list(reqA());
    expect(result).toEqual([]);
  });

  it('list returns placeholders + linked rows after seeding', async () => {
    await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    const result = await controller.list(reqA());
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.firstName).sort()).toEqual(['Lucas', 'Sofia']);
    for (const c of result) {
      expect(c.status).toBe('PLACEHOLDER');
      expect(c.personId).toBeNull();
    }
  });

  // ─── POST /family/children ─────────────────────────────────

  it('create writes PLACEHOLDER, person_id NULL, lazy-creates family', async () => {
    const child = await controller.create(reqA(), {
      firstName: 'Sofia',
      lastName: 'A',
      dateOfBirth: '2010-06-12',
      gender: 'F',
    });
    expect(child.status).toBe('PLACEHOLDER');
    expect(child.personId).toBeNull();
    expect(child.firstName).toBe('Sofia');
    expect(child.dateOfBirth).toBe('2010-06-12');

    // Confirm family was created lazily.
    const fams = await prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
      `SELECT family_id::text AS family_id FROM platform.platform_family_members
       WHERE person_id = $1::uuid`,
      userAPersonId,
    );
    expect(fams).toHaveLength(1);
    expect(fams[0]!.family_id).toBe(child.familyId);
  });

  it('create twice → both children in same family', async () => {
    const c1 = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const c2 = await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    expect(c1.familyId).toBe(c2.familyId);
    const list = await controller.list(reqA());
    expect(list).toHaveLength(2);
  });

  // ─── PATCH /family/children/:id ────────────────────────────

  it('patch placeholder updates name + DOB', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const updated = await controller.update(reqA(), c.id, {
      firstName: 'Sophie',
      dateOfBirth: '2011-03-04',
    });
    expect(updated.firstName).toBe('Sophie');
    expect(updated.dateOfBirth).toBe('2011-03-04');
    expect(updated.lastName).toBe('A');
  });

  it('patch MANAGED LINKED child writes to iam_person and mirrors to family_children', async () => {
    // The dual-table write only fires for MANAGED children (the
    // caller is the account custodian). Use createChildAccount which
    // stamps platform_users.managed_by_person_id = caller. The
    // INDEPENDENT-rejection contract is locked by a separate spec
    // below.
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const linked = await controller.createAccount(reqA(), c.id, {
      dateOfBirth: '2014-03-03',
      gender: 'F',
    });
    expect(linked.accessLevel).toBe('MANAGED');

    const updated = await controller.update(reqA(), c.id, { firstName: 'Sophie', gender: 'F' });
    expect(updated.firstName).toBe('Sophie');
    expect(updated.gender).toBe('F');
    // gender must land on iam_person too — that's what the child's own
    // /profile page reads. A family-mirror-only write left the parent
    // seeing "Female" while the child saw "Not Specified".
    const person = await prisma.iamPerson.findUnique({
      where: { id: linked.personId! },
      select: { firstName: true, gender: true },
    });
    expect(person?.firstName).toBe('Sophie');
    expect(person?.gender).toBe('F');
  });

  it('patch INDEPENDENT LINKED child → 403', async () => {
    // user B accepts user A's FAMILY_INVITE → B is LINKED in A's
    // family with their own (unmanaged) platform_users row, so the
    // row resolves to INDEPENDENT from A's viewpoint.
    const code = (await controller.generateCode(reqA())).code;
    const result = await controller.accept(reqB(), { code });
    if (result.kind !== 'CHILD') throw new Error('expected CHILD result');
    expect(result.child.accessLevel).toBe('INDEPENDENT');
    await expect(
      controller.update(reqA(), result.child.id, { firstName: 'Hacked' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // ─── DELETE /family/children/:id ───────────────────────────

  it('delete placeholder removes it from the list', async () => {
    const c1 = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const c2 = await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
    await controller.remove(reqA(), c1.id);
    const list = await controller.list(reqA());
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(c2.id);
  });

  it('delete LINKED child → 400', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const linkedPersonId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Sofia', 'A', 'STUDENT', true)`,
      linkedPersonId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET person_id = $1::uuid, status = 'LINKED', linked_at = now()
       WHERE id = $2::uuid`,
      linkedPersonId,
      c.id,
    );

    await expect(controller.remove(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);

    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children SET person_id = NULL, status = 'PLACEHOLDER'
       WHERE id = $1::uuid`,
      c.id,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
      linkedPersonId,
    );
  });

  // Helper: drop the row to PENDING_LINK with a fixed code + invitation
  // row so the lifecycle tests below can exercise cancel + resend.
  async function seedPendingLink(childId: string, code: string): Promise<string> {
    const invitationId = generateId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_invitations
         (id, type, token, inviter_person_id, target_email, metadata,
          status, expires_at, created_at)
       VALUES ($1::uuid, 'CHILD_LINK', $2, $3::uuid, $4,
               jsonb_build_object('familyChildId', $5::text),
               'PENDING', now() + interval '72 hours', now())`,
      invitationId,
      code,
      userAPersonId,
      'sofia@example.invalid',
      childId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE platform.platform_family_children
         SET status = 'PENDING_LINK', invite_code = $1, invite_email = $2
       WHERE id = $3::uuid`,
      code,
      'sofia@example.invalid',
      childId,
    );
    return invitationId;
  }

  it('delete PENDING_LINK child → 400 (must cancel-link first)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK1');

    await expect(controller.remove(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);

    // Row + invitation must still exist (the BadRequest is a no-op).
    const inv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK1' } });
    expect(inv!.status).toBe('PENDING');
  });

  it('cancel-link on PENDING_LINK → invitation REVOKED, row back to PLACEHOLDER', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK2');

    const after = await controller.cancelLink(reqA(), c.id);

    expect(after.status).toBe('PLACEHOLDER');
    expect(after.inviteCode).toBeNull();
    expect(after.inviteEmail).toBeNull();
    expect(after.inviteSentAt).toBeNull();

    const inv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK2' } });
    expect(inv!.status).toBe('REVOKED');
  });

  it('cancel-link → delete succeeds (PENDING_LINK → PLACEHOLDER → removed)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK3');

    await controller.cancelLink(reqA(), c.id);
    await controller.remove(reqA(), c.id);

    const list = await controller.list(reqA());
    expect(list.find((x) => x.id === c.id)).toBeUndefined();
  });

  it('cancel-link on PLACEHOLDER → 400 (no pending link to cancel)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.cancelLink(reqA(), c.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('send-link works on PENDING_LINK — old code revoked, new code issued (resend)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await seedPendingLink(c.id, 'PENDLINK4');

    const after = await controller.sendLink(reqA(), c.id, { email: 'sofia@example.invalid' });

    expect(after.status).toBe('PENDING_LINK');
    expect(after.inviteCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(after.inviteCode).not.toBe('PENDLINK4');

    const oldInv = await prisma.platformInvitation.findUnique({ where: { token: 'PENDLINK4' } });
    expect(oldInv!.status).toBe('REVOKED');

    const newInv = await prisma.platformInvitation.findUnique({
      where: { token: after.inviteCode! },
    });
    expect(newInv!.status).toBe('PENDING');
  });

  // ─── Cross-family isolation ────────────────────────────────

  it('user B cannot see user A’s children', async () => {
    await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    const listB = await controller.list(reqB());
    expect(listB).toEqual([]);
  });

  it('user B cannot patch user A’s child (404)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.update(reqB(), c.id, { firstName: 'Hacked' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('user B cannot delete user A’s child (404)', async () => {
    const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
    await expect(controller.remove(reqB(), c.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  // ─── Bidirectional family-link feature ─────────────────────

  // Direction A — Parent generates FAMILY_INVITE, child accepts.
  describe('FAMILY_INVITE — parent generates, child accepts', () => {
    it('generate-code creates a PENDING FAMILY_INVITE with familyId metadata', async () => {
      const result = await controller.generateCode(reqA());
      expect(result.code).toMatch(/^[A-Z0-9]{8}$/);
      expect(result.type).toBe('FAMILY_INVITE');
      const row = await prisma.platformInvitation.findUnique({
        where: { token: result.code },
        select: { type: true, status: true, inviterPersonId: true, metadata: true },
      });
      expect(row?.type).toBe('FAMILY_INVITE');
      expect(row?.status).toBe('PENDING');
      expect(row?.inviterPersonId).toBe(userAPersonId);
      expect((row?.metadata as { familyId?: string }).familyId).toBeTruthy();
    });

    it('child accepting FAMILY_INVITE creates LINKED family_child + refreshes parent persona', async () => {
      const code = (await controller.generateCode(reqA())).code;
      const result = await controller.accept(reqB(), { code });
      if (result.kind !== 'CHILD') throw new Error('expected CHILD result');
      expect(result.child.status).toBe('LINKED');
      expect(result.child.personId).toBe(userBPersonId);

      // The child is in user A's family.
      const familyRow = await prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
        `SELECT family_id::text AS family_id FROM platform.platform_family_members WHERE person_id = $1::uuid LIMIT 1`,
        userAPersonId,
      );
      const aFamilyId = familyRow[0]!.family_id;
      expect(result.child.familyId).toBe(aFamilyId);

      // The invitation is ACCEPTED.
      const invitation = await prisma.platformInvitation.findUnique({
        where: { token: code },
        select: { status: true, targetPersonId: true },
      });
      expect(invitation?.status).toBe('ACCEPTED');
      expect(invitation?.targetPersonId).toBe(userBPersonId);
    });

    it('FAMILY_INVITE auto-matches a same-name PLACEHOLDER row instead of inserting a duplicate', async () => {
      // Parent pre-creates the child as a PLACEHOLDER with the SAME
      // name the accepter will resolve to from iam_person.
      const placeholder = await controller.create(reqA(), { firstName: 'B', lastName: 'Parent' });
      const code = (await controller.generateCode(reqA())).code;
      const accepted = await controller.accept(reqB(), { code });
      if (accepted.kind !== 'CHILD') throw new Error('expected CHILD result');
      expect(accepted.child.id).toBe(placeholder.id);
      expect(accepted.child.status).toBe('LINKED');
      expect(accepted.child.personId).toBe(userBPersonId);
    });

    it('refuses when the inviter accepts their own FAMILY_INVITE code', async () => {
      const code = (await controller.generateCode(reqA())).code;
      await expect(controller.accept(reqA(), { code })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // Direction B — Child generates CHILD_LINK (no familyChildId),
  // parent accepts.
  describe('CHILD_LINK without familyChildId — child generates, parent accepts', () => {
    it('generate-child-code creates a PENDING CHILD_LINK with NULL metadata', async () => {
      const result = await controller.generateChildCode(reqB());
      expect(result.type).toBe('CHILD_LINK');
      const row = await prisma.platformInvitation.findUnique({
        where: { token: result.code },
        select: { type: true, status: true, inviterPersonId: true, metadata: true },
      });
      expect(row?.type).toBe('CHILD_LINK');
      expect(row?.status).toBe('PENDING');
      expect(row?.inviterPersonId).toBe(userBPersonId);
      expect(row?.metadata).toBeNull();
    });

    it('parent accepting child-issued CHILD_LINK creates LINKED row in parent family + refreshes parent persona', async () => {
      const code = (await controller.generateChildCode(reqB())).code;
      const result = await controller.accept(reqA(), { code });
      if (result.kind !== 'CHILD') throw new Error('expected CHILD result');
      expect(result.child.status).toBe('LINKED');
      // The child stored on the row is the INVITER (user B), the
      // family is the ACCEPTER's (user A).
      expect(result.child.personId).toBe(userBPersonId);
      const familyRow = await prisma.$queryRawUnsafe<Array<{ family_id: string }>>(
        `SELECT family_id::text AS family_id FROM platform.platform_family_members WHERE person_id = $1::uuid LIMIT 1`,
        userAPersonId,
      );
      expect(result.child.familyId).toBe(familyRow[0]!.family_id);
    });
  });

  // ─── GET /family — composite view + viewer role ───────────

  describe('getFamily', () => {
    it('returns null when the caller has no family yet', async () => {
      const view = await controller.getFamily(reqA());
      expect(view).toBeNull();
    });

    it('returns PARENT view of the caller’s own family with children listed', async () => {
      await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      await controller.create(reqA(), { firstName: 'Lucas', lastName: 'A' });
      const view = await controller.getFamily(reqA());
      expect(view).not.toBeNull();
      expect(view!.viewerRole).toBe('PARENT');
      expect(view!.viewerPersonId).toBe(userAPersonId);
      // The caller is a family_members row in their own family.
      expect(view!.members.map((m) => m.personId)).toEqual([userAPersonId]);
      expect(view!.members[0]!.isCurrentUser).toBe(true);
      // Both placeholder children show up regardless of LINKED status.
      const names = view!.children.map((c) => c.firstName).sort();
      expect(names).toEqual(['Lucas', 'Sofia']);
    });

    it('returns CHILD view of the inviter’s family for a LINKED family_child', async () => {
      // user A invites user B as a child via FAMILY_INVITE.
      const code = (await controller.generateCode(reqA())).code;
      await controller.accept(reqB(), { code });
      // user B is now LINKED in user A's family with no kids of their
      // own → CHILD viewer of A's family.
      const view = await controller.getFamily(reqB());
      expect(view).not.toBeNull();
      expect(view!.viewerRole).toBe('CHILD');
      expect(view!.viewerPersonId).toBe(userBPersonId);
      // The parent (A) shows up in members.
      expect(view!.members.map((m) => m.personId)).toEqual([userAPersonId]);
      expect(view!.members[0]!.isCurrentUser).toBe(false);
      // children[] includes the viewer themself (B).
      const linkedPersonIds = view!.children
        .filter((c) => c.status === 'LINKED')
        .map((c) => c.personId);
      expect(linkedPersonIds).toContain(userBPersonId);
    });
  });

  // ─── Role-gated writes ─────────────────────────────────────

  describe('parent-only writes', () => {
    it('create refuses a CHILD viewer with 403', async () => {
      // Link user B as a child in A's family so B becomes a CHILD viewer.
      const code = (await controller.generateCode(reqA())).code;
      await controller.accept(reqB(), { code });
      await expect(
        controller.create(reqB(), { firstName: 'WontHappen', lastName: 'B' }),
      ).rejects.toMatchObject({ status: HttpException.prototype.constructor.name ? 403 : 403 });
    });

    it('generate-code refuses a CHILD viewer with 403', async () => {
      const code = (await controller.generateCode(reqA())).code;
      await controller.accept(reqB(), { code });
      await expect(controller.generateCode(reqB())).rejects.toMatchObject({ status: 403 });
    });
  });

  // ─── GUARDIAN_INVITE — parent generates, co-parent accepts ──

  describe('GUARDIAN_INVITE', () => {
    it('invite-guardian creates a PENDING GUARDIAN_INVITE with familyId metadata', async () => {
      const result = await controller.inviteGuardian(reqA(), {});
      expect(result.type).toBe('GUARDIAN_INVITE');
      const row = await prisma.platformInvitation.findUnique({
        where: { token: result.code },
        select: { type: true, status: true, inviterPersonId: true, metadata: true, targetEmail: true },
      });
      expect(row?.type).toBe('GUARDIAN_INVITE');
      expect(row?.status).toBe('PENDING');
      expect(row?.inviterPersonId).toBe(userAPersonId);
      expect((row?.metadata as { familyId?: string }).familyId).toBeTruthy();
      expect(row?.targetEmail).toBeNull();
    });

    it('invite-guardian records target_email when provided', async () => {
      const result = await controller.inviteGuardian(reqA(), { email: 'coparent@example.test' });
      const row = await prisma.platformInvitation.findUnique({
        where: { token: result.code },
        select: { targetEmail: true },
      });
      expect(row?.targetEmail).toBe('coparent@example.test');
    });

    it('accepting GUARDIAN_INVITE adds caller to family_members + returns GUARDIAN result', async () => {
      // Seed user A's family so the invitation has a target.
      await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      const result = await controller.accept(reqB(), { code });
      if (result.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');
      expect(result.family.id).toBeTruthy();
      expect(result.inviterName).toContain('A');

      // user B is now a family_members row in user A's family.
      const member = await prisma.familyMember.findUnique({
        where: { personId: userBPersonId },
        select: { familyId: true, memberRole: true, isPrimaryContact: true },
      });
      expect(member?.familyId).toBe(result.family.id);
      expect(member?.isPrimaryContact).toBe(false);

      // The invitation is ACCEPTED.
      const invitation = await prisma.platformInvitation.findUnique({
        where: { token: code },
        select: { status: true, targetPersonId: true },
      });
      expect(invitation?.status).toBe('ACCEPTED');
      expect(invitation?.targetPersonId).toBe(userBPersonId);
    });

    it('refuses a caller whose family has children with a 400', async () => {
      // user B is HoH of their own family AND has at least one child
      // — this is the "real family, not just a registration singleton"
      // case that the dissolve-on-accept fix below intentionally still
      // refuses. The empty-singleton path is covered by the next test.
      await controller.create(reqB(), { firstName: 'B', lastName: 'Child' });
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      await expect(controller.accept(reqB(), { code })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("dissolves the caller's empty singleton family and joins the inviter's", async () => {
      // Seed user B as HEAD_OF_HOUSEHOLD of an empty singleton family
      // — the shape /auth/register normally creates: family row + one
      // platform_family_members row, no children, no co-parents. This
      // is the case the dissolve-on-accept fix is meant to support.
      const oldFamilyId = generateId();
      const oldMemberId = generateId();
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_families (id, name, home_language, mailing_address_same)
         VALUES ($1::uuid, NULL, 'en', true)`,
        oldFamilyId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_members
           (id, family_id, person_id, member_role, is_primary_contact, joined_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', true, now())`,
        oldMemberId,
        oldFamilyId,
        userBPersonId,
      );
      const beforeMember = await prisma.familyMember.findUnique({
        where: { personId: userBPersonId },
        select: { familyId: true },
      });
      expect(beforeMember?.familyId).toBe(oldFamilyId);

      // Seed A's family so the GUARDIAN_INVITE has a target.
      await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      const result = await controller.accept(reqB(), { code });
      if (result.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');

      // B is now a member of A's family (the new family id from the
      // result), not the old singleton.
      const afterMember = await prisma.familyMember.findUnique({
        where: { personId: userBPersonId },
        select: { familyId: true },
      });
      expect(afterMember?.familyId).toBe(result.family.id);
      expect(afterMember?.familyId).not.toBe(oldFamilyId);

      // The old empty family was deleted in the same tx.
      const orphanFamily = await prisma.platformFamily.findUnique({
        where: { id: oldFamilyId },
      });
      expect(orphanFamily).toBeNull();
    });

    it('refuses the inviter accepting their own GUARDIAN_INVITE', async () => {
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      await expect(controller.accept(reqA(), { code })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("drops a synthetic ACTIVE placeholder-promotion shadow so the real accepter doesn't duplicate", async () => {
      // The createMemberAccount flow promotes a PLACEHOLDER guardian
      // directly to ACTIVE with a synthesized iam_person whose email
      // ends in @external.invalid. If the real person later self-
      // registers and accepts a GUARDIAN_INVITE, the shadow row
      // would coexist with the real one — /family renders the
      // person twice. The acceptGuardianInvite open-invite branch
      // now deletes the synthetic ACTIVE row in-tx when it finds a
      // name match.
      await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      // Seed the synthetic shadow directly via raw SQL — that's the
      // state createMemberAccount would leave behind, modelled here
      // without depending on that whole flow's prerequisites.
      const shadowPersonId = generateId();
      const shadowAccountId = generateId();
      const shadowMemberId = generateId();
      const familyAId = (await prisma.familyMember.findUnique({
        where: { personId: userAPersonId },
        select: { familyId: true },
      }))!.familyId;
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person
           (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Ashley', 'Tromsness', 'GUARDIAN', true)`,
        shadowPersonId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_users
           (id, person_id, email, account_status, account_type, mfa_enabled)
         VALUES ($1::uuid, $2::uuid, 'guardian-shadow-' || substr($1::text, 1, 6) || '@external.invalid',
                 'ACTIVE', 'HUMAN', false)`,
        shadowAccountId,
        shadowPersonId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.platform_family_members
           (id, family_id, person_id, member_role, is_primary_contact, status, joined_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_OF_HOUSEHOLD', false, 'ACTIVE', now())`,
        shadowMemberId,
        familyAId,
        shadowPersonId,
      );

      // userB is the real Ashley. Rename them so the synthetic
      // match by first/last lines up — beforeAll seeds them as
      // ('B', 'Parent'); for this test we update to Ashley/Tromsness.
      await prisma.$executeRawUnsafe(
        `UPDATE platform.iam_person SET first_name = 'Ashley', last_name = 'Tromsness'
         WHERE id = $1::uuid`,
        userBPersonId,
      );

      const code = (
        await controller.inviteGuardian(reqA(), {
          firstName: 'Ashley',
          lastName: 'Tromsness',
        })
      ).code;
      const result = await controller.accept(reqB(), { code });
      if (result.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');

      // Family now has Adam + real Ashley only — synthetic shadow
      // family_members row was dropped in the accept tx.
      const memberRows = await prisma.familyMember.findMany({
        where: { familyId: result.family.id },
        orderBy: { joinedAt: 'asc' },
        select: { id: true, personId: true, status: true },
      });
      expect(memberRows.length).toBe(2);
      const personIds = memberRows.map((r) => r.personId);
      expect(personIds).toContain(userBPersonId);
      expect(personIds).not.toContain(shadowPersonId);

      // Shadow iam_person + platform_users are intentionally left
      // as orphans — verify they survive the accept (cleanup belongs
      // to a separate maintenance job).
      const shadowStillExists = await prisma.iamPerson.findUnique({
        where: { id: shadowPersonId },
      });
      expect(shadowStillExists).not.toBeNull();

      // Restore userB's iam_person name so the other tests in this
      // describe block don't see Ashley leaking. beforeEach wipes
      // family_members + invitations but not iam_person.
      await prisma.$executeRawUnsafe(
        `UPDATE platform.iam_person SET first_name = 'B', last_name = 'Parent'
         WHERE id = $1::uuid`,
        userBPersonId,
      );
      // And drop the shadow + its account so the orphan doesn't
      // collide with subsequent re-runs (UNIQUE email).
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_users WHERE person_id = $1::uuid`,
        shadowPersonId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
        shadowPersonId,
      );
    });

    it('claims an existing PLACEHOLDER member instead of inserting a duplicate', async () => {
      // user A names "Ashley" via /family/members POST (placeholder
      // row, person_id NULL), then issues an OPEN guardian-invite
      // code (no familyMemberId metadata). user B accepts.
      //
      // Without the placeholder-claim fix, the open-invite accept
      // would INSERT a fresh ACTIVE row → /family renders Ashley
      // twice (once for the placeholder, once for the new ACTIVE
      // row). With the fix, the accept matches the placeholder by
      // first_name + last_name and promotes it in place.
      await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      await controller.addMember(reqA(), {
        firstName: 'Ashley',
        lastName: 'Smith',
        email: 'ashley@example.test',
      });
      const code = (
        await controller.inviteGuardian(reqA(), {
          firstName: 'Ashley',
          lastName: 'Smith',
        })
      ).code;

      const result = await controller.accept(reqB(), { code });
      if (result.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');

      const memberRows = await prisma.familyMember.findMany({
        where: { familyId: result.family.id },
        select: { id: true, personId: true, status: true, firstName: true },
      });
      // Two rows would mean: A's own HEAD row + Ashley's placeholder
      // + Ashley's promoted ACTIVE. The fix collapses placeholder +
      // ACTIVE into a single row → total = 2.
      expect(memberRows.length).toBe(2);
      const ashleyRows = memberRows.filter(
        (r) => r.firstName === 'Ashley' || r.personId === userBPersonId,
      );
      expect(ashleyRows.length).toBe(1);
      expect(ashleyRows[0]!.personId).toBe(userBPersonId);
      expect(ashleyRows[0]!.status).toBe('ACTIVE');
    });
  });

  // ─── Co-guardian shared MANAGED access ─────────────────────

  describe('co-guardian MANAGED access', () => {
    it('a co-guardian sees children managed by another guardian as MANAGED, not INDEPENDENT', async () => {
      // Adam (userA) creates a child via createChildAccount — the
      // resulting platform_users row's managed_by_person_id = Adam.
      // Then Ashley (userB) accepts a GUARDIAN_INVITE and lands in
      // Adam's family.
      //
      // Pre-fix Ashley's GET /family/children showed the child as
      // INDEPENDENT because computeAccessLevel only matched
      // managed_by against Ashley's OWN personId. Post-fix, the
      // guardian-set includes Adam's id too, so Ashley sees MANAGED.
      const placeholder = await controller.create(reqA(), {
        firstName: 'Junior',
        lastName: 'A',
      });
      const linked = await controller.createAccount(reqA(), placeholder.id, {
        dateOfBirth: '2014-03-03',
        gender: 'F',
      });
      expect(linked.accessLevel).toBe('MANAGED');

      const code = (await controller.inviteGuardian(reqA(), {})).code;
      const accept = await controller.accept(reqB(), { code });
      if (accept.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');

      const ashleyView = await controller.list(reqB());
      const fromAshleyView = ashleyView.find((c) => c.id === placeholder.id);
      expect(fromAshleyView?.accessLevel).toBe('MANAGED');
    });

    it('activates the PARENT persona for a guardian-invite accepter', async () => {
      // Bug 3 / the "Set up your profile" pill issue: Ashley accepts
      // an invite, the family has a LINKED child (so the PARENT
      // condition is met), and refreshPersonaCacheSafe writes the
      // platform_personas row. Verifies the cache is populated
      // before /auth/me is called.
      const placeholder = await controller.create(reqA(), {
        firstName: 'Junior',
        lastName: 'A',
      });
      await controller.createAccount(reqA(), placeholder.id, {
        dateOfBirth: '2014-03-03',
        gender: 'F',
      });

      const code = (await controller.inviteGuardian(reqA(), {})).code;
      await controller.accept(reqB(), { code });

      const personas = await prisma.platformPersona.findMany({
        where: { personId: userBPersonId, isActive: true },
        select: { type: true },
      });
      expect(personas.map((p) => p.type)).toContain('PARENT');
    });
  });

  // ─── LINKED-child edit — sync iam_person + family_children ──

  describe('update — LINKED child', () => {
    it('writes name + DOB + middleName + preferredName + notes to iam_person and mirrors to family_children', async () => {
      // Use createChildAccount so the LINKED row is MANAGED — the
      // dual-table write path is gated on access level. The
      // FAMILY_INVITE / accept flow produces an INDEPENDENT row and
      // is covered by its own 403 spec above.
      const placeholder = await controller.create(reqA(), {
        firstName: 'Original',
        lastName: 'Surname',
      });
      const linked = await controller.createAccount(reqA(), placeholder.id, {
        dateOfBirth: '2014-03-03',
        gender: 'F',
      });
      const linkedChildId = linked.id;
      const linkedPersonId = linked.personId!;

      const updated = await controller.update(reqA(), linkedChildId, {
        firstName: 'Renamed',
        lastName: 'Surname',
        middleName: 'Middle',
        preferredName: 'Nick',
        dateOfBirth: '2010-04-12',
        primaryPhone: '+1-555-0100',
        notes: 'allergic to peanuts',
      });
      // The GET response now joins iam_person, so every field the
      // parent edited round-trips on the wire. The form's useEffect
      // re-seeds from this DTO after every save — anything missing
      // here silently vanishes from the inputs.
      expect(updated.firstName).toBe('Renamed');
      expect(updated.lastName).toBe('Surname');
      expect(updated.middleName).toBe('Middle');
      expect(updated.preferredName).toBe('Nick');
      expect(updated.dateOfBirth).toBe('2010-04-12');
      expect(updated.primaryPhone).toBe('+1-555-0100');
      expect(updated.notes).toBe('allergic to peanuts');

      // iam_person carries the full set of identity fields. (The
      // managed minor's iam_person was created by createChildAccount
      // above; userBPersonId from the older FAMILY_INVITE variant
      // doesn't apply here.)
      const person = await prisma.iamPerson.findUnique({
        where: { id: linkedPersonId },
        select: {
          firstName: true,
          middleName: true,
          lastName: true,
          preferredName: true,
          primaryPhone: true,
          notes: true,
          dateOfBirth: true,
        },
      });
      expect(person?.firstName).toBe('Renamed');
      expect(person?.middleName).toBe('Middle');
      expect(person?.lastName).toBe('Surname');
      expect(person?.preferredName).toBe('Nick');
      expect(person?.primaryPhone).toBe('+1-555-0100');
      expect(person?.notes).toBe('allergic to peanuts');
      // ISO date stored as 2010-04-12T00:00:00.000Z.
      expect(person?.dateOfBirth?.toISOString().slice(0, 10)).toBe('2010-04-12');
    });

    it('PLACEHOLDER children still edit family_children directly and skip iam_person writes', async () => {
      const child = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      const updated = await controller.update(reqA(), child.id, {
        firstName: 'Sofie',
        lastName: 'Edited',
      });
      expect(updated.firstName).toBe('Sofie');
      expect(updated.lastName).toBe('Edited');
      expect(updated.personId).toBeNull();
    });

    it('PLACEHOLDER row stores + returns middleName + preferredName on create', async () => {
      const child = await controller.create(reqA(), {
        firstName: 'Alivia',
        middleName: 'Rae',
        lastName: 'A',
        preferredName: 'Liv',
      });
      expect(child.firstName).toBe('Alivia');
      expect(child.middleName).toBe('Rae');
      expect(child.lastName).toBe('A');
      expect(child.preferredName).toBe('Liv');

      // Refetch via the list endpoint to confirm the columns persist
      // (not just the synchronous post-insert response).
      const list = await controller.list(reqA());
      const found = list.find((c) => c.id === child.id);
      expect(found?.middleName).toBe('Rae');
      expect(found?.preferredName).toBe('Liv');
    });

    it('PLACEHOLDER row updates middleName + preferredName via PATCH', async () => {
      const child = await controller.create(reqA(), { firstName: 'Alivia', lastName: 'A' });
      const updated = await controller.update(reqA(), child.id, {
        middleName: 'Rae',
        preferredName: 'Liv',
      });
      expect(updated.middleName).toBe('Rae');
      expect(updated.preferredName).toBe('Liv');
    });
  });

  // ─── Placeholder guardian members ─────────────────────────

  describe('placeholder guardian members', () => {
    it('addMember inserts a PLACEHOLDER row with person_id NULL + name/email', async () => {
      const m = await controller.addMember(reqA(), {
        firstName: 'Jane',
        lastName: 'A',
        email: 'jane@example.invalid',
      });
      expect(m.status).toBe('PLACEHOLDER');
      expect(m.personId).toBeNull();
      expect(m.firstName).toBe('Jane');
      expect(m.lastName).toBe('A');
      expect(m.email).toBe('jane@example.invalid');
      expect(m.memberRole).toBe('PARENT');
      expect(m.isPrimaryContact).toBe(false);
    });

    it('getFamily surfaces placeholder + active members together', async () => {
      const placeholder = await controller.addMember(reqA(), {
        firstName: 'Jane',
        lastName: 'A',
      });
      const view = await controller.getFamily(reqA());
      expect(view).not.toBeNull();
      const ids = view!.members.map((m) => m.id).sort();
      expect(ids).toContain(placeholder.id);
      const activeRow = view!.members.find((m) => m.status === 'ACTIVE');
      expect(activeRow?.isCurrentUser).toBe(true);
    });

    it('updateMember edits placeholder fields; ACTIVE INDEPENDENT rejects with 403', async () => {
      const m = await controller.addMember(reqA(), { firstName: 'Jane', lastName: 'A' });
      const patched = await controller.updateMember(reqA(), m.id, {
        firstName: 'Janet',
        email: 'janet@example.invalid',
      });
      expect(patched.firstName).toBe('Janet');
      expect(patched.email).toBe('janet@example.invalid');

      // The caller's own ACTIVE row has managed_by_person_id NULL
      // (their account was inserted directly by the fixture, not
      // via createMemberAccount). From their own viewpoint that
      // resolves to INDEPENDENT → 403. The matching MANAGED-reject
      // (400, "edit via /profile") path is covered by a separate
      // spec below.
      const view = await controller.getFamily(reqA());
      const activeRow = view!.members.find((mm) => mm.status === 'ACTIVE');
      await expect(
        controller.updateMember(reqA(), activeRow!.id, { firstName: 'Hacked' }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('removeMember deletes PLACEHOLDER; ACTIVE rejects', async () => {
      const m = await controller.addMember(reqA(), { firstName: 'Jane', lastName: 'A' });
      await controller.removeMember(reqA(), m.id);
      const view = await controller.getFamily(reqA());
      expect(view!.members.find((mm) => mm.id === m.id)).toBeUndefined();

      const active = view!.members.find((mm) => mm.status === 'ACTIVE');
      await expect(controller.removeMember(reqA(), active!.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('createAccountForMember provisions iam_person + platform_users + ACTIVE the row', async () => {
      const m = await controller.addMember(reqA(), {
        firstName: 'Jane',
        lastName: 'A',
        email: 'jane@example.invalid',
      });
      const promoted = await controller.createMemberAccount(reqA(), m.id, {
        dateOfBirth: '1986-07-07',
        gender: 'F',
      });
      expect(promoted.status).toBe('ACTIVE');
      expect(promoted.personId).toBeTruthy();
      // The new iam_person carries the placeholder's name.
      const person = await prisma.iamPerson.findUnique({
        where: { id: promoted.personId! },
        select: { firstName: true, lastName: true, personType: true },
      });
      expect(person?.firstName).toBe('Jane');
      expect(person?.lastName).toBe('A');
      expect(person?.personType).toBe('GUARDIAN');
      // platform_users row exists and uses the provided email.
      const accountRows = await prisma.$queryRawUnsafe<Array<{ email: string }>>(
        `SELECT email FROM platform.platform_users WHERE person_id = $1::uuid`,
        promoted.personId!,
      );
      expect(accountRows[0]?.email).toBe('jane@example.invalid');
    });

    it('sendMemberInvite flips PLACEHOLDER → PENDING_INVITE + creates a targeted GUARDIAN_INVITE', async () => {
      const m = await controller.addMember(reqA(), { firstName: 'Jane', lastName: 'A' });
      const sent = await controller.sendMemberInvite(reqA(), m.id, {
        email: 'jane@example.invalid',
      });
      expect(sent.status).toBe('PENDING_INVITE');
      expect(sent.inviteCode).toMatch(/^[A-Z0-9]{8}$/);

      const inv = await prisma.platformInvitation.findUnique({
        where: { token: sent.inviteCode! },
        select: { type: true, status: true, metadata: true, targetEmail: true },
      });
      expect(inv?.type).toBe('GUARDIAN_INVITE');
      expect(inv?.status).toBe('PENDING');
      expect(inv?.targetEmail).toBe('jane@example.invalid');
      expect((inv?.metadata as { familyMemberId?: string }).familyMemberId).toBe(m.id);
    });

    it('accepting a targeted GUARDIAN_INVITE promotes the placeholder row in place', async () => {
      const m = await controller.addMember(reqA(), { firstName: 'Jane', lastName: 'A' });
      const sent = await controller.sendMemberInvite(reqA(), m.id, {});
      const result = await controller.accept(reqB(), { code: sent.inviteCode! });
      if (result.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');

      // The original placeholder row got person_id stamped + ACTIVE.
      const refetched = await prisma.familyMember.findUnique({ where: { id: m.id } });
      expect(refetched?.personId).toBe(userBPersonId);
      expect(refetched?.status).toBe('ACTIVE');
      expect(refetched?.inviteCode).toBeNull();

      // No new row inserted — the same id is the canonical one.
      const dupRows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        `SELECT COUNT(*)::bigint AS cnt FROM platform.platform_family_members
         WHERE person_id = $1::uuid`,
        userBPersonId,
      );
      expect(Number(dupRows[0]!.cnt)).toBe(1);
    });
  });

  // ─── Child profile sections — parent-only enforcement ──────

  describe('child profile sections (medical / emergency / dietary)', () => {
    async function linkedChild(): Promise<string> {
      // Build a MANAGED LINKED child of user A so the parent-only
      // endpoints have a target to attach to.
      const placeholder = await controller.create(reqA(), {
        firstName: 'Sectioned',
        lastName: 'Child',
      });
      const linked = await controller.createAccount(reqA(), placeholder.id, {
        dateOfBirth: '2014-03-03',
        gender: 'F',
      });
      return linked.id;
    }

    it('PLACEHOLDER child → all section endpoints reject with 400', async () => {
      const c = await controller.create(reqA(), { firstName: 'Sofia', lastName: 'A' });
      await expect(controller.getMedical(reqA(), c.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        controller.updateMedical(reqA(), c.id, { medicalNotes: 'Test' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(controller.listEmergencyContacts(reqA(), c.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(controller.getDietary(reqA(), c.id)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cross-family caller → 404 on every section endpoint', async () => {
      const childId = await linkedChild();
      await expect(controller.getMedical(reqB(), childId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.listEmergencyContacts(reqB(), childId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.getDietary(reqB(), childId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('LINKED parent path: medical / emergency / dietary upsert round-trip', async () => {
      const childId = await linkedChild();

      // Medical: blank initial, upsert, refetch.
      const initialMedical = await controller.getMedical(reqA(), childId);
      expect(initialMedical.allergies).toEqual([]);
      expect(initialMedical.doctorName).toBeNull();

      // medicalSource: 'CUSTOM' is required to override the per-child
      // doctor/insurance — in 'FAMILY' mode (the default) those fields
      // inherit from platform_families and the read path shadows the
      // per-child columns. This mirrors the web client, which flips to
      // CUSTOM before sending any doctor/insurance override.
      const updatedMedical = await controller.updateMedical(reqA(), childId, {
        medicalSource: 'CUSTOM',
        allergies: [{ name: 'Peanuts', severity: 'SEVERE', type: 'FOOD' }],
        doctorName: 'Dr. Sarah Johnson',
        doctorPhone: '+1-316-555-0100',
        bloodType: 'A+',
        medicalNotes: 'Carries inhaler at all times.',
      });
      expect(updatedMedical.allergies).toHaveLength(1);
      expect(updatedMedical.allergies[0]!.name).toBe('Peanuts');
      expect(updatedMedical.doctorName).toBe('Dr. Sarah Johnson');
      expect(updatedMedical.bloodType).toBe('A+');
      expect(updatedMedical.medicalNotes).toBe('Carries inhaler at all times.');

      // Emergency contacts: add → list → remove.
      const added = await controller.addEmergencyContact(reqA(), childId, {
        name: 'Jane Tromsness',
        relationship: 'Spouse',
        phonePrimary: '+1-316-555-0101',
        authorizedPickup: true,
      });
      expect(added.name).toBe('Jane Tromsness');
      const list = await controller.listEmergencyContacts(reqA(), childId);
      expect(list).toHaveLength(1);
      expect(list[0]!.authorizedPickup).toBe(true);

      // UNIQUE (person_id, phone_primary) → 409 on duplicate phone.
      await expect(
        controller.addEmergencyContact(reqA(), childId, {
          name: 'Same Phone',
          relationship: 'Other',
          phonePrimary: '+1-316-555-0101',
        }),
      ).rejects.toMatchObject({ status: 409 });

      await controller.removeEmergencyContact(reqA(), childId, added.id);
      const afterRemove = await controller.listEmergencyContacts(reqA(), childId);
      expect(afterRemove).toHaveLength(0);

      // Dietary: default NONE, upsert.
      const initialDietary = await controller.getDietary(reqA(), childId);
      expect(initialDietary.dietaryType).toBe('NONE');
      const updatedDietary = await controller.updateDietary(reqA(), childId, {
        dietaryType: 'VEGETARIAN',
        additionalRestrictions: 'No mushrooms.',
      });
      expect(updatedDietary.dietaryType).toBe('VEGETARIAN');
      expect(updatedDietary.additionalRestrictions).toBe('No mushrooms.');
    });
  });

  // ─── DTO validation — ValidationPipe round-trip ───────────

  describe('DTO validation', () => {
    /**
     * Production hit a "property preferences should not exist"
     * 400 on PATCH /family/contact-preferences because the DTO's
     * `preferences` field carried only @ApiProperty (Swagger
     * metadata) — class-validator only whitelists a property when
     * it has at least one class-validator decorator, and the global
     * ValidationPipe runs with `forbidNonWhitelisted: true`.
     *
     * This test wires up the same pipe configuration as main.ts and
     * runs a valid payload through it. A regression that removes
     * the @IsArray / @ValidateNested decorators (or other
     * whitelist-establishing markers) will fail this test before
     * it ships.
     */
    it('UpdateFamilyContactPreferencesDto passes the global ValidationPipe whitelist', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      const payload = {
        preferences: [
          { category: 'GENERAL', primaryPersonId: generateId() },
          { category: 'BILLING_FINANCIAL', primaryPersonId: generateId() },
        ],
      };
      const result = await pipe.transform(payload, {
        type: 'body',
        metatype: UpdateFamilyContactPreferencesDto,
      });
      expect(result).toBeInstanceOf(UpdateFamilyContactPreferencesDto);
      expect(result.preferences).toHaveLength(2);
      expect(result.preferences[0]!.category).toBe('GENERAL');
    });

    it('rejects an unknown sibling property', async () => {
      const pipe = new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      });
      await expect(
        pipe.transform(
          { preferences: [], stray: 'value' },
          { type: 'body', metatype: UpdateFamilyContactPreferencesDto },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── Change primary guardian (spec STEP 6) ─────────────────

  describe('change primary guardian', () => {
    const families = () => new FamiliesController(service);

    // A creates the family (→ HEAD_OF_HOUSEHOLD + primary). A invites a
    // guardian; B accepts → B is an ACTIVE, non-primary guardian. Returns
    // the family id both share.
    async function familyWithTwoGuardians(): Promise<string> {
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      const accept = await controller.accept(reqB(), { code });
      if (accept.kind !== 'GUARDIAN') throw new Error('expected GUARDIAN result');
      const view = await controller.getFamily(reqA());
      return view!.family.id;
    }

    function primaryPersonId(view: Awaited<ReturnType<typeof controller.getFamily>>): string | null {
      const primaries = (view?.members ?? []).filter((m) => m.isPrimaryContact);
      // Invariant: never more than one primary.
      expect(primaries.length).toBeLessThanOrEqual(1);
      return primaries[0]?.personId ?? null;
    }

    it('setting B primary clears A; exactly one primary remains', async () => {
      const familyId = await familyWithTwoGuardians();
      // A starts primary (family creator).
      expect(primaryPersonId(await controller.getFamily(reqA()))).toBe(userAPersonId);

      const result = await families().setPrimaryGuardian(reqA(), familyId, {
        guardianPersonId: userBPersonId,
      });
      // Star moved to B, A demoted, still exactly one.
      expect(primaryPersonId(result)).toBe(userBPersonId);
      expect(primaryPersonId(await controller.getFamily(reqA()))).toBe(userBPersonId);
    });

    it('targeting a pending invite (not an active guardian) → 400', async () => {
      // A invites but nobody accepts → a PENDING_INVITE member with a
      // person_id that isn't an ACTIVE guardian of the family.
      const placeholder = await controller.addMember(reqA(), { firstName: 'Pend', lastName: 'A' });
      await controller.sendMemberInvite(reqA(), placeholder.id, {});
      const view = await controller.getFamily(reqA());
      const familyId = view!.family.id;
      // A pending invite has no linked person_id, so target by a
      // non-active person id (userB, who never joined this family).
      await expect(
        families().setPrimaryGuardian(reqA(), familyId, { guardianPersonId: userBPersonId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // A is still the only primary — nothing changed.
      expect(primaryPersonId(await controller.getFamily(reqA()))).toBe(userAPersonId);
    });

    it('cross-family caller → 404 (cannot reassign another family’s primary)', async () => {
      const familyId = await familyWithTwoGuardians();
      // userB is a member here, but a brand-new unrelated person is not.
      const outsiderPerson = generateId();
      const outsiderAccount = generateId();
      await prisma.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Out', 'Sider', 'GUARDIAN', true) ON CONFLICT (id) DO NOTHING`,
        outsiderPerson,
      );
      try {
        await expect(
          families().setPrimaryGuardian(reqFor(outsiderPerson, outsiderAccount), familyId, {
            guardianPersonId: userBPersonId,
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
          outsiderPerson,
        );
      }
    });

    it('reassigning primary does NOT change edit rights / guardianship', async () => {
      const familyId = await familyWithTwoGuardians();
      // Both A and B are active guardians of the family before…
      const before = await controller.getFamily(reqA());
      const aRoleBefore = before!.members.find((m) => m.personId === userAPersonId)?.memberRole;
      const bRoleBefore = before!.members.find((m) => m.personId === userBPersonId)?.memberRole;

      await families().setPrimaryGuardian(reqA(), familyId, { guardianPersonId: userBPersonId });

      const after = await controller.getFamily(reqA());
      // Member roles (the guardianship signal) are unchanged for both —
      // only is_primary_contact moved.
      expect(after!.members.find((m) => m.personId === userAPersonId)?.memberRole).toBe(
        aRoleBefore,
      );
      expect(after!.members.find((m) => m.personId === userBPersonId)?.memberRole).toBe(
        bRoleBefore,
      );
      // A is still a guardian (still present, ACTIVE) after losing primary.
      const aAfter = after!.members.find((m) => m.personId === userAPersonId);
      expect(aAfter?.status).toBe('ACTIVE');
      expect(aAfter?.isPrimaryContact).toBe(false);
    });
  });
});
