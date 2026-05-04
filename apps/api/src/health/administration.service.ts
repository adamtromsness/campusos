import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import { MedicationService } from './medication.service';
import {
  AdministerDoseDto,
  AdministrationResponseDto,
  LogMissedDoseDto,
  MedicationDashboardRowDto,
  MedicationRoute,
  MissedReason,
} from './dto/health.dto';

interface AdminRow {
  id: string;
  medication_id: string;
  schedule_entry_id: string | null;
  administered_by: string | null;
  administered_first: string | null;
  administered_last: string | null;
  administered_at: string | null;
  dose_given: string | null;
  notes: string | null;
  parent_notified: boolean;
  was_missed: boolean;
  missed_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DashboardRow {
  schedule_entry_id: string;
  medication_id: string;
  medication_name: string;
  dosage: string | null;
  route: string;
  is_self_administered: boolean;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  scheduled_time: string;
  administration_id: string | null;
  administered_at: string | null;
  was_missed: boolean | null;
  missed_reason: string | null;
}

const SELECT_ADMIN_BASE =
  'SELECT a.id::text AS id, a.medication_id::text AS medication_id, ' +
  'a.schedule_entry_id::text AS schedule_entry_id, ' +
  'a.administered_by::text AS administered_by, ' +
  'ip.first_name AS administered_first, ip.last_name AS administered_last, ' +
  'TO_CHAR(a.administered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS administered_at, ' +
  'a.dose_given, a.notes, a.parent_notified, a.was_missed, a.missed_reason, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medication_administrations a ' +
  'LEFT JOIN hr_employees e ON e.id = a.administered_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * AdministrationService — Cycle 10 Step 6.
 *
 * Per-dose log writes + the school-wide medication dashboard query.
 * `administer` writes an active dose (was_missed=false +
 * administered_at NOT NULL + missed_reason NULL — the missed_chk
 * shape from Step 2). `logMissed` writes a missed dose
 * (was_missed=true + administered_at NULL + missed_reason NOT NULL).
 * The schema's missed_chk multi-column CHECK enforces both shapes.
 *
 * The medication dashboard is a nurse / admin endpoint that joins
 * today's schedule slots across every active medication for the
 * school and resolves each slot's ADMINISTERED / MISSED / PENDING
 * status from the administrations table.
 */
@Injectable()
export class AdministrationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
    private readonly medications: MedicationService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Log an administered dose. Nurse / admin only via assertNurseScope.
   * Stamps administered_by from actor.employeeId; refuses callers
   * without an hr_employees row (a synthetic Platform Admin would
   * fail here — by design, since dose administrations are a clinical
   * record). Emits hlth.medication.administered after the INSERT for
   * the future Cycle 3 NotificationConsumer to fan out parent
   * notifications.
   */
  async administer(
    medicationId: string,
    input: AdministerDoseDto,
    actor: ResolvedActor,
  ): Promise<AdministrationResponseDto> {
    await this.records.assertNurseScope(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Administering staff member must have an employee record (no hr_employees row)',
      );
    }
    const med = await this.loadMedicationOrFail(medicationId);
    if (input.scheduleEntryId) {
      await this.assertScheduleSlotForMedication(input.scheduleEntryId, medicationId);
    }
    const id = generateId();
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_medication_administrations ' +
          '(id, medication_id, schedule_entry_id, administered_by, administered_at, dose_given, notes, parent_notified, was_missed, missed_reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now(), $5, $6, $7, false, NULL)',
        id,
        medicationId,
        input.scheduleEntryId ?? null,
        actor.employeeId,
        input.doseGiven ?? null,
        input.notes ?? null,
        input.parentNotified ?? false,
      );
    });

    void this.kafka.emit({
      topic: 'hlth.medication.administered',
      key: id,
      sourceModule: 'health',
      payload: {
        administrationId: id,
        medicationId,
        medicationName: med.medication_name,
        studentId: med.student_id,
        studentName: fullName(med.student_first, med.student_last),
        scheduleEntryId: input.scheduleEntryId ?? null,
        administeredBy: actor.employeeId,
        administeredByAccountId: actor.accountId,
        doseGiven: input.doseGiven ?? null,
        parentNotified: input.parentNotified ?? false,
        administeredAt: new Date().toISOString(),
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });

    return this.loadOrFail(id);
  }

  /**
   * Log a missed dose. Nurse / admin only. Stamps was_missed=true +
   * administered_at NULL + missed_reason set per the missed_chk
   * shape. The administered_by column is left NULL because the dose
   * was not given by anyone — the missed_reason captures who or what
   * caused the miss (STUDENT_ABSENT / STUDENT_REFUSED / etc).
   */
  async logMissed(
    medicationId: string,
    input: LogMissedDoseDto,
    actor: ResolvedActor,
  ): Promise<AdministrationResponseDto> {
    await this.records.assertNurseScope(actor);
    await this.loadMedicationOrFail(medicationId);
    if (input.scheduleEntryId) {
      await this.assertScheduleSlotForMedication(input.scheduleEntryId, medicationId);
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_medication_administrations ' +
          '(id, medication_id, schedule_entry_id, administered_by, administered_at, dose_given, notes, parent_notified, was_missed, missed_reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, NULL, NULL, $4, false, true, $5)',
        id,
        medicationId,
        input.scheduleEntryId ?? null,
        input.notes ?? null,
        input.missedReason,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Per-medication dose history. Inherits the parent medication's
   * row scope. Reads write a VIEW_MEDICATIONS audit row.
   */
  async listForMedication(
    medicationId: string,
    actor: ResolvedActor,
  ): Promise<AdministrationResponseDto[]> {
    const { studentId } = await this.medications.loadStudentForMedication(medicationId);
    const includeRead =
      (await this.records.assertCanReadStudentExternal(studentId, actor)).isManager ||
      actor.personType === 'GUARDIAN';
    if (!includeRead) {
      throw new ForbiddenException(
        'Medication administration history is visible to nurses, admins, and parents only',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AdminRow[]>(
        SELECT_ADMIN_BASE +
          'WHERE a.medication_id = $1::uuid ORDER BY COALESCE(a.administered_at, a.created_at) DESC',
        medicationId,
      );
    });
    await this.accessLog.recordAccess(actor, studentId, 'VIEW_MEDICATIONS');
    return rows.map((r) => this.adminRowToDto(r));
  }

  /**
   * Today's school-wide medication dashboard. Admin / nurse only.
   * One row per scheduled-today slot across every active medication
   * in the school, with the administration status resolved
   * (ADMINISTERED / MISSED / PENDING). The Step 8 nurse dashboard
   * polls this for the daily checklist.
   *
   * day_of_week semantics: rows where day_of_week IS NULL apply
   * every day; rows with a specific value 0..6 apply only on that
   * weekday (ISO Sunday=0..Saturday=6, matching the Cycle 5
   * sch_periods convention).
   */
  async getDashboard(actor: ResolvedActor): Promise<MedicationDashboardRowDto[]> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('The medication dashboard is visible to nurses and admins only');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        // 1) base = every active medication's scheduled slot for today
        // 2) left join to today's administration row keyed by
        //    (schedule_entry_id, today's date) so a slot already
        //    administered or missed for today is annotated.
        'SELECT s.id::text AS schedule_entry_id, ' +
          'm.id::text AS medication_id, m.medication_name, m.dosage, m.route, m.is_self_administered, ' +
          'r.student_id::text AS student_id, ' +
          'sip.first_name AS student_first, sip.last_name AS student_last, ' +
          "TO_CHAR(s.scheduled_time, 'HH24:MI:SS') AS scheduled_time, " +
          'a.id::text AS administration_id, ' +
          'TO_CHAR(a.administered_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS administered_at, ' +
          'a.was_missed, a.missed_reason ' +
          'FROM hlth_medication_schedule s ' +
          'JOIN hlth_medications m ON m.id = s.medication_id ' +
          'JOIN hlth_student_health_records r ON r.id = m.health_record_id ' +
          'JOIN sis_students st ON st.id = r.student_id ' +
          'JOIN platform.platform_students sps ON sps.id = st.platform_student_id ' +
          'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
          'LEFT JOIN hlth_medication_administrations a ' +
          '  ON a.schedule_entry_id = s.id ' +
          "  AND ((a.administered_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date " +
          "       OR (a.was_missed = true AND (a.created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date)) " +
          'WHERE m.is_active = true ' +
          '  AND r.school_id = $1::uuid ' +
          '  AND (s.day_of_week IS NULL ' +
          "       OR s.day_of_week = EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))) " +
          'ORDER BY s.scheduled_time ASC, sip.last_name ASC, sip.first_name ASC',
        tenant.schoolId,
      )) as DashboardRow[];
      return rows.map((r) => {
        let status: 'ADMINISTERED' | 'MISSED' | 'PENDING';
        if (r.administration_id == null) {
          status = 'PENDING';
        } else if (r.was_missed) {
          status = 'MISSED';
        } else {
          status = 'ADMINISTERED';
        }
        return {
          scheduleEntryId: r.schedule_entry_id,
          medicationId: r.medication_id,
          medicationName: r.medication_name,
          dosage: r.dosage,
          route: r.route as MedicationRoute,
          isSelfAdministered: r.is_self_administered,
          studentId: r.student_id,
          studentFirstName: r.student_first,
          studentLastName: r.student_last,
          scheduledTime: r.scheduled_time,
          status,
          administrationId: r.administration_id,
          administeredAt: r.administered_at,
          missedReason: r.missed_reason as MissedReason | null,
        };
      });
    });
  }

  // ─── Internal ────────────────────────────────────────────────

  private async loadOrFail(id: string): Promise<AdministrationResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AdminRow[]>(SELECT_ADMIN_BASE + 'WHERE a.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Administration ' + id);
    return this.adminRowToDto(rows[0]!);
  }

  private async loadMedicationOrFail(medicationId: string): Promise<{
    student_id: string;
    medication_name: string;
    student_first: string | null;
    student_last: string | null;
    is_active: boolean;
  }> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT m.medication_name, m.is_active, ' +
          'r.student_id::text AS student_id, ' +
          'sip.first_name AS student_first, sip.last_name AS student_last ' +
          'FROM hlth_medications m ' +
          'JOIN hlth_student_health_records r ON r.id = m.health_record_id ' +
          'JOIN sis_students st ON st.id = r.student_id ' +
          'JOIN platform.platform_students sps ON sps.id = st.platform_student_id ' +
          'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
          'WHERE m.id = $1::uuid LIMIT 1',
        medicationId,
      )) as Array<{
        medication_name: string;
        is_active: boolean;
        student_id: string;
        student_first: string | null;
        student_last: string | null;
      }>;
      if (rows.length === 0) throw new NotFoundException('Medication ' + medicationId);
      const r = rows[0]!;
      if (!r.is_active) {
        throw new BadRequestException(
          'Medication is inactive — reactivate via PATCH before logging doses',
        );
      }
      return r;
    });
  }

  private async assertScheduleSlotForMedication(
    slotId: string,
    medicationId: string,
  ): Promise<void> {
    const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hlth_medication_schedule WHERE id = $1::uuid AND medication_id = $2::uuid LIMIT 1',
        slotId,
        medicationId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
    if (!ok) {
      throw new BadRequestException('scheduleEntryId does not belong to this medication');
    }
  }

  private adminRowToDto(r: AdminRow): AdministrationResponseDto {
    return {
      id: r.id,
      medicationId: r.medication_id,
      scheduleEntryId: r.schedule_entry_id,
      administeredById: r.administered_by,
      administeredByName: fullName(r.administered_first, r.administered_last),
      administeredAt: r.administered_at,
      doseGiven: r.dose_given,
      notes: r.notes,
      parentNotified: r.parent_notified,
      wasMissed: r.was_missed,
      missedReason: r.missed_reason as MissedReason | null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
