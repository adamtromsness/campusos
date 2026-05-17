import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import {
  AWARD_TYPES,
  type AwardType,
  type BulkHonorRollDto,
  type BulkHonorRollResponseDto,
  type CreateStudentAwardDto,
  type StudentAwardDto,
} from '../transcripts/dto/sis-transcripts.dto';

interface AwardRow {
  id: string;
  student_id: string;
  student_first_name: string | null;
  student_last_name: string | null;
  award_type: string;
  award_name: string;
  academic_year: string | null;
  term: string | null;
  awarded_by: string | null;
  awarded_by_first_name: string | null;
  awarded_by_last_name: string | null;
  awarded_at: string;
  certificate_s3_key: string | null;
  description: string | null;
}

/**
 * Student Award Service.
 *
 * `bulkHonorRoll()` reads sis_student_gpa_snapshots for the supplied
 * academic_year + term and awards every qualifying student in a single
 * tenant tx. Idempotent — students already holding a HONOR_ROLL award
 * with the matching (academic_year, term) name are skipped.
 */
@Injectable()
export class StudentAwardService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  private rowToDto(r: AwardRow): StudentAwardDto {
    return {
      id: r.id,
      studentId: r.student_id,
      studentName:
        r.student_first_name && r.student_last_name
          ? `${r.student_first_name} ${r.student_last_name}`
          : null,
      awardType: r.award_type as AwardType,
      awardName: r.award_name,
      academicYear: r.academic_year,
      term: r.term,
      awardedBy: r.awarded_by,
      awardedByName:
        r.awarded_by_first_name && r.awarded_by_last_name
          ? `${r.awarded_by_first_name} ${r.awarded_by_last_name}`
          : null,
      awardedAt: r.awarded_at,
      certificateS3Key: r.certificate_s3_key,
      description: r.description,
    };
  }

  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-005:write',
      'stu-005:admin',
    ]);
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException('Only staff or admins can manage student awards.');
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
    if (await this.hasAdminScope(actor)) return;
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

  private buildSelectBase(): string {
    return (
      'SELECT a.id::text, a.student_id::text, ' +
      'sip.first_name AS student_first_name, sip.last_name AS student_last_name, ' +
      'a.award_type, a.award_name, a.academic_year, a.term, ' +
      'a.awarded_by::text, ' +
      'ap.first_name AS awarded_by_first_name, ap.last_name AS awarded_by_last_name, ' +
      'a.awarded_at::text, a.certificate_s3_key, a.description ' +
      'FROM sis_student_awards a ' +
      'LEFT JOIN sis_students s ON s.id = a.student_id ' +
      'LEFT JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'LEFT JOIN platform.iam_person sip ON sip.id = ps.person_id ' +
      'LEFT JOIN platform.iam_person ap ON ap.id = a.awarded_by '
    );
  }

  async listForStudent(studentId: string, actor: ResolvedActor): Promise<StudentAwardDto[]> {
    await this.assertCanReadStudent(studentId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AwardRow[]>(
        this.buildSelectBase() + 'WHERE a.student_id = $1::uuid ORDER BY a.awarded_at DESC',
        studentId,
      ),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async create(dto: CreateStudentAwardDto, actor: ResolvedActor): Promise<StudentAwardDto> {
    await this.assertAdmin(actor);
    if (!AWARD_TYPES.includes(dto.awardType)) {
      throw new BadRequestException(`awardType must be one of ${AWARD_TYPES.join(', ')}`);
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
        'INSERT INTO sis_student_awards (id, student_id, award_type, award_name, academic_year, ' +
          'term, awarded_by, awarded_at, certificate_s3_key, description) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, current_date, $8, $9)',
        id,
        dto.studentId,
        dto.awardType,
        dto.awardName,
        dto.academicYear ?? null,
        dto.term ?? null,
        actor.personId,
        dto.certificateS3Key ?? null,
        dto.description ?? null,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AwardRow[]>(
        this.buildSelectBase() + 'WHERE a.id = $1::uuid LIMIT 1',
        id,
      ),
    );
    return this.rowToDto(rows[0]!);
  }

  async bulkHonorRoll(
    dto: BulkHonorRollDto,
    actor: ResolvedActor,
  ): Promise<BulkHonorRollResponseDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const awardName = dto.awardName ?? `${dto.term} Honor Roll`;

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Read the qualifying students.
      const studentFilter =
        dto.studentIds && dto.studentIds.length > 0 ? ' AND snap.student_id = ANY($3::uuid[])' : '';
      const candidates = await tx.$queryRawUnsafe<Array<{ student_id: string }>>(
        'SELECT DISTINCT snap.student_id::text AS student_id ' +
          'FROM sis_student_gpa_snapshots snap ' +
          'JOIN sis_students s ON s.id = snap.student_id ' +
          'WHERE s.school_id = $1::uuid AND snap.cumulative_gpa >= $2::numeric' +
          studentFilter,
        tenant.schoolId,
        dto.gpaThreshold.toFixed(3),
        ...(dto.studentIds && dto.studentIds.length > 0 ? [dto.studentIds] : []),
      );

      const awardIds: string[] = [];
      let skipped = 0;
      for (const c of candidates) {
        const dupes = await tx.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_awards ' +
            "WHERE student_id = $1::uuid AND award_type = 'HONOR_ROLL' " +
            'AND academic_year = $2 AND COALESCE(term, $3) = $3 ' +
            'LIMIT 1',
          c.student_id,
          dto.academicYear,
          dto.term,
        );
        if (dupes.length > 0) {
          skipped += 1;
          continue;
        }
        const id = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO sis_student_awards (id, student_id, award_type, award_name, academic_year, ' +
            'term, awarded_by, awarded_at, description) ' +
            "VALUES ($1::uuid, $2::uuid, 'HONOR_ROLL', $3, $4, $5, $6::uuid, current_date, $7)",
          id,
          c.student_id,
          awardName,
          dto.academicYear,
          dto.term,
          actor.personId,
          `Auto-awarded for GPA >= ${dto.gpaThreshold} during ${dto.term}.`,
        );
        awardIds.push(id);
      }

      return { awarded: awardIds.length, skipped, awardIds };
    });
    return result;
  }

  async delete(id: string, actor: ResolvedActor): Promise<void> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ school_id: string }>>(
        'SELECT s.school_id::text AS school_id FROM sis_student_awards a ' +
          'JOIN sis_students s ON s.id = a.student_id WHERE a.id = $1::uuid LIMIT 1',
        id,
      ),
    );
    if (rows.length === 0 || rows[0]!.school_id !== tenant.schoolId) {
      throw new NotFoundException('Award not found');
    }
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe('DELETE FROM sis_student_awards WHERE id = $1::uuid', id),
    );
  }
}
