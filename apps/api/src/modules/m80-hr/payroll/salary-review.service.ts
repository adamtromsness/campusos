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
import {
  CreateSalaryReviewDto,
  ListSalaryReviewsQueryDto,
  SALARY_REVIEW_STATUSES,
  SALARY_REVIEW_TYPES,
  SalaryReviewDto,
  SalaryReviewStatus,
  SalaryReviewType,
  UpdateSalaryReviewDto,
} from './dto/payroll.dto';

interface SalaryReviewRow {
  id: string;
  school_id: string;
  employee_id: string;
  employee_first: string | null;
  employee_last: string | null;
  requested_by: string;
  requestor_first: string | null;
  requestor_last: string | null;
  review_type: string;
  current_salary: string | null;
  recommended_salary: string | null;
  effective_date: string | null;
  justification: string;
  status: string;
  decision_notes: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const SELECT_REVIEW_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, ' +
  '       r.employee_id::text AS employee_id, ep.first_name AS employee_first, ep.last_name AS employee_last, ' +
  '       r.requested_by::text AS requested_by, rp.first_name AS requestor_first, rp.last_name AS requestor_last, ' +
  '       r.review_type, r.current_salary::text AS current_salary, r.recommended_salary::text AS recommended_salary, ' +
  '       r.effective_date::text AS effective_date, r.justification, r.status, r.decision_notes, ' +
  '       r.decided_by::text AS decided_by, r.decided_at::text AS decided_at, r.created_at::text AS created_at ' +
  'FROM hr_salary_review_requests r ' +
  'JOIN hr_employees re ON re.id = r.employee_id ' +
  'LEFT JOIN platform.iam_person ep ON ep.id = re.person_id ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = r.requested_by ';

@Injectable()
export class SalaryReviewService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(args: ListSalaryReviewsQueryDto, actor: ResolvedActor): Promise<SalaryReviewDto[]> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE r.school_id = $1::uuid';
    if (!isAdmin) {
      // Non-admin view: requester sees own submissions; employee sees
      // own reviews only (their salary is being reviewed). The two
      // filters OR together.
      const ids: string[] = [];
      if (actor.personId) ids.push(actor.personId);
      if (actor.employeeId) ids.push(actor.employeeId);
      if (ids.length === 0) return [];
      params.push(actor.personId ?? null);
      params.push(actor.employeeId ?? null);
      where +=
        ' AND (r.requested_by = $' +
        (params.length - 1) +
        '::uuid OR r.employee_id = $' +
        params.length +
        '::uuid)';
    }
    if (args.status) {
      params.push(args.status);
      where += ' AND r.status = $' + params.length;
    }
    if (args.employeeId) {
      params.push(args.employeeId);
      where += ' AND r.employee_id = $' + params.length + '::uuid';
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REVIEW_BASE + where + ' ORDER BY r.created_at DESC',
        ...params,
      )) as SalaryReviewRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<SalaryReviewDto> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_REVIEW_BASE + 'WHERE r.school_id = $1::uuid AND r.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as SalaryReviewRow[];
      if (rows.length === 0) throw new NotFoundException('Salary review not found');
      const row = rows[0]!;
      if (!isAdmin) {
        const ownsAsRequester = row.requested_by === actor.personId;
        const ownsAsEmployee = row.employee_id === actor.employeeId;
        if (!ownsAsRequester && !ownsAsEmployee) {
          throw new NotFoundException('Salary review not found');
        }
      }
      return this.rowToDto(row);
    });
  }

  async create(input: CreateSalaryReviewDto, actor: ResolvedActor): Promise<SalaryReviewDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Salary reviews can only be submitted by named users.');
    }
    if (!SALARY_REVIEW_TYPES.includes(input.reviewType)) {
      throw new BadRequestException('Invalid reviewType.');
    }
    if (
      input.recommendedSalary !== undefined &&
      input.currentSalary !== undefined &&
      input.recommendedSalary < 0
    ) {
      throw new BadRequestException('recommendedSalary must be >= 0.');
    }
    const tenant = getCurrentTenant();
    // Verify employee exists in this school.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_employees WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.employeeId,
      )) as Array<{ id: string }>;
      if (rows.length === 0) {
        throw new BadRequestException('employeeId does not belong to this school.');
      }
    });
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_salary_review_requests ' +
          '(id, school_id, employee_id, requested_by, review_type, current_salary, recommended_salary, ' +
          ' effective_date, justification, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::date, $9, 'SUBMITTED')",
        id,
        tenant.schoolId,
        input.employeeId,
        actor.personId,
        input.reviewType,
        input.currentSalary ?? null,
        input.recommendedSalary ?? null,
        input.effectiveDate ?? null,
        input.justification,
      );
    });
    // Re-read AFTER commit so the row is visible to a sibling tx
    // (calling getById inside the outer tx opens a nested tenant
    // context that can't see uncommitted rows).
    return this.getById(id, actor);
  }

  async patch(
    id: string,
    input: UpdateSalaryReviewDto,
    actor: ResolvedActor,
  ): Promise<SalaryReviewDto> {
    const tenant = getCurrentTenant();
    const isAdmin = await this.isAdmin(actor);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status, requested_by::text AS requested_by FROM hr_salary_review_requests ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string; requested_by: string }>;
      if (lock.length === 0) throw new NotFoundException('Salary review not found');
      const cur = lock[0]!.status as SalaryReviewStatus;
      if (cur === 'APPROVED' || cur === 'REJECTED') {
        throw new BadRequestException(
          'Salary reviews are immutable once decided. Submit a new request instead.',
        );
      }
      // Status transitions: requester can WITHDRAW own pending. Admin
      // can flip to UNDER_REVIEW / APPROVED / REJECTED.
      if (input.status !== undefined) {
        if (!SALARY_REVIEW_STATUSES.includes(input.status)) {
          throw new BadRequestException('Invalid status.');
        }
        if (input.status === 'WITHDRAWN') {
          if (lock[0]!.requested_by !== actor.personId && !isAdmin) {
            throw new ForbiddenException('Only the requester or an admin can withdraw.');
          }
        } else if (!isAdmin) {
          throw new ForbiddenException('Only an admin can transition this status.');
        }
        if (input.status === 'APPROVED' || input.status === 'REJECTED') {
          if (!actor.personId) {
            throw new ForbiddenException('Decision must be recorded under a named admin.');
          }
        }
      } else if (!isAdmin && lock[0]!.requested_by !== actor.personId) {
        throw new ForbiddenException('Only the requester or an admin can edit this review.');
      }
      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.justification !== undefined) push('justification', input.justification);
      if (input.recommendedSalary !== undefined)
        push('recommended_salary', input.recommendedSalary);
      if (input.decisionNotes !== undefined) push('decision_notes', input.decisionNotes);
      if (input.status !== undefined) {
        push('status', input.status);
        if (input.status === 'APPROVED' || input.status === 'REJECTED') {
          // Postgres won't auto-cast text → uuid; without the explicit
          // cast the UPDATE raises 42804.
          sets.push('decided_by = $' + n + '::uuid');
          values.push(actor.personId);
          n += 1;
          sets.push('decided_at = now()');
        }
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        'UPDATE hr_salary_review_requests SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          n +
          '::uuid AND id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );
    });
    // Re-read AFTER commit (see createPeriod fix).
    return this.getById(id, actor);
  }

  /**
   * Salary review admin scope. REVIEW-P2-4a BLOCKING #3 — payroll
   * decision authority belongs to hr-010 (Payroll Management) not
   * hr-003 (Leave Management). Holders of hr-010:admin or
   * hr-010:write — Staff payroll operator + School Admin — can
   * decide on submitted reviews; the requester (any hr-003:write
   * holder) can still submit + withdraw their own.
   */
  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-010:admin',
      'hr-010:write',
    ]);
  }

  private rowToDto(r: SalaryReviewRow): SalaryReviewDto {
    const employeeName =
      r.employee_first || r.employee_last
        ? [r.employee_first, r.employee_last].filter(Boolean).join(' ')
        : null;
    const requestorName =
      r.requestor_first || r.requestor_last
        ? [r.requestor_first, r.requestor_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      schoolId: r.school_id,
      employeeId: r.employee_id,
      employeeName,
      requestedBy: r.requested_by,
      requestedByName: requestorName,
      reviewType: r.review_type as SalaryReviewType,
      currentSalary: r.current_salary === null ? null : Number(r.current_salary),
      recommendedSalary: r.recommended_salary === null ? null : Number(r.recommended_salary),
      effectiveDate: r.effective_date,
      justification: r.justification,
      status: r.status as SalaryReviewStatus,
      decisionNotes: r.decision_notes,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      createdAt: r.created_at,
    };
  }
}
