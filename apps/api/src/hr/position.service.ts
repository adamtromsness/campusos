import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CreatePositionDto, PositionResponseDto, UpdatePositionDto } from './dto/position.dto';

interface PositionRow {
  id: string;
  school_id: string;
  title: string;
  department_id: string | null;
  department_name: string | null;
  is_teaching_role: boolean;
  is_active: boolean;
  active_assignments: number;
  created_at: string;
  updated_at: string;
}

function rowToDto(row: PositionRow): PositionResponseDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    title: row.title,
    departmentId: row.department_id,
    departmentName: row.department_name,
    isTeachingRole: row.is_teaching_role,
    isActive: row.is_active,
    activeAssignments: Number(row.active_assignments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

var SELECT_POSITION_BASE =
  'SELECT p.id, p.school_id, p.title, p.department_id, d.name AS department_name, ' +
  'p.is_teaching_role, p.is_active, ' +
  '(SELECT count(*)::int FROM hr_employee_positions ep ' +
  '   WHERE ep.position_id = p.id AND ep.effective_to IS NULL) AS active_assignments, ' +
  'p.created_at, p.updated_at ' +
  'FROM hr_positions p ' +
  'LEFT JOIN sis_departments d ON d.id = p.department_id ';

@Injectable()
export class PositionService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async list(includeInactive: boolean): Promise<PositionResponseDto[]> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PositionRow[]>(
        SELECT_POSITION_BASE +
          'WHERE ($1::boolean = true OR p.is_active = true) ' +
          'ORDER BY p.title',
        includeInactive,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<PositionResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<PositionRow[]>(
        SELECT_POSITION_BASE + 'WHERE p.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Position ' + id + ' not found');
    return rowToDto(rows[0]!);
  }

  async create(body: CreatePositionDto, actor: ResolvedActor): Promise<PositionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create positions');
    }
    var schoolIdRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ school_id: string }>>(
        'SELECT school_id::uuid AS school_id FROM hr_employees LIMIT 1',
      );
    });
    if (schoolIdRows.length === 0) {
      throw new ForbiddenException(
        'No employees in this tenant — seed at least one employee before creating positions',
      );
    }
    var schoolId = schoolIdRows[0]!.school_id;

    var positionId = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hr_positions (id, school_id, title, department_id, is_teaching_role) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5)',
        positionId,
        schoolId,
        body.title,
        body.departmentId ?? null,
        body.isTeachingRole === true,
      );
    });
    return this.getById(positionId);
  }

  async update(
    id: string,
    body: UpdatePositionDto,
    actor: ResolvedActor,
  ): Promise<PositionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update positions');
    }
    var existing = await this.getById(id);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.title !== undefined) {
      setClauses.push('title = $' + idx);
      params.push(body.title);
      idx++;
    }
    if (body.departmentId !== undefined) {
      setClauses.push('department_id = $' + idx + '::uuid');
      params.push(body.departmentId);
      idx++;
    }
    if (body.isTeachingRole !== undefined) {
      setClauses.push('is_teaching_role = $' + idx);
      params.push(body.isTeachingRole);
      idx++;
    }
    if (body.isActive !== undefined) {
      setClauses.push('is_active = $' + idx);
      params.push(body.isActive);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE hr_positions SET ' + setClauses.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }
}
