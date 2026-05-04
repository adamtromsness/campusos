import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateImmunisationDto,
  ImmunisationResponseDto,
  UpdateImmunisationDto,
} from './dto/health.dto';

interface ImmunisationRow {
  id: string;
  health_record_id: string;
  vaccine_name: string;
  administered_date: string | null;
  due_date: string | null;
  administered_by: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT id::text AS id, health_record_id::text AS health_record_id, ' +
  "vaccine_name, TO_CHAR(administered_date, 'YYYY-MM-DD') AS administered_date, " +
  "TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, " +
  'administered_by, status, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_immunisations ';

/**
 * ImmunisationService — Cycle 10 Step 5.
 *
 * Per-record immunisation CRUD. Reads are restricted to admin / nurse /
 * parent personas — teachers cannot read immunisations because the
 * vaccine schedule is not classroom-relevant. Reads write a
 * VIEW_IMMUNISATIONS audit row before returning. Writes are nurse /
 * admin only.
 */
@Injectable()
export class ImmunisationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
  ) {}

  /**
   * List immunisations for a student. Teachers receive a 403 even
   * though they hold hlt-001:read — immunisations are not part of the
   * classroom safety alert surface; they belong to the parent and
   * nurse / admin tier.
   */
  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<ImmunisationResponseDto[]> {
    const { isManager } = await this.records.assertCanReadStudentExternal(studentId, actor);
    const includeRead = isManager || actor.personType === 'GUARDIAN';
    if (!includeRead) {
      throw new ForbiddenException('Immunisations are visible to nurses, admins, and parents only');
    }
    const recordId = await this.records.loadRecordIdForStudent(studentId);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ImmunisationRow[]>(
        SELECT_BASE +
          'WHERE health_record_id = $1::uuid ORDER BY administered_date DESC NULLS LAST',
        recordId,
      );
    });

    await this.accessLog.recordAccess(actor, studentId, 'VIEW_IMMUNISATIONS');
    return rows.map((r) => this.records.immunisationRowToDto(r));
  }

  async create(
    studentId: string,
    input: CreateImmunisationDto,
    actor: ResolvedActor,
  ): Promise<ImmunisationResponseDto> {
    await this.records.assertNurseScope(actor);
    const recordId = await this.records.loadRecordIdForStudent(studentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_immunisations ' +
          '(id, health_record_id, vaccine_name, administered_date, due_date, administered_by, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6, $7)',
        id,
        recordId,
        input.vaccineName,
        input.administeredDate ?? null,
        input.dueDate ?? null,
        input.administeredBy ?? null,
        input.status,
      );
    });
    return this.loadOrFail(id);
  }

  async update(
    id: string,
    input: UpdateImmunisationDto,
    actor: ResolvedActor,
  ): Promise<ImmunisationResponseDto> {
    await this.records.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.vaccineName !== undefined) {
      sets.push('vaccine_name = $' + idx);
      params.push(input.vaccineName);
      idx++;
    }
    if (input.administeredDate !== undefined) {
      sets.push('administered_date = $' + idx + '::date');
      params.push(input.administeredDate);
      idx++;
    }
    if (input.dueDate !== undefined) {
      sets.push('due_date = $' + idx + '::date');
      params.push(input.dueDate);
      idx++;
    }
    if (input.administeredBy !== undefined) {
      sets.push('administered_by = $' + idx);
      params.push(input.administeredBy);
      idx++;
    }
    if (input.status !== undefined) {
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_immunisations SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Immunisation ' + id);
    return this.loadOrFail(id);
  }

  // ─── Internal helpers ────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ImmunisationResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ImmunisationRow[]>(SELECT_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Immunisation ' + id);
    return this.records.immunisationRowToDto(rows[0]!);
  }
}
