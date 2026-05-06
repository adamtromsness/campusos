import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ActivityCategory,
  ActivityResponseDto,
  ActivityStatus,
  ActivityTypeResponseDto,
  CreateActivityDto,
  CreateActivityTypeDto,
  UpdateActivityDto,
} from './dto/clubs.dto';

interface ActivityRow {
  id: string;
  school_id: string;
  activity_type_id: string;
  activity_type_name: string | null;
  activity_type_category: string | null;
  name: string;
  description: string | null;
  academic_year_id: string;
  advisor_id: string | null;
  advisor_name: string | null;
  max_participants: number | null;
  status: string;
  meeting_location: string | null;
  member_count: number;
}

const SELECT_ACTIVITY_BASE =
  'SELECT a.id::text AS id, a.school_id::text AS school_id, ' +
  'a.activity_type_id::text AS activity_type_id, t.name AS activity_type_name, ' +
  't.category AS activity_type_category, a.name, a.description, ' +
  'a.academic_year_id::text AS academic_year_id, ' +
  'a.advisor_id::text AS advisor_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = a.advisor_id) AS advisor_name, ' +
  'a.max_participants, a.status, a.meeting_location, ' +
  '(SELECT COUNT(*)::int FROM ext_activity_members m WHERE m.activity_id = a.id AND m.is_active = true) AS member_count ' +
  'FROM ext_activities a ' +
  'JOIN ext_activity_types t ON t.id = a.activity_type_id ';

function activityRowToDto(r: ActivityRow): ActivityResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    activityTypeId: r.activity_type_id,
    activityTypeName: r.activity_type_name,
    activityTypeCategory: (r.activity_type_category as ActivityCategory) ?? null,
    name: r.name,
    description: r.description,
    academicYearId: r.academic_year_id,
    advisorId: r.advisor_id,
    advisorName: r.advisor_name,
    maxParticipants: r.max_participants,
    status: r.status as ActivityStatus,
    meetingLocation: r.meeting_location,
    memberCount: r.member_count,
  };
}

@Injectable()
export class ActivityService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private isManager(actor: ResolvedActor): boolean {
    return actor.isSchoolAdmin || actor.personType === 'STAFF';
  }

  // ── Activity Types ──

  async listTypes(includeInactive = false): Promise<ActivityTypeResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql =
      'SELECT id::text AS id, school_id::text AS school_id, name, category, description, is_active ' +
      'FROM ext_activity_types WHERE school_id = $1::uuid' +
      (includeInactive ? '' : ' AND is_active = true') +
      ' ORDER BY category, name';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, tenant.schoolId);
    })) as Array<{
      id: string;
      school_id: string;
      name: string;
      category: string;
      description: string | null;
      is_active: boolean;
    }>;
    return rows.map((r) => ({
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      category: r.category as ActivityCategory,
      description: r.description,
      isActive: r.is_active,
    }));
  }

  async createType(
    input: CreateActivityTypeDto,
    actor: ResolvedActor,
  ): Promise<ActivityTypeResponseDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can create activity types');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ext_activity_types (id, school_id, name, category, description) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          tenant.schoolId,
          input.name,
          input.category,
          input.description ?? null,
        );
      });
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (err.code === '23505' || /duplicate key|already exists/i.test(err.message ?? '')) {
        throw new BadRequestException(
          'An activity type named "' + input.name + '" already exists for this school',
        );
      }
      throw e;
    }
    return {
      id,
      schoolId: tenant.schoolId,
      name: input.name,
      category: input.category,
      description: input.description ?? null,
      isActive: true,
    };
  }

  // ── Activities ──

  async list(args: {
    category?: string;
    status?: string;
    academicYearId?: string;
  }): Promise<ActivityResponseDto[]> {
    const tenant = getCurrentTenant();
    const filters: string[] = ['a.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.category) {
      params.push(args.category);
      filters.push('t.category = $' + params.length);
    }
    if (args.status) {
      params.push(args.status);
      filters.push('a.status = $' + params.length);
    }
    if (args.academicYearId) {
      params.push(args.academicYearId);
      filters.push('a.academic_year_id = $' + params.length + '::uuid');
    }
    const sql =
      SELECT_ACTIVITY_BASE + 'WHERE ' + filters.join(' AND ') + ' ORDER BY t.category, a.name';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, ...params);
    })) as ActivityRow[];
    return rows.map(activityRowToDto);
  }

  async getById(id: string): Promise<ActivityResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ACTIVITY_BASE + 'WHERE a.id = $1::uuid', id);
    })) as ActivityRow[];
    if (rows.length === 0) throw new NotFoundException('Activity not found');
    const dto = activityRowToDto(rows[0]!);

    // Inline members + schedule
    const memberRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.activity_id::text AS activity_id, ' +
          'm.student_id::text AS student_id, ' +
          "(SELECT (p.first_name || ' ' || p.last_name) FROM sis_students s " +
          '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '  JOIN platform.iam_person p ON p.id = ps.person_id ' +
          '  WHERE s.id = m.student_id) AS student_name, ' +
          "m.role, TO_CHAR(m.joined_at, 'YYYY-MM-DD') AS joined_at, " +
          "TO_CHAR(m.left_at, 'YYYY-MM-DD') AS left_at, m.is_active " +
          'FROM ext_activity_members m WHERE m.activity_id = $1::uuid ORDER BY m.role, joined_at',
        id,
      );
    })) as Array<{
      id: string;
      activity_id: string;
      student_id: string;
      student_name: string | null;
      role: string;
      joined_at: string;
      left_at: string | null;
      is_active: boolean;
    }>;
    dto.members = memberRows.map((m) => ({
      id: m.id,
      activityId: m.activity_id,
      studentId: m.student_id,
      studentName: m.student_name,
      role: m.role as 'MEMBER' | 'OFFICER' | 'PRESIDENT' | 'SECRETARY',
      joinedAt: m.joined_at,
      leftAt: m.left_at,
      isActive: m.is_active,
    }));

    const scheduleRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT id::text AS id, activity_id::text AS activity_id, day_of_week, ' +
          "TO_CHAR(start_time, 'HH24:MI') AS start_time, " +
          "TO_CHAR(end_time, 'HH24:MI') AS end_time, " +
          'location, is_active FROM ext_activity_schedules WHERE activity_id = $1::uuid ORDER BY day_of_week, start_time',
        id,
      );
    })) as Array<{
      id: string;
      activity_id: string;
      day_of_week: number;
      start_time: string;
      end_time: string;
      location: string | null;
      is_active: boolean;
    }>;
    dto.schedule = scheduleRows.map((s) => ({
      id: s.id,
      activityId: s.activity_id,
      dayOfWeek: s.day_of_week,
      startTime: s.start_time,
      endTime: s.end_time,
      location: s.location,
      isActive: s.is_active,
    }));

    return dto;
  }

  async create(input: CreateActivityDto, actor: ResolvedActor): Promise<ActivityResponseDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can create activities');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO ext_activities (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, max_participants, meeting_location) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9)',
        id,
        tenant.schoolId,
        input.activityTypeId,
        input.name,
        input.description ?? null,
        input.academicYearId,
        input.advisorId ?? null,
        input.maxParticipants ?? null,
        input.meetingLocation ?? null,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateActivityDto,
    actor: ResolvedActor,
  ): Promise<ActivityResponseDto> {
    if (!this.isManager(actor)) {
      throw new ForbiddenException('Only Staff or admins can update activities');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push('name = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push('status = $' + params.length);
    }
    if (input.advisorId !== undefined) {
      params.push(input.advisorId);
      sets.push('advisor_id = $' + params.length + '::uuid');
    }
    if (input.maxParticipants !== undefined) {
      params.push(input.maxParticipants);
      sets.push('max_participants = $' + params.length);
    }
    if (input.meetingLocation !== undefined) {
      params.push(input.meetingLocation);
      sets.push('meeting_location = $' + params.length);
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ext_activities SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('Activity not found');
    return this.getById(id);
  }
}
