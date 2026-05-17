import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { GroupService } from './group.service';
import {
  ApproveJoinDto,
  InviteMemberDto,
  JoinGroupDto,
  MemberResponseDto,
  MemberRole,
  MemberStatus,
  NotificationPrefsDto,
  SuspendMemberDto,
  UpdateMemberRoleDto,
  UpdateNotificationPrefsDto,
  NotificationChannel,
} from './dto/groups.dto';

interface MemberRow {
  id: string;
  group_id: string;
  person_id: string;
  person_name: string | null;
  member_role: string;
  status: string;
  joined_at: Date | null;
  invited_by: string | null;
  left_at: Date | null;
  suspension_reason: string | null;
}

const SELECT_MEMBER_BASE =
  'SELECT m.id::text AS id, m.group_id::text AS group_id, m.person_id::text AS person_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = m.person_id) AS person_name, ' +
  'm.member_role, m.status, m.joined_at, m.invited_by::text AS invited_by, ' +
  'm.left_at, m.suspension_reason ' +
  'FROM grp_members m ';

function rowToDto(r: MemberRow): MemberResponseDto {
  return {
    id: r.id,
    groupId: r.group_id,
    personId: r.person_id,
    personName: r.person_name,
    role: r.member_role as MemberRole,
    status: r.status as MemberStatus,
    joinedAt: r.joined_at ? r.joined_at.toISOString() : null,
    invitedBy: r.invited_by,
    leftAt: r.left_at ? r.left_at.toISOString() : null,
    suspensionReason: r.suspension_reason,
  };
}

@Injectable()
export class MembershipService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  /**
   * REVIEW-CYCLE18 BLOCKING 2 — tenant validation on invited
   * platform_users.id. Same soft-ref-validate pattern as Cycle 7
   * Tasks, Cycle 15 Meetings, Cycle 12 Library patrons, Cycle 17
   * Chaperones. Joins through the three current-tenant projections
   * to confirm the supplied account exists in this school.
   */
  private async assertAccountInCurrentTenant(accountId: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM platform.platform_users pu WHERE pu.id = $1::uuid AND (' +
          'EXISTS (SELECT 1 FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM sis_guardians g WHERE g.person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM hr_employees e WHERE e.person_id = pu.person_id) ' +
          ') LIMIT 1',
        accountId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException('Invited account does not belong to a user in this school');
    }
  }

  /**
   * REVIEW-CYCLE18 BLOCKING 3 — roster visibility.
   *
   * Roster of names + roles + statuses is no longer returned to
   * non-members of OPEN/APPROVAL_REQUIRED groups. Admins, group
   * OWNER/ADMIN, and active members see the full roster; everyone
   * else gets an empty array (the `memberCount` aggregate on the
   * group DTO is the public-facing alternative).
   */
  async listForGroup(groupId: string, actor: ResolvedActor): Promise<MemberResponseDto[]> {
    const group = await this.groups.getById(groupId, actor);
    const isMember = !!group.myMembership && group.myMembership.status === 'ACTIVE';
    if (!actor.isSchoolAdmin && !isMember) {
      return [];
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEMBER_BASE +
          "WHERE m.group_id = $1::uuid AND m.status <> 'LEFT' " +
          'ORDER BY CASE m.member_role ' +
          "  WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 ELSE 2 END, m.joined_at NULLS LAST",
        groupId,
      );
    })) as MemberRow[];
    return rows.map(rowToDto);
  }

  private isUniqueViolation(e: unknown): boolean {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    return (
      err.code === '23505' ||
      err.code === 'P2002' ||
      err.meta?.code === '23505' ||
      /duplicate key|already exists/i.test(err.message ?? '')
    );
  }

  async listMine(actor: ResolvedActor): Promise<MemberResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEMBER_BASE +
          "WHERE m.person_id = $1::uuid AND m.status <> 'LEFT' ORDER BY m.joined_at DESC NULLS LAST",
        actor.accountId,
      );
    })) as MemberRow[];
    return rows.map(rowToDto);
  }

  async loadMember(memberId: string): Promise<MemberRow> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1', memberId);
    })) as MemberRow[];
    if (rows.length === 0) throw new NotFoundException('Membership not found');
    return rows[0]!;
  }

  /**
   * KEYSTONE — join semantics with re-join.
   *
   * If the caller has an existing non-LEFT row, return it (idempotent).
   * If they have a LEFT row, the partial UNIQUE allows a fresh row to
   * land. Routing depends on join_policy:
   *   OPEN              → ACTIVE immediately
   *   APPROVAL_REQUIRED → PENDING_APPROVAL (admin promotes)
   *   INVITE_ONLY       → 403 (must be invited)
   */
  async joinGroup(
    groupId: string,
    _input: JoinGroupDto,
    actor: ResolvedActor,
  ): Promise<MemberResponseDto> {
    const group = await this.groups.getById(groupId, actor);
    if (group.status !== 'ACTIVE') {
      throw new BadRequestException('Group is not accepting new members');
    }
    if (group.myMembership && group.myMembership.status !== 'LEFT') {
      // Already a member or pending — return the existing row.
      const row = await this.loadMember(group.myMembership.id);
      return rowToDto(row);
    }

    if (group.joinPolicy === 'INVITE_ONLY') {
      throw new ForbiddenException('This group is invite-only');
    }

    const id = generateId();
    const status = group.joinPolicy === 'APPROVAL_REQUIRED' ? 'PENDING_APPROVAL' : 'ACTIVE';
    const joinedExpr = status === 'ACTIVE' ? 'now()' : 'NULL';
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', $4, " +
            joinedExpr +
            ')',
          id,
          groupId,
          actor.accountId,
          status,
        );
      });
    } catch (e) {
      // REVIEW-CYCLE18 MAJOR 6 — race-loser path: a concurrent
      // self-join could land between the pre-flight read and the
      // INSERT. The partial UNIQUE on (group_id, person_id) WHERE
      // status<>'LEFT' fires; return the existing row instead of
      // surfacing 23505.
      if (this.isUniqueViolation(e)) {
        const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
          return client.$queryRawUnsafe(
            SELECT_MEMBER_BASE +
              "WHERE m.group_id = $1::uuid AND m.person_id = $2::uuid AND m.status <> 'LEFT' LIMIT 1",
            groupId,
            actor.accountId,
          );
        })) as MemberRow[];
        if (existing.length > 0) return rowToDto(existing[0]!);
      }
      throw e;
    }
    const row = await this.loadMember(id);
    return rowToDto(row);
  }

  async leaveGroup(groupId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const group = await this.groups.loadGroup(groupId, actor);
    if (!group.myMembership) throw new NotFoundException('Not a member of this group');
    if (group.myMembership.role === 'OWNER') {
      throw new BadRequestException(
        'OWNER must transfer ownership before leaving — initiate a transfer first',
      );
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'LEFT', left_at = now(), updated_at = now() WHERE id = $1::uuid",
        group.myMembership!.id,
      );
    });
    return { ok: true };
  }

  async invite(
    groupId: string,
    input: InviteMemberDto,
    actor: ResolvedActor,
  ): Promise<MemberResponseDto> {
    await this.groups.assertCanManageGroup(groupId, actor);
    // REVIEW-CYCLE18 BLOCKING 2 — invited account must belong to
    // this tenant. Without the check, a manager who knows a UUID
    // from another school could land an invite row here.
    await this.assertAccountInCurrentTenant(input.personId);

    const existing = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT id::text AS id, status FROM grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND status <> 'LEFT' LIMIT 1",
        groupId,
        input.personId,
      );
    })) as Array<{ id: string; status: string }>;
    if (existing.length > 0) {
      throw new BadRequestException(
        'Person is already a member or has a pending invite (status=' + existing[0]!.status + ')',
      );
    }

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO grp_members (id, group_id, person_id, member_role, status, invited_by) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'INVITED', $5::uuid)",
          id,
          groupId,
          input.personId,
          input.role ?? 'MEMBER',
          actor.accountId,
        );
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        throw new BadRequestException(
          'Person is already a member or has a pending invite for this group',
        );
      }
      throw e;
    }
    const row = await this.loadMember(id);
    return rowToDto(row);
  }

  /**
   * REVIEW-CYCLE18 MAJOR 5 — locked-row state transitions.
   *
   * Every membership state mutation locks the target row with
   * SELECT ... FOR UPDATE inside the same tenant transaction that
   * validates state + applies the UPDATE, so two concurrent
   * managers can't both pass a status/role check and land
   * conflicting writes (the classic last-writer-wins shape we've
   * fixed in Cycles 4, 5, 6, 13, 14, 15, 16).
   */
  private async lockedTransition<T>(
    memberId: string,
    fn: (
      tx: Parameters<Parameters<TenantPrismaService['executeInTenantTransaction']>[0]>[0],
      row: MemberRow,
    ) => Promise<T>,
  ): Promise<T> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid FOR UPDATE OF m',
        memberId,
      )) as MemberRow[];
      if (rows.length === 0) throw new NotFoundException('Membership not found');
      return fn(tx, rows[0]!);
    });
  }

  async acceptInvite(memberId: string, actor: ResolvedActor): Promise<MemberResponseDto> {
    return this.lockedTransition(memberId, async (tx, row) => {
      if (row.person_id !== actor.accountId) {
        throw new ForbiddenException('Only the invited person can accept');
      }
      if (row.status !== 'INVITED') {
        throw new BadRequestException('Membership is not in INVITED state');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'ACTIVE', joined_at = now(), updated_at = now() WHERE id = $1::uuid",
        memberId,
      );
      const fresh = await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1',
        memberId,
      );
      return rowToDto((fresh as MemberRow[])[0]!);
    });
  }

  async declineInvite(memberId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    return this.lockedTransition(memberId, async (tx, row) => {
      if (row.person_id !== actor.accountId) {
        throw new ForbiddenException('Only the invited person can decline');
      }
      if (row.status !== 'INVITED') {
        throw new BadRequestException('Membership is not in INVITED state');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'LEFT', left_at = now(), updated_at = now() WHERE id = $1::uuid",
        memberId,
      );
      return { ok: true } as const;
    });
  }

  async approveJoin(
    memberId: string,
    input: ApproveJoinDto,
    actor: ResolvedActor,
  ): Promise<MemberResponseDto> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException('Membership is not pending approval');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'ACTIVE', joined_at = now(), member_role = $2, updated_at = now() WHERE id = $1::uuid",
        memberId,
        input.role ?? 'MEMBER',
      );
      const fresh = await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1',
        memberId,
      );
      return rowToDto((fresh as MemberRow[])[0]!);
    });
  }

  async denyJoin(memberId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException('Membership is not pending approval');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'REMOVED', updated_at = now() WHERE id = $1::uuid",
        memberId,
      );
      return { ok: true } as const;
    });
  }

  async updateRole(
    memberId: string,
    input: UpdateMemberRoleDto,
    actor: ResolvedActor,
  ): Promise<MemberResponseDto> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.member_role === 'OWNER') {
        throw new BadRequestException(
          'Cannot demote the OWNER directly — initiate an ownership transfer instead',
        );
      }
      if (row.status !== 'ACTIVE') {
        throw new BadRequestException('Member must be ACTIVE to change role');
      }
      await tx.$executeRawUnsafe(
        'UPDATE grp_members SET member_role = $2, updated_at = now() WHERE id = $1::uuid',
        memberId,
        input.role,
      );
      const fresh = await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1',
        memberId,
      );
      return rowToDto((fresh as MemberRow[])[0]!);
    });
  }

  async suspend(
    memberId: string,
    input: SuspendMemberDto,
    actor: ResolvedActor,
  ): Promise<MemberResponseDto> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.member_role === 'OWNER') {
        throw new BadRequestException('Cannot suspend the OWNER');
      }
      if (row.status !== 'ACTIVE') {
        throw new BadRequestException('Member must be ACTIVE to suspend');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'SUSPENDED', suspension_reason = $2, updated_at = now() WHERE id = $1::uuid",
        memberId,
        input.reason,
      );
      const fresh = await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1',
        memberId,
      );
      return rowToDto((fresh as MemberRow[])[0]!);
    });
  }

  async unsuspend(memberId: string, actor: ResolvedActor): Promise<MemberResponseDto> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.status !== 'SUSPENDED') {
        throw new BadRequestException('Member is not currently suspended');
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'ACTIVE', suspension_reason = NULL, updated_at = now() WHERE id = $1::uuid",
        memberId,
      );
      const fresh = await tx.$queryRawUnsafe(
        SELECT_MEMBER_BASE + 'WHERE m.id = $1::uuid LIMIT 1',
        memberId,
      );
      return rowToDto((fresh as MemberRow[])[0]!);
    });
  }

  async remove(memberId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    return this.lockedTransition(memberId, async (tx, row) => {
      await this.groups.assertCanManageGroup(row.group_id, actor);
      if (row.member_role === 'OWNER') {
        throw new BadRequestException(
          'Cannot remove the OWNER — initiate an ownership transfer first',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE grp_members SET status = 'REMOVED', updated_at = now() WHERE id = $1::uuid",
        memberId,
      );
      return { ok: true } as const;
    });
  }

  // ── Notification preferences ──

  async getPrefs(memberId: string, actor: ResolvedActor): Promise<NotificationPrefsDto> {
    const row = await this.loadMember(memberId);
    if (row.person_id !== actor.accountId && !actor.isSchoolAdmin) {
      throw new ForbiddenException("Cannot view another member's notification prefs");
    }
    const prefs = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT membership_id::text AS membership_id, notify_announcements, notify_events, ' +
          'notify_membership_changes, notify_results, preferred_channel, quiet_hours_override ' +
          'FROM grp_member_notification_prefs WHERE membership_id = $1::uuid LIMIT 1',
        memberId,
      );
    })) as Array<{
      membership_id: string;
      notify_announcements: boolean;
      notify_events: boolean;
      notify_membership_changes: boolean;
      notify_results: boolean;
      preferred_channel: string;
      quiet_hours_override: boolean;
    }>;
    if (prefs.length > 0) {
      const p = prefs[0]!;
      return {
        membershipId: p.membership_id,
        notifyAnnouncements: p.notify_announcements,
        notifyEvents: p.notify_events,
        notifyMembershipChanges: p.notify_membership_changes,
        notifyResults: p.notify_results,
        preferredChannel: p.preferred_channel as NotificationChannel,
        quietHoursOverride: p.quiet_hours_override,
      };
    }
    return {
      membershipId: memberId,
      notifyAnnouncements: true,
      notifyEvents: true,
      notifyMembershipChanges: false,
      notifyResults: true,
      preferredChannel: 'IN_APP',
      quietHoursOverride: false,
    };
  }

  async updatePrefs(
    memberId: string,
    input: UpdateNotificationPrefsDto,
    actor: ResolvedActor,
  ): Promise<NotificationPrefsDto> {
    const row = await this.loadMember(memberId);
    if (row.person_id !== actor.accountId && !actor.isSchoolAdmin) {
      throw new ForbiddenException("Cannot edit another member's notification prefs");
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO grp_member_notification_prefs (id, membership_id, notify_announcements, notify_events, notify_membership_changes, notify_results, preferred_channel, quiet_hours_override) ' +
          'VALUES ($1::uuid, $2::uuid, COALESCE($3, true), COALESCE($4, true), COALESCE($5, false), COALESCE($6, true), COALESCE($7, $8), COALESCE($9, false)) ' +
          'ON CONFLICT (membership_id) DO UPDATE SET ' +
          'notify_announcements = COALESCE($3, grp_member_notification_prefs.notify_announcements), ' +
          'notify_events = COALESCE($4, grp_member_notification_prefs.notify_events), ' +
          'notify_membership_changes = COALESCE($5, grp_member_notification_prefs.notify_membership_changes), ' +
          'notify_results = COALESCE($6, grp_member_notification_prefs.notify_results), ' +
          'preferred_channel = COALESCE($7, grp_member_notification_prefs.preferred_channel), ' +
          'quiet_hours_override = COALESCE($9, grp_member_notification_prefs.quiet_hours_override), ' +
          'updated_at = now()',
        id,
        memberId,
        input.notifyAnnouncements ?? null,
        input.notifyEvents ?? null,
        input.notifyMembershipChanges ?? null,
        input.notifyResults ?? null,
        input.preferredChannel ?? null,
        'IN_APP',
        input.quietHoursOverride ?? null,
      );
    });
    return this.getPrefs(memberId, actor);
  }
}
