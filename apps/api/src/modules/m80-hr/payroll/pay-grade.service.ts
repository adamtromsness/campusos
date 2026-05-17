import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreatePayGradeDto,
  CreateSalaryScaleDto,
  PayGradeDto,
  SalaryScaleDto,
  UpdatePayGradeDto,
  UpdateSalaryScaleDto,
} from './dto/payroll.dto';

interface PayGradeRow {
  id: string;
  school_id: string;
  grade_name: string;
  description: string | null;
  min_salary: string | null;
  max_salary: string | null;
  is_active: boolean;
}

interface SalaryScaleRow {
  id: string;
  pay_grade_id: string;
  step: number;
  annual_salary: string;
  notes: string | null;
}

const SELECT_GRADE_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, grade_name, description, ' +
  '       min_salary::text AS min_salary, max_salary::text AS max_salary, is_active ' +
  'FROM hr_pay_grades ';

const SELECT_SCALE_BASE =
  'SELECT id::text AS id, pay_grade_id::text AS pay_grade_id, step, ' +
  '       annual_salary::text AS annual_salary, notes ' +
  'FROM hr_salary_scales ';

@Injectable()
export class PayGradeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive = false): Promise<PayGradeDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive ? '' : ' AND is_active = true';
      const grades = (await client.$queryRawUnsafe(
        SELECT_GRADE_BASE + 'WHERE school_id = $1::uuid' + where + ' ORDER BY grade_name',
        tenant.schoolId,
      )) as PayGradeRow[];
      if (grades.length === 0) return [];
      const scales = (await client.$queryRawUnsafe(
        SELECT_SCALE_BASE + 'WHERE pay_grade_id = ANY($1::uuid[]) ORDER BY pay_grade_id, step',
        grades.map((g) => g.id),
      )) as SalaryScaleRow[];
      const byGrade = new Map<string, SalaryScaleDto[]>();
      for (const s of scales) {
        if (!byGrade.has(s.pay_grade_id)) byGrade.set(s.pay_grade_id, []);
        byGrade.get(s.pay_grade_id)!.push(this.scaleRowToDto(s));
      }
      return grades.map((g) => this.gradeRowToDto(g, byGrade.get(g.id) ?? []));
    });
  }

  async getById(id: string): Promise<PayGradeDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const grades = (await client.$queryRawUnsafe(
        SELECT_GRADE_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as PayGradeRow[];
      if (grades.length === 0) throw new NotFoundException('Pay grade not found');
      const scales = (await client.$queryRawUnsafe(
        SELECT_SCALE_BASE + 'WHERE pay_grade_id = $1::uuid ORDER BY step',
        id,
      )) as SalaryScaleRow[];
      return this.gradeRowToDto(
        grades[0]!,
        scales.map((s) => this.scaleRowToDto(s)),
      );
    });
  }

  async create(input: CreatePayGradeDto, actor: ResolvedActor): Promise<PayGradeDto> {
    await this.assertAdmin(actor);
    if (
      input.minSalary !== undefined &&
      input.maxSalary !== undefined &&
      input.maxSalary < input.minSalary
    ) {
      throw new BadRequestException('maxSalary must be >= minSalary');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_pay_grades (id, school_id, grade_name, description, min_salary, max_salary) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
          id,
          tenant.schoolId,
          input.gradeName,
          input.description ?? null,
          input.minSalary ?? null,
          input.maxSalary ?? null,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            'A pay grade with this name already exists in this school.',
          );
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_GRADE_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as PayGradeRow[];
      return this.gradeRowToDto(rows[0]!, []);
    });
  }

  async patch(id: string, input: UpdatePayGradeDto, actor: ResolvedActor): Promise<PayGradeDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const sets: string[] = [];
    const values: unknown[] = [];
    let n = 1;
    const push = (col: string, value: unknown) => {
      sets.push(col + ' = $' + n);
      values.push(value);
      n += 1;
    };
    if (input.gradeName !== undefined) push('grade_name', input.gradeName);
    if (input.description !== undefined) push('description', input.description);
    if (input.minSalary !== undefined) push('min_salary', input.minSalary);
    if (input.maxSalary !== undefined) push('max_salary', input.maxSalary);
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    values.push(tenant.schoolId, id);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'UPDATE hr_pay_grades SET ' +
            sets.join(', ') +
            ' WHERE school_id = $' +
            (n + 0) +
            '::uuid AND id = $' +
            (n + 1) +
            '::uuid',
          ...values,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            'A pay grade with this name already exists in this school.',
          );
        }
        throw e;
      }
      return this.getById(id);
    });
  }

  async listScales(payGradeId: string): Promise<SalaryScaleDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const grade = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_pay_grades WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        payGradeId,
      )) as Array<{ id: string }>;
      if (grade.length === 0) throw new NotFoundException('Pay grade not found');
      const rows = (await client.$queryRawUnsafe(
        SELECT_SCALE_BASE + 'WHERE pay_grade_id = $1::uuid ORDER BY step',
        payGradeId,
      )) as SalaryScaleRow[];
      return rows.map((r) => this.scaleRowToDto(r));
    });
  }

  async addScale(
    payGradeId: string,
    input: CreateSalaryScaleDto,
    actor: ResolvedActor,
  ): Promise<SalaryScaleDto> {
    await this.assertAdmin(actor);
    await this.getById(payGradeId);
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_salary_scales (id, pay_grade_id, step, annual_salary, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          payGradeId,
          input.step,
          input.annualSalary,
          input.notes ?? null,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException(
            'Step ' + input.step + ' already exists for this pay grade.',
          );
        }
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        SELECT_SCALE_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as SalaryScaleRow[];
      return this.scaleRowToDto(rows[0]!);
    });
  }

  async patchScale(
    scaleId: string,
    input: UpdateSalaryScaleDto,
    actor: ResolvedActor,
  ): Promise<SalaryScaleDto> {
    await this.assertAdmin(actor);
    const sets: string[] = [];
    const values: unknown[] = [];
    let n = 1;
    const push = (col: string, value: unknown) => {
      sets.push(col + ' = $' + n);
      values.push(value);
      n += 1;
    };
    if (input.step !== undefined) push('step', input.step);
    if (input.annualSalary !== undefined) push('annual_salary', input.annualSalary);
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return this.loadScaleOrFail(scaleId);
    sets.push('updated_at = now()');
    values.push(scaleId);
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'UPDATE hr_salary_scales SET ' + sets.join(', ') + ' WHERE id = $' + n + '::uuid',
          ...values,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('Step number already exists for this pay grade.');
        }
        throw e;
      }
      return this.loadScaleOrFail(scaleId);
    });
  }

  /**
   * Public lookup — used by PayrollService to resolve a salary scale's
   * annual_salary when computing gross pay. Returns the row tied to the
   * caller's tenant via the parent pay grade's school_id.
   */
  async loadScaleForCompute(
    scaleId: string,
  ): Promise<{ id: string; payGradeId: string; step: number; annualSalary: number } | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.pay_grade_id::text AS pay_grade_id, ' +
          '       s.step, s.annual_salary::text AS annual_salary ' +
          'FROM hr_salary_scales s ' +
          'JOIN hr_pay_grades g ON g.id = s.pay_grade_id ' +
          'WHERE g.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        scaleId,
      )) as Array<{ id: string; pay_grade_id: string; step: number; annual_salary: string }>;
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: r.id,
        payGradeId: r.pay_grade_id,
        step: r.step,
        annualSalary: Number(r.annual_salary),
      };
    });
  }

  // ---------- helpers ------------------------------------------------------

  private async loadScaleOrFail(scaleId: string): Promise<SalaryScaleDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT s.id::text AS id, s.pay_grade_id::text AS pay_grade_id, ' +
          '       s.step, s.annual_salary::text AS annual_salary, s.notes ' +
          'FROM hr_salary_scales s ' +
          'JOIN hr_pay_grades g ON g.id = s.pay_grade_id ' +
          'WHERE g.school_id = $1::uuid AND s.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        scaleId,
      )) as SalaryScaleRow[];
      if (rows.length === 0) throw new NotFoundException('Salary scale not found');
      return this.scaleRowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    // REVIEW-P2-4a BLOCKING #3 — moved off hr-003 to hr-010.
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-010:admin',
      'hr-010:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Pay grade configuration requires hr-010:admin or school admin.',
      );
    }
  }

  private gradeRowToDto(r: PayGradeRow, scales: SalaryScaleDto[]): PayGradeDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      gradeName: r.grade_name,
      description: r.description,
      minSalary: r.min_salary === null ? null : Number(r.min_salary),
      maxSalary: r.max_salary === null ? null : Number(r.max_salary),
      isActive: r.is_active,
      scales,
    };
  }

  private scaleRowToDto(r: SalaryScaleRow): SalaryScaleDto {
    return {
      id: r.id,
      payGradeId: r.pay_grade_id,
      step: r.step,
      annualSalary: Number(r.annual_salary),
      notes: r.notes,
    };
  }

  private isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2010' && err.meta?.code === '23505') return true;
    if (typeof err.message === 'string' && /unique/i.test(err.message)) return true;
    return false;
  }
}
