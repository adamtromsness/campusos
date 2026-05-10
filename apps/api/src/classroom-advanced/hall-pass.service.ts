import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateHallPassDto,
  HallPassResponseDto,
  HallPassSettingsResponseDto,
  RecallHallPassDto,
  ReturnHallPassDto,
  UpdateHallPassSettingsDto,
} from './dto/hall-pass.dto';

interface HallPassRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  class_id: string;
  class_name: string | null;
  issued_by: string;
  issued_by_name: string | null;
  destination: string;
  issued_at: Date | string;
  expected_return_at: Date | string;
  returned_at: Date | string | null;
  status: 'ACTIVE' | 'RETURNED' | 'OVERDUE' | 'RECALLED';
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SettingsRow {
  id: string;
  school_id: string;
  max_concurrent_passes_per_class: number;
  max_daily_passes_per_student: number;
  default_duration_minutes: number;
  destinations: string[];
  require_teacher_approval: boolean;
  updated_at: Date | string;
}

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : v.toISOString();
}

function rowToDto(row: HallPassRow): HallPassResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    studentId: row.student_id,
    studentName: row.student_name,
    classId: row.class_id,
    className: row.class_name,
    issuedBy: row.issued_by,
    issuedByName: row.issued_by_name,
    destination: row.destination,
    issuedAt: toIso(row.issued_at) || '',
    expectedReturnAt: toIso(row.expected_return_at) || '',
    returnedAt: toIso(row.returned_at),
    status: row.status,
    notes: row.notes,
    createdAt: toIso(row.created_at) || '',
    updatedAt: toIso(row.updated_at) || '',
  };
}

function settingsToDto(row: SettingsRow): HallPassSettingsResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    maxConcurrentPassesPerClass: row.max_concurrent_passes_per_class,
    maxDailyPassesPerStudent: row.max_daily_passes_per_student,
    defaultDurationMinutes: row.default_duration_minutes,
    destinations: row.destinations,
    requireTeacherApproval: row.require_teacher_approval,
    updatedAt: toIso(row.updated_at) || '',
  };
}

const SELECT_PASS_BASE =
  'SELECT hp.id, hp.school_id, hp.student_id, ' +
  "(ip_s.first_name || ' ' || ip_s.last_name) AS student_name, " +
  'hp.class_id, ' +
  "(co.name || ' (' || c.section_code || ')') AS class_name, " +
  'hp.issued_by, ' +
  "(ip_t.first_name || ' ' || ip_t.last_name) AS issued_by_name, " +
  'hp.destination, hp.issued_at, hp.expected_return_at, hp.returned_at, ' +
  'hp.status, hp.notes, hp.created_at, hp.updated_at ' +
  'FROM cls_hall_passes hp ' +
  'LEFT JOIN sis_students s ON s.id = hp.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person ip_s ON ip_s.id = ps.person_id ' +
  'LEFT JOIN sis_classes c ON c.id = hp.class_id ' +
  'LEFT JOIN sis_courses co ON co.id = c.course_id ' +
  'LEFT JOIN hr_employees he ON he.id = hp.issued_by ' +
  'LEFT JOIN platform.iam_person ip_t ON ip_t.id = he.person_id ';

@Injectable()
export class HallPassService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /** Permission check helper: admin OR teacher who teaches the class. */
  private async assertCanIssueForClass(classId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) {
      const exists = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_classes WHERE id = $1::uuid',
          classId,
        );
      });
      if (exists.length === 0) throw new NotFoundException('Class ' + classId + ' not found');
      return;
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can issue hall passes. The calling user has no hr_employees record.',
      );
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_class_teachers ' +
          'WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
        classId,
        actor.employeeId,
      );
    });
    if (rows.length === 0) {
      throw new ForbiddenException(
        'You are not assigned to class ' + classId + ' and cannot issue hall passes for it.',
      );
    }
  }

  private async loadSettings(schoolId: string): Promise<SettingsRow> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<SettingsRow[]>(
        'SELECT id, school_id, max_concurrent_passes_per_class, max_daily_passes_per_student, ' +
          'default_duration_minutes, destinations, require_teacher_approval, updated_at ' +
          'FROM cls_hall_pass_settings WHERE school_id = $1::uuid',
        schoolId,
      );
      if (rows.length > 0) return rows[0]!;
      // Lazy-initialise default row for this school
      const id = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO cls_hall_pass_settings (id, school_id) VALUES ($1::uuid, $2::uuid)',
        id,
        schoolId,
      );
      const created = await client.$queryRawUnsafe<SettingsRow[]>(
        'SELECT id, school_id, max_concurrent_passes_per_class, max_daily_passes_per_student, ' +
          'default_duration_minutes, destinations, require_teacher_approval, updated_at ' +
          'FROM cls_hall_pass_settings WHERE id = $1::uuid',
        id,
      );
      return created[0]!;
    });
  }

  /** GET /classroom/hall-pass-settings */
  async getSettings(): Promise<HallPassSettingsResponseDto> {
    const tenant = getCurrentTenant();
    const row = await this.loadSettings(tenant.schoolId);
    return settingsToDto(row);
  }

  /** PATCH /classroom/hall-pass-settings */
  async updateSettings(
    input: UpdateHallPassSettingsDto,
    actor: ResolvedActor,
  ): Promise<HallPassSettingsResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only school admins can update hall pass settings.');
    }
    const tenant = getCurrentTenant();
    await this.loadSettings(tenant.schoolId);
    if (input.destinations !== undefined && input.destinations.length === 0) {
      throw new BadRequestException('destinations must contain at least one entry.');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (input.maxConcurrentPassesPerClass !== undefined) {
      sets.push('max_concurrent_passes_per_class = $' + i++ + '::int');
      params.push(input.maxConcurrentPassesPerClass);
    }
    if (input.maxDailyPassesPerStudent !== undefined) {
      sets.push('max_daily_passes_per_student = $' + i++ + '::int');
      params.push(input.maxDailyPassesPerStudent);
    }
    if (input.defaultDurationMinutes !== undefined) {
      sets.push('default_duration_minutes = $' + i++ + '::int');
      params.push(input.defaultDurationMinutes);
    }
    if (input.destinations !== undefined) {
      sets.push('destinations = $' + i++ + '::text[]');
      params.push(input.destinations);
    }
    if (input.requireTeacherApproval !== undefined) {
      sets.push('require_teacher_approval = $' + i++);
      params.push(input.requireTeacherApproval);
    }
    if (sets.length === 0) {
      return this.getSettings();
    }
    sets.push('updated_at = now()');
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE cls_hall_pass_settings SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          i +
          '::uuid',
        ...params,
      );
    });
    return this.getSettings();
  }

  /**
   * POST /classroom/hall-passes — issue a hall pass.
   *
   * Permission gate: ATT-005:write (Teacher / Admin tier). Cross-row
   * authorisation: caller must teach the class (admin bypasses).
   *
   * Limit gates fire INSIDE a tenant transaction with a per-class row
   * lock against the settings row so two simultaneous issues cannot
   * both pass the concurrent / daily-cap check. The schema does not
   * enforce a lock here, so the service uses
   * pg_advisory_xact_lock(hashtext('cls_hall_passes:' || class_id))
   * to serialise issue per class — matches the Cycle 6 pattern from
   * RoomBookingService (REVIEW-CYCLE5 BLOCKING 1).
   */
  async issue(input: CreateHallPassDto, actor: ResolvedActor): Promise<HallPassResponseDto> {
    await this.assertCanIssueForClass(input.classId, actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Only employees can issue hall passes. The calling user has no hr_employees record.',
      );
    }
    const tenant = getCurrentTenant();
    const settings = await this.loadSettings(tenant.schoolId);

    if (!settings.destinations.includes(input.destination)) {
      throw new BadRequestException(
        'destination must be one of: ' + settings.destinations.join(', '),
      );
    }
    const duration = input.durationMinutes ?? settings.default_duration_minutes;
    if (duration <= 0) {
      throw new BadRequestException('durationMinutes must be greater than 0.');
    }

    const passId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Per-class advisory lock — serialises concurrent issues for this class.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext('cls_hall_passes:' || $1::text))",
        input.classId,
      );

      // Validate student is enrolled in the class
      const enrollRows = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
        "SELECT 1 AS ok FROM sis_enrollments WHERE class_id = $1::uuid AND student_id = $2::uuid AND status = 'ACTIVE'",
        input.classId,
        input.studentId,
      );
      if (enrollRows.length === 0) {
        throw new BadRequestException(
          'Student ' + input.studentId + ' is not actively enrolled in class ' + input.classId,
        );
      }

      // Concurrent-per-class limit (school-wide ACTIVE for this class)
      const concurrentRows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        "SELECT count(*)::int AS count FROM cls_hall_passes WHERE class_id = $1::uuid AND status = 'ACTIVE'",
        input.classId,
      );
      if (concurrentRows[0]!.count >= settings.max_concurrent_passes_per_class) {
        throw new BadRequestException(
          'Class is at the concurrent hall pass limit (' +
            settings.max_concurrent_passes_per_class +
            '). Wait for an active pass to return before issuing another.',
        );
      }

      // Daily-per-student limit (today's issued count for this student)
      const dailyRows = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM cls_hall_passes ' +
          'WHERE student_id = $1::uuid AND issued_at >= date_trunc($2, now())',
        input.studentId,
        'day',
      );
      if (dailyRows[0]!.count >= settings.max_daily_passes_per_student) {
        throw new BadRequestException(
          'Student has reached the daily hall pass limit (' +
            settings.max_daily_passes_per_student +
            '). Try again tomorrow.',
        );
      }

      const newId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO cls_hall_passes ' +
          '(id, school_id, student_id, class_id, issued_by, destination, ' +
          'issued_at, expected_return_at, status, notes) VALUES ' +
          '($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, ' +
          "now(), now() + ($7::int || ' minutes')::interval, 'ACTIVE', $8)",
        newId,
        tenant.schoolId,
        input.studentId,
        input.classId,
        actor.employeeId,
        input.destination,
        duration,
        input.notes ?? null,
      );
      return newId;
    });

    const created = await this.getById(passId);
    // Emit AFTER tx commits so a Kafka outage cannot roll back the issue.
    void this.kafka.emit({
      topic: 'cls.hall_pass.issued',
      key: passId,
      sourceModule: 'classroom',
      payload: {
        hallPassId: passId,
        sourceRefId: passId,
        schoolId: tenant.schoolId,
        studentId: created.studentId,
        studentName: created.studentName,
        classId: created.classId,
        className: created.className,
        issuedById: created.issuedBy,
        issuedByName: created.issuedByName,
        destination: created.destination,
        issuedAt: created.issuedAt,
        expectedReturnAt: created.expectedReturnAt,
      },
    });
    return created;
  }

  /** GET /classroom/hall-passes/:id (admin/teacher full DTO; row-scoped for non-admin) */
  async getById(id: string): Promise<HallPassResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<HallPassRow[]>(
        SELECT_PASS_BASE + ' WHERE hp.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Hall pass ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  /** GET /classroom/hall-passes — list with row scope. */
  async list(actor: ResolvedActor, statusFilter?: string): Promise<HallPassResponseDto[]> {
    const params: unknown[] = [];
    const wheres: string[] = [];
    let i = 1;

    if (statusFilter) {
      wheres.push('hp.status = $' + i++);
      params.push(statusFilter);
    }

    if (!actor.isSchoolAdmin) {
      if (actor.personType === 'STAFF' && actor.employeeId) {
        // Teachers see passes for classes they teach
        wheres.push(
          'hp.class_id IN (SELECT class_id FROM sis_class_teachers WHERE teacher_employee_id = $' +
            i++ +
            '::uuid)',
        );
        params.push(actor.employeeId);
      } else if (actor.personType === 'STUDENT') {
        // Students see only own passes — resolve sis_students.id from actor.personId
        wheres.push(
          'hp.student_id = (SELECT s.id FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE ps.person_id = $' +
            i++ +
            '::uuid)',
        );
        params.push(actor.personId);
      } else {
        // Parents / other personas → empty (no policy gate yet)
        return [];
      }
    }

    const sql =
      SELECT_PASS_BASE +
      (wheres.length > 0 ? ' WHERE ' + wheres.join(' AND ') : '') +
      ' ORDER BY hp.issued_at DESC';

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<HallPassRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  /** GET /classroom/hall-passes/active */
  async listActive(actor: ResolvedActor): Promise<HallPassResponseDto[]> {
    return this.list(actor, 'ACTIVE');
  }

  /** PATCH /classroom/hall-passes/:id/return — student returns or teacher marks back. */
  async returnPass(
    id: string,
    input: ReturnHallPassDto,
    actor: ResolvedActor,
  ): Promise<HallPassResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ status: string; class_id: string }>>(
        'SELECT status, class_id::text AS class_id FROM cls_hall_passes WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Hall pass ' + id + ' not found');
      const row = rows[0]!;
      if (row.status !== 'ACTIVE' && row.status !== 'OVERDUE') {
        throw new BadRequestException(
          'Hall pass is in status ' + row.status + ' and cannot be returned.',
        );
      }
      // Authorise: admin OR teacher of class OR student themselves (own pass)
      if (!actor.isSchoolAdmin && actor.personType === 'STAFF' && actor.employeeId) {
        const teaches = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_class_teachers WHERE class_id = $1::uuid AND teacher_employee_id = $2::uuid',
          row.class_id,
          actor.employeeId,
        );
        if (teaches.length === 0) {
          throw new ForbiddenException('You are not assigned to this class.');
        }
      } else if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
        throw new ForbiddenException(
          'Only the issuing teacher or an admin can mark a pass returned.',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE cls_hall_passes SET status = 'RETURNED', returned_at = now(), " +
          'notes = COALESCE($2, notes), updated_at = now() WHERE id = $1::uuid',
        id,
        input.notes ?? null,
      );
    });
    return this.getById(id);
  }

  /** PATCH /classroom/hall-passes/:id/recall — admin or issuing teacher pulls a pass back. */
  async recall(
    id: string,
    input: RecallHallPassDto,
    actor: ResolvedActor,
  ): Promise<HallPassResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ status: string; class_id: string; issued_by: string; notes: string | null }>
      >(
        'SELECT status, class_id::text AS class_id, issued_by::text AS issued_by, notes ' +
          'FROM cls_hall_passes WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (rows.length === 0) throw new NotFoundException('Hall pass ' + id + ' not found');
      const row = rows[0]!;
      if (row.status !== 'ACTIVE' && row.status !== 'OVERDUE') {
        throw new BadRequestException(
          'Hall pass is in status ' + row.status + ' and cannot be recalled.',
        );
      }
      if (
        !actor.isSchoolAdmin &&
        (actor.personType !== 'STAFF' || actor.employeeId !== row.issued_by)
      ) {
        throw new ForbiddenException('Only the issuing teacher or an admin can recall a pass.');
      }
      const combinedNotes = (row.notes ? row.notes + '\n' : '') + 'RECALLED: ' + input.reason;
      await tx.$executeRawUnsafe(
        "UPDATE cls_hall_passes SET status = 'RECALLED', returned_at = now(), " +
          'notes = $2, updated_at = now() WHERE id = $1::uuid',
        id,
        combinedNotes,
      );
    });
    return this.getById(id);
  }

  /**
   * Internal — flip ACTIVE rows past expected_return_at to OVERDUE and emit
   * cls.hall_pass.overdue per row. Called by the HallPassOverdueWorker once
   * per minute. Returns the rows that flipped so the worker can log them.
   */
  async sweepOverdueForCurrentTenant(): Promise<HallPassResponseDto[]> {
    const tenant = getCurrentTenant();
    const flippedIds = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        "UPDATE cls_hall_passes SET status = 'OVERDUE', updated_at = now() " +
          "WHERE school_id = $1::uuid AND status = 'ACTIVE' AND expected_return_at < now() " +
          'RETURNING id::text AS id',
        tenant.schoolId,
      );
      return rows.map((r) => r.id);
    });
    if (flippedIds.length === 0) return [];

    const dtos: HallPassResponseDto[] = [];
    for (const id of flippedIds) {
      const dto = await this.getById(id);
      dtos.push(dto);
      void this.kafka.emit({
        topic: 'cls.hall_pass.overdue',
        key: id,
        sourceModule: 'classroom',
        payload: {
          hallPassId: id,
          sourceRefId: id,
          schoolId: dto.schoolId,
          studentId: dto.studentId,
          studentName: dto.studentName,
          classId: dto.classId,
          className: dto.className,
          issuedById: dto.issuedBy,
          issuedByName: dto.issuedByName,
          destination: dto.destination,
          expectedReturnAt: dto.expectedReturnAt,
          minutesOverdue: Math.max(
            0,
            Math.floor((Date.now() - new Date(dto.expectedReturnAt).getTime()) / 60_000),
          ),
        },
      });
    }
    return dtos;
  }
}
