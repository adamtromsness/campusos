import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  CreatePullOutDto,
  PullOutResponseDto,
  UpdatePullOutDto,
} from './dto/scheduling-advanced-b.dto';

/*
 * PullOutService — P2-17b.
 *
 * Owns sch_pull_out_interventions. The keystone — on create the
 * service pre-marks sis_attendance_records as PULL_OUT for the
 * (student regular_slot) pair on every intervention date that falls
 * inside the [start_date end_date] window AND matches the cadence.
 *
 * Cadence resolution:
 *   - WEEKLY      — every week on each weekday in days_of_week.
 *                   When days_of_week is NULL we default to the
 *                   regular slot's weekday.
 *   - FORTNIGHTLY — every other week on each weekday in days_of_week.
 *   - DAILY       — every weekday Mon..Fri.
 *   - CUSTOM      — every weekday in days_of_week (required).
 *
 * The attendance pre-mark only updates existing sis_attendance_records
 * rows — it does not insert new rows. Cycle 1 pre-populates attendance
 * on slot date, so this service flips a PRE_POPULATED PRESENT row to
 * PULL_OUT. Rows that don't exist yet will be pre-marked when the
 * AttendancePrePopulationWorker runs (out of scope here — Cycle 1
 * convention).
 */

interface InterventionRow {
  id: string;
  school_id: string;
  student_id: string;
  regular_slot_id: string;
  intervention_name: string;
  intervention_provider: string | null;
  intervention_location: string | null;
  start_date: string;
  end_date: string | null;
  frequency: string;
  days_of_week: number[] | null;
  notes: string | null;
}

const SELECT_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, student_id::text AS student_id, ' +
  'regular_slot_id::text AS regular_slot_id, intervention_name, ' +
  'intervention_provider::text AS intervention_provider, intervention_location, ' +
  "to_char(start_date, 'YYYY-MM-DD') AS start_date, " +
  "to_char(end_date, 'YYYY-MM-DD') AS end_date, frequency, days_of_week, notes " +
  'FROM sch_pull_out_interventions ';

function rowToDto(row: InterventionRow, attendancePremarked: number): PullOutResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    studentId: row.student_id,
    regularSlotId: row.regular_slot_id,
    interventionName: row.intervention_name,
    interventionProvider: row.intervention_provider,
    interventionLocation: row.intervention_location,
    startDate: row.start_date,
    endDate: row.end_date,
    frequency: row.frequency as PullOutResponseDto['frequency'],
    daysOfWeek: row.days_of_week,
    notes: row.notes,
    attendancePremarked,
  };
}

@Injectable()
export class PullOutService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Pull-out intervention writes require sch-001:admin (school admin).',
      );
    }
  }

  async list(studentId?: string): Promise<PullOutResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return studentId
        ? client.$queryRawUnsafe<InterventionRow[]>(
            SELECT_BASE +
              'WHERE school_id = $1::uuid AND student_id = $2::uuid ORDER BY start_date DESC',
            tenant.schoolId,
            studentId,
          )
        : client.$queryRawUnsafe<InterventionRow[]>(
            SELECT_BASE + 'WHERE school_id = $1::uuid ORDER BY start_date DESC',
            tenant.schoolId,
          );
    });
    return rows.map((r) => rowToDto(r, 0));
  }

  async getById(id: string): Promise<PullOutResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<InterventionRow[]>(
        SELECT_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Pull-out intervention not found');
    return rowToDto(rows[0]!, 0);
  }

  async create(body: CreatePullOutDto, actor: ResolvedActor): Promise<PullOutResponseDto> {
    this.assertAdmin(actor);
    if (body.frequency === 'CUSTOM' && (!body.daysOfWeek || body.daysOfWeek.length === 0)) {
      throw new BadRequestException(
        'CUSTOM frequency requires at least one weekday in daysOfWeek.',
      );
    }
    const tenant = getCurrentTenant();

    // REVIEW-P2C17 BLOCKING 5 — validate every soft-FK reference
    // against current school BEFORE inserting. A School A admin
    // supplying a School B studentId / regularSlotId / provider gets
    // 400 here before any pre-marking touches sis_attendance_records.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const refs = await client.$queryRawUnsafe<
        Array<{ student_ok: boolean; slot_ok: boolean; provider_ok: boolean }>
      >(
        'SELECT ' +
          '(EXISTS (SELECT 1 FROM sis_students WHERE id = $1::uuid AND school_id = $4::uuid)) AS student_ok, ' +
          '(EXISTS (SELECT 1 FROM sch_timetable_slots WHERE id = $2::uuid AND school_id = $4::uuid)) AS slot_ok, ' +
          '($3::uuid IS NULL OR EXISTS (SELECT 1 FROM hr_employees WHERE id = $3::uuid AND school_id = $4::uuid)) AS provider_ok',
        body.studentId,
        body.regularSlotId,
        body.interventionProvider ?? null,
        tenant.schoolId,
      );
      const r = refs[0]!;
      if (!r.student_ok) {
        throw new BadRequestException('studentId does not match a student in this school.');
      }
      if (!r.slot_ok) {
        throw new BadRequestException(
          'regularSlotId does not match a timetable slot in this school.',
        );
      }
      if (!r.provider_ok) {
        throw new BadRequestException(
          'interventionProvider does not match an employee in this school.',
        );
      }
    });

    const id = generateId();
    const daysParam = body.daysOfWeek ? body.daysOfWeek.join(',') : null;

    // INSERT the intervention.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_pull_out_interventions (id, school_id, student_id, regular_slot_id, intervention_name, intervention_provider, intervention_location, start_date, end_date, frequency, days_of_week, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9, $10, ' +
          (daysParam === null ? 'NULL' : "string_to_array($11, ',')::smallint[]") +
          ', $12)',
        ...(daysParam === null
          ? [
              id,
              tenant.schoolId,
              body.studentId,
              body.regularSlotId,
              body.interventionName,
              body.interventionProvider ?? null,
              body.interventionLocation ?? null,
              body.startDate,
              body.endDate ?? null,
              body.frequency,
              body.notes ?? null,
            ]
          : [
              id,
              tenant.schoolId,
              body.studentId,
              body.regularSlotId,
              body.interventionName,
              body.interventionProvider ?? null,
              body.interventionLocation ?? null,
              body.startDate,
              body.endDate ?? null,
              body.frequency,
              daysParam,
              body.notes ?? null,
            ]),
      );
    });

    // Pre-mark attendance as PULL_OUT for each cadence-matching date.
    const premarked = await this.premarkAttendance(id);
    const row = await this.getById(id);
    return { ...row, attendancePremarked: premarked };
  }

  async patch(
    id: string,
    body: UpdatePullOutDto,
    actor: ResolvedActor,
  ): Promise<PullOutResponseDto> {
    this.assertAdmin(actor);
    const sets: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (body.endDate !== undefined) {
      sets.push('end_date = $' + i + '::date');
      args.push(body.endDate);
      i += 1;
    }
    if (body.frequency !== undefined) {
      sets.push('frequency = $' + i);
      args.push(body.frequency);
      i += 1;
    }
    if (body.daysOfWeek !== undefined) {
      sets.push('days_of_week = string_to_array($' + i + ", ',')::smallint[]");
      args.push(body.daysOfWeek.join(','));
      i += 1;
    }
    if (body.notes !== undefined) {
      sets.push('notes = $' + i);
      args.push(body.notes);
      i += 1;
    }
    if (sets.length === 0) return this.getById(id);
    // REVIEW-P2C17 BLOCKING 5 — confirm school ownership before
    // mutating. getById throws 404 don't-leak-existence if the
    // intervention belongs to a foreign school.
    await this.getById(id);
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    args.push(id);
    args.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE sch_pull_out_interventions SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          i +
          '::uuid AND school_id = $' +
          (i + 1) +
          '::uuid',
        ...args,
      );
    });
    return this.getById(id);
  }

  /**
   * Pre-mark sis_attendance_records.status = 'PULL_OUT' for every
   * (student regular_slot) tuple on the cadence-matching dates inside
   * the [start_date end_date] window. Returns the number of attendance
   * rows updated. Idempotent — re-running over an already-PULL_OUT row
   * is a no-op.
   *
   * The Cycle 1 sis_attendance_records partitioning makes this an
   * UPDATE rather than INSERT — Cycle 1 pre-populates attendance from
   * timetable slots on the calendar date, so the attendance row already
   * exists by the time the pull-out lands. We flip the PRE_POPULATED
   * row from its default (PRESENT) to PULL_OUT.
   */
  private async premarkAttendance(interventionId: string): Promise<number> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C17 BLOCKING 5 — resolve the intervention shape only
      // when the intervention + its slot both belong to the current
      // school. Defence-in-depth against any path that somehow lands
      // an intervention with a foreign-school slot.
      const rows = await client.$queryRawUnsafe<
        {
          student_id: string;
          regular_slot_id: string;
          start_date: string;
          end_date: string | null;
          frequency: string;
          days_of_week: number[] | null;
          period_id: string;
        }[]
      >(
        'SELECT i.student_id::text AS student_id, i.regular_slot_id::text AS regular_slot_id, ' +
          "to_char(i.start_date, 'YYYY-MM-DD') AS start_date, " +
          "to_char(i.end_date, 'YYYY-MM-DD') AS end_date, " +
          'i.frequency, i.days_of_week, s.period_id::text AS period_id ' +
          'FROM sch_pull_out_interventions i ' +
          'JOIN sch_timetable_slots s ON s.id = i.regular_slot_id ' +
          'WHERE i.id = $1::uuid AND i.school_id = $2::uuid AND s.school_id = $2::uuid',
        interventionId,
        tenant.schoolId,
      );
      if (rows.length === 0) return 0;
      const inter = rows[0]!;
      const start = new Date(inter.start_date + 'T00:00:00Z');
      // Cap end at start + 90 days when end_date is null, to bound the
      // pre-mark window for open-ended interventions. Operators can
      // re-run the pre-mark later (idempotent UPDATE — no double-mark).
      const end = inter.end_date
        ? new Date(inter.end_date + 'T00:00:00Z')
        : new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);

      const targetDates: string[] = [];
      let cursor = new Date(start.getTime());
      let weekIndex = 0;
      let weekStartIso = '';
      while (cursor.getTime() <= end.getTime()) {
        const dow = cursor.getUTCDay(); // 0..6 — Postgres convention
        const iso = cursor.toISOString().slice(0, 10);
        const isWeekday = dow >= 1 && dow <= 5;
        let matches = false;

        if (inter.frequency === 'DAILY') {
          matches = isWeekday;
        } else if (inter.frequency === 'WEEKLY') {
          const days = inter.days_of_week ?? [];
          matches = isWeekday && (days.length === 0 || days.includes(dow));
        } else if (inter.frequency === 'FORTNIGHTLY') {
          const days = inter.days_of_week ?? [];
          if (!weekStartIso) weekStartIso = iso;
          // Each calendar week = increment weekIndex on Monday.
          if (dow === 1 && iso !== weekStartIso) {
            weekIndex += 1;
            weekStartIso = iso;
          }
          matches = isWeekday && days.includes(dow) && weekIndex % 2 === 0;
        } else if (inter.frequency === 'CUSTOM') {
          const days = inter.days_of_week ?? [];
          matches = isWeekday && days.includes(dow);
        }

        if (matches) targetDates.push(iso);
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      }

      if (targetDates.length === 0) return 0;

      // Look up class_id from the slot — sis_attendance_records is
      // partitioned by (school_year, class_id) so we need it on the
      // WHERE for partition pruning. REVIEW-P2C17 BLOCKING 5 —
      // school-scope this slot lookup too.
      const slotInfo = await client.$queryRawUnsafe<{ class_id: string | null }[]>(
        'SELECT class_id::text AS class_id FROM sch_timetable_slots ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid',
        inter.regular_slot_id,
        tenant.schoolId,
      );
      const classId = slotInfo[0]?.class_id;
      if (!classId) return 0;

      // REVIEW-P2C17 BLOCKING 5 — UPDATE existing attendance rows for
      // the (student class date) tuples ONLY when the student is in
      // the current school. The JOIN against sis_students is the
      // schema-side guard so an attendance row whose student_id ended
      // up cross-school (impossible today since attendance partitioning
      // keys on class_id which itself school-scopes through sis_classes,
      // but the defence-in-depth check makes the contract explicit).
      // Idempotent — re-running over PULL_OUT rows is a no-op via the
      // status<>'PULL_OUT' guard.
      const result = await client.$executeRawUnsafe(
        'UPDATE sis_attendance_records ar SET status = $1, evidence_source = $2, marked_at = now() ' +
          'FROM sis_students stu ' +
          'WHERE ar.class_id = $3::uuid AND ar.student_id = $4::uuid ' +
          'AND ar.date = ANY(string_to_array($5, $6)::date[]) ' +
          "AND ar.status <> 'PULL_OUT' " +
          'AND stu.id = ar.student_id AND stu.school_id = $7::uuid',
        'PULL_OUT',
        'SYSTEM_INFERRED',
        classId,
        inter.student_id,
        targetDates.join(','),
        ',',
        tenant.schoolId,
      );
      return Number(result);
    });
  }
}
