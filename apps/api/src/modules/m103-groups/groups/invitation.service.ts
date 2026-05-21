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
import { assertAccountInCurrentSchool, assertGroupInCurrentSchool } from './access';
import {
  CreateInvitationDto,
  InvitationResponseDto,
  InvitationStatus,
  RespondInvitationDto,
} from './dto/groups-advanced.dto';

interface InvitationRow {
  id: string;
  group_id: string;
  group_name: string | null;
  invited_user_id: string;
  invited_user_name: string | null;
  invited_by: string;
  invited_by_name: string | null;
  status: string;
  message: string | null;
  responded_at: Date | null;
  created_at: Date;
}

const SELECT_INV_BASE =
  'SELECT i.id::text AS id, i.group_id::text AS group_id, ' +
  '(SELECT name FROM grp_groups WHERE id = i.group_id) AS group_name, ' +
  'i.invited_user_id::text AS invited_user_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = i.invited_user_id) AS invited_user_name, ' +
  'i.invited_by::text AS invited_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = i.invited_by) AS invited_by_name, ' +
  'i.status, i.message, i.responded_at, i.created_at ' +
  'FROM grp_group_invitations i ';

/**
 * InvitationService — P2-28a Step 2.
 *
 * Pending invitations to join a group. The KEYSTONE is the ACCEPTED
 * transition — the service-layer accept handler runs inside one
 * tenant tx that:
 *   1. Locks the invitation row FOR UPDATE.
 *   2. Validates status = PENDING.
 *   3. Stamps status = ACCEPTED + responded_at = now().
 *   4. INSERTs a grp_members row with status = ACTIVE.
 *
 * The grp_members partial UNIQUE (group_id, person_id) WHERE
 * status <> 'LEFT' is the schema-side belt-and-braces — if the
 * invited user is already a non-LEFT member the INSERT raises 23505
 * and the tx rolls back; the service catches the unique violation
 * and returns a friendly 409-style 400 with the existing-member
 * message.
 */
@Injectable()
export class InvitationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly groups: GroupService,
  ) {}

  private isUniqueViolation(e: unknown): boolean {
    const err = e as { code?: string; meta?: { code?: string }; message?: string };
    return (
      err.code === '23505' ||
      err.code === 'P2002' ||
      err.meta?.code === '23505' ||
      /duplicate key|already exists/i.test(err.message ?? '')
    );
  }

  async create(
    groupId: string,
    input: CreateInvitationDto,
    actor: ResolvedActor,
  ): Promise<InvitationResponseDto> {
    // REVIEW-P2C28 Round 1 BLOCKING 2 — even school admins must
    // validate the target group belongs to the current school.
    await assertGroupInCurrentSchool(this.tenantPrisma, groupId);
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    // REVIEW-P2C28 Round 1 BLOCKING 3 — invited user must have a
    // projection in the current SCHOOL (not just somewhere in the
    // tenant schema).
    await assertAccountInCurrentSchool(this.tenantPrisma, input.invitedUserId);

    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO grp_group_invitations (id, group_id, invited_user_id, invited_by, message, status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'PENDING')",
          id,
          groupId,
          input.invitedUserId,
          actor.accountId,
          input.message ?? null,
        );
      });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        throw new BadRequestException('An invitation for this user already exists on this group');
      }
      throw e;
    }
    return this.getById(id, actor);
  }

  async listForGroup(groupId: string, actor: ResolvedActor): Promise<InvitationResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      await this.groups.assertCanManageGroup(groupId, actor);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_INV_BASE + 'WHERE i.group_id = $1::uuid ORDER BY i.created_at DESC LIMIT 200',
        groupId,
      );
    })) as InvitationRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async listMine(actor: ResolvedActor): Promise<InvitationResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_INV_BASE +
          "WHERE i.invited_user_id = $1::uuid AND i.status = 'PENDING' ORDER BY i.created_at DESC",
        actor.accountId,
      );
    })) as InvitationRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(invitationId: string, actor: ResolvedActor): Promise<InvitationResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_INV_BASE + 'WHERE i.id = $1::uuid LIMIT 1',
        invitationId,
      );
    })) as InvitationRow[];
    if (rows.length === 0) throw new NotFoundException('Invitation not found');
    const row = rows[0]!;
    // Row scope: invited user, inviter, group manager, school admin
    if (
      !actor.isSchoolAdmin &&
      row.invited_user_id !== actor.accountId &&
      row.invited_by !== actor.accountId
    ) {
      await this.groups.assertCanManageGroup(row.group_id, actor);
    }
    return this.rowToDto(row);
  }

  /**
   * Respond keystone — ACCEPTED auto-creates grp_members row inside
   * one tenant tx so the invitation flip and the member row land
   * together or not at all.
   */
  async respond(
    invitationId: string,
    input: RespondInvitationDto,
    actor: ResolvedActor,
  ): Promise<InvitationResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, group_id::text AS group_id, invited_user_id::text AS invited_user_id, status ' +
          'FROM grp_group_invitations WHERE id = $1::uuid FOR UPDATE',
        invitationId,
      )) as Array<{ id: string; group_id: string; invited_user_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Invitation not found');
      const inv = rows[0]!;
      if (inv.invited_user_id !== actor.accountId) {
        throw new ForbiddenException('Only the invited user can respond to this invitation');
      }
      if (inv.status !== 'PENDING') {
        throw new BadRequestException('Invitation is no longer pending');
      }

      await tx.$executeRawUnsafe(
        'UPDATE grp_group_invitations SET status = $1, responded_at = now(), updated_at = now() ' +
          'WHERE id = $2::uuid',
        input.status,
        invitationId,
      );

      if (input.status === 'ACCEPTED') {
        // Check whether the invited user is already a non-LEFT member
        const existing = (await tx.$queryRawUnsafe(
          "SELECT id::text AS id FROM grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND status <> 'LEFT' LIMIT 1",
          inv.group_id,
          inv.invited_user_id,
        )) as Array<{ id: string }>;
        if (existing.length === 0) {
          try {
            await tx.$executeRawUnsafe(
              'INSERT INTO grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
                "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', 'ACTIVE', now())",
              generateId(),
              inv.group_id,
              inv.invited_user_id,
            );
          } catch (e) {
            if (!this.isUniqueViolation(e)) throw e;
            // Race-loser path — another path already created the member.
            // Treat as success because the invariant ("member exists") holds.
          }
        }
      }
    });

    return this.getById(invitationId, actor);
  }

  async cancel(invitationId: string, actor: ResolvedActor): Promise<{ ok: true }> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT group_id::text AS group_id, status, invited_by::text AS invited_by ' +
          'FROM grp_group_invitations WHERE id = $1::uuid LIMIT 1',
        invitationId,
      );
    })) as Array<{ group_id: string; status: string; invited_by: string }>;
    if (rows.length === 0) throw new NotFoundException('Invitation not found');
    if (!actor.isSchoolAdmin && rows[0]!.invited_by !== actor.accountId) {
      await this.groups.assertCanManageGroup(rows[0]!.group_id, actor);
    }
    if (rows[0]!.status !== 'PENDING') {
      throw new BadRequestException('Only PENDING invitations can be cancelled');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM grp_group_invitations WHERE id = $1::uuid',
        invitationId,
      );
    });
    return { ok: true };
  }

  private rowToDto(r: InvitationRow): InvitationResponseDto {
    return {
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_name,
      invitedUserId: r.invited_user_id,
      invitedUserName: r.invited_user_name,
      invitedBy: r.invited_by,
      invitedByName: r.invited_by_name,
      status: r.status as InvitationStatus,
      message: r.message,
      respondedAt: r.responded_at ? r.responded_at.toISOString() : null,
      createdAt: r.created_at.toISOString(),
    };
  }
}
