import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateRoomChangeRequestDto,
  ListRoomChangeRequestsQueryDto,
  ReviewRoomChangeRequestDto,
  RoomChangeRequestResponseDto,
} from './dto/room-change-request.dto';

interface RequestRow {
  id: string;
  school_id: string;
  timetable_slot_id: string;
  class_section_code: string;
  course_name: string;
  period_name: string;
  requested_by: string;
  requester_first_name: string | null;
  requester_last_name: string | null;
  current_room_id: string;
  current_room_name: string;
  requested_room_id: string | null;
  requested_room_name: string | null;
  request_date: string;
  reason: string;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  created_at: string;
}

function rowToDto(row: RequestRow): RoomChangeRequestResponseDto {
  var requestedByName: string | null = null;
  if (row.requester_first_name && row.requester_last_name) {
    requestedByName = row.requester_first_name + ' ' + row.requester_last_name;
  }
  return {
    id: row.id,
    schoolId: row.school_id,
    timetableSlotId: row.timetable_slot_id,
    classSectionCode: row.class_section_code,
    courseName: row.course_name,
    periodName: row.period_name,
    requestedById: row.requested_by,
    requestedByName: requestedByName,
    currentRoomId: row.current_room_id,
    currentRoomName: row.current_room_name,
    requestedRoomId: row.requested_room_id,
    requestedRoomName: row.requested_room_name,
    requestDate: row.request_date,
    reason: row.reason,
    status: row.status as RoomChangeRequestResponseDto['status'],
    reviewedById: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
  };
}

var SELECT_REQUEST_BASE =
  'SELECT rcr.id, rcr.school_id, rcr.timetable_slot_id, ' +
  'c.section_code AS class_section_code, co.name AS course_name, p.name AS period_name, ' +
  'rcr.requested_by, ip.first_name AS requester_first_name, ip.last_name AS requester_last_name, ' +
  'rcr.current_room_id, cr.name AS current_room_name, ' +
  'rcr.requested_room_id, rr.name AS requested_room_name, ' +
  "TO_CHAR(rcr.request_date, 'YYYY-MM-DD') AS request_date, " +
  'rcr.reason, rcr.status, rcr.reviewed_by, rcr.reviewed_at, rcr.review_notes, rcr.created_at ' +
  'FROM sch_room_change_requests rcr ' +
  'JOIN sch_timetable_slots s ON s.id = rcr.timetable_slot_id ' +
  'JOIN sis_classes c ON c.id = s.class_id ' +
  'JOIN sis_courses co ON co.id = c.course_id ' +
  'JOIN sch_periods p ON p.id = s.period_id ' +
  'JOIN sch_rooms cr ON cr.id = rcr.current_room_id ' +
  'LEFT JOIN sch_rooms rr ON rr.id = rcr.requested_room_id ' +
  'LEFT JOIN hr_employees e ON e.id = rcr.requested_by ' +
  'LEFT JOIN platform.iam_person ip ON ip.id = e.person_id ';

@Injectable()
export class RoomChangeRequestService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(
    query: ListRoomChangeRequestsQueryDto,
    actor: ResolvedActor,
  ): Promise<RoomChangeRequestResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        SELECT_REQUEST_BASE +
        'WHERE ($1::text IS NULL OR rcr.status = $1::text) ' +
        'AND ($2::date IS NULL OR rcr.request_date >= $2::date) ' +
        'AND ($3::date IS NULL OR rcr.request_date <= $3::date) ';
      var params: any[] = [query.status ?? null, query.fromDate ?? null, query.toDate ?? null];
      var idx = params.length + 1;
      if (!actor.isSchoolAdmin) {
        if (!actor.employeeId) return [] as RequestRow[];
        sql += 'AND rcr.requested_by = $' + idx + '::uuid ';
        params.push(actor.employeeId);
        idx++;
      }
      sql += 'ORDER BY rcr.request_date DESC, rcr.created_at DESC';
      return client.$queryRawUnsafe<RequestRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<RoomChangeRequestResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE rcr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Room change request ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin && actor.employeeId !== row.requested_by) {
      throw new NotFoundException('Room change request ' + id + ' not found');
    }
    return rowToDto(row);
  }

  /**
   * Teacher submits a request. The current_room_id is read from the
   * existing slot — clients only need to supply timetable_slot_id +
   * (optionally) requestedRoomId + the reason and date.
   */
  async create(
    body: CreateRoomChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RoomChangeRequestResponseDto> {
    if (!actor.employeeId && !actor.isSchoolAdmin) {
      throw new ForbiddenException('Only employees can submit room change requests');
    }
    var slotRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ room_id: string; teacher_id: string | null }>>(
        'SELECT room_id::text AS room_id, teacher_id::text AS teacher_id FROM sch_timetable_slots WHERE id = $1::uuid',
        body.timetableSlotId,
      );
    });
    if (slotRows.length === 0) {
      throw new NotFoundException('Timetable slot ' + body.timetableSlotId + ' not found');
    }
    var slot = slotRows[0]!;

    if (
      !actor.isSchoolAdmin &&
      actor.employeeId !== null &&
      slot.teacher_id !== null &&
      slot.teacher_id !== actor.employeeId
    ) {
      throw new ForbiddenException(
        "Only the slot's assigned teacher or an admin can submit a change request",
      );
    }

    var schoolId = getCurrentTenant().schoolId;
    var requestId = generateId();
    var requestedById: string;
    if (actor.employeeId) {
      requestedById = actor.employeeId;
    } else {
      // Admin without hr_employees row — the column is NOT NULL, so we
      // require a real employee id even for admin submissions.
      throw new ForbiddenException(
        'Submitter must have an hr_employees row — use a regular admin account or impersonate',
      );
    }

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_room_change_requests (id, school_id, timetable_slot_id, requested_by, current_room_id, requested_room_id, request_date, reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::date, $8)',
        requestId,
        schoolId,
        body.timetableSlotId,
        requestedById,
        slot.room_id,
        body.requestedRoomId ?? null,
        body.requestDate,
        body.reason,
      );
    });
    return this.getById(requestId, actor);
  }

  /**
   * Approve a PENDING request. Sets status=APPROVED, reviewed_at, reviewed_by.
   * The optional approvedRoomId overrides the requested_room_id when the
   * teacher submitted with NULL ("any available room").
   *
   * Note: this lands the audit row only. Step 6's CalendarService is what
   * materialises a one-day timetable override against the slot — when that
   * service ships, this method will additionally insert a substitution
   * timetable row for the (slot, request_date) pair. For Cycle 5 Step 5 the
   * approval is tracked but not yet wired into the live timetable.
   */
  async approve(
    id: string,
    body: ReviewRoomChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RoomChangeRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can approve room change requests');
    }
    // REVIEW-CYCLE5 BLOCKING 2: read status under FOR UPDATE inside the
    // same tx that runs the UPDATE so two concurrent admins cannot both
    // pass the PENDING check. The UPDATE WHERE clause also re-asserts
    // status='PENDING' as belt-and-braces.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var lockedRows = await tx.$queryRawUnsafe<
        Array<{ status: string; requested_room_id: string | null }>
      >(
        'SELECT status, requested_room_id::text AS requested_room_id ' +
          'FROM sch_room_change_requests WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (lockedRows.length === 0) {
        throw new NotFoundException('Room change request ' + id + ' not found');
      }
      var locked = lockedRows[0]!;
      if (locked.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + locked.status + '; only PENDING requests can be approved',
        );
      }
      var finalRoomId = body.approvedRoomId ?? locked.requested_room_id;
      if (!finalRoomId) {
        throw new BadRequestException(
          'approvedRoomId is required when the original request did not specify a room',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE sch_room_change_requests SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $1::uuid, review_notes = $2, requested_room_id = $3::uuid, updated_at = now() " +
          "WHERE id = $4::uuid AND status = 'PENDING'",
        actor.accountId,
        body.reviewNotes ?? null,
        finalRoomId,
        id,
      );
    });
    return this.getById(id, actor);
  }

  async reject(
    id: string,
    body: ReviewRoomChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RoomChangeRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can reject room change requests');
    }
    // REVIEW-CYCLE5 BLOCKING 2: same pattern as approve() — locked read +
    // status validation + status-conditional UPDATE all in one tx.
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var lockedRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM sch_room_change_requests WHERE id = $1::uuid FOR UPDATE',
        id,
      );
      if (lockedRows.length === 0) {
        throw new NotFoundException('Room change request ' + id + ' not found');
      }
      var locked = lockedRows[0]!;
      if (locked.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + locked.status + '; only PENDING requests can be rejected',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE sch_room_change_requests SET status = 'REJECTED', reviewed_at = now(), reviewed_by = $1::uuid, review_notes = $2, updated_at = now() " +
          "WHERE id = $3::uuid AND status = 'PENDING'",
        actor.accountId,
        body.reviewNotes ?? null,
        id,
      );
    });
    return this.getById(id, actor);
  }
}
