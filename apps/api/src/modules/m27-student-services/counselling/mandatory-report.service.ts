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
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import {
  CreateMandatoryReportDto,
  ListMandatoryReportsQueryDto,
  MandatoryReportResponseDto,
  ReportStatus,
  ReportType,
  UpdateMandatoryReportDto,
} from './dto/counselling.dto';

interface ReportRow {
  id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  reporter_person_id: string;
  reporter_first: string | null;
  reporter_last: string | null;
  report_type: string;
  reported_to_authority: string;
  report_date: string;
  description: string;
  supporting_docs_s3_keys: string[] | null;
  cps_response: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const SELECT_REPORT_BASE =
  'SELECT r.id::text AS id, r.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'r.reporter_person_id::text AS reporter_person_id, ' +
  'rp.first_name AS reporter_first, rp.last_name AS reporter_last, ' +
  'r.report_type, r.reported_to_authority, ' +
  'TO_CHAR(r.report_date, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS report_date, ' +
  'r.description, r.supporting_docs_s3_keys, r.cps_response, r.status, ' +
  'TO_CHAR(r.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(r.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_mandatory_reports r ' +
  'JOIN sis_students s ON s.id = r.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = r.reporter_person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: ReportRow): MandatoryReportResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentFirstName: r.student_first,
    studentLastName: r.student_last,
    reporterPersonId: r.reporter_person_id,
    reporterName: fullName(r.reporter_first, r.reporter_last),
    reportType: r.report_type as ReportType,
    reportedToAuthority: r.reported_to_authority,
    reportDate: r.report_date,
    description: r.description,
    supportingDocsS3Keys: r.supporting_docs_s3_keys,
    cpsResponse: r.cps_response,
    status: r.status as ReportStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * MandatoryReportService — IMMUTABLE core fields after FILED.
 *
 * Service-side discipline. Once a report is past the initial FILED
 * status (or even at FILED — the M27 ERD says "immutable once filed"),
 * the description / report_type / reported_to_authority / report_date /
 * supporting_docs_s3_keys columns cannot be changed. Only `status` and
 * `cps_response` may be updated as the case evolves through
 * CPS_CONTACTED → INVESTIGATION_ACTIVE → CLOSED.
 *
 * The DTO `UpdateMandatoryReportDto` only exposes those two fields, so
 * a well-behaved client cannot accidentally send the immutable
 * columns. The global `ValidationPipe` with `forbidNonWhitelisted=true`
 * rejects any unknown property at the request layer. The service
 * additionally never builds an UPDATE statement for those columns.
 *
 * Reports are retained PERMANENTLY per the M27 ERD; the schema-side
 * NO ACTION FK on `student_id → sis_students(id)` enforces this by
 * refusing to delete a student with mandatory reports (admin must
 * archive the audit trail first).
 */
@Injectable()
export class MandatoryReportService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Lead-counsellor / admin scope: actors who hold cou-006:admin can
   * see + update every report in the school. Regular reporters
   * (cou-006:write holders) can only see their own filed reports.
   */
  private async hasAdminScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-006:admin',
    ]);
  }

  async list(
    query: ListMandatoryReportsQueryDto,
    actor: ResolvedActor,
  ): Promise<MandatoryReportResponseDto[]> {
    const isAdmin = await this.hasAdminScope(actor);
    const limit = Math.min(query.limit ?? 100, 200);
    const sql: string[] = [SELECT_REPORT_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (!isAdmin) {
      // Regular reporters see only their own filed reports.
      sql.push('AND r.reporter_person_id = $' + idx + '::uuid ');
      params.push(actor.personId);
      idx++;
    }
    if (query.status) {
      sql.push('AND r.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND r.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    sql.push('ORDER BY r.report_date DESC, r.created_at DESC LIMIT ' + limit);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReportRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<MandatoryReportResponseDto> {
    const isAdmin = await this.hasAdminScope(actor);
    const sql =
      SELECT_REPORT_BASE +
      'WHERE r.id = $1::uuid ' +
      (isAdmin ? '' : 'AND r.reporter_person_id = $2::uuid ');
    const params: unknown[] = [id];
    if (!isAdmin) params.push(actor.personId);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ReportRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Mandatory report ' + id);
    return rowToDto(rows[0]!);
  }

  /**
   * File a new report. Any employee with cou-006:write can file —
   * every staff member is a mandated reporter. Stamps
   * `reporter_person_id` from `actor.personId` so caller input on
   * that field would be a no-op anyway. Status starts at FILED.
   */
  async create(
    input: CreateMandatoryReportDto,
    actor: ResolvedActor,
  ): Promise<MandatoryReportResponseDto> {
    if (actor.personType !== 'STAFF' && !actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only staff with an iam_person record can file mandatory reports',
      );
    }
    // Validate student exists.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ ok: number }>;
      if (r.length === 0) throw new NotFoundException('Student ' + input.studentId);
    });
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO svc_mandatory_reports (id, student_id, reporter_person_id, report_type, ' +
          'reported_to_authority, report_date, description, supporting_docs_s3_keys, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, $7, $8::text[], 'FILED')",
        id,
        input.studentId,
        actor.personId,
        input.reportType,
        input.reportedToAuthority,
        input.reportDate,
        input.description,
        input.supportingDocsS3Keys ?? null,
      );
    });
    return this.getById(id, actor);
  }

  /**
   * Update mutable fields ONLY (status + cps_response). Refuses any
   * attempt to change the immutable core fields with a 400 — though
   * the DTO's whitelist already prevents the columns from arriving
   * here at all, this service-side guard is defense-in-depth in case
   * a future DTO refactor accidentally exposes them. Lead-counsellor
   * (cou-006:admin) or School Admin / Platform Admin only.
   */
  async patch(
    id: string,
    input: UpdateMandatoryReportDto,
    actor: ResolvedActor,
  ): Promise<MandatoryReportResponseDto> {
    if (!(await this.hasAdminScope(actor))) {
      throw new ForbiddenException(
        'Only the lead counsellor or admin can update mandatory reports',
      );
    }
    // Defense-in-depth: refuse any caller-supplied immutable column.
    // The DTO does not declare them, but this guard catches a future
    // refactor that drops the strict whitelist.
    const inputAny = input as unknown as Record<string, unknown>;
    const immutableFields = [
      'description',
      'reportType',
      'reportedToAuthority',
      'reportDate',
      'supportingDocsS3Keys',
      'studentId',
      'reporterPersonId',
    ];
    for (const f of immutableFields) {
      if (inputAny[f] !== undefined) {
        throw new BadRequestException(
          'Mandatory report core fields are immutable once filed. Only status and cpsResponse can be updated.',
        );
      }
    }
    const updates: string[] = [];
    const params: unknown[] = [id];
    let idx = 2;
    if (input.status !== undefined) {
      updates.push('status = $' + idx);
      params.push(input.status);
      idx++;
    }
    if (input.cpsResponse !== undefined) {
      updates.push('cps_response = $' + idx);
      params.push(input.cpsResponse);
      idx++;
    }
    if (updates.length === 0) {
      return this.getById(id, actor);
    }
    updates.push('updated_at = now()');
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = await client.$executeRawUnsafe(
        'UPDATE svc_mandatory_reports SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
      if (r === 0) throw new NotFoundException('Mandatory report ' + id);
    });
    return this.getById(id, actor);
  }
}
