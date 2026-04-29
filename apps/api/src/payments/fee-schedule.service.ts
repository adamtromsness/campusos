import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateFeeCategoryDto,
  CreateFeeScheduleDto,
  FeeCategoryResponseDto,
  FeeScheduleResponseDto,
  Recurrence,
  UpdateFeeScheduleDto,
} from './dto/fee-schedule.dto';

interface CategoryRow {
  id: string;
  school_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  school_id: string;
  academic_year_id: string;
  academic_year_name: string;
  fee_category_id: string;
  fee_category_name: string;
  name: string;
  description: string | null;
  grade_level: string | null;
  amount: string;
  is_recurring: boolean;
  recurrence: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function categoryRowToDto(r: CategoryRow): FeeCategoryResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    name: r.name,
    description: r.description,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function scheduleRowToDto(r: ScheduleRow): FeeScheduleResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    academicYearId: r.academic_year_id,
    academicYearName: r.academic_year_name,
    feeCategoryId: r.fee_category_id,
    feeCategoryName: r.fee_category_name,
    name: r.name,
    description: r.description,
    gradeLevel: r.grade_level,
    amount: Number(r.amount),
    isRecurring: r.is_recurring,
    recurrence: r.recurrence as Recurrence,
    isActive: r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_SCHEDULE_BASE =
  'SELECT s.id, s.school_id, s.academic_year_id, ay.name AS academic_year_name, ' +
  's.fee_category_id, fc.name AS fee_category_name, ' +
  's.name, s.description, s.grade_level, s.amount::text, ' +
  's.is_recurring, s.recurrence, s.is_active, s.created_at, s.updated_at ' +
  'FROM pay_fee_schedules s ' +
  'JOIN sis_academic_years ay ON ay.id = s.academic_year_id ' +
  'JOIN pay_fee_categories fc ON fc.id = s.fee_category_id ';

@Injectable()
export class FeeScheduleService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async listCategories(): Promise<FeeCategoryResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CategoryRow[]>(
        'SELECT id, school_id, name, description, is_active, created_at, updated_at ' +
          'FROM pay_fee_categories ORDER BY name',
      );
    });
    return rows.map(categoryRowToDto);
  }

  async createCategory(
    body: CreateFeeCategoryDto,
    actor: ResolvedActor,
  ): Promise<FeeCategoryResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create fee categories');
    }
    var schoolId = getCurrentTenant().schoolId;
    var id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_fee_categories (id, school_id, name, description, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, true)',
        id,
        schoolId,
        body.name,
        body.description ?? null,
      );
    });
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CategoryRow[]>(
        'SELECT id, school_id, name, description, is_active, created_at, updated_at ' +
          'FROM pay_fee_categories WHERE id = $1::uuid',
        id,
      );
    });
    return categoryRowToDto(rows[0]!);
  }

  async listSchedules(): Promise<FeeScheduleResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScheduleRow[]>(
        SELECT_SCHEDULE_BASE + 'ORDER BY ay.start_date DESC, fc.name, s.name',
      );
    });
    return rows.map(scheduleRowToDto);
  }

  async getScheduleById(id: string): Promise<FeeScheduleResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ScheduleRow[]>(
        SELECT_SCHEDULE_BASE + 'WHERE s.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Fee schedule ' + id + ' not found');
    return scheduleRowToDto(rows[0]!);
  }

  async createSchedule(
    body: CreateFeeScheduleDto,
    actor: ResolvedActor,
  ): Promise<FeeScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create fee schedules');
    }
    var schoolId = getCurrentTenant().schoolId;
    var id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var ayRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM sis_academic_years WHERE id = $1::uuid',
        body.academicYearId,
      )) as Array<{ id: string }>;
      if (ayRows.length === 0) {
        throw new NotFoundException('Academic year ' + body.academicYearId + ' not found');
      }
      var catRows = (await tx.$queryRawUnsafe(
        'SELECT id, is_active FROM pay_fee_categories WHERE id = $1::uuid',
        body.feeCategoryId,
      )) as Array<{ id: string; is_active: boolean }>;
      if (catRows.length === 0) {
        throw new NotFoundException('Fee category ' + body.feeCategoryId + ' not found');
      }
      if (!catRows[0]!.is_active) {
        throw new BadRequestException('Fee category is inactive');
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_fee_schedules (id, school_id, academic_year_id, fee_category_id, name, description, grade_level, amount, is_recurring, recurrence, is_active) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::numeric, $9, $10, true)',
        id,
        schoolId,
        body.academicYearId,
        body.feeCategoryId,
        body.name,
        body.description ?? null,
        body.gradeLevel ?? null,
        body.amount.toFixed(2),
        body.isRecurring ?? false,
        body.recurrence ?? 'ANNUAL',
      );
    });
    return this.getScheduleById(id);
  }

  async updateSchedule(
    id: string,
    body: UpdateFeeScheduleDto,
    actor: ResolvedActor,
  ): Promise<FeeScheduleResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update fee schedules');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var setClauses: string[] = [];
      var params: any[] = [];
      var idx = 1;
      if (body.name !== undefined) {
        setClauses.push('name = $' + idx);
        params.push(body.name);
        idx++;
      }
      if (body.description !== undefined) {
        setClauses.push('description = $' + idx);
        params.push(body.description);
        idx++;
      }
      if (body.gradeLevel !== undefined) {
        setClauses.push('grade_level = $' + idx);
        params.push(body.gradeLevel);
        idx++;
      }
      if (body.amount !== undefined) {
        setClauses.push('amount = $' + idx + '::numeric');
        params.push(body.amount.toFixed(2));
        idx++;
      }
      if (body.isRecurring !== undefined) {
        setClauses.push('is_recurring = $' + idx);
        params.push(body.isRecurring);
        idx++;
      }
      if (body.recurrence !== undefined) {
        setClauses.push('recurrence = $' + idx);
        params.push(body.recurrence);
        idx++;
      }
      if (body.isActive !== undefined) {
        setClauses.push('is_active = $' + idx);
        params.push(body.isActive);
        idx++;
      }
      if (setClauses.length === 0) return;
      setClauses.push('updated_at = now()');
      params.push(id);
      var result = await tx.$executeRawUnsafe(
        'UPDATE pay_fee_schedules SET ' +
          setClauses.join(', ') +
          ' WHERE id = $' +
          idx +
          '::uuid',
        ...params,
      );
      if (Number(result) === 0) {
        throw new NotFoundException('Fee schedule ' + id + ' not found');
      }
    });
    return this.getScheduleById(id);
  }
}
