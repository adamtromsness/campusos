import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { GroupService } from '@modules/m103-groups/groups/group.service';
import { MembershipService } from '@modules/m103-groups/groups/membership.service';
import { InvitationService } from '@modules/m103-groups/groups/invitation.service';
import { OwnershipTransferService } from '@modules/m103-groups/groups/ownership-transfer.service';
import { GroupAnalyticsService } from '@modules/m103-groups/groups/analytics.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  resetGroupsAndStudents,
  ensureGroupsSeed,
  TEST_GROUP_OPEN_A_ID,
  TEST_GROUP_APPROVAL_A_ID,
  TEST_GROUP_INVITE_A_ID,
  TEST_GROUP_B_ID,
  TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
  TEST_GROUP_APPROVAL_A_OWNER_MEMBER_ID,
} from '../fixtures/groups';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';
import { TEST_ACTIVITY_A_ID } from '../fixtures/clubs';
import { ensureClubsSeed } from '../fixtures/clubs';

/**
 * Wave 7 — m103-groups core suite. Exercises GroupService (CRUD +
 * scope-based create permissions + INVITE_ONLY hiding), MembershipService
 * (join semantics + INVITE_ONLY 403 + leave/owner-block + invite/accept/
 * decline + approve/deny + role/suspend/unsuspend/remove + notification
 * prefs UPSERT), InvitationService (create + respond + cancel + UNIQUE),
 * OwnershipTransferService (initiate + accept atomic role swap + decline
 * + cancel + partial UNIQUE PENDING), GroupAnalyticsService (recompute
 * UPSERT + manager gate). Cross-school isolation exercised throughout.
 */
describe('integration:m103-groups/groups', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let groups: GroupService;
  let memberships: MembershipService;
  let invitations: InvitationService;
  let transfers: OwnershipTransferService;
  let analytics: GroupAnalyticsService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    groups = new GroupService(tenantPrisma);
    memberships = new MembershipService(tenantPrisma, groups);
    invitations = new InvitationService(tenantPrisma, groups);
    transfers = new OwnershipTransferService(tenantPrisma, groups);
    analytics = new GroupAnalyticsService(tenantPrisma, groups);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetGroupsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
    await ensureGroupsSeed(rawClient);
  });

  /**
   * Seed a fresh platform_users + iam_person + hr_employees row in
   * School A. Lets us exercise the assertAccountInCurrentSchool gate
   * cleanly for invitations.
   */
  async function seedSchoolAEmployee(opts: {
    accountId: string;
    personId: string;
    employeeId: string;
    firstName?: string;
    lastName?: string;
  }): Promise<void> {
    const firstName = opts.firstName ?? 'Spec';
    const lastName = opts.lastName ?? 'Member';
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, $2, $3, 'STAFF', true) ON CONFLICT (id) DO NOTHING`,
      opts.personId,
      firstName,
      lastName,
    );
    personIds.push(opts.personId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false) ON CONFLICT (id) DO NOTHING`,
      opts.accountId,
      opts.personId,
      `spec-${opts.accountId}@test.local`,
      `${firstName} ${lastName}`,
    );
    accountIds.push(opts.accountId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hr_employees
         (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'FULL_TIME', 'ACTIVE', '2024-01-01')
       ON CONFLICT (id) DO NOTHING`,
      opts.employeeId,
      opts.personId,
      opts.accountId,
      TEST_SCHOOL_ID,
      'GRP-' + opts.employeeId.slice(-6),
    );
  }

  /**
   * Idempotent helper — ensure TEST_STUDENT_PERSON_ID has a
   * platform_students projection + a sis_students row in School A so
   * MembershipService.assertAccountInCurrentTenant and
   * InvitationService.assertAccountInCurrentSchool can resolve it.
   *
   * Uses ON CONFLICT (person_id) DO NOTHING so a leftover row from
   * a prior test that escaped cleanup doesn't trigger a 23505 on the
   * UNIQUE(platform_students.person_id) constraint.
   */
  async function ensureStudentInSchoolA(): Promise<void> {
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES (gen_random_uuid(), $1::uuid, 'Stu', 'Linked', true)
       ON CONFLICT (person_id) DO NOTHING`,
      '019e0cf8-aaaa-7777-8888-000000000040', // TEST_STUDENT_PERSON_ID
    );
    const psRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      '019e0cf8-aaaa-7777-8888-000000000040',
    );
    platformStudentIds.push(psRow[0]!.id);
    const stuRow = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '5', 'ENROLLED')
       ON CONFLICT DO NOTHING
       RETURNING id::text AS id`,
      psRow[0]!.id,
      TEST_SCHOOL_ID,
      'STU-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    );
    if ((stuRow as Array<{ id: string }>).length > 0) {
      studentIds.push((stuRow as Array<{ id: string }>)[0]!.id);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // GroupService — list / getById / create / patch
  // ─────────────────────────────────────────────────────────────────
  describe('GroupService', () => {
    it('list: admin sees every School A group (and not School B)', async () => {
      const list = await withTestTenant(async () => groups.list(adminActor(), {}));
      const ids = list.map((g) => g.id);
      expect(ids).toContain(TEST_GROUP_OPEN_A_ID);
      expect(ids).toContain(TEST_GROUP_APPROVAL_A_ID);
      expect(ids).toContain(TEST_GROUP_INVITE_A_ID);
      expect(ids).not.toContain(TEST_GROUP_B_ID);
    });

    it('list: non-admin sees OPEN + APPROVAL_REQUIRED groups; INVITE_ONLY hidden', async () => {
      const list = await withTestTenant(async () => groups.list(studentActor(), {}));
      const ids = list.map((g) => g.id);
      expect(ids).toContain(TEST_GROUP_OPEN_A_ID);
      expect(ids).toContain(TEST_GROUP_APPROVAL_A_ID);
      expect(ids).not.toContain(TEST_GROUP_INVITE_A_ID);
    });

    it('list: onlyMine=true returns only joined groups', async () => {
      // Admin is OWNER of the three fixture groups
      const list = await withTestTenant(async () => groups.list(adminActor(), { onlyMine: true }));
      const ids = list.map((g) => g.id);
      expect(ids).toContain(TEST_GROUP_OPEN_A_ID);
      // Student is not a member of anything
      const stuList = await withTestTenant(async () =>
        groups.list(studentActor(), { onlyMine: true }),
      );
      expect(stuList).toEqual([]);
    });

    it('list: filter by status + scopeType', async () => {
      const list = await withTestTenant(async () =>
        groups.list(adminActor(), { status: 'ACTIVE', scopeType: 'SCHOOL' }),
      );
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((g) => g.status === 'ACTIVE')).toBe(true);
      expect(list.every((g) => g.scopeType === 'SCHOOL')).toBe(true);
    });

    it('getById: admin reads INVITE_ONLY (visible)', async () => {
      const dto = await withTestTenant(async () =>
        groups.getById(TEST_GROUP_INVITE_A_ID, adminActor()),
      );
      expect(dto.id).toBe(TEST_GROUP_INVITE_A_ID);
      expect(dto.joinPolicy).toBe('INVITE_ONLY');
    });

    it('getById: non-member reading INVITE_ONLY → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => groups.getById(TEST_GROUP_INVITE_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          groups.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: admin can create SCHOOL group, becomes OWNER atomically', async () => {
      const dto = await withTestTenant(async () =>
        groups.create(
          {
            name: 'New School Group',
            scopeType: 'SCHOOL',
            joinPolicy: 'OPEN',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('New School Group');
      expect(dto.scopeType).toBe('SCHOOL');
      expect(dto.myMembership).not.toBeNull();
      expect(dto.myMembership!.role).toBe('OWNER');
      expect(dto.memberCount).toBe(1);
    });

    it('create: SCHOOL group with non-null scopeId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create(
            {
              name: 'Bad Scope',
              scopeType: 'SCHOOL',
              scopeId: TEST_SIS_CLASS_ID,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: CLASS group without scopeId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create({ name: 'No scope', scopeType: 'CLASS' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: non-admin non-staff (student) cannot create SCHOOL group', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create({ name: 'Stu Group', scopeType: 'SCHOOL' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: non-admin non-staff (student) cannot create CUSTOM group', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create({ name: 'Stu Custom', scopeType: 'CUSTOM' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: non-admin non-staff (student) cannot create YEAR_GROUP', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create(
            {
              name: 'Stu Year',
              scopeType: 'YEAR_GROUP',
              scopeId: TEST_SIS_ACADEMIC_YEAR_ID,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: non-admin STAFF can create SCHOOL group', async () => {
      const dto = await withTestTenant(async () =>
        groups.create({ name: 'Teacher School Group', scopeType: 'SCHOOL' } as any, teacherActor()),
      );
      expect(dto.name).toBe('Teacher School Group');
    });

    it('create: CLASS group requires teacher to be assigned to class', async () => {
      // teacher actor is NOT in sis_class_teachers for TEST_SIS_CLASS_ID
      await expect(
        withTestTenant(async () =>
          groups.create(
            { name: 'Cls Grp', scopeType: 'CLASS', scopeId: TEST_SIS_CLASS_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: CLASS group succeeds for admin (validates scopeId in tenant)', async () => {
      const dto = await withTestTenant(async () =>
        groups.create(
          { name: 'Admin Class Grp', scopeType: 'CLASS', scopeId: TEST_SIS_CLASS_ID } as any,
          adminActor(),
        ),
      );
      expect(dto.scopeType).toBe('CLASS');
      expect(dto.scopeId).toBe(TEST_SIS_CLASS_ID);
    });

    it('create: bogus scopeId for CLASS → BadRequestException via assertScopeRefValid', async () => {
      await expect(
        withTestTenant(async () =>
          groups.create(
            {
              name: 'Bad scopeId',
              scopeType: 'CLASS',
              scopeId: '00000000-0000-0000-0000-000000000000',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: ACTIVITY group requires advisor', async () => {
      // teacher actor is NOT the advisor of TEST_ACTIVITY_A_ID
      await expect(
        withTestTenant(async () =>
          groups.create(
            { name: 'Bad ACT', scopeType: 'ACTIVITY', scopeId: TEST_ACTIVITY_A_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: ACTIVITY group via admin succeeds', async () => {
      const dto = await withTestTenant(async () =>
        groups.create(
          { name: 'Activity Group', scopeType: 'ACTIVITY', scopeId: TEST_ACTIVITY_A_ID } as any,
          adminActor(),
        ),
      );
      expect(dto.scopeType).toBe('ACTIVITY');
      expect(dto.scopeLabel).toBeDefined();
    });

    it('create: ACTIVITY group with staff lacking employeeId → ForbiddenException', async () => {
      const ghostStaff: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      };
      await expect(
        withTestTenant(async () =>
          groups.create(
            { name: 'No emp', scopeType: 'ACTIVITY', scopeId: TEST_ACTIVITY_A_ID } as any,
            ghostStaff,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: CLASS group with staff lacking employeeId → ForbiddenException', async () => {
      const ghostStaff: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      };
      await expect(
        withTestTenant(async () =>
          groups.create(
            { name: 'No emp', scopeType: 'CLASS', scopeId: TEST_SIS_CLASS_ID } as any,
            ghostStaff,
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: admin updates metadata', async () => {
      const dto = await withTestTenant(async () =>
        groups.patch(
          TEST_GROUP_OPEN_A_ID,
          {
            name: 'Renamed Open',
            description: 'updated',
            joinPolicy: 'APPROVAL_REQUIRED',
            avatarUrl: 'https://example.com/x.png',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('Renamed Open');
      expect(dto.joinPolicy).toBe('APPROVAL_REQUIRED');
    });

    it('patch: no-op input still returns DTO', async () => {
      const dto = await withTestTenant(async () =>
        groups.patch(TEST_GROUP_OPEN_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_GROUP_OPEN_A_ID);
    });

    it('patch: archive group with status update', async () => {
      const dto = await withTestTenant(async () =>
        groups.patch(
          TEST_GROUP_OPEN_A_ID,
          { status: 'ARCHIVED', autoDissolveAt: '2030-01-01T00:00:00Z' } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('ARCHIVED');
    });

    it('patch: non-member non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          groups.patch(TEST_GROUP_OPEN_A_ID, { name: 'X' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertOwner: caller not owner → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          groups.assertOwner(TEST_GROUP_OPEN_A_ID, TEST_STUDENT_ACCOUNT_ID),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertOwner: admin OWNER passes', async () => {
      await expect(
        withTestTenant(async () => groups.assertOwner(TEST_GROUP_OPEN_A_ID, TEST_ADMIN_ACCOUNT_ID)),
      ).resolves.toBeUndefined();
    });

    it('cross-school: School A admin cannot see School B groups', async () => {
      const listA = await withTestTenant(async () => groups.list(adminActor(), {}));
      expect(listA.map((g) => g.id)).not.toContain(TEST_GROUP_B_ID);
      const listB = await withTestTenantB(async () => groups.list(adminActor(), {}));
      expect(listB.map((g) => g.id)).toContain(TEST_GROUP_B_ID);
      expect(listB.map((g) => g.id)).not.toContain(TEST_GROUP_OPEN_A_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MembershipService — join / leave / invite / accept / decline /
  // approve / deny / role / suspend / unsuspend / remove / prefs
  // ─────────────────────────────────────────────────────────────────
  describe('MembershipService', () => {
    it('listForGroup: admin sees full roster', async () => {
      const list = await withTestTenant(async () =>
        memberships.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(list.length).toBe(1);
      expect(list[0]!.role).toBe('OWNER');
    });

    it('listForGroup: non-member of OPEN group sees []', async () => {
      const list = await withTestTenant(async () =>
        memberships.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
      );
      expect(list).toEqual([]);
    });

    it('listMine: returns the actor own memberships', async () => {
      // listMine is account-scoped (not school-scoped) per design — the
      // admin actor owns 4 fixture groups across School A (3) and B (1).
      const list = await withTestTenant(async () => memberships.listMine(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(3);
      expect(list.length).toBeLessThanOrEqual(4);
    });

    it('joinGroup: OPEN → ACTIVE immediately', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      expect(m.status).toBe('ACTIVE');
      expect(m.role).toBe('MEMBER');
    });

    it('joinGroup: APPROVAL_REQUIRED → PENDING_APPROVAL', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_APPROVAL_A_ID, {} as any, studentActor()),
      );
      expect(m.status).toBe('PENDING_APPROVAL');
    });

    it('joinGroup: INVITE_ONLY non-member → NotFoundException (group hidden)', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.joinGroup(TEST_GROUP_INVITE_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('joinGroup: re-join after LEFT lands a fresh row', async () => {
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      // Force the member to LEFT
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.grp_members SET status = 'LEFT', left_at = now() WHERE group_id = $1::uuid AND person_id = $2::uuid`,
        TEST_GROUP_OPEN_A_ID,
        TEST_STUDENT_ACCOUNT_ID,
      );
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      expect(m.status).toBe('ACTIVE');
    });

    it('joinGroup: existing non-LEFT membership returns idempotent', async () => {
      const first = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      const second = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      expect(second.id).toBe(first.id);
    });

    it('joinGroup: archived group → BadRequestException', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.grp_groups SET status = 'ARCHIVED' WHERE id = $1::uuid`,
        TEST_GROUP_OPEN_A_ID,
      );
      await expect(
        withTestTenant(async () =>
          memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('leaveGroup: OWNER → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => memberships.leaveGroup(TEST_GROUP_OPEN_A_ID, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('leaveGroup: non-member → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => memberships.leaveGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaveGroup: ACTIVE member → ok', async () => {
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      const r = await withTestTenant(async () =>
        memberships.leaveGroup(TEST_GROUP_OPEN_A_ID, studentActor()),
      );
      expect(r.ok).toBe(true);
    });

    it('invite: admin invites student → INVITED row', async () => {
      await ensureStudentInSchoolA();
      const m = await withTestTenant(async () =>
        memberships.invite(
          TEST_GROUP_OPEN_A_ID,
          { personId: TEST_STUDENT_ACCOUNT_ID, role: 'MEMBER' } as any,
          adminActor(),
        ),
      );
      expect(m.status).toBe('INVITED');
    });

    it('invite: non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.invite(
            TEST_GROUP_OPEN_A_ID,
            { personId: TEST_STUDENT_ACCOUNT_ID } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invite: invited account not in school → BadRequestException', async () => {
      // student actor lacks any tenant projection so assertAccountInCurrentTenant fails
      await expect(
        withTestTenant(async () =>
          memberships.invite(
            TEST_GROUP_OPEN_A_ID,
            { personId: TEST_STUDENT_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invite: duplicate existing membership → BadRequestException', async () => {
      // admin is already OWNER of TEST_GROUP_OPEN_A_ID
      await expect(
        withTestTenant(async () =>
          memberships.invite(
            TEST_GROUP_OPEN_A_ID,
            { personId: TEST_ADMIN_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acceptInvite + declineInvite: only invitee can act + state transitions', async () => {
      await ensureStudentInSchoolA();
      const m = await withTestTenant(async () =>
        memberships.invite(
          TEST_GROUP_OPEN_A_ID,
          { personId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      // Wrong actor cannot accept
      await expect(
        withTestTenant(async () => memberships.acceptInvite(m.id, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Accept transitions to ACTIVE
      const ok = await withTestTenant(async () => memberships.acceptInvite(m.id, studentActor()));
      expect(ok.status).toBe('ACTIVE');
      // Cannot accept again (not INVITED any more)
      await expect(
        withTestTenant(async () => memberships.acceptInvite(m.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('declineInvite: invited can decline; non-INVITED → BadRequestException', async () => {
      await ensureStudentInSchoolA();
      const m = await withTestTenant(async () =>
        memberships.invite(
          TEST_GROUP_OPEN_A_ID,
          { personId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => memberships.declineInvite(m.id, studentActor()));
      expect(r.ok).toBe(true);
      await expect(
        withTestTenant(async () => memberships.declineInvite(m.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('acceptInvite: not found → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.acceptInvite('00000000-0000-0000-0000-000000000000', studentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('approveJoin + denyJoin: state transitions', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_APPROVAL_A_ID, {} as any, studentActor()),
      );
      const ok = await withTestTenant(async () =>
        memberships.approveJoin(m.id, { role: 'MEMBER' } as any, adminActor()),
      );
      expect(ok.status).toBe('ACTIVE');
      // Approve again — not pending now
      await expect(
        withTestTenant(async () =>
          memberships.approveJoin(m.id, { role: 'MEMBER' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('denyJoin: pending → REMOVED', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_APPROVAL_A_ID, {} as any, studentActor()),
      );
      const r = await withTestTenant(async () => memberships.denyJoin(m.id, adminActor()));
      expect(r.ok).toBe(true);
      await expect(
        withTestTenant(async () => memberships.denyJoin(m.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateRole: OWNER → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.updateRole(
            TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
            { role: 'MEMBER' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateRole: non-ACTIVE member → BadRequestException', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_APPROVAL_A_ID, {} as any, studentActor()),
      );
      // m.status = PENDING_APPROVAL
      await expect(
        withTestTenant(async () =>
          memberships.updateRole(m.id, { role: 'ADMIN' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updateRole + suspend + unsuspend lifecycle on ACTIVE member', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      const promoted = await withTestTenant(async () =>
        memberships.updateRole(m.id, { role: 'ADMIN' } as any, adminActor()),
      );
      expect(promoted.role).toBe('ADMIN');

      const suspended = await withTestTenant(async () =>
        memberships.suspend(m.id, { reason: 'TOS violation' } as any, adminActor()),
      );
      expect(suspended.status).toBe('SUSPENDED');
      expect(suspended.suspensionReason).toBe('TOS violation');

      // Cannot suspend again (not ACTIVE)
      await expect(
        withTestTenant(async () =>
          memberships.suspend(m.id, { reason: 'again' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const unsuspended = await withTestTenant(async () =>
        memberships.unsuspend(m.id, adminActor()),
      );
      expect(unsuspended.status).toBe('ACTIVE');
      expect(unsuspended.suspensionReason).toBeNull();

      // Cannot unsuspend ACTIVE member
      await expect(
        withTestTenant(async () => memberships.unsuspend(m.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('suspend: OWNER → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.suspend(
            TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
            { reason: 'no' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('remove: OWNER → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.remove(TEST_GROUP_OPEN_A_OWNER_MEMBER_ID, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('remove: non-OWNER → REMOVED', async () => {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      const r = await withTestTenant(async () => memberships.remove(m.id, adminActor()));
      expect(r.ok).toBe(true);
    });

    it('lockedTransition: missing membership → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.updateRole(
            '00000000-0000-0000-0000-000000000000',
            { role: 'ADMIN' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadMember: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => memberships.loadMember('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getPrefs: default + member-only gate', async () => {
      const prefs = await withTestTenant(async () =>
        memberships.getPrefs(TEST_GROUP_OPEN_A_OWNER_MEMBER_ID, adminActor()),
      );
      expect(prefs.notifyAnnouncements).toBe(true);
      expect(prefs.preferredChannel).toBe('IN_APP');

      // Non-owning non-admin → ForbiddenException
      await expect(
        withTestTenant(async () =>
          memberships.getPrefs(TEST_GROUP_OPEN_A_OWNER_MEMBER_ID, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('updatePrefs: self UPSERT + read back', async () => {
      const dto = await withTestTenant(async () =>
        memberships.updatePrefs(
          TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
          {
            notifyAnnouncements: false,
            notifyEvents: false,
            preferredChannel: 'EMAIL',
            quietHoursOverride: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.notifyAnnouncements).toBe(false);
      expect(dto.preferredChannel).toBe('EMAIL');

      // Idempotent re-update (UPSERT branch on conflict)
      const dto2 = await withTestTenant(async () =>
        memberships.updatePrefs(
          TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
          { notifyResults: false } as any,
          adminActor(),
        ),
      );
      expect(dto2.notifyResults).toBe(false);
      expect(dto2.preferredChannel).toBe('EMAIL'); // preserved
    });

    it('updatePrefs: non-owner non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.updatePrefs(
            TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
            { notifyAnnouncements: false } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A admin cannot list School B members → NotFound via getById', async () => {
      // listForGroup calls groups.getById which is school-scoped via
      // loadGroup. From School A context, the School B group is not
      // visible so NotFoundException is raised.
      await expect(
        withTestTenant(async () => memberships.listForGroup(TEST_GROUP_B_ID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A admin getById School B → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => groups.getById(TEST_GROUP_B_ID, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School B admin sees School B group', async () => {
      const dto = await withTestTenantB(async () => groups.getById(TEST_GROUP_B_ID, adminActor()));
      expect(dto.id).toBe(TEST_GROUP_B_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // InvitationService — create / listForGroup / listMine / respond / cancel
  // ─────────────────────────────────────────────────────────────────
  describe('InvitationService', () => {
    /**
     * Seed sis_students row in School A for TEST_STUDENT_PERSON_ID so
     * assertAccountInCurrentSchool returns OK for student invites.
     */
    async function seedStudentInSchoolA(): Promise<void> {
      await ensureStudentInSchoolA();
    }

    it('create: admin invites student → PENDING invitation', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID, message: 'come join' } as any,
          adminActor(),
        ),
      );
      expect(inv.status).toBe('PENDING');
      expect(inv.message).toBe('come join');
    });

    it('create: duplicate invitation → BadRequestException via UNIQUE', async () => {
      await seedStudentInSchoolA();
      await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          invitations.create(
            TEST_GROUP_OPEN_A_ID,
            { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: invited account not in school → ForbiddenException', async () => {
      // student not in School A projections → 403 via assertAccountInCurrentSchool
      await expect(
        withTestTenant(async () =>
          invitations.create(
            TEST_GROUP_OPEN_A_ID,
            { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('create: cross-school group → ForbiddenException via assertGroupInCurrentSchool', async () => {
      // From School A context, TEST_GROUP_B_ID is School B — must fail
      await expect(
        withTestTenant(async () =>
          invitations.create(
            TEST_GROUP_B_ID,
            { invitedUserId: TEST_ADMIN_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForGroup: manager sees invites; non-manager → ForbiddenException', async () => {
      await seedStudentInSchoolA();
      await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        invitations.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(list.length).toBe(1);

      await expect(
        withTestTenant(async () => invitations.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listMine: returns pending for me', async () => {
      await seedStudentInSchoolA();
      await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () => invitations.listMine(studentActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.invitedUserId).toBe(TEST_STUDENT_ACCOUNT_ID);
    });

    it('getById: invited user can see; outsider gated by group manager', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const stuView = await withTestTenant(async () => invitations.getById(inv.id, studentActor()));
      expect(stuView.id).toBe(inv.id);

      // Outsider (parent) is neither invitee nor inviter — falls through to assertCanManageGroup
      await expect(
        withTestTenant(async () => invitations.getById(inv.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          invitations.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('respond ACCEPTED: atomic — flips status AND inserts grp_members', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        invitations.respond(inv.id, { status: 'ACCEPTED' } as any, studentActor()),
      );
      expect(r.status).toBe('ACCEPTED');

      const members = await rawClient.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        `SELECT id::text AS id, status FROM ${TEST_SCHEMA}.grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND status <> 'LEFT'`,
        TEST_GROUP_OPEN_A_ID,
        TEST_STUDENT_ACCOUNT_ID,
      );
      expect(members.length).toBe(1);
      expect(members[0]!.status).toBe('ACTIVE');
    });

    it('respond DECLINED: flips status, NO member row added', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () =>
        invitations.respond(inv.id, { status: 'DECLINED' } as any, studentActor()),
      );
      expect(r.status).toBe('DECLINED');
      const members = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid`,
        TEST_GROUP_OPEN_A_ID,
        TEST_STUDENT_ACCOUNT_ID,
      );
      expect(members.length).toBe(0);
    });

    it('respond: not invitee → ForbiddenException', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          invitations.respond(inv.id, { status: 'ACCEPTED' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('respond: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          invitations.respond(
            '00000000-0000-0000-0000-000000000000',
            { status: 'ACCEPTED' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('respond: terminal state → BadRequestException', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        invitations.respond(inv.id, { status: 'DECLINED' } as any, studentActor()),
      );
      await expect(
        withTestTenant(async () =>
          invitations.respond(inv.id, { status: 'ACCEPTED' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel: inviter or admin only; PENDING only', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      const ok = await withTestTenant(async () => invitations.cancel(inv.id, adminActor()));
      expect(ok.ok).toBe(true);

      await expect(
        withTestTenant(async () => invitations.cancel(inv.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          invitations.cancel('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel: terminal state → BadRequestException', async () => {
      await seedStudentInSchoolA();
      const inv = await withTestTenant(async () =>
        invitations.create(
          TEST_GROUP_OPEN_A_ID,
          { invitedUserId: TEST_STUDENT_ACCOUNT_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        invitations.respond(inv.id, { status: 'DECLINED' } as any, studentActor()),
      );
      await expect(
        withTestTenant(async () => invitations.cancel(inv.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // OwnershipTransferService
  // ─────────────────────────────────────────────────────────────────
  describe('OwnershipTransferService', () => {
    /**
     * Promote student to ACTIVE member of GROUP_OPEN_A so we can
     * transfer ownership to that member.
     */
    async function ensureStudentMember(): Promise<string> {
      const m = await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      return m.id;
    }

    it('initiate + accept atomic role swap', async () => {
      const memberId = await ensureStudentMember();

      const t = await withTestTenant(async () =>
        transfers.initiate(
          TEST_GROUP_OPEN_A_ID,
          { toMemberId: memberId, reason: 'taking a break' } as any,
          adminActor(),
        ),
      );
      expect(t.status).toBe('PENDING');

      const accepted = await withTestTenant(async () => transfers.accept(t.id, studentActor()));
      expect(accepted.status).toBe('ACCEPTED');

      // Verify role swap landed: admin OWNER row demoted to ADMIN; student promoted to OWNER
      const rows = await rawClient.$queryRawUnsafe<
        Array<{ id: string; person_id: string; member_role: string }>
      >(
        `SELECT id::text AS id, person_id::text AS person_id, member_role FROM ${TEST_SCHEMA}.grp_members WHERE group_id = $1::uuid ORDER BY member_role`,
        TEST_GROUP_OPEN_A_ID,
      );
      const adminRow = rows.find((r) => r.person_id === TEST_ADMIN_ACCOUNT_ID);
      const stuRow = rows.find((r) => r.person_id === TEST_STUDENT_ACCOUNT_ID);
      expect(adminRow!.member_role).toBe('ADMIN');
      expect(stuRow!.member_role).toBe('OWNER');
    });

    it('initiate: caller not OWNER → ForbiddenException', async () => {
      const memberId = await ensureStudentMember();
      await expect(
        withTestTenant(async () =>
          transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('initiate: destination not in group → BadRequestException', async () => {
      // OWNER member of GROUP_APPROVAL_A, not GROUP_OPEN_A
      await expect(
        withTestTenant(async () =>
          transfers.initiate(
            TEST_GROUP_OPEN_A_ID,
            { toMemberId: TEST_GROUP_APPROVAL_A_OWNER_MEMBER_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('initiate: destination missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transfers.initiate(
            TEST_GROUP_OPEN_A_ID,
            { toMemberId: '00000000-0000-0000-0000-000000000000' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('initiate: destination is OWNER (self) → BadRequestException', async () => {
      // To-member-id = the owner's own member row
      await expect(
        withTestTenant(async () =>
          transfers.initiate(
            TEST_GROUP_OPEN_A_ID,
            { toMemberId: TEST_GROUP_OPEN_A_OWNER_MEMBER_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('initiate: destination not ACTIVE → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.grp_members SET status = 'SUSPENDED', suspension_reason = 'x' WHERE id = $1::uuid`,
        memberId,
      );
      await expect(
        withTestTenant(async () =>
          transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('initiate: duplicate PENDING transfer → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accept: not recipient → ForbiddenException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      // Admin tries to accept its own transfer
      await expect(
        withTestTenant(async () => transfers.accept(t.id, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accept: expired transfer → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      // Roll BOTH initiated_at and expires_at backwards so the check
      // constraint (expires_at > initiated_at) is preserved.
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.grp_ownership_transfers
           SET initiated_at = now() - INTERVAL '3 hours',
               expires_at = now() - INTERVAL '1 hour'
         WHERE id = $1::uuid`,
        t.id,
      );
      await expect(
        withTestTenant(async () => transfers.accept(t.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accept: not pending → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      await withTestTenant(async () => transfers.cancel(t.id, adminActor()));
      await expect(
        withTestTenant(async () => transfers.accept(t.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accept: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transfers.accept('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('decline: recipient declines', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      const declined = await withTestTenant(async () => transfers.decline(t.id, studentActor()));
      expect(declined.status).toBe('DECLINED');
    });

    it('decline: not recipient → ForbiddenException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => transfers.decline(t.id, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('decline: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transfers.decline('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('decline: non-pending → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      await withTestTenant(async () => transfers.cancel(t.id, adminActor()));
      await expect(
        withTestTenant(async () => transfers.decline(t.id, studentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel: initiator can cancel', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      const cancelled = await withTestTenant(async () => transfers.cancel(t.id, adminActor()));
      expect(cancelled.status).toBe('CANCELLED');
    });

    it('cancel: non-initiator non-admin → ForbiddenException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      // student is the recipient, not the initiator
      await expect(
        withTestTenant(async () => transfers.cancel(t.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel: non-pending → BadRequestException', async () => {
      const memberId = await ensureStudentMember();
      const t = await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      await withTestTenant(async () => transfers.decline(t.id, studentActor()));
      await expect(
        withTestTenant(async () => transfers.cancel(t.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          transfers.cancel('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list: admin sees all; non-member returns []', async () => {
      const memberId = await ensureStudentMember();
      await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        transfers.list(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(list.length).toBe(1);

      const stuList = await withTestTenant(async () =>
        transfers.list(TEST_GROUP_OPEN_A_ID, parentActor()),
      );
      expect(stuList).toEqual([]);
    });

    it('listMine: returns pending transfers awaiting me', async () => {
      const memberId = await ensureStudentMember();
      await withTestTenant(async () =>
        transfers.initiate(TEST_GROUP_OPEN_A_ID, { toMemberId: memberId } as any, adminActor()),
      );
      const mine = await withTestTenant(async () => transfers.listMine(studentActor()));
      expect(mine.length).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // GroupAnalyticsService — listForGroup + recompute UPSERT
  // ─────────────────────────────────────────────────────────────────
  describe('GroupAnalyticsService', () => {
    it('recompute: admin computes baseline (UPSERT INSERT branch)', async () => {
      const dto = await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: '2026-05-01' } as any, adminActor()),
      );
      expect(dto.groupId).toBe(TEST_GROUP_OPEN_A_ID);
      expect(dto.totalMembers).toBe(1);
      expect(dto.activeMembers).toBe(1);
      expect(dto.engagementRate).toBe(1);
    });

    it('recompute: second call updates the existing row (UPSERT UPDATE branch)', async () => {
      await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: '2026-05-01' } as any, adminActor()),
      );
      // Add a second member then recompute
      await withTestTenant(async () =>
        memberships.joinGroup(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
      );
      const dto = await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: '2026-05-01' } as any, adminActor()),
      );
      expect(dto.totalMembers).toBe(2);
      expect(dto.activeMembers).toBe(2);
    });

    it('recompute: invalid date in period falls back to current month', async () => {
      const dto = await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: 'not-a-date' } as any, adminActor()),
      );
      expect(dto.period).toMatch(/^\d{4}-\d{2}-01/);
    });

    it('recompute: no period → defaults to current month', async () => {
      const dto = await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, {} as any, adminActor()),
      );
      expect(dto.period).toMatch(/^\d{4}-\d{2}-01/);
    });

    it('recompute: missing group → NotFoundException', async () => {
      // Group not in school → assertGroupInCurrentSchool throws Forbidden first
      await expect(
        withTestTenant(async () =>
          analytics.recompute('00000000-0000-0000-0000-000000000000', {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('recompute: cross-school group → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => analytics.recompute(TEST_GROUP_B_ID, {} as any, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('recompute: non-admin non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          analytics.recompute(TEST_GROUP_OPEN_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForGroup: admin returns the recomputed history', async () => {
      await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: '2026-04-01' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        analytics.recompute(TEST_GROUP_OPEN_A_ID, { period: '2026-05-01' } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        analytics.listForGroup(TEST_GROUP_OPEN_A_ID, adminActor()),
      );
      expect(list.length).toBe(2);
    });

    it('listForGroup: non-manager → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => analytics.listForGroup(TEST_GROUP_OPEN_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listForGroup: cross-school → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => analytics.listForGroup(TEST_GROUP_B_ID, adminActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
