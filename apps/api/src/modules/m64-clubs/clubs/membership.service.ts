import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { ActivityService } from '../activities/activity.service';
import {
  ActivityMemberDto,
  AddMemberDto,
  JoinActivityDto,
  MemberRole,
  UpdateMemberDto,
} from './dto/clubs.dto';

interface MemberRow {
  id: string;
  activity_id: string;
  student_id: string;
  student_name: string | null;
  role: string;
  joined_at: string;
  left_at: string | null;
  is_active: boolean;
}

const SELECT_MEMBER =
  'SELECT m.id::text AS id, m.activity_id::text AS activity_id, ' +
  'm.student_id::text AS student_id, ' +
  "(SELECT (p.first_name || ' ' || p.last_name) FROM sis_students s " +
  '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  '  JOIN platform.iam_person p ON p.id = ps.person_id ' +
  '  WHERE s.id = m.student_id) AS student_name, ' +
  "m.role, TO_CHAR(m.joined_at, 'YYYY-MM-DD') AS joined_at, " +
  "TO_CHAR(m.left_at, 'YYYY-MM-DD') AS left_at, m.is_active " +
  'FROM ext_activity_members m ';

function memberRowToDto(r: MemberRow): ActivityMemberDto {
  return {
    id: r.id,
    activityId: r.activity_id,
    studentId: r.student_id,
    studentName: r.student_name,
    role: r.role as MemberRole,
    joinedAt: r.joined_at,
    leftAt: r.left_at,
    isActive: r.is_active,
  };
}

@Injectable()
export class MembershipService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly activities: ActivityService,
  ) {}

  /**
   * Resolve the calling student's sis_students.id from
   * actor.personId via the platform_students bridge. Returns null
   * for non-student personas.
   */
  private async resolveStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT' || !actor.personId) return null;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
    })) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  /**
   * STUDENT SELF-REGISTRATION KEYSTONE.
   *
   * Locks the parent activity row with `SELECT … FOR UPDATE` inside a
   * single tenant transaction so concurrent joins serialise on the
   * activity. Validates max_participants is not exceeded by counting
   * active members under the lock. UNIQUE(activity, student) catches
   * double-join with a friendly 400. The student is resolved via
   * actor.personId so a parent or teacher cannot join as a student.
   */
  async joinAsStudent(
    activityId: string,
    input: JoinActivityDto,
    actor: ResolvedActor,
  ): Promise<ActivityMemberDto> {
    const studentId = await this.resolveStudentId(actor);
    if (!studentId) {
      throw new ForbiddenException(
        'Only students can self-register. Staff can add a student via POST /clubs/activities/:id/members',
      );
    }
    const memberId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const activity = (await tx.$queryRawUnsafe(
        'SELECT id, max_participants, status FROM ext_activities WHERE id = $1::uuid FOR UPDATE',
        activityId,
      )) as Array<{ id: string; max_participants: number | null; status: string }>;
      if (activity.length === 0) throw new NotFoundException('Activity not found');
      if (activity[0]!.status !== 'ACTIVE') {
        throw new BadRequestException('Activity is not ACTIVE — registration is closed');
      }

      // Count active members under the lock so concurrent joins serialise
      const countRows = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM ext_activity_members WHERE activity_id = $1::uuid AND is_active = true',
        activityId,
      )) as Array<{ c: number }>;
      const max = activity[0]!.max_participants;
      if (max !== null && countRows[0]!.c >= max) {
        throw new BadRequestException(
          'Activity has reached its max_participants cap of ' + max + '. Registration is full.',
        );
      }

      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_activity_members (id, activity_id, student_id, role, joined_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_DATE)',
          memberId,
          activityId,
          studentId,
          input.role ?? 'MEMBER',
        );
      } catch (e) {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
          throw new BadRequestException('You are already a member of this activity');
        }
        throw e;
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MEMBER + 'WHERE m.id = $1::uuid', memberId);
    })) as MemberRow[];
    return memberRowToDto(rows[0]!);
  }

  async addMember(
    activityId: string,
    input: AddMemberDto,
    actor: ResolvedActor,
  ): Promise<ActivityMemberDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only Staff or admins can add members');
    }
    // REVIEW-CYCLE17 BLOCKING 1 — only the activity advisor or admin
    await this.activities.assertCanManageActivity(activityId, actor);
    const memberId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const activity = (await tx.$queryRawUnsafe(
        'SELECT id, max_participants FROM ext_activities WHERE id = $1::uuid FOR UPDATE',
        activityId,
      )) as Array<{ id: string; max_participants: number | null }>;
      if (activity.length === 0) throw new NotFoundException('Activity not found');
      const max = activity[0]!.max_participants;
      if (max !== null) {
        const countRows = (await tx.$queryRawUnsafe(
          'SELECT COUNT(*)::int AS c FROM ext_activity_members WHERE activity_id = $1::uuid AND is_active = true',
          activityId,
        )) as Array<{ c: number }>;
        if (countRows[0]!.c >= max) {
          throw new BadRequestException('Activity has reached its max_participants cap of ' + max);
        }
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO ext_activity_members (id, activity_id, student_id, role, joined_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_DATE)',
          memberId,
          activityId,
          input.studentId,
          input.role ?? 'MEMBER',
        );
      } catch (e) {
        const err = e as { code?: string; meta?: { code?: string }; message?: string };
        if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
          throw new BadRequestException('Student is already a member of this activity');
        }
        throw e;
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MEMBER + 'WHERE m.id = $1::uuid', memberId);
    })) as MemberRow[];
    return memberRowToDto(rows[0]!);
  }

  async patchMember(
    id: string,
    input: UpdateMemberDto,
    actor: ResolvedActor,
  ): Promise<ActivityMemberDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only Staff or admins can update members');
    }
    // REVIEW-CYCLE17 BLOCKING 1 — only the activity advisor or admin
    const activityId = await this.activities.loadActivityIdForMember(id);
    if (!activityId) throw new NotFoundException('Member not found');
    await this.activities.assertCanManageActivity(activityId, actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.role !== undefined) {
      params.push(input.role);
      sets.push('role = $' + params.length);
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (input.leftAt !== undefined) {
      params.push(input.leftAt);
      sets.push('left_at = $' + params.length + '::date');
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_MEMBER + 'WHERE m.id = $1::uuid', id);
      })) as MemberRow[];
      if (rows.length === 0) throw new NotFoundException('Member not found');
      return memberRowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_activity_members SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('Member not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_MEMBER + 'WHERE m.id = $1::uuid', id);
    })) as MemberRow[];
    return memberRowToDto(rows[0]!);
  }

  async listMyActivities(actor: ResolvedActor): Promise<ActivityMemberDto[]> {
    const studentId = await this.resolveStudentId(actor);
    if (!studentId) return [];
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEMBER +
          'WHERE m.student_id = $1::uuid AND m.is_active = true ORDER BY m.joined_at DESC',
        studentId,
      );
    })) as MemberRow[];
    return rows.map(memberRowToDto);
  }
}
