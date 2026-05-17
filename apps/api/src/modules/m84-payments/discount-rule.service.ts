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
import {
  CalculationMethod,
  CreateDiscountRuleDto,
  DiscountRuleResponseDto,
  DiscountType,
  ListDiscountRulesQueryDto,
  UpdateDiscountRuleDto,
} from './dto/discount-rule.dto';

interface DiscountRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  discount_type: string;
  calculation_method: string;
  value: string;
  applies_to_fee_category_id: string | null;
  category_name: string | null;
  sibling_order: number | null;
  minimum_invoice_amount: string | null;
  academic_year_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE =
  'SELECT r.id, r.school_id, r.name, r.description, r.discount_type, r.calculation_method, ' +
  'r.value::text, r.applies_to_fee_category_id, c.name AS category_name, r.sibling_order, ' +
  'r.minimum_invoice_amount::text, r.academic_year_id, r.is_active, r.created_at, r.updated_at ' +
  'FROM pay_discount_rules r LEFT JOIN pay_fee_categories c ON c.id = r.applies_to_fee_category_id ';

function rowToDto(r: DiscountRow): DiscountRuleResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    discountType: r.discount_type as DiscountType,
    calculationMethod: r.calculation_method as CalculationMethod,
    value: Number(r.value),
    appliesToFeeCategoryId: r.applies_to_fee_category_id,
    appliesToFeeCategoryName: r.category_name,
    siblingOrder: r.sibling_order,
    minimumInvoiceAmount:
      r.minimum_invoice_amount === null ? null : Number(r.minimum_invoice_amount),
    academicYearId: r.academic_year_id,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class DiscountRuleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(
    query: ListDiscountRulesQueryDto,
    actor: ResolvedActor,
  ): Promise<DiscountRuleResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can list discount rules');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      let sql = SELECT_BASE + 'WHERE 1=1 ';
      const params: unknown[] = [];
      let idx = 1;
      if (!query.includeInactive) sql += 'AND r.is_active = true ';
      if (query.discountType) {
        sql += 'AND r.discount_type = $' + idx + ' ';
        params.push(query.discountType);
        idx++;
      }
      sql += 'ORDER BY r.discount_type, r.name';
      return client.$queryRawUnsafe<DiscountRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<DiscountRuleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can read discount rules');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<DiscountRow[]>(SELECT_BASE + 'WHERE r.id = $1::uuid', id),
    );
    if (rows.length === 0) throw new NotFoundException('Discount rule ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async create(
    body: CreateDiscountRuleDto,
    actor: ResolvedActor,
  ): Promise<DiscountRuleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create discount rules');
    }
    if (body.discountType === 'SIBLING' && !body.siblingOrder) {
      throw new BadRequestException('siblingOrder is required for SIBLING discount type');
    }
    if (body.discountType !== 'SIBLING' && body.siblingOrder !== undefined) {
      throw new BadRequestException('siblingOrder is only valid for SIBLING discount type');
    }
    const id = generateId();
    const schoolId = getCurrentTenant().schoolId;
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO pay_discount_rules ' +
            '(id, school_id, name, description, discount_type, calculation_method, value, applies_to_fee_category_id, sibling_order, minimum_invoice_amount, academic_year_id, is_active, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12, $13::uuid)',
          id,
          schoolId,
          body.name,
          body.description ?? null,
          body.discountType,
          body.calculationMethod,
          body.value.toFixed(2),
          body.appliesToFeeCategoryId ?? null,
          body.siblingOrder ?? null,
          body.minimumInvoiceAmount === undefined ? null : body.minimumInvoiceAmount.toFixed(2),
          body.academicYearId ?? null,
          body.isActive ?? true,
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'A discount rule with name "' + body.name + '" already exists',
          );
        }
        throw err;
      }
    });
    return this.getById(id, actor);
  }

  async update(
    id: string,
    body: UpdateDiscountRuleDto,
    actor: ResolvedActor,
  ): Promise<DiscountRuleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update discount rules');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (body.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(body.name);
      idx++;
    }
    if (body.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(body.description);
      idx++;
    }
    if (body.value !== undefined) {
      sets.push('value = $' + idx + '::numeric');
      params.push(body.value.toFixed(2));
      idx++;
    }
    if (body.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(body.isActive);
      idx++;
    }
    if (body.minimumInvoiceAmount !== undefined) {
      sets.push('minimum_invoice_amount = $' + idx + '::numeric');
      params.push(body.minimumInvoiceAmount.toFixed(2));
      idx++;
    }
    if (sets.length === 0) return this.getById(id, actor);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE pay_discount_rules SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Discount rule ' + id + ' not found');
    });
    return this.getById(id, actor);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  return (
    e.code === 'P2002' ||
    e.meta?.code === '23505' ||
    (typeof e.message === 'string' && /23505|unique constraint/i.test(e.message))
  );
}
