import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { WorkflowEngineService } from '../workflows/workflow-engine.service';
import {
  LeaveBalanceDto,
  LeaveRequestResponseDto,
  LeaveTypeResponseDto,
  ListLeaveRequestsQueryDto,
  ReviewLeaveRequestDto,
  SubmitLeaveRequestDto,
} from './dto/leave.dto';

interface LeaveTypeRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  is_paid: boolean;
  accrual_rate: string;
  max_balance: string | null;
  is_active: boolean;
}

interface LeaveBalanceRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  leave_type_name: string;
  is_paid: boolean;
  academic_year_id: string;
  accrued: string;
  used: string;
  pending: string;
}

interface LeaveRequestRow {
  id: string;
  employee_id: string;
  employee_first_name: string;
  employee_last_name: string;
  leave_type_id: string;
  leave_type_name: string;
  start_date: string;
  end_date: string;
  days_requested: string;
  status: string;
  reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  cancelled_at: string | null;
  is_hr_initiated: boolean;
}

function leaveTypeRowToDto(r: LeaveTypeRow): LeaveTypeResponseDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isPaid: r.is_paid,
    accrualRate: Number(r.accrual_rate),
    maxBalance: r.max_balance === null ? null : Number(r.max_balance),
    isActive: r.is_active,
  };
}

function balanceRowToDto(r: LeaveBalanceRow): LeaveBalanceDto {
  var accrued = Number(r.accrued);
  var used = Number(r.used);
  var pending = Number(r.pending);
  return {
    leaveTypeId: r.leave_type_id,
    leaveTypeName: r.leave_type_name,
    isPaid: r.is_paid,
    accrued: accrued,
    used: used,
    pending: pending,
    available: Number((accrued - used - pending).toFixed(2)),
    academicYearId: r.academic_year_id,
  };
}

function requestRowToDto(r: LeaveRequestRow): LeaveRequestResponseDto {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_first_name + ' ' + r.employee_last_name,
    leaveTypeId: r.leave_type_id,
    leaveTypeName: r.leave_type_name,
    startDate: r.start_date,
    endDate: r.end_date,
    daysRequested: Number(r.days_requested),
    status: r.status as LeaveRequestResponseDto['status'],
    reason: r.reason,
    submittedAt: r.submitted_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: r.reviewed_by,
    reviewNotes: r.review_notes,
    cancelledAt: r.cancelled_at,
    isHrInitiated: r.is_hr_initiated,
  };
}

var SELECT_REQUEST_BASE =
  'SELECT lr.id, lr.employee_id, ip.first_name AS employee_first_name, ip.last_name AS employee_last_name, ' +
  'lr.leave_type_id, lt.name AS leave_type_name, ' +
  "TO_CHAR(lr.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(lr.end_date, 'YYYY-MM-DD') AS end_date, " +
  'lr.days_requested, lr.status, lr.reason, lr.submitted_at, lr.reviewed_at, lr.reviewed_by, lr.review_notes, lr.cancelled_at, lr.is_hr_initiated ' +
  'FROM hr_leave_requests lr ' +
  'JOIN hr_leave_types lt ON lt.id = lr.leave_type_id ' +
  'JOIN hr_employees e ON e.id = lr.employee_id ' +
  'JOIN platform.iam_person ip ON ip.id = e.person_id ';

@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly workflowEngine: WorkflowEngineService,
  ) {}

  async listLeaveTypes(): Promise<LeaveTypeResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LeaveTypeRow[]>(
        'SELECT id, school_id, name, description, is_paid, accrual_rate, max_balance, is_active ' +
          'FROM hr_leave_types WHERE is_active = true ORDER BY name',
      );
    });
    return rows.map(leaveTypeRowToDto);
  }

  /**
   * Per-employee balance read for the current academic year. Returns one
   * row per leave type — every type the school has configured, even if the
   * employee has no balance row yet (returns zeros for those types).
   */
  async listBalancesForEmployee(employeeId: string): Promise<LeaveBalanceDto[]> {
    var ayRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_academic_years WHERE is_current = true LIMIT 1',
      );
    });
    var academicYearId = ayRows[0]?.id ?? null;
    if (!academicYearId) {
      return [];
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LeaveBalanceRow[]>(
        'SELECT lt.id AS leave_type_id, lt.name AS leave_type_name, lt.is_paid, ' +
          '$2::uuid AS academic_year_id, COALESCE(b.accrued, 0)::text AS accrued, ' +
          'COALESCE(b.used, 0)::text AS used, COALESCE(b.pending, 0)::text AS pending, ' +
          "$1::uuid AS employee_id, '' AS id " +
          'FROM hr_leave_types lt ' +
          'LEFT JOIN hr_leave_balances b ON b.leave_type_id = lt.id AND b.employee_id = $1::uuid AND b.academic_year_id = $2::uuid ' +
          'WHERE lt.is_active = true ORDER BY lt.name',
        employeeId,
        academicYearId,
      );
    });
    return rows.map(balanceRowToDto);
  }

  /**
   * List requests. Non-admins are restricted to their own employee row;
   * admins see everything (filterable by status / employeeId).
   */
  async list(
    query: ListLeaveRequestsQueryDto,
    actor: ResolvedActor,
  ): Promise<LeaveRequestResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_REQUEST_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        if (!actor.employeeId) return [] as LeaveRequestRow[];
        sql += 'AND lr.employee_id = $' + idx + '::uuid ';
        params.push(actor.employeeId);
        idx++;
      } else if (query.employeeId) {
        sql += 'AND lr.employee_id = $' + idx + '::uuid ';
        params.push(query.employeeId);
        idx++;
      }
      if (query.status) {
        sql += 'AND lr.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      sql += 'ORDER BY lr.submitted_at DESC';
      return client.$queryRawUnsafe<LeaveRequestRow[]>(sql, ...params);
    });
    return rows.map(requestRowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<LeaveRequestResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LeaveRequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE lr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Leave request ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin && actor.employeeId !== row.employee_id) {
      throw new NotFoundException('Leave request ' + id + ' not found');
    }
    return requestRowToDto(row);
  }

  /**
   * Fetch a leave request by id without any actor scoping. Used by the
   * workflow engine consumer (Step 7) — by the time approval.request.resolved
   * fires, the workflow engine has already validated who was allowed to
   * approve, so the consumer just needs the row to apply the side effects.
   */
  private async loadByIdNoAuth(id: string): Promise<LeaveRequestResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<LeaveRequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE lr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Leave request ' + id + ' not found');
    return requestRowToDto(rows[0]!);
  }

  /**
   * Submit a new request. Bumps `pending` on the matching balance row
   * inside the same transaction; the non-negative CHECK on `pending`
   * never fires here (balance can only go up), but the dates and
   * days-requested CHECKs land naturally if the caller violates them.
   * Emits `hr.leave.requested`.
   */
  async submit(
    body: SubmitLeaveRequestDto,
    actor: ResolvedActor,
  ): Promise<LeaveRequestResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException('Only employees can submit leave requests');
    }
    if (new Date(body.endDate) < new Date(body.startDate)) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    if (body.daysRequested <= 0) {
      throw new BadRequestException('daysRequested must be > 0');
    }
    var typeRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM hr_leave_types WHERE id = $1::uuid AND is_active = true',
        body.leaveTypeId,
      );
    });
    if (typeRows.length === 0) {
      throw new NotFoundException('Leave type ' + body.leaveTypeId + ' not found');
    }
    var academicYearId: string = await this.requireCurrentAcademicYearId();

    var requestId = generateId();
    var employeeId: string = actor.employeeId;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await this.upsertBalance(tx, employeeId, body.leaveTypeId, academicYearId);
      await tx.$executeRawUnsafe(
        'UPDATE hr_leave_balances SET pending = pending + $1::numeric, updated_at = now() ' +
          'WHERE employee_id = $2::uuid AND leave_type_id = $3::uuid AND academic_year_id = $4::uuid',
        body.daysRequested.toFixed(1),
        employeeId,
        body.leaveTypeId,
        academicYearId,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days_requested, status, reason) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::numeric, 'PENDING', $7)",
        requestId,
        employeeId,
        body.leaveTypeId,
        body.startDate,
        body.endDate,
        body.daysRequested.toFixed(1),
        body.reason ?? null,
      );
    });

    var dto = await this.getById(requestId, actor);
    void this.kafka.emit({
      topic: 'hr.leave.requested',
      key: requestId,
      sourceModule: 'hr',
      payload: {
        requestId: requestId,
        employeeId: employeeId,
        accountId: actor.accountId,
        leaveTypeId: body.leaveTypeId,
        leaveTypeName: dto.leaveTypeName,
        startDate: body.startDate,
        endDate: body.endDate,
        daysRequested: body.daysRequested,
        reason: body.reason ?? null,
        status: 'PENDING',
      },
    });

    // Cycle 7 Step 7 — submit a parallel approval request through the
    // workflow engine. Schools without a LEAVE_REQUEST template fall
    // back gracefully to the direct PATCH /leave-requests/:id/approve
    // pattern; the engine throws BadRequest in that case and we log +
    // continue. When the template is configured (the seeded path), the
    // engine creates the wsk_approval_requests row, activates Step 1
    // with a resolved approver, and the LeaveApprovalConsumer applies
    // approveInternal/rejectInternal once approval.request.resolved
    // fires.
    try {
      await this.workflowEngine.submit(
        {
          requestType: 'LEAVE_REQUEST',
          referenceId: requestId,
          referenceTable: 'hr_leave_requests',
        },
        actor,
      );
    } catch (e: any) {
      var msg = e?.message || '';
      if (msg.indexOf('No active workflow template') >= 0) {
        this.logger.log(
          'No LEAVE_REQUEST workflow template configured for this school — falling back to the direct admin override path',
        );
      } else {
        // Don't let an engine bug fail the leave submission; the leave row
        // is committed and the direct admin path still works. Log loudly.
        this.logger.error(
          'WorkflowEngineService.submit failed for leave ' +
            requestId +
            ': ' +
            (e?.stack || e?.message || e),
        );
      }
    }
    return dto;
  }

  /**
   * Approve a PENDING request. Decrements `pending`, increments `used`.
   * Emits `hr.leave.approved`. Admin-only.
   *
   * Concurrency (REVIEW-CYCLE4 BLOCKING 1): the request row is locked with
   * SELECT ... FOR UPDATE inside the same transaction that writes the
   * balance + status. Two concurrent admin approve attempts serialise on
   * the row lock; the second one re-reads status='APPROVED' and 400s.
   */
  async approve(
    id: string,
    body: ReviewLeaveRequestDto,
    actor: ResolvedActor,
  ): Promise<LeaveRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can approve leave requests');
    }
    return this.approveInternal(id, body.reviewNotes ?? null, actor.accountId);
  }

  /**
   * Apply the approve side effects WITHOUT the admin gate. Used by both
   * the public approve() (after admin gate) and the LeaveApprovalConsumer
   * (after the workflow engine has resolved). Idempotent: re-applying on
   * an already-APPROVED row is rejected by lockAndValidate's status check.
   */
  async approveInternal(
    id: string,
    reviewNotes: string | null,
    reviewerAccountId: string,
  ): Promise<LeaveRequestResponseDto> {
    var academicYearId = await this.requireCurrentAcademicYearId();
    var locked = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var row = await this.lockAndValidate(tx, id, 'PENDING');
      await tx.$executeRawUnsafe(
        'UPDATE hr_leave_balances SET pending = pending - $1::numeric, used = used + $1::numeric, updated_at = now() ' +
          'WHERE employee_id = $2::uuid AND leave_type_id = $3::uuid AND academic_year_id = $4::uuid',
        row.days_requested,
        row.employee_id,
        row.leave_type_id,
        academicYearId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE hr_leave_requests SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $1::uuid, review_notes = $2, updated_at = now() WHERE id = $3::uuid",
        reviewerAccountId,
        reviewNotes,
        id,
      );
      return row;
    });
    var dto = await this.loadByIdNoAuth(id);
    void this.kafka.emit({
      topic: 'hr.leave.approved',
      key: id,
      sourceModule: 'hr',
      payload: {
        requestId: id,
        employeeId: locked.employee_id,
        accountId: locked.account_id,
        leaveTypeId: locked.leave_type_id,
        leaveTypeName: dto.leaveTypeName,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        reviewedBy: reviewerAccountId,
        reviewedAt: dto.reviewedAt,
        status: 'APPROVED',
      },
    });
    return dto;
  }

  async reject(
    id: string,
    body: ReviewLeaveRequestDto,
    actor: ResolvedActor,
  ): Promise<LeaveRequestResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can reject leave requests');
    }
    return this.rejectInternal(id, body.reviewNotes ?? null, actor.accountId);
  }

  /**
   * Apply the reject side effects WITHOUT the admin gate. Counterpart
   * to approveInternal — used by the LeaveApprovalConsumer.
   */
  async rejectInternal(
    id: string,
    reviewNotes: string | null,
    reviewerAccountId: string,
  ): Promise<LeaveRequestResponseDto> {
    var academicYearId = await this.requireCurrentAcademicYearId();
    var locked = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var row = await this.lockAndValidate(tx, id, 'PENDING');
      await tx.$executeRawUnsafe(
        'UPDATE hr_leave_balances SET pending = pending - $1::numeric, updated_at = now() ' +
          'WHERE employee_id = $2::uuid AND leave_type_id = $3::uuid AND academic_year_id = $4::uuid',
        row.days_requested,
        row.employee_id,
        row.leave_type_id,
        academicYearId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE hr_leave_requests SET status = 'REJECTED', reviewed_at = now(), reviewed_by = $1::uuid, review_notes = $2, updated_at = now() WHERE id = $3::uuid",
        reviewerAccountId,
        reviewNotes,
        id,
      );
      return row;
    });
    var dto = await this.loadByIdNoAuth(id);
    void this.kafka.emit({
      topic: 'hr.leave.rejected',
      key: id,
      sourceModule: 'hr',
      payload: {
        requestId: id,
        employeeId: locked.employee_id,
        accountId: locked.account_id,
        leaveTypeId: locked.leave_type_id,
        leaveTypeName: dto.leaveTypeName,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        reviewedBy: reviewerAccountId,
        reviewNotes: reviewNotes,
        status: 'REJECTED',
      },
    });
    return dto;
  }

  /**
   * Cancel an own request. PENDING → reverse `pending`. APPROVED → reverse
   * `used`. Anything else → 400. Owners and admins can cancel.
   *
   * Concurrency (REVIEW-CYCLE4 BLOCKING 1): the request row is locked with
   * SELECT ... FOR UPDATE inside the transaction; the previous status is
   * read from the locked row, not from a stale read taken before the tx.
   * A double-cancel race serialises and the second call sees the
   * already-CANCELLED status and 400s.
   */
  async cancel(id: string, actor: ResolvedActor): Promise<LeaveRequestResponseDto> {
    // Cheap pre-flight ownership check outside the tx so a non-owner
    // doesn't acquire a row lock just to be told to go away.
    var preflight = await this.loadForReview(id, null);
    if (!actor.isSchoolAdmin && actor.employeeId !== preflight.employee_id) {
      throw new ForbiddenException(
        'Only the owning employee or an admin can cancel this leave request',
      );
    }
    return this.cancelInternal(id, actor.accountId);
  }

  /**
   * Apply cancel side effects WITHOUT the ownership gate. Used by both
   * the public cancel() (after admin/owner check) and the
   * LeaveApprovalConsumer when the workflow engine emits
   * approval.request.resolved with status=WITHDRAWN — the requester
   * pulled the approval back, the leave row should follow.
   */
  async cancelInternal(
    id: string,
    cancellerAccountId: string,
  ): Promise<LeaveRequestResponseDto> {
    var academicYearId = await this.requireCurrentAcademicYearId();
    var locked = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var row = await this.lockAndValidate(tx, id, null);
      if (row.status === 'REJECTED' || row.status === 'CANCELLED') {
        throw new BadRequestException('Request is already ' + row.status);
      }
      var balanceColumn = row.status === 'APPROVED' ? 'used' : 'pending';
      await tx.$executeRawUnsafe(
        'UPDATE hr_leave_balances SET ' +
          balanceColumn +
          ' = ' +
          balanceColumn +
          ' - $1::numeric, updated_at = now() ' +
          'WHERE employee_id = $2::uuid AND leave_type_id = $3::uuid AND academic_year_id = $4::uuid',
        row.days_requested,
        row.employee_id,
        row.leave_type_id,
        academicYearId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE hr_leave_requests SET status = 'CANCELLED', cancelled_at = now(), updated_at = now() WHERE id = $1::uuid",
        id,
      );
      return row;
    });
    var dto = await this.loadByIdNoAuth(id);
    void this.kafka.emit({
      topic: 'hr.leave.cancelled',
      key: id,
      sourceModule: 'hr',
      payload: {
        requestId: id,
        employeeId: locked.employee_id,
        accountId: locked.account_id,
        leaveTypeId: locked.leave_type_id,
        leaveTypeName: dto.leaveTypeName,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested: dto.daysRequested,
        previousStatus: locked.status,
        cancelledBy: cancellerAccountId,
        status: 'CANCELLED',
      },
    });
    return dto;
  }

  /**
   * Locks the leave-request row with SELECT FOR UPDATE inside the caller's
   * transaction, then validates status. The lock blocks any concurrent
   * approve/reject/cancel on the same row from reading inconsistent state.
   *
   * `requireStatus=null` returns whatever status is on the row; the caller
   * is responsible for rejecting invalid transitions. `requireStatus='PENDING'`
   * returns the row only if it's still PENDING — used by approve/reject.
   */
  private async lockAndValidate(
    tx: any,
    id: string,
    requireStatus: string | null,
  ): Promise<{
    id: string;
    employee_id: string;
    account_id: string;
    leave_type_id: string;
    days_requested: string;
    status: string;
  }> {
    var rows = (await tx.$queryRawUnsafe(
      'SELECT lr.id, lr.employee_id, e.account_id::text AS account_id, lr.leave_type_id, lr.days_requested::text, lr.status ' +
        'FROM hr_leave_requests lr ' +
        'JOIN hr_employees e ON e.id = lr.employee_id ' +
        'WHERE lr.id = $1::uuid ' +
        'FOR UPDATE OF lr',
      id,
    )) as Array<{
      id: string;
      employee_id: string;
      account_id: string;
      leave_type_id: string;
      days_requested: string;
      status: string;
    }>;
    if (rows.length === 0) {
      throw new NotFoundException('Leave request ' + id + ' not found');
    }
    var row = rows[0]!;
    if (requireStatus && row.status !== requireStatus) {
      throw new BadRequestException(
        'Leave request ' + id + ' is in status ' + row.status + '; expected ' + requireStatus,
      );
    }
    return row;
  }

  private async upsertBalance(
    tx: any,
    employeeId: string,
    leaveTypeId: string,
    academicYearId: string,
  ): Promise<void> {
    var existing = (await tx.$queryRawUnsafe(
      'SELECT id FROM hr_leave_balances WHERE employee_id = $1::uuid AND leave_type_id = $2::uuid AND academic_year_id = $3::uuid',
      employeeId,
      leaveTypeId,
      academicYearId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return;
    var typeRows = (await tx.$queryRawUnsafe(
      'SELECT accrual_rate FROM hr_leave_types WHERE id = $1::uuid',
      leaveTypeId,
    )) as Array<{ accrual_rate: string }>;
    var accrual = typeRows[0]?.accrual_rate ?? '0';
    await tx.$executeRawUnsafe(
      'INSERT INTO hr_leave_balances (id, employee_id, leave_type_id, academic_year_id, accrued, used, pending) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, 0, 0)',
      generateId(),
      employeeId,
      leaveTypeId,
      academicYearId,
      accrual,
    );
  }

  private async loadForReview(
    id: string,
    requireStatus: string | null,
  ): Promise<{
    id: string;
    employee_id: string;
    account_id: string;
    leave_type_id: string;
    days_requested: string;
    status: string;
  }> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          id: string;
          employee_id: string;
          account_id: string;
          leave_type_id: string;
          days_requested: string;
          status: string;
        }>
      >(
        'SELECT lr.id, lr.employee_id, e.account_id::text AS account_id, lr.leave_type_id, lr.days_requested::text, lr.status ' +
          'FROM hr_leave_requests lr ' +
          'JOIN hr_employees e ON e.id = lr.employee_id ' +
          'WHERE lr.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Leave request ' + id + ' not found');
    if (requireStatus && rows[0]!.status !== requireStatus) {
      throw new BadRequestException(
        'Leave request ' + id + ' is in status ' + rows[0]!.status + '; expected ' + requireStatus,
      );
    }
    return rows[0]!;
  }

  private async requireCurrentAcademicYearId(): Promise<string> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id FROM sis_academic_years WHERE is_current = true LIMIT 1',
      );
    });
    var id = rows[0]?.id;
    if (!id) {
      throw new BadRequestException(
        'No current academic year — leave operations are unavailable until one is configured.',
      );
    }
    return id;
  }
}
