import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ApproveCandidateDto,
  CandidateDirection,
  CandidateReviewStatus,
  CandidateVehicleType,
  CreateManualCandidateDto,
  GenerationCandidateInline,
  GenerationCandidateResponseDto,
  GenerationCandidateStopResponseDto,
  GenerationDirections,
  GenerationRequestResponseDto,
  GenerationRequestType,
  GenerationStatus,
  QueueGenerationRequestDto,
  RejectCandidateDto,
} from './dto/route-generation.dto';

interface GenerationRequestRow {
  id: string;
  school_id: string;
  requested_by: string;
  request_type: string;
  academic_year_id: string | null;
  term_id: string | null;
  date_from: Date | null;
  date_to: Date | null;
  constraint_id: string;
  constraint_name: string | null;
  directions: string;
  status: string;
  optimiser_run_id: string | null;
  routes_generated: number | null;
  students_covered: number | null;
  students_uncovered: number | null;
  error_message: string | null;
  queued_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface CandidateRow {
  id: string;
  request_id: string;
  candidate_name: string;
  direction: string;
  vehicle_type_required: string;
  total_students: number;
  total_stops: number;
  estimated_route_mileage: string;
  estimated_duration_minutes: number;
  max_student_ride_time_minutes: number;
  all_constraints_satisfied: boolean;
  constraint_violations: Record<string, unknown> | null;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  approved_route_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CandidateStopRow {
  id: string;
  candidate_id: string;
  stop_name: string;
  address: string | null;
  latitude: string;
  longitude: string;
  sequence_order: number;
  scheduled_time: string | null;
  student_ids: string[];
  student_count: number;
}

const SELECT_REQUEST_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, ' +
  'r.requested_by::text AS requested_by, r.request_type, ' +
  'r.academic_year_id::text AS academic_year_id, r.term_id::text AS term_id, ' +
  'r.date_from, r.date_to, r.constraint_id::text AS constraint_id, ' +
  'c.constraint_name AS constraint_name, r.directions, r.status, ' +
  'r.optimiser_run_id, r.routes_generated, r.students_covered, r.students_uncovered, ' +
  'r.error_message, r.queued_at, r.started_at, r.completed_at, ' +
  'r.created_at, r.updated_at ' +
  'FROM trn_generation_requests r LEFT JOIN trn_route_constraints c ON c.id = r.constraint_id ';

const SELECT_CANDIDATE_BASE =
  'SELECT id::text AS id, request_id::text AS request_id, candidate_name, direction, ' +
  'vehicle_type_required, total_students, total_stops, ' +
  'estimated_route_mileage::text AS estimated_route_mileage, ' +
  'estimated_duration_minutes, max_student_ride_time_minutes, ' +
  'all_constraints_satisfied, constraint_violations, review_status, ' +
  'reviewed_by::text AS reviewed_by, reviewed_at, review_notes, ' +
  'approved_route_id::text AS approved_route_id, created_at, updated_at ' +
  'FROM trn_generation_candidates ';

const SELECT_STOP_BASE =
  'SELECT id::text AS id, candidate_id::text AS candidate_id, stop_name, address, ' +
  'latitude::text AS latitude, longitude::text AS longitude, sequence_order, ' +
  "TO_CHAR(scheduled_time, 'HH24:MI:SS') AS scheduled_time, " +
  'student_ids::text[] AS student_ids, student_count ' +
  'FROM trn_generation_candidate_stops ';

function requestRowToDto(r: GenerationRequestRow): GenerationRequestResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    requestedBy: r.requested_by,
    requestType: r.request_type as GenerationRequestType,
    academicYearId: r.academic_year_id,
    termId: r.term_id,
    dateFrom: r.date_from ? r.date_from.toISOString().slice(0, 10) : null,
    dateTo: r.date_to ? r.date_to.toISOString().slice(0, 10) : null,
    constraintId: r.constraint_id,
    constraintName: r.constraint_name,
    directions: r.directions as GenerationDirections,
    status: r.status as GenerationStatus,
    optimiserRunId: r.optimiser_run_id,
    routesGenerated: r.routes_generated,
    studentsCovered: r.students_covered,
    studentsUncovered: r.students_uncovered,
    errorMessage: r.error_message,
    queuedAt: r.queued_at.toISOString(),
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function candidateRowToInline(r: CandidateRow): GenerationCandidateInline {
  return {
    id: r.id,
    candidateName: r.candidate_name,
    direction: r.direction as CandidateDirection,
    vehicleTypeRequired: r.vehicle_type_required as CandidateVehicleType,
    totalStudents: r.total_students,
    totalStops: r.total_stops,
    estimatedRouteMileage: Number(r.estimated_route_mileage),
    estimatedDurationMinutes: r.estimated_duration_minutes,
    maxStudentRideTimeMinutes: r.max_student_ride_time_minutes,
    allConstraintsSatisfied: r.all_constraints_satisfied,
    constraintViolations: r.constraint_violations,
    reviewStatus: r.review_status as CandidateReviewStatus,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    reviewNotes: r.review_notes,
    approvedRouteId: r.approved_route_id,
    createdAt: r.created_at.toISOString(),
  };
}

function candidateRowToDto(r: CandidateRow): GenerationCandidateResponseDto {
  return {
    ...candidateRowToInline(r),
    requestId: r.request_id,
    updatedAt: r.updated_at.toISOString(),
  };
}

function stopRowToDto(r: CandidateStopRow): GenerationCandidateStopResponseDto {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    stopName: r.stop_name,
    address: r.address,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    sequenceOrder: r.sequence_order,
    scheduledTime: r.scheduled_time,
    studentIds: r.student_ids,
    studentCount: r.student_count,
  };
}

/**
 * RouteGenerationService — queues + reviews route generation runs.
 *
 * The plan specifies a Scheduling Solver extracted service. When that
 * service is not deployed the worker accepts manual candidate
 * creation as the fallback path (the candidates are written directly
 * by the TC instead of by the solver). The READY-for-review +
 * APPROVE flow is identical either way.
 *
 * On approval, the candidate is atomically materialised into a live
 * trn_routes row + trn_stops rows + trn_student_assignments rows so
 * the route is immediately usable. Emits trn.generation.completed
 * AFTER tx commits per ADR-057 + the existing transport emit
 * convention.
 */
@Injectable()
export class RouteGenerationService {
  private readonly logger = new Logger(RouteGenerationService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  private assertCanManage(actor: ResolvedActor): void {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STAFF') return;
    throw new ForbiddenException(
      'Only school admins or transportation staff can manage route generation',
    );
  }

  // ── Generation requests ──

  async listRequests(args: { status?: GenerationStatus }): Promise<GenerationRequestResponseDto[]> {
    const tenant = getCurrentTenant();
    const where: string[] = ['r.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args.status) {
      params.push(args.status);
      where.push('r.status = $' + params.length);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQUEST_BASE +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY r.queued_at DESC LIMIT 100',
        ...params,
      );
    })) as GenerationRequestRow[];
    return rows.map(requestRowToDto);
  }

  async getRequestById(requestId: string): Promise<GenerationRequestResponseDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_REQUEST_BASE + 'WHERE r.school_id = $1::uuid AND r.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        requestId,
      );
    })) as GenerationRequestRow[];
    if (rows.length === 0) throw new NotFoundException('Generation request not found');
    const dto = requestRowToDto(rows[0]!);
    const candidates = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CANDIDATE_BASE +
          'WHERE request_id = $1::uuid ORDER BY direction ASC, candidate_name ASC',
        requestId,
      );
    })) as CandidateRow[];
    dto.candidates = candidates.map(candidateRowToInline);
    return dto;
  }

  async queueRequest(
    input: QueueGenerationRequestDto,
    actor: ResolvedActor,
  ): Promise<GenerationRequestResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();

    // Validate scope by request_type — required date / term / year scope
    if (input.requestType === 'TERM' && !input.termId) {
      throw new BadRequestException('termId is required for TERM request type');
    }
    if (input.requestType === 'FULL_YEAR' && !input.academicYearId) {
      throw new BadRequestException('academicYearId is required for FULL_YEAR request type');
    }
    if (input.requestType === 'DATE_RANGE' && (!input.dateFrom || !input.dateTo)) {
      throw new BadRequestException(
        'dateFrom and dateTo are both required for DATE_RANGE request type',
      );
    }
    if (input.requestType === 'SINGLE_DATE' && !input.dateFrom) {
      throw new BadRequestException('dateFrom is required for SINGLE_DATE request type');
    }
    if (input.dateFrom && input.dateTo && input.dateTo < input.dateFrom) {
      throw new BadRequestException('dateTo must be on or after dateFrom');
    }

    // Validate constraint profile exists + is active for this school
    const constraintRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT is_active FROM trn_route_constraints WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.constraintId,
      );
    })) as Array<{ is_active: boolean }>;
    if (constraintRows.length === 0) {
      throw new BadRequestException(
        'constraintId does not match a constraint profile in this school',
      );
    }
    if (!constraintRows[0]!.is_active) {
      throw new BadRequestException('constraintId points at an inactive constraint profile');
    }

    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO trn_generation_requests (id, school_id, requested_by, request_type, academic_year_id, term_id, date_from, date_to, constraint_id, directions) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, $7::date, $8::date, $9::uuid, COALESCE($10, 'BOTH'))",
        id,
        tenant.schoolId,
        actor.accountId,
        input.requestType,
        input.academicYearId ?? null,
        input.termId ?? null,
        input.dateFrom ?? null,
        input.dateTo ?? null,
        input.constraintId,
        input.directions ?? null,
      );
    });
    return this.getRequestById(id);
  }

  async cancelRequest(
    requestId: string,
    actor: ResolvedActor,
  ): Promise<GenerationRequestResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_generation_requests WHERE id = $1::uuid FOR UPDATE',
        requestId,
      )) as Array<{ status: string }>;
      if (locked.length === 0) throw new NotFoundException('Generation request not found');
      if (locked[0]!.status === 'COMPLETED' || locked[0]!.status === 'CANCELLED') {
        throw new BadRequestException(
          'Generation request is in status ' +
            locked[0]!.status +
            '; only QUEUED, RUNNING, or FAILED requests can be cancelled',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_generation_requests SET status = 'CANCELLED', completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id = $1::uuid",
        requestId,
      );
    });
    return this.getRequestById(requestId);
  }

  // ── Manual candidate path (solver-fallback) ──

  /**
   * Manual candidate authoring — used when the Scheduling Solver
   * extracted service is not deployed. The TC creates one or more
   * candidates against an open generation request; on the last
   * candidate the request can be flipped to COMPLETED via
   * markRequestCompleted. The candidate INSERT is a single tenant tx
   * so a partial multi-stop write rolls back cleanly.
   */
  async addManualCandidate(
    requestId: string,
    input: CreateManualCandidateDto,
    actor: ResolvedActor,
  ): Promise<GenerationCandidateResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();
    // Validate stops have unique sequence_order
    const seen = new Set<number>();
    for (const stop of input.stops) {
      if (seen.has(stop.sequenceOrder)) {
        throw new BadRequestException(
          'sequenceOrder ' + stop.sequenceOrder + ' is duplicated across stops',
        );
      }
      seen.add(stop.sequenceOrder);
    }

    const candidateId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock parent request + check it's in a flippable state
      const reqRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM trn_generation_requests WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        requestId,
      )) as Array<{ status: string }>;
      if (reqRows.length === 0) throw new NotFoundException('Generation request not found');
      const reqStatus = reqRows[0]!.status;
      if (reqStatus === 'COMPLETED' || reqStatus === 'CANCELLED' || reqStatus === 'FAILED') {
        throw new BadRequestException(
          'Generation request is in status ' + reqStatus + '; cannot add candidates',
        );
      }

      // Flip request to RUNNING on first candidate
      if (reqStatus === 'QUEUED') {
        await tx.$executeRawUnsafe(
          "UPDATE trn_generation_requests SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid",
          requestId,
        );
      }

      const totalStudents = input.stops.reduce((acc, s) => acc + s.studentIds.length, 0);
      const totalStops = input.stops.length;

      await tx.$executeRawUnsafe(
        'INSERT INTO trn_generation_candidates (id, request_id, candidate_name, direction, vehicle_type_required, total_students, total_stops, estimated_route_mileage, estimated_duration_minutes, max_student_ride_time_minutes, all_constraints_satisfied, constraint_violations) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7::int, $8::numeric, $9::int, $10::int, $11::boolean, $12::jsonb)',
        candidateId,
        requestId,
        input.candidateName,
        input.direction,
        input.vehicleTypeRequired,
        totalStudents,
        totalStops,
        input.estimatedRouteMileage,
        input.estimatedDurationMinutes,
        input.maxStudentRideTimeMinutes,
        input.allConstraintsSatisfied ?? true,
        input.constraintViolations ? JSON.stringify(input.constraintViolations) : null,
      );

      for (const stop of input.stops) {
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_generation_candidate_stops (id, candidate_id, stop_name, address, latitude, longitude, sequence_order, scheduled_time, student_ids, student_count) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::time, $9::uuid[], $10::int)',
          generateId(),
          candidateId,
          stop.stopName,
          stop.address ?? null,
          stop.latitude,
          stop.longitude,
          stop.sequenceOrder,
          stop.scheduledTime ?? null,
          stop.studentIds,
          stop.studentIds.length,
        );
      }
    });
    return this.getCandidateById(candidateId);
  }

  async markRequestCompleted(
    requestId: string,
    actor: ResolvedActor,
  ): Promise<GenerationRequestResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();

    let envelope: {
      requestId: string;
      schoolId: string;
      routesGenerated: number;
      studentsCovered: number;
      studentsUncovered: number;
      requestedBy: string;
      completedAt: string;
    } | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const reqRows = (await tx.$queryRawUnsafe(
        'SELECT status, school_id::text AS school_id, requested_by::text AS requested_by FROM trn_generation_requests WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        requestId,
      )) as Array<{ status: string; school_id: string; requested_by: string }>;
      if (reqRows.length === 0) throw new NotFoundException('Generation request not found');
      const status = reqRows[0]!.status;
      if (status === 'COMPLETED' || status === 'CANCELLED') {
        throw new BadRequestException(
          'Generation request is in status ' + status + '; cannot mark COMPLETED',
        );
      }

      const counts = (await tx.$queryRawUnsafe(
        'SELECT ' +
          'COUNT(*)::int AS routes_generated, ' +
          'COALESCE(SUM(total_students), 0)::int AS students_covered ' +
          'FROM trn_generation_candidates WHERE request_id = $1::uuid',
        requestId,
      )) as Array<{ routes_generated: number; students_covered: number }>;
      const routesGenerated = counts[0]?.routes_generated ?? 0;
      const studentsCovered = counts[0]?.students_covered ?? 0;

      await tx.$executeRawUnsafe(
        "UPDATE trn_generation_requests SET status = 'COMPLETED', completed_at = now(), routes_generated = $1::int, students_covered = $2::int, students_uncovered = COALESCE(students_uncovered, 0), updated_at = now() WHERE id = $3::uuid",
        routesGenerated,
        studentsCovered,
        requestId,
      );

      const final = (await tx.$queryRawUnsafe(
        'SELECT students_uncovered, completed_at FROM trn_generation_requests WHERE id = $1::uuid',
        requestId,
      )) as Array<{ students_uncovered: number | null; completed_at: Date }>;
      envelope = {
        requestId,
        schoolId: tenant.schoolId,
        routesGenerated,
        studentsCovered,
        studentsUncovered: final[0]?.students_uncovered ?? 0,
        requestedBy: reqRows[0]!.requested_by,
        completedAt: final[0]!.completed_at.toISOString(),
      };
    });

    if (envelope) {
      try {
        await this.kafka.emit({
          topic: 'trn.generation.completed',
          key: requestId,
          sourceModule: 'transport',
          payload: envelope,
        });
      } catch (err) {
        this.logger.warn('Failed to emit trn.generation.completed: ' + String(err));
      }
    }

    return this.getRequestById(requestId);
  }

  // ── Candidates ──

  async getCandidateById(candidateId: string): Promise<GenerationCandidateResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CANDIDATE_BASE + 'WHERE id = $1::uuid LIMIT 1',
        candidateId,
      );
    })) as CandidateRow[];
    if (rows.length === 0) throw new NotFoundException('Candidate not found');
    const dto = candidateRowToDto(rows[0]!);
    const stops = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_STOP_BASE + 'WHERE candidate_id = $1::uuid ORDER BY sequence_order ASC',
        candidateId,
      );
    })) as CandidateStopRow[];
    dto.stops = stops.map(stopRowToDto);
    return dto;
  }

  async listCandidatesForRequest(requestId: string): Promise<GenerationCandidateResponseDto[]> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_CANDIDATE_BASE +
          'WHERE request_id = $1::uuid ORDER BY direction ASC, candidate_name ASC',
        requestId,
      );
    })) as CandidateRow[];
    return rows.map(candidateRowToDto);
  }

  /**
   * Approve a candidate. Locks the candidate + parent request + stops
   * inside one tenant tx and materialises a live trn_routes row +
   * trn_stops rows + trn_student_assignments rows. Stamps approved_route_id
   * onto the candidate per the schema's multi-column approved_route_chk.
   */
  async approveCandidate(
    candidateId: string,
    input: ApproveCandidateDto,
    actor: ResolvedActor,
  ): Promise<GenerationCandidateResponseDto> {
    this.assertCanManage(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const candRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, request_id::text AS request_id, candidate_name, direction, ' +
          'review_status, total_students, total_stops FROM trn_generation_candidates ' +
          'WHERE id = $1::uuid FOR UPDATE',
        candidateId,
      )) as Array<{
        id: string;
        request_id: string;
        candidate_name: string;
        direction: string;
        review_status: string;
        total_students: number;
        total_stops: number;
      }>;
      if (candRows.length === 0) throw new NotFoundException('Candidate not found');
      const cand = candRows[0]!;
      if (cand.review_status !== 'PENDING') {
        throw new BadRequestException(
          'Candidate is in review_status ' + cand.review_status + '; only PENDING can be approved',
        );
      }

      // Verify parent request is in current tenant
      const reqRows = (await tx.$queryRawUnsafe(
        'SELECT school_id::text AS school_id, status, academic_year_id::text AS academic_year_id FROM trn_generation_requests WHERE id = $1::uuid',
        cand.request_id,
      )) as Array<{ school_id: string; status: string; academic_year_id: string | null }>;
      if (reqRows.length === 0 || reqRows[0]!.school_id !== tenant.schoolId) {
        throw new NotFoundException('Candidate not found');
      }

      // Verify vehicle + driver belong to this tenant if supplied
      if (input.vehicleId) {
        const v = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM trn_vehicles WHERE id = $1::uuid LIMIT 1',
          input.vehicleId,
        )) as Array<{ ok: number }>;
        if (v.length === 0) {
          throw new BadRequestException('vehicleId does not match a vehicle in this school');
        }
      }
      if (input.driverId) {
        const d = (await tx.$queryRawUnsafe(
          'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
          input.driverId,
        )) as Array<{ ok: number }>;
        if (d.length === 0) {
          throw new BadRequestException('driverId does not match an employee in this school');
        }
      }

      const academicYearId = input.academicYearId ?? reqRows[0]!.academic_year_id ?? null;

      // INSERT trn_routes
      const routeId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO trn_routes (id, school_id, name, description, direction, vehicle_id, driver_id, status, academic_year_id, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::uuid, 'ACTIVE', $8::uuid, $9::uuid)",
        routeId,
        tenant.schoolId,
        input.routeName,
        'Generated from candidate ' + cand.candidate_name,
        cand.direction,
        input.vehicleId ?? null,
        input.driverId ?? null,
        academicYearId,
        actor.accountId,
      );

      // Walk the candidate stops, create trn_stops + trn_student_assignments
      const stopRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, stop_name, address, latitude::text AS latitude, longitude::text AS longitude, sequence_order, scheduled_time, student_ids::text[] AS student_ids ' +
          'FROM trn_generation_candidate_stops WHERE candidate_id = $1::uuid ORDER BY sequence_order ASC',
        candidateId,
      )) as Array<{
        id: string;
        stop_name: string;
        address: string | null;
        latitude: string;
        longitude: string;
        sequence_order: number;
        scheduled_time: Date | null;
        student_ids: string[];
      }>;

      for (const stop of stopRows) {
        const newStopId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO trn_stops (id, route_id, name, address, latitude, longitude, sequence_order, scheduled_time) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::time)',
          newStopId,
          routeId,
          stop.stop_name,
          stop.address,
          stop.latitude,
          stop.longitude,
          stop.sequence_order,
          stop.scheduled_time,
        );
        for (const studentId of stop.student_ids) {
          // Honour the partial UNIQUE on (student, academic_year) WHERE is_override=false
          // by skipping the insert if a permanent assignment already exists for this year.
          await tx.$executeRawUnsafe(
            'INSERT INTO trn_student_assignments (id, student_id, route_id, stop_id, academic_year_id, direction, effective_from, is_override, created_by) ' +
              'SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, CURRENT_DATE, false, $7::uuid ' +
              'WHERE NOT EXISTS (SELECT 1 FROM trn_student_assignments WHERE student_id = $2::uuid AND academic_year_id = $5::uuid AND is_override = false)',
            generateId(),
            studentId,
            routeId,
            newStopId,
            academicYearId,
            cand.direction,
            actor.accountId,
          );
        }
      }

      // Flip candidate to APPROVED + stamp approved_route_id
      await tx.$executeRawUnsafe(
        "UPDATE trn_generation_candidates SET review_status = 'APPROVED', reviewed_by = $1::uuid, reviewed_at = now(), review_notes = $2, approved_route_id = $3::uuid, updated_at = now() WHERE id = $4::uuid",
        actor.accountId,
        input.reviewNotes ?? null,
        routeId,
        candidateId,
      );
    });
    return this.getCandidateById(candidateId);
  }

  async rejectCandidate(
    candidateId: string,
    input: RejectCandidateDto,
    actor: ResolvedActor,
  ): Promise<GenerationCandidateResponseDto> {
    this.assertCanManage(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT review_status FROM trn_generation_candidates WHERE id = $1::uuid FOR UPDATE',
        candidateId,
      )) as Array<{ review_status: string }>;
      if (rows.length === 0) throw new NotFoundException('Candidate not found');
      if (rows[0]!.review_status !== 'PENDING') {
        throw new BadRequestException(
          'Candidate is in review_status ' +
            rows[0]!.review_status +
            '; only PENDING candidates can be rejected',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE trn_generation_candidates SET review_status = 'REJECTED', reviewed_by = $1::uuid, reviewed_at = now(), review_notes = $2, updated_at = now() WHERE id = $3::uuid",
        actor.accountId,
        input.reviewNotes,
        candidateId,
      );
    });
    return this.getCandidateById(candidateId);
  }
}
