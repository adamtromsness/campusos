import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { OutboxService } from '@shared/kafka';
import {
  CancelWithdrawalDto,
  CompleteWithdrawalDto,
  CreateWithdrawalDto,
  ExitTaskResponseDto,
  PlaceReenrolHoldDto,
  WithdrawalResponseDto,
} from './dto/withdrawal.dto';
import { ExitTaskTemplateService } from './exit-task-template.service';

/**
 * The minimal shape of an open tenant tx — just the two raw exec
 * methods. Lets ReenrolmentService pass its own open tx into
 * WithdrawalService.createInTx without dragging the full
 * PrismaClient typing across services.
 */
export interface TenantTx {
  $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
  $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
}

interface WithdrawalRow {
  id: string;
  school_id: string;
  student_id: string;
  initiated_by: string;
  requested_by: string;
  requested_by_first_name: string | null;
  requested_by_last_name: string | null;
  withdrawal_reason_category: string;
  withdrawal_reason_detail: string | null;
  last_attendance_date: string;
  requested_at: string;
  destination_school_name: string | null;
  destination_school_country: string | null;
  records_release_consented: boolean;
  records_sent_at: string | null;
  status: string;
  completed_at: string | null;
  completed_by: string | null;
  completed_by_first_name: string | null;
  completed_by_last_name: string | null;
  re_enrollment_hold_placed: boolean;
  re_enrollment_hold_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  student_first_name: string | null;
  student_last_name: string | null;
}

interface ExitTaskRow {
  id: string;
  withdrawal_id: string;
  task_name: string;
  task_category: string;
  status: string;
  completed_by: string | null;
  completed_by_first_name: string | null;
  completed_by_last_name: string | null;
  completed_at: string | null;
  notes: string | null;
  sort_order: number;
}

const SELECT_WITHDRAWAL_BASE =
  'SELECT w.id, w.school_id, w.student_id, w.initiated_by, w.requested_by, ' +
  '       rp.first_name AS requested_by_first_name, rp.last_name AS requested_by_last_name, ' +
  '       w.withdrawal_reason_category, w.withdrawal_reason_detail, ' +
  '       w.last_attendance_date::text AS last_attendance_date, ' +
  '       w.requested_at::text AS requested_at, ' +
  '       w.destination_school_name, w.destination_school_country, ' +
  '       w.records_release_consented, w.records_sent_at::text AS records_sent_at, ' +
  '       w.status, w.completed_at::text AS completed_at, ' +
  '       w.completed_by, ' +
  '       cp.first_name AS completed_by_first_name, cp.last_name AS completed_by_last_name, ' +
  '       w.re_enrollment_hold_placed, w.re_enrollment_hold_reason, w.notes, ' +
  '       w.created_at::text AS created_at, w.updated_at::text AS updated_at, ' +
  '       sp.first_name AS student_first_name, sp.last_name AS student_last_name ' +
  'FROM enr_withdrawal_requests w ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = w.requested_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = w.completed_by ' +
  'LEFT JOIN sis_students s ON s.id = w.student_id ' +
  'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person sp ON sp.id = ps.person_id ';

function toFullName(f: string | null, l: string | null): string | null {
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(' ');
}

function withdrawalRowToDto(r: WithdrawalRow, tasks: ExitTaskRow[]): WithdrawalResponseDto {
  const exitTasks = tasks.map(
    (t): ExitTaskResponseDto => ({
      id: t.id,
      withdrawalId: t.withdrawal_id,
      taskName: t.task_name,
      taskCategory: t.task_category as ExitTaskResponseDto['taskCategory'],
      status: t.status as ExitTaskResponseDto['status'],
      completedBy: t.completed_by,
      completedByName: toFullName(t.completed_by_first_name, t.completed_by_last_name),
      completedAt: t.completed_at,
      notes: t.notes,
      sortOrder: t.sort_order,
    }),
  );
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    initiatedBy: r.initiated_by as WithdrawalResponseDto['initiatedBy'],
    requestedBy: r.requested_by,
    requestedByName: toFullName(r.requested_by_first_name, r.requested_by_last_name),
    withdrawalReasonCategory:
      r.withdrawal_reason_category as WithdrawalResponseDto['withdrawalReasonCategory'],
    withdrawalReasonDetail: r.withdrawal_reason_detail,
    lastAttendanceDate: r.last_attendance_date,
    requestedAt: r.requested_at,
    destinationSchoolName: r.destination_school_name,
    destinationSchoolCountry: r.destination_school_country,
    recordsReleaseConsented: r.records_release_consented,
    recordsSentAt: r.records_sent_at,
    status: r.status as WithdrawalResponseDto['status'],
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    completedByName: toFullName(r.completed_by_first_name, r.completed_by_last_name),
    reEnrollmentHoldPlaced: r.re_enrollment_hold_placed,
    reEnrollmentHoldReason: r.re_enrollment_hold_reason,
    notes: r.notes,
    exitTasks,
    exitTaskSummary: {
      pending: exitTasks.filter((t) => t.status === 'PENDING').length,
      completed: exitTasks.filter((t) => t.status === 'COMPLETED').length,
      waived: exitTasks.filter((t) => t.status === 'WAIVED').length,
      notApplicable: exitTasks.filter((t) => t.status === 'NOT_APPLICABLE').length,
      total: exitTasks.length,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface WithdrawalCreateInternalInput extends CreateWithdrawalDto {
  // Allow other services (ReenrolmentService) to seed the requested_by
  // id explicitly when the originating actor isn't the resolved caller.
  requestedBy?: string;
  notes?: string;
}

/**
 * WithdrawalService — withdrawal request lifecycle.
 *
 * Authorisation contract:
 *   - list / getById — admin (stu-004:admin or sch-001:admin) sees
 *     every withdrawal. Parents see withdrawals for own children
 *     resolved via sis_student_guardians. STAFF without admin tier
 *     see every withdrawal — they're EO / department staff.
 *   - create — parent with stu-004:write OR admin OR EO. Parent
 *     row scope binds to own children via sis_student_guardians;
 *     a parent cannot initiate a withdrawal for someone else's
 *     child. Admins + EO bypass the row scope.
 *   - complete — admin only. Refuses unless every exit task is
 *     COMPLETED or WAIVED. NOT_APPLICABLE counts as resolved too.
 *     On success: flips sis_students.enrollment_status to WITHDRAWN
 *     and emits enr.student.withdrawn AFTER tx commits.
 *   - cancel — admin or original requester (REQUESTED status only).
 *   - placeReenrolHold — admin only.
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
    private readonly templates: ExitTaskTemplateService,
  ) {}

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:admin',
    ]);
  }

  private async hasWriteScope(actor: ResolvedActor): Promise<boolean> {
    if (await this.hasAdminScope(actor)) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
    ]);
  }

  /**
   * REVIEW-P2-5 BLOCKING 3 — "operator scope" replaces the old
   * `actor.personType === 'STAFF'` shortcut. An operator is a
   * school admin OR a STAFF actor who explicitly holds STU-004
   * (i.e. Enrolment Officer / Vice Principal — both granted
   * STU-004 admin via their specialist role specs). Generic Staff
   * (counsellor, librarian, custodial, etc.) does NOT pass this
   * check and so cannot list every school-wide withdrawal /
   * initiate withdrawal for arbitrary students.
   */
  private async hasOperatorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
      'stu-004:admin',
    ]);
  }

  private async assertGuardianOfStudent(actor: ResolvedActor, studentId: string): Promise<void> {
    if (await this.hasOperatorScope(actor)) return;
    if (actor.personType !== 'GUARDIAN') {
      throw new ForbiddenException('Only guardians, EO, or admins can initiate a withdrawal.');
    }
    const tenant = getCurrentTenant();
    const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 ' +
          'FROM sis_students s ' +
          'JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE s.school_id = $1::uuid AND s.id = $2::uuid AND g.person_id = $3::uuid LIMIT 1',
        tenant.schoolId,
        studentId,
        actor.personId,
      )) as Array<unknown>;
      return rows.length > 0;
    });
    if (!ok) {
      throw new ForbiddenException(
        'You can only initiate a withdrawal for a student linked to your guardian record.',
      );
    }
  }

  async list(actor: ResolvedActor, statusFilter?: string): Promise<WithdrawalResponseDto[]> {
    const tenant = getCurrentTenant();
    // REVIEW-P2-5 BLOCKING 3 — only operators (admin OR EO/VP) see
    // school-wide; everyone else is row-scoped to own children
    // (parent) or returns an empty list (other STAFF without
    // STU-004 grant).
    const operator = await this.hasOperatorScope(actor);

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = 'w.school_id = $1::uuid ';
      if (!operator) {
        // Parent — bind to own children via guardian link.
        args.push(actor.personId);
        where +=
          '  AND w.student_id IN ( ' +
          '    SELECT s.id FROM sis_students s ' +
          '    JOIN sis_student_guardians sg ON sg.student_id = s.id ' +
          '    JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          '    WHERE g.person_id = $' +
          args.length +
          '::uuid ' +
          '  ) ';
      }
      if (statusFilter) {
        args.push(statusFilter);
        where += '  AND w.status = $' + args.length + ' ';
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_WITHDRAWAL_BASE + 'WHERE ' + where + 'ORDER BY w.requested_at DESC LIMIT 500',
        ...args,
      )) as WithdrawalRow[];
      const ids = rows.map((r) => r.id);
      const tasks = await this.loadTasks(client, ids);
      return rows.map((r) =>
        withdrawalRowToDto(
          r,
          tasks.filter((t) => t.withdrawal_id === r.id),
        ),
      );
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<WithdrawalResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_WITHDRAWAL_BASE + 'WHERE w.school_id = $1::uuid AND w.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as WithdrawalRow[];
      if (rows.length === 0) throw new NotFoundException('Withdrawal not found');
      const row = rows[0] as WithdrawalRow;
      const operator = await this.hasOperatorScope(actor);
      if (!operator) {
        // Parent row-scope on the student. Non-operator non-guardian
        // (e.g. generic STAFF without STU-004) gets the same
        // collapsed 404 — don't-leak-existence.
        const ok = (await client.$queryRawUnsafe(
          'SELECT 1 FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          row.student_id,
          actor.personId,
        )) as Array<unknown>;
        if (ok.length === 0) throw new NotFoundException('Withdrawal not found');
      }
      const tasks = await this.loadTasks(client, [id]);
      return withdrawalRowToDto(row, tasks);
    });
  }

  private async loadTasks(
    client: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    withdrawalIds: string[],
  ): Promise<ExitTaskRow[]> {
    if (withdrawalIds.length === 0) return [];
    return (await client.$queryRawUnsafe(
      'SELECT t.id, t.withdrawal_id, t.task_name, t.task_category, t.status, ' +
        '       t.completed_by, p.first_name AS completed_by_first_name, p.last_name AS completed_by_last_name, ' +
        '       t.completed_at::text AS completed_at, t.notes, t.sort_order ' +
        'FROM enr_withdrawal_exit_tasks t ' +
        'LEFT JOIN platform.iam_person p ON p.id = t.completed_by ' +
        'WHERE t.withdrawal_id = ANY($1::uuid[]) ORDER BY t.sort_order, t.created_at',
      withdrawalIds,
    )) as ExitTaskRow[];
  }

  async create(
    input: WithdrawalCreateInternalInput,
    actor: ResolvedActor,
  ): Promise<WithdrawalResponseDto> {
    if (!(await this.hasWriteScope(actor))) {
      throw new ForbiddenException('Initiating a withdrawal requires stu-004:write');
    }
    await this.assertGuardianOfStudent(actor, input.studentId);

    const id = await this.tenantPrisma.executeInTenantTransaction(async (tx) =>
      this.createInTx(tx as never, input, actor),
    );
    return this.getById(id, actor);
  }

  /**
   * Internal-only helper used by both WithdrawalService.create AND
   * ReenrolmentService.submit (the auto-withdrawal path).
   *
   * REVIEW-P2-5 BLOCKING 2 fix: ReenrolmentService now passes its
   * own open `tx` so the auto-initiated withdrawal + the
   * confirmation INSERT are atomic — if the confirmation hits the
   * UNIQUE(student, year) collision, the withdrawal + its exit
   * tasks roll back together. Previously WithdrawalService.create
   * opened its own tx and committed before the confirmation row
   * landed, leaking orphan withdrawals on the duplicate path.
   *
   * Caller must:
   *   - Have already verified actor scope (assertWriter / assertAdmin).
   *   - Have already verified guardian-of-student for non-admin actors.
   *   - Pass an open tenant tx (search_path scoped to the calling
   *     tenant schema).
   *
   * Returns the new withdrawal id. The caller is responsible for
   * the post-tx getById / DTO shape if it needs the response.
   */
  async createInTx(
    tx: TenantTx,
    input: WithdrawalCreateInternalInput,
    actor: ResolvedActor,
  ): Promise<string> {
    const tenant = getCurrentTenant();
    const requestedBy = input.requestedBy ?? actor.personId;
    const id = generateId();

    // Resolve template tasks BEFORE the tx writes so a missing
    // default template returns a friendly 400 cleanly. Lazy-seed
    // happens here for fresh tenants.
    const templateTasks = await this.templates.listActive(tenant.schoolId, 'DEFAULT', actor);
    if (templateTasks.length === 0) {
      throw new BadRequestException(
        'No active withdrawal task template configured for this school. Configure the DEFAULT template before initiating withdrawals.',
      );
    }

    // Validate the student belongs to this school.
    const studentRows = (await tx.$queryRawUnsafe(
      'SELECT id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
      tenant.schoolId,
      input.studentId,
    )) as Array<{ id: string }>;
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }

    await tx.$executeRawUnsafe(
      'INSERT INTO enr_withdrawal_requests ' +
        '(id, school_id, student_id, initiated_by, requested_by, withdrawal_reason_category, ' +
        ' withdrawal_reason_detail, last_attendance_date, destination_school_name, ' +
        ' destination_school_country, records_release_consented, status, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, $8::date, $9, $10, $11, 'REQUESTED', $12)",
      id,
      tenant.schoolId,
      input.studentId,
      input.initiatedBy,
      requestedBy,
      input.withdrawalReasonCategory,
      input.withdrawalReasonDetail ?? null,
      input.lastAttendanceDate,
      input.destinationSchoolName ?? null,
      input.destinationSchoolCountry ?? null,
      input.recordsReleaseConsented ?? false,
      input.notes ?? null,
    );

    // Auto-create exit tasks from the template.
    for (const t of templateTasks) {
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_withdrawal_exit_tasks ' +
          '(id, withdrawal_id, task_name, task_category, status, sort_order) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING', $5)",
        generateId(),
        id,
        t.taskName,
        t.taskCategory,
        t.sortOrder,
      );
    }

    return id;
  }

  /**
   * Complete a withdrawal — admin only, and only when every exit
   * task is in a terminal state (COMPLETED, WAIVED, or NOT_APPLICABLE).
   * On success: flip sis_students.enrollment_status to WITHDRAWN and
   * emit enr.student.withdrawn AFTER the tx commits.
   */
  async complete(
    id: string,
    input: CompleteWithdrawalDto,
    actor: ResolvedActor,
  ): Promise<WithdrawalResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Completing a withdrawal requires stu-004:admin');
    }
    const tenant = getCurrentTenant();

    const emitPayload = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id, student_id, status FROM enr_withdrawal_requests ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; student_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Withdrawal not found');
      const row = rows[0]!;
      if (row.status === 'COMPLETED') {
        throw new BadRequestException('Withdrawal is already COMPLETED');
      }
      if (row.status === 'CANCELLED') {
        throw new BadRequestException('Cannot complete a CANCELLED withdrawal');
      }

      const taskRows = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS pending FROM enr_withdrawal_exit_tasks ' +
          "WHERE withdrawal_id = $1::uuid AND status = 'PENDING'",
        id,
      )) as Array<{ pending: number }>;
      const pendingCount = taskRows[0]!.pending;
      if (pendingCount > 0) {
        throw new BadRequestException(
          'Cannot complete withdrawal — ' +
            pendingCount +
            ' exit task(s) still PENDING. Mark each task COMPLETED, WAIVED, or NOT_APPLICABLE first.',
        );
      }

      await tx.$executeRawUnsafe(
        "UPDATE enr_withdrawal_requests SET status = 'COMPLETED', completed_at = now(), " +
          'completed_by = $1::uuid, notes = COALESCE($2, notes), updated_at = now() ' +
          'WHERE id = $3::uuid',
        actor.personId,
        input.notes ?? null,
        id,
      );

      // REVIEW-P2-5 MAJOR 5 — school_id-scoped UPDATE for the
      // hardening-by-default convention. The withdrawal row above
      // is already locked + school-scoped; this is defence in
      // depth against any future code path that might pass an
      // attacker-supplied student_id directly.
      await tx.$executeRawUnsafe(
        "UPDATE sis_students SET enrollment_status = 'WITHDRAWN', updated_at = now() " +
          'WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        row.student_id,
      );

      await this.outbox.enqueueInTx(tx as never, {
        topic: 'enr.student.withdrawn',
        key: id,
        sourceModule: 'enrolment-advanced',
        payload: {
          withdrawalId: id,
          studentId: row.student_id,
          schoolId: tenant.schoolId,
          completedBy: actor.personId,
          completedAt: new Date().toISOString(),
        },
      });

      return { ok: true };
    });

    // emitPayload is unused but referenced to keep tx return shape.
    void emitPayload;
    return this.getById(id, actor);
  }

  async cancel(
    id: string,
    input: CancelWithdrawalDto,
    actor: ResolvedActor,
  ): Promise<WithdrawalResponseDto> {
    const tenant = getCurrentTenant();
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new BadRequestException('reason is required to cancel a withdrawal');
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id, requested_by, status FROM enr_withdrawal_requests ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; requested_by: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Withdrawal not found');
      const row = rows[0]!;
      const isAdmin = await this.hasAdminScope(actor);
      const isOwner = row.requested_by === actor.personId;
      if (!isAdmin && !isOwner) {
        throw new ForbiddenException('Only admins or the original requester can cancel.');
      }
      if (row.status === 'COMPLETED') {
        throw new BadRequestException('Cannot cancel a COMPLETED withdrawal');
      }
      if (row.status === 'CANCELLED') {
        throw new BadRequestException('Withdrawal is already CANCELLED');
      }

      await tx.$executeRawUnsafe(
        "UPDATE enr_withdrawal_requests SET status = 'CANCELLED', " +
          "notes = COALESCE(notes, '') || E'\\n[cancelled] ' || $1, updated_at = now() " +
          'WHERE id = $2::uuid',
        reason,
        id,
      );
    });

    return this.getById(id, actor);
  }

  async placeReenrolHold(
    id: string,
    input: PlaceReenrolHoldDto,
    actor: ResolvedActor,
  ): Promise<WithdrawalResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Placing a re-enrolment hold requires stu-004:admin');
    }
    const tenant = getCurrentTenant();
    if (input.hold) {
      const reason = (input.reason ?? '').trim();
      if (reason.length === 0) {
        throw new BadRequestException(
          'reason is required when placing a re-enrolment hold (hold_chk schema invariant).',
        );
      }
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_withdrawal_requests WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (rows.length === 0) throw new NotFoundException('Withdrawal not found');

      if (input.hold) {
        await tx.$executeRawUnsafe(
          'UPDATE enr_withdrawal_requests SET re_enrollment_hold_placed = true, ' +
            're_enrollment_hold_reason = $1, updated_at = now() WHERE id = $2::uuid',
          input.reason,
          id,
        );
      } else {
        await tx.$executeRawUnsafe(
          'UPDATE enr_withdrawal_requests SET re_enrollment_hold_placed = false, ' +
            're_enrollment_hold_reason = NULL, updated_at = now() WHERE id = $1::uuid',
          id,
        );
      }
    });
    return this.getById(id, actor);
  }

  /** Public helper used by ReenrolmentService to check holds. */
  async hasActiveHoldForStudent(studentId: string): Promise<boolean> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 FROM enr_withdrawal_requests ' +
          'WHERE school_id = $1::uuid AND student_id = $2::uuid ' +
          '  AND re_enrollment_hold_placed = true LIMIT 1',
        tenant.schoolId,
        studentId,
      )) as Array<unknown>;
      return rows.length > 0;
    });
  }

  // REVIEW-P2-5 BLOCKING 2 — the previous `createInternal` opened
  // its own tenant tx which broke atomicity for ReenrolmentService.
  // Callers that need an in-tx withdrawal create now call
  // createInTx(tx, ...) directly. The public surface keeps `create`
  // for the controller path.
}
