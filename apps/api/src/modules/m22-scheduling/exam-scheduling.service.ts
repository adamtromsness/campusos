import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import {
  AddExamRoomDto,
  AssignInvigilatorDto,
  AssignSeatDto,
  CreateExamSessionDto,
  ExamInvigilatorResponseDto,
  ExamRoomConflictDto,
  ExamRoomResponseDto,
  ExamSeatingResponseDto,
  ExamSessionResponseDto,
} from './dto/scheduling-advanced-b.dto';

/*
 * ExamSchedulingService — P2-17b.
 *
 * Owns sch_exam_sessions + sch_exam_session_rooms + sch_exam_seatings +
 * sch_exam_invigilator_assignments.
 *
 * Keystone: seat assignment auto-populates accommodation fields
 * (extra_time_minutes separate_room reader_required scribe_required)
 * from sis_student_active_accommodations on accommodation_type strings
 * EXTENDED_TIME plus SEPARATE_LOCATION plus READ_ALOUD plus SCRIBE.
 *
 * Room conflict detection is service-layer (no schema EXCLUSION
 * because exams cross the daily schedule grain). findRoomConflicts
 * uses tstzrange overlap against active sch_timetable_slots that share
 * the room on the exam_date weekday plus any CONFIRMED
 * sch_room_bookings in the exam window.
 */

interface SessionRow {
  id: string;
  school_id: string;
  exam_name: string;
  subject_id: string | null;
  exam_date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  extra_time_minutes: number;
  notes: string | null;
}

interface RoomRow {
  id: string;
  session_id: string;
  room_id: string;
  capacity: number;
  is_main_room: boolean;
  notes: string | null;
}

interface SeatingRow {
  id: string;
  session_id: string;
  student_id: string;
  room_id: string;
  seat_number: string | null;
  extra_time_minutes: number;
  separate_room: boolean;
  reader_required: boolean;
  scribe_required: boolean;
}

interface InvigilatorRow {
  id: string;
  session_id: string;
  room_id: string;
  invigilator_id: string;
  is_lead: boolean;
}

interface AccommodationRow {
  accommodation_type: string;
}

const SELECT_SESSION = `SELECT id::text AS id, school_id::text AS school_id, exam_name, subject_id::text AS subject_id,
  to_char(exam_date, 'YYYY-MM-DD') AS exam_date,
  to_char(start_time, 'HH24:MI:SS') AS start_time,
  to_char(end_time, 'HH24:MI:SS') AS end_time,
  duration_minutes, extra_time_minutes, notes
FROM sch_exam_sessions `;

function sessionRowToDto(
  row: SessionRow,
): Omit<ExamSessionResponseDto, 'rooms' | 'seatings' | 'invigilators'> {
  return {
    id: row.id,
    schoolId: row.school_id,
    examName: row.exam_name,
    subjectId: row.subject_id,
    examDate: row.exam_date,
    startTime: row.start_time,
    endTime: row.end_time,
    durationMinutes: row.duration_minutes,
    extraTimeMinutes: row.extra_time_minutes,
    notes: row.notes,
  };
}

function roomRowToDto(row: RoomRow): ExamRoomResponseDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    roomId: row.room_id,
    capacity: row.capacity,
    isMainRoom: row.is_main_room,
    notes: row.notes,
  };
}

function seatingRowToDto(row: SeatingRow): ExamSeatingResponseDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    studentId: row.student_id,
    roomId: row.room_id,
    seatNumber: row.seat_number,
    extraTimeMinutes: row.extra_time_minutes,
    separateRoom: row.separate_room,
    readerRequired: row.reader_required,
    scribeRequired: row.scribe_required,
  };
}

function invigilatorRowToDto(row: InvigilatorRow): ExamInvigilatorResponseDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    roomId: row.room_id,
    invigilatorId: row.invigilator_id,
    isLead: row.is_lead,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err.code === 'P2010' || err.meta?.code === '23505';
}

@Injectable()
export class ExamSchedulingService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Exam scheduling requires sch-001:admin (school admin).');
    }
  }

  async listSessions(): Promise<ExamSessionResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const sessions = await client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION + 'WHERE school_id = $1::uuid ORDER BY exam_date DESC, start_time ASC',
        tenant.schoolId,
      );
      const out: ExamSessionResponseDto[] = [];
      for (const s of sessions) {
        out.push({ ...sessionRowToDto(s), rooms: [], seatings: [], invigilators: [] });
      }
      return out;
    });
  }

  async getSession(id: string): Promise<ExamSessionResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const sessions = await client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      );
      if (sessions.length === 0) throw new NotFoundException('Exam session not found');

      const rooms = await client.$queryRawUnsafe<RoomRow[]>(
        'SELECT id::text AS id, session_id::text AS session_id, room_id::text AS room_id, capacity, is_main_room, notes ' +
          'FROM sch_exam_session_rooms WHERE session_id = $1::uuid ORDER BY is_main_room DESC, room_id ASC',
        id,
      );
      const seatings = await client.$queryRawUnsafe<SeatingRow[]>(
        'SELECT id::text AS id, session_id::text AS session_id, student_id::text AS student_id, ' +
          'room_id::text AS room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required ' +
          'FROM sch_exam_seatings WHERE session_id = $1::uuid ORDER BY room_id ASC, seat_number ASC NULLS LAST',
        id,
      );
      const invigilators = await client.$queryRawUnsafe<InvigilatorRow[]>(
        'SELECT id::text AS id, session_id::text AS session_id, room_id::text AS room_id, ' +
          'invigilator_id::text AS invigilator_id, is_lead ' +
          'FROM sch_exam_invigilator_assignments WHERE session_id = $1::uuid ORDER BY is_lead DESC, invigilator_id ASC',
        id,
      );
      return {
        ...sessionRowToDto(sessions[0]!),
        rooms: rooms.map(roomRowToDto),
        seatings: seatings.map(seatingRowToDto),
        invigilators: invigilators.map(invigilatorRowToDto),
      };
    });
  }

  async createSession(
    body: CreateExamSessionDto,
    actor: ResolvedActor,
  ): Promise<ExamSessionResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_exam_sessions (id, school_id, exam_name, subject_id, exam_date, start_time, end_time, duration_minutes, extra_time_minutes, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::time, $7::time, $8::int, $9::int, $10, $11::uuid)',
          id,
          tenant.schoolId,
          body.examName,
          body.subjectId ?? null,
          body.examDate,
          body.startTime,
          body.endTime,
          body.durationMinutes,
          body.extraTimeMinutes ?? 0,
          body.notes ?? null,
          actor.accountId,
        );
      });
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string; message?: string } };
      if (err.meta?.code === '23514') {
        throw new BadRequestException(
          'Exam session rejected — end_time must be after start_time and duration must be positive.',
        );
      }
      throw e;
    }
    return this.getSession(id);
  }

  async addRoom(
    sessionId: string,
    body: AddExamRoomDto,
    actor: ResolvedActor,
  ): Promise<ExamRoomResponseDto> {
    this.assertAdmin(actor);
    await this.assertSessionExists(sessionId);
    // REVIEW-P2C17 BLOCKING 4 — validate room belongs to current school.
    await this.assertRoomBelongsToSchool(body.roomId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_exam_session_rooms (id, session_id, room_id, capacity, is_main_room, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int, $5, $6)',
          id,
          sessionId,
          body.roomId,
          body.capacity,
          body.isMainRoom ?? true,
          body.notes ?? null,
        );
      });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('This room is already assigned to the exam session.');
      }
      throw e;
    }
    // REVIEW-P2C17 BLOCKING 4 — reload joins through the parent
    // session school predicate so foreign-school child rows can never
    // surface even by direct ID.
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<RoomRow[]>(
        'SELECT r.id::text AS id, r.session_id::text AS session_id, r.room_id::text AS room_id, ' +
          'r.capacity, r.is_main_room, r.notes ' +
          'FROM sch_exam_session_rooms r ' +
          'JOIN sch_exam_sessions es ON es.id = r.session_id ' +
          'WHERE r.id = $1::uuid AND es.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
      return roomRowToDto(rows[0]!);
    });
  }

  /**
   * Service-layer room conflict detection — no schema EXCLUSION
   * because exams cross the timetable grain. We construct the exam
   * window as tstzrange(exam_date + start_time, exam_date + end_time)
   * and check overlap against:
   *   1. Active sch_timetable_slots sharing the room AND covering the
   *      exam_date (effective_from <= exam_date <= COALESCE(effective_to, infinity)).
   *      For each such slot the period clock-time is built from
   *      sch_periods.start_time + end_time on the same exam date and
   *      checked for overlap against the exam window.
   *   2. CONFIRMED sch_room_bookings sharing the room with overlapping
   *      tstzrange in the exam window.
   */
  async findRoomConflicts(sessionId: string): Promise<ExamRoomConflictDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C17 BLOCKING 4 — school-scope the session lookup so
      // the conflict endpoint can never run against a foreign-school
      // session UUID. 404 don't-leak-existence on miss.
      const sessions = await client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        sessionId,
        tenant.schoolId,
      );
      if (sessions.length === 0) throw new NotFoundException('Exam session not found');
      const session = sessions[0]!;

      const rooms = await client.$queryRawUnsafe<{ room_id: string }[]>(
        'SELECT room_id::text AS room_id FROM sch_exam_session_rooms WHERE session_id = $1::uuid',
        sessionId,
      );

      const conflicts: ExamRoomConflictDto[] = [];
      for (const r of rooms) {
        // 1. Timetable slots that share the room and cover the exam_date.
        const slotConflicts = await client.$queryRawUnsafe<
          { id: string; period_start: string; period_end: string }[]
        >(
          'SELECT s.id::text AS id, ' +
            "to_char(p.start_time, 'HH24:MI:SS') AS period_start, " +
            "to_char(p.end_time, 'HH24:MI:SS') AS period_end " +
            'FROM sch_timetable_slots s JOIN sch_periods p ON p.id = s.period_id ' +
            'WHERE s.room_id = $1::uuid ' +
            'AND s.effective_from <= $2::date ' +
            'AND (s.effective_to IS NULL OR s.effective_to >= $2::date) ' +
            'AND tstzrange(($2::date + p.start_time)::timestamptz, ($2::date + p.end_time)::timestamptz, $5) ' +
            ' && tstzrange(($2::date + $3::time)::timestamptz, ($2::date + $4::time)::timestamptz, $5)',
          r.room_id,
          session.exam_date,
          session.start_time,
          session.end_time,
          '[)',
        );
        for (const c of slotConflicts) {
          conflicts.push({
            roomId: r.room_id,
            conflictId: c.id,
            conflictType: 'TIMETABLE_SLOT',
            conflictWindow: c.period_start + '..' + c.period_end,
          });
        }

        // 2. CONFIRMED room bookings overlapping the exam window.
        const bookingConflicts = await client.$queryRawUnsafe<
          { id: string; start_at: string; end_at: string }[]
        >(
          'SELECT id::text AS id, ' +
            "to_char(start_at, 'YYYY-MM-DD HH24:MI:SSOF') AS start_at, " +
            "to_char(end_at, 'YYYY-MM-DD HH24:MI:SSOF') AS end_at " +
            'FROM sch_room_bookings WHERE room_id = $1::uuid AND status = $4 ' +
            "AND tstzrange(start_at, end_at, '[)') " +
            " && tstzrange(($2::date + $3::time)::timestamptz, ($2::date + $5::time)::timestamptz, '[)')",
          r.room_id,
          session.exam_date,
          session.start_time,
          'CONFIRMED',
          session.end_time,
        );
        for (const c of bookingConflicts) {
          conflicts.push({
            roomId: r.room_id,
            conflictId: c.id,
            conflictType: 'ROOM_BOOKING',
            conflictWindow: c.start_at + '..' + c.end_at,
          });
        }
      }
      return conflicts;
    });
  }

  /**
   * Auto-populate accommodation fields from sis_student_active_accommodations.
   * Returns the seat row. Admin can override via explicit body fields.
   */
  async assignSeat(
    sessionId: string,
    body: AssignSeatDto,
    actor: ResolvedActor,
  ): Promise<ExamSeatingResponseDto> {
    this.assertAdmin(actor);
    await this.assertSessionExists(sessionId);
    // REVIEW-P2C17 BLOCKING 4 — validate the student + room belong to
    // the current school BEFORE inserting. A School A admin who
    // supplies a School B student UUID or room UUID gets 400 here.
    await this.assertStudentBelongsToSchool(body.studentId);
    await this.assertRoomBelongsToSchool(body.roomId);

    const id = generateId();

    // Resolve accommodations for the student — school-scope through
    // sis_student_active_accommodations.school_id (the ADR-030 read
    // model carries school_id) so accommodation flags can never leak
    // across schools.
    const tenant = getCurrentTenant();
    const session = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const sessions = await client.$queryRawUnsafe<SessionRow[]>(
        SELECT_SESSION + 'WHERE id = $1::uuid AND school_id = $2::uuid',
        sessionId,
        tenant.schoolId,
      );
      return sessions[0]!;
    });

    const accommodations = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AccommodationRow[]>(
        'SELECT accommodation_type FROM sis_student_active_accommodations ' +
          'WHERE student_id = $1::uuid AND school_id = $3::uuid ' +
          'AND (effective_from IS NULL OR effective_from <= $2::date) ' +
          'AND (effective_to IS NULL OR effective_to >= $2::date) ' +
          "AND applies_to IN ('ALL_ASSESSMENTS', 'SPECIFIC')",
        body.studentId,
        session.exam_date,
        tenant.schoolId,
      );
    });

    // Compute defaults from accommodations.
    let defaultExtra = 0;
    let defaultSeparate = false;
    let defaultReader = false;
    let defaultScribe = false;
    for (const acc of accommodations) {
      const type = acc.accommodation_type.toUpperCase();
      if (type === 'EXTENDED_TIME' || type === 'EXTRA_TIME') {
        // 25% extension by default
        defaultExtra = Math.max(defaultExtra, Math.ceil(session.duration_minutes * 0.25));
      } else if (type === 'SEPARATE_LOCATION' || type === 'SEPARATE_ROOM') {
        defaultSeparate = true;
      } else if (type === 'READ_ALOUD' || type === 'READER') {
        defaultReader = true;
      } else if (type === 'SCRIBE') {
        defaultScribe = true;
      }
    }

    const extraTimeMinutes = body.extraTimeMinutes ?? defaultExtra;
    const separateRoom = body.separateRoom ?? defaultSeparate;
    const readerRequired = body.readerRequired ?? defaultReader;
    const scribeRequired = body.scribeRequired ?? defaultScribe;

    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int, $7, $8, $9)',
          id,
          sessionId,
          body.studentId,
          body.roomId,
          body.seatNumber ?? null,
          extraTimeMinutes,
          separateRoom,
          readerRequired,
          scribeRequired,
        );
      });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('This student already has a seat in this exam session.');
      }
      throw e;
    }

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<SeatingRow[]>(
        'SELECT sx.id::text AS id, sx.session_id::text AS session_id, sx.student_id::text AS student_id, ' +
          'sx.room_id::text AS room_id, sx.seat_number, sx.extra_time_minutes, sx.separate_room, sx.reader_required, sx.scribe_required ' +
          'FROM sch_exam_seatings sx ' +
          'JOIN sch_exam_sessions es ON es.id = sx.session_id ' +
          'WHERE sx.id = $1::uuid AND es.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
      return seatingRowToDto(rows[0]!);
    });
  }

  async assignInvigilator(
    sessionId: string,
    body: AssignInvigilatorDto,
    actor: ResolvedActor,
  ): Promise<ExamInvigilatorResponseDto> {
    this.assertAdmin(actor);
    await this.assertSessionExists(sessionId);
    // REVIEW-P2C17 BLOCKING 4 — validate room + invigilator belong to
    // the current school.
    await this.assertRoomBelongsToSchool(body.roomId);
    await this.assertEmployeeBelongsToSchool(body.invigilatorId);
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_exam_invigilator_assignments (id, session_id, room_id, invigilator_id, is_lead) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
          id,
          sessionId,
          body.roomId,
          body.invigilatorId,
          body.isLead ?? false,
        );
      });
    } catch (e: unknown) {
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          'This invigilator is already assigned to this room for this exam.',
        );
      }
      throw e;
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<InvigilatorRow[]>(
        'SELECT ia.id::text AS id, ia.session_id::text AS session_id, ia.room_id::text AS room_id, ' +
          'ia.invigilator_id::text AS invigilator_id, ia.is_lead ' +
          'FROM sch_exam_invigilator_assignments ia ' +
          'JOIN sch_exam_sessions es ON es.id = ia.session_id ' +
          'WHERE ia.id = $1::uuid AND es.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
      return invigilatorRowToDto(rows[0]!);
    });
  }

  private async assertSessionExists(sessionId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sch_exam_sessions WHERE id = $1::uuid AND school_id = $2::uuid',
        sessionId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Exam session not found');
  }

  /**
   * REVIEW-P2C17 BLOCKING 4 — validate the supplied roomId belongs to
   * the current school. 400 BadRequest on miss. Mirrors the same shape
   * Cycle 6.1 ProfileService.assertTargetInCurrentTenant uses for
   * platform-tier identifiers.
   */
  private async assertRoomBelongsToSchool(roomId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sch_rooms WHERE id = $1::uuid AND school_id = $2::uuid',
        roomId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException('roomId does not match a room in this school.');
    }
  }

  private async assertStudentBelongsToSchool(studentId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid',
        studentId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school.');
    }
  }

  private async assertEmployeeBelongsToSchool(employeeId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<{ id: string }[]>(
        'SELECT id::text AS id FROM hr_employees WHERE id = $1::uuid AND school_id = $2::uuid',
        employeeId,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) {
      throw new BadRequestException('invigilatorId does not match an employee in this school.');
    }
  }
}
