import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { RouteService } from './route.service';
import { RouteChangeLogService } from './route-change-log.service';
import {
  AssignmentDirection,
  CreateStudentAssignmentDto,
  StudentAssignmentResponseDto,
} from './dto/transport.dto';

interface AssignmentRow {
  id: string;
  student_id: string;
  student_name: string | null;
  route_id: string;
  stop_id: string;
  stop_name: string | null;
  stop_sequence: number | null;
  direction: string;
  effective_from: Date;
  effective_to: Date | null;
  is_override: boolean;
  parent_request_id: string | null;
  created_at: Date;
}

const SELECT_ASSIGNMENT_BASE =
  'SELECT a.id::text AS id, a.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id) AS student_name, ' +
  'a.route_id::text AS route_id, a.stop_id::text AS stop_id, ' +
  '(SELECT name FROM trn_stops WHERE id = a.stop_id) AS stop_name, ' +
  '(SELECT sequence_order FROM trn_stops WHERE id = a.stop_id) AS stop_sequence, ' +
  'a.direction, a.effective_from, a.effective_to, a.is_override, ' +
  'a.parent_request_id::text AS parent_request_id, a.created_at ' +
  'FROM trn_student_assignments a ';

function rowToDto(r: AssignmentRow): StudentAssignmentResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    routeId: r.route_id,
    stopId: r.stop_id,
    stopName: r.stop_name,
    stopSequence: r.stop_sequence,
    direction: r.direction as AssignmentDirection,
    effectiveFrom: r.effective_from.toISOString().slice(0, 10),
    effectiveTo: r.effective_to ? r.effective_to.toISOString().slice(0, 10) : null,
    isOverride: r.is_override,
    parentRequestId: r.parent_request_id,
    createdAt: r.created_at.toISOString(),
  };
}

@Injectable()
export class AssignmentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly routes: RouteService,
    private readonly changeLog: RouteChangeLogService,
  ) {}

  async listForRoute(
    routeId: string,
    actor: ResolvedActor,
  ): Promise<StudentAssignmentResponseDto[]> {
    await this.routes.assertCanReadRoute(routeId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE +
          'WHERE a.route_id = $1::uuid ORDER BY (SELECT sequence_order FROM trn_stops WHERE id = a.stop_id), a.direction',
        routeId,
      );
    })) as AssignmentRow[];
    return rows.map(rowToDto);
  }

  /**
   * Parent: own children's assignments. Student: own assignment.
   * Staff/admin: all (or scoped via routeId argument by callers).
   */
  async listForStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<StudentAssignmentResponseDto[]> {
    await this.assertCanReadStudent(studentId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE +
          'WHERE a.student_id = $1::uuid ORDER BY a.is_override, a.effective_from DESC',
        studentId,
      );
    })) as AssignmentRow[];
    return rows.map(rowToDto);
  }

  async myRoute(actor: ResolvedActor): Promise<StudentAssignmentResponseDto[]> {
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_ASSIGNMENT_BASE +
            'WHERE a.student_id IN (' +
            '  SELECT s.id FROM sis_students s ' +
            '  JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            '  WHERE ps.person_id = $1::uuid' +
            ') AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE) ' +
            'ORDER BY a.is_override DESC, a.direction',
          actor.personId,
        );
      })) as AssignmentRow[];
      return rows.map(rowToDto);
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          SELECT_ASSIGNMENT_BASE +
            'WHERE a.student_id IN (' +
            '  SELECT sg.student_id FROM sis_student_guardians sg ' +
            '  JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            '  WHERE g.person_id = $1::uuid' +
            ') AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE) ' +
            'ORDER BY a.student_id, a.direction',
          actor.personId,
        );
      })) as AssignmentRow[];
      return rows.map(rowToDto);
    }
    throw new ForbiddenException('Only students and parents can read /transport/my-route');
  }

  async create(
    routeId: string,
    input: CreateStudentAssignmentDto,
    actor: ResolvedActor,
  ): Promise<StudentAssignmentResponseDto> {
    this.routes.assertManagerScope(actor);
    await this.routes.assertCanReadRoute(routeId, actor);

    // Verify the stop belongs to this route
    const stopCheck = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM trn_stops WHERE id = $1::uuid AND route_id = $2::uuid LIMIT 1',
        input.stopId,
        routeId,
      );
    })) as Array<{ ok: number }>;
    if (stopCheck.length === 0) {
      throw new BadRequestException('stopId does not belong to this route');
    }

    // Verify the student exists in the tenant
    const studentCheck = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      );
    })) as Array<{ ok: number }>;
    if (studentCheck.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }

    // REVIEW-CYCLE19 BLOCKING 4 — every permanent assignment must
    // carry an academicYearId so the partial UNIQUE(student_id,
    // academic_year_id) WHERE is_override=false index is meaningful.
    // Override rows can omit it because they're date-bounded by
    // their parent change request.
    const isOverride = input.isOverride ?? false;
    if (!isOverride && !input.academicYearId) {
      throw new BadRequestException('academicYearId is required for permanent assignments');
    }
    if (input.academicYearId) {
      const yearCheck = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_academic_years WHERE id = $1::uuid LIMIT 1',
          input.academicYearId,
        );
      })) as Array<{ ok: number }>;
      if (yearCheck.length === 0) {
        throw new BadRequestException(
          'academicYearId does not match an academic year in this school',
        );
      }
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_student_assignments (id, student_id, route_id, stop_id, academic_year_id, direction, effective_from, effective_to, is_override, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::date, $9, $10, $11::uuid)',
          id,
          input.studentId,
          routeId,
          input.stopId,
          input.academicYearId ?? null,
          input.direction,
          input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
          input.effectiveTo ?? null,
          isOverride,
          input.notes ?? null,
          actor.accountId,
        );
      } catch (err: unknown) {
        const e = err as { code?: string; meta?: { code?: string }; message?: string };
        if (
          e.code === '23505' ||
          e.meta?.code === '23505' ||
          (typeof e.message === 'string' && e.message.includes('23505'))
        ) {
          throw new BadRequestException(
            'Student already has a permanent assignment for this academic year',
          );
        }
        throw err;
      }
      await this.changeLog.recordChange(tx, {
        routeId,
        changedBy: actor.accountId,
        changeType: 'STUDENT_ADDED',
        stopId: input.stopId,
        studentId: input.studentId,
        newValue: {
          studentId: input.studentId,
          stopId: input.stopId,
          direction: input.direction,
          isOverride: input.isOverride ?? false,
        },
      });
    });

    const fetched = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ASSIGNMENT_BASE + 'WHERE a.id = $1::uuid LIMIT 1', id);
    })) as AssignmentRow[];
    return rowToDto(fetched[0]!);
  }

  async remove(assignmentId: string, actor: ResolvedActor): Promise<void> {
    this.routes.assertManagerScope(actor);
    const before = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ASSIGNMENT_BASE + 'WHERE a.id = $1::uuid LIMIT 1',
        assignmentId,
      );
    })) as AssignmentRow[];
    if (before.length === 0) throw new NotFoundException('Assignment not found');
    const dto = rowToDto(before[0]!);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'DELETE FROM trn_student_assignments WHERE id = $1::uuid',
        assignmentId,
      );
      await this.changeLog.recordChange(tx, {
        routeId: dto.routeId,
        changedBy: actor.accountId,
        changeType: 'STUDENT_REMOVED',
        stopId: dto.stopId,
        studentId: dto.studentId,
        oldValue: {
          studentId: dto.studentId,
          stopId: dto.stopId,
          direction: dto.direction,
        },
      });
    });
  }

  /**
   * Used by RouteChangeRequestService.approve to land the override
   * assignment + change log entry inside the same tx the parent
   * request flips to APPROVED.
   */
  async createOverrideInTx(
    tx: Parameters<TenantPrismaService['executeInTenantTransaction']>[0] extends (
      tx: infer T,
    ) => Promise<unknown>
      ? T
      : never,
    args: {
      routeId: string;
      studentId: string;
      stopId: string;
      direction: AssignmentDirection;
      effectiveDate: string;
      parentRequestId: string;
      createdBy: string;
    },
  ): Promise<string> {
    const id = generateId();
    await (
      tx as { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> }
    ).$executeRawUnsafe(
      'INSERT INTO trn_student_assignments (id, student_id, route_id, stop_id, direction, effective_from, effective_to, is_override, parent_request_id, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $6::date, true, $7::uuid, $8::uuid)',
      id,
      args.studentId,
      args.routeId,
      args.stopId,
      args.direction,
      args.effectiveDate,
      args.parentRequestId,
      args.createdBy,
    );
    await this.changeLog.recordChange(tx as never, {
      routeId: args.routeId,
      changedBy: args.createdBy,
      changeType: 'STUDENT_ADDED',
      stopId: args.stopId,
      studentId: args.studentId,
      newValue: {
        studentId: args.studentId,
        stopId: args.stopId,
        direction: args.direction,
        isOverride: true,
        effectiveDate: args.effectiveDate,
      },
      reason: 'Parent route-change request approved',
    });
    return id;
  }

  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') return;
    if (actor.personType === 'STUDENT') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'WHERE s.id = $1::uuid AND ps.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new NotFoundException('Student not found');
      }
      return;
    }
    if (actor.personType === 'GUARDIAN') {
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        );
      })) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new NotFoundException('Student not found');
      }
      return;
    }
    throw new NotFoundException('Student not found');
  }
}
