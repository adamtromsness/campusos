import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  AdmissionType,
  CompleteTaskDto,
  CreateChecklistDto,
  OnboardingChecklistResponseDto,
  OnboardingTaskTemplateResponseDto,
  ProgressStatus,
  StudentOnboardingProgressResponseDto,
  TaskCategory,
  TaskCompletionResponseDto,
  TaskStatus,
} from './dto/cycle16.dto';

interface ChecklistRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  admission_type: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  checklist_id: string;
  task_name: string;
  description: string | null;
  task_category: string;
  is_mandatory: boolean;
  responsible_role: string | null;
  sort_order: number;
  due_days_before_start: number;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  id: string;
  application_id: string;
  checklist_id: string;
  checklist_name: string | null;
  student_id: string | null;
  started_date: string;
  target_start_date: string;
  overall_status: string;
  tasks_total: number;
  tasks_completed: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskCompletionRow {
  id: string;
  progress_id: string;
  task_id: string;
  task_name: string | null;
  task_category: string | null;
  responsible_role: string | null;
  is_mandatory: boolean | null;
  sort_order: number | null;
  status: string;
  completed_by: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  notes: string | null;
}

const SELECT_CHECKLIST =
  'SELECT id::text AS id, school_id::text AS school_id, name, description, ' +
  'admission_type, is_active, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM enr_onboarding_checklists ';

const SELECT_TASK =
  'SELECT id::text AS id, checklist_id::text AS checklist_id, task_name, description, ' +
  'task_category, is_mandatory, responsible_role, sort_order, due_days_before_start, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM enr_onboarding_tasks ';

const SELECT_PROGRESS =
  'SELECT p.id::text AS id, p.application_id::text AS application_id, ' +
  'p.checklist_id::text AS checklist_id, c.name AS checklist_name, ' +
  "p.student_id::text AS student_id, TO_CHAR(p.started_date, 'YYYY-MM-DD') AS started_date, " +
  "TO_CHAR(p.target_start_date, 'YYYY-MM-DD') AS target_start_date, " +
  'p.overall_status, p.tasks_total, p.tasks_completed, ' +
  'TO_CHAR(p.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'TO_CHAR(p.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(p.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM enr_student_onboarding_progress p ' +
  'JOIN enr_onboarding_checklists c ON c.id = p.checklist_id ';

const SELECT_TASK_COMPLETION =
  'SELECT tc.id::text AS id, tc.progress_id::text AS progress_id, ' +
  'tc.task_id::text AS task_id, t.task_name, t.task_category, t.responsible_role, ' +
  't.is_mandatory, t.sort_order, tc.status, tc.completed_by::text AS completed_by, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_users pu " +
  '  JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
  '  WHERE pu.id = tc.completed_by) AS completed_by_name, ' +
  'TO_CHAR(tc.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'tc.notes ' +
  'FROM enr_student_onboarding_task_completions tc ' +
  'JOIN enr_onboarding_tasks t ON t.id = tc.task_id ';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e?.code === '23505' ||
    e?.meta?.code === '23505' ||
    /duplicate key value violates unique constraint/i.test(e?.message ?? '')
  );
}

function checklistRowToDto(r: ChecklistRow): OnboardingChecklistResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    admissionType: r.admission_type as AdmissionType,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function taskRowToDto(r: TaskRow): OnboardingTaskTemplateResponseDto {
  return {
    id: r.id,
    checklistId: r.checklist_id,
    taskName: r.task_name,
    description: r.description,
    taskCategory: r.task_category as TaskCategory,
    isMandatory: r.is_mandatory,
    responsibleRole: r.responsible_role,
    sortOrder: r.sort_order,
    dueDaysBeforeStart: r.due_days_before_start,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function progressRowToDto(r: ProgressRow): StudentOnboardingProgressResponseDto {
  return {
    id: r.id,
    applicationId: r.application_id,
    checklistId: r.checklist_id,
    checklistName: r.checklist_name,
    studentId: r.student_id,
    startedDate: r.started_date,
    targetStartDate: r.target_start_date,
    overallStatus: r.overall_status as ProgressStatus,
    tasksTotal: r.tasks_total,
    tasksCompleted: r.tasks_completed,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function completionRowToDto(r: TaskCompletionRow): TaskCompletionResponseDto {
  return {
    id: r.id,
    progressId: r.progress_id,
    taskId: r.task_id,
    taskName: r.task_name,
    taskCategory: (r.task_category as TaskCategory) ?? null,
    responsibleRole: r.responsible_role,
    isMandatory: r.is_mandatory ?? undefined,
    sortOrder: r.sort_order ?? undefined,
    status: r.status as TaskStatus,
    completedBy: r.completed_by,
    completedByName: r.completed_by_name,
    completedAt: r.completed_at,
    notes: r.notes,
  };
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  // ── Checklists ──

  async listChecklists(includeInactive = false): Promise<OnboardingChecklistResponseDto[]> {
    const tenant = getCurrentTenant();
    const sql =
      SELECT_CHECKLIST +
      'WHERE school_id = $1::uuid ' +
      (includeInactive ? '' : 'AND is_active = true ') +
      'ORDER BY admission_type, name ASC';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(sql, tenant.schoolId);
    })) as ChecklistRow[];
    return rows.map(checklistRowToDto);
  }

  async getChecklist(id: string): Promise<OnboardingChecklistResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_CHECKLIST + 'WHERE id = $1::uuid', id);
    })) as ChecklistRow[];
    if (rows.length === 0) throw new NotFoundException('Checklist not found');
    const dto = checklistRowToDto(rows[0]!);
    const taskRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TASK + 'WHERE checklist_id = $1::uuid ORDER BY sort_order ASC',
        id,
      );
    })) as TaskRow[];
    dto.tasks = taskRows.map(taskRowToDto);
    return dto;
  }

  async createChecklist(
    input: CreateChecklistDto,
    actor: ResolvedActor,
  ): Promise<OnboardingChecklistResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create onboarding checklists');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'INSERT INTO enr_onboarding_checklists (id, school_id, name, description, admission_type, is_active) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
          id,
          tenant.schoolId,
          input.name,
          input.description ?? null,
          input.admissionType,
        );
        if (input.tasks && input.tasks.length > 0) {
          for (let i = 0; i < input.tasks.length; i++) {
            const t = input.tasks[i]!;
            await tx.$executeRawUnsafe(
              'INSERT INTO enr_onboarding_tasks (id, checklist_id, task_name, description, task_category, is_mandatory, responsible_role, sort_order, due_days_before_start) ' +
                'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)',
              generateId(),
              id,
              t.taskName,
              t.description ?? null,
              t.taskCategory,
              t.isMandatory ?? true,
              t.responsibleRole ?? null,
              t.sortOrder ?? i,
              t.dueDaysBeforeStart ?? 0,
            );
          }
        }
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new BadRequestException(
          'A checklist named "' + input.name + '" with this admission type already exists.',
        );
      }
      throw e;
    }
    return this.getChecklist(id);
  }

  // ── Progress ──

  /**
   * Row-scope: admin/EO see every onboarding progress row;
   * guardian sees own children's rows only (matched on
   * enr_applications.guardian_person_id = actor.personId);
   * everyone else gets a collapsed 404 — REVIEW-CYCLE16 BLOCKING 1.
   */
  private async assertCanReadApplication(
    applicationId: string,
    actor: ResolvedActor,
  ): Promise<void> {
    if (actor.isSchoolAdmin || actor.personType === 'STAFF') return;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT guardian_person_id::text AS gpid FROM enr_applications WHERE id = $1::uuid',
        applicationId,
      );
    })) as Array<{ gpid: string | null }>;
    if (rows.length === 0) throw new NotFoundException('Application not found');
    const gpid = rows[0]!.gpid;
    const isOwnGuardian =
      actor.personType === 'GUARDIAN' && gpid !== null && gpid === actor.personId;
    if (!isOwnGuardian) {
      throw new NotFoundException('Application not found');
    }
  }

  async getProgress(
    id: string,
    actor: ResolvedActor,
  ): Promise<StudentOnboardingProgressResponseDto> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_PROGRESS + 'WHERE p.id = $1::uuid', id);
    })) as ProgressRow[];
    if (rows.length === 0) throw new NotFoundException('Progress row not found');
    await this.assertCanReadApplication(rows[0]!.application_id, actor);
    const dto = progressRowToDto(rows[0]!);
    const completions = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TASK_COMPLETION + 'WHERE tc.progress_id = $1::uuid ORDER BY t.sort_order ASC',
        id,
      );
    })) as TaskCompletionRow[];
    dto.taskCompletions = completions.map(completionRowToDto);
    return dto;
  }

  async getProgressForApplication(
    applicationId: string,
    actor: ResolvedActor,
  ): Promise<StudentOnboardingProgressResponseDto | null> {
    await this.assertCanReadApplication(applicationId, actor);
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_PROGRESS + 'WHERE p.application_id = $1::uuid LIMIT 1',
        applicationId,
      );
    })) as ProgressRow[];
    if (rows.length === 0) return null;
    return this.getProgress(rows[0]!.id, actor);
  }

  /**
   * Generate a per-student onboarding progress row by cloning the
   * school's STANDARD_INTAKE checklist into per-task completion rows
   * with status=PENDING. Called by the OfferService.respond hook on
   * ACCEPTED inside the same tenant tx so the offer-accept and
   * checklist-creation are atomic.
   */
  /**
   * Tx-aware variant called by OfferService.respond inside the
   * already-open tenant tx so offer-accept and progress-row creation
   * are atomic. Returns a typed result so the caller can distinguish
   * the legitimate "no checklist configured for this school yet"
   * branch from real failures (which must be rethrown so the
   * offer-accept tx rolls back together) — REVIEW-CYCLE16 BLOCKING 3.
   */
  async generateProgressForApplicationInTx(
    tx: Parameters<Parameters<TenantPrismaService['executeInTenantTransaction']>[0]>[0],
    applicationId: string,
    targetStartDate: Date,
    actorAccountId: string,
  ): Promise<
    | { status: 'CREATED'; progressId: string }
    | { status: 'EXISTS'; progressId: string }
    | { status: 'NO_CHECKLIST' }
    | { status: 'NO_APPLICATION' }
  > {
    void actorAccountId;
    const appRows = (await tx.$queryRawUnsafe(
      'SELECT school_id::text AS school_id FROM enr_applications WHERE id = $1::uuid',
      applicationId,
    )) as Array<{ school_id: string }>;
    if (appRows.length === 0) return { status: 'NO_APPLICATION' };
    const schoolId = appRows[0]!.school_id;

    const checklistRows = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id FROM enr_onboarding_checklists ' +
        "WHERE school_id = $1::uuid AND admission_type = 'STANDARD_INTAKE' AND is_active = true LIMIT 1",
      schoolId,
    )) as Array<{ id: string }>;
    if (checklistRows.length === 0) {
      return { status: 'NO_CHECKLIST' };
    }
    const checklistId = checklistRows[0]!.id;

    const existing = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id FROM enr_student_onboarding_progress WHERE application_id = $1::uuid AND checklist_id = $2::uuid',
      applicationId,
      checklistId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      return { status: 'EXISTS', progressId: existing[0]!.id };
    }

    const taskRows = (await tx.$queryRawUnsafe(
      'SELECT id::text AS id FROM enr_onboarding_tasks WHERE checklist_id = $1::uuid ORDER BY sort_order ASC',
      checklistId,
    )) as Array<{ id: string }>;
    const tasksTotal = taskRows.length;

    const newProgressId = generateId();
    await tx.$executeRawUnsafe(
      'INSERT INTO enr_student_onboarding_progress (id, application_id, checklist_id, started_date, target_start_date, overall_status, tasks_total, tasks_completed) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE, $4::date, 'IN_PROGRESS', $5, 0)",
      newProgressId,
      applicationId,
      checklistId,
      targetStartDate.toISOString().slice(0, 10),
      tasksTotal,
    );
    for (const t of taskRows) {
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_student_onboarding_task_completions (id, progress_id, task_id, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')",
        generateId(),
        newProgressId,
        t.id,
      );
    }
    return { status: 'CREATED', progressId: newProgressId };
  }

  async generateProgressForApplication(
    applicationId: string,
    targetStartDate: Date,
    actorAccountId: string,
  ): Promise<string | null> {
    let progressId: string | null = null;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await this.generateProgressForApplicationInTx(
        tx,
        applicationId,
        targetStartDate,
        actorAccountId,
      );
      if (result.status === 'CREATED' || result.status === 'EXISTS') {
        progressId = result.progressId;
      }
    });
    return progressId;
  }

  /**
   * Shared task-lifecycle helper used by both `completeTask()` and
   * `waiveTask()` per REVIEW-CYCLE16 BLOCKING 2. Both endpoints flow
   * through the same locking + recompute + auto-flip-to-COMPLETE +
   * emit pipeline so a waived mandatory task can also fire
   * `enr.student.onboarded` when it is the last gating task.
   * Mandatory tasks require status IN (COMPLETED, WAIVED) — see the
   * Step 3 schema for the matching exclusion in
   * `enr_student_onboarding_task_completions_open_idx`.
   */
  private async transitionTask(
    completionId: string,
    newStatus: 'COMPLETED' | 'WAIVED',
    notes: string | null,
    actor: ResolvedActor,
  ): Promise<{
    completion: TaskCompletionResponseDto;
    progress: StudentOnboardingProgressResponseDto;
    onboarded: boolean;
  }> {
    let onboarded = false;
    let progressIdResolved: string | null = null;
    let kafkaPayload: Record<string, unknown> | null = null as Record<string, unknown> | null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, progress_id::text AS progress_id, task_id::text AS task_id, status FROM enr_student_onboarding_task_completions WHERE id = $1::uuid FOR UPDATE',
        completionId,
      )) as Array<{ id: string; progress_id: string; task_id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Task completion not found');
      const currentStatus = lock[0]!.status;
      if (currentStatus === 'COMPLETED' || currentStatus === 'WAIVED') {
        throw new BadRequestException('Task is already in terminal state ' + currentStatus);
      }
      progressIdResolved = lock[0]!.progress_id;

      await tx.$executeRawUnsafe(
        'UPDATE enr_student_onboarding_task_completions SET status = $1, completed_by = $2::uuid, completed_at = now(), notes = $3, updated_at = now() WHERE id = $4::uuid',
        newStatus,
        actor.accountId,
        notes,
        completionId,
      );

      // Lock + bump progress counters
      const progressLock = (await tx.$queryRawUnsafe(
        'SELECT id, application_id::text AS application_id, checklist_id::text AS checklist_id, ' +
          'tasks_total, tasks_completed, overall_status FROM enr_student_onboarding_progress WHERE id = $1::uuid FOR UPDATE',
        progressIdResolved,
      )) as Array<{
        id: string;
        application_id: string;
        checklist_id: string;
        tasks_total: number;
        tasks_completed: number;
        overall_status: string;
      }>;
      if (progressLock.length === 0) throw new NotFoundException('Progress row not found');

      // Recompute completed count from actual rows so manual SQL or
      // out-of-order updates can never cause drift between counter
      // and underlying truth.
      const completedRows = (await tx.$queryRawUnsafe(
        "SELECT COUNT(*)::int AS c FROM enr_student_onboarding_task_completions WHERE progress_id = $1::uuid AND status IN ('COMPLETED','WAIVED')",
        progressIdResolved,
      )) as Array<{ c: number }>;
      const newCompleted = completedRows[0]!.c;

      // Check if every mandatory task is done. Mandatory tasks
      // require status IN (COMPLETED, WAIVED). Optional tasks count
      // toward tasks_completed but do not gate overall_status.
      const mandatoryPending = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS c FROM enr_student_onboarding_task_completions tc ' +
          'JOIN enr_onboarding_tasks t ON t.id = tc.task_id ' +
          "WHERE tc.progress_id = $1::uuid AND t.is_mandatory = true AND tc.status NOT IN ('COMPLETED','WAIVED')",
        progressIdResolved,
      )) as Array<{ c: number }>;
      const allMandatoryDone = mandatoryPending[0]!.c === 0;

      if (allMandatoryDone && progressLock[0]!.overall_status !== 'COMPLETE') {
        await tx.$executeRawUnsafe(
          "UPDATE enr_student_onboarding_progress SET tasks_completed = $1, overall_status = 'COMPLETE', completed_at = now(), updated_at = now() WHERE id = $2::uuid",
          newCompleted,
          progressIdResolved,
        );
        onboarded = true;
        const tenant = getCurrentTenant();
        kafkaPayload = {
          progressId: progressIdResolved,
          applicationId: progressLock[0]!.application_id,
          checklistId: progressLock[0]!.checklist_id,
          schoolId: tenant.schoolId,
          completedAt: new Date().toISOString(),
          completedBy: actor.accountId,
          tasksTotal: progressLock[0]!.tasks_total,
          tasksCompleted: newCompleted,
          sourceRefId: progressIdResolved,
        };
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE enr_student_onboarding_progress SET tasks_completed = $1, updated_at = now() WHERE id = $2::uuid',
          newCompleted,
          progressIdResolved,
        );
      }
    });

    // Emit AFTER tx commit. enr.student.onboarded is the Cycle 16
    // keystone signal — fires when the last mandatory onboarding task
    // lands (COMPLETED or WAIVED). Cycle 6's enr.student.enrolled
    // emit on offer-accept stays in place (PaymentAccountWorker
    // consumes it for the billing account allocation);
    // enr.student.onboarded is the cross-module trigger for
    // downstream consumers that should react only after the school
    // has actually completed the new-student onboarding checklist.
    if (kafkaPayload) {
      try {
        await this.kafka.emit({
          topic: 'enr.student.onboarded',
          key: kafkaPayload.applicationId as string,
          sourceModule: 'enrollment',
          payload: kafkaPayload,
        });
      } catch {
        // best-effort emit
      }
    }

    if (!progressIdResolved) throw new NotFoundException('Progress row not found');
    const completionRows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_TASK_COMPLETION + 'WHERE tc.id = $1::uuid',
        completionId,
      );
    })) as TaskCompletionRow[];
    return {
      completion: completionRowToDto(completionRows[0]!),
      progress: await this.getProgress(progressIdResolved, actor),
      onboarded,
    };
  }

  /**
   * Complete a task. Stamps completed_at + completed_by, bumps
   * progress.tasks_completed, and when the last mandatory task is
   * complete flips overall_status to COMPLETE atomically inside the
   * same tx and emits enr.student.onboarded AFTER tx commit. The
   * onboarded topic is the Cycle 16 cross-module signal; Cycle 6's
   * enr.student.enrolled stays untouched on offer-accept.
   */
  async completeTask(
    completionId: string,
    input: CompleteTaskDto,
    actor: ResolvedActor,
  ): Promise<{
    completion: TaskCompletionResponseDto;
    progress: StudentOnboardingProgressResponseDto;
    onboarded: boolean;
  }> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only Staff or admins can complete onboarding tasks');
    }
    return this.transitionTask(completionId, 'COMPLETED', input.notes ?? null, actor);
  }

  /**
   * Waive a task. Counts toward tasks_completed but flagged as
   * WAIVED in audit. Admin only. Reuses the same lifecycle path as
   * completeTask so that waiving the LAST mandatory task correctly
   * flips overall_status to COMPLETE and emits enr.student.onboarded
   * — REVIEW-CYCLE16 BLOCKING 2.
   */
  async waiveTask(
    completionId: string,
    input: CompleteTaskDto,
    actor: ResolvedActor,
  ): Promise<{
    completion: TaskCompletionResponseDto;
    progress: StudentOnboardingProgressResponseDto;
    onboarded: boolean;
  }> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can waive an onboarding task');
    }
    return this.transitionTask(completionId, 'WAIVED', input.notes ?? null, actor);
  }
}
