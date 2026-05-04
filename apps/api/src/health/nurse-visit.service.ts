import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { HealthAccessLogService } from './health-access-log.service';
import { HealthRecordService } from './health-record.service';
import {
  CreateNurseVisitDto,
  ListNurseVisitsQueryDto,
  NurseVisitResponseDto,
  NurseVisitStatus,
  UpdateNurseVisitDto,
  VisitedPersonType,
} from './dto/health.dto';

interface VisitRow {
  id: string;
  school_id: string;
  visited_person_id: string;
  visited_person_type: string;
  visited_person_name: string | null;
  nurse_id: string | null;
  nurse_first: string | null;
  nurse_last: string | null;
  visit_date: string;
  status: string;
  signed_in_at: string;
  signed_out_at: string | null;
  reason: string | null;
  treatment_given: string | null;
  parent_notified: boolean;
  sent_home: boolean;
  sent_home_at: string | null;
  follow_up_required: boolean;
  follow_up_notes: string | null;
  follow_up_date: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_VISIT_BASE =
  'SELECT v.id::text AS id, v.school_id::text AS school_id, ' +
  'v.visited_person_id::text AS visited_person_id, ' +
  'v.visited_person_type, ' +
  // Resolve display name across STUDENT (sis_students -> platform_students -> iam_person)
  // and STAFF (hr_employees -> iam_person) via two LEFT JOINs and COALESCE.
  "COALESCE(sip.first_name || ' ' || sip.last_name, eip.first_name || ' ' || eip.last_name) AS visited_person_name, " +
  'v.nurse_id::text AS nurse_id, ' +
  'nip.first_name AS nurse_first, nip.last_name AS nurse_last, ' +
  'TO_CHAR(v.visit_date, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS visit_date, ' +
  'v.status, ' +
  'TO_CHAR(v.signed_in_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS signed_in_at, ' +
  'TO_CHAR(v.signed_out_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS signed_out_at, ' +
  'v.reason, v.treatment_given, v.parent_notified, v.sent_home, ' +
  'TO_CHAR(v.sent_home_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS sent_home_at, ' +
  'v.follow_up_required, v.follow_up_notes, ' +
  "TO_CHAR(v.follow_up_date, 'YYYY-MM-DD') AS follow_up_date, " +
  'TO_CHAR(v.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(v.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM hlth_nurse_visits v ' +
  // Student name path
  "LEFT JOIN sis_students s ON s.id = v.visited_person_id AND v.visited_person_type = 'STUDENT' " +
  'LEFT JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'LEFT JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  // Staff name path
  "LEFT JOIN hr_employees e ON e.id = v.visited_person_id AND v.visited_person_type = 'STAFF' " +
  'LEFT JOIN platform.iam_person eip ON eip.id = e.person_id ' +
  // Nurse name path
  'LEFT JOIN hr_employees ne ON ne.id = v.nurse_id ' +
  'LEFT JOIN platform.iam_person nip ON nip.id = ne.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

/**
 * NurseVisitService — Cycle 10 Step 7.
 *
 * Live nurse-office surface. Admin / nurse only — gated on
 * `hlt-003:read` / `hlt-003:write` at the controller. The Step 7
 * plan reserves nurse visits to the staff tier; parents see visits
 * via the future Step 9 parent health summary, not this service.
 *
 * Endpoints:
 *   - GET /health/nurse-visits           list with status / from / to filters
 *   - GET /health/nurse-visits/roster    live IN_PROGRESS roster
 *   - POST /health/nurse-visits          sign in a student / staff
 *   - PATCH /health/nurse-visits/:id     update treatment + flags + sign out
 *
 * The signed_chk and sent_home_chk multi-column CHECKs from Step 3
 * are the schema-side belt-and-braces; this service stamps the
 * dependent timestamps in lockstep with the boolean flags so the
 * row never lands in an invariant-breaking shape.
 *
 * Emits hlth.nurse_visit.sent_home when sent_home flips false → true
 * for the future Cycle 3 NotificationConsumer to fan out parent
 * notifications.
 */
@Injectable()
export class NurseVisitService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly accessLog: HealthAccessLogService,
    private readonly records: HealthRecordService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(
    query: ListNurseVisitsQueryDto,
    actor: ResolvedActor,
  ): Promise<NurseVisitResponseDto[]> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException(
        'Nurse visits are visible to nurses, counsellors, and admins only',
      );
    }
    const tenant = getCurrentTenant();
    const limit = Math.min(query.limit ?? 100, 500);
    const sql: string[] = [SELECT_VISIT_BASE, 'WHERE v.school_id = $1::uuid '];
    const params: unknown[] = [tenant.schoolId];
    let idx = 2;
    if (query.status) {
      sql.push('AND v.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.fromDate) {
      sql.push('AND v.visit_date >= $' + idx + '::timestamptz ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND v.visit_date <= $' + idx + '::timestamptz ');
      params.push(query.toDate);
      idx++;
    }
    sql.push('ORDER BY v.visit_date DESC LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(sql.join(''), ...params)) as VisitRow[];
    });

    // Audit-log per visited STUDENT (not STAFF — STAFF visits aren't PHI of a student).
    const studentIds = new Set<string>();
    for (const r of rows) {
      if (r.visited_person_type === 'STUDENT') studentIds.add(r.visited_person_id);
    }
    for (const sid of studentIds) {
      await this.accessLog.recordAccess(actor, sid, 'VIEW_VISITS');
    }
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Per-student visit history. Gated on hlt-001:read so parents
   * (GUARDIAN row-scope via `assertCanReadStudentExternal`) and
   * nurses can both reach it. Filters STUDENT visits only since the
   * row is keyed on a `sis_students` id; STAFF visits live under
   * the broader admin-only `list` path.
   */
  async listForStudent(studentId: string, actor: ResolvedActor): Promise<NurseVisitResponseDto[]> {
    await this.records.assertCanReadStudentExternal(studentId, actor);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_VISIT_BASE +
          "WHERE v.visited_person_id = $1::uuid AND v.visited_person_type = 'STUDENT' " +
          'ORDER BY v.visit_date DESC LIMIT 100',
        studentId,
      )) as VisitRow[];
    });
    await this.accessLog.recordAccess(actor, studentId, 'VIEW_VISITS');
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Live nurse-office roster — students/staff currently IN_PROGRESS.
   * Hits the partial INDEX on (school_id, status) WHERE status='IN_PROGRESS'.
   */
  async roster(actor: ResolvedActor): Promise<NurseVisitResponseDto[]> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException(
        'The nurse office roster is visible to nurses, counsellors, and admins only',
      );
    }
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_VISIT_BASE +
          "WHERE v.school_id = $1::uuid AND v.status = 'IN_PROGRESS' ORDER BY v.signed_in_at ASC",
        tenant.schoolId,
      )) as VisitRow[];
    });
    return rows.map((r) => this.rowToDto(r));
  }

  /**
   * Sign in a student / staff. Defaults to STUDENT visited_person_type.
   * Validates the soft polymorphic ref against sis_students or
   * hr_employees per type before INSERT.
   */
  async create(input: CreateNurseVisitDto, actor: ResolvedActor): Promise<NurseVisitResponseDto> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses, counsellors, and admins can sign in a visit');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException(
        'Recording staff member must have an employee record (no hr_employees row)',
      );
    }
    const visitedType = input.visitedPersonType ?? 'STUDENT';
    await this.assertVisitedRefValid(visitedType, input.visitedPersonId);

    const id = generateId();
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO hlth_nurse_visits ' +
          '(id, school_id, visited_person_id, visited_person_type, nurse_id, visit_date, status, signed_in_at, reason) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, now(), 'IN_PROGRESS', now(), $6)",
        id,
        tenant.schoolId,
        input.visitedPersonId,
        visitedType,
        actor.employeeId,
        input.reason ?? null,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Update a visit — treatment, parent notification, sent home, follow-up,
   * sign out. Locks the row FOR UPDATE inside a transaction so signed_chk
   * and sent_home_chk lockstep is atomic. Emits hlth.nurse_visit.sent_home
   * when sent_home flips false → true.
   */
  async update(
    id: string,
    input: UpdateNurseVisitDto,
    actor: ResolvedActor,
  ): Promise<NurseVisitResponseDto> {
    if (!(await this.records.hasNurseScope(actor))) {
      throw new ForbiddenException('Only nurses, counsellors, and admins can update a visit');
    }
    let prevSentHome = false;
    let visitedPersonId = '';
    let visitedPersonType = 'STUDENT';

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT visited_person_id::text AS visited_person_id, visited_person_type, ' +
          'sent_home, status FROM hlth_nurse_visits WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{
        visited_person_id: string;
        visited_person_type: string;
        sent_home: boolean;
        status: string;
      }>;
      if (lockRows.length === 0) throw new NotFoundException('Nurse visit ' + id);
      const cur = lockRows[0]!;
      prevSentHome = cur.sent_home;
      visitedPersonId = cur.visited_person_id;
      visitedPersonType = cur.visited_person_type;

      const sets: string[] = [];
      const params: unknown[] = [];
      let idx = 1;
      if (input.reason !== undefined) {
        sets.push('reason = $' + idx);
        params.push(input.reason);
        idx++;
      }
      if (input.treatmentGiven !== undefined) {
        sets.push('treatment_given = $' + idx);
        params.push(input.treatmentGiven);
        idx++;
      }
      if (input.parentNotified !== undefined) {
        sets.push('parent_notified = $' + idx);
        params.push(input.parentNotified);
        idx++;
      }
      if (input.sentHome !== undefined) {
        sets.push('sent_home = $' + idx);
        params.push(input.sentHome);
        idx++;
        // Lockstep with sent_home_chk: when sent_home flips true the
        // schema requires sent_home_at NOT NULL; when false it requires
        // NULL. Stamp / clear in the same UPDATE.
        if (input.sentHome) {
          sets.push('sent_home_at = now()');
        } else {
          sets.push('sent_home_at = NULL');
        }
      }
      if (input.followUpRequired !== undefined) {
        sets.push('follow_up_required = $' + idx);
        params.push(input.followUpRequired);
        idx++;
      }
      if (input.followUpNotes !== undefined) {
        sets.push('follow_up_notes = $' + idx);
        params.push(input.followUpNotes);
        idx++;
      }
      if (input.followUpDate !== undefined) {
        sets.push('follow_up_date = $' + idx + '::date');
        params.push(input.followUpDate);
        idx++;
      }
      if (input.signOut === true) {
        if (cur.status !== 'IN_PROGRESS') {
          throw new BadRequestException('Cannot sign out a visit that is not IN_PROGRESS');
        }
        // Lockstep with signed_chk: COMPLETED requires signed_out_at
        // NOT NULL. Flip status + stamp in the same UPDATE.
        sets.push("status = 'COMPLETED'");
        sets.push('signed_out_at = now()');
      }

      if (sets.length === 0) return;
      sets.push('updated_at = now()');
      params.push(id);

      await tx.$executeRawUnsafe(
        'UPDATE hlth_nurse_visits SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });

    // Emit hlth.nurse_visit.sent_home only on the false → true transition.
    if (input.sentHome === true && !prevSentHome) {
      const tenant = getCurrentTenant();
      void this.kafka.emit({
        topic: 'hlth.nurse_visit.sent_home',
        key: id,
        sourceModule: 'health',
        payload: {
          visitId: id,
          schoolId: tenant.schoolId,
          visitedPersonId,
          visitedPersonType,
          sentHomeAt: new Date().toISOString(),
          nurseEmployeeId: actor.employeeId,
          nurseAccountId: actor.accountId,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }

    return this.loadOrFail(id);
  }

  // ─── Internal ────────────────────────────────────────────────

  private async assertVisitedRefValid(type: VisitedPersonType, id: string): Promise<void> {
    const ok = await this.tenantPrisma.executeInTenantContext(async (client) => {
      if (type === 'STUDENT') {
        const rows = (await client.$queryRawUnsafe(
          'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
          id,
        )) as Array<{ ok: number }>;
        return rows.length > 0;
      }
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM hr_employees WHERE id = $1::uuid LIMIT 1',
        id,
      )) as Array<{ ok: number }>;
      return rows.length > 0;
    });
    if (!ok) {
      throw new BadRequestException(
        'visitedPersonId does not match a ' + type.toLowerCase() + ' in this school',
      );
    }
  }

  private async loadOrFail(id: string): Promise<NurseVisitResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_VISIT_BASE + 'WHERE v.id = $1::uuid LIMIT 1',
        id,
      )) as VisitRow[];
    });
    if (rows.length === 0) throw new NotFoundException('Nurse visit ' + id);
    return this.rowToDto(rows[0]!);
  }

  private rowToDto(r: VisitRow): NurseVisitResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      visitedPersonId: r.visited_person_id,
      visitedPersonType: r.visited_person_type as VisitedPersonType,
      visitedPersonName: r.visited_person_name,
      nurseId: r.nurse_id,
      nurseName: fullName(r.nurse_first, r.nurse_last),
      visitDate: r.visit_date,
      status: r.status as NurseVisitStatus,
      signedInAt: r.signed_in_at,
      signedOutAt: r.signed_out_at,
      reason: r.reason,
      treatmentGiven: r.treatment_given,
      parentNotified: r.parent_notified,
      sentHome: r.sent_home,
      sentHomeAt: r.sent_home_at,
      followUpRequired: r.follow_up_required,
      followUpNotes: r.follow_up_notes,
      followUpDate: r.follow_up_date,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
