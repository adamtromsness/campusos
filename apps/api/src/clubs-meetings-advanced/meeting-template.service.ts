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
  CreateMeetingFromTemplateDto,
  CreateMeetingTemplateDto,
  MeetingTemplateResponseDto,
  TemplateAgendaItemInputDto,
  UpdateMeetingTemplateDto,
} from './dto/clubs-meetings-advanced.dto';

interface TemplateRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  meeting_type_id: string | null;
  meeting_type_name: string | null;
  default_duration_minutes: number;
  default_agenda: unknown;
  created_by: string;
  created_by_name: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

const SELECT_TEMPLATE =
  'SELECT t.id::text AS id, t.school_id::text AS school_id, t.name, t.description, ' +
  't.meeting_type_id::text AS meeting_type_id, ' +
  '(SELECT mt.name FROM mtg_meeting_types mt WHERE mt.id = t.meeting_type_id) AS meeting_type_name, ' +
  't.default_duration_minutes, t.default_agenda, ' +
  't.created_by::text AS created_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM hr_employees e " +
  '  JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  '  WHERE e.id = t.created_by) AS created_by_name, ' +
  't.is_active, t.created_at, t.updated_at ' +
  'FROM mtg_meeting_templates t ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' || e?.meta?.code === '23505' || /unique constraint/i.test(e?.message ?? '')
  );
}

function parseAgenda(raw: unknown): TemplateAgendaItemInputDto[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as TemplateAgendaItemInputDto[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * MeetingTemplateService — P2-28b Step 4.
 *
 * Reusable meeting templates. UNIQUE(school_id, name) caps the
 * catalogue at one row per name. The keystone is createMeetingFrom-
 * Template: it INSERTs a new mtg_meetings row plus N mtg_agenda_items
 * rows from the template's default_agenda inside one tenant tx —
 * either the meeting and every agenda item land together, or none.
 *
 * Authorisation: MTG-001:read for reads (every staff member);
 * MTG-001:admin for write paths (school admin OR holds mtg-001:admin
 * — only School Admin / Platform Admin via everyFunction today).
 * Refuses STUDENT and GUARDIAN at the service layer.
 */
@Injectable()
export class MeetingTemplateService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertStaff(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT' || actor.personType === 'GUARDIAN') {
      throw new ForbiddenException('Meeting templates are staff-only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Staff actor must have an hr_employees row');
    }
  }

  async list(actor: ResolvedActor, includeInactive = false): Promise<MeetingTemplateResponseDto[]> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (includeInactive) {
        return client.$queryRawUnsafe(
          SELECT_TEMPLATE + 'WHERE t.school_id = $1::uuid ORDER BY t.name ASC',
          tenant.schoolId,
        );
      }
      return client.$queryRawUnsafe(
        SELECT_TEMPLATE + 'WHERE t.school_id = $1::uuid AND t.is_active = true ORDER BY t.name ASC',
        tenant.schoolId,
      );
    })) as TemplateRow[];
    return rows.map((r) => this.rowToDto(r));
  }

  async getById(id: string, actor: ResolvedActor): Promise<MeetingTemplateResponseDto> {
    this.assertStaff(actor);
    return this.loadOrFail(id);
  }

  private async loadOrFail(id: string): Promise<MeetingTemplateResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TEMPLATE + 'WHERE t.id = $1::uuid AND t.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    })) as TemplateRow[];
    if (rows.length === 0) throw new NotFoundException('Meeting template not found');
    return this.rowToDto(rows[0]!);
  }

  async create(
    input: CreateMeetingTemplateDto,
    actor: ResolvedActor,
  ): Promise<MeetingTemplateResponseDto> {
    this.assertStaff(actor);
    const id = generateId();
    const tenant = getCurrentTenant();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO mtg_meeting_templates ' +
            '(id, school_id, name, description, meeting_type_id, default_duration_minutes, default_agenda, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::jsonb, $8::uuid)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.meetingTypeId ?? null,
          input.defaultDurationMinutes ?? 60,
          JSON.stringify(input.defaultAgenda ?? []),
          actor.employeeId,
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A meeting template with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  async patch(
    id: string,
    input: UpdateMeetingTemplateDto,
    actor: ResolvedActor,
  ): Promise<MeetingTemplateResponseDto> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
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
    if (input.meetingTypeId !== undefined) {
      params.push(input.meetingTypeId);
      sets.push('meeting_type_id = $' + params.length + '::uuid');
    }
    if (input.defaultDurationMinutes !== undefined) {
      params.push(input.defaultDurationMinutes);
      sets.push('default_duration_minutes = $' + params.length);
    }
    if (input.defaultAgenda !== undefined) {
      params.push(JSON.stringify(input.defaultAgenda));
      sets.push('default_agenda = $' + params.length + '::jsonb');
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);
    params.push(tenant.schoolId);
    try {
      const result = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$executeRawUnsafe(
          'UPDATE mtg_meeting_templates SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            (params.length - 1) +
            '::uuid AND school_id = $' +
            params.length +
            '::uuid',
          ...params,
        );
      })) as number;
      if (result === 0) throw new NotFoundException('Meeting template not found');
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'A meeting template with that name already exists for this school',
        );
      }
      throw err;
    }
    return this.loadOrFail(id);
  }

  /**
   * KEYSTONE — atomically INSERT a new mtg_meetings row plus N
   * mtg_agenda_items rows from the template's default_agenda inside
   * one tenant tx. Either all rows commit together or none.
   *
   * Returns the new meeting id. The caller can fetch the full
   * meeting (with agenda + participants) via the existing
   * MeetingService.getById path.
   */
  async createMeetingFromTemplate(
    templateId: string,
    input: CreateMeetingFromTemplateDto,
    actor: ResolvedActor,
  ): Promise<{ meetingId: string; agendaItemsCreated: number }> {
    this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const template = await this.loadOrFail(templateId);
    if (!template.isActive) {
      throw new BadRequestException('Cannot create meetings from inactive templates');
    }
    if (!template.meetingTypeId) {
      throw new BadRequestException(
        'Template has no meeting_type_id — set one via PATCH before creating meetings from it',
      );
    }

    const meetingId = generateId();
    const agenda = template.defaultAgenda ?? [];
    const duration = input.durationMinutes ?? template.defaultDurationMinutes;

    // REVIEW-P2C28 MAJOR 2 — validate supplied participantIds belong
    // to users with a projection in the current school. Cap loop at
    // 200 to bound iteration cost (CodeQL js/loop-bound-injection).
    if (input.participantIds && input.participantIds.length > 200) {
      throw new BadRequestException(
        'participantIds list too large — max 200 participants per meeting',
      );
    }
    if (input.participantIds && input.participantIds.length > 0) {
      const verified = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT pu.id::text AS account_id FROM platform.platform_users pu ' +
            'WHERE pu.id = ANY($1::uuid[]) AND (' +
            'EXISTS (SELECT 1 FROM sis_students s ' +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  WHERE ps.person_id = pu.person_id AND s.school_id = $2::uuid) ' +
            'OR EXISTS (SELECT 1 FROM sis_student_guardians sg ' +
            '  JOIN sis_students s ON s.id = sg.student_id ' +
            '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            '  WHERE g.person_id = pu.person_id AND s.school_id = $2::uuid) ' +
            'OR EXISTS (SELECT 1 FROM hr_employees e ' +
            '  WHERE e.person_id = pu.person_id AND e.school_id = $2::uuid))',
          input.participantIds,
          tenant.schoolId,
        );
      })) as Array<{ account_id: string }>;
      const verifiedSet = new Set(verified.map((r) => r.account_id));
      const missing = input.participantIds.filter((id) => !verifiedSet.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          'participantIds contain accounts not affiliated with this school: ' + missing.join(', '),
        );
      }
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO mtg_meetings ' +
          '(id, school_id, meeting_type_id, title, scheduled_at, duration_minutes, meeting_url, status, organiser_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7, 'SCHEDULED', $8::uuid)",
        meetingId,
        tenant.schoolId,
        template.meetingTypeId,
        input.title,
        input.scheduledAt,
        duration,
        input.meetingUrl ?? null,
        actor.accountId,
      );

      // Auto-add organiser as HOST participant
      await tx.$executeRawUnsafe(
        'INSERT INTO mtg_meeting_participants (id, meeting_id, participant_id, role) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'HOST') " +
          'ON CONFLICT (meeting_id, participant_id) DO NOTHING',
        generateId(),
        meetingId,
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
            meetingId,
            pid,
          );
        }
      }

      // Materialise default_agenda rows
      for (let i = 0; i < agenda.length; i++) {
        const item = agenda[i]!;
        await tx.$executeRawUnsafe(
          'INSERT INTO mtg_agenda_items (id, meeting_id, title, description, duration_minutes, sort_order) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          generateId(),
          meetingId,
          item.title,
          item.description ?? null,
          item.durationMinutes ?? null,
          item.sortOrder ?? i,
        );
      }
    });

    return { meetingId, agendaItemsCreated: agenda.length };
  }

  private rowToDto(r: TemplateRow): MeetingTemplateResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      name: r.name,
      description: r.description,
      meetingTypeId: r.meeting_type_id,
      meetingTypeName: r.meeting_type_name,
      defaultDurationMinutes: r.default_duration_minutes,
      defaultAgenda: parseAgenda(r.default_agenda),
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      isActive: r.is_active,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }
}
