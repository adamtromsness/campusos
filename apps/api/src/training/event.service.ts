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
  CreateTrainingEventDto,
  EventStatus,
  TrainingEventDto,
  UpdateTrainingEventDto,
} from './dto/training.dto';

interface EventRow {
  id: string;
  programme_id: string;
  programme_name: string | null;
  school_id: string;
  title: string;
  scheduled_at: string;
  duration_minutes: number | null;
  location: string | null;
  facilitator: string | null;
  max_participants: number | null;
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  completion_count: number;
  created_at: string;
}

const SELECT_EVENT_BASE =
  'SELECT e.id::text AS id, e.programme_id::text AS programme_id, p.name AS programme_name, ' +
  '       e.school_id::text AS school_id, e.title, e.scheduled_at::text AS scheduled_at, ' +
  '       e.duration_minutes, e.location, e.facilitator, e.max_participants, e.status, ' +
  '       e.completed_at::text AS completed_at, e.cancelled_at::text AS cancelled_at, ' +
  '       e.cancellation_reason, e.notes, ' +
  '       COALESCE(cc.completion_count, 0)::int AS completion_count, ' +
  '       e.created_at::text AS created_at ' +
  'FROM hr_training_events e ' +
  'JOIN hr_training_programmes p ON p.id = e.programme_id ' +
  'LEFT JOIN ( ' +
  '  SELECT event_id, COUNT(*)::int AS completion_count FROM hr_training_completions GROUP BY event_id ' +
  ') cc ON cc.event_id = e.id ';

@Injectable()
export class TrainingEventService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(args: { programmeId?: string; status?: EventStatus }): Promise<TrainingEventDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE e.school_id = $1::uuid';
    if (args.programmeId) {
      params.push(args.programmeId);
      where += ` AND e.programme_id = $${params.length}::uuid`;
    }
    if (args.status) {
      params.push(args.status);
      where += ` AND e.status = $${params.length}`;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_EVENT_BASE + where + ' ORDER BY e.scheduled_at DESC',
        ...params,
      )) as EventRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<TrainingEventDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_EVENT_BASE + 'WHERE e.school_id = $1::uuid AND e.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as EventRow[];
      if (rows.length === 0) throw new NotFoundException('Training event not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateTrainingEventDto, actor: ResolvedActor): Promise<TrainingEventDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify the parent programme is in the same school + active.
      const prog = (await tx.$queryRawUnsafe(
        'SELECT id FROM hr_training_programmes ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid AND is_active = true LIMIT 1',
        tenant.schoolId,
        input.programmeId,
      )) as Array<{ id: string }>;
      if (prog.length === 0) {
        throw new BadRequestException(
          'programmeId does not match an active training programme in this school.',
        );
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_training_events ' +
          '(id, programme_id, school_id, title, scheduled_at, duration_minutes, location, ' +
          ' facilitator, max_participants, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7, $8, $9, $10)',
        id,
        input.programmeId,
        tenant.schoolId,
        input.title,
        input.scheduledAt,
        input.durationMinutes ?? null,
        input.location ?? null,
        input.facilitator ?? null,
        input.maxParticipants ?? null,
        input.notes ?? null,
      );
      return this.getById(id);
    });
  }

  async patch(
    id: string,
    input: UpdateTrainingEventDto,
    actor: ResolvedActor,
  ): Promise<TrainingEventDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_training_events ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Training event not found');
      const cur = lock[0]!.status as EventStatus;
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown, cast?: string) => {
        sets.push(`${col} = $${n}${cast ? `::${cast}` : ''}`);
        values.push(value);
        n += 1;
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.scheduledAt !== undefined) push('scheduled_at', input.scheduledAt, 'timestamptz');
      if (input.durationMinutes !== undefined) push('duration_minutes', input.durationMinutes);
      if (input.location !== undefined) push('location', input.location);
      if (input.facilitator !== undefined) push('facilitator', input.facilitator);
      if (input.maxParticipants !== undefined) push('max_participants', input.maxParticipants);
      if (input.notes !== undefined) push('notes', input.notes);
      if (input.status !== undefined && input.status !== cur) {
        const target = input.status;
        if (cur === 'COMPLETED' || cur === 'CANCELLED') {
          throw new BadRequestException(`Cannot transition out of terminal status ${cur}.`);
        }
        push('status', target);
        if (target === 'COMPLETED') {
          sets.push('completed_at = now()');
        } else if (target === 'CANCELLED') {
          if (!input.cancellationReason || input.cancellationReason.trim() === '') {
            throw new BadRequestException('cancellationReason is required when cancelling.');
          }
          sets.push('cancelled_at = now()');
          push('cancellation_reason', input.cancellationReason);
        }
      }
      if (sets.length === 0) return this.getById(id);
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        `UPDATE hr_training_events SET ${sets.join(', ')} ` +
          `WHERE school_id = $${n}::uuid AND id = $${n + 1}::uuid`,
        ...values,
      );
      return this.getById(id);
    });
  }

  /** Internal — load programme + event in one shot for the
   * CompletionService auto-issue path. */
  async loadInternalWithProgramme(id: string): Promise<{
    eventId: string;
    programmeId: string;
    schoolId: string;
    isMandatory: boolean;
    renewalMonths: number | null;
    eventTitle: string;
  } | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT e.id::text AS event_id, e.programme_id::text AS programme_id, ' +
          '       e.school_id::text AS school_id, e.title AS event_title, ' +
          '       p.is_mandatory, p.renewal_months ' +
          'FROM hr_training_events e ' +
          'JOIN hr_training_programmes p ON p.id = e.programme_id ' +
          'WHERE e.school_id = $1::uuid AND e.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as Array<{
        event_id: string;
        programme_id: string;
        school_id: string;
        event_title: string;
        is_mandatory: boolean;
        renewal_months: number | null;
      }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        eventId: r.event_id,
        programmeId: r.programme_id,
        schoolId: r.school_id,
        isMandatory: r.is_mandatory,
        renewalMonths: r.renewal_months,
        eventTitle: r.event_title,
      };
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-004:write',
      'hr-004:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Training event administration requires hr-004:write or school admin.',
      );
    }
  }

  private rowToDto(r: EventRow): TrainingEventDto {
    return {
      id: r.id,
      programmeId: r.programme_id,
      programmeName: r.programme_name,
      schoolId: r.school_id,
      title: r.title,
      scheduledAt: r.scheduled_at,
      durationMinutes: r.duration_minutes,
      location: r.location,
      facilitator: r.facilitator,
      maxParticipants: r.max_participants,
      status: r.status as EventStatus,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
      cancellationReason: r.cancellation_reason,
      notes: r.notes,
      completionCount: r.completion_count,
      createdAt: r.created_at,
    };
  }
}
