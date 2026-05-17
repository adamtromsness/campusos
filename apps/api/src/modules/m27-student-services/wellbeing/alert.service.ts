import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import {
  AlertResponseDto,
  AlertStatus,
  AlertType,
  ListAlertsQueryDto,
  ResolveAlertDto,
} from './dto/wellbeing.dto';

interface AlertRow {
  id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  response_id: string;
  checkin_id: string | null;
  question_id: string | null;
  question_text: string | null;
  numeric_response: number | null;
  text_response: string | null;
  alert_type: string;
  status: string;
  acknowledged_by: string | null;
  acker_first: string | null;
  acker_last: string | null;
  acknowledged_at: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_ALERT_BASE =
  'SELECT a.id::text AS id, a.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, ' +
  'a.response_id::text AS response_id, ' +
  'r.checkin_id::text AS checkin_id, ' +
  'r.question_id::text AS question_id, q.question_text, ' +
  'r.numeric_response, r.text_response, ' +
  'a.alert_type, a.status, ' +
  'a.acknowledged_by::text AS acknowledged_by, ' +
  'ap.first_name AS acker_first, ap.last_name AS acker_last, ' +
  'TO_CHAR(a.acknowledged_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS acknowledged_at, ' +
  'a.resolution_notes, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM svc_wellbeing_alerts a ' +
  'JOIN sis_students s ON s.id = a.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN svc_wellbeing_responses r ON r.id = a.response_id ' +
  'LEFT JOIN svc_wellbeing_questions q ON q.id = r.question_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = a.acknowledged_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToDto(r: AlertRow): AlertResponseDto {
  // Build a short response preview for the queue UI: numeric responses
  // render as "<n>" (the question text supplies context); text responses
  // render the first 80 chars.
  let preview: string | null = null;
  if (r.numeric_response !== null) {
    preview = String(r.numeric_response);
  } else if (r.text_response) {
    preview = r.text_response.slice(0, 80);
  }
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: fullName(r.student_first, r.student_last),
    responseId: r.response_id,
    checkinId: r.checkin_id,
    questionId: r.question_id,
    questionText: r.question_text,
    responsePreview: preview,
    alertType: r.alert_type as AlertType,
    status: r.status as AlertStatus,
    acknowledgedById: r.acknowledged_by,
    acknowledgedByName: fullName(r.acker_first, r.acker_last),
    acknowledgedAt: r.acknowledged_at,
    resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class AlertService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope: admin OR holds cou-004:write — same canonical
   * counsellor signal across the wellbeing services. AlertService is
   * counsellor + admin only at the service layer; teachers and
   * students never reach the alert surface (the controller gate is
   * cou-004:read but the service-layer check below 403s teachers and
   * students explicitly).
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'cou-004:write',
    ]);
  }

  /**
   * Visibility model for alerts:
   *   - Admin                                  → all alerts in tenant.
   *   - Counsellor (STAFF + cou-004:write)     → alerts for students
   *                                              on own ACTIVE
   *                                              caseloads.
   *   - Teacher / Student / Parent / unknown    → 403 at the service
   *                                              layer. Alerts are
   *                                              counsellor + admin
   *                                              only (the Step 6 UI
   *                                              renders aggregate
   *                                              counts for teachers
   *                                              via a future trend
   *                                              endpoint, not by
   *                                              reading this surface).
   */
  async list(query: ListAlertsQueryDto, actor: ResolvedActor): Promise<AlertResponseDto[]> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Wellbeing alerts are counsellor + admin only. Teachers see aggregated trends only.',
      );
    }
    const limit = Math.min(query.limit ?? 100, 200);
    const sql: string[] = [SELECT_ALERT_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;

    if (!actor.isSchoolAdmin) {
      if (!actor.employeeId) return [];
      sql.push(
        'AND a.student_id IN (' +
          'SELECT student_id FROM svc_caseloads WHERE counselor_id = $' +
          idx +
          "::uuid AND status = 'ACTIVE') ",
      );
      params.push(actor.employeeId);
      idx++;
    }

    if (query.status) {
      sql.push('AND a.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.alertType) {
      sql.push('AND a.alert_type = $' + idx + ' ');
      params.push(query.alertType);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND a.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }

    sql.push(
      'ORDER BY CASE a.alert_type ' +
        "WHEN 'SELF_HARM_INDICATOR' THEN 0 " +
        "WHEN 'FEELS_UNSAFE' THEN 1 " +
        "WHEN 'WANTS_TO_TALK' THEN 2 " +
        "WHEN 'SIGNIFICANT_SCORE_DROP' THEN 3 " +
        'ELSE 4 END, ' +
        'a.created_at DESC LIMIT ' +
        limit,
    );

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertRow[]>(sql.join(''), ...params);
    });
    return rows.map(rowToDto);
  }

  async getById(id: string, actor: ResolvedActor): Promise<AlertResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Wellbeing alerts are counsellor + admin only. Teachers see aggregated trends only.',
      );
    }
    return this.loadOrFail(id, actor);
  }

  /**
   * NEW → ACKNOWLEDGED. Stamps acknowledged_by + acknowledged_at
   * atomically inside one tenant tx so the multi-column
   * acknowledged_chk lockstep is satisfied. Counsellors can only
   * acknowledge alerts for students on their own ACTIVE caseload —
   * the service layer enforces this via loadOrFail before the lock.
   */
  async acknowledge(id: string, actor: ResolvedActor): Promise<AlertResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Wellbeing alerts are counsellor + admin only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Acknowledger must have an employee record');
    }
    // Pre-flight visibility check (also gives the friendly 404 for
    // counsellors trying to ack alerts outside their caseload).
    await this.loadOrFail(id, actor);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_wellbeing_alerts WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Alert ' + id);
      if (lockRows[0]!.status !== 'NEW') {
        throw new BadRequestException(
          'Alert is in status ' + lockRows[0]!.status + '; only NEW alerts can be acknowledged',
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE svc_wellbeing_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $2::uuid, " +
          'acknowledged_at = now(), updated_at = now() WHERE id = $1::uuid',
        id,
        actor.employeeId,
      );
    });
    return this.loadOrFail(id, actor);
  }

  /**
   * Any non-RESOLVED state → RESOLVED with required resolution_notes.
   * If the alert is still NEW (skip-acknowledge fast path), stamps
   * acknowledged_by + acknowledged_at on the same UPDATE so the
   * lockstep CHECK is satisfied — the audit captures who closed the
   * alert even when the counsellor went straight from NEW to RESOLVED.
   */
  async resolve(
    id: string,
    input: ResolveAlertDto,
    actor: ResolvedActor,
  ): Promise<AlertResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Wellbeing alerts are counsellor + admin only');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Resolver must have an employee record');
    }
    await this.loadOrFail(id, actor);

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM svc_wellbeing_alerts WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Alert ' + id);
      if (lockRows[0]!.status === 'RESOLVED') {
        throw new BadRequestException('Alert is already RESOLVED');
      }
      // Single UPDATE that stamps every required column for the
      // acknowledged_chk lockstep — works whether the alert was
      // already ACKNOWLEDGED (the COALESCE preserves the original
      // ack timestamp) or still NEW (stamps fresh ack values).
      await tx.$executeRawUnsafe(
        "UPDATE svc_wellbeing_alerts SET status = 'RESOLVED', " +
          'resolution_notes = $2, ' +
          'acknowledged_by = COALESCE(acknowledged_by, $3::uuid), ' +
          'acknowledged_at = COALESCE(acknowledged_at, now()), ' +
          'updated_at = now() WHERE id = $1::uuid',
        id,
        input.resolutionNotes,
        actor.employeeId,
      );
    });
    return this.loadOrFail(id, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<AlertResponseDto> {
    const sql: string[] = [SELECT_ALERT_BASE, 'WHERE a.id = $1::uuid '];
    const params: unknown[] = [id];
    let idx = 2;
    if (!actor.isSchoolAdmin) {
      if (!actor.employeeId) throw new NotFoundException('Alert ' + id);
      sql.push(
        'AND a.student_id IN (' +
          'SELECT student_id FROM svc_caseloads WHERE counselor_id = $' +
          idx +
          "::uuid AND status = 'ACTIVE') ",
      );
      params.push(actor.employeeId);
      idx++;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AlertRow[]>(sql.join(''), ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Alert ' + id);
    return rowToDto(rows[0]!);
  }
}
