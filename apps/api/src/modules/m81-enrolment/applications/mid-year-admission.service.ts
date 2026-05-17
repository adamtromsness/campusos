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
import {
  CreateMidYearAdmissionDto,
  MidYearAdmissionResponseDto,
  UpdateMidYearAdmissionDto,
} from '../withdrawals/dto/withdrawal.dto';

interface MyarRow {
  id: string;
  school_id: string;
  requested_by: string;
  requested_by_first_name: string | null;
  requested_by_last_name: string | null;
  student_first_name: string;
  student_last_name: string;
  student_date_of_birth: string;
  applying_for_grade_level: string;
  requested_start_date: string;
  admission_reason: string;
  admission_reason_detail: string | null;
  previous_school_name: string | null;
  previous_school_country: string | null;
  records_requested: boolean;
  status: string;
  capacity_available: boolean | null;
  capacity_checked_at: string | null;
  capacity_checked_by: string | null;
  capacity_checked_by_first_name: string | null;
  capacity_checked_by_last_name: string | null;
  linked_application_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_MYAR_BASE =
  'SELECT m.id, m.school_id, m.requested_by, ' +
  '       rp.first_name AS requested_by_first_name, rp.last_name AS requested_by_last_name, ' +
  '       m.student_first_name, m.student_last_name, ' +
  '       m.student_date_of_birth::text AS student_date_of_birth, ' +
  '       m.applying_for_grade_level, m.requested_start_date::text AS requested_start_date, ' +
  '       m.admission_reason, m.admission_reason_detail, ' +
  '       m.previous_school_name, m.previous_school_country, m.records_requested, ' +
  '       m.status, m.capacity_available, ' +
  '       m.capacity_checked_at::text AS capacity_checked_at, m.capacity_checked_by, ' +
  '       cp.first_name AS capacity_checked_by_first_name, cp.last_name AS capacity_checked_by_last_name, ' +
  '       m.linked_application_id, m.notes, ' +
  '       m.created_at::text AS created_at, m.updated_at::text AS updated_at ' +
  'FROM enr_mid_year_admission_requests m ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = m.requested_by ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = m.capacity_checked_by ';

function name(f: string | null, l: string | null): string | null {
  if (!f && !l) return null;
  return [f, l].filter(Boolean).join(' ');
}

function rowToDto(r: MyarRow): MidYearAdmissionResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    requestedBy: r.requested_by,
    requestedByName: name(r.requested_by_first_name, r.requested_by_last_name),
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    studentDateOfBirth: r.student_date_of_birth,
    applyingForGradeLevel: r.applying_for_grade_level,
    requestedStartDate: r.requested_start_date,
    admissionReason: r.admission_reason as MidYearAdmissionResponseDto['admissionReason'],
    admissionReasonDetail: r.admission_reason_detail,
    previousSchoolName: r.previous_school_name,
    previousSchoolCountry: r.previous_school_country,
    recordsRequested: r.records_requested,
    status: r.status as MidYearAdmissionResponseDto['status'],
    capacityAvailable: r.capacity_available,
    capacityCheckedAt: r.capacity_checked_at,
    capacityCheckedBy: r.capacity_checked_by,
    capacityCheckedByName: name(r.capacity_checked_by_first_name, r.capacity_checked_by_last_name),
    linkedApplicationId: r.linked_application_id,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * MidYearAdmissionService — out-of-cycle admission requests.
 *
 * Authorisation contract:
 *   - submit — guardian (stu-004:write) or admin / EO. Guardians
 *     submit for their own family (no link to existing student
 *     required since this is a brand-new admission).
 *   - list — admin sees the full queue; parent sees only own
 *     submissions.
 *   - patch — admin / EO only. Sets capacity_available with the
 *     audit fields populated atomically (capacity_chk lockstep);
 *     can advance status; can stamp linked_application_id.
 */
@Injectable()
export class MidYearAdmissionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-003:admin',
      'stu-004:admin',
    ]);
  }

  /**
   * REVIEW-P2-5 BLOCKING 3 — operator scope = school admin OR a
   * STAFF actor with explicit STU-004 grant (Enrolment Officer or
   * Vice Principal). Generic STAFF (counsellor, librarian, etc.)
   * does NOT pass this check, so they cannot list every mid-year
   * request school-wide. Replaces the old `personType === 'STAFF'`
   * shortcut.
   */
  private async hasOperatorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType !== 'STAFF') return false;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-003:admin',
      'stu-004:write',
      'stu-004:admin',
    ]);
  }

  private async hasWriteScope(actor: ResolvedActor): Promise<boolean> {
    if (await this.hasAdminScope(actor)) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-004:write',
    ]);
  }

  async submit(
    input: CreateMidYearAdmissionDto,
    actor: ResolvedActor,
  ): Promise<MidYearAdmissionResponseDto> {
    if (!(await this.hasWriteScope(actor))) {
      throw new ForbiddenException('Submitting a mid-year admission requires stu-004:write');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO enr_mid_year_admission_requests ' +
          '(id, school_id, requested_by, student_first_name, student_last_name, ' +
          ' student_date_of_birth, applying_for_grade_level, requested_start_date, ' +
          ' admission_reason, admission_reason_detail, previous_school_name, ' +
          ' previous_school_country, records_requested, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8::date, $9, $10, $11, $12, $13, $14)',
        id,
        tenant.schoolId,
        actor.personId,
        input.studentFirstName,
        input.studentLastName,
        input.studentDateOfBirth,
        input.applyingForGradeLevel,
        input.requestedStartDate,
        input.admissionReason,
        input.admissionReasonDetail ?? null,
        input.previousSchoolName ?? null,
        input.previousSchoolCountry ?? null,
        input.recordsRequested ?? false,
        input.notes ?? null,
      );
    });
    return this.getById(id, actor);
  }

  async list(actor: ResolvedActor): Promise<MidYearAdmissionResponseDto[]> {
    const tenant = getCurrentTenant();
    // REVIEW-P2-5 BLOCKING 3 — operator scope (admin OR EO/VP)
    // sees school-wide; everyone else is row-scoped to own
    // submissions.
    const operator = await this.hasOperatorScope(actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = 'm.school_id = $1::uuid ';
      if (!operator) {
        args.push(actor.personId);
        where += '  AND m.requested_by = $' + args.length + '::uuid ';
      }
      const rows = (await client.$queryRawUnsafe(
        SELECT_MYAR_BASE +
          'WHERE ' +
          where +
          'ORDER BY m.requested_start_date, m.created_at LIMIT 500',
        ...args,
      )) as MyarRow[];
      return rows.map(rowToDto);
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<MidYearAdmissionResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_MYAR_BASE + 'WHERE m.school_id = $1::uuid AND m.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as MyarRow[];
      if (rows.length === 0) throw new NotFoundException('Mid-year admission request not found');
      const row = rows[0] as MyarRow;
      // REVIEW-P2-5 BLOCKING 3 — operator scope replaces broad
      // STAFF shortcut. Non-operator non-submitter gets 404.
      const operator = await this.hasOperatorScope(actor);
      if (!operator && row.requested_by !== actor.personId) {
        throw new NotFoundException('Mid-year admission request not found');
      }
      return rowToDto(row);
    });
  }

  async patch(
    id: string,
    input: UpdateMidYearAdmissionDto,
    actor: ResolvedActor,
  ): Promise<MidYearAdmissionResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Updating a mid-year admission requires stu-004:admin');
    }
    const tenant = getCurrentTenant();

    if (input.linkedApplicationId) {
      // Validate the application exists in this school.
      const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 FROM enr_applications WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
          tenant.schoolId,
          input.linkedApplicationId,
        )) as Array<unknown>;
        return rows.length > 0;
      });
      if (!ok) {
        throw new BadRequestException(
          'linkedApplicationId does not match an application in this school.',
        );
      }
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_mid_year_admission_requests ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string }>;
      if (rows.length === 0) throw new NotFoundException('Mid-year admission request not found');

      const sets: string[] = ['updated_at = now()'];
      const args: unknown[] = [];
      if (input.status !== undefined) {
        sets.push('status = $' + (args.length + 1));
        args.push(input.status);
      }
      if (input.capacityAvailable !== undefined) {
        sets.push('capacity_available = $' + (args.length + 1));
        args.push(input.capacityAvailable);
        sets.push('capacity_checked_at = now()');
        sets.push('capacity_checked_by = $' + (args.length + 1) + '::uuid');
        args.push(actor.personId);
      }
      if (input.linkedApplicationId !== undefined) {
        sets.push('linked_application_id = $' + (args.length + 1) + '::uuid');
        args.push(input.linkedApplicationId);
      }
      if (input.notes !== undefined) {
        sets.push('notes = $' + (args.length + 1));
        args.push(input.notes);
      }
      if (sets.length === 1) return;
      args.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE enr_mid_year_admission_requests SET ' +
          sets.join(', ') +
          ' WHERE id = $' +
          args.length +
          '::uuid',
        ...args,
      );
    });

    return this.getById(id, actor);
  }
}
