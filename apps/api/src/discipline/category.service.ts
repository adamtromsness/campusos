import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import {
  CategoryResponseDto,
  CreateCategoryDto,
  Severity,
  UpdateCategoryDto,
} from './dto/discipline.dto';

interface CategoryRow {
  id: string;
  school_id: string;
  name: string;
  severity: string;
  description: string | null;
  is_active: boolean;
}

const SELECT_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, name, severity, description, is_active ' +
  'FROM sis_discipline_categories ';

function rowToDto(r: CategoryRow): CategoryResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    severity: r.severity as Severity,
    description: r.description,
    isActive: r.is_active,
  };
}

@Injectable()
export class CategoryService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(includeInactive: boolean): Promise<CategoryResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE +
          (includeInactive ? '' : 'WHERE is_active = true ') +
          // Severity sort: CRITICAL first so the admin queue surfaces the
          // most serious categories at the top, then alphabetical within
          // each tier. Postgres CASE is stable for tied alphabeticals.
          "ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, name",
      )) as CategoryRow[];
      return rows.map(rowToDto);
    });
  }

  async getById(id: string): Promise<CategoryResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE id = $1::uuid',
        id,
      )) as CategoryRow[];
      if (rows.length === 0) throw new NotFoundException('Category ' + id);
      return rowToDto(rows[0]!);
    });
  }

  async create(input: CreateCategoryDto): Promise<CategoryResponseDto> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO sis_discipline_categories (id, school_id, name, severity, description) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
          id,
          tenant.schoolId,
          input.name,
          input.severity,
          input.description ?? null,
        );
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('A category with this name already exists');
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  async update(id: string, input: UpdateCategoryDto): Promise<CategoryResponseDto> {
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push('name = $' + idx);
      params.push(input.name);
      idx++;
    }
    if (input.severity !== undefined) {
      sets.push('severity = $' + idx);
      params.push(input.severity);
      idx++;
    }
    if (input.description !== undefined) {
      sets.push('description = $' + idx);
      params.push(input.description);
      idx++;
    }
    if (input.isActive !== undefined) {
      sets.push('is_active = $' + idx);
      params.push(input.isActive);
      idx++;
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        const result = (await client.$executeRawUnsafe(
          'UPDATE sis_discipline_categories SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            idx +
            '::uuid',
          ...params,
        )) as number;
        if (result === 0) throw new NotFoundException('Category ' + id);
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException('A category with this name already exists');
        }
        throw err;
      }
    });
    return this.getById(id);
  }

  /**
   * Internal helper used by IncidentService to validate the supplied
   * categoryId before insert. Returns the category row when active.
   */
  async assertActive(id: string): Promise<CategoryResponseDto> {
    const dto = await this.getById(id);
    if (!dto.isActive) {
      throw new BadRequestException('Category ' + id + ' is not active');
    }
    return dto;
  }

  private isUniqueViolation(err: unknown): boolean {
    const errObj = err as { code?: string; meta?: { code?: string }; message?: string };
    return (
      errObj?.code === 'P2010' ||
      errObj?.meta?.code === '23505' ||
      (typeof errObj?.message === 'string' && errObj.message.includes('23505'))
    );
  }
}
