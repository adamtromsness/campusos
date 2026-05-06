import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateMeetingNotesDto,
  MeetingNotesResponseDto,
  UpdateMeetingNotesDto,
} from './dto/meeting.dto';
import { MeetingService } from './meeting.service';

interface NotesRow {
  id: string;
  meeting_id: string;
  notes_text: string | null;
  is_approved: boolean;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  is_parent_visible: boolean;
  parent_visible_summary: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_NOTES =
  'SELECT n.id::text AS id, n.meeting_id::text AS meeting_id, n.notes_text, ' +
  'n.is_approved, n.approved_by::text AS approved_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = n.approved_by) AS approved_by_name, ' +
  'TO_CHAR(n.approved_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS approved_at, ' +
  'n.is_parent_visible, n.parent_visible_summary, n.created_by::text AS created_by, ' +
  'TO_CHAR(n.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(n.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_meeting_notes n ';

function rowToDto(r: NotesRow): MeetingNotesResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    notesText: r.notes_text,
    isApproved: r.is_approved,
    approvedBy: r.approved_by,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    isParentVisible: r.is_parent_visible,
    parentVisibleSummary: r.parent_visible_summary,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class MeetingNotesService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly meetings: MeetingService,
  ) {}

  /**
   * PARENT-VISIBILITY GATE.
   *   - Staff (admin / non-GUARDIAN non-STUDENT) sees full notes_text.
   *   - GUARDIAN sees parent_visible_summary if provided, otherwise
   *     full notes_text — but only when BOTH is_parent_visible=true
   *     AND is_approved=true. Otherwise returns null.
   *   - STUDENT sees nothing (returns null).
   */
  async getForMeeting(
    meetingId: string,
    actor: ResolvedActor,
  ): Promise<MeetingNotesResponseDto | null> {
    // Caller must be a participant or organiser or admin
    if (!actor.isSchoolAdmin) {
      const ok = await this.meetings.isParticipantOrOrganiser(meetingId, actor.accountId);
      if (!ok) throw new NotFoundException('Meeting not found');
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_NOTES + 'WHERE n.meeting_id = $1::uuid', meetingId);
    })) as NotesRow[];
    if (rows.length === 0) return null;
    const dto = rowToDto(rows[0]!);

    if (actor.personType === 'STUDENT') return null;

    if (actor.personType === 'GUARDIAN') {
      if (!dto.isParentVisible || !dto.isApproved) return null;
      // Parent sees parent_visible_summary if provided, otherwise the
      // full notes_text. Strip parent-irrelevant approval metadata.
      return {
        ...dto,
        notesText: dto.parentVisibleSummary ? null : dto.notesText,
        // approved_by + approved_by_name + approved_at remain visible to
        // confirm the parent is reading approved notes
      };
    }

    // Staff / admin — full notes
    return dto;
  }

  async upsert(
    meetingId: string,
    input: CreateMeetingNotesDto,
    actor: ResolvedActor,
  ): Promise<MeetingNotesResponseDto> {
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO mtg_meeting_notes ' +
          '(id, meeting_id, notes_text, is_parent_visible, parent_visible_summary, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid) ' +
          'ON CONFLICT (meeting_id) DO UPDATE SET ' +
          '  notes_text = EXCLUDED.notes_text, ' +
          '  is_parent_visible = EXCLUDED.is_parent_visible, ' +
          '  parent_visible_summary = EXCLUDED.parent_visible_summary, ' +
          '  updated_at = now()',
        id,
        meetingId,
        input.notesText ?? null,
        input.isParentVisible ?? false,
        input.parentVisibleSummary ?? null,
        actor.accountId,
      );
    });
    return this.getRawForMeeting(meetingId);
  }

  async patch(
    notesId: string,
    input: UpdateMeetingNotesDto,
    actor: ResolvedActor,
  ): Promise<MeetingNotesResponseDto> {
    const meetingId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT meeting_id::text AS meeting_id FROM mtg_meeting_notes WHERE id = $1::uuid',
        notesId,
      )) as Array<{ meeting_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Notes not found');
      return rows[0]!.meeting_id;
    });
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.notesText !== undefined) {
      params.push(input.notesText);
      sets.push('notes_text = $' + params.length);
    }
    if (input.isParentVisible !== undefined) {
      params.push(input.isParentVisible);
      sets.push('is_parent_visible = $' + params.length);
    }
    if (input.parentVisibleSummary !== undefined) {
      params.push(input.parentVisibleSummary);
      sets.push('parent_visible_summary = $' + params.length);
    }
    if (sets.length === 0) return this.getRawForMeeting(meetingId);
    sets.push('updated_at = now()');
    params.push(notesId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE mtg_meeting_notes SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    return this.getRawForMeeting(meetingId);
  }

  /**
   * Approve keystone — multi-column approved_chk lockstep stamps
   * all three columns atomically. Refuses re-approval since
   * approval is irreversible by design (matches the BIP / locked-
   * note pattern across other cycles).
   */
  async approve(notesId: string, actor: ResolvedActor): Promise<MeetingNotesResponseDto> {
    const meetingId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, meeting_id::text AS meeting_id, is_approved FROM mtg_meeting_notes WHERE id = $1::uuid FOR UPDATE',
        notesId,
      )) as Array<{ id: string; meeting_id: string; is_approved: boolean }>;
      if (lock.length === 0) throw new NotFoundException('Notes not found');
      if (lock[0]!.is_approved) {
        throw new BadRequestException('Notes are already approved (irreversible)');
      }
      // Verify caller is organiser/admin via meeting service (locks
      // happen on the notes row already)
      if (!actor.isSchoolAdmin) {
        const m = (await tx.$queryRawUnsafe(
          'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
          lock[0]!.meeting_id,
        )) as Array<{ organiser_id: string }>;
        if (m.length === 0 || m[0]!.organiser_id !== actor.accountId) {
          throw new ForbiddenException('Only the meeting organiser or an admin can approve notes');
        }
      }
      await tx.$executeRawUnsafe(
        'UPDATE mtg_meeting_notes SET is_approved = true, approved_by = $1::uuid, approved_at = now(), updated_at = now() WHERE id = $2::uuid',
        actor.accountId,
        notesId,
      );
      return lock[0]!.meeting_id;
    });
    return this.getRawForMeeting(meetingId);
  }

  private async getRawForMeeting(meetingId: string): Promise<MeetingNotesResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_NOTES + 'WHERE n.meeting_id = $1::uuid', meetingId);
    })) as NotesRow[];
    if (rows.length === 0) throw new NotFoundException('Notes not found');
    return rowToDto(rows[0]!);
  }
}
