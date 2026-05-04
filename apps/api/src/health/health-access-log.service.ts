import { ForbiddenException, Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogRowDto, HealthAccessType, ListAccessLogQueryDto } from './dto/health.dto';

interface AccessLogRow {
  id: string;
  school_id: string;
  accessed_by: string;
  accessed_by_first: string | null;
  accessed_by_last: string | null;
  accessed_by_email: string | null;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  access_type: string;
  ip_address: string | null;
  accessed_at: string;
}

const SELECT_LOG_BASE =
  'SELECT l.id::text AS id, l.school_id::text AS school_id, ' +
  'l.accessed_by::text AS accessed_by, ' +
  'pip.first_name AS accessed_by_first, pip.last_name AS accessed_by_last, ' +
  'pu.email AS accessed_by_email, ' +
  'l.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'l.access_type, l.ip_address, ' +
  'TO_CHAR(l.accessed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS accessed_at ' +
  'FROM hlth_health_access_log l ' +
  'LEFT JOIN platform.platform_users pu ON pu.id = l.accessed_by ' +
  'LEFT JOIN platform.iam_person pip ON pip.id = pu.person_id ' +
  'JOIN sis_students s ON s.id = l.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * HealthAccessLogService — Cycle 10 Step 5.
 *
 * The canonical writer to `hlth_health_access_log`. Every Step 5 / 6 / 7
 * health-read endpoint calls `recordAccess(actor, studentId, accessType)`
 * AFTER the row-scope check passes and BEFORE the response body leaves
 * the server. The schema is IMMUTABLE per ADR-010 — this service has
 * no UPDATE or DELETE method and no admin endpoint exposes them.
 *
 * The 9-value access_type enum covers every per-domain read shape so the
 * audit query can filter and group by domain. EXPORT is reserved for
 * future bulk export endpoints; Cycle 10 ships none.
 *
 * The admin GET /health/access-log endpoint is gated on `hlt-001:admin`
 * (held by School Admin and Platform Admin via the `everyFunction`
 * grant). It is the only read path.
 */
@Injectable()
export class HealthAccessLogService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Append-only audit write. Called by every Step 5 / 6 / 7 health-read
   * service after the data is fetched and the row-scope check has passed.
   * Throws on insert failure so the controller can fail-closed (a
   * successful read is never sent to the client without a successful
   * audit row).
   */
  async recordAccess(
    actor: ResolvedActor,
    studentId: string,
    accessType: HealthAccessType,
    ipAddress: string | null = null,
  ): Promise<void> {
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_health_access_log ' +
          '(id, school_id, accessed_by, student_id, access_type, ip_address) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)',
        id,
        tenant.schoolId,
        actor.accountId,
        studentId,
        accessType,
        ipAddress,
      );
    });
  }

  /**
   * Paginated audit list. Admin-only.
   */
  async list(query: ListAccessLogQueryDto, actor: ResolvedActor): Promise<HealthAccessLogRowDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can read the health access log');
    }
    const limit = Math.min(query.limit ?? 100, 500);
    const sql: string[] = [SELECT_LOG_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (query.studentId) {
      sql.push('AND l.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    if (query.accessedBy) {
      sql.push('AND l.accessed_by = $' + idx + '::uuid ');
      params.push(query.accessedBy);
      idx++;
    }
    if (query.accessType) {
      sql.push('AND l.access_type = $' + idx + ' ');
      params.push(query.accessType);
      idx++;
    }
    if (query.fromDate) {
      sql.push('AND l.accessed_at >= $' + idx + '::timestamptz ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND l.accessed_at <= $' + idx + '::timestamptz ');
      params.push(query.toDate);
      idx++;
    }
    sql.push('ORDER BY l.accessed_at DESC LIMIT ' + limit);

    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(sql.join(''), ...params)) as AccessLogRow[];
      return rows.map((r) => ({
        id: r.id,
        schoolId: r.school_id,
        accessedById: r.accessed_by,
        accessedByName: fullName(r.accessed_by_first, r.accessed_by_last),
        accessedByEmail: r.accessed_by_email,
        studentId: r.student_id,
        studentName: fullName(r.student_first, r.student_last),
        accessType: r.access_type as HealthAccessType,
        ipAddress: r.ip_address,
        accessedAt: r.accessed_at,
      }));
    });
  }
}
