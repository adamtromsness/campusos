import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateMedicationDto,
  MedicationResponseDto,
  MedicationRoute,
  ScheduleSlotResponseDto,
  UpdateMedicationDto,
} from './dto/health.dto';

interface MedicationRow {
  id: string;
  health_record_id: string;
  medication_name: string;
  dosage: string | null;
  frequency: string | null;
  route: string;
  prescribing_physician: string | null;
  is_self_administered: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  medication_id: string;
  scheduled_time: string;
  day_of_week: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_MED_BASE =
  'SELECT id::text AS id, health_record_id::text AS health_record_id, ' +
  'medication_name, dosage, frequency, route, prescribing_physician, ' +
  'is_self_administered, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medications ';

const SELECT_SCHEDULE_BASE =
  'SELECT id::text AS id, medication_id::text AS medication_id, ' +
  "TO_CHAR(scheduled_time, 'HH24:MI:SS') AS scheduled_time, " +
  'day_of_week, notes, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medication_schedule ';

/**
 * MedicationService — Cycle 10 Step 6.
 *
 * Per-record medication CRUD + inlined schedule slots. Reads are
 * gated on hlt-001:read at the controller, and the service-layer
 * row scope mirrors the Step 5 HealthRecordService — admin / nurse
 * see all; parent sees own children with `prescribingPhysician`
 * stripped (parents already have the prescription on paper);
 * teacher 403 service-layer (medication info is nurse / parent /
 * admin only — teachers see life-threatening allergies via
 * emergency_medical_notes on the health record). Reads call
 * HealthAccessLogService.recordAccess(VIEW_MEDICATIONS) before
 * returning. Writes are nurse / admin only via assertNurseScope.
 */
@Injectable()
export class MedicationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
  ) {}

  /**
   * List medications for a student with inlined schedule slots.
   * Teachers receive 403 — medication info is not classroom-relevant
   * (life-threatening allergies + conditions surface via the Step 5
   * health record stripped DTO already).
   */
  async listForStudent(studentId: string, actor: ResolvedActor): Promise<MedicationResponseDto[]> {
    const { isManager } = await this.records.assertCanReadStudentExternal(studentId, actor);
    const includeRead = isManager || actor.personType === 'GUARDIAN';
    if (!includeRead) {
      throw new ForbiddenException('Medications are visible to nurses, admins, and parents only');
    }
    const recordId = await this.records.loadRecordIdForStudent(studentId);

    const [meds, schedules] = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return Promise.all([
        client.$queryRawUnsafe<MedicationRow[]>(
          SELECT_MED_BASE +
            'WHERE health_record_id = $1::uuid ORDER BY is_active DESC, medication_name ASC',
          recordId,
        ),
        client.$queryRawUnsafe<ScheduleRow[]>(
          SELECT_SCHEDULE_BASE +
            'WHERE medication_id IN (SELECT id FROM hlth_medications WHERE health_record_id = $1::uuid) ORDER BY scheduled_time ASC',
          recordId,
        ),
      ]);
    });

    await this.accessLog.recordAccess(actor, studentId, 'VIEW_MEDICATIONS');

    const slotsByMed = new Map<string, ScheduleSlotResponseDto[]>();
    for (const s of schedules) {
      const arr = slotsByMed.get(s.medication_id) ?? [];
      arr.push(this.scheduleRowToDto(s));
      slotsByMed.set(s.medication_id, arr);
    }
    return meds.map((m) => this.medicationRowToDto(m, slotsByMed.get(m.id) ?? [], isManager));
  }

  async create(
    studentId: string,
    input: CreateMedicationDto,
    actor: ResolvedActor,
  ): Promise<MedicationResponseDto> {
    await this.records.assertNurseScope(actor);
    const recordId = await this.records.loadRecordIdForStudent(studentId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_medications ' +
          '(id, health_record_id, medication_name, dosage, frequency, route, prescribing_physician, is_self_administered, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, true)',
        id,
        recordId,
        input.medicationName,
        input.dosage ?? null,
        input.frequency ?? null,
        input.route,
        input.prescribingPhysician ?? null,
        input.isSelfAdministered ?? false,
      );
    });
    return this.loadOrFail(id, /* isManager */ true);
  }

  async update(
    id: string,
    input: UpdateMedicationDto,
    actor: ResolvedActor,
  ): Promise<MedicationResponseDto> {
    await this.records.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.medicationName !== undefined) {
      sets.push('medication_name = $' + idx);
      params.push(input.medicationName);
      idx++;
    }
    if (input.dosage !== undefined) {
      sets.push('dosage = $' + idx);
      params.push(input.dosage);
      idx++;
    }
    if (input.frequency !== undefined) {
      sets.push('frequency = $' + idx);
      params.push(input.frequency);
      idx++;
    }
    if (input.route !== undefined) {
      sets.push('route = $' + idx);
      params.push(input.route);
      idx++;
    }
    if (input.prescribingPhysician !== undefined) {
      sets.push('prescribing_physician = $' + idx);
      params.push(input.prescribingPhysician);
      idx++;
    }
    if (input.isSelfAdministered !== undefined) {
      sets.push('is_self_administered = $' + idx);
      params.push(input.isSelfAdministered);
      idx++;
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFail(id, /* isManager */ true);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_medications SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Medication ' + id);
    return this.loadOrFail(id, /* isManager */ true);
  }

  // ─── Internal helpers shared with ScheduleService + AdministrationService ─

  /** Resolves the health_record_id + student_id for a medication so the
   *  audit-log + row-scope check can fire on dependent endpoints. Throws
   *  404 if the medication does not exist in this tenant. */
  async loadStudentForMedication(
    medicationId: string,
  ): Promise<{ studentId: string; healthRecordId: string }> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT m.health_record_id::text AS health_record_id, ' +
          'r.student_id::text AS student_id ' +
          'FROM hlth_medications m ' +
          'JOIN hlth_student_health_records r ON r.id = m.health_record_id ' +
          'WHERE m.id = $1::uuid LIMIT 1',
        medicationId,
      )) as Array<{ health_record_id: string; student_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Medication ' + medicationId);
      return { studentId: rows[0]!.student_id, healthRecordId: rows[0]!.health_record_id };
    });
  }

  scheduleRowToDto(r: ScheduleRow): ScheduleSlotResponseDto {
    return {
      id: r.id,
      medicationId: r.medication_id,
      scheduledTime: r.scheduled_time,
      dayOfWeek: r.day_of_week,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ─── Internal ────────────────────────────────────────────────

  private async loadOrFail(id: string, isManager: boolean): Promise<MedicationResponseDto> {
    const med = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_MED_BASE + 'WHERE id = $1::uuid',
        id,
      )) as MedicationRow[];
      return rows[0] ?? null;
    });
    if (!med) throw new NotFoundException('Medication ' + id);
    const slots = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScheduleRow[]>(
        SELECT_SCHEDULE_BASE + 'WHERE medication_id = $1::uuid ORDER BY scheduled_time ASC',
        id,
      );
    });
    return this.medicationRowToDto(
      med,
      slots.map((s) => this.scheduleRowToDto(s)),
      isManager,
    );
  }

  private medicationRowToDto(
    r: MedicationRow,
    schedule: ScheduleSlotResponseDto[],
    isManager: boolean,
  ): MedicationResponseDto {
    return {
      id: r.id,
      healthRecordId: r.health_record_id,
      medicationName: r.medication_name,
      dosage: r.dosage,
      frequency: r.frequency,
      route: r.route as MedicationRoute,
      // Strip prescribing_physician for parent payload — they already
      // have the prescription on paper from the prescribing physician.
      prescribingPhysician: isManager ? r.prescribing_physician : null,
      isSelfAdministered: r.is_self_administered,
      isActive: r.is_active,
      schedule,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
