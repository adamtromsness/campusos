import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { StudentService } from '../sis/student.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateTimetableSlotDto,
  ListTimetableQueryDto,
  TimetableSlotResponseDto,
  UpdateTimetableSlotDto,
} from './dto/timetable.dto';

interface SlotRow {
  id: string;
  school_id: string;
  class_id: string;
  class_section_code: string;
  course_name: string;
  period_id: string;
  period_name: string;
  day_of_week: number | null;
  start_time: string;
  end_time: string;
  teacher_id: string | null;
  teacher_first_name: string | null;
  teacher_last_name: string | null;
  room_id: string;
  room_name: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

function rowToDto(row: SlotRow): TimetableSlotResponseDto {
  var teacherName: string | null = null;
  if (row.teacher_first_name && row.teacher_last_name) {
    teacherName = row.teacher_first_name + ' ' + row.teacher_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    classId: row.class_id,
    classSectionCode: row.class_section_code,
    courseName: row.course_name,
    periodId: row.period_id,
    periodName: row.period_name,
    dayOfWeek: row.day_of_week,
    startTime: row.start_time,
    endTime: row.end_time,
    teacherId: row.teacher_id,
    teacherName: teacherName,
    roomId: row.room_id,
    roomName: row.room_name,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    notes: row.notes,
  };
}

var SELECT_SLOT_BASE =
  'SELECT s.id, s.school_id, s.class_id, c.section_code AS class_section_code, ' +
  'co.name AS course_name, ' +
  's.period_id, p.name AS period_name, p.day_of_week, ' +
  "TO_CHAR(p.start_time, 'HH24:MI') AS start_time, " +
  "TO_CHAR(p.end_time, 'HH24:MI') AS end_time, " +
  's.teacher_id, ip.first_name AS teacher_first_name, ip.last_name AS teacher_last_name, ' +
  's.room_id, r.name AS room_name, ' +
  "TO_CHAR(s.effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "TO_CHAR(s.effective_to, 'YYYY-MM-DD') AS effective_to, " +
  's.notes ' +
  'FROM sch_timetable_slots s ' +
  'JOIN sis_classes c ON c.id = s.class_id ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'JOIN sch_periods p ON p.id = s.period_id ' +
  'JOIN sch_rooms r ON r.id = s.room_id ' +
  'LEFT JOIN hr_employees e ON e.id = s.teacher_id ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ';

@Injectable()
export class TimetableService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly students: StudentService,
  ) {}

  /**
   * List slots with optional filters. `onDate` filters to slots active on
   * that date (effective_from <= onDate AND (effective_to IS NULL OR
   * effective_to >= onDate)). Without onDate, all slots are returned.
   */
  async list(query: ListTimetableQueryDto): Promise<TimetableSlotResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SlotRow[]>(
        SELECT_SLOT_BASE +
          'WHERE ($1::uuid IS NULL OR s.class_id = $1::uuid) ' +
          'AND ($2::uuid IS NULL OR s.teacher_id = $2::uuid) ' +
          'AND ($3::uuid IS NULL OR s.room_id = $3::uuid) ' +
          'AND ($4::date IS NULL OR ' +
          '  (s.effective_from <= $4::date AND (s.effective_to IS NULL OR s.effective_to >= $4::date))) ' +
          'ORDER BY p.day_of_week NULLS FIRST, p.start_time, c.section_code',
        query.classId ?? null,
        query.teacherId ?? null,
        query.roomId ?? null,
        query.onDate ?? null,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<TimetableSlotResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SlotRow[]>(SELECT_SLOT_BASE + 'WHERE s.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Timetable slot ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async listForTeacher(employeeId: string): Promise<TimetableSlotResponseDto[]> {
    return this.list({ teacherId: employeeId });
  }

  async listForClass(classId: string): Promise<TimetableSlotResponseDto[]> {
    return this.list({ classId: classId });
  }

  async listForRoom(roomId: string): Promise<TimetableSlotResponseDto[]> {
    return this.list({ roomId: roomId });
  }

  /**
   * Slots for the classes a given student is actively enrolled in.
   *
   * Authorization is row-scoped: the caller must be allowed to see this
   * student via `StudentService.assertCanViewStudent` (admin / parent of /
   * assigned-class teacher / the student themself). The endpoint gate is
   * `stu-001:read` so parents and students (who don't hold sch-001:read)
   * can hit this; the row-scope check is the actual access gate.
   */
  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<TimetableSlotResponseDto[]> {
    await this.students.assertCanViewStudent(studentId, actor);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<SlotRow[]>(
        SELECT_SLOT_BASE +
          'WHERE s.class_id IN (' +
          '  SELECT class_id FROM sis_enrollments ' +
          "  WHERE student_id = $1::uuid AND status = 'ACTIVE'" +
          ') ' +
          'ORDER BY p.day_of_week NULLS FIRST, p.start_time, c.section_code',
        studentId,
      );
    });
    return rows.map(rowToDto);
  }

  async create(
    body: CreateTimetableSlotDto,
    actor: ResolvedActor,
  ): Promise<TimetableSlotResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create timetable slots');
    }
    if (body.effectiveTo && new Date(body.effectiveTo) < new Date(body.effectiveFrom)) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom');
    }
    var schoolId = getCurrentTenant().schoolId;
    var slotId = generateId();
    var teacherId = body.teacherId ?? null;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_timetable_slots (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::date, $8::date, $9)',
          slotId,
          schoolId,
          body.classId,
          body.periodId,
          teacherId,
          body.roomId,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          body.notes ?? null,
        );
      });
    } catch (e: any) {
      throw await this.translateConflict(e, body.periodId, teacherId, body.roomId);
    }
    var dto = await this.getById(slotId);
    void this.emitTimetableUpdated(slotId, 'created');
    return dto;
  }

  async update(
    id: string,
    body: UpdateTimetableSlotDto,
    actor: ResolvedActor,
  ): Promise<TimetableSlotResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update timetable slots');
    }
    var existing = await this.getById(id);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.teacherId !== undefined) {
      setClauses.push('teacher_id = $' + idx + '::uuid');
      params.push(body.teacherId);
      idx++;
    }
    if (body.roomId !== undefined) {
      setClauses.push('room_id = $' + idx + '::uuid');
      params.push(body.roomId);
      idx++;
    }
    if (body.effectiveFrom !== undefined) {
      setClauses.push('effective_from = $' + idx + '::date');
      params.push(body.effectiveFrom);
      idx++;
    }
    if (body.effectiveTo !== undefined) {
      setClauses.push('effective_to = $' + idx + '::date');
      params.push(body.effectiveTo);
      idx++;
    }
    if (body.notes !== undefined) {
      setClauses.push('notes = $' + idx);
      params.push(body.notes);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    var newPeriodId = existing.periodId;
    var newTeacherId = body.teacherId !== undefined ? body.teacherId : existing.teacherId;
    var newRoomId = body.roomId !== undefined ? body.roomId : existing.roomId;
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE sch_timetable_slots SET ' +
            setClauses.join(', ') +
            ' WHERE id = $' +
            idx +
            '::uuid',
          ...params,
        );
      });
    } catch (e: any) {
      throw await this.translateConflict(e, newPeriodId, newTeacherId, newRoomId);
    }
    var dto = await this.getById(id);
    void this.emitTimetableUpdated(id, 'updated');
    return dto;
  }

  async delete(id: string, actor: ResolvedActor): Promise<{ deleted: boolean }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can delete timetable slots');
    }
    await this.getById(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM sch_timetable_slots WHERE id = $1::uuid', id);
    });
    void this.emitTimetableUpdated(id, 'deleted');
    return { deleted: true };
  }

  /**
   * Translate a Postgres exception into a meaningful HTTP error. The
   * EXCLUSION constraints raise SQLSTATE 23P01; the constraint name encodes
   * which dimension overlapped (teacher vs room). We look up the conflicting
   * actor name so the message reads like "Teacher James Rivera is already
   * scheduled for Period 1 between 2026-01-01 and open-ended".
   */
  private async translateConflict(
    e: any,
    periodId: string,
    teacherId: string | null,
    roomId: string,
  ): Promise<Error> {
    var code = e?.code || e?.meta?.code || (e?.message && /23P01/.test(e.message) ? '23P01' : null);
    var msg = e?.message || '';
    var isExclusion = code === '23P01' || /sch_timetable_slots_(teacher|room)_no_overlap/.test(msg);
    if (!isExclusion) {
      // FK violations etc are 23503 — surface as 400.
      if (code === '23503' || /violates foreign key/i.test(msg)) {
        return new BadRequestException(
          'One of class_id / period_id / teacher_id / room_id does not exist in this tenant',
        );
      }
      // UNIQUE on (class_id, period_id, effective_from)
      if (code === '23505' || /sch_timetable_slots_class_period_from_uq/.test(msg)) {
        return new ConflictException(
          'A timetable slot already exists for this class + period + start date',
        );
      }
      return e instanceof Error ? e : new Error(String(e));
    }

    var dimension: 'teacher' | 'room' = /room_no_overlap/.test(msg) ? 'room' : 'teacher';

    if (dimension === 'room') {
      var roomName = await this.lookupRoomName(roomId);
      var periodName = await this.lookupPeriodName(periodId);
      return new ConflictException(
        'Room ' +
          (roomName || roomId) +
          ' is already scheduled for ' +
          (periodName || 'this period') +
          ' during the requested date range',
      );
    }
    if (!teacherId) {
      // Should not happen — the EXCLUSION on teacher_id treats NULL as
      // not-equal-anything. Fall back to a generic message.
      return new ConflictException('Teacher conflict on this period and date range');
    }
    var teacherName = await this.lookupTeacherName(teacherId);
    var periodLabel = await this.lookupPeriodName(periodId);
    return new ConflictException(
      'Teacher ' +
        (teacherName || teacherId) +
        ' is already scheduled for ' +
        (periodLabel || 'this period') +
        ' during the requested date range',
    );
  }

  private async lookupRoomName(roomId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ name: string }>>(
        'SELECT name FROM sch_rooms WHERE id = $1::uuid',
        roomId,
      );
    });
    return rows[0]?.name ?? null;
  }

  private async lookupPeriodName(periodId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ name: string }>>(
        'SELECT name FROM sch_periods WHERE id = $1::uuid',
        periodId,
      );
    });
    return rows[0]?.name ?? null;
  }

  private async lookupTeacherName(employeeId: string): Promise<string | null> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ first_name: string; last_name: string }>>(
        'SELECT ip.first_name, ip.last_name FROM hr_employees e ' +
          'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
          'WHERE e.id = $1::uuid',
        employeeId,
      );
    });
    if (rows.length === 0) return null;
    return rows[0]!.first_name + ' ' + rows[0]!.last_name;
  }

  private emitTimetableUpdated(slotId: string, action: string): Promise<void> {
    return this.kafka.emit({
      topic: 'sch.timetable.updated',
      key: slotId,
      sourceModule: 'scheduling',
      payload: {
        slotId: slotId,
        action: action,
      },
    });
  }
}
