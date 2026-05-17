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
  CreateJobPostingDto,
  JobPostingDto,
  ListJobPostingsQueryDto,
  POSTING_STATUSES,
  PostingStatus,
  UpdateJobPostingDto,
} from './dto/recruitment.dto';

interface JobPostingRow {
  id: string;
  school_id: string;
  position_title: string;
  department: string | null;
  description: string;
  qualifications_required: string | null;
  salary_range_low: string | null;
  salary_range_high: string | null;
  employment_type: string;
  application_deadline: string | null;
  status: string;
  posted_at: string | null;
  closed_at: string | null;
  application_count: number;
  created_at: string;
}

const SELECT_POSTING_BASE =
  'SELECT p.id::text AS id, p.school_id::text AS school_id, p.position_title, p.department, ' +
  '       p.description, p.qualifications_required, ' +
  '       p.salary_range_low::text AS salary_range_low, ' +
  '       p.salary_range_high::text AS salary_range_high, ' +
  '       p.employment_type, ' +
  '       p.application_deadline::text AS application_deadline, ' +
  '       p.status, p.posted_at::text AS posted_at, p.closed_at::text AS closed_at, ' +
  '       COALESCE(ac.application_count, 0)::int AS application_count, ' +
  '       p.created_at::text AS created_at ' +
  'FROM hr_job_postings p ' +
  'LEFT JOIN ( ' +
  '  SELECT posting_id, COUNT(*)::int AS application_count ' +
  '  FROM hr_applications GROUP BY posting_id ' +
  ') ac ON ac.posting_id = p.id ';

/**
 * Job posting CRUD + lifecycle. Emits `hr.job.posted` durably via
 * OutboxService.enqueueInTx whenever status flips to LIVE so the
 * Cycle 14 Communications fan-out (and any future job-alert
 * worker) can route the event without depending on best-effort
 * Kafka delivery.
 *
 * Status lifecycle:
 *   DRAFT -> LIVE (skip APPROVAL for the demo; full DH approval
 *                  workflow is a Phase 2 polish that mirrors Cycle 7
 *                  workflows)
 *   LIVE  -> CLOSED (deadline reached, position filled, etc.)
 *   any   -> CANCELLED (admin abandons the requisition)
 *
 * Permission gate: REVIEW-P2-4b BLOCKING #1 — admin reads / writes
 * gated on the new `hr-011` Recruitment Administration code (held
 * only by School Admin / Platform Admin via everyFunction); the
 * candidate-facing paths and public job-board stay on @Public().
 * Generic Staff (VP / counsellor / admin assistant) no longer
 * sees the recruitment admin pipeline by default.
 */
@Injectable()
export class JobPostingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  async list(args: ListJobPostingsQueryDto): Promise<JobPostingDto[]> {
    const tenant = getCurrentTenant();
    const params: unknown[] = [tenant.schoolId];
    let where = 'WHERE p.school_id = $1::uuid';
    if (args.status) {
      params.push(args.status);
      where += ' AND p.status = $' + params.length;
    }
    if (args.department) {
      params.push(args.department);
      where += ' AND p.department = $' + params.length;
    }
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POSTING_BASE + where + ' ORDER BY p.created_at DESC',
        ...params,
      )) as JobPostingRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  /**
   * Public LIVE-only listing — no tenant-scoped controller gate.
   * The school must resolve via the public-resolver path or the
   * caller passes schoolId as a query param. This implementation
   * relies on getCurrentTenant() because the controller mounts
   * under the standard tenant-resolved router; the @Public() flag
   * keeps the auth guard out but tenant context is still set.
   */
  async listPublicLive(): Promise<JobPostingDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POSTING_BASE +
          "WHERE p.school_id = $1::uuid AND p.status = 'LIVE' " +
          'ORDER BY p.posted_at DESC',
        tenant.schoolId,
      )) as JobPostingRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(id: string): Promise<JobPostingDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POSTING_BASE + 'WHERE p.school_id = $1::uuid AND p.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as JobPostingRow[];
      if (rows.length === 0) throw new NotFoundException('Job posting not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async create(input: CreateJobPostingDto, actor: ResolvedActor): Promise<JobPostingDto> {
    await this.assertAdmin(actor);
    if (
      input.salaryRangeLow !== undefined &&
      input.salaryRangeHigh !== undefined &&
      input.salaryRangeHigh < input.salaryRangeLow
    ) {
      throw new BadRequestException('salaryRangeHigh must be >= salaryRangeLow.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_job_postings ' +
          '(id, school_id, position_title, department, description, qualifications_required, ' +
          ' salary_range_low, salary_range_high, employment_type, application_deadline, ' +
          ' status, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::date, 'DRAFT', $11::uuid)",
        id,
        tenant.schoolId,
        input.positionTitle,
        input.department ?? null,
        input.description,
        input.qualificationsRequired ?? null,
        input.salaryRangeLow ?? null,
        input.salaryRangeHigh ?? null,
        input.employmentType,
        input.applicationDeadline ?? null,
        actor.accountId,
      );
      return this.getById(id);
    });
  }

  async patch(
    id: string,
    input: UpdateJobPostingDto,
    actor: ResolvedActor,
  ): Promise<JobPostingDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, status FROM hr_job_postings ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string }>;
      if (lock.length === 0) throw new NotFoundException('Job posting not found');
      const cur = lock[0]!.status as PostingStatus;

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };

      if (input.positionTitle !== undefined) push('position_title', input.positionTitle);
      if (input.department !== undefined) push('department', input.department);
      if (input.description !== undefined) push('description', input.description);
      if (input.qualificationsRequired !== undefined)
        push('qualifications_required', input.qualificationsRequired);
      if (input.salaryRangeLow !== undefined) push('salary_range_low', input.salaryRangeLow);
      if (input.salaryRangeHigh !== undefined) push('salary_range_high', input.salaryRangeHigh);
      if (input.employmentType !== undefined) push('employment_type', input.employmentType);
      if (input.applicationDeadline !== undefined)
        push('application_deadline', input.applicationDeadline);

      let willEmitJobPosted = false;
      if (input.status !== undefined && input.status !== cur) {
        const target = input.status;
        if (!POSTING_STATUSES.includes(target)) {
          throw new BadRequestException('Invalid status target ' + target);
        }
        // Lifecycle guard: terminal CLOSED / CANCELLED stay.
        if (cur === 'CLOSED' || cur === 'CANCELLED') {
          throw new BadRequestException('Cannot transition out of terminal status ' + cur + '.');
        }
        // DRAFT / PENDING_APPROVAL / APPROVED -> LIVE stamps posted_at.
        push('status', target);
        if (target === 'LIVE') {
          sets.push('posted_at = now()');
          willEmitJobPosted = true;
        } else if (target === 'CLOSED' || target === 'CANCELLED') {
          sets.push('closed_at = now()');
          // CLOSED reached from a non-LIVE state still needs posted_at
          // populated so the lockstep CHECK passes. We set it
          // unconditionally; idempotent in practice.
          if (cur !== 'LIVE') sets.push('posted_at = COALESCE(posted_at, now())');
        }
      }

      if (sets.length === 0) return this.getById(id);
      sets.push('updated_at = now()');
      values.push(tenant.schoolId, id);
      await tx.$executeRawUnsafe(
        'UPDATE hr_job_postings SET ' +
          sets.join(', ') +
          ' WHERE school_id = $' +
          n +
          '::uuid AND id = $' +
          (n + 1) +
          '::uuid',
        ...values,
      );

      // REVIEW-P2-4b BLOCKING #4 — re-read the post-flip state via
      // the SAME tx client (not the public getById which opens its
      // own tenant context) so the outbox payload is built from
      // transaction-local state. The previous implementation could
      // see uncommitted-or-stale rows depending on isolation, and
      // the unit tests didn't catch it because the in-memory fake
      // shared a single client across `tx` and `tenantPrisma`.
      const txRows = (await tx.$queryRawUnsafe(
        SELECT_POSTING_BASE + 'WHERE p.school_id = $1::uuid AND p.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as JobPostingRow[];
      const dto = this.rowToDto(txRows[0]!);
      if (willEmitJobPosted) {
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'hr.job.posted',
          key: dto.id,
          sourceModule: 'hr-recruitment',
          payload: {
            postingId: dto.id,
            schoolId: dto.schoolId,
            positionTitle: dto.positionTitle,
            department: dto.department,
            employmentType: dto.employmentType,
            salaryRangeLow: dto.salaryRangeLow,
            salaryRangeHigh: dto.salaryRangeHigh,
            applicationDeadline: dto.applicationDeadline,
            postedAt: dto.postedAt,
          },
        });
      }
      return dto;
    });
  }

  // Internal helper used by ApplicationService to confirm the posting
  // is open for new applications.
  async loadOpenForApply(postingId: string): Promise<JobPostingRow> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_POSTING_BASE +
          "WHERE p.school_id = $1::uuid AND p.id = $2::uuid AND p.status = 'LIVE' LIMIT 1",
        tenant.schoolId,
        postingId,
      )) as JobPostingRow[];
      if (rows.length === 0) {
        throw new BadRequestException('Posting not found or not currently accepting applications.');
      }
      return rows[0]!;
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    // REVIEW-P2-4b BLOCKING #1 — service-layer admin check on
    // hr-011 (Recruitment Administration), not hr-002. Generic
    // Staff no longer holds hr-011, so VPs / counsellors /
    // admin assistants who previously fell through this guard
    // now correctly 403 unless they hold hr-011.
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-011:admin',
      'hr-011:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Recruitment administration requires hr-011 or school admin.');
    }
  }

  private rowToDto(r: JobPostingRow): JobPostingDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      positionTitle: r.position_title,
      department: r.department,
      description: r.description,
      qualificationsRequired: r.qualifications_required,
      salaryRangeLow: r.salary_range_low === null ? null : Number(r.salary_range_low),
      salaryRangeHigh: r.salary_range_high === null ? null : Number(r.salary_range_high),
      employmentType: r.employment_type as JobPostingDto['employmentType'],
      applicationDeadline: r.application_deadline,
      status: r.status as PostingStatus,
      postedAt: r.posted_at,
      closedAt: r.closed_at,
      applicationCount: r.application_count,
      createdAt: r.created_at,
    };
  }
}
