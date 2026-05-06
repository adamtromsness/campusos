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
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CreateIepMeetingRecordDto,
  IepMeetingRecordResponseDto,
  UpdateIepMeetingRecordDto,
} from './dto/meeting.dto';

interface IepRecordRow {
  id: string;
  meeting_id: string;
  student_id: string;
  student_name: string | null;
  iep_plan_id: string | null;
  iep_plan_type: string | null;
  iep_plan_status: string | null;
  attendee_roles: Array<{ personId: string; role: string; name: string }>;
  outcomes_summary: string | null;
  next_review_date: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_IEP_RECORD =
  'SELECT r.id::text AS id, r.meeting_id::text AS meeting_id, ' +
  'r.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
  '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  '  WHERE s.id = r.student_id) AS student_name, ' +
  'r.iep_plan_id::text AS iep_plan_id, ' +
  '(SELECT plan_type FROM hlth_iep_plans WHERE id = r.iep_plan_id) AS iep_plan_type, ' +
  '(SELECT status FROM hlth_iep_plans WHERE id = r.iep_plan_id) AS iep_plan_status, ' +
  'r.attendee_roles, r.outcomes_summary, ' +
  "TO_CHAR(r.next_review_date, 'YYYY-MM-DD') AS next_review_date, " +
  'r.recorded_by::text AS recorded_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = r.recorded_by) AS recorded_by_name, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_iep_meeting_records r ';

function rowToDto(r: IepRecordRow): IepMeetingRecordResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    studentId: r.student_id,
    studentName: r.student_name,
    iepPlanId: r.iep_plan_id,
    iepPlanType: r.iep_plan_type,
    iepPlanStatus: r.iep_plan_status,
    attendeeRoles: r.attendee_roles ?? [],
    outcomesSummary: r.outcomes_summary,
    nextReviewDate: r.next_review_date,
    recordedBy: r.recorded_by,
    recordedByName: r.recorded_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class IepMeetingRecordService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * IEP records hold health-sensitive data. Service-layer gate
   * requires admin OR hlt-001:read so non-Health staff can't read
   * IEP meeting records via the meetings surface.
   */
  private async assertHealthAccess(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const hasHealth = await this.permissions.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['hlt-001:read'],
    );
    if (!hasHealth) {
      throw new ForbiddenException('IEP meeting records require hlt-001:read or admin authority');
    }
  }

  async getForMeeting(
    meetingId: string,
    actor: ResolvedActor,
  ): Promise<IepMeetingRecordResponseDto | null> {
    await this.assertHealthAccess(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'WHERE r.meeting_id = $1::uuid', meetingId);
    })) as IepRecordRow[];
    if (rows.length === 0) return null;
    return rowToDto(rows[0]!);
  }

  async list(actor: ResolvedActor): Promise<IepMeetingRecordResponseDto[]> {
    await this.assertHealthAccess(actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'ORDER BY r.created_at DESC LIMIT 200');
    })) as IepRecordRow[];
    return rows.map(rowToDto);
  }

  async create(
    meetingId: string,
    input: CreateIepMeetingRecordDto,
    actor: ResolvedActor,
  ): Promise<IepMeetingRecordResponseDto> {
    await this.assertHealthAccess(actor);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO mtg_iep_meeting_records (id, meeting_id, student_id, iep_plan_id, attendee_roles, outcomes_summary, next_review_date, recorded_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7::date, $8::uuid)',
          id,
          meetingId,
          input.studentId,
          input.iepPlanId ?? null,
          JSON.stringify(input.attendeeRoles ?? []),
          input.outcomesSummary ?? null,
          input.nextReviewDate ?? null,
          actor.accountId,
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException('An IEP record already exists for this meeting');
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'WHERE r.id = $1::uuid', id);
    })) as IepRecordRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateIepMeetingRecordDto,
    actor: ResolvedActor,
  ): Promise<IepMeetingRecordResponseDto> {
    await this.assertHealthAccess(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.iepPlanId !== undefined) {
      params.push(input.iepPlanId);
      sets.push('iep_plan_id = $' + params.length + '::uuid');
    }
    if (input.attendeeRoles !== undefined) {
      params.push(JSON.stringify(input.attendeeRoles));
      sets.push('attendee_roles = $' + params.length + '::jsonb');
    }
    if (input.outcomesSummary !== undefined) {
      params.push(input.outcomesSummary);
      sets.push('outcomes_summary = $' + params.length);
    }
    if (input.nextReviewDate !== undefined) {
      params.push(input.nextReviewDate);
      sets.push('next_review_date = $' + params.length + '::date');
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'WHERE r.id = $1::uuid', id);
      })) as IepRecordRow[];
      if (rows.length === 0) throw new NotFoundException('IEP meeting record not found');
      return rowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE mtg_iep_meeting_records SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    if (updated === 0) throw new NotFoundException('IEP meeting record not found');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'WHERE r.id = $1::uuid', id);
    })) as IepRecordRow[];
    return rowToDto(rows[0]!);
  }
}
