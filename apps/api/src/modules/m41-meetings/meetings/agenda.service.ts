import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { AgendaItemResponseDto, CreateAgendaItemDto, UpdateAgendaItemDto } from './dto/meeting.dto';
import { MeetingService } from './meeting.service';

interface AgendaRow {
  id: string;
  meeting_id: string;
  title: string;
  description: string | null;
  presenter_id: string | null;
  presenter_name: string | null;
  duration_minutes: number | null;
  sort_order: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_AGENDA =
  'SELECT a.id::text AS id, a.meeting_id::text AS meeting_id, ' +
  'a.title, a.description, a.presenter_id::text AS presenter_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = a.presenter_id) AS presenter_name, ' +
  'a.duration_minutes, a.sort_order, a.notes, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_agenda_items a ';

function rowToDto(r: AgendaRow): AgendaItemResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    title: r.title,
    description: r.description,
    presenterId: r.presenter_id,
    presenterName: r.presenter_name,
    durationMinutes: r.duration_minutes,
    sortOrder: r.sort_order,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class AgendaService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly meetings: MeetingService,
  ) {}

  /**
   * REVIEW-CYCLE15 BLOCKING 3. Agenda listing is row-scoped to meeting
   * participants and the organiser. Non-participant non-admin callers
   * receive a collapsed 404 (don't-leak-existence) so a user with
   * mtg-001:read cannot enumerate agenda items for meetings they did
   * not attend.
   */
  async listForMeeting(meetingId: string, actor: ResolvedActor): Promise<AgendaItemResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      const ok = await this.meetings.isParticipantOrOrganiser(meetingId, actor.accountId);
      if (!ok) throw new NotFoundException('Meeting not found');
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_AGENDA + 'WHERE a.meeting_id = $1::uuid ORDER BY a.sort_order ASC, a.created_at ASC',
        meetingId,
      );
    })) as AgendaRow[];
    return rows.map(rowToDto);
  }

  async create(
    meetingId: string,
    input: CreateAgendaItemDto,
    actor: ResolvedActor,
  ): Promise<AgendaItemResponseDto> {
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    if (input.presenterId) {
      await this.meetings.assertAccountInCurrentTenant(input.presenterId, 'presenterId');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO mtg_agenda_items (id, meeting_id, title, description, presenter_id, duration_minutes, sort_order, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8)',
        id,
        meetingId,
        input.title,
        input.description ?? null,
        input.presenterId ?? null,
        input.durationMinutes ?? null,
        input.sortOrder ?? 0,
        input.notes ?? null,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_AGENDA + 'WHERE a.id = $1::uuid', id);
    })) as AgendaRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateAgendaItemDto,
    actor: ResolvedActor,
  ): Promise<AgendaItemResponseDto> {
    const meetingId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT meeting_id::text AS meeting_id FROM mtg_agenda_items WHERE id = $1::uuid',
        id,
      )) as Array<{ meeting_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Agenda item not found');
      return rows[0]!.meeting_id;
    });
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);

    if (input.presenterId) {
      await this.meetings.assertAccountInCurrentTenant(input.presenterId, 'presenterId');
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.title !== undefined) {
      params.push(input.title);
      sets.push('title = $' + params.length);
    }
    if (input.description !== undefined) {
      params.push(input.description);
      sets.push('description = $' + params.length);
    }
    if (input.presenterId !== undefined) {
      params.push(input.presenterId);
      sets.push('presenter_id = $' + params.length + '::uuid');
    }
    if (input.durationMinutes !== undefined) {
      params.push(input.durationMinutes);
      sets.push('duration_minutes = $' + params.length);
    }
    if (input.sortOrder !== undefined) {
      params.push(input.sortOrder);
      sets.push('sort_order = $' + params.length);
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length > 0) {
      sets.push('updated_at = now()');
      params.push(id);
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE mtg_agenda_items SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_AGENDA + 'WHERE a.id = $1::uuid', id);
    })) as AgendaRow[];
    if (rows.length === 0) throw new NotFoundException('Agenda item not found');
    return rowToDto(rows[0]!);
  }

  async remove(id: string, actor: ResolvedActor): Promise<void> {
    const meetingId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT meeting_id::text AS meeting_id FROM mtg_agenda_items WHERE id = $1::uuid',
        id,
      )) as Array<{ meeting_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Agenda item not found');
      return rows[0]!.meeting_id;
    });
    await this.meetings.assertOrganiserOrAdmin(meetingId, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM mtg_agenda_items WHERE id = $1::uuid', id);
    });
  }
}
