import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import { ConditionResponseDto, CreateConditionDto, UpdateConditionDto } from './dto/health.dto';

interface ConditionRow {
  id: string;
  health_record_id: string;
  condition_name: string;
  diagnosis_date: string | null;
  is_active: boolean;
  severity: string;
  management_plan: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT id::text AS id, health_record_id::text AS health_record_id, ' +
  "condition_name, TO_CHAR(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date, " +
  'is_active, severity, management_plan, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medical_conditions ';

/**
 * ConditionService — Cycle 10 Step 5.
 *
 * Per-record condition CRUD. Reads write a VIEW_CONDITIONS audit row
 * before returning. Writes are nurse/admin only via the
 * HealthRecordService.assertNurseScope helper.
 */
@Injectable()
export class ConditionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
  ) {}

  /**
   * List conditions for a student. Row-scoped via the parent
   * HealthRecordService's assertCanReadStudent helper, then
   * VIEW_CONDITIONS audit row + field-strip per persona.
   */
  async listForStudent(studentId: string, actor: ResolvedActor): Promise<ConditionResponseDto[]> {
    const { isManager } = await this.records.assertCanReadStudentExternal(studentId, actor);
    const recordId = await this.records.loadRecordIdForStudent(studentId);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ConditionRow[]>(
        SELECT_BASE + 'WHERE health_record_id = $1::uuid ORDER BY is_active DESC, created_at DESC',
        recordId,
      );
    });

    await this.accessLog.recordAccess(actor, studentId, 'VIEW_CONDITIONS');

    return rows.map((r) => this.records.conditionRowToDto(r, isManager));
  }

  /**
   * Create a new condition. Nurse / admin only.
   */
  async create(
    studentId: string,
    input: CreateConditionDto,
    actor: ResolvedActor,
  ): Promise<ConditionResponseDto> {
    await this.records.assertNurseScope(actor);
    const recordId = await this.records.loadRecordIdForStudent(studentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_medical_conditions ' +
          '(id, health_record_id, condition_name, diagnosis_date, is_active, severity, management_plan) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::date, true, $5, $6)',
        id,
        recordId,
        input.conditionName,
        input.diagnosisDate ?? null,
        input.severity,
        input.managementPlan ?? null,
      );
    });
    return this.loadOrFail(id, /* manager */ true);
  }

  /**
   * Update a condition by id. Nurse / admin only. Setting
   * `is_active=false` is the canonical "resolve" path — the row stays
   * for the historical timeline.
   */
  async update(
    id: string,
    input: UpdateConditionDto,
    actor: ResolvedActor,
  ): Promise<ConditionResponseDto> {
    await this.records.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.conditionName !== undefined) {
      sets.push('condition_name = $' + idx);
      params.push(input.conditionName);
      idx++;
    }
    if (input.diagnosisDate !== undefined) {
      sets.push('diagnosis_date = $' + idx + '::date');
      params.push(input.diagnosisDate);
      idx++;
    }
    if (input.severity !== undefined) {
      sets.push('severity = $' + idx);
      params.push(input.severity);
      idx++;
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    if (input.managementPlan !== undefined) {
      sets.push('management_plan = $' + idx);
      params.push(input.managementPlan);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFail(id, /* manager */ true);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_medical_conditions SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Condition ' + id);
    return this.loadOrFail(id, /* manager */ true);
  }

  /**
   * Hard delete a condition. Nurse / admin only. The canonical
   * "resolve" path is is_active=false; admins use this to remove a
   * row recorded in error.
   */
  async remove(id: string, actor: ResolvedActor): Promise<void> {
    await this.records.assertNurseScope(actor);
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM hlth_medical_conditions WHERE id = $1::uuid',
        id,
      );
    });
    if (result === 0) throw new NotFoundException('Condition ' + id);
  }

  // ─── Internal helpers ────────────────────────────────────────

  private async loadOrFail(id: string, isManager: boolean): Promise<ConditionResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ConditionRow[]>(SELECT_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Condition ' + id);
    return this.records.conditionRowToDto(rows[0]!, isManager);
  }
}
