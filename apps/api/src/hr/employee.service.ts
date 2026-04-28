import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  CreateEmployeeDto,
  EmployeePositionDto,
  EmployeeResponseDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';

interface EmployeeRow {
  id: string;
  person_id: string;
  account_id: string;
  school_id: string;
  employee_number: string | null;
  employment_type: string;
  employment_status: string;
  hire_date: string;
  termination_date: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

interface PositionRow {
  id: string;
  employee_id: string;
  position_id: string;
  position_title: string;
  is_teaching_role: boolean;
  is_primary: boolean;
  fte: string;
  effective_from: string;
  effective_to: string | null;
}

function rowToDto(row: EmployeeRow, positions: PositionRow[]): EmployeeResponseDto {
  var dtoPositions: EmployeePositionDto[] = positions
    .filter(function (p) {
      return p.employee_id === row.id;
    })
    .map(function (p) {
      return {
        id: p.id,
        positionId: p.position_id,
        positionTitle: p.position_title,
        isTeachingRole: p.is_teaching_role,
        isPrimary: p.is_primary,
        fte: Number(p.fte),
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
      };
    });
  var primary = dtoPositions.filter(function (p) {
    return p.isPrimary && p.effectiveTo === null;
  })[0];
  return {
    id: row.id,
    personId: row.person_id,
    accountId: row.account_id,
    schoolId: row.school_id,
    employeeNumber: row.employee_number,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.first_name + ' ' + row.last_name,
    email: row.email,
    employmentType: row.employment_type as EmployeeResponseDto['employmentType'],
    employmentStatus: row.employment_status as EmployeeResponseDto['employmentStatus'],
    hireDate: row.hire_date,
    terminationDate: row.termination_date,
    positions: dtoPositions,
    primaryPositionTitle: primary ? primary.positionTitle : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

var SELECT_EMPLOYEE_BASE =
  'SELECT e.id, e.person_id, e.account_id, e.school_id, e.employee_number, ' +
  'e.employment_type, e.employment_status, ' +
  "TO_CHAR(e.hire_date, 'YYYY-MM-DD') AS hire_date, " +
  "TO_CHAR(e.termination_date, 'YYYY-MM-DD') AS termination_date, " +
  'ip.first_name, ip.last_name, u.email, ' +
  'e.created_at, e.updated_at ' +
  'FROM hr_employees e ' +
  'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
  'LEFT JOIN platform.platform_users u ON u.id = e.account_id ';

var SELECT_POSITIONS_BASE =
  'SELECT ep.id, ep.employee_id, ep.position_id, p.title AS position_title, ' +
  'p.is_teaching_role, ep.is_primary, ep.fte, ' +
  "TO_CHAR(ep.effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "TO_CHAR(ep.effective_to, 'YYYY-MM-DD') AS effective_to " +
  'FROM hr_employee_positions ep ' +
  'JOIN hr_positions p ON p.id = ep.position_id ';

@Injectable()
export class EmployeeService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Staff directory list. Every authenticated user with `hr-001:read`
   * sees the active staff; admins (with `includeInactive=true`) can also
   * see TERMINATED / SUSPENDED / ON_LEAVE rows. Search across first / last
   * name + email + employee number.
   */
  async list(filters: ListEmployeesQueryDto, actor: ResolvedActor): Promise<EmployeeResponseDto[]> {
    var includeInactive = filters.includeInactive === true && actor.isSchoolAdmin;
    var statusFilter = filters.employmentStatus ?? null;
    var search = filters.search ? '%' + filters.search.trim().toLowerCase() + '%' : null;

    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<EmployeeRow[]>(
        SELECT_EMPLOYEE_BASE +
          'WHERE ($1::text IS NULL OR e.employment_status = $1::text) ' +
          "AND ($2::boolean = true OR e.employment_status = 'ACTIVE') " +
          'AND ($3::text IS NULL OR ' +
          'LOWER(ip.first_name) LIKE $3::text OR ' +
          'LOWER(ip.last_name) LIKE $3::text OR ' +
          "LOWER(COALESCE(u.email, '')) LIKE $3::text OR " +
          "LOWER(COALESCE(e.employee_number, '')) LIKE $3::text) " +
          'ORDER BY ip.last_name, ip.first_name',
        statusFilter,
        includeInactive,
        search,
      );
      var ids = rows.map(function (r) {
        return r.id;
      });
      var positions = await this.loadPositionsFor(client, ids);
      return { rows: rows, positions: positions };
    });

    return result.rows.map(function (r) {
      return rowToDto(r, result.positions);
    });
  }

  /**
   * Single-employee read. Throws 404 when no employee row exists for the id.
   * Currently every persona with hr-001:read can fetch any employee profile —
   * documents and leave details are gated separately on their own endpoints.
   */
  async getById(id: string): Promise<EmployeeResponseDto> {
    var result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var rows = await client.$queryRawUnsafe<EmployeeRow[]>(
        SELECT_EMPLOYEE_BASE + 'WHERE e.id = $1::uuid',
        id,
      );
      if (rows.length === 0) return null;
      var positions = await this.loadPositionsFor(client, [id]);
      return { row: rows[0]!, positions: positions };
    });
    if (!result) throw new NotFoundException('Employee ' + id + ' not found');
    return rowToDto(result.row, result.positions);
  }

  /**
   * Resolve the calling user's own employee record. Returns 404 if the
   * caller has no hr_employees row (parents, students, the synthetic
   * Platform Admin). The actor.employeeId field was populated in
   * Cycle 4 Step 0 inside ActorContextService.resolveActor.
   */
  async getMe(actor: ResolvedActor): Promise<EmployeeResponseDto> {
    if (!actor.employeeId) {
      throw new NotFoundException('No employee record for the calling user');
    }
    return this.getById(actor.employeeId);
  }

  /**
   * Create an employee row. Optionally links a primary position assignment
   * via initialPositionId. The (person_id, account_id) pair must exist in
   * platform.iam_person / platform.platform_users — soft-FK validation
   * happens app-layer per ADR-001/020.
   */
  async create(body: CreateEmployeeDto, actor: ResolvedActor): Promise<EmployeeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can create employees');
    }
    var platform = this.tenantPrisma.getPlatformClient();
    var person = await platform.iamPerson.findUnique({ where: { id: body.personId } });
    if (!person) throw new BadRequestException('iam_person ' + body.personId + ' not found');
    var account = await platform.platformUser.findUnique({ where: { id: body.accountId } });
    if (!account) throw new BadRequestException('platform_user ' + body.accountId + ' not found');
    if (account.personId !== body.personId) {
      throw new BadRequestException(
        'platform_user ' + body.accountId + ' is not linked to iam_person ' + body.personId,
      );
    }

    var schoolIdRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ school_id: string }>>(
        "SELECT value::uuid AS school_id FROM school_config WHERE key = 'school_id' LIMIT 1",
      );
    });
    // Fall back to the existing employee rows' school_id if school_config doesn't carry one.
    var schoolId: string;
    if (schoolIdRows.length > 0) {
      schoolId = schoolIdRows[0]!.school_id;
    } else {
      var existing = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<Array<{ school_id: string }>>(
          'SELECT school_id::uuid AS school_id FROM hr_employees LIMIT 1',
        );
      });
      if (existing.length === 0) {
        throw new BadRequestException(
          'school_id cannot be resolved — provision tenant first and seed at least one employee',
        );
      }
      schoolId = existing[0]!.school_id;
    }

    var employeeId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_employees (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'ACTIVE', $7::date)",
        employeeId,
        body.personId,
        body.accountId,
        schoolId,
        body.employeeNumber ?? null,
        body.employmentType,
        body.hireDate,
      );
      if (body.initialPositionId) {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_employee_positions (id, employee_id, position_id, is_primary, fte, effective_from) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, true, 1.000, $4::date)',
          generateId(),
          employeeId,
          body.initialPositionId,
          body.hireDate,
        );
      }
    });
    return this.getById(employeeId);
  }

  /**
   * Patch employee fields. Admin-only — every persona except admins is
   * forbidden, even from updating their own employee_number etc. (Step 8
   * UI surfaces these as admin-only fields anyway.)
   */
  async update(
    id: string,
    body: UpdateEmployeeDto,
    actor: ResolvedActor,
  ): Promise<EmployeeResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update employee records');
    }
    var existing = await this.getById(id);

    var setClauses: string[] = [];
    var params: any[] = [];
    var idx = 1;
    if (body.employeeNumber !== undefined) {
      setClauses.push('employee_number = $' + idx);
      params.push(body.employeeNumber);
      idx++;
    }
    if (body.employmentType !== undefined) {
      setClauses.push('employment_type = $' + idx);
      params.push(body.employmentType);
      idx++;
    }
    if (body.employmentStatus !== undefined) {
      setClauses.push('employment_status = $' + idx);
      params.push(body.employmentStatus);
      idx++;
    }
    if (body.terminationDate !== undefined) {
      setClauses.push('termination_date = $' + idx + '::date');
      params.push(body.terminationDate);
      idx++;
    }
    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'UPDATE hr_employees SET ' + setClauses.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    return this.getById(id);
  }

  private async loadPositionsFor(client: any, employeeIds: string[]): Promise<PositionRow[]> {
    if (employeeIds.length === 0) return [];
    var placeholders = employeeIds
      .map(function (_, i) {
        return '$' + (i + 1) + '::uuid';
      })
      .join(',');
    return client.$queryRawUnsafe(
      SELECT_POSITIONS_BASE +
        'WHERE ep.employee_id IN (' +
        placeholders +
        ') ' +
        'ORDER BY ep.is_primary DESC, ep.effective_from DESC',
      ...employeeIds,
    );
  }
}
