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
import { PermissionCheckService } from '../iam/permission-check.service';
import { HealthAccessLogService } from './health-access-log.service';
import {
  AllergyEntryDto,
  ConditionResponseDto,
  ConditionSeverity,
  CreateHealthRecordDto,
  HealthRecordResponseDto,
  ImmunisationComplianceRowDto,
  ImmunisationResponseDto,
  ImmunisationStatus,
  UpdateHealthRecordDto,
} from './dto/health.dto';

/* HealthRecordService — Cycle 10 Step 5.
 *
 * Row-scope visibility model:
 *   - Admin / nurse (isSchoolAdmin OR holds hlt-001:write) → all
 *     students in tenant; full DTO including management_plan and
 *     emergency_medical_notes.
 *   - Teacher (STAFF persona, hlt-001:read only) → students in their
 *     classes via sis_class_teachers + ACTIVE sis_enrollments.
 *     STRIPPED DTO: blood_type + allergen+severity only (no reaction
 *     or notes) + emergency_medical_notes (teachers need to know
 *     about evacuation procedures) + active conditions name+severity
 *     (no management_plan) + NO immunisations + NO physician contact.
 *   - Parent (GUARDIAN, hlt-001:read) → own children via
 *     sis_student_guardians keyed on actor.personId. STRIPPED DTO:
 *     full allergy details + immunisations (parents need compliance
 *     status) + active and inactive conditions name+severity (no
 *     management_plan — that is staff treatment guidance) + NO
 *     emergency_medical_notes (procedural staff content) + physician
 *     contact since parents already have it.
 *   - Student → 403 at the gate (HLT-001:read not granted to students).
 *     The service-layer check would also AND FALSE.
 */

interface RecordRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  blood_type: string | null;
  allergies: AllergyEntryDto[] | null;
  emergency_medical_notes: string | null;
  physician_name: string | null;
  physician_phone: string | null;
  created_at: string;
  updated_at: string;
}

interface ConditionRow {
  id: string;
  health_record_id: string;
  condition_name: string;
  diagnosis_date: string | null;
  is_active: boolean;
  severity: string;
  management_plan: string | null;
  created_at: string;
  updated_at: string;
}

interface ImmunisationRow {
  id: string;
  health_record_id: string;
  vaccine_name: string;
  administered_date: string | null;
  due_date: string | null;
  administered_by: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SELECT_RECORD_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, ' +
  'r.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'r.blood_type, r.allergies, r.emergency_medical_notes, ' +
  'r.physician_name, r.physician_phone, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_student_health_records r ' +
  'JOIN sis_students s ON s.id = r.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ';

const SELECT_CONDITION_BASE =
  'SELECT id::text AS id, health_record_id::text AS health_record_id, ' +
  "condition_name, TO_CHAR(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date, " +
  'is_active, severity, management_plan, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_medical_conditions ';

const SELECT_IMMUNISATION_BASE =
  'SELECT id::text AS id, health_record_id::text AS health_record_id, ' +
  "vaccine_name, TO_CHAR(administered_date, 'YYYY-MM-DD') AS administered_date, " +
  "TO_CHAR(due_date, 'YYYY-MM-DD') AS due_date, " +
  'administered_by, status, ' +
  'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_immunisations ';

@Injectable()
export class HealthRecordService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  // ─── Permission helpers ──────────────────────────────────────

  /**
   * Nurse scope = caller can read/write health records across the
   * tenant. Granted to admins (sch-001:admin via everyFunction → also
   * picks up hlt-001:*) and to staff who hold hlt-001:write directly
   * (the seed grants this to the Staff role for nurse / counsellor /
   * VP / admin assistant). Teachers with only hlt-001:read fall
   * through to the row-scoped path.
   */
  async hasNurseScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hlt-001:write',
    ]);
  }

  /**
   * Validates the actor can READ this student's health record.
   * Returns silently if allowed; throws NotFoundException otherwise
   * (per the don't-leak-existence row-scope convention used by the
   * Cycle 9 IncidentService).
   */
  private async assertCanReadStudent(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<{ isManager: boolean }> {
    const isManager = await this.hasNurseScope(actor);
    if (isManager) {
      // Manager still has to verify the student is in this tenant.
      const exists = await this.studentExistsInTenant(studentId);
      if (!exists) throw new NotFoundException('Student ' + studentId);
      return { isManager: true };
    }

    if (actor.personType === 'STAFF' && actor.employeeId) {
      const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_enrollments e ' +
            'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
            "WHERE e.status = 'ACTIVE' AND e.student_id = $1::uuid AND ct.teacher_employee_id = $2::uuid LIMIT 1",
          studentId,
          actor.employeeId,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      });
      if (!ok) throw new NotFoundException('Student ' + studentId);
      return { isManager: false };
    }

    if (actor.personType === 'GUARDIAN') {
      const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      });
      if (!ok) throw new NotFoundException('Student ' + studentId);
      return { isManager: false };
    }

    // STUDENT or anything unrecognised — the gate-tier permission
    // check should already have 403'd. Defence in depth:
    throw new NotFoundException('Student ' + studentId);
  }

  private async studentExistsInTenant(studentId: string): Promise<boolean> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
  }

  // ─── Read paths ──────────────────────────────────────────────

  /**
   * Full record + inlined conditions + inlined immunisations.
   * Writes a VIEW_RECORD audit row before returning. Throws 404 when
   * the student exists but is outside the actor's row scope, OR when
   * the student exists but has no health record (the typical case
   * for a newly enrolled student where the nurse hasn't created the
   * record yet — staff get a clean 404 to indicate "needs creation"
   * while non-managers see the same 404 since they wouldn't be able
   * to see the record anyway).
   */
  async getFullRecord(studentId: string, actor: ResolvedActor): Promise<HealthRecordResponseDto> {
    const { isManager } = await this.assertCanReadStudent(studentId, actor);

    const record = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_RECORD_BASE + 'WHERE r.student_id = $1::uuid LIMIT 1',
        studentId,
      )) as RecordRow[];
      return rows[0] ?? null;
    });
    if (!record) {
      throw new NotFoundException('No health record exists for student ' + studentId);
    }

    const [conditions, immunisations] = await this.tenantPrisma.executeInTenantContext(
      async (client) => {
        return Promise.all([
          client.$queryRawUnsafe<ConditionRow[]>(
            SELECT_CONDITION_BASE +
              'WHERE health_record_id = $1::uuid ORDER BY is_active DESC, created_at DESC',
            record.id,
          ),
          client.$queryRawUnsafe<ImmunisationRow[]>(
            SELECT_IMMUNISATION_BASE +
              'WHERE health_record_id = $1::uuid ORDER BY administered_date DESC NULLS LAST',
            record.id,
          ),
        ]);
      },
    );

    // Audit BEFORE returning. Throws if the insert fails — the client
    // never sees PHI without a successful audit row.
    await this.accessLog.recordAccess(actor, studentId, 'VIEW_RECORD');

    const conditionDtos = conditions.map((c) => this.conditionRowToDto(c, isManager));
    const includeImmunisations = isManager || actor.personType === 'GUARDIAN';
    const immunisationDtos = includeImmunisations
      ? immunisations.map((i) => this.immunisationRowToDto(i))
      : [];

    return this.recordRowToDto(
      record,
      conditionDtos,
      immunisationDtos,
      isManager,
      actor.personType,
    );
  }

  // ─── Write paths ─────────────────────────────────────────────

  /**
   * Create a new health record. Nurse / admin only. UNIQUE on
   * student_id at the schema layer rejects duplicate creation
   * attempts with a 23505 — translated to 400 here.
   */
  async create(
    studentId: string,
    input: CreateHealthRecordDto,
    actor: ResolvedActor,
  ): Promise<HealthRecordResponseDto> {
    if (!(await this.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses and admins can create health records');
    }
    if (!(await this.studentExistsInTenant(studentId))) {
      throw new NotFoundException('Student ' + studentId);
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO hlth_student_health_records ' +
            '(id, school_id, student_id, blood_type, allergies, emergency_medical_notes, physician_name, physician_phone) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8)',
          id,
          tenant.schoolId,
          studentId,
          input.bloodType ?? null,
          JSON.stringify(input.allergies ?? []),
          input.emergencyMedicalNotes ?? null,
          input.physicianName ?? null,
          input.physicianPhone ?? null,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          'Student ' + studentId + ' already has a health record. Use PATCH to update.',
        );
      }
      throw err;
    }
    return this.getFullRecord(studentId, actor);
  }

  /**
   * Update an existing health record by student id. Nurse / admin
   * only. Field-by-field — non-supplied fields are left untouched.
   */
  async update(
    studentId: string,
    input: UpdateHealthRecordDto,
    actor: ResolvedActor,
  ): Promise<HealthRecordResponseDto> {
    if (!(await this.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses and admins can update health records');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.bloodType !== undefined) {
      sets.push('blood_type = $' + idx);
      params.push(input.bloodType);
      idx++;
    }
    if (input.allergies !== undefined) {
      sets.push('allergies = $' + idx + '::jsonb');
      params.push(JSON.stringify(input.allergies));
      idx++;
    }
    if (input.emergencyMedicalNotes !== undefined) {
      sets.push('emergency_medical_notes = $' + idx);
      params.push(input.emergencyMedicalNotes);
      idx++;
    }
    if (input.physicianName !== undefined) {
      sets.push('physician_name = $' + idx);
      params.push(input.physicianName);
      idx++;
    }
    if (input.physicianPhone !== undefined) {
      sets.push('physician_phone = $' + idx);
      params.push(input.physicianPhone);
      idx++;
    }
    if (sets.length === 0) return this.getFullRecord(studentId, actor);
    sets.push('updated_at = now()');
    params.push(studentId);

    const result = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$executeRawUnsafe(
        'UPDATE hlth_student_health_records SET ' +
          sets.join(', ') +
          ' WHERE student_id = $' +
          idx +
          '::uuid',
        ...params,
      );
    });
    if (result === 0) {
      throw new NotFoundException('No health record exists for student ' + studentId);
    }
    return this.getFullRecord(studentId, actor);
  }

  // ─── Compliance dashboard ────────────────────────────────────

  /**
   * School-wide immunisation compliance rollup. Admin-only. Returns
   * one row per vaccine_name with CURRENT / OVERDUE / WAIVED counts
   * across the school.
   */
  async getImmunisationCompliance(actor: ResolvedActor): Promise<ImmunisationComplianceRowDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only admins can read the school-wide immunisation compliance dashboard',
      );
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT i.vaccine_name, ' +
          'COUNT(*)::int AS total_rows, ' +
          "SUM(CASE WHEN i.status = 'CURRENT' THEN 1 ELSE 0 END)::int AS current_count, " +
          "SUM(CASE WHEN i.status = 'OVERDUE' THEN 1 ELSE 0 END)::int AS overdue_count, " +
          "SUM(CASE WHEN i.status = 'WAIVED' THEN 1 ELSE 0 END)::int AS waived_count " +
          'FROM hlth_immunisations i ' +
          'JOIN hlth_student_health_records r ON r.id = i.health_record_id ' +
          'WHERE r.school_id = $1::uuid ' +
          'GROUP BY i.vaccine_name ' +
          'ORDER BY overdue_count DESC, i.vaccine_name ASC',
        tenant.schoolId,
      )) as Array<{
        vaccine_name: string;
        total_rows: number;
        current_count: number;
        overdue_count: number;
        waived_count: number;
      }>;
      return rows.map((r) => ({
        vaccineName: r.vaccine_name,
        totalRows: r.total_rows,
        currentCount: r.current_count,
        overdueCount: r.overdue_count,
        waivedCount: r.waived_count,
      }));
    });
  }

  // ─── Internal helpers shared with ConditionService + ImmunisationService ──

  /** Resolves the health_record_id for a student. Throws 404 if none. */
  async loadRecordIdForStudent(studentId: string): Promise<string> {
    const id = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id FROM hlth_student_health_records WHERE student_id = $1::uuid LIMIT 1',
        studentId,
      )) as Array<{ id: string }>;
      return rows[0]?.id ?? null;
    });
    if (!id) {
      throw new NotFoundException('No health record exists for student ' + studentId);
    }
    return id;
  }

  async assertCanReadStudentExternal(
    studentId: string,
    actor: ResolvedActor,
  ): Promise<{ isManager: boolean }> {
    return this.assertCanReadStudent(studentId, actor);
  }

  async assertNurseScope(actor: ResolvedActor): Promise<void> {
    if (!(await this.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses and admins can mutate health data');
    }
  }

  conditionRowToDto(r: ConditionRow, isManager: boolean): ConditionResponseDto {
    return {
      id: r.id,
      healthRecordId: r.health_record_id,
      conditionName: r.condition_name,
      diagnosisDate: r.diagnosis_date,
      isActive: r.is_active,
      severity: r.severity as ConditionSeverity,
      // Strip management_plan for everyone who is not a manager —
      // teachers and parents both. The condition name + severity
      // suffices for the parent and classroom UI.
      managementPlan: isManager ? r.management_plan : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  immunisationRowToDto(r: ImmunisationRow): ImmunisationResponseDto {
    return {
      id: r.id,
      healthRecordId: r.health_record_id,
      vaccineName: r.vaccine_name,
      administeredDate: r.administered_date,
      dueDate: r.due_date,
      administeredBy: r.administered_by,
      status: r.status as ImmunisationStatus,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private recordRowToDto(
    r: RecordRow,
    conditions: ConditionResponseDto[],
    immunisations: ImmunisationResponseDto[],
    isManager: boolean,
    personType: string | null,
  ): HealthRecordResponseDto {
    const allergies = r.allergies ?? [];
    // Field strip per persona:
    // - Manager (nurse / admin) → everything.
    // - Parent (GUARDIAN) → full allergy details + immunisations
    //   inlined; emergency_medical_notes is staff-side procedural,
    //   stripped.
    // - Teacher (STAFF non-manager) → allergen + severity only,
    //   reaction + notes stripped for classroom safety alerts;
    //   emergency_medical_notes kept (teachers need evacuation
    //   awareness); physician contact stripped (not classroom-
    //   relevant); immunisations stripped (out of classroom scope).
    // - Anything else → defence in depth, treat as teacher view.
    let allergiesOut: AllergyEntryDto[];
    if (isManager || personType === 'GUARDIAN') {
      allergiesOut = allergies;
    } else {
      allergiesOut = allergies.map((a) => ({
        allergen: a.allergen,
        severity: a.severity,
        reaction: null,
        notes: null,
      }));
    }

    const includeEmergencyNotes = isManager || personType === 'STAFF';
    const includePhysician = isManager || personType === 'GUARDIAN';

    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentFirstName: r.student_first,
      studentLastName: r.student_last,
      bloodType: r.blood_type,
      allergies: allergiesOut,
      emergencyMedicalNotes: includeEmergencyNotes ? r.emergency_medical_notes : null,
      physicianName: includePhysician ? r.physician_name : null,
      physicianPhone: includePhysician ? r.physician_phone : null,
      conditions,
      immunisations,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
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
