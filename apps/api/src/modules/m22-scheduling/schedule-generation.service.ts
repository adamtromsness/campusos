import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { OutboxService } from '@shared/kafka/outbox.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  deterministicGenerationCompletedEventId,
  deterministicTimetableUpdatedEventId,
} from './event-ids';
import {
  ActivateCandidateResponseDto,
  ActivationLogResponseDto,
  CandidateSlotResponseDto,
  CreateSchedulingConstraintsDto,
  CreateSchedulingRequestDto,
  ResolveClashDto,
  ReviewCandidateDto,
  SchedulingCandidateResponseDto,
  SchedulingConstraintsResponseDto,
  SchedulingRequestResponseDto,
} from './dto/scheduling-advanced.dto';

/*
 * ScheduleGenerationService — P2-17a Step 2.
 *
 * Owns sch_scheduling_constraints + sch_scheduling_requests +
 * sch_scheduling_candidates + sch_scheduling_candidate_slots +
 * sch_scheduling_activation_log. The "external" Scheduling Solver
 * service is stubbed locally in dev (selectSolverAlgorithm picks
 * CP_SAT ≤300, HEURISTIC >300 per ADR-060). When a real solver lands
 * the request lifecycle (QUEUED → RUNNING → COMPLETED) plus the
 * candidate population can move out of process — the consumer
 * contract is the same.
 *
 * Activation lifecycle:
 *   1. Solver returns candidates → review_status = PENDING (DRAFT).
 *   2. Admin reviews → review_status = APPROVED / REJECTED / MODIFIED.
 *      "REVIEWED" in the plan maps to either APPROVED or REJECTED at
 *      the service layer (we record the reviewed_at timestamp).
 *   3. Admin activates an APPROVED candidate → SchedulingActivationWorker
 *      promotes each non-clashing candidate_slot into a fresh
 *      sch_timetable_slots row + writes the activation log + emits
 *      sch.timetable.updated. Refuses to promote when total_clashes > 0
 *      OR any candidate_slot still carries has_clash=true.
 */

interface ConstraintsRow {
  id: string;
  school_id: string;
  academic_year_id: string | null;
  name: string;
  hard_constraints: unknown;
  soft_constraints: unknown;
  is_active: boolean;
  description: string | null;
}

interface RequestRow {
  id: string;
  school_id: string;
  academic_year_id: string | null;
  constraint_id: string;
  section_count_at_submission: number;
  solver_algorithm: 'CP_SAT' | 'HEURISTIC';
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  requested_by: string;
  candidates_generated: number | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

interface CandidateRow {
  id: string;
  request_id: string;
  candidate_name: string | null;
  solver_seed: string | null;
  total_slots: number;
  total_clashes: number;
  all_constraints_satisfied: boolean;
  constraint_violations: unknown;
  soft_constraint_score: string | null;
  review_status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MODIFIED';
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
}

interface CandidateSlotRow {
  id: string;
  candidate_id: string;
  class_id: string | null;
  teacher_id: string | null;
  room_id: string | null;
  period_id: string | null;
  day_of_week: number | null;
  rotation_day: number | null;
  has_clash: boolean;
  clash_description: string | null;
}

interface ActivationLogRow {
  id: string;
  candidate_id: string;
  slots_promoted: number;
  slots_skipped: number;
  activated_by: string;
  activated_at: string;
  notes: string | null;
}

const ADR_060_CP_SAT_THRESHOLD = 300;

function constraintsRowToDto(row: ConstraintsRow): SchedulingConstraintsResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    academicYearId: row.academic_year_id,
    name: row.name,
    hardConstraints: Array.isArray(row.hard_constraints) ? (row.hard_constraints as unknown[]) : [],
    softConstraints: Array.isArray(row.soft_constraints) ? (row.soft_constraints as unknown[]) : [],
    isActive: row.is_active,
    description: row.description,
  };
}

function requestRowToDto(
  row: RequestRow,
  candidates?: SchedulingCandidateResponseDto[],
): SchedulingRequestResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    academicYearId: row.academic_year_id,
    constraintId: row.constraint_id,
    sectionCountAtSubmission: row.section_count_at_submission,
    solverAlgorithm: row.solver_algorithm,
    status: row.status,
    requestedBy: row.requested_by,
    candidatesGenerated: row.candidates_generated,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
    candidates: candidates ?? null,
  };
}

function candidateRowToDto(row: CandidateRow): SchedulingCandidateResponseDto {
  return {
    id: row.id,
    requestId: row.request_id,
    candidateName: row.candidate_name,
    solverSeed: row.solver_seed,
    totalSlots: row.total_slots,
    totalClashes: row.total_clashes,
    allConstraintsSatisfied: row.all_constraints_satisfied,
    constraintViolations: Array.isArray(row.constraint_violations)
      ? (row.constraint_violations as unknown[])
      : [],
    softConstraintScore:
      row.soft_constraint_score === null ? null : Number(row.soft_constraint_score),
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
  };
}

function slotRowToDto(row: CandidateSlotRow): CandidateSlotResponseDto {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    classId: row.class_id,
    teacherId: row.teacher_id,
    roomId: row.room_id,
    periodId: row.period_id,
    dayOfWeek: row.day_of_week,
    rotationDay: row.rotation_day,
    hasClash: row.has_clash,
    clashDescription: row.clash_description,
  };
}

function logRowToDto(row: ActivationLogRow): ActivationLogResponseDto {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    slotsPromoted: row.slots_promoted,
    slotsSkipped: row.slots_skipped,
    activatedBy: row.activated_by,
    activatedAt: row.activated_at,
    notes: row.notes,
  };
}

/**
 * Pure helper — ADR-060 algorithm selection.
 *   - CP_SAT for sectionCount ≤ 300
 *   - HEURISTIC for sectionCount > 300
 * Manual override allowed; the caller is responsible for passing a
 * value that satisfies the database-side CHECK
 * (CP_SAT requires sectionCount ≤ 300).
 */
export function selectSolverAlgorithm(sectionCount: number): 'CP_SAT' | 'HEURISTIC' {
  return sectionCount <= ADR_060_CP_SAT_THRESHOLD ? 'CP_SAT' : 'HEURISTIC';
}

const SELECT_REQUEST_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, ' +
  'academic_year_id::text AS academic_year_id, constraint_id::text AS constraint_id, ' +
  'section_count_at_submission, solver_algorithm, status, requested_by::text AS requested_by, ' +
  'candidates_generated, ' +
  'TO_CHAR(queued_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS queued_at, ' +
  'TO_CHAR(started_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS started_at, ' +
  'TO_CHAR(completed_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS completed_at, ' +
  'error_message FROM sch_scheduling_requests ';

const SELECT_CANDIDATE_BASE =
  'SELECT id::text AS id, request_id::text AS request_id, candidate_name, solver_seed, ' +
  'total_slots, total_clashes, all_constraints_satisfied, constraint_violations, ' +
  'soft_constraint_score::text AS soft_constraint_score, review_status, ' +
  'reviewed_by::text AS reviewed_by, ' +
  'TO_CHAR(reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS reviewed_at, ' +
  'review_notes FROM sch_scheduling_candidates ';

const SELECT_SLOT_BASE =
  'SELECT id::text AS id, candidate_id::text AS candidate_id, class_id::text AS class_id, ' +
  'teacher_id::text AS teacher_id, room_id::text AS room_id, period_id::text AS period_id, ' +
  'day_of_week, rotation_day, has_clash, clash_description ' +
  'FROM sch_scheduling_candidate_slots ';

@Injectable()
export class ScheduleGenerationService {
  private readonly logger = new Logger(ScheduleGenerationService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Schedule generation requires sch-001:admin (school admin).');
    }
  }

  async listConstraints(): Promise<SchedulingConstraintsResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ConstraintsRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, academic_year_id::text AS academic_year_id, ' +
          'name, hard_constraints, soft_constraints, is_active, description ' +
          'FROM sch_scheduling_constraints WHERE school_id = $1::uuid ORDER BY is_active DESC, name ASC',
        tenant.schoolId,
      );
    });
    return rows.map(constraintsRowToDto);
  }

  async createConstraints(
    body: CreateSchedulingConstraintsDto,
    actor: ResolvedActor,
  ): Promise<SchedulingConstraintsResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_scheduling_constraints (id, school_id, academic_year_id, name, hard_constraints, soft_constraints, is_active, description) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, $7, $8)',
          id,
          tenant.schoolId,
          body.academicYearId ?? null,
          body.name,
          JSON.stringify(body.hardConstraints),
          JSON.stringify(body.softConstraints),
          body.isActive ?? true,
          body.description ?? null,
        );
      });
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string } };
      if (err.code === 'P2010' || err.meta?.code === '23505') {
        throw new ConflictException(
          'A constraint profile with this (school, year, name) already exists.',
        );
      }
      throw e;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ConstraintsRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, academic_year_id::text AS academic_year_id, ' +
          'name, hard_constraints, soft_constraints, is_active, description ' +
          'FROM sch_scheduling_constraints WHERE id = $1::uuid',
        id,
      );
    });
    return constraintsRowToDto(rows[0]!);
  }

  async listRequests(filters: { status?: string }): Promise<SchedulingRequestResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE +
          'WHERE school_id = $1::uuid AND ($2::text IS NULL OR status = $2) ' +
          'ORDER BY queued_at DESC',
        tenant.schoolId,
        filters.status ?? null,
      );
    });
    return rows.map((r) => requestRowToDto(r));
  }

  async getRequest(id: string): Promise<SchedulingRequestResponseDto> {
    const tenant = getCurrentTenant();
    const requests = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      );
    });
    if (requests.length === 0) throw new NotFoundException('Scheduling request not found');
    const candidates = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CandidateRow[]>(
        SELECT_CANDIDATE_BASE + 'WHERE request_id = $1::uuid ORDER BY created_at ASC',
        id,
      );
    });
    return requestRowToDto(requests[0]!, candidates.map(candidateRowToDto));
  }

  /**
   * Queue a scheduling request. The submission stamps section_count
   * and solver_algorithm — ADR-060 selects CP_SAT when sectionCount
   * ≤ 300 and HEURISTIC otherwise. Manual override allowed via
   * body.solverAlgorithm.
   *
   * In-process stub: the service immediately invokes the stub solver
   * inline (runStubSolver) which builds 2 deterministic candidates +
   * 30 candidate slots and stamps the request COMPLETED. When a real
   * external solver lands the service queues the request and a
   * separate SchedulingWorker drives the lifecycle.
   */
  async submitRequest(
    body: CreateSchedulingRequestDto,
    actor: ResolvedActor,
  ): Promise<SchedulingRequestResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    let sectionCount = body.sectionCount;
    if (sectionCount === undefined) {
      const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ c: bigint }>>(
          'SELECT COUNT(*)::bigint AS c FROM sis_classes',
        );
      });
      sectionCount = Number(rows[0]?.c ?? 0);
    }

    const algorithm = body.solverAlgorithm ?? selectSolverAlgorithm(sectionCount);
    if (algorithm === 'CP_SAT' && sectionCount > ADR_060_CP_SAT_THRESHOLD) {
      throw new BadRequestException(
        'CP_SAT requires sectionCount ≤ ' +
          ADR_060_CP_SAT_THRESHOLD +
          ' per ADR-060. Use HEURISTIC instead.',
      );
    }

    const id = generateId();
    const payload = {
      schoolId: tenant.schoolId,
      academicYearId: body.academicYearId ?? null,
      constraintId: body.constraintId,
      sectionCount,
      requestedBy: actor.accountId,
      snapshotAt: new Date().toISOString(),
    };
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sch_scheduling_requests (id, school_id, academic_year_id, constraint_id, section_count_at_submission, solver_algorithm, status, requested_by, queued_at, solver_payload) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, 'QUEUED', $7::uuid, now(), $8::jsonb)",
        id,
        tenant.schoolId,
        body.academicYearId ?? null,
        body.constraintId,
        sectionCount,
        algorithm,
        actor.accountId,
        JSON.stringify(payload),
      );
    });

    // Run the stub solver inline. When a real external solver lands the
    // SchedulingWorker picks up QUEUED rows and replaces this call.
    await this.runStubSolver(id, algorithm, sectionCount, actor);

    return this.getRequest(id);
  }

  /**
   * Stub solver — generates 2 candidates with 30 candidate slots each
   * (28 clean + 2 with has_clash=true on the second). Stamps the
   * request lifecycle QUEUED → RUNNING → COMPLETED and emits
   * sch.generation.completed after the tx commits.
   */
  private async runStubSolver(
    requestId: string,
    algorithm: 'CP_SAT' | 'HEURISTIC',
    sectionCount: number,
    actor: ResolvedActor,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const candidatesGenerated = 2;
    let candAId = '';
    let candBId = '';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // RUNNING transition.
      await tx.$executeRawUnsafe(
        "UPDATE sch_scheduling_requests SET status = 'RUNNING', started_at = now(), updated_at = now() WHERE id = $1::uuid",
        requestId,
      );

      // Pull a sample of rooms / periods / employees / classes to populate
      // candidate slots. The stub builds 28+2=30 rows per candidate.
      const rooms = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sch_rooms LIMIT 10',
      );
      const periods = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id::text AS id FROM sch_periods WHERE period_type = 'LESSON' ORDER BY sort_order LIMIT 6",
      );
      const teachers = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM hr_employees LIMIT 5',
      );
      const classes = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM sis_classes ORDER BY section_code LIMIT 6',
      );

      // Candidate A — clean.
      candAId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sch_scheduling_candidates (id, request_id, candidate_name, total_slots, total_clashes, all_constraints_satisfied, constraint_violations, soft_constraint_score, review_status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, 28, 0, true, '[]'::jsonb, 91.50, 'PENDING')",
        candAId,
        requestId,
        'Candidate A',
      );
      let slotsInsertedA = 0;
      outerA: for (let dow = 1; dow <= 5; dow++) {
        for (let pi = 0; pi < periods.length; pi++) {
          if (slotsInsertedA >= 28) break outerA;
          const room = rooms[pi % Math.max(rooms.length, 1)];
          const teacher = teachers[pi % Math.max(teachers.length, 1)];
          const cls = classes[pi % Math.max(classes.length, 1)];
          await tx.$executeRawUnsafe(
            'INSERT INTO sch_scheduling_candidate_slots (id, candidate_id, class_id, teacher_id, room_id, period_id, day_of_week, rotation_day, has_clash, clash_description) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::smallint, $8::smallint, false, NULL)',
            generateId(),
            candAId,
            cls ? cls.id : null,
            teacher ? teacher.id : null,
            room ? room.id : null,
            periods[pi] ? periods[pi]!.id : null,
            dow,
            ((slotsInsertedA % 2) + 1) as 1 | 2,
          );
          slotsInsertedA++;
        }
      }

      // Candidate B — 2 clashing slots.
      candBId = generateId();
      const violationsB = JSON.stringify([
        { code: 'S1', count: 2, description: 'Two consecutive same-subject blocks.' },
      ]);
      await tx.$executeRawUnsafe(
        'INSERT INTO sch_scheduling_candidates (id, request_id, candidate_name, total_slots, total_clashes, all_constraints_satisfied, constraint_violations, soft_constraint_score, review_status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, 28, 2, false, $4::jsonb, 76.40, 'PENDING')",
        candBId,
        requestId,
        'Candidate B',
        violationsB,
      );
      for (let ci = 0; ci < 2 && ci < periods.length; ci++) {
        await tx.$executeRawUnsafe(
          'INSERT INTO sch_scheduling_candidate_slots (id, candidate_id, class_id, teacher_id, room_id, period_id, day_of_week, rotation_day, has_clash, clash_description) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1::smallint, 1::smallint, true, 'Soft S1 — consecutive same-subject blocks.')",
          generateId(),
          candBId,
          classes[ci] ? classes[ci]!.id : null,
          teachers[0] ? teachers[0].id : null,
          rooms[ci] ? rooms[ci]!.id : null,
          periods[ci] ? periods[ci]!.id : null,
        );
      }

      await tx.$executeRawUnsafe(
        "UPDATE sch_scheduling_requests SET status = 'COMPLETED', completed_at = now(), candidates_generated = $1::int, updated_at = now() WHERE id = $2::uuid",
        candidatesGenerated,
        requestId,
      );

      // REVIEW-P2C17 BLOCKING 1 — emit via the platform outbox INSIDE
      // the same tx that flipped the request to COMPLETED. A broker
      // outage now leaves the row in the outbox; the
      // OutboxPublisherWorker drains on recovery. Deterministic
      // event_id keyed on requestId so retries dedup cleanly.
      await this.outbox.enqueueInTx(tx, {
        topic: 'sch.generation.completed',
        key: requestId,
        sourceModule: 'scheduling',
        eventId: deterministicGenerationCompletedEventId(requestId),
        payload: {
          requestId,
          schoolId: tenant.schoolId,
          solverAlgorithm: algorithm,
          sectionCount,
          candidatesGenerated,
          candidateIds: [candAId, candBId].filter((id) => id !== ''),
          requestedBy: actor.accountId,
          sourceRefId: requestId,
        },
      });
    });

    this.logger.log(
      '[schedule-generation] request ' +
        requestId +
        ' COMPLETED — ' +
        candidatesGenerated +
        ' candidates via ' +
        algorithm,
    );
  }

  /**
   * REVIEW-P2C17 BLOCKING 2 — candidate reads must join through
   * sch_scheduling_requests so the parent request's school_id gates
   * access. A School A admin who knows a School B candidate UUID now
   * collapses to 404 don't-leak-existence.
   */
  async getCandidate(id: string): Promise<SchedulingCandidateResponseDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CandidateRow[]>(
        'SELECT c.id::text AS id, c.request_id::text AS request_id, c.candidate_name, c.solver_seed, ' +
          'c.total_slots, c.total_clashes, c.all_constraints_satisfied, c.constraint_violations, ' +
          'c.soft_constraint_score::text AS soft_constraint_score, c.review_status, ' +
          'c.reviewed_by::text AS reviewed_by, ' +
          'TO_CHAR(c.reviewed_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS reviewed_at, ' +
          'c.review_notes ' +
          'FROM sch_scheduling_candidates c ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE c.id = $1::uuid AND r.school_id = $2::uuid',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Candidate not found');
    return candidateRowToDto(rows[0]!);
  }

  async listCandidateSlots(candidateId: string): Promise<CandidateSlotResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CandidateSlotRow[]>(
        'SELECT s.id::text AS id, s.candidate_id::text AS candidate_id, s.class_id::text AS class_id, ' +
          's.teacher_id::text AS teacher_id, s.room_id::text AS room_id, s.period_id::text AS period_id, ' +
          's.day_of_week, s.rotation_day, s.has_clash, s.clash_description ' +
          'FROM sch_scheduling_candidate_slots s ' +
          'JOIN sch_scheduling_candidates c ON c.id = s.candidate_id ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE s.candidate_id = $1::uuid AND r.school_id = $2::uuid ' +
          'ORDER BY s.day_of_week, s.rotation_day',
        candidateId,
        tenant.schoolId,
      );
    });
    return rows.map(slotRowToDto);
  }

  /**
   * Mark a candidate APPROVED. The activation worker only picks up
   * APPROVED candidates. Refuses promotion if total_clashes > 0 OR any
   * candidate_slot row still carries has_clash=true.
   */
  async approveCandidate(
    candidateId: string,
    body: ReviewCandidateDto,
    actor: ResolvedActor,
  ): Promise<SchedulingCandidateResponseDto> {
    this.assertAdmin(actor);
    return this.transitionCandidate(candidateId, 'APPROVED', body.reviewNotes, actor);
  }

  async rejectCandidate(
    candidateId: string,
    body: ReviewCandidateDto,
    actor: ResolvedActor,
  ): Promise<SchedulingCandidateResponseDto> {
    this.assertAdmin(actor);
    return this.transitionCandidate(candidateId, 'REJECTED', body.reviewNotes, actor);
  }

  private async transitionCandidate(
    candidateId: string,
    newStatus: 'APPROVED' | 'REJECTED' | 'MODIFIED',
    reviewNotes: string | undefined,
    actor: ResolvedActor,
  ): Promise<SchedulingCandidateResponseDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C17 BLOCKING 2 — lock the candidate row via JOIN to
      // the parent request with school_id = tenant.schoolId so a
      // School A admin cannot transition a School B candidate by UUID.
      const rows = await tx.$queryRawUnsafe<Array<{ id: string; review_status: string }>>(
        'SELECT c.id::text AS id, c.review_status FROM sch_scheduling_candidates c ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE c.id = $1::uuid AND r.school_id = $2::uuid FOR UPDATE OF c',
        candidateId,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Candidate not found');
      if (rows[0]!.review_status !== 'PENDING' && rows[0]!.review_status !== 'MODIFIED') {
        throw new ConflictException(
          'Candidate is in status ' +
            rows[0]!.review_status +
            ' — only PENDING / MODIFIED candidates can transition.',
        );
      }
      await tx.$executeRawUnsafe(
        'UPDATE sch_scheduling_candidates SET review_status = $1, reviewed_by = $2::uuid, reviewed_at = now(), review_notes = $3, updated_at = now() WHERE id = $4::uuid',
        newStatus,
        actor.accountId,
        reviewNotes ?? null,
        candidateId,
      );
    });
    return this.getCandidate(candidateId);
  }

  /**
   * Resolve or update a single candidate_slot clash. Setting
   * clashDescription to undefined clears the clash flag (sets
   * has_clash=false and clash_description=NULL); setting a non-empty
   * value keeps the clash flagged with the updated description.
   */
  async resolveClash(
    candidateId: string,
    body: ResolveClashDto,
    actor: ResolvedActor,
  ): Promise<CandidateSlotResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    let updated = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C17 BLOCKING 2 — lock the slot row via JOIN to the
      // parent candidate + request with school_id = tenant.schoolId so
      // a School A admin cannot resolve a clash on a School B slot.
      const owned = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sch_scheduling_candidate_slots s ' +
          'JOIN sch_scheduling_candidates c ON c.id = s.candidate_id ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE s.id = $1::uuid AND s.candidate_id = $2::uuid AND r.school_id = $3::uuid ' +
          'FOR UPDATE OF s',
        body.slotId,
        candidateId,
        tenant.schoolId,
      );
      if (owned.length === 0) {
        throw new NotFoundException('Slot not found on this candidate');
      }
      const clearFlag = body.clashDescription === undefined || body.clashDescription.trim() === '';
      if (clearFlag) {
        updated = (await tx.$executeRawUnsafe(
          'UPDATE sch_scheduling_candidate_slots SET has_clash = false, clash_description = NULL, updated_at = now() WHERE id = $1::uuid',
          body.slotId,
        )) as number;
        // Decrement total_clashes on the parent candidate if the slot was flagged.
        await tx.$executeRawUnsafe(
          'UPDATE sch_scheduling_candidates SET total_clashes = GREATEST(0, total_clashes - 1), updated_at = now() WHERE id = $1::uuid',
          candidateId,
        );
      } else {
        updated = (await tx.$executeRawUnsafe(
          'UPDATE sch_scheduling_candidate_slots SET has_clash = true, clash_description = $1, updated_at = now() WHERE id = $2::uuid',
          body.clashDescription,
          body.slotId,
        )) as number;
      }
    });
    if (updated === 0) throw new NotFoundException('Slot not updated');
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CandidateSlotRow[]>(
        'SELECT s.id::text AS id, s.candidate_id::text AS candidate_id, s.class_id::text AS class_id, ' +
          's.teacher_id::text AS teacher_id, s.room_id::text AS room_id, s.period_id::text AS period_id, ' +
          's.day_of_week, s.rotation_day, s.has_clash, s.clash_description ' +
          'FROM sch_scheduling_candidate_slots s ' +
          'JOIN sch_scheduling_candidates c ON c.id = s.candidate_id ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE s.id = $1::uuid AND r.school_id = $2::uuid',
        body.slotId,
        tenant.schoolId,
      );
    });
    return slotRowToDto(rows[0]!);
  }

  /**
   * Activate an APPROVED candidate — promote each non-clashing slot
   * to sch_timetable_slots, write the activation log row, emit
   * sch.timetable.updated. Refuses if total_clashes > 0 OR any slot
   * still carries has_clash=true.
   */
  async activateCandidate(
    candidateId: string,
    actor: ResolvedActor,
  ): Promise<ActivateCandidateResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    let slotsPromoted = 0;
    let slotsSkipped = 0;
    let activationLogId = '';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C17 BLOCKING 2 — lock the candidate row via JOIN to
      // the parent request with school_id = tenant.schoolId so the
      // School A admin cannot activate a School B candidate.
      const candRows = await tx.$queryRawUnsafe<
        Array<{ id: string; review_status: string; total_clashes: number }>
      >(
        'SELECT c.id::text AS id, c.review_status, c.total_clashes ' +
          'FROM sch_scheduling_candidates c ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE c.id = $1::uuid AND r.school_id = $2::uuid FOR UPDATE OF c',
        candidateId,
        tenant.schoolId,
      );
      if (candRows.length === 0) throw new NotFoundException('Candidate not found');
      const cand = candRows[0]!;
      if (cand.review_status !== 'APPROVED') {
        throw new ConflictException(
          'Only APPROVED candidates can be activated (current: ' + cand.review_status + ').',
        );
      }
      // Refuse if any flagged clash remains.
      const flagged = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
        'SELECT COUNT(*)::bigint AS c FROM sch_scheduling_candidate_slots WHERE candidate_id = $1::uuid AND has_clash = true',
        candidateId,
      );
      if (Number(flagged[0]?.c ?? 0) > 0) {
        throw new ConflictException(
          'Cannot activate — ' +
            Number(flagged[0]?.c ?? 0) +
            ' candidate slots still flagged with has_clash=true. Resolve them first.',
        );
      }
      if (cand.total_clashes > 0) {
        throw new ConflictException(
          'Cannot activate — candidate reports total_clashes=' +
            cand.total_clashes +
            ' from the solver run. Resolve clashes or re-run the solver.',
        );
      }

      // Pull every non-clashing slot.
      const slots = await tx.$queryRawUnsafe<CandidateSlotRow[]>(
        SELECT_SLOT_BASE + 'WHERE candidate_id = $1::uuid AND has_clash = false',
        candidateId,
      );

      // Promote each slot into sch_timetable_slots. Skip rows missing
      // any of the required NOT-NULL columns (class_id / period_id /
      // room_id) on the target table.
      //
      // Per-INSERT SAVEPOINT so an EXCLUSION (23P01) on a conflicting
      // slot rolls back only that row without aborting the whole
      // activation transaction. Without the savepoint Postgres would
      // mark the tx as aborted on the first conflict and every
      // subsequent INSERT would fail with "current transaction is
      // aborted". The schema-level constraint is the safety net; the
      // activation flow gracefully skips conflicts and records them as
      // slots_skipped.
      const today = new Date().toISOString().slice(0, 10);
      for (let idx = 0; idx < slots.length; idx++) {
        const s = slots[idx]!;
        if (!s.class_id || !s.period_id || !s.room_id) {
          slotsSkipped++;
          continue;
        }

        // REVIEW-P2C17 BLOCKING 2 — validate that every referenced
        // object belongs to the current school BEFORE inserting the
        // timetable slot. A candidate's slot can in theory carry IDs
        // from anywhere (the slot table itself is tenant-local, but
        // we still defence-in-depth: the candidate UUIDs could have
        // been written by a buggy/older solver). Skip any slot whose
        // class / period / room / teacher do not belong to this
        // tenant's school. teacher_id is nullable; only validate when
        // present.
        const refCheck = await tx.$queryRawUnsafe<
          Array<{
            class_ok: boolean;
            period_ok: boolean;
            room_ok: boolean;
            teacher_ok: boolean;
          }>
        >(
          'SELECT ' +
            '(EXISTS (SELECT 1 FROM sis_classes WHERE id = $1::uuid AND school_id = $5::uuid)) AS class_ok, ' +
            '(EXISTS (SELECT 1 FROM sch_periods p JOIN sch_bell_schedules bs ON bs.id = p.bell_schedule_id WHERE p.id = $2::uuid AND bs.school_id = $5::uuid)) AS period_ok, ' +
            '(EXISTS (SELECT 1 FROM sch_rooms WHERE id = $3::uuid AND school_id = $5::uuid)) AS room_ok, ' +
            '($4::uuid IS NULL OR EXISTS (SELECT 1 FROM hr_employees WHERE id = $4::uuid AND school_id = $5::uuid)) AS teacher_ok',
          s.class_id,
          s.period_id,
          s.room_id,
          s.teacher_id,
          tenant.schoolId,
        );
        const refs = refCheck[0]!;
        if (!refs.class_ok || !refs.period_ok || !refs.room_ok || !refs.teacher_ok) {
          this.logger.warn(
            '[schedule-generation] candidate slot ' +
              s.id +
              ' references foreign-school object(s) (class_ok=' +
              refs.class_ok +
              ' period_ok=' +
              refs.period_ok +
              ' room_ok=' +
              refs.room_ok +
              ' teacher_ok=' +
              refs.teacher_ok +
              ') — skipping promotion.',
          );
          slotsSkipped++;
          continue;
        }

        const sp = 'sp_activate_' + idx;
        await tx.$executeRawUnsafe('SAVEPOINT ' + sp);
        try {
          await tx.$executeRawUnsafe(
            'INSERT INTO sch_timetable_slots (id, school_id, class_id, period_id, teacher_id, room_id, effective_from) ' +
              'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::date)',
            generateId(),
            tenant.schoolId,
            s.class_id,
            s.period_id,
            s.teacher_id,
            s.room_id,
            today,
          );
          await tx.$executeRawUnsafe('RELEASE SAVEPOINT ' + sp);
          slotsPromoted++;
        } catch (e: unknown) {
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT ' + sp);
          // EXCLUSION violations from the existing timetable surface as
          // 23P01; UNIQUE (class, period, effective_from) as 23505;
          // Prisma may wrap both as P2010 with SQLSTATE in meta.code OR
          // as the literal code on the top-level error.
          const err = e as { code?: string; meta?: { code?: string }; message?: string };
          const code = err.code || err.meta?.code;
          const msg = err.message || '';
          const isConflict =
            code === '23P01' ||
            code === '23505' ||
            /23P01|23505|sch_timetable_slots_(teacher|room)_no_overlap|sch_timetable_slots_class_period_from_uq/.test(
              msg,
            );
          if (isConflict) {
            this.logger.warn(
              '[schedule-generation] candidate slot ' +
                s.id +
                ' could not be promoted — existing timetable conflict.',
            );
            slotsSkipped++;
            continue;
          }
          throw e;
        }
      }

      activationLogId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sch_scheduling_activation_log (id, candidate_id, slots_promoted, slots_skipped, activated_by, activated_at, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5::uuid, now(), $6)',
        activationLogId,
        candidateId,
        slotsPromoted,
        slotsSkipped,
        actor.accountId,
        slotsSkipped > 0
          ? 'Activation complete — ' +
              slotsPromoted +
              ' promoted, ' +
              slotsSkipped +
              ' skipped (placeholder slots or conflicts).'
          : null,
      );

      // REVIEW-P2C17 BLOCKING 1 — emit via the platform outbox INSIDE
      // the same tx that promoted the slots + wrote the activation
      // log. A broker outage now leaves the row in the outbox;
      // OutboxPublisherWorker drains on recovery. Deterministic
      // event_id keyed on activationLogId so retries dedup cleanly.
      await this.outbox.enqueueInTx(tx, {
        topic: 'sch.timetable.updated',
        key: candidateId,
        sourceModule: 'scheduling',
        eventId: deterministicTimetableUpdatedEventId(activationLogId),
        payload: {
          candidateId,
          schoolId: tenant.schoolId,
          slotsPromoted,
          slotsSkipped,
          activationLogId,
          activatedBy: actor.accountId,
          action: 'candidate_activated',
          sourceRefId: activationLogId,
        },
      });
    });

    this.logger.log(
      '[schedule-generation] activated candidate ' +
        candidateId +
        ' — ' +
        slotsPromoted +
        ' promoted / ' +
        slotsSkipped +
        ' skipped',
    );

    return {
      candidateId,
      slotsPromoted,
      slotsSkipped,
      activationLogId,
    };
  }

  async listActivationLogs(candidateId: string): Promise<ActivationLogResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C17 BLOCKING 2 — JOIN through candidate + request so
      // a School A admin cannot read School B activation logs by
      // candidate UUID.
      return client.$queryRawUnsafe<ActivationLogRow[]>(
        'SELECT l.id::text AS id, l.candidate_id::text AS candidate_id, l.slots_promoted, l.slots_skipped, ' +
          'l.activated_by::text AS activated_by, TO_CHAR(l.activated_at, \'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS activated_at, l.notes ' +
          'FROM sch_scheduling_activation_log l ' +
          'JOIN sch_scheduling_candidates c ON c.id = l.candidate_id ' +
          'JOIN sch_scheduling_requests r ON r.id = c.request_id ' +
          'WHERE l.candidate_id = $1::uuid AND r.school_id = $2::uuid ' +
          'ORDER BY l.activated_at DESC',
        candidateId,
        tenant.schoolId,
      );
    });
    return rows.map(logRowToDto);
  }
}
