import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthRecordService } from './health-record.service';
import { MedicationService } from './medication.service';
import {
  CreateScheduleSlotDto,
  ScheduleSlotResponseDto,
  UpdateScheduleSlotDto,
} from './dto/health.dto';

interface ScheduleRow {
  id: string;
  medication_id: string;
  scheduled_time: string;
  day_of_week: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT id::text AS id, medication_id::text AS medication_id, ' +
  "TO_CHAR(scheduled_time, 'HH24:MI:SS') AS scheduled_time, " +
  'day_of_week, notes, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medication_schedule ';

/**
 * MedicationScheduleService — Cycle 10 Step 6.
 *
 * CRUD on hlth_medication_schedule. Slots are the recurring time
 * windows the nurse dashboard renders as a daily checklist. Reads
 * inherit from the parent medication's row scope; writes are nurse /
 * admin only via HealthRecordService.assertNurseScope.
 */
@Injectable()
export class MedicationScheduleService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly records: HealthRecordService,
    private readonly medications: MedicationService,
  ) {}

  /**
   * List the slots for a medication. The Step 6 nurse dashboard
   * does not call this directly — it reads via the dashboard query
   * which joins schedule + administrations across all medications
   * for today. This endpoint is the per-medication detail view that
   * the UI uses when editing the schedule for one prescription.
   */
  async listForMedication(
    medicationId: string,
    actor: ResolvedActor,
  ): Promise<ScheduleSlotResponseDto[]> {
    const { studentId } = await this.medications.loadStudentForMedication(medicationId);
    await this.records.assertCanReadStudentExternal(studentId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE medication_id = $1::uuid ORDER BY scheduled_time ASC',
        medicationId,
      )) as ScheduleRow[];
      return rows.map((r) => this.medications.scheduleRowToDto(r));
    });
  }

  async create(
    medicationId: string,
    input: CreateScheduleSlotDto,
    actor: ResolvedActor,
  ): Promise<ScheduleSlotResponseDto> {
    await this.records.assertNurseScope(actor);
    // Verify medication exists; error path 404s.
    await this.medications.loadStudentForMedication(medicationId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_medication_schedule ' +
          '(id, medication_id, scheduled_time, day_of_week, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::time, $4, $5)',
        id,
        medicationId,
        input.scheduledTime,
        input.dayOfWeek ?? null,
        input.notes ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  async update(
    id: string,
    input: UpdateScheduleSlotDto,
    actor: ResolvedActor,
  ): Promise<ScheduleSlotResponseDto> {
    await this.records.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.scheduledTime !== undefined) {
      sets.push('scheduled_time = $' + idx + '::time');
      params.push(input.scheduledTime);
      idx++;
    }
    if (input.dayOfWeek !== undefined) {
      sets.push('day_of_week = $' + idx);
      params.push(input.dayOfWeek);
      idx++;
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + idx);
      params.push(input.notes);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_medication_schedule SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('Schedule slot ' + id);
    return this.loadOrFail(id);
  }

  /**
   * Delete a schedule slot. Nurse / admin only. The schema's
   * `schedule_entry_id` on hlth_medication_administrations is a
   * deliberate soft ref (no DB-enforced FK), so deleting a slot
   * leaves historical administration rows intact pointing at the
   * now-gone slot id — by design, per the Step 2 schema header.
   */
  async remove(id: string, actor: ResolvedActor): Promise<void> {
    await this.records.assertNurseScope(actor);
    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'DELETE FROM hlth_medication_schedule WHERE id = $1::uuid',
        id,
      );
    });
    if (result === 0) throw new NotFoundException('Schedule slot ' + id);
  }

  // ─── Internal ────────────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ScheduleSlotResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScheduleRow[]>(SELECT_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Schedule slot ' + id);
    return this.medications.scheduleRowToDto(rows[0]!);
  }
}
