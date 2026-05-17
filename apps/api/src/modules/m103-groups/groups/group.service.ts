import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateGroupDto,
  GroupResponseDto,
  GroupScopeType,
  GroupStatus,
  JoinPolicy,
  MemberRole,
  MemberStatus,
  UpdateGroupDto,
} from './dto/groups.dto';

interface GroupRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  scope_type: string;
  scope_id: string | null;
  scope_label: string | null;
  status: string;
  join_policy: string;
  auto_dissolve_at: Date | null;
  created_by: string;
  avatar_url: string | null;
  member_count: number;
  pending_count: number;
  my_member_id: string | null;
  my_role: string | null;
  my_status: string | null;
  created_at: Date;
}

const SELECT_GROUP_BASE =
  'SELECT g.id::text AS id, g.school_id::text AS school_id, g.name, g.description, ' +
  'g.scope_type, g.scope_id::text AS scope_id, ' +
  'CASE g.scope_type ' +
  "  WHEN 'CLASS' THEN (SELECT cl.section_code || ' — ' || co.name FROM sis_classes cl JOIN sis_courses co ON co.id = cl.course_id WHERE cl.id = g.scope_id) " +
  "  WHEN 'YEAR_GROUP' THEN (SELECT name FROM sis_academic_years WHERE id = g.scope_id) " +
  "  WHEN 'ACTIVITY' THEN (SELECT name FROM ext_activities WHERE id = g.scope_id) " +
  '  ELSE NULL END AS scope_label, ' +
  'g.status, g.join_policy, g.auto_dissolve_at, ' +
  'g.created_by::text AS created_by, g.avatar_url, ' +
  "(SELECT COUNT(*)::int FROM grp_members m WHERE m.group_id = g.id AND m.status = 'ACTIVE') AS member_count, " +
  "(SELECT COUNT(*)::int FROM grp_members m WHERE m.group_id = g.id AND m.status IN ('PENDING_APPROVAL', 'INVITED')) AS pending_count, " +
  '(SELECT m.id::text FROM grp_members m WHERE m.group_id = g.id AND m.person_id = $ME::uuid AND m.status <> $LEFT LIMIT 1) AS my_member_id, ' +
  '(SELECT m.member_role FROM grp_members m WHERE m.group_id = g.id AND m.person_id = $ME::uuid AND m.status <> $LEFT LIMIT 1) AS my_role, ' +
  '(SELECT m.status FROM grp_members m WHERE m.group_id = g.id AND m.person_id = $ME::uuid AND m.status <> $LEFT LIMIT 1) AS my_status, ' +
  'g.created_at ' +
  'FROM grp_groups g ';

function buildSelectGroup(meIndex: number, leftIndex: number): string {
  return SELECT_GROUP_BASE.replace(/\$ME/g, '$' + meIndex).replace(/\$LEFT/g, '$' + leftIndex);
}

function rowToDto(r: GroupRow): GroupResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    scopeType: r.scope_type as GroupScopeType,
    scopeId: r.scope_id,
    scopeLabel: r.scope_label,
    status: r.status as GroupStatus,
    joinPolicy: r.join_policy as JoinPolicy,
    autoDissolveAt: r.auto_dissolve_at ? r.auto_dissolve_at.toISOString() : null,
    createdBy: r.created_by,
    avatarUrl: r.avatar_url,
    memberCount: r.member_count,
    pendingCount: r.pending_count,
    myMembership: r.my_member_id
      ? { id: r.my_member_id, role: r.my_role as MemberRole, status: r.my_status as MemberStatus }
      : null,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class GroupService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Manager scope = school admin OR the calling person is OWNER/ADMIN
   * of the specific group. Used by every mutation surface.
   */
  async assertCanManageGroup(groupId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT member_role FROM grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND status = 'ACTIVE' AND member_role IN ('OWNER', 'ADMIN') LIMIT 1",
        groupId,
        actor.accountId,
      );
    })) as Array<{ member_role: string }>;
    if (rows.length === 0) {
      throw new ForbiddenException('Only OWNER, ADMIN, or school admins can manage this group');
    }
  }

  async loadGroup(groupId: string, actor: ResolvedActor): Promise<GroupResponseDto> {
    const sql = buildSelectGroup(1, 2) + 'WHERE g.id = $3::uuid LIMIT 1';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, actor.accountId, 'LEFT', groupId);
    })) as GroupRow[];
    if (rows.length === 0) throw new NotFoundException('Group not found');
    return rowToDto(rows[0]!);
  }

  /**
   * List groups visible to the actor.
   *
   * - Admins see every group in the school.
   * - Members see groups they belong to.
   * - Anyone can browse OPEN/APPROVAL_REQUIRED groups (the
   *   discovery surface) — INVITE_ONLY groups stay hidden unless
   *   the caller is a member.
   */
  async list(
    actor: ResolvedActor,
    args: { onlyMine?: boolean; status?: GroupStatus; scopeType?: GroupScopeType },
  ): Promise<GroupResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['g.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];

    if (args.status) {
      where.push('g.status = $' + (params.length + 1));
      params.push(args.status);
    } else {
      where.push("g.status <> 'DISSOLVED'");
    }

    if (args.scopeType) {
      where.push('g.scope_type = $' + (params.length + 1));
      params.push(args.scopeType);
    }

    if (args.onlyMine) {
      params.push(actor.accountId);
      where.push(
        'EXISTS (SELECT 1 FROM grp_members m WHERE m.group_id = g.id AND m.person_id = $' +
          params.length +
          "::uuid AND m.status <> 'LEFT')",
      );
    } else if (!actor.isSchoolAdmin) {
      params.push(actor.accountId);
      where.push(
        "(g.join_policy <> 'INVITE_ONLY' OR EXISTS (SELECT 1 FROM grp_members m WHERE m.group_id = g.id AND m.person_id = $" +
          params.length +
          "::uuid AND m.status <> 'LEFT'))",
      );
    }

    const meIndex = params.length + 1;
    params.push(actor.accountId);
    const leftIndex = params.length + 1;
    params.push('LEFT');

    const sql =
      buildSelectGroup(meIndex, leftIndex) +
      'WHERE ' +
      where.join(' AND ') +
      ' ORDER BY g.created_at DESC LIMIT 200';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...params);
    })) as GroupRow[];
    return rows.map(rowToDto);
  }

  async getById(groupId: string, actor: ResolvedActor): Promise<GroupResponseDto> {
    const dto = await this.loadGroup(groupId, actor);
    if (dto.joinPolicy === 'INVITE_ONLY' && !actor.isSchoolAdmin && !dto.myMembership) {
      throw new NotFoundException('Group not found');
    }
    return dto;
  }

  /**
   * Create a group. The creator becomes the OWNER atomically inside
   * one tenant transaction so there's never a moment a group exists
   * without an owner.
   *
   * REVIEW-CYCLE18 BLOCKING 1 — creation authority by scope:
   *   SCHOOL / CUSTOM     → admin or STAFF only.
   *   CLASS               → admin or the assigned class teacher.
   *   YEAR_GROUP          → admin or STAFF only.
   *   ACTIVITY            → admin or the activity advisor.
   * Students and guardians can no longer create broad school-wide
   * groups by hitting POST /groups directly.
   */
  async create(input: CreateGroupDto, actor: ResolvedActor): Promise<GroupResponseDto> {
    const tenant = getCurrentTenant();

    if ((input.scopeType === 'SCHOOL' || input.scopeType === 'CUSTOM') && input.scopeId) {
      throw new BadRequestException('scopeId must be null for SCHOOL or CUSTOM groups');
    }
    if (
      (input.scopeType === 'CLASS' ||
        input.scopeType === 'YEAR_GROUP' ||
        input.scopeType === 'ACTIVITY') &&
      !input.scopeId
    ) {
      throw new BadRequestException(
        'scopeId is required for CLASS, YEAR_GROUP, or ACTIVITY groups',
      );
    }

    await this.assertCanCreateForScope(input.scopeType, input.scopeId ?? null, actor);

    if (input.scopeId) {
      await this.assertScopeRefValid(input.scopeType, input.scopeId);
    }

    const id = generateId();
    const memberId = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO grp_groups (id, school_id, name, description, scope_type, scope_id, status, join_policy, auto_dissolve_at, created_by, avatar_url) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'ACTIVE', $7, $8::timestamptz, $9::uuid, $10)",
        id,
        tenant.schoolId,
        input.name,
        input.description ?? null,
        input.scopeType,
        input.scopeId ?? null,
        input.joinPolicy ?? 'OPEN',
        input.autoDissolveAt ?? null,
        actor.accountId,
        input.avatarUrl ?? null,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now())",
        memberId,
        id,
        actor.accountId,
      );
    });

    return this.loadGroup(id, actor);
  }

  private async assertCanCreateForScope(
    scopeType: GroupScopeType,
    scopeId: string | null,
    actor: ResolvedActor,
  ): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const isStaff = actor.personType === 'STAFF';

    if (scopeType === 'SCHOOL' || scopeType === 'CUSTOM' || scopeType === 'YEAR_GROUP') {
      if (!isStaff) {
        throw new ForbiddenException(
          'Only school admins or staff can create ' + scopeType + ' groups',
        );
      }
      return;
    }

    if (scopeType === 'CLASS') {
      if (!actor.employeeId || !scopeId) {
        throw new ForbiddenException(
          'Only the assigned class teacher or a school admin can create a CLASS group',
        );
      }
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid LIMIT 1',
          scopeId,
          actor.employeeId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException(
          'Only the assigned class teacher or a school admin can create a CLASS group',
        );
      }
      return;
    }

    if (scopeType === 'ACTIVITY') {
      if (!actor.employeeId || !scopeId) {
        throw new ForbiddenException(
          'Only the activity advisor or a school admin can create an ACTIVITY group',
        );
      }
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM ext_activities WHERE id = $1::uuid AND advisor_id = $2::uuid LIMIT 1',
          scopeId,
          actor.employeeId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException(
          'Only the activity advisor or a school admin can create an ACTIVITY group',
        );
      }
      return;
    }
  }

  private async assertScopeRefValid(scopeType: GroupScopeType, scopeId: string): Promise<void> {
    const tableByScope: Record<string, string> = {
      CLASS: 'sis_classes',
      YEAR_GROUP: 'sis_academic_years',
      ACTIVITY: 'ext_activities',
    };
    const table = tableByScope[scopeType];
    if (!table) return;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM ' + table + ' WHERE id = $1::uuid LIMIT 1',
        scopeId,
      );
    })) as Array<{ ok: number }>;
    if (rows.length === 0) {
      throw new BadRequestException(
        'scopeId does not match an existing ' + scopeType + ' row in this tenant',
      );
    }
  }

  async patch(
    groupId: string,
    input: UpdateGroupDto,
    actor: ResolvedActor,
  ): Promise<GroupResponseDto> {
    await this.assertCanManageGroup(groupId, actor);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      sets.push('name = $' + (params.length + 1));
      params.push(input.name);
    }
    if (input.description !== undefined) {
      sets.push('description = $' + (params.length + 1));
      params.push(input.description);
    }
    if (input.status !== undefined) {
      sets.push('status = $' + (params.length + 1));
      params.push(input.status);
    }
    if (input.joinPolicy !== undefined) {
      sets.push('join_policy = $' + (params.length + 1));
      params.push(input.joinPolicy);
    }
    if (input.autoDissolveAt !== undefined) {
      sets.push('auto_dissolve_at = $' + (params.length + 1) + '::timestamptz');
      params.push(input.autoDissolveAt);
    }
    if (input.avatarUrl !== undefined) {
      sets.push('avatar_url = $' + (params.length + 1));
      params.push(input.avatarUrl);
    }

    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(groupId);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE grp_groups SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
          ...params,
        );
      });
    }

    return this.loadGroup(groupId, actor);
  }

  /**
   * Used by other services to confirm a person is OWNER of the
   * group (e.g. ownership-transfer initiation).
   */
  async assertOwner(groupId: string, accountId: string): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        "SELECT id FROM grp_members WHERE group_id = $1::uuid AND person_id = $2::uuid AND member_role = 'OWNER' AND status = 'ACTIVE' LIMIT 1",
        groupId,
        accountId,
      );
    })) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new ForbiddenException('Only the group OWNER can perform this action');
    }
  }
}
