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
  ConferenceEventResponseDto,
  ConferenceStatus,
  ConferenceType,
  CreateConferenceEventDto,
  UpdateConferenceEventDto,
} from './dto/meeting.dto';

interface ConferenceRow {
  id: string;
  school_id: string;
  title: string;
  description: string | null;
  conference_type: string;
  start_date: string;
  end_date: string;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  meeting_count: number;
  total_slots: number;
  booked_slots: number;
}

const SELECT_CONFERENCE =
  'SELECT c.id::text AS id, c.school_id::text AS school_id, c.title, c.description, ' +
  "c.conference_type, TO_CHAR(c.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(c.end_date, 'YYYY-MM-DD') AS end_date, c.status, " +
  'c.created_by::text AS created_by, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at, ' +
  '(SELECT COUNT(*)::int FROM mtg_meetings m WHERE m.conference_event_id = c.id) AS meeting_count, ' +
  '(SELECT COUNT(*)::int FROM mtg_meeting_slots s ' +
  '  JOIN mtg_meetings m ON m.id = s.meeting_id ' +
  '  WHERE m.conference_event_id = c.id) AS total_slots, ' +
  '(SELECT COUNT(*)::int FROM mtg_meeting_slots s ' +
  '  JOIN mtg_meetings m ON m.id = s.meeting_id ' +
  '  WHERE m.conference_event_id = c.id AND s.is_booked = true) AS booked_slots ' +
  'FROM mtg_conference_events c ';

function rowToDto(r: ConferenceRow): ConferenceEventResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    title: r.title,
    description: r.description,
    conferenceType: r.conference_type as ConferenceType,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status as ConferenceStatus,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    meetingCount: r.meeting_count ?? 0,
    totalSlots: r.total_slots ?? 0,
    bookedSlots: r.booked_slots ?? 0,
  };
}

@Injectable()
export class ConferenceService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(): Promise<ConferenceEventResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CONFERENCE + 'WHERE c.school_id = $1::uuid ORDER BY c.start_date DESC LIMIT 200',
        tenant.schoolId,
      );
    })) as ConferenceRow[];
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<ConferenceEventResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CONFERENCE + 'WHERE c.id = $1::uuid AND c.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as ConferenceRow[];
    if (rows.length === 0) throw new NotFoundException('Conference event not found');
    return rowToDto(rows[0]!);
  }

  async create(
    input: CreateConferenceEventDto,
    actor: ResolvedActor,
  ): Promise<ConferenceEventResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create conference events');
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO mtg_conference_events ' +
          '(id, school_id, title, description, conference_type, start_date, end_date, status, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, 'SCHEDULED', $8::uuid)",
        id,
        tenant.schoolId,
        input.title,
        input.description ?? null,
        input.conferenceType,
        input.startDate,
        input.endDate,
        actor.accountId,
      );
    });
    return this.getById(id);
  }

  async patch(
    id: string,
    input: UpdateConferenceEventDto,
    actor: ResolvedActor,
  ): Promise<ConferenceEventResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can edit conference events');
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
    if (input.status !== undefined) {
      params.push(input.status);
      sets.push('status = $' + params.length);
    }
    if (input.startDate !== undefined) {
      params.push(input.startDate);
      sets.push('start_date = $' + params.length + '::date');
    }
    if (input.endDate !== undefined) {
      params.push(input.endDate);
      sets.push('end_date = $' + params.length + '::date');
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    try {
      const updated = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE mtg_conference_events SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      });
      if (updated === 0) throw new NotFoundException('Conference event not found');
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === '23514' || err.meta?.code === '23514') {
        throw new BadRequestException(
          'Conference event update violates a CHECK constraint (status / dates).',
        );
      }
      throw e;
    }
    return this.getById(id);
  }
}
