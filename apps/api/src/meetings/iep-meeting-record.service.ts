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
   * REVIEW-CYCLE15 BLOCKING 1. IEP records hold health-sensitive data.
   * Authorisation tiers:
   *
   *   - school admin                                      → all records
   *   - counsellor (cou-001:write at the role level)      → write any
   *     record + read records for students on own active caseload
   *   - non-counsellor STAFF + meeting participant        → read only
   *     records for meetings they actually attended (covers nurses /
   *     lead-counsellors / health-team operators with hlt-001:write)
   *   - everyone else                                     → 404
   *
   * Notably this excludes parents (even though Parent holds hlt-001:read
   * for the child health summary surface), teachers (who continue to
   * use the ADR-030 sis_student_active_accommodations read model),
   * and students.
   */
  async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  /**
   * Returns true when the actor is allowed to READ the IEP record for
   * the given meeting, given the student under that record. Counsellors
   * are restricted to their active caseload students; non-counsellor
   * staff are restricted to meetings they actually participated in.
   */
  private async canReadRecord(
    actor: ResolvedActor,
    meetingId: string,
    studentId: string,
  ): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (await this.hasCounsellorScope(actor)) {
      // Counsellor: limit to own active caseload students. employeeId
      // is required because svc_caseloads.counselor_id is hr_employees.id.
      if (!actor.employeeId) return false;
      const tenant = getCurrentTenant();
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM svc_caseloads ' +
            "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' " +
            'AND school_id = $3::uuid LIMIT 1',
          actor.employeeId,
          studentId,
          tenant.schoolId,
        );
      })) as Array<unknown>;
      return rows.length > 0;
    }
    // Non-counsellor staff with hlt-001:read AND meeting participation
    // covers nurses + lead counsellors who join an IEP meeting as
    // health-team operators. Parents and teachers fall through here
    // because they do not satisfy the participation predicate via the
    // intended IEP-meeting flow (parents attend through a separate
    // parent-summary surface, teachers via the ADR-030 read model).
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    const hasHealth = await this.permissions.hasAnyPermissionInTenant(
      actor.accountId,
      tenant.schoolId,
      ['hlt-001:read'],
    );
    if (!hasHealth) return false;
    const partRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM mtg_meeting_participants ' +
          'WHERE meeting_id = $1::uuid AND participant_id = $2::uuid LIMIT 1',
        meetingId,
        actor.accountId,
      );
    })) as Array<unknown>;
    return partRows.length > 0;
  }

  async getForMeeting(
    meetingId: string,
    actor: ResolvedActor,
  ): Promise<IepMeetingRecordResponseDto | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'WHERE r.meeting_id = $1::uuid', meetingId);
    })) as IepRecordRow[];
    if (rows.length === 0) return null;
    const dto = rowToDto(rows[0]!);
    if (!(await this.canReadRecord(actor, meetingId, dto.studentId))) {
      // Don't leak existence to non-authorised callers
      throw new NotFoundException('IEP meeting record not found');
    }
    return dto;
  }

  async list(actor: ResolvedActor): Promise<IepMeetingRecordResponseDto[]> {
    if (actor.isSchoolAdmin) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_IEP_RECORD + 'ORDER BY r.created_at DESC LIMIT 200');
      })) as IepRecordRow[];
      return rows.map(rowToDto);
    }
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Listing IEP meeting records requires admin or counsellor authority',
      );
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Counsellor IEP record list requires an hr_employees identity');
    }
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_IEP_RECORD +
          'WHERE r.student_id IN (' +
          '  SELECT student_id FROM svc_caseloads ' +
          "  WHERE counselor_id = $1::uuid AND status = 'ACTIVE' AND school_id = $2::uuid" +
          ') ORDER BY r.created_at DESC LIMIT 200',
        actor.employeeId,
        tenant.schoolId,
      );
    })) as IepRecordRow[];
    return rows.map(rowToDto);
  }

  async create(
    meetingId: string,
    input: CreateIepMeetingRecordDto,
    actor: ResolvedActor,
  ): Promise<IepMeetingRecordResponseDto> {
    // Write authority is admin OR counsellor (cou-001:write). Non-
    // counsellor staff with hlt-001:read can read records they
    // attended but cannot create or edit them.
    if (!actor.isSchoolAdmin && !(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only admins or counsellors can create IEP meeting records');
    }
    // Counsellors creating a record must own the student's active
    // caseload. Admin bypass.
    if (!actor.isSchoolAdmin && actor.employeeId) {
      const tenant = getCurrentTenant();
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM svc_caseloads ' +
            "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' " +
            'AND school_id = $3::uuid LIMIT 1',
          actor.employeeId,
          input.studentId,
          tenant.schoolId,
        );
      })) as Array<unknown>;
      if (rows.length === 0) {
        throw new ForbiddenException(
          'Counsellor can only create IEP meeting records for students on their active caseload',
        );
      }
    }
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
    // Patch authority mirrors create — admin OR counsellor with the
    // student on own active caseload. Look the row up first so we can
    // pin the scope check to the resolved student_id.
    const lookupRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT meeting_id::text AS meeting_id, student_id::text AS student_id FROM mtg_iep_meeting_records WHERE id = $1::uuid',
        id,
      );
    })) as Array<{ meeting_id: string; student_id: string }>;
    if (lookupRows.length === 0) throw new NotFoundException('IEP meeting record not found');

    if (!actor.isSchoolAdmin) {
      if (!(await this.hasCounsellorScope(actor))) {
        throw new ForbiddenException('Only admins or counsellors can edit IEP meeting records');
      }
      if (!actor.employeeId) {
        throw new ForbiddenException('Edit requires an hr_employees identity');
      }
      const tenant = getCurrentTenant();
      const ownsCaseload = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 FROM svc_caseloads ' +
            "WHERE counselor_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE' " +
            'AND school_id = $3::uuid LIMIT 1',
          actor.employeeId,
          lookupRows[0]!.student_id,
          tenant.schoolId,
        );
      })) as Array<unknown>;
      if (ownsCaseload.length === 0) {
        throw new ForbiddenException(
          'Counsellor can only edit IEP meeting records for students on their active caseload',
        );
      }
    }

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
