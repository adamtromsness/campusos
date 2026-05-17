import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { assertFinanceAdmin, assertFinanceReader, isUniqueViolation } from './access';
import type {
  BudgetCategory,
  CreateDepartmentalBudgetDto,
  DepartmentalBudgetDto,
  UpdateDepartmentalBudgetDto,
} from './dto/commerce.dto';

interface BudgetRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  department: string;
  budget_category: string;
  allocated_amount: string | number;
  committed_amount: string | number;
  spent_amount: string | number;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class DepartmentalBudgetService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  private toDto(row: BudgetRow): DepartmentalBudgetDto {
    const allocated = Number(row.allocated_amount);
    const committed = Number(row.committed_amount);
    const spent = Number(row.spent_amount);
    return {
      id: row.id,
      schoolId: row.school_id,
      academicYearId: row.academic_year_id,
      department: row.department,
      budgetCategory: row.budget_category as BudgetCategory,
      allocatedAmount: allocated,
      committedAmount: committed,
      spentAmount: spent,
      // available_amount is computed in service code, never trusted from the DB.
      // It can go negative on overspend, which the variance dashboard surfaces.
      availableAmount: Math.round((allocated - committed - spent) * 100) / 100,
      notes: row.notes,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(
    actor: ResolvedActor,
    filter: { academicYearId?: string; department?: string; category?: BudgetCategory },
  ): Promise<DepartmentalBudgetDto[]> {
    await assertFinanceReader(actor, this.permCheck, 'Departmental budget list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      const where: string[] = [];
      if (filter.academicYearId) {
        args.push(filter.academicYearId);
        where.push(`academic_year_id = $${args.length}::uuid`);
      }
      if (filter.department) {
        args.push(filter.department);
        where.push(`department = $${args.length}`);
      }
      if (filter.category) {
        args.push(filter.category);
        where.push(`budget_category = $${args.length}`);
      }
      const extra = where.length ? ' AND ' + where.join(' AND ') : '';
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                academic_year_id::text AS academic_year_id,
                department, budget_category,
                allocated_amount, committed_amount, spent_amount,
                notes, approved_by::text AS approved_by,
                approved_at::text AS approved_at,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM fin_departmental_budgets
          WHERE school_id = $1::uuid${extra}
          ORDER BY department, budget_category`,
        ...args,
      )) as BudgetRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<DepartmentalBudgetDto> {
    await assertFinanceReader(actor, this.permCheck, 'Departmental budget read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id,
                academic_year_id::text AS academic_year_id,
                department, budget_category,
                allocated_amount, committed_amount, spent_amount,
                notes, approved_by::text AS approved_by,
                approved_at::text AS approved_at,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM fin_departmental_budgets
          WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as BudgetRow[];
      if (rows.length === 0) throw new NotFoundException('Departmental budget not found');
      return this.toDto(rows[0]!);
    });
  }

  async create(
    actor: ResolvedActor,
    input: CreateDepartmentalBudgetDto,
  ): Promise<DepartmentalBudgetDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Create departmental budget');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Verify academic year is in current school.
      const year = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM sis_academic_years
          WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.academicYearId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (year.length === 0) {
        throw new BadRequestException(
          'academicYearId does not match an academic year in this school',
        );
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO fin_departmental_budgets
             (id, school_id, academic_year_id, department, budget_category,
              allocated_amount, notes, approved_by, approved_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, $8::uuid,
                   CASE WHEN $8::uuid IS NULL THEN NULL ELSE now() END)
           RETURNING id::text AS id, school_id::text AS school_id,
                     academic_year_id::text AS academic_year_id,
                     department, budget_category,
                     allocated_amount, committed_amount, spent_amount,
                     notes, approved_by::text AS approved_by,
                     approved_at::text AS approved_at,
                     created_at::text AS created_at, updated_at::text AS updated_at`,
          id,
          tenant.schoolId,
          input.academicYearId,
          input.department,
          input.budgetCategory,
          input.allocatedAmount,
          input.notes ?? null,
          actor.isSchoolAdmin ? (actor.employeeId ?? null) : null,
        )) as BudgetRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A budget for ${input.department} / ${input.budgetCategory} already exists for this academic year`,
          );
        }
        throw err;
      }
    });
  }

  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateDepartmentalBudgetDto,
  ): Promise<DepartmentalBudgetDto> {
    await assertFinanceAdmin(actor, this.permCheck, 'Update departmental budget');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_departmental_budgets
          WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (existing.length === 0) throw new NotFoundException('Departmental budget not found');

      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.allocatedAmount !== undefined) {
        sets.push(`allocated_amount = $${p}::numeric`);
        args.push(input.allocatedAmount);
        p++;
      }
      if (input.notes !== undefined) {
        sets.push(`notes = $${p}`);
        args.push(input.notes);
        p++;
      }
      if (sets.length === 0) {
        return this.getById(actor, id);
      }
      sets.push(`updated_at = now()`);
      args.push(tenant.schoolId, id);
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE fin_departmental_budgets
            SET ${sets.join(', ')}
          WHERE school_id = $${p}::uuid AND id = $${p + 1}::uuid
          RETURNING id::text AS id, school_id::text AS school_id,
                    academic_year_id::text AS academic_year_id,
                    department, budget_category,
                    allocated_amount, committed_amount, spent_amount,
                    notes, approved_by::text AS approved_by,
                    approved_at::text AS approved_at,
                    created_at::text AS created_at, updated_at::text AS updated_at`,
        ...args,
      )) as BudgetRow[];
      return this.toDto(rows[0]!);
    });
  }
}
