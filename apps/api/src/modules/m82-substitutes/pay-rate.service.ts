import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { generateId } from '@campusos/database';
import { AssignmentPayDto, CreatePayRateDto, PayRateResponseDto } from './dto/substitutes.dto';

const SCHOOL_DEFAULT_SUB_ID = '00000000-0000-0000-0000-000000000000';

interface PayRateRow {
  id: string;
  school_id: string;
  substitute_id: string;
  job_type: string;
  rate: string;
  rate_type: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
}

const SELECT_PAY_RATE_BASE = `
  SELECT id::text AS id,
         school_id::text AS school_id,
         substitute_id::text AS substitute_id,
         job_type,
         rate::text AS rate,
         rate_type,
         effective_from::text AS effective_from,
         effective_to::text AS effective_to,
         notes
  FROM sub_pay_rates
`;

/**
 * PayRateService — P2-9b Step 7.
 *
 * EXCLUDE-gist guarded — concurrent overlapping date ranges for the same
 * (school_id, substitute_id, job_type) tuple raise SQLSTATE 23P01 which
 * the service translates to 409 Conflict.
 *
 * computePay resolves the rate for a given assignment: per-substitute
 * row first, falling back to the SCHOOL_DEFAULT_SUB_ID sentinel row.
 */
@Injectable()
export class PayRateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'sub-002:write',
    ]);
  }

  async list(): Promise<PayRateResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PAY_RATE_BASE +
          ' WHERE school_id = $1::uuid ORDER BY substitute_id, job_type, effective_from DESC',
        tenant.schoolId,
      )) as PayRateRow[];
      return rows.map(this.rowToDto);
    });
  }

  async create(input: CreatePayRateDto, actor: ResolvedActor): Promise<PayRateResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can manage pay rates.');
    }
    if (input.rate < 0) {
      throw new BadRequestException('rate must be non-negative.');
    }
    if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
      throw new BadRequestException('effectiveTo must be on or after effectiveFrom.');
    }

    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO sub_pay_rates (id, school_id, substitute_id, job_type, rate, rate_type, effective_from, effective_to, notes)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date, $9)`,
          id,
          tenant.schoolId,
          input.substituteId ?? SCHOOL_DEFAULT_SUB_ID,
          input.jobType ?? 'FULL_DAY',
          input.rate,
          input.rateType ?? 'DAILY',
          input.effectiveFrom,
          input.effectiveTo ?? null,
          input.notes ?? null,
        );
      } catch (e) {
        if (String(e).includes('sub_pay_rates_no_overlap')) {
          throw new ConflictException(
            'Pay rate overlaps an existing date range for this (substitute, jobType). Close out the prior rate first by setting its effectiveTo.',
          );
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_PAY_RATE_BASE + ' WHERE id = $1::uuid',
        id,
      )) as PayRateRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async close(id: string, effectiveTo: string, actor: ResolvedActor): Promise<PayRateResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only school admins can close pay rates.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT id, effective_from FROM sub_pay_rates
         WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE`,
        id,
        tenant.schoolId,
      )) as Array<{ id: string; effective_from: Date }>;
      if (rows.length === 0) throw new NotFoundException('Pay rate not found');

      await tx.$executeRawUnsafe(
        `UPDATE sub_pay_rates SET effective_to = $1::date, updated_at = now() WHERE id = $2::uuid`,
        effectiveTo,
        id,
      );
      const fresh = (await tx.$queryRawUnsafe(
        SELECT_PAY_RATE_BASE + ' WHERE id = $1::uuid',
        id,
      )) as PayRateRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  /**
   * Compute pay for a given assignment. Per-substitute row first (matched
   * on substitute_id + job_type + a date range that covers job_date),
   * falling back to the SCHOOL_DEFAULT_SUB_ID sentinel row.
   */
  async computePay(assignmentId: string): Promise<AssignmentPayDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const asgRows = (await client.$queryRawUnsafe(
        `SELECT a.id::text AS id, a.substitute_id::text AS substitute_id,
                j.job_type, j.job_date::text AS job_date
         FROM sub_assignments a
         JOIN sub_job_postings j ON j.id = a.job_id
         WHERE a.id = $1::uuid AND j.school_id = $2::uuid`,
        assignmentId,
        tenant.schoolId,
      )) as Array<{ id: string; substitute_id: string; job_type: string; job_date: string }>;
      if (asgRows.length === 0) throw new NotFoundException('Assignment not found');
      const asg = asgRows[0]!;

      // Per-substitute first
      const perSubRows = (await client.$queryRawUnsafe(
        `${SELECT_PAY_RATE_BASE}
         WHERE school_id = $1::uuid
           AND substitute_id = $2::uuid
           AND job_type = $3
           AND effective_from <= $4::date
           AND (effective_to IS NULL OR effective_to >= $4::date)
         ORDER BY effective_from DESC LIMIT 1`,
        tenant.schoolId,
        asg.substitute_id,
        asg.job_type,
        asg.job_date,
      )) as PayRateRow[];

      if (perSubRows.length > 0) {
        const r = perSubRows[0]!;
        return {
          assignmentId,
          rate: r.rate,
          rateType: r.rate_type as AssignmentPayDto['rateType'],
          rateSource: 'PER_SUBSTITUTE',
          payRateId: r.id,
        };
      }

      // School default fallback
      const defaultRows = (await client.$queryRawUnsafe(
        `${SELECT_PAY_RATE_BASE}
         WHERE school_id = $1::uuid
           AND substitute_id = $2::uuid
           AND job_type = $3
           AND effective_from <= $4::date
           AND (effective_to IS NULL OR effective_to >= $4::date)
         ORDER BY effective_from DESC LIMIT 1`,
        tenant.schoolId,
        SCHOOL_DEFAULT_SUB_ID,
        asg.job_type,
        asg.job_date,
      )) as PayRateRow[];

      if (defaultRows.length === 0) {
        throw new NotFoundException(
          `No pay rate configured for jobType=${asg.job_type} on ${asg.job_date}. Configure a school-default rate first.`,
        );
      }

      const r = defaultRows[0]!;
      return {
        assignmentId,
        rate: r.rate,
        rateType: r.rate_type as AssignmentPayDto['rateType'],
        rateSource: 'SCHOOL_DEFAULT',
        payRateId: r.id,
      };
    });
  }

  private rowToDto = (r: PayRateRow): PayRateResponseDto => ({
    id: r.id,
    schoolId: r.school_id,
    substituteId: r.substitute_id,
    jobType: r.job_type as PayRateResponseDto['jobType'],
    rate: r.rate,
    rateType: r.rate_type as PayRateResponseDto['rateType'],
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    notes: r.notes,
  });
}
