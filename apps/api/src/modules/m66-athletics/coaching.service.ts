import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { ProgrammeService } from './programme.service';
import {
  CoachingAssignmentResponseDto,
  CoachingRole,
  CreateCoachingAssignmentDto,
  UpdateCoachingAssignmentDto,
} from './dto/athletics.dto';

interface CoachingRow {
  id: string;
  roster_id: string;
  coach_person_id: string;
  coach_name: string | null;
  role: string;
  stipend_amount: string | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COACHING =
  'SELECT c.id::text AS id, c.roster_id::text AS roster_id, c.coach_person_id::text AS coach_person_id, ' +
  "(ip.first_name || ' ' || ip.last_name) AS coach_name, " +
  'c.role, c.stipend_amount::text AS stipend_amount, ' +
  "TO_CHAR(c.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(c.end_date, 'YYYY-MM-DD') AS end_date, " +
  'c.is_active, c.notes, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM ath_coaching_assignments c ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = c.coach_person_id ';

function rowToDto(r: CoachingRow): CoachingAssignmentResponseDto {
  return {
    id: r.id,
    rosterId: r.roster_id,
    coachPersonId: r.coach_person_id,
    coachName: r.coach_name,
    role: r.role as CoachingRole,
    stipendAmount: r.stipend_amount === null ? null : Number(r.stipend_amount),
    startDate: r.start_date,
    endDate: r.end_date,
    isActive: r.is_active,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class CoachingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly programmes: ProgrammeService,
  ) {}

  async listForRoster(rosterId: string): Promise<CoachingAssignmentResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_COACHING + 'WHERE c.roster_id = $1::uuid ORDER BY c.is_active DESC, c.role ASC',
        rosterId,
      );
    })) as CoachingRow[];
    return rows.map(rowToDto);
  }

  async create(
    rosterId: string,
    input: CreateCoachingAssignmentDto,
    actor: ResolvedActor,
  ): Promise<CoachingAssignmentResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can manage coaching staff');
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO ath_coaching_assignments (id, roster_id, coach_person_id, role, stipend_amount, start_date, end_date, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8)',
          id,
          rosterId,
          input.coachPersonId,
          input.role,
          input.stipendAmount ?? null,
          input.startDate ?? null,
          input.endDate ?? null,
          input.notes ?? null,
        );
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '23514') {
        throw new BadRequestException(
          'Coaching dates inconsistent. end_date must be on or after start_date.',
        );
      }
      throw e;
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_COACHING + 'WHERE c.id = $1::uuid', id);
    })) as CoachingRow[];
    return rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    input: UpdateCoachingAssignmentDto,
    actor: ResolvedActor,
  ): Promise<CoachingAssignmentResponseDto> {
    if (!(await this.programmes.hasAdScope(actor))) {
      throw new ForbiddenException('Only the AD or admin can edit coaching assignments');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.role !== undefined) {
      params.push(input.role);
      sets.push('role = $' + params.length);
    }
    if (input.stipendAmount !== undefined) {
      if (input.stipendAmount === null) sets.push('stipend_amount = NULL');
      else {
        params.push(input.stipendAmount);
        sets.push('stipend_amount = $' + params.length);
      }
    }
    if (input.isActive !== undefined) {
      params.push(input.isActive);
      sets.push('is_active = $' + params.length);
    }
    if (input.endDate !== undefined) {
      if (input.endDate === null) sets.push('end_date = NULL');
      else {
        params.push(input.endDate);
        sets.push('end_date = $' + params.length + '::date');
      }
    }
    if (input.notes !== undefined) {
      params.push(input.notes);
      sets.push('notes = $' + params.length);
    }
    if (sets.length === 0) {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(SELECT_COACHING + 'WHERE c.id = $1::uuid', id);
      })) as CoachingRow[];
      if (rows.length === 0) throw new NotFoundException('Coaching assignment not found');
      return rowToDto(rows[0]!);
    }
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE ath_coaching_assignments SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          params.length +
          '::uuid',
        ...params,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_COACHING + 'WHERE c.id = $1::uuid', id);
    })) as CoachingRow[];
    if (rows.length === 0) throw new NotFoundException('Coaching assignment not found');
    return rowToDto(rows[0]!);
  }
}
