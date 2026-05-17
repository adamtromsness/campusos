import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import {
  AddParticipantDto,
  CreateMeetingDto,
  MeetingParticipantResponseDto,
  MeetingResponseDto,
  MeetingStatus,
  ParticipantRole,
  UpdateMeetingDto,
} from './dto/meeting.dto';

interface MeetingRow {
  id: string;
  school_id: string;
  meeting_type_id: string;
  meeting_type_name: string | null;
  conference_event_id: string | null;
  conference_event_title: string | null;
  title: string;
  description: string | null;
  scheduled_at: string;
  duration_minutes: number;
  meeting_url: string | null;
  status: string;
  organiser_id: string;
  organiser_name: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ParticipantRow {
  id: string;
  meeting_id: string;
  participant_id: string;
  participant_name: string | null;
  role: string;
  attended: boolean;
  join_at: string | null;
  leave_at: string | null;
  notes: string | null;
}

const SELECT_MEETING =
  'SELECT m.id::text AS id, m.school_id::text AS school_id, ' +
  'm.meeting_type_id::text AS meeting_type_id, t.name AS meeting_type_name, ' +
  'm.conference_event_id::text AS conference_event_id, c.title AS conference_event_title, ' +
  'm.title, m.description, ' +
  'TO_CHAR(m.scheduled_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS scheduled_at, ' +
  'm.duration_minutes, m.meeting_url, m.status, ' +
  'm.organiser_id::text AS organiser_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = m.organiser_id) AS organiser_name, ' +
  'TO_CHAR(m.started_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS started_at, ' +
  'TO_CHAR(m.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'TO_CHAR(m.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(m.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM mtg_meetings m ' +
  'JOIN mtg_meeting_types t ON t.id = m.meeting_type_id ' +
  'LEFT JOIN mtg_conference_events c ON c.id = m.conference_event_id ';

const SELECT_PARTICIPANT =
  'SELECT p.id::text AS id, p.meeting_id::text AS meeting_id, ' +
  'p.participant_id::text AS participant_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = p.participant_id) AS participant_name, ' +
  'p.role, p.attended, ' +
  'TO_CHAR(p.join_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS join_at, ' +
  'TO_CHAR(p.leave_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS leave_at, ' +
  'p.notes ' +
  'FROM mtg_meeting_participants p ';

function meetingRowToDto(r: MeetingRow): MeetingResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    meetingTypeId: r.meeting_type_id,
    meetingTypeName: r.meeting_type_name,
    conferenceEventId: r.conference_event_id,
    conferenceEventTitle: r.conference_event_title,
    title: r.title,
    description: r.description,
    scheduledAt: r.scheduled_at,
    durationMinutes: r.duration_minutes,
    meetingUrl: r.meeting_url,
    status: r.status as MeetingStatus,
    organiserId: r.organiser_id,
    organiserName: r.organiser_name,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function participantRowToDto(r: ParticipantRow): MeetingParticipantResponseDto {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    participantId: r.participant_id,
    participantName: r.participant_name,
    role: r.role as ParticipantRole,
    attended: r.attended,
    joinAt: r.join_at,
    leaveAt: r.leave_at,
    notes: r.notes,
  };
}

@Injectable()
export class MeetingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Visibility — admin sees all; everyone else sees meetings where
   * they are organiser OR an active participant.
   */
  private buildVisibility(
    actor: ResolvedActor,
    nextParam: number,
  ): { sql: string; params: unknown[] } {
    if (actor.isSchoolAdmin) return { sql: '', params: [] };
    return {
      sql:
        'AND (m.organiser_id = $' +
        nextParam +
        '::uuid OR EXISTS (SELECT 1 FROM mtg_meeting_participants pp WHERE pp.meeting_id = m.id AND pp.participant_id = $' +
        nextParam +
        '::uuid)) ',
      params: [actor.accountId],
    };
  }

  async list(
    filters: {
      fromDate?: string;
      toDate?: string;
      status?: MeetingStatus;
      conferenceEventId?: string;
    },
    actor: ResolvedActor,
  ): Promise<MeetingResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_MEETING, 'WHERE m.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];

    const visibility = this.buildVisibility(actor, params.length + 1);
    if (visibility.sql) {
      sql.push(visibility.sql);
      params.push(...visibility.params);
    }

    if (filters.fromDate) {
      params.push(filters.fromDate);
      sql.push('AND m.scheduled_at >= $' + params.length + '::timestamptz ');
    }
    if (filters.toDate) {
      params.push(filters.toDate);
      sql.push('AND m.scheduled_at <= $' + params.length + '::timestamptz ');
    }
    if (filters.status) {
      params.push(filters.status);
      sql.push('AND m.status = $' + params.length + ' ');
    }
    if (filters.conferenceEventId) {
      params.push(filters.conferenceEventId);
      sql.push('AND m.conference_event_id = $' + params.length + '::uuid ');
    }
    sql.push('ORDER BY m.scheduled_at DESC LIMIT 500');

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql.join(''), ...params);
    })) as MeetingRow[];
    return rows.map(meetingRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<MeetingResponseDto> {
    const tenant = getCurrentTenant();
    const sql: string[] = [SELECT_MEETING, 'WHERE m.id = $1::uuid AND m.school_id = $2::uuid '];
    const params: unknown[] = [id, tenant.schoolId];

    const visibility = this.buildVisibility(actor, params.length + 1);
    if (visibility.sql) {
      sql.push(visibility.sql);
      params.push(...visibility.params);
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql.join(''), ...params);
    })) as MeetingRow[];
    if (rows.length === 0) throw new NotFoundException('Meeting not found');

    const dto = meetingRowToDto(rows[0]!);
    dto.participants = await this.listParticipants(id);
    return dto;
  }

  /**
   * Internal getter for service-to-service use that bypasses the
   * actor-aware row scope. The Step 5 services (notes, action items,
   * recording, IEP record) call this when they have already verified
   * caller scope through their own gate.
   */
  async loadOrFail(id: string): Promise<MeetingResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_MEETING + 'WHERE m.id = $1::uuid AND m.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as MeetingRow[];
    if (rows.length === 0) throw new NotFoundException('Meeting not found');
    return meetingRowToDto(rows[0]!);
  }

  async listParticipants(meetingId: string): Promise<MeetingParticipantResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PARTICIPANT + 'WHERE p.meeting_id = $1::uuid ORDER BY p.role ASC',
        meetingId,
      );
    })) as ParticipantRow[];
    return rows.map(participantRowToDto);
  }

  async isParticipantOrOrganiser(meetingId: string, accountId: string): Promise<boolean> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 FROM mtg_meetings m WHERE m.id = $1::uuid AND m.organiser_id = $2::uuid ' +
          'UNION SELECT 1 FROM mtg_meeting_participants p WHERE p.meeting_id = $1::uuid AND p.participant_id = $2::uuid',
        meetingId,
        accountId,
      );
    })) as Array<unknown>;
    return rows.length > 0;
  }

  async create(input: CreateMeetingDto, actor: ResolvedActor): Promise<MeetingResponseDto> {
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Only staff or admins can create meetings');
    }
    // REVIEW-CYCLE15 MAJOR 4. Tenant-validate every request-supplied
    // participantId so a tenant A admin cannot land a meeting roster
    // on a tenant B user by guessing UUIDs.
    if (input.participantIds && input.participantIds.length > 0) {
      for (const pid of input.participantIds) {
        if (pid === actor.accountId) continue;
        await this.assertAccountInCurrentTenant(pid, 'participantId');
      }
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO mtg_meetings ' +
          '(id, school_id, meeting_type_id, conference_event_id, title, description, scheduled_at, duration_minutes, meeting_url, status, organiser_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8, $9, 'SCHEDULED', $10::uuid)",
        id,
        tenant.schoolId,
        input.meetingTypeId,
        input.conferenceEventId ?? null,
        input.title,
        input.description ?? null,
        input.scheduledAt,
        input.durationMinutes,
        input.meetingUrl ?? null,
        actor.accountId,
      );

      // Auto-add organiser as HOST participant
      await tx.$executeRawUnsafe(
        'INSERT INTO mtg_meeting_participants (id, meeting_id, participant_id, role) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'HOST') " +
          'ON CONFLICT (meeting_id, participant_id) DO NOTHING',
        generateId(),
        id,
        actor.accountId,
      );

      if (input.participantIds && input.participantIds.length > 0) {
        for (const pid of input.participantIds) {
          if (pid === actor.accountId) continue;
          await tx.$executeRawUnsafe(
            'INSERT INTO mtg_meeting_participants (id, meeting_id, participant_id, role) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATTENDEE') " +
              'ON CONFLICT (meeting_id, participant_id) DO NOTHING',
            generateId(),
            id,
            pid,
          );
        }
      }

      // P2-H3 Step 2 — mtg.meeting.scheduled migrated from best-effort
      // post-commit emit to durable outbox in-tx. Meeting creation drives
      // downstream IEP/MTSS workflow rows + notifications; a broker
      // outage between INSERT and emit would silently leave downstream
      // workers without their trigger event.
      await this.outbox.enqueueInTx(tx, {
        topic: 'mtg.meeting.scheduled',
        key: id,
        sourceModule: 'meetings',
        payload: {
          meetingId: id,
          schoolId: tenant.schoolId,
          meetingTypeId: input.meetingTypeId,
          conferenceEventId: input.conferenceEventId ?? null,
          title: input.title,
          scheduledAt: input.scheduledAt,
          durationMinutes: input.durationMinutes,
          organiserId: actor.accountId,
          sourceRefId: id,
        },
      });
    });

    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateMeetingDto,
    actor: ResolvedActor,
  ): Promise<MeetingResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, organiser_id::text AS organiser_id, status FROM mtg_meetings WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; organiser_id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Meeting not found');
      if (!actor.isSchoolAdmin && lock[0]!.organiser_id !== actor.accountId) {
        throw new ForbiddenException('Only the organiser or an admin can edit this meeting');
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
      if (input.scheduledAt !== undefined) {
        params.push(input.scheduledAt);
        sets.push('scheduled_at = $' + params.length + '::timestamptz');
      }
      if (input.durationMinutes !== undefined) {
        params.push(input.durationMinutes);
        sets.push('duration_minutes = $' + params.length);
      }
      if (input.meetingUrl !== undefined) {
        params.push(input.meetingUrl);
        sets.push('meeting_url = $' + params.length);
      }
      if (input.status !== undefined) {
        params.push(input.status);
        sets.push('status = $' + params.length);
        if (input.status === 'IN_PROGRESS') {
          sets.push('started_at = COALESCE(started_at, now())');
        } else if (input.status === 'COMPLETED') {
          sets.push('completed_at = COALESCE(completed_at, now())');
        }
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE mtg_meetings SET ' + sets.join(', ') + ' WHERE id = $' + params.length + '::uuid',
        ...params,
      );
    });
    return this.getById(id, actor);
  }

  async addParticipant(
    meetingId: string,
    input: AddParticipantDto,
    actor: ResolvedActor,
  ): Promise<MeetingParticipantResponseDto> {
    await this.assertOrganiserOrAdmin(meetingId, actor);
    await this.assertAccountInCurrentTenant(input.participantId, 'participantId');
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO mtg_meeting_participants (id, meeting_id, participant_id, role) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
          id,
          meetingId,
          input.participantId,
          input.role ?? 'ATTENDEE',
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23505') {
        throw new BadRequestException('Participant is already on this meeting');
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PARTICIPANT + 'WHERE p.id = $1::uuid', id);
    })) as ParticipantRow[];
    return participantRowToDto(rows[0]!);
  }

  async removeParticipant(participantId: string, actor: ResolvedActor): Promise<void> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT meeting_id::text AS meeting_id FROM mtg_meeting_participants WHERE id = $1::uuid',
        participantId,
      );
    })) as Array<{ meeting_id: string }>;
    if (rows.length === 0) throw new NotFoundException('Participant not found');
    await this.assertOrganiserOrAdmin(rows[0]!.meeting_id, actor);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'DELETE FROM mtg_meeting_participants WHERE id = $1::uuid',
        participantId,
      );
    });
  }

  async assertOrganiserOrAdmin(meetingId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT organiser_id::text AS organiser_id FROM mtg_meetings WHERE id = $1::uuid',
        meetingId,
      );
    })) as Array<{ organiser_id: string }>;
    if (rows.length === 0) throw new NotFoundException('Meeting not found');
    if (rows[0]!.organiser_id !== actor.accountId) {
      throw new ForbiddenException('Only the meeting organiser or an admin can do this');
    }
  }

  /**
   * REVIEW-CYCLE15 MAJOR 4. Validate that a request-supplied
   * platform_users.id has a projection in the current tenant
   * (sis_students / sis_guardians / hr_employees). Mirrors the
   * Cycle 6.1 Profile + Cycle 7 Task patterns. Throws 400 with the
   * specified field-name in the message when the lookup misses.
   */
  async assertAccountInCurrentTenant(accountId: string, fieldName: string): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM platform.platform_users pu WHERE pu.id = $1::uuid AND ( ' +
          'EXISTS (SELECT 1 FROM sis_students s ' +
          '        JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          '        WHERE ps.person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM sis_guardians WHERE person_id = pu.person_id) ' +
          'OR EXISTS (SELECT 1 FROM hr_employees WHERE person_id = pu.person_id)) LIMIT 1',
        accountId,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException(fieldName + ' does not belong to a user in this school');
    }
  }
}
