import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { FamilyChildrenService } from '@modules/m00-platform/households/family-children.service';
import { FamilyChildrenController } from '@modules/m00-platform/households/family-children.controller';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
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
    // Wipe each user's family children + family between tests so order
    // doesn't matter and `ensureFamilyForPerson` re-creates the family.
    for (const personId of [userAPersonId, userBPersonId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_invitations WHERE inviter_person_id = $1::uuid`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_children WHERE family_id IN
           (SELECT family_id FROM platform.platform_family_members WHERE person_id = $1::uuid)`,
        personId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM platform.platform_family_members WHERE person_id = $1::uuid`,
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

  it('patch LINKED child writes to iam_person and mirrors to family_children', async () => {
    // Promote a placeholder to LINKED directly, then exercise the
    // dual-table write path. The dedicated test suite for the full
    // GUARDIAN_INVITE → LINKED happy-path lives in "update — LINKED
    // child" at the bottom of this file.
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

    const updated = await controller.update(reqA(), c.id, { firstName: 'Sophie' });
    expect(updated.firstName).toBe('Sophie');
    const person = await prisma.iamPerson.findUnique({
      where: { id: linkedPersonId },
      select: { firstName: true },
    });
    expect(person?.firstName).toBe('Sophie');

    // Unlink before deleting the iam_person row — the FK from
    // platform_family_children would otherwise block cleanup.
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

    it('refuses a caller already in a family with a 400', async () => {
      // user B is HoH of their own family — registration normally
      // creates one; for the test, lazy-create by adding a placeholder.
      await controller.create(reqB(), { firstName: 'B', lastName: 'Child' });
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      await expect(controller.accept(reqB(), { code })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses the inviter accepting their own GUARDIAN_INVITE', async () => {
      const code = (await controller.inviteGuardian(reqA(), {})).code;
      await expect(controller.accept(reqA(), { code })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // ─── LINKED-child edit — sync iam_person + family_children ──

  describe('update — LINKED child', () => {
    it('writes name + DOB + middleName + preferredName + notes to iam_person and mirrors to family_children', async () => {
      // Create the LINKED row via FAMILY_INVITE so iam_person exists.
      const code = (await controller.generateCode(reqA())).code;
      const acceptResult = await controller.accept(reqB(), { code });
      if (acceptResult.kind !== 'CHILD') throw new Error('expected CHILD result');
      const linkedChildId = acceptResult.child.id;

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

      // iam_person carries the full set of identity fields.
      const person = await prisma.iamPerson.findUnique({
        where: { id: userBPersonId },
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
  });
});
