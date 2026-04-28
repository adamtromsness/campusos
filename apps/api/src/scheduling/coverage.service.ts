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
import {
  AssignCoverageDto,
  CancelCoverageDto,
  CoverageRequestResponseDto,
  ListCoverageQueryDto,
} from './dto/coverage.dto';

interface CoverageRow {
  id: string;
  school_id: string;
  timetable_slot_id: string;
  class_section_code: string;
  course_name: string;
  period_id: string;
  period_name: string;
  room_id: string;
  room_name: string;
  absent_teacher_id: string;
  absent_teacher_first_name: string;
  absent_teacher_last_name: string;
  leave_request_id: string | null;
  coverage_date: string;
  status: string;
  assigned_substitute_id: string | null;
  sub_first_name: string | null;
  sub_last_name: string | null;
  assigned_at: string | null;
  notes: string | null;
  created_at: string;
}

function rowToDto(row: CoverageRow): CoverageRequestResponseDto {
  var subName: string | null = null;
  if (row.sub_first_name && row.sub_last_name) {
    subName = row.sub_first_name + ' ' + row.sub_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    timetableSlotId: row.timetable_slot_id,
    classSectionCode: row.class_section_code,
    courseName: row.course_name,
    periodId: row.period_id,
    periodName: row.period_name,
    roomId: row.room_id,
    roomName: row.room_name,
    absentTeacherId: row.absent_teacher_id,
    absentTeacherName: row.absent_teacher_first_name + ' ' + row.absent_teacher_last_name,
    leaveRequestId: row.leave_request_id,
    coverageDate: row.coverage_date,
    status: row.status as CoverageRequestResponseDto['status'],
    assignedSubstituteId: row.assigned_substitute_id,
    assignedSubstituteName: subName,
    assignedAt: row.assigned_at,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

var SELECT_COVERAGE_BASE =
  'SELECT cr.id, cr.school_id, cr.timetable_slot_id, ' +
  'c.section_code AS class_section_code, co.name AS course_name, ' +
  'cr_period.id AS period_id, cr_period.name AS period_name, ' +
  'r.id AS room_id, r.name AS room_name, ' +
  'cr.absent_teacher_id, abs_ip.first_name AS absent_teacher_first_name, abs_ip.last_name AS absent_teacher_last_name, ' +
  'cr.leave_request_id, ' +
  "TO_CHAR(cr.coverage_date, 'YYYY-MM-DD') AS coverage_date, " +
  'cr.status, cr.assigned_substitute_id, sub_ip.first_name AS sub_first_name, sub_ip.last_name AS sub_last_name, ' +
  'cr.assigned_at, cr.notes, cr.created_at ' +
  'FROM sch_coverage_requests cr ' +
  'JOIN sch_timetable_slots ts ON ts.id = cr.timetable_slot_id ' +
  'JOIN sis_classes c ON c.id = ts.class_id ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'JOIN sch_periods cr_period ON cr_period.id = ts.period_id ' +
  'JOIN sch_rooms r ON r.id = ts.room_id ' +
  'JOIN hr_employees abs_e ON abs_e.id = cr.absent_teacher_id ' +
  'JOIN platform.iam_person abs_ip ON abs_ip.id = abs_e.person_id ' +
  'LEFT JOIN hr_employees sub_e ON sub_e.id = cr.assigned_substitute_id ' +
  'LEFT JOIN platform.iam_person sub_ip ON sub_ip.id = sub_e.person_id ';

@Injectable()
export class CoverageService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Daily coverage board. Reads default to today + status=OPEN/ASSIGNED so
   * the admin queue is the load-bearing default. Filters narrow further.
   * Non-admin staff see only the rows where they are the absent or assigned
   * employee — admins see everything in the school.
   */
  async list(
    query: ListCoverageQueryDto,
    actor: ResolvedActor,
  ): Promise<CoverageRequestResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        SELECT_COVERAGE_BASE +
        'WHERE ($1::date IS NULL OR cr.coverage_date >= $1::date) ' +
        'AND ($2::date IS NULL OR cr.coverage_date <= $2::date) ' +
        'AND ($3::text IS NULL OR cr.status = $3::text) ';
      var params: any[] = [query.fromDate ?? null, query.toDate ?? null, query.status ?? null];
      var idx = params.length + 1;
      if (!actor.isSchoolAdmin) {
        if (!actor.employeeId) return [] as CoverageRow[];
        sql +=
          'AND (cr.absent_teacher_id = $' +
          idx +
          '::uuid OR cr.assigned_substitute_id = $' +
          idx +
          '::uuid) ';
        params.push(actor.employeeId);
        idx++;
      }
      sql += 'ORDER BY cr.coverage_date, cr_period.start_time';
      return client.$queryRawUnsafe<CoverageRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<CoverageRequestResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CoverageRow[]>(
        SELECT_COVERAGE_BASE + 'WHERE cr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Coverage request ' + id + ' not found');
    var row = rows[0]!;
    if (
      !actor.isSchoolAdmin &&
      actor.employeeId !== row.absent_teacher_id &&
      actor.employeeId !== row.assigned_substitute_id
    ) {
      throw new NotFoundException('Coverage request ' + id + ' not found');
    }
    return rowToDto(row);
  }

  /**
   * Assign a substitute to an OPEN coverage request. Admin-only. Inside one
   * transaction:
   *   1) lock the coverage row (FOR UPDATE) so racing admins serialise,
   *   2) flip status -> ASSIGNED + populate assigned_substitute_id + assigned_at,
   *   3) INSERT the matching sch_substitution_timetable row (UNIQUE (slot, date)
   *      catches the rare case where a row was planted by a separate path).
   * Then emits sch.coverage.assigned outside the tx so the substitute gets
   * the IN_APP notification through the Cycle 3 pipeline.
   */
  async assign(
    id: string,
    body: AssignCoverageDto,
    actor: ResolvedActor,
  ): Promise<CoverageRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can assign substitutes');
    }
    var schoolId = getCurrentTenant().schoolId;
    var assignedAt = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT cr.id, cr.status, cr.coverage_date::text AS coverage_date, cr.timetable_slot_id::text AS timetable_slot_id, ' +
          'cr.absent_teacher_id::text AS absent_teacher_id, ts.room_id::text AS slot_room_id ' +
          'FROM sch_coverage_requests cr ' +
          'JOIN sch_timetable_slots ts ON ts.id = cr.timetable_slot_id ' +
          'WHERE cr.id = $1::uuid ' +
          'FOR UPDATE OF cr',
        id,
      )) as Array<{
        id: string;
        status: string;
        coverage_date: string;
        timetable_slot_id: string;
        absent_teacher_id: string;
        slot_room_id: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Coverage request ' + id + ' not found');
      }
      var row = rows[0]!;
      if (row.status !== 'OPEN') {
        throw new BadRequestException(
          'Coverage request is in status ' + row.status + '; only OPEN can be assigned',
        );
      }
      if (body.substituteId === row.absent_teacher_id) {
        throw new BadRequestException('A teacher cannot substitute for their own coverage request');
      }

      var roomId = body.roomId ?? row.slot_room_id;
      var nowIso = new Date().toISOString();
      await tx.$executeRawUnsafe(
        "UPDATE sch_coverage_requests SET status = 'ASSIGNED', assigned_substitute_id = $1::uuid, assigned_at = $2::timestamptz, notes = COALESCE($3, notes), updated_at = now() WHERE id = $4::uuid",
        body.substituteId,
        nowIso,
        body.notes ?? null,
        id,
      );
      // INSERT the substitution timetable row. UNIQUE(original_slot_id,
      // effective_date) catches the rare case where a row was planted by a
      // separate path (e.g. seed) — we surface that as a 409.
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO sch_substitution_timetable (id, school_id, original_slot_id, effective_date, substitute_id, room_id, coverage_request_id, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, $6::uuid, $7::uuid, $8)',
          generateId(),
          schoolId,
          row.timetable_slot_id,
          row.coverage_date,
          body.substituteId,
          roomId,
          id,
          body.notes ?? null,
        );
      } catch (e: any) {
        var msg = e?.message || '';
        if (e?.code === '23505' || /sch_substitution_timetable_slot_date_uq/.test(msg)) {
          throw new BadRequestException(
            'A substitution timetable row already exists for this slot on this date',
          );
        }
        throw e;
      }
      return nowIso;
    });

    var dto = await this.getById(id, actor);
    void this.kafka.emit({
      topic: 'sch.coverage.assigned',
      key: id,
      sourceModule: 'scheduling',
      payload: {
        coverageRequestId: id,
        timetableSlotId: dto.timetableSlotId,
        coverageDate: dto.coverageDate,
        substituteId: dto.assignedSubstituteId,
        substituteName: dto.assignedSubstituteName,
        absentTeacherId: dto.absentTeacherId,
        absentTeacherName: dto.absentTeacherName,
        classSectionCode: dto.classSectionCode,
        courseName: dto.courseName,
        periodName: dto.periodName,
        roomId: dto.roomId,
        roomName: dto.roomName,
        assignedAt: assignedAt,
      },
    });
    return dto;
  }

  /**
   * Cancel a coverage request. The schema's assignment_chk leaves CANCELLED
   * unconstrained — substitute may stay populated for audit when cancelled
   * after assignment. We DO drop any matching substitution_timetable row so
   * the substitute's day-view stops showing the cover.
   */
  async cancel(
    id: string,
    body: CancelCoverageDto,
    actor: ResolvedActor,
  ): Promise<CoverageRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can cancel coverage requests');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM sch_coverage_requests WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('Coverage request ' + id + ' not found');
      }
      if (rows[0]!.status === 'CANCELLED') {
        throw new BadRequestException('Coverage request is already CANCELLED');
      }
      // Drop the substitution row (if any) — ON DELETE CASCADE handles it
      // when we delete the parent, but here we keep the parent and only
      // remove the materialised cover row.
      await tx.$executeRawUnsafe(
        'DELETE FROM sch_substitution_timetable WHERE coverage_request_id = $1::uuid',
        id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE sch_coverage_requests SET status = 'CANCELLED', notes = COALESCE($1, notes), updated_at = now() WHERE id = $2::uuid",
        body.notes ?? null,
        id,
      );
    });
    return this.getById(id, actor);
  }
}
