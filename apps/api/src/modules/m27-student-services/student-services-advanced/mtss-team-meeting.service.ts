import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateMtssTeamMeetingDto,
  MtssDiscussionRecommendation,
  MtssStudentDiscussionResponseDto,
  MtssTeamMeetingResponseDto,
  RecordStudentDiscussionDto,
} from './dto/student-services-advanced.dto';

interface MeetingRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  meeting_date: Date;
  facilitated_by: string;
  facilitated_by_name: string | null;
  linked_meeting_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DiscussionRow {
  id: string;
  team_meeting_id: string;
  student_id: string;
  student_name: string | null;
  tier_id: string | null;
  tier_label: string | null;
  outcome: string | null;
  outcome_notes: string | null;
  created_at: Date;
}

const SELECT_MEETING =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, ' +
  'm.academic_year_id::text AS academic_year_id, m.meeting_date, ' +
  'm.facilitated_by::text AS facilitated_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = m.facilitated_by) AS facilitated_by_name, ' +
  'm.meeting_id::text AS linked_meeting_id, m.notes, m.created_at, m.updated_at ' +
  'FROM svc_mtss_team_meetings m ';

const SELECT_DISCUSSION =
  'SELECT d.id::text AS id, d.team_meeting_id::text AS team_meeting_id, ' +
  'd.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM sis_students s " +
  '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  '  JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  '  WHERE s.id = d.student_id) AS student_name, ' +
  'd.tier_id::text AS tier_id, ' +
  '(SELECT t.tier_level FROM svc_mtss_tiers t WHERE t.id = d.tier_id) AS tier_label, ' +
  'd.outcome, d.outcome_notes, d.created_at ' +
  'FROM svc_mtss_team_meeting_students d ';

const RECOMMENDATION_TO_OUTCOME: Record<MtssDiscussionRecommendation, string> = {
  MAINTAIN: 'NO_CHANGE',
  ESCALATE: 'TIER_UP',
  DE_ESCALATE: 'TIER_DOWN',
};

const OUTCOME_TO_RECOMMENDATION: Record<string, MtssDiscussionRecommendation | null> = {
  NO_CHANGE: 'MAINTAIN',
  TIER_UP: 'ESCALATE',
  TIER_DOWN: 'DE_ESCALATE',
  EXIT: null,
  CONTINUE_WITH_ADJUSTMENT: null,
};

/**
 * MtssTeamMeetingService — P2-28c MTSS team-meeting coordination on
 * top of the Cycle 11 svc_mtss_team_meetings + svc_mtss_team_meeting
 * _students tables. Adds the per-(meeting, student) discussion record
 * with the 3-value recommendation token (MAINTAIN / ESCALATE /
 * DE_ESCALATE) that maps onto the existing 5-value outcome enum
 * (NO_CHANGE / TIER_UP / TIER_DOWN) at the service layer.
 *
 * The existing Cycle 11 schema's outcome column stays the source of
 * truth — the recommendation is the simpler tri-state surface the
 * P2-28c plan calls for. EXIT and CONTINUE_WITH_ADJUSTMENT remain
 * available via the legacy MTSS controller; they round-trip as null
 * recommendation on the new API surface.
 *
 * Authorisation: staff + admin only at the service layer.
 */
@Injectable()
export class MtssTeamMeetingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('MTSS team meetings are staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async list(actor: ResolvedActor): Promise<MtssTeamMeetingResponseDto[]> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEETING +
          'WHERE m.school_id = $1::uuid ORDER BY m.meeting_date DESC, m.created_at DESC',
        tenant.schoolId,
      );
    })) as MeetingRow[];
    return rows.map((r) => this.meetingToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<MtssTeamMeetingResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<MtssTeamMeetingResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEETING + 'WHERE m.id = $1::uuid AND m.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as MeetingRow[];
    if (rows.length === 0) throw new NotFoundException('MTSS team meeting not found');
    return this.meetingToDto(rows[0]!);
  }

  async create(
    input: CreateMtssTeamMeetingDto,
    actor: ResolvedActor,
  ): Promise<MtssTeamMeetingResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_mtss_team_meetings (id, school_id, meeting_id, academic_year_id, ' +
          'facilitated_by, meeting_date, notes) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7)',
        id,
        tenant.schoolId,
        input.meetingId ?? null,
        input.academicYearId,
        actor.employeeId,
        input.meetingDate,
        input.notes ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  async recordDiscussion(
    teamMeetingId: string,
    input: RecordStudentDiscussionDto,
    actor: ResolvedActor,
  ): Promise<MtssStudentDiscussionResponseDto> {
    this.assertStaff(actor);
    // Verify meeting exists in current school
    await this.loadOrFail(teamMeetingId);

    const id = generateId();
    const outcomeValue =
      input.tierChangeRecommended !== undefined
        ? RECOMMENDATION_TO_OUTCOME[input.tierChangeRecommended]
        : null;

    const tenant = getCurrentTenant();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // REVIEW-P2C28 Round 1 BLOCKING 8 — student must belong to
        // the current school. Cross-school student UUIDs would
        // otherwise land on a School A MTSS agenda.
        const studentRows = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
          input.studentId,
          tenant.schoolId,
        )) as Array<{ ok: number }>;
        if (studentRows.length === 0) {
          throw new BadRequestException('studentId does not match a student in this school');
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO svc_mtss_team_meeting_students (id, team_meeting_id, student_id, ' +
            'tier_id, outcome, outcome_notes) VALUES ($1::uuid, $2::uuid, $3::uuid, ' +
            '$4::uuid, $5, $6)',
          id,
          teamMeetingId,
          input.studentId,
          input.tierId ?? null,
          outcomeValue,
          input.discussionNotes ?? null,
        );
      });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === '23505' || /unique constraint/i.test(e?.message ?? '')) {
        throw new BadRequestException(
          'Student already on this team meeting agenda. PATCH the existing row instead.',
        );
      }
      throw err;
    }

    // REVIEW-P2C28 BLOCKING 8 — reload JOINs parent meeting for
    // school predicate (defence-in-depth on top of the FOR UPDATE
    // school-scope on the parent).
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_DISCUSSION +
          'JOIN svc_mtss_team_meetings m2 ON m2.id = d.team_meeting_id ' +
          'WHERE d.id = $1::uuid AND m2.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as DiscussionRow[];
    return this.discussionToDto(rows[0]!);
  }

  async listDiscussions(
    teamMeetingId: string,
    actor: ResolvedActor,
  ): Promise<MtssStudentDiscussionResponseDto[]> {
    this.assertStaff(actor);
    await this.loadOrFail(teamMeetingId);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_DISCUSSION + 'WHERE d.team_meeting_id = $1::uuid ORDER BY d.created_at ASC',
        teamMeetingId,
      );
    })) as DiscussionRow[];
    return rows.map((r) => this.discussionToDto(r));
  }

  private meetingToDto(r: MeetingRow): MtssTeamMeetingResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      academicYearId: r.academic_year_id,
      meetingDate: r.meeting_date.toISOString().slice(0, 10),
      facilitatedBy: r.facilitated_by,
      facilitatedByName: r.facilitated_by_name,
      linkedMeetingId: r.linked_meeting_id,
      notes: r.notes,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  private discussionToDto(r: DiscussionRow): MtssStudentDiscussionResponseDto {
    const recommendation = r.outcome ? (OUTCOME_TO_RECOMMENDATION[r.outcome] ?? null) : null;
    return {
      id: r.id,
      teamMeetingId: r.team_meeting_id,
      studentId: r.student_id,
      studentName: r.student_name,
      tierId: r.tier_id,
      tierLabel: r.tier_label,
      tierChangeRecommended: recommendation,
      discussionNotes: r.outcome_notes,
      createdAt: r.created_at.toISOString(),
    };
  }
}
