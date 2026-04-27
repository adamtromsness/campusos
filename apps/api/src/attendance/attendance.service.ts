import { Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import {
  AttendanceRecordDto,
  BatchAttendanceEntryDto,
  BatchSubmitResultDto,
  MarkAttendanceDto,
} from './dto/attendance.dto';

interface AttendanceRow {
  id: string;
  student_id: string;
  student_number: string | null;
  first_name: string;
  last_name: string;
  class_id: string;
  date: Date | string;
  period: string;
  status: string;
  confirmation_status: string;
  parent_explanation: string | null;
  marked_by: string | null;
  marked_at: Date | string | null;
  absence_request_id: string | null;
}

interface ClassPartitionKeys {
  schoolId: string;
  schoolYear: string;
}

function rowToDto(r: AttendanceRow): AttendanceRecordDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentNumber: r.student_number,
    firstName: r.first_name,
    lastName: r.last_name,
    fullName: r.first_name + ' ' + r.last_name,
    classId: r.class_id,
    date: typeof r.date === 'string' ? r.date : r.date.toISOString().slice(0, 10),
    period: r.period,
    status: r.status,
    confirmationStatus: r.confirmation_status,
    parentExplanation: r.parent_explanation,
    markedBy: r.marked_by,
    markedAt: r.marked_at
      ? typeof r.marked_at === 'string'
        ? r.marked_at
        : r.marked_at.toISOString()
      : null,
    absenceRequestId: r.absence_request_id,
  };
}

var SELECT_ATTENDANCE_BASE =
  'SELECT a.id, a.student_id, a.class_id, a.date::text AS date, a.period, a.status, a.confirmation_status, ' +
  'a.parent_explanation, a.marked_by, a.marked_at, a.absence_request_id, ' +
  's.student_number, ip.first_name, ip.last_name ' +
  'FROM sis_attendance_records a ' +
  'JOIN sis_students s ON s.id = a.student_id ' +
  'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'JOIN platform.iam_person ip ON ip.id = ps.person_id ';

@Injectable()
export class AttendanceService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Resolve the partition keys for a class:
   * - school_id (denormalized scoping)
   * - school_year (academic_year.start_date used as the partition value, per ADR-007)
   *
   * Throws 404 if the class doesn't exist.
   */
  private async resolveClassPartitionKeys(classId: string): Promise<ClassPartitionKeys> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ school_id: string; school_year: string }>>(
        'SELECT c.school_id, ay.start_date::text AS school_year ' +
          'FROM sis_classes c ' +
          'JOIN sis_academic_years ay ON ay.id = c.academic_year_id ' +
          'WHERE c.id = $1::uuid',
        classId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
    return { schoolId: rows[0]!.school_id, schoolYear: rows[0]!.school_year };
  }

  /**
   * Read the class roster + attendance for (date, period?). For students who
   * have no attendance row yet, ensures a PRESENT/PRE_POPULATED row exists
   * (lazy pre-population — fires the first time a teacher opens the page).
   */
  async getClassAttendance(
    classId: string,
    date: string,
    period?: string,
  ): Promise<AttendanceRecordDto[]> {
    var partitionKeys = await this.resolveClassPartitionKeys(classId);

    if (period) {
      await this.prePopulateClassPeriod(classId, date, period, partitionKeys);
    }

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AttendanceRow[]>(
        SELECT_ATTENDANCE_BASE +
          'WHERE a.class_id = $1::uuid AND a.date = $2::date ' +
          'AND ($3::text IS NULL OR a.period = $3::text) ' +
          'ORDER BY a.period, ip.last_name, ip.first_name',
        classId,
        date,
        period ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  /**
   * Insert a PRESENT/PRE_POPULATED row for every active enrollment that
   * doesn't already have one for (class, date, period). Idempotent via the
   * natural-key unique on sis_attendance_records.
   *
   * Wrapped in a tenant transaction so a partial failure rolls back.
   */
  async prePopulateClassPeriod(
    classId: string,
    date: string,
    period: string,
    pks?: ClassPartitionKeys,
  ): Promise<{ inserted: number }> {
    var keys = pks || (await this.resolveClassPartitionKeys(classId));

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var missing = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT e.student_id ' +
          'FROM sis_enrollments e ' +
          "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE' " +
          'AND NOT EXISTS (' +
          'SELECT 1 FROM sis_attendance_records r ' +
          'WHERE r.class_id = $1::uuid AND r.date = $2::date AND r.period = $3 AND r.student_id = e.student_id' +
          ')',
        classId,
        date,
        period,
      );

      if (missing.length === 0) return { inserted: 0 };

      for (var i = 0; i < missing.length; i++) {
        var studentId = missing[i]!.student_id;
        var newId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_attendance_records ' +
            '(id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status) ' +
            "VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, $7, 'PRESENT', 'PRE_POPULATED') " +
            'ON CONFLICT ON CONSTRAINT sis_attendance_records_natural_uq DO NOTHING',
          newId,
          keys.schoolId,
          keys.schoolYear,
          studentId,
          classId,
          date,
          period,
        );
      }
      return { inserted: missing.length };
    });
  }

  /**
   * Mark a single attendance record (teacher tapping one student to TARDY,
   * for example). Looks up the row first to recover the partition keys
   * (id alone isn't enough on a partitioned table for an efficient UPDATE),
   * then UPDATEs and emits Kafka events.
   */
  async markIndividual(
    recordId: string,
    patch: MarkAttendanceDto,
    actorAccountId: string,
  ): Promise<AttendanceRecordDto> {
    var existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AttendanceRow[]>(
        SELECT_ATTENDANCE_BASE + 'WHERE a.id = $1::uuid',
        recordId,
      );
    });
    if (existing.length === 0)
      throw new NotFoundException('Attendance record ' + recordId + ' not found');
    var prior = existing[0]!;

    var updated = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE sis_attendance_records SET ' +
          'status = $1, ' +
          'parent_explanation = COALESCE($2, parent_explanation), ' +
          'marked_by = $3::uuid, ' +
          'marked_at = now(), ' +
          'updated_at = now() ' +
          'WHERE id = $4::uuid AND class_id = $5::uuid',
        patch.status,
        patch.parentExplanation ?? null,
        actorAccountId,
        recordId,
        prior.class_id,
      );
      var refreshed = await tx.$queryRawUnsafe<AttendanceRow[]>(
        SELECT_ATTENDANCE_BASE + 'WHERE a.id = $1::uuid AND a.class_id = $2::uuid',
        recordId,
        prior.class_id,
      );
      return refreshed[0]!;
    });

    void this.emitMarkEvents(updated, prior.status, actorAccountId);
    return rowToDto(updated);
  }

  /**
   * Confirm a class period in one shot. Inputs are exception-only — students
   * not in the body are treated as PRESENT. Each row is updated, the period
   * is flipped to CONFIRMED, and a per-period Kafka event is emitted.
   */
  async batchSubmit(
    classId: string,
    date: string,
    period: string,
    records: BatchAttendanceEntryDto[],
    actorAccountId: string,
  ): Promise<BatchSubmitResultDto> {
    var keys = await this.resolveClassPartitionKeys(classId);
    await this.prePopulateClassPeriod(classId, date, period, keys);

    var exceptionByStudent: Record<string, BatchAttendanceEntryDto> = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i]!;
      exceptionByStudent[r.studentId] = r;
    }

    var summary = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rosterRows = await tx.$queryRawUnsafe<
        Array<{ id: string; student_id: string; status: string }>
      >(
        'SELECT id, student_id, status FROM sis_attendance_records ' +
          'WHERE class_id = $1::uuid AND date = $2::date AND period = $3 ' +
          'FOR UPDATE',
        classId,
        date,
        period,
      );

      var counts: Record<string, number> = {
        PRESENT: 0,
        ABSENT: 0,
        TARDY: 0,
        EARLY_DEPARTURE: 0,
        EXCUSED: 0,
      };

      for (var j = 0; j < rosterRows.length; j++) {
        var row = rosterRows[j]!;
        var override = exceptionByStudent[row.student_id];
        var nextStatus = override ? override.status : 'PRESENT';
        var nextNote = override ? (override.parentExplanation ?? null) : null;
        counts[nextStatus] = (counts[nextStatus] || 0) + 1;
        await tx.$executeRawUnsafe(
          'UPDATE sis_attendance_records SET ' +
            'status = $1, ' +
            'parent_explanation = $2, ' +
            "confirmation_status = 'CONFIRMED', " +
            'marked_by = $3::uuid, ' +
            'marked_at = now(), ' +
            'updated_at = now() ' +
            'WHERE id = $4::uuid AND class_id = $5::uuid',
          nextStatus,
          nextNote,
          actorAccountId,
          row.id,
          classId,
        );
      }

      return {
        totalStudents: rosterRows.length,
        counts,
        rosterRows,
      };
    });

    var nowIso = new Date().toISOString();

    void this.kafka.emit('att.attendance.confirmed', classId, {
      classId,
      date,
      period,
      schoolId: keys.schoolId,
      schoolYear: keys.schoolYear,
      totalStudents: summary.totalStudents,
      counts: summary.counts,
      confirmedAt: nowIso,
      confirmedBy: actorAccountId,
    });
    for (var k = 0; k < summary.rosterRows.length; k++) {
      var rr = summary.rosterRows[k]!;
      var newStatus = exceptionByStudent[rr.student_id]?.status || 'PRESENT';
      if (newStatus === 'TARDY') {
        void this.kafka.emit('att.student.marked_tardy', rr.student_id, {
          recordId: rr.id,
          studentId: rr.student_id,
          classId,
          date,
          period,
          markedAt: nowIso,
        });
      } else if (newStatus === 'ABSENT') {
        void this.kafka.emit('att.student.marked_absent', rr.student_id, {
          recordId: rr.id,
          studentId: rr.student_id,
          classId,
          date,
          period,
          markedAt: nowIso,
        });
      }
    }

    return {
      classId,
      date,
      period,
      totalStudents: summary.totalStudents,
      presentCount: summary.counts.PRESENT || 0,
      tardyCount: summary.counts.TARDY || 0,
      absentCount: summary.counts.ABSENT || 0,
      earlyDepartureCount: summary.counts.EARLY_DEPARTURE || 0,
      excusedCount: summary.counts.EXCUSED || 0,
      confirmedAt: nowIso,
    };
  }

  /**
   * Attendance history for a student. Optional date range; defaults to the
   * current academic year.
   */
  async getStudentAttendance(
    studentId: string,
    fromDate?: string,
    toDate?: string,
  ): Promise<AttendanceRecordDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AttendanceRow[]>(
        SELECT_ATTENDANCE_BASE +
          'WHERE a.student_id = $1::uuid ' +
          'AND ($2::date IS NULL OR a.date >= $2::date) ' +
          'AND ($3::date IS NULL OR a.date <= $3::date) ' +
          'ORDER BY a.date DESC, a.period',
        studentId,
        fromDate ?? null,
        toDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  private emitMarkEvents(row: AttendanceRow, priorStatus: string, actorAccountId: string): void {
    void this.kafka.emit('att.attendance.marked', row.id, {
      recordId: row.id,
      studentId: row.student_id,
      classId: row.class_id,
      date: typeof row.date === 'string' ? row.date : row.date.toISOString().slice(0, 10),
      period: row.period,
      priorStatus,
      newStatus: row.status,
      markedBy: actorAccountId,
      markedAt: row.marked_at,
    });
    if (row.status === 'TARDY' && priorStatus !== 'TARDY') {
      void this.kafka.emit('att.student.marked_tardy', row.student_id, {
        recordId: row.id,
        studentId: row.student_id,
        classId: row.class_id,
        date: typeof row.date === 'string' ? row.date : row.date.toISOString().slice(0, 10),
        period: row.period,
        markedAt: row.marked_at,
      });
    } else if (row.status === 'ABSENT' && priorStatus !== 'ABSENT') {
      void this.kafka.emit('att.student.marked_absent', row.student_id, {
        recordId: row.id,
        studentId: row.student_id,
        classId: row.class_id,
        date: typeof row.date === 'string' ? row.date : row.date.toISOString().slice(0, 10),
        period: row.period,
        markedAt: row.marked_at,
      });
    }
  }
}
