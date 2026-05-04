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
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateAccommodationDto,
  CreateGoalProgressDto,
  CreateIepGoalDto,
  CreateIepPlanDto,
  CreateIepServiceDto,
  IepAccommodationResponseDto,
  IepAppliesTo,
  IepDeliveryMethod,
  IepGoalProgressResponseDto,
  IepGoalResponseDto,
  IepGoalStatus,
  IepPlanResponseDto,
  IepPlanStatus,
  IepPlanType,
  IepServiceResponseDto,
  UpdateAccommodationDto,
  UpdateIepGoalDto,
  UpdateIepPlanDto,
  UpdateIepServiceDto,
} from './dto/health.dto';

interface PlanRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  plan_type: string;
  status: string;
  start_date: string | null;
  review_date: string | null;
  end_date: string | null;
  case_manager_id: string | null;
  case_manager_first: string | null;
  case_manager_last: string | null;
  created_at: string;
  updated_at: string;
}

interface GoalRow {
  id: string;
  iep_plan_id: string;
  goal_text: string;
  measurement_criteria: string | null;
  baseline: string | null;
  target_value: string | null;
  current_value: string | null;
  goal_area: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  id: string;
  goal_id: string;
  recorded_by: string | null;
  recorded_first: string | null;
  recorded_last: string | null;
  progress_value: string | null;
  observation_notes: string | null;
  recorded_at: string;
}

interface ServiceRow {
  id: string;
  iep_plan_id: string;
  service_type: string;
  provider_name: string | null;
  frequency: string | null;
  minutes_per_session: number | null;
  delivery_method: string;
  created_at: string;
  updated_at: string;
}

interface AccommodationRow {
  id: string;
  iep_plan_id: string;
  accommodation_type: string;
  description: string | null;
  applies_to: string;
  specific_assignment_types: string[] | null;
  effective_from: string | null;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PLAN_BASE =
  'SELECT p.id::text AS id, p.school_id::text AS school_id, ' +
  'p.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'p.plan_type, p.status, ' +
  "TO_CHAR(p.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(p.review_date, 'YYYY-MM-DD') AS review_date, " +
  "TO_CHAR(p.end_date, 'YYYY-MM-DD') AS end_date, " +
  'p.case_manager_id::text AS case_manager_id, ' +
  'cmp.first_name AS case_manager_first, cmp.last_name AS case_manager_last, ' +
  'TO_CHAR(p.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(p.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_iep_plans p ' +
  'JOIN sis_students s ON s.id = p.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN hr_employees cme ON cme.id = p.case_manager_id ' +
  'LEFT JOIN platform.iam_person cmp ON cmp.id = cme.person_id ';

const SELECT_GOAL_BASE =
  'SELECT id::text AS id, iep_plan_id::text AS iep_plan_id, ' +
  'goal_text, measurement_criteria, baseline, target_value, current_value, goal_area, status, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_iep_goals ';

const SELECT_PROGRESS_BASE =
  'SELECT pg.id::text AS id, pg.goal_id::text AS goal_id, ' +
  'pg.recorded_by::text AS recorded_by, ' +
  'rp.first_name AS recorded_first, rp.last_name AS recorded_last, ' +
  'pg.progress_value, pg.observation_notes, ' +
  'TO_CHAR(pg.recorded_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS recorded_at ' +
  'FROM hlth_iep_goal_progress pg ' +
  'LEFT JOIN hr_employees re ON re.id = pg.recorded_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ';

const SELECT_SERVICE_BASE =
  'SELECT id::text AS id, iep_plan_id::text AS iep_plan_id, ' +
  'service_type, provider_name, frequency, minutes_per_session, delivery_method, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_iep_services ';

const SELECT_ACC_BASE =
  'SELECT id::text AS id, iep_plan_id::text AS iep_plan_id, ' +
  'accommodation_type, description, applies_to, specific_assignment_types, ' +
  "TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to, " +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_iep_accommodations ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * IepPlanService — Cycle 10 Step 7.
 *
 * Owns the full IEP / 504 plan surface — plans, goals, goal progress,
 * services, accommodations. Reads write a VIEW_IEP audit row.
 *
 * Visibility:
 *  - Admin / nurse / counsellor (hasNurseScope) → all in tenant.
 *  - Parent (GUARDIAN) → own children with full IEP detail (parents
 *    are full IEP team participants — no PII strip; goal progress
 *    and accommodations are collaborative records).
 *  - Teacher → 403 service-layer. Teachers consume accommodations
 *    via the ADR-030 sis_student_active_accommodations read model
 *    (maintained by the IepAccommodationConsumer below). They never
 *    read hlth_iep_plans directly.
 *  - Student → 403 at gate.
 *
 * Accommodation mutations emit `iep.accommodation.updated` with the
 * full post-mutation accommodation set so the IepAccommodationConsumer
 * can upsert sis_student_active_accommodations keyed on
 * source_iep_accommodation_id and DELETE rows whose source row was
 * removed. The emit is idempotent — the consumer reconciles state by
 * comparing the snapshot with what's in the read model.
 */
@Injectable()
export class IepPlanService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
    private readonly kafka: KafkaProducerService,
  ) {}

  // ─── Plan reads ──────────────────────────────────────────────

  /**
   * Get the active (non-EXPIRED) plan for a student plus all goals,
   * services, and accommodations inlined. Returns null when the
   * student has no plan yet — distinct from 404 (which would mean
   * the row scope rejected). The Step 8 admin UI uses null to surface
   * "no plan yet — create one".
   */
  async getForStudent(studentId: string, actor: ResolvedActor): Promise<IepPlanResponseDto | null> {
    await this.assertCanReadStudent(studentId, actor);

    const plan = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PLAN_BASE +
          "WHERE p.student_id = $1::uuid AND p.status <> 'EXPIRED' " +
          'ORDER BY p.created_at DESC LIMIT 1',
        studentId,
      )) as PlanRow[];
      return rows[0] ?? null;
    });

    if (!plan) return null;
    const dto = await this.loadFullPlan(plan);
    await this.accessLog.recordAccess(actor, studentId, 'VIEW_IEP');
    return dto;
  }

  // ─── Plan writes ─────────────────────────────────────────────

  async create(
    studentId: string,
    input: CreateIepPlanDto,
    actor: ResolvedActor,
  ): Promise<IepPlanResponseDto> {
    await this.assertNurseScope(actor);
    if (!(await this.studentExistsInTenant(studentId))) {
      throw new NotFoundException('Student ' + studentId);
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO hlth_iep_plans ' +
            '(id, school_id, student_id, plan_type, status, start_date, review_date, end_date, case_manager_id) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'DRAFT', $5::date, $6::date, $7::date, $8::uuid)",
          id,
          tenant.schoolId,
          studentId,
          input.planType,
          input.startDate ?? null,
          input.reviewDate ?? null,
          input.endDate ?? null,
          input.caseManagerId ?? null,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          'Student already has a non-EXPIRED IEP/504 plan. Expire the existing plan before creating a new one.',
        );
      }
      throw err;
    }
    return this.loadOrFailById(id);
  }

  async update(
    id: string,
    input: UpdateIepPlanDto,
    actor: ResolvedActor,
  ): Promise<IepPlanResponseDto> {
    await this.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.status !== undefined) {
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    if (input.startDate !== undefined) {
      sets.push('start_date = $' + idx + '::date');
      params.push(input.startDate);
      idx++;
    }
    if (input.reviewDate !== undefined) {
      sets.push('review_date = $' + idx + '::date');
      params.push(input.reviewDate);
      idx++;
    }
    if (input.endDate !== undefined) {
      sets.push('end_date = $' + idx + '::date');
      params.push(input.endDate);
      idx++;
    }
    if (input.caseManagerId !== undefined) {
      sets.push('case_manager_id = $' + idx + '::uuid');
      params.push(input.caseManagerId);
      idx++;
    }
    if (sets.length === 0) return this.loadOrFailById(id);
    sets.push('updated_at = now()');
    params.push(id);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM hlth_iep_plans WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string }>;
      if (lockRows.length === 0) throw new NotFoundException('IEP plan ' + id);
      try {
        await tx.$executeRawUnsafe(
          'UPDATE hlth_iep_plans SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
          ...params,
        );
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException(
            'Student already has a non-EXPIRED IEP/504 plan. Expire the existing plan first.',
          );
        }
        throw err;
      }
    });
    // If status changed (e.g. ACTIVE → EXPIRED) the accommodation set
    // visible to the read model has effectively changed — re-emit so
    // the consumer can drop the rows. We always emit on UPDATE for
    // safety; the consumer is idempotent.
    await this.emitAccommodationSnapshotByPlanId(id);
    return this.loadOrFailById(id);
  }

  // ─── Goals ───────────────────────────────────────────────────

  async addGoal(
    planId: string,
    input: CreateIepGoalDto,
    actor: ResolvedActor,
  ): Promise<IepGoalResponseDto> {
    await this.assertNurseScope(actor);
    await this.loadOrFailById(planId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_iep_goals ' +
          '(id, iep_plan_id, goal_text, measurement_criteria, baseline, target_value, current_value, goal_area, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'ACTIVE')",
        id,
        planId,
        input.goalText,
        input.measurementCriteria ?? null,
        input.baseline ?? null,
        input.targetValue ?? null,
        input.currentValue ?? null,
        input.goalArea ?? null,
      );
    });
    return this.loadGoalOrFail(id);
  }

  async updateGoal(
    id: string,
    input: UpdateIepGoalDto,
    actor: ResolvedActor,
  ): Promise<IepGoalResponseDto> {
    await this.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.goalText !== undefined) {
      sets.push('goal_text = $' + idx);
      params.push(input.goalText);
      idx++;
    }
    if (input.measurementCriteria !== undefined) {
      sets.push('measurement_criteria = $' + idx);
      params.push(input.measurementCriteria);
      idx++;
    }
    if (input.baseline !== undefined) {
      sets.push('baseline = $' + idx);
      params.push(input.baseline);
      idx++;
    }
    if (input.targetValue !== undefined) {
      sets.push('target_value = $' + idx);
      params.push(input.targetValue);
      idx++;
    }
    if (input.currentValue !== undefined) {
      sets.push('current_value = $' + idx);
      params.push(input.currentValue);
      idx++;
    }
    if (input.goalArea !== undefined) {
      sets.push('goal_area = $' + idx);
      params.push(input.goalArea);
      idx++;
    }
    if (input.status !== undefined) {
      sets.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    if (sets.length === 0) return this.loadGoalOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_iep_goals SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('IEP goal ' + id);
    return this.loadGoalOrFail(id);
  }

  async addGoalProgress(
    goalId: string,
    input: CreateGoalProgressDto,
    actor: ResolvedActor,
  ): Promise<IepGoalProgressResponseDto> {
    await this.assertNurseScope(actor);
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Recording staff member must have an employee record (no hr_employees row)',
      );
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const goalCheck = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hlth_iep_goals WHERE id = $1::uuid LIMIT 1',
        goalId,
      )) as Array<{ ok: number }>;
      if (goalCheck.length === 0) throw new NotFoundException('IEP goal ' + goalId);

      await client.$executeRawUnsafe(
        'INSERT INTO hlth_iep_goal_progress ' +
          '(id, goal_id, recorded_by, progress_value, observation_notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        id,
        goalId,
        actor.employeeId,
        input.progressValue ?? null,
        input.observationNotes ?? null,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        SELECT_PROGRESS_BASE + 'WHERE pg.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Goal progress ' + id);
    return this.progressRowToDto(rows[0]!);
  }

  // ─── Services ────────────────────────────────────────────────

  async addService(
    planId: string,
    input: CreateIepServiceDto,
    actor: ResolvedActor,
  ): Promise<IepServiceResponseDto> {
    await this.assertNurseScope(actor);
    await this.loadOrFailById(planId);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_iep_services ' +
          '(id, iep_plan_id, service_type, provider_name, frequency, minutes_per_session, delivery_method) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
        id,
        planId,
        input.serviceType,
        input.providerName ?? null,
        input.frequency ?? null,
        input.minutesPerSession ?? null,
        input.deliveryMethod,
      );
    });
    return this.loadServiceOrFail(id);
  }

  async updateService(
    id: string,
    input: UpdateIepServiceDto,
    actor: ResolvedActor,
  ): Promise<IepServiceResponseDto> {
    await this.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.serviceType !== undefined) {
      sets.push('service_type = $' + idx);
      params.push(input.serviceType);
      idx++;
    }
    if (input.providerName !== undefined) {
      sets.push('provider_name = $' + idx);
      params.push(input.providerName);
      idx++;
    }
    if (input.frequency !== undefined) {
      sets.push('frequency = $' + idx);
      params.push(input.frequency);
      idx++;
    }
    if (input.minutesPerSession !== undefined) {
      sets.push('minutes_per_session = $' + idx);
      params.push(input.minutesPerSession);
      idx++;
    }
    if (input.deliveryMethod !== undefined) {
      sets.push('delivery_method = $' + idx);
      params.push(input.deliveryMethod);
      idx++;
    }
    if (sets.length === 0) return this.loadServiceOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_iep_services SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    if (result === 0) throw new NotFoundException('IEP service ' + id);
    return this.loadServiceOrFail(id);
  }

  // ─── Accommodations (the keystone for ADR-030 emit) ─────────

  async addAccommodation(
    planId: string,
    input: CreateAccommodationDto,
    actor: ResolvedActor,
  ): Promise<IepAccommodationResponseDto> {
    await this.assertNurseScope(actor);
    await this.loadOrFailById(planId);
    this.assertAccommodationShape(input.appliesTo, input.specificAssignmentTypes ?? null);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_iep_accommodations ' +
          '(id, iep_plan_id, accommodation_type, description, applies_to, specific_assignment_types, effective_from, effective_to) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7::date, $8::date)',
        id,
        planId,
        input.accommodationType,
        input.description ?? null,
        input.appliesTo,
        input.specificAssignmentTypes ?? null,
        input.effectiveFrom ?? null,
        input.effectiveTo ?? null,
      );
    });
    await this.emitAccommodationSnapshotByPlanId(planId);
    return this.loadAccommodationOrFail(id);
  }

  async updateAccommodation(
    id: string,
    input: UpdateAccommodationDto,
    actor: ResolvedActor,
  ): Promise<IepAccommodationResponseDto> {
    await this.assertNurseScope(actor);
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.accommodationType !== undefined) {
      sets.push('accommodation_type = $' + idx);
      params.push(input.accommodationType);
      idx++;
    }
    if (input.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.appliesTo !== undefined) {
      sets.push('applies_to = $' + idx);
      params.push(input.appliesTo);
      idx++;
    }
    if (input.specificAssignmentTypes !== undefined) {
      sets.push('specific_assignment_types = $' + idx + '::text[]');
      params.push(input.specificAssignmentTypes);
      idx++;
    }
    if (input.effectiveFrom !== undefined) {
      sets.push('effective_from = $' + idx + '::date');
      params.push(input.effectiveFrom);
      idx++;
    }
    if (input.effectiveTo !== undefined) {
      sets.push('effective_to = $' + idx + '::date');
      params.push(input.effectiveTo);
      idx++;
    }
    if (sets.length === 0) return this.loadAccommodationOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);

    const planId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT iep_plan_id::text AS plan_id FROM hlth_iep_accommodations WHERE id = $1::uuid LIMIT 1',
        id,
      )) as Array<{ plan_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Accommodation ' + id);
      return rows[0]!.plan_id;
    });

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE hlth_iep_accommodations SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    await this.emitAccommodationSnapshotByPlanId(planId);
    return this.loadAccommodationOrFail(id);
  }

  async removeAccommodation(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertNurseScope(actor);
    const planId = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT iep_plan_id::text AS plan_id FROM hlth_iep_accommodations WHERE id = $1::uuid LIMIT 1',
        id,
      )) as Array<{ plan_id: string }>;
      if (rows.length === 0) throw new NotFoundException('Accommodation ' + id);
      return rows[0]!.plan_id;
    });
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe('DELETE FROM hlth_iep_accommodations WHERE id = $1::uuid', id);
    });
    await this.emitAccommodationSnapshotByPlanId(planId);
  }

  // ─── Internal helpers ────────────────────────────────────────

  private async assertCanReadStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<{ isManager: boolean }> {
    const isManager = await this.records.hasNurseScope(actor);
    if (isManager) {
      // Verify student exists in tenant.
      if (!(await this.studentExistsInTenant(studentId))) {
        throw new NotFoundException('Student ' + studentId);
      }
      return { isManager: true };
    }
    if (actor.personType === 'GUARDIAN') {
      const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      });
      if (!ok) throw new NotFoundException('Student ' + studentId);
      return { isManager: false };
    }
    // Teachers and students don't read IEP plans directly. Teachers
    // see accommodations via the ADR-030 read model maintained by the
    // IepAccommodationConsumer; students 403 at the gate.
    throw new ForbiddenException(
      'IEP plans are visible to nurses, admins, counsellors, and parents only. Teachers see accommodations via sis_student_active_accommodations.',
    );
  }

  private async assertNurseScope(actor: ResolvedActor): Promise<void> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses, counsellors, and admins can edit IEP plans');
    }
  }

  private async studentExistsInTenant(studentId: string): Promise<boolean> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
  }

  private assertAccommodationShape(appliesTo: IepAppliesTo, specificTypes: string[] | null): void {
    // Mirror the schema's applies_to_chk so we surface a friendly
    // 400 instead of a 23514. The schema is the belt-and-braces.
    if (appliesTo === 'SPECIFIC') {
      if (!specificTypes || specificTypes.length === 0) {
        throw new BadRequestException(
          'applies_to=SPECIFIC requires a non-empty specificAssignmentTypes array',
        );
      }
    } else if (specificTypes !== null) {
      throw new BadRequestException(
        'applies_to=' +
          appliesTo +
          ' requires specificAssignmentTypes to be null (broad scopes cannot also enumerate specific types)',
      );
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    const errObj = err as { code?: string; meta?: { code?: string }; message?: string };
    return (
      errObj?.code === 'P2010' ||
      errObj?.meta?.code === '23505' ||
      (typeof errObj?.message === 'string' && errObj.message.includes('23505'))
    );
  }

  // ─── Loaders ─────────────────────────────────────────────────

  private async loadFullPlan(plan: PlanRow): Promise<IepPlanResponseDto> {
    const [goals, services, accommodations] = await this.tenantPrisma.executeInTenantContext(
      async (client) => {
        return Promise.all([
          client.$queryRawUnsafe<GoalRow[]>(
            SELECT_GOAL_BASE + 'WHERE iep_plan_id = $1::uuid ORDER BY created_at ASC',
            plan.id,
          ),
          client.$queryRawUnsafe<ServiceRow[]>(
            SELECT_SERVICE_BASE + 'WHERE iep_plan_id = $1::uuid ORDER BY created_at ASC',
            plan.id,
          ),
          client.$queryRawUnsafe<AccommodationRow[]>(
            SELECT_ACC_BASE + 'WHERE iep_plan_id = $1::uuid ORDER BY created_at ASC',
            plan.id,
          ),
        ]);
      },
    );

    // Per-goal progress timeline (newest first).
    const goalIds = goals.map((g) => g.id);
    let progressRows: ProgressRow[] = [];
    if (goalIds.length > 0) {
      progressRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<ProgressRow[]>(
          SELECT_PROGRESS_BASE + 'WHERE pg.goal_id = ANY($1::uuid[]) ORDER BY pg.recorded_at DESC',
          goalIds,
        );
      });
    }
    const progressByGoal = new Map<string, IepGoalProgressResponseDto[]>();
    for (const p of progressRows) {
      const arr = progressByGoal.get(p.goal_id) ?? [];
      arr.push(this.progressRowToDto(p));
      progressByGoal.set(p.goal_id, arr);
    }

    return {
      id: plan.id,
      schoolId: plan.school_id,
      studentId: plan.student_id,
      studentFirstName: plan.student_first,
      studentLastName: plan.student_last,
      planType: plan.plan_type as IepPlanType,
      status: plan.status as IepPlanStatus,
      startDate: plan.start_date,
      reviewDate: plan.review_date,
      endDate: plan.end_date,
      caseManagerId: plan.case_manager_id,
      caseManagerName: fullName(plan.case_manager_first, plan.case_manager_last),
      goals: goals.map((g) => ({
        id: g.id,
        iepPlanId: g.iep_plan_id,
        goalText: g.goal_text,
        measurementCriteria: g.measurement_criteria,
        baseline: g.baseline,
        targetValue: g.target_value,
        currentValue: g.current_value,
        goalArea: g.goal_area,
        status: g.status as IepGoalStatus,
        progress: progressByGoal.get(g.id) ?? [],
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      })),
      services: services.map((s) => this.serviceRowToDto(s)),
      accommodations: accommodations.map((a) => this.accommodationRowToDto(a)),
      createdAt: plan.created_at,
      updatedAt: plan.updated_at,
    };
  }

  private async loadOrFailById(id: string): Promise<IepPlanResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PlanRow[]>(SELECT_PLAN_BASE + 'WHERE p.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('IEP plan ' + id);
    return this.loadFullPlan(rows[0]!);
  }

  private async loadGoalOrFail(id: string): Promise<IepGoalResponseDto> {
    const goals = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<GoalRow[]>(SELECT_GOAL_BASE + 'WHERE id = $1::uuid', id);
    });
    if (goals.length === 0) throw new NotFoundException('IEP goal ' + id);
    const progress = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ProgressRow[]>(
        SELECT_PROGRESS_BASE + 'WHERE pg.goal_id = $1::uuid ORDER BY pg.recorded_at DESC',
        id,
      );
    });
    const g = goals[0]!;
    return {
      id: g.id,
      iepPlanId: g.iep_plan_id,
      goalText: g.goal_text,
      measurementCriteria: g.measurement_criteria,
      baseline: g.baseline,
      targetValue: g.target_value,
      currentValue: g.current_value,
      goalArea: g.goal_area,
      status: g.status as IepGoalStatus,
      progress: progress.map((p) => this.progressRowToDto(p)),
      createdAt: g.created_at,
      updatedAt: g.updated_at,
    };
  }

  private async loadServiceOrFail(id: string): Promise<IepServiceResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ServiceRow[]>(SELECT_SERVICE_BASE + 'WHERE id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('IEP service ' + id);
    return this.serviceRowToDto(rows[0]!);
  }

  private async loadAccommodationOrFail(id: string): Promise<IepAccommodationResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AccommodationRow[]>(
        SELECT_ACC_BASE + 'WHERE id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Accommodation ' + id);
    return this.accommodationRowToDto(rows[0]!);
  }

  private serviceRowToDto(r: ServiceRow): IepServiceResponseDto {
    return {
      id: r.id,
      iepPlanId: r.iep_plan_id,
      serviceType: r.service_type,
      providerName: r.provider_name,
      frequency: r.frequency,
      minutesPerSession: r.minutes_per_session,
      deliveryMethod: r.delivery_method as IepDeliveryMethod,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private accommodationRowToDto(r: AccommodationRow): IepAccommodationResponseDto {
    return {
      id: r.id,
      iepPlanId: r.iep_plan_id,
      accommodationType: r.accommodation_type,
      description: r.description,
      appliesTo: r.applies_to as IepAppliesTo,
      specificAssignmentTypes: r.specific_assignment_types,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private progressRowToDto(r: ProgressRow): IepGoalProgressResponseDto {
    return {
      id: r.id,
      goalId: r.goal_id,
      recordedById: r.recorded_by,
      recordedByName: fullName(r.recorded_first, r.recorded_last),
      progressValue: r.progress_value,
      observationNotes: r.observation_notes,
      recordedAt: r.recorded_at,
    };
  }

  // ─── Kafka emit (the ADR-030 keystone) ───────────────────────

  /**
   * Reads the full set of accommodations + plan_type for a plan and
   * emits `iep.accommodation.updated` with the snapshot. The Step 7
   * IepAccommodationConsumer consumes and reconciles
   * sis_student_active_accommodations.
   *
   * Called after every accommodation INSERT / UPDATE / DELETE and on
   * IEP plan UPDATE (status changes — e.g. ACTIVE → EXPIRED — change
   * which accommodations the read model should expose).
   */
  private async emitAccommodationSnapshotByPlanId(planId: string): Promise<void> {
    const snapshot = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const planRows = (await client.$queryRawUnsafe(
        'SELECT student_id::text AS student_id, plan_type, status, school_id::text AS school_id ' +
          'FROM hlth_iep_plans WHERE id = $1::uuid LIMIT 1',
        planId,
      )) as Array<{
        student_id: string;
        plan_type: string;
        status: string;
        school_id: string;
      }>;
      if (planRows.length === 0) return null;
      const plan = planRows[0]!;

      // EXPIRED plans contribute no accommodations to the read model.
      const accommodations =
        plan.status === 'EXPIRED'
          ? []
          : ((await client.$queryRawUnsafe(
              'SELECT id::text AS id, accommodation_type, description, applies_to, ' +
                'specific_assignment_types, ' +
                "TO_CHAR(effective_from, 'YYYY-MM-DD') AS effective_from, " +
                "TO_CHAR(effective_to, 'YYYY-MM-DD') AS effective_to " +
                'FROM hlth_iep_accommodations WHERE iep_plan_id = $1::uuid',
              planId,
            )) as Array<{
              id: string;
              accommodation_type: string;
              description: string | null;
              applies_to: string;
              specific_assignment_types: string[] | null;
              effective_from: string | null;
              effective_to: string | null;
            }>);

      return { plan, accommodations };
    });

    if (!snapshot) return;
    const tenant = getCurrentTenant();
    void this.kafka.emit({
      topic: 'iep.accommodation.updated',
      key: snapshot.plan.student_id,
      sourceModule: 'health',
      payload: {
        planId,
        schoolId: snapshot.plan.school_id,
        studentId: snapshot.plan.student_id,
        planType: snapshot.plan.plan_type,
        planStatus: snapshot.plan.status,
        accommodations: snapshot.accommodations.map((a) => ({
          sourceIepAccommodationId: a.id,
          accommodationType: a.accommodation_type,
          description: a.description,
          appliesTo: a.applies_to,
          specificAssignmentTypes: a.specific_assignment_types,
          effectiveFrom: a.effective_from,
          effectiveTo: a.effective_to,
        })),
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
  }
}
