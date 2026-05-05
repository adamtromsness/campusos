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
  CreateInterventionDto,
  InterventionProgressEntryDto,
  InterventionResponseDto,
  InterventionStatus,
  InterventionType,
  LogProgressDto,
  UpdateInterventionDto,
} from './dto/counselling.dto';

interface InterventionRow {
  id: string;
  tier_id: string;
  intervention_name: string;
  intervention_type: string;
  description: string | null;
  frequency: string | null;
  start_date: string;
  end_date: string | null;
  provider_id: string | null;
  provider_first: string | null;
  provider_last: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  id: string;
  intervention_id: string;
  recorded_by: string;
  recorder_first: string | null;
  recorder_last: string | null;
  recorded_date: string;
  measure_type: string;
  score: string | null;
  benchmark: string | null;
  notes: string | null;
  created_at: string;
}

const SELECT_INTERVENTION_BASE =
  'SELECT i.id::text AS id, i.tier_id::text AS tier_id, ' +
  'i.intervention_name, i.intervention_type, i.description, i.frequency, ' +
  "TO_CHAR(i.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(i.end_date, 'YYYY-MM-DD') AS end_date, " +
  'i.provider_id::text AS provider_id, ' +
  'pp.first_name AS provider_first, pp.last_name AS provider_last, ' +
  'i.status, ' +
  'TO_CHAR(i.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(i.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_interventions i ' +
  'LEFT JOIN hr_employees pe ON pe.id = i.provider_id ' +
  'LEFT JOIN platform.iam_person pp ON pp.id = pe.person_id ';

const SELECT_PROGRESS_BASE =
  'SELECT p.id::text AS id, p.intervention_id::text AS intervention_id, ' +
  'p.recorded_by::text AS recorded_by, ' +
  'rp.first_name AS recorder_first, rp.last_name AS recorder_last, ' +
  "TO_CHAR(p.recorded_date, 'YYYY-MM-DD') AS recorded_date, " +
  'p.measure_type, p.score::text AS score, p.benchmark::text AS benchmark, p.notes, ' +
  'TO_CHAR(p.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at ' +
  'FROM svc_intervention_progress p ' +
  'LEFT JOIN hr_employees re ON re.id = p.recorded_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToProgressDto(r: ProgressRow): InterventionProgressEntryDto {
  return {
    id: r.id,
    interventionId: r.intervention_id,
    recordedById: r.recorded_by,
    recordedByName: fullName(r.recorder_first, r.recorder_last),
    recordedDate: r.recorded_date,
    measureType: r.measure_type,
    score: r.score === null ? null : Number(r.score),
    benchmark: r.benchmark === null ? null : Number(r.benchmark),
    notes: r.notes,
    createdAt: r.created_at,
  };
}

function rowToDto(
  r: InterventionRow,
  latest: InterventionProgressEntryDto | null,
): InterventionResponseDto {
  return {
    id: r.id,
    tierId: r.tier_id,
    interventionName: r.intervention_name,
    interventionType: r.intervention_type as InterventionType,
    description: r.description,
    frequency: r.frequency,
    startDate: r.start_date,
    endDate: r.end_date,
    providerId: r.provider_id,
    providerName: fullName(r.provider_first, r.provider_last),
    status: r.status as InterventionStatus,
    latestProgress: latest,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class InterventionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-001:write',
    ]);
  }

  async listForTier(tierId: string, actor: ResolvedActor): Promise<InterventionResponseDto[]> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can view interventions');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<InterventionRow[]>(
        SELECT_INTERVENTION_BASE + 'WHERE i.tier_id = $1::uuid ORDER BY i.start_date DESC',
        tierId,
      );
    });
    if (rows.length === 0) return [];
    // Pull latest progress per intervention in one query.
    const ids = rows.map((r) => r.id);
    const progressRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        'SELECT DISTINCT ON (p.intervention_id) ' +
          SELECT_PROGRESS_BASE.replace(/^SELECT/, '').replace(
            /FROM svc_intervention_progress p/,
            'FROM svc_intervention_progress p',
          ) +
          'WHERE p.intervention_id = ANY($1::uuid[]) ' +
          'ORDER BY p.intervention_id, p.recorded_date DESC, p.created_at DESC',
        ids,
      );
    });
    const latestByIntervention = new Map<string, InterventionProgressEntryDto>();
    for (const p of progressRows) {
      latestByIntervention.set(p.intervention_id, rowToProgressDto(p));
    }
    return rows.map((r) => rowToDto(r, latestByIntervention.get(r.id) ?? null));
  }

  async getById(id: string, actor: ResolvedActor): Promise<InterventionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can view interventions');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<InterventionRow[]>(
        SELECT_INTERVENTION_BASE + 'WHERE i.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Intervention ' + id);
    const latest = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        SELECT_PROGRESS_BASE +
          'WHERE p.intervention_id = $1::uuid ORDER BY p.recorded_date DESC, p.created_at DESC LIMIT 1',
        id,
      );
    });
    return rowToDto(rows[0]!, latest.length > 0 ? rowToProgressDto(latest[0]!) : null);
  }

  async create(
    tierId: string,
    input: CreateInterventionDto,
    actor: ResolvedActor,
  ): Promise<InterventionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can create interventions');
    }
    if (input.endDate && input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    // Validate tier exists in this tenant.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM svc_mtss_tiers WHERE id = $1::uuid LIMIT 1',
        tierId,
      )) as Array<{ ok: number }>;
      if (r.length === 0)
        throw new BadRequestException('tierId does not match an MTSS tier in this school');
    });
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_interventions (id, tier_id, intervention_name, intervention_type, description, frequency, ' +
          'start_date, end_date, provider_id, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9::uuid, 'ACTIVE')",
        id,
        tierId,
        input.interventionName,
        input.interventionType,
        input.description ?? null,
        input.frequency ?? null,
        input.startDate,
        input.endDate ?? null,
        input.providerId ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateInterventionDto,
    actor: ResolvedActor,
  ): Promise<InterventionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can update interventions');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const updates: string[] = [];
      const params: unknown[] = [id];
      let idx = 2;
      if (input.status !== undefined) {
        updates.push('status = $' + idx);
        params.push(input.status);
        idx++;
      }
      if (input.frequency !== undefined) {
        updates.push('frequency = $' + idx);
        params.push(input.frequency);
        idx++;
      }
      if (input.endDate !== undefined) {
        updates.push('end_date = $' + idx + '::date');
        params.push(input.endDate);
        idx++;
      }
      if (input.description !== undefined) {
        updates.push('description = $' + idx);
        params.push(input.description);
        idx++;
      }
      if (updates.length === 0) return;
      updates.push('updated_at = now()');
      const r = await client.$executeRawUnsafe(
        'UPDATE svc_interventions SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
      if (r === 0) throw new NotFoundException('Intervention ' + id);
    });
    return this.getById(id, actor);
  }

  /**
   * Append-only progress entry. Stamps recorded_by from
   * actor.employeeId; refuses callers without an hr_employees row.
   * The schema-side append-only enforcement comes from there being no
   * UPDATE / DELETE method exposed at the service layer (mirrors
   * Cycle 8 tkt_ticket_activity + Cycle 11 svc_referral_activity).
   */
  async logProgress(
    interventionId: string,
    input: LogProgressDto,
    actor: ResolvedActor,
  ): Promise<InterventionProgressEntryDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can log intervention progress');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Recorder must have an employee record');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_intervention_progress (id, intervention_id, recorded_by, recorded_date, measure_type, score, benchmark, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8)',
        id,
        interventionId,
        actor.employeeId,
        input.recordedDate,
        input.measureType,
        input.score ?? null,
        input.benchmark ?? null,
        input.notes ?? null,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        SELECT_PROGRESS_BASE + 'WHERE p.id = $1::uuid',
        id,
      );
    });
    return rowToProgressDto(rows[0]!);
  }

  async listProgress(
    interventionId: string,
    actor: ResolvedActor,
  ): Promise<InterventionProgressEntryDto[]> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can view intervention progress');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        SELECT_PROGRESS_BASE +
          'WHERE p.intervention_id = $1::uuid ORDER BY p.recorded_date ASC, p.created_at ASC',
        interventionId,
      );
    });
    return rows.map(rowToProgressDto);
  }
}
