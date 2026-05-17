import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { AssignmentService } from './assignment.service';
import {
  ApproveChangeRequestDto,
  AssignmentDirection,
  ChangeRequestStatus,
  ChangeRequestType,
  CreateRouteChangeRequestDto,
  RejectChangeRequestDto,
  RouteChangeRequestResponseDto,
} from './dto/transport.dto';

interface ChangeRequestRow {
  id: string;
  student_id: string;
  student_name: string | null;
  submitted_by: string;
  submitted_by_name: string | null;
  change_date: Date;
  change_type: string;
  requested_route_id: string | null;
  requested_stop_id: string | null;
  reason: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  override_assignment_id: string | null;
  created_at: Date;
}

const SELECT_REQUEST_BASE =
  'SELECT r.id::text AS id, r.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = r.student_id) AS student_name, ' +
  'r.submitted_by::text AS submitted_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.id = r.submitted_by) AS submitted_by_name, ' +
  'r.change_date, r.change_type, ' +
  'r.requested_route_id::text AS requested_route_id, r.requested_stop_id::text AS requested_stop_id, ' +
  'r.reason, r.status, r.reviewed_by::text AS reviewed_by, r.reviewed_at, r.review_notes, ' +
  'r.override_assignment_id::text AS override_assignment_id, r.created_at ' +
  'FROM trn_route_change_requests r ';

function rowToDto(r: ChangeRequestRow): RouteChangeRequestResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    submittedBy: r.submitted_by,
    submittedByName: r.submitted_by_name,
    changeDate: r.change_date.toISOString().slice(0, 10),
    changeType: r.change_type as ChangeRequestType,
    requestedRouteId: r.requested_route_id,
    requestedStopId: r.requested_stop_id,
    reason: r.reason,
    status: r.status as ChangeRequestStatus,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    reviewNotes: r.review_notes,
    overrideAssignmentId: r.override_assignment_id,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class RouteChangeRequestService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly assignments: AssignmentService,
  ) {}

  /**
   * List visible change requests.
   *
   * - Admin / Staff (TC) sees every PENDING request school-wide and
   *   own queue history.
   * - Parent sees own submissions only (row-scoped on submitted_by).
   * - Student is not granted TRN-005 by default.
   */
  async list(
    actor: ResolvedActor,
    args: { status?: ChangeRequestStatus },
  ): Promise<RouteChangeRequestResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['r.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];

    if (args.status) {
      where.push('r.status = $' + (params.length + 1));
      params.push(args.status);
    }

    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      where.push('r.submitted_by = $' + (params.length + 1) + '::uuid');
      params.push(actor.accountId);
    }

    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQUEST_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.change_date DESC, r.created_at DESC LIMIT 200',
        ...params,
      );
    })) as ChangeRequestRow[];
    return rows.map(rowToDto);
  }

  async getById(requestId: string, actor: ResolvedActor): Promise<RouteChangeRequestResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid LIMIT 1',
        requestId,
      );
    })) as ChangeRequestRow[];
    if (rows.length === 0) throw new NotFoundException('Route change request not found');
    const dto = rowToDto(rows[0]!);
    if (
      !actor.isSchoolAdmin &&
      actor.personType !== 'STAFF' &&
      dto.submittedBy !== actor.accountId
    ) {
      throw new NotFoundException('Route change request not found');
    }
    return dto;
  }

  async submit(
    input: CreateRouteChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RouteChangeRequestResponseDto> {
    if (actor.personType !== 'GUARDIAN' && !actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only parents (or staff on their behalf) can submit route-change requests',
      );
    }

    // Parent: row-scope to own children
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          input.studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new ForbiddenException(
          'You can only submit route-change requests for your own children',
        );
      }
    }

    if (input.changeType === 'DIFFERENT_STOP' && !input.requestedStopId) {
      throw new BadRequestException('requestedStopId is required for DIFFERENT_STOP change type');
    }
    if (input.changeType === 'DIFFERENT_ROUTE' && !input.requestedRouteId) {
      throw new BadRequestException('requestedRouteId is required for DIFFERENT_ROUTE change type');
    }

    // REVIEW-CYCLE19 MAJOR 7 — validate every soft-ref input
    // regardless of actor (parents are already row-scoped to own
    // children above, but staff/admin submitting on behalf bypassed
    // soft-ref existence checks). Validates studentId in tenant +
    // requestedRouteId active + requestedStopId belongs to that
    // route (or to the student's current permanent route when
    // changeType=DIFFERENT_STOP and requestedRouteId is omitted).
    const studentExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      );
    })) as Array<{ ok: number }>;
    if (studentExists.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
    if (input.requestedRouteId) {
      const routeExists = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT status FROM trn_routes WHERE id = $1::uuid LIMIT 1',
          input.requestedRouteId,
        );
      })) as Array<{ status: string }>;
      if (routeExists.length === 0) {
        throw new BadRequestException('requestedRouteId does not match a route in this school');
      }
      if (routeExists[0]!.status !== 'ACTIVE') {
        throw new BadRequestException(
          'requestedRouteId points at a non-ACTIVE route (' + routeExists[0]!.status + ')',
        );
      }
    }
    if (input.requestedStopId) {
      const stopRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT route_id::text AS route_id FROM trn_stops WHERE id = $1::uuid LIMIT 1',
          input.requestedStopId,
        );
      })) as Array<{ route_id: string }>;
      if (stopRows.length === 0) {
        throw new BadRequestException('requestedStopId does not match a stop in this school');
      }
      // If requestedRouteId is set, verify the stop belongs to it
      if (input.requestedRouteId && stopRows[0]!.route_id !== input.requestedRouteId) {
        throw new BadRequestException(
          'requestedStopId does not belong to the supplied requestedRouteId',
        );
      }
    }

    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_route_change_requests (id, school_id, student_id, submitted_by, change_date, change_type, requested_route_id, requested_stop_id, reason) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, $7::uuid, $8::uuid, $9)',
        id,
        tenant.schoolId,
        input.studentId,
        actor.accountId,
        input.changeDate,
        input.changeType,
        input.requestedRouteId ?? null,
        input.requestedStopId ?? null,
        input.reason ?? null,
      );
    });

    return this.getById(id, actor);
  }

  async approve(
    requestId: string,
    input: ApproveChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RouteChangeRequestResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only school admins or transportation staff can approve route-change requests',
      );
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, student_id::text AS student_id, change_date, change_type, ' +
          'requested_route_id::text AS requested_route_id, requested_stop_id::text AS requested_stop_id, ' +
          'status FROM trn_route_change_requests WHERE id = $1::uuid FOR UPDATE',
        requestId,
      )) as Array<{
        id: string;
        student_id: string;
        change_date: Date;
        change_type: string;
        requested_route_id: string | null;
        requested_stop_id: string | null;
        status: string;
      }>;
      if (locked.length === 0) throw new NotFoundException('Route change request not found');
      const row = locked[0]!;
      if (row.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + row.status + '; only PENDING requests can be approved',
        );
      }

      let overrideId: string | null = null;
      if (row.change_type === 'DIFFERENT_STOP' || row.change_type === 'DIFFERENT_ROUTE') {
        // Resolve route + stop for the override
        let targetRouteId: string | null = row.requested_route_id;
        const targetStopId = row.requested_stop_id;

        if (row.change_type === 'DIFFERENT_STOP' && targetStopId) {
          // Use the existing route for the student's permanent assignment
          const routeRows = (await tx.$queryRawUnsafe(
            'SELECT route_id::text AS id FROM trn_stops WHERE id = $1::uuid LIMIT 1',
            targetStopId,
          )) as Array<{ id: string }>;
          if (routeRows.length === 0) {
            throw new BadRequestException('requestedStopId no longer exists');
          }
          targetRouteId = routeRows[0]!.id;
        }

        if (!targetRouteId || !targetStopId) {
          throw new BadRequestException(
            'Approval requires both a target route and stop for the override assignment',
          );
        }

        // Resolve direction from existing permanent assignment, default to AM
        const dirRows = (await tx.$queryRawUnsafe(
          'SELECT direction FROM trn_student_assignments WHERE student_id = $1::uuid AND is_override = false ORDER BY effective_from DESC LIMIT 1',
          row.student_id,
        )) as Array<{ direction: string }>;
        const direction: AssignmentDirection =
          (dirRows[0]?.direction as AssignmentDirection) ?? 'AM';

        overrideId = await this.assignments.createOverrideInTx(tx as never, {
          routeId: targetRouteId,
          studentId: row.student_id,
          stopId: targetStopId,
          direction,
          effectiveDate: row.change_date.toISOString().slice(0, 10),
          parentRequestId: requestId,
          createdBy: actor.accountId,
        });
      }
      // For NO_BUS we just record the approval — no override row is needed
      // because the parent is opting their child out of the bus for the
      // day; the no-show worker will skip the missing scan because the
      // student has no override and no permanent assignment for that
      // direction.

      await tx.$executeRawUnsafe(
        "UPDATE trn_route_change_requests SET status = 'APPROVED', reviewed_by = $1::uuid, reviewed_at = now(), review_notes = $2, override_assignment_id = $3::uuid, updated_at = now() WHERE id = $4::uuid",
        actor.accountId,
        input.reviewNotes ?? null,
        overrideId,
        requestId,
      );
    });

    return this.getById(requestId, actor);
  }

  async reject(
    requestId: string,
    input: RejectChangeRequestDto,
    actor: ResolvedActor,
  ): Promise<RouteChangeRequestResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException(
        'Only school admins or transportation staff can reject route-change requests',
      );
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_route_change_requests WHERE id = $1::uuid FOR UPDATE',
        requestId,
      )) as Array<{ status: string }>;
      if (locked.length === 0) throw new NotFoundException('Route change request not found');
      if (locked[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + locked[0]!.status + '; only PENDING requests can be rejected',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_route_change_requests SET status = 'REJECTED', reviewed_by = $1::uuid, reviewed_at = now(), review_notes = $2, updated_at = now() WHERE id = $3::uuid",
        actor.accountId,
        input.reviewNotes,
        requestId,
      );
    });
    return this.getById(requestId, actor);
  }
}
