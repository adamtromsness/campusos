import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  CreateCrossSchoolStaffDto,
  CrossSchoolStaffResponseDto,
  UpdateCrossSchoolStaffDto,
} from './dto/scheduling-advanced-b.dto';

/*
 * CrossSchoolStaffService — P2-17b.
 *
 * Owns sch_cross_school_staff_assignments. The keystone — the
 * EXCLUSION constraint on (person_id daterange) prevents the same
 * iam_person from holding overlapping cross-school assignments. SQL
 * SQLSTATE 23P01 is translated to 409 Conflict here.
 *
 * Tenants are schema-isolated so a person assigned to multiple
 * visiting schools across tenants cannot be detected from a single
 * query. The EXCLUSION at this tenant is the best schema-level guard.
 * The visiting tenant maintains its own sch_timetable_slots EXCLUSION
 * keyed on hr_employees.id (a different row from the home employee).
 */

interface AssignmentRow {
  id: string;
  home_school_id: string;
  visiting_school_id: string;
  person_id: string;
  home_employee_id: string;
  role_at_visiting_school: string;
  effective_from: string;
  effective_to: string | null;
  max_periods_per_week: number | null;
  approved_by: string | null;
  notes: string | null;
}

const SELECT_BASE =
  'SELECT id::text AS id, home_school_id::text AS home_school_id, ' +
  'visiting_school_id::text AS visiting_school_id, person_id::text AS person_id, ' +
  'home_employee_id::text AS home_employee_id, role_at_visiting_school, ' +
  "to_char(effective_from, 'YYYY-MM-DD') AS effective_from, " +
  "to_char(effective_to, 'YYYY-MM-DD') AS effective_to, max_periods_per_week, " +
  'approved_by::text AS approved_by, notes ' +
  'FROM sch_cross_school_staff_assignments ';

function rowToDto(row: AssignmentRow): CrossSchoolStaffResponseDto {
  return {
    id: row.id,
    homeSchoolId: row.home_school_id,
    visitingSchoolId: row.visiting_school_id,
    personId: row.person_id,
    homeEmployeeId: row.home_employee_id,
    roleAtVisitingSchool: row.role_at_visiting_school,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    maxPeriodsPerWeek: row.max_periods_per_week,
    approvedBy: row.approved_by,
    notes: row.notes,
  };
}

function isExclusionViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err.meta?.code === '23P01' || err.code === '23P01';
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string } };
  return err.code === 'P2010' || err.meta?.code === '23505';
}

@Injectable()
export class CrossSchoolStaffService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private assertAdmin(actor: ResolvedActor): void {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Cross-school staff assignments require sch-001:admin (school admin).',
      );
    }
  }

  async list(): Promise<CrossSchoolStaffResponseDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssignmentRow[]>(
        SELECT_BASE +
          'WHERE home_school_id = $1::uuid OR visiting_school_id = $1::uuid ORDER BY effective_from DESC',
        tenant.schoolId,
      );
    });
    return rows.map(rowToDto);
  }

  async getById(id: string): Promise<CrossSchoolStaffResponseDto> {
    // P2-H1 Step 1: the requesting tenant must be either the home school OR the
    // visiting school for the assignment to be visible. Cross-school assignments
    // belonging entirely to OTHER schools collapse to 404 don't-leak-existence.
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AssignmentRow[]>(
        SELECT_BASE +
          'WHERE id = $1::uuid AND (home_school_id = $2::uuid OR visiting_school_id = $2::uuid)',
        id,
        tenant.schoolId,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Cross-school staff assignment not found');
    return rowToDto(rows[0]!);
  }

  async create(
    body: CreateCrossSchoolStaffDto,
    actor: ResolvedActor,
  ): Promise<CrossSchoolStaffResponseDto> {
    this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    if (body.visitingSchoolId === tenant.schoolId) {
      throw new BadRequestException(
        'visitingSchoolId must differ from the home school (the calling tenant).',
      );
    }
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO sch_cross_school_staff_assignments (id, home_school_id, visiting_school_id, person_id, home_employee_id, role_at_visiting_school, effective_from, effective_to, max_periods_per_week, approved_by, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::date, $9, $10::uuid, $11)',
          id,
          tenant.schoolId,
          body.visitingSchoolId,
          body.personId,
          body.homeEmployeeId,
          body.roleAtVisitingSchool,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          body.maxPeriodsPerWeek ?? null,
          actor.accountId,
          body.notes ?? null,
        );
      });
    } catch (e: unknown) {
      if (isExclusionViolation(e)) {
        throw new ConflictException(
          'This person already has an overlapping cross-school assignment — the person-level EXCLUSION constraint prevents the same human from being double-booked.',
        );
      }
      if (isUniqueViolation(e)) {
        throw new ConflictException(
          'A cross-school assignment for this (visiting_school person effective_from) tuple already exists.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }

  async patch(
    id: string,
    body: UpdateCrossSchoolStaffDto,
    actor: ResolvedActor,
  ): Promise<CrossSchoolStaffResponseDto> {
    this.assertAdmin(actor);
    const sets: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (body.effectiveTo !== undefined) {
      sets.push('effective_to = $' + i + '::date');
      args.push(body.effectiveTo);
      i += 1;
    }
    if (body.maxPeriodsPerWeek !== undefined) {
      sets.push('max_periods_per_week = $' + i + '::int');
      args.push(body.maxPeriodsPerWeek);
      i += 1;
    }
    if (body.notes !== undefined) {
      sets.push('notes = $' + i);
      args.push(body.notes);
      i += 1;
    }
    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    args.push(id);
    // P2-H1 Step 1: UPDATE requires the calling tenant to be home OR visiting
    // school for the assignment. Defence-in-depth on top of the getById guard.
    const tenant = getCurrentTenant();
    args.push(tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE sch_cross_school_staff_assignments SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            i +
            '::uuid AND (home_school_id = $' +
            (i + 1) +
            '::uuid OR visiting_school_id = $' +
            (i + 1) +
            '::uuid)',
          ...args,
        );
      });
    } catch (e: unknown) {
      if (isExclusionViolation(e)) {
        throw new ConflictException(
          'PATCH would create an overlapping window for this person — the person-level EXCLUSION constraint prevents the change.',
        );
      }
      throw e;
    }
    return this.getById(id);
  }
}
