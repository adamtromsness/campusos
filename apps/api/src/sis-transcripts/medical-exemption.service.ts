import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { PermissionCheckService } from '../iam/permission-check.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  MEDICAL_EXEMPTION_TYPES,
  type CreateMedicalExemptionDto,
  type MedicalExemptionDto,
  type MedicalExemptionType,
  type PatchMedicalExemptionDto,
} from './dto/sis-transcripts.dto';

interface ExemptionRow {
  id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  exemption_type: string;
  reason: string;
  doctor_note_s3_key: string | null;
  effective_from: string;
  effective_to: string | null;
  approved_by: string | null;
  approved_by_first_name: string | null;
  approved_by_last_name: string | null;
  approved_at: string | null;
}

/**
 * Medical Exemption Service.
 *
 * Row scope:
 *   - Staff / admin (stu-001:write) — read + write any.
 *   - STUDENT — own only.
 *   - GUARDIAN — linked children via sis_student_guardians.
 */
@Injectable()
export class MedicalExemptionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: ExemptionRow): MedicalExemptionDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName:
        r.student_first_name && r.student_last_name
          ? `${r.student_first_name} ${r.student_last_name}`
          : null,
      exemptionType: r.exemption_type as MedicalExemptionType,
      reason: r.reason,
      doctorNoteS3Key: r.doctor_note_s3_key,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
      approvedBy: r.approved_by,
      approvedByName:
        r.approved_by_first_name && r.approved_by_last_name
          ? `${r.approved_by_first_name} ${r.approved_by_last_name}`
          : null,
      approvedAt: r.approved_at,
    };
  }

  private async hasStaffScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-001:write',
      'stu-001:admin',
    ]);
  }

  private async assertStaff(actor: ResolvedActor): Promise<void> {
    if (!(await this.hasStaffScope(actor))) {
      throw new ForbiddenException('Only staff or admins can manage medical exemptions.');
    }
  }

  private async resolveOwnStudentId(actor: ResolvedActor): Promise<string | null> {
    if (actor.personType !== 'STUDENT') return null;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT s.id::text AS id FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE ps.person_id = $1::uuid LIMIT 1',
        actor.personId,
      );
      return rows[0]?.id ?? null;
    });
  }

  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (await this.hasStaffScope(actor)) return;
    if (actor.personType === 'STUDENT') {
      const ownId = await this.resolveOwnStudentId(actor);
      if (ownId === studentId) return;
      throw new NotFoundException('Student not found');
    }
    if (actor.personType === 'GUARDIAN') {
      const linked = await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        ),
      );
      if (linked.length > 0) return;
      throw new NotFoundException('Student not found');
    }
    throw new NotFoundException('Student not found');
  }

  /**
   * REVIEW-P2C13 MAJOR 1 — SELECT base now joins sis_students with an
   * inner join. Every read carries `s.school_id = tenant.schoolId`
   * so cross-school exemption UUIDs collapse to 0 rows.
   */
  private buildSelectBase(): string {
    return (
      'SELECT e.id::text, e.student_id::text, ' +
      'sip.first_name AS student_first_name, sip.last_name AS student_last_name, ' +
      'e.exemption_type, e.reason, e.doctor_note_s3_key, ' +
      'e.effective_from::text, e.effective_to::text, ' +
      'e.approved_by::text, ' +
      'ap.first_name AS approved_by_first_name, ap.last_name AS approved_by_last_name, ' +
      'e.approved_at::text ' +
      'FROM sis_medical_exemption_records e ' +
      'JOIN sis_students s ON s.id = e.student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person sip ON sip.id = ps.person_id ' +
      'LEFT JOIN platform.iam_person ap ON ap.id = e.approved_by '
    );
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<MedicalExemptionDto[]> {
    await this.assertCanReadStudent(studentId, actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ExemptionRow[]>(
        this.buildSelectBase() +
          'WHERE e.student_id = $1::uuid AND s.school_id = $2::uuid ' +
          'ORDER BY e.effective_from DESC',
        studentId,
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async create(dto: CreateMedicalExemptionDto, actor: ResolvedActor): Promise<MedicalExemptionDto> {
    await this.assertStaff(actor);
    if (!MEDICAL_EXEMPTION_TYPES.includes(dto.exemptionType)) {
      throw new BadRequestException(
        `exemptionType must be one of ${MEDICAL_EXEMPTION_TYPES.join(', ')}`,
      );
    }
    if (dto.effectiveTo && new Date(dto.effectiveTo) < new Date(dto.effectiveFrom)) {
      throw new BadRequestException('effectiveTo must be >= effectiveFrom');
    }
    const tenant = getCurrentTenant();
    const studentRows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ ok: number }>>(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        dto.studentId,
        tenant.schoolId,
      ),
    );
    if (studentRows.length === 0) {
      throw new BadRequestException('studentId does not match a student in this school');
    }
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_medical_exemption_records (id, student_id, exemption_type, reason, ' +
          'doctor_note_s3_key, effective_from, effective_to, approved_by, approved_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8::uuid, now())',
        id,
        dto.studentId,
        dto.exemptionType,
        dto.reason,
        dto.doctorNoteS3Key ?? null,
        dto.effectiveFrom,
        dto.effectiveTo ?? null,
        actor.personId,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ExemptionRow[]>(
        this.buildSelectBase() + 'WHERE e.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async patch(
    id: string,
    dto: PatchMedicalExemptionDto,
    actor: ResolvedActor,
  ): Promise<MedicalExemptionDto> {
    await this.assertStaff(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // REVIEW-P2C13 MAJOR 1 — lock joins sis_students with the school
      // predicate baked in; a foreign-school exemption UUID returns 0
      // rows and collapses to 404 don't-leak-existence.
      const rows = await tx.$queryRawUnsafe<
        Array<{ effective_from: string; effective_to: string | null }>
      >(
        'SELECT e.effective_from::text, e.effective_to::text ' +
          'FROM sis_medical_exemption_records e ' +
          'JOIN sis_students s ON s.id = e.student_id ' +
          'WHERE e.id = $1::uuid AND s.school_id = $2::uuid FOR UPDATE OF e',
        id,
        tenant.schoolId,
      );
      if (rows.length === 0) throw new NotFoundException('Exemption not found');
      const row = rows[0]!;
      const effFrom = dto.effectiveFrom ?? row.effective_from;
      const effTo =
        dto.effectiveTo === undefined
          ? row.effective_to
          : dto.effectiveTo === null
            ? null
            : dto.effectiveTo;
      if (effTo && new Date(effTo) < new Date(effFrom)) {
        throw new BadRequestException('effectiveTo must be >= effectiveFrom');
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      let next = 1;
      if (dto.reason !== undefined) {
        sets.push(`reason = $${next}`);
        params.push(dto.reason);
        next += 1;
      }
      if (dto.doctorNoteS3Key !== undefined) {
        sets.push(`doctor_note_s3_key = $${next}`);
        params.push(dto.doctorNoteS3Key);
        next += 1;
      }
      if (dto.effectiveFrom !== undefined) {
        sets.push(`effective_from = $${next}::date`);
        params.push(dto.effectiveFrom);
        next += 1;
      }
      if (dto.effectiveTo !== undefined) {
        sets.push(`effective_to = $${next}::date`);
        params.push(dto.effectiveTo);
        next += 1;
      }
      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);
      params.push(tenant.schoolId);
      // Defence-in-depth — UPDATE carries the school predicate via
      // subselect so even if the locked row pre-check is bypassed by a
      // future refactor, the final UPDATE still cannot touch a foreign
      // school's row.
      await tx.$executeRawUnsafe(
        `UPDATE sis_medical_exemption_records SET ${sets.join(', ')} ` +
          `WHERE id = $${next}::uuid ` +
          `AND student_id IN (SELECT s.id FROM sis_students s WHERE s.school_id = $${next + 1}::uuid)`,
        ...params,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<ExemptionRow[]>(
        this.buildSelectBase() + 'WHERE e.id = $1::uuid AND s.school_id = $2::uuid LIMIT 1',
        id,
        tenant.schoolId,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertStaff(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ school_id: string }>>(
        'SELECT s.school_id::text AS school_id FROM sis_medical_exemption_records e ' +
          'JOIN sis_students s ON s.id = e.student_id WHERE e.id = $1::uuid LIMIT 1',
        id,
      ),
    );
    if (rows.length === 0 || rows[0]!.school_id !== tenant.schoolId) {
      throw new NotFoundException('Exemption not found');
    }
    // REVIEW-P2C13 MAJOR 1 — DELETE carries the school predicate via
    // subselect so even if the school check above is short-circuited
    // the SQL still refuses to touch a foreign-school row.
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'DELETE FROM sis_medical_exemption_records WHERE id = $1::uuid ' +
          'AND student_id IN (SELECT s.id FROM sis_students s WHERE s.school_id = $2::uuid)',
        id,
        tenant.schoolId,
      ),
    );
  }
}
