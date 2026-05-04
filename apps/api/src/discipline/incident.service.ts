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
import { CategoryService } from './category.service';
import {
  ActionResponseDto,
  CreateIncidentDto,
  IncidentResponseDto,
  IncidentStatus,
  ListIncidentsQueryDto,
  ResolveIncidentDto,
  ReviewIncidentDto,
  Severity,
} from './dto/discipline.dto';

interface IncidentRow {
  id: string;
  school_id: string;
  student_id: string;
  student_first: string | null;
  student_last: string | null;
  student_grade: string | null;
  reported_by: string | null;
  reporter_first: string | null;
  reporter_last: string | null;
  category_id: string;
  category_name: string;
  severity: string;
  description: string;
  incident_date: string;
  incident_time: string | null;
  location: string | null;
  witnesses: string | null;
  status: string;
  resolved_by: string | null;
  resolver_first: string | null;
  resolver_last: string | null;
  resolved_at: string | null;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  incident_id: string;
  action_type_id: string;
  action_type_name: string;
  requires_parent_notification: boolean;
  assigned_by: string | null;
  assigned_first: string | null;
  assigned_last: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  parent_notified: boolean;
  parent_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_INCIDENT_BASE =
  'SELECT i.id::text AS id, i.school_id::text AS school_id, ' +
  'i.student_id::text AS student_id, ' +
  'sip.first_name AS student_first, sip.last_name AS student_last, s.grade_level AS student_grade, ' +
  'i.reported_by::text AS reported_by, ' +
  'rp.first_name AS reporter_first, rp.last_name AS reporter_last, ' +
  'i.category_id::text AS category_id, c.name AS category_name, c.severity AS severity, ' +
  'i.description, ' +
  "TO_CHAR(i.incident_date, 'YYYY-MM-DD') AS incident_date, " +
  "TO_CHAR(i.incident_time, 'HH24:MI:SS') AS incident_time, " +
  'i.location, i.witnesses, i.status, ' +
  'i.resolved_by::text AS resolved_by, ' +
  'rsp.first_name AS resolver_first, rsp.last_name AS resolver_last, ' +
  'TO_CHAR(i.resolved_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS resolved_at, ' +
  'i.admin_notes, ' +
  'TO_CHAR(i.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(i.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_discipline_incidents i ' +
  'JOIN sis_discipline_categories c ON c.id = i.category_id ' +
  'JOIN sis_students s ON s.id = i.student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sip ON sip.id = sps.person_id ' +
  'LEFT JOIN hr_employees re ON re.id = i.reported_by ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = re.person_id ' +
  'LEFT JOIN hr_employees rse ON rse.id = i.resolved_by ' +
  'LEFT JOIN platform.iam_person rsp ON rsp.id = rse.person_id ';

const SELECT_ACTION_BASE =
  'SELECT a.id::text AS id, a.incident_id::text AS incident_id, ' +
  'a.action_type_id::text AS action_type_id, ' +
  'at.name AS action_type_name, at.requires_parent_notification, ' +
  'a.assigned_by::text AS assigned_by, ' +
  'ap.first_name AS assigned_first, ap.last_name AS assigned_last, ' +
  "TO_CHAR(a.start_date, 'YYYY-MM-DD') AS start_date, " +
  "TO_CHAR(a.end_date, 'YYYY-MM-DD') AS end_date, " +
  'a.notes, a.parent_notified, ' +
  'TO_CHAR(a.parent_notified_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS parent_notified_at, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_discipline_actions a ' +
  'JOIN sis_discipline_action_types at ON at.id = a.action_type_id ' +
  'LEFT JOIN hr_employees ae ON ae.id = a.assigned_by ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = ae.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToActionDto(r: ActionRow): ActionResponseDto {
  return {
    id: r.id,
    incidentId: r.incident_id,
    actionTypeId: r.action_type_id,
    actionTypeName: r.action_type_name,
    requiresParentNotification: r.requires_parent_notification,
    assignedById: r.assigned_by,
    assignedByName: fullName(r.assigned_first, r.assigned_last),
    startDate: r.start_date,
    endDate: r.end_date,
    notes: r.notes,
    parentNotified: r.parent_notified,
    parentNotifiedAt: r.parent_notified_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Strip admin-only fields for non-manager readers (parents, students,
 * teachers without manager scope on this incident). The schema-level
 * `admin_notes` column is internal; the row-scope contract requires the
 * service layer to remove it from the DTO before the response leaves the
 * server.
 */
function stripForNonManager(dto: IncidentResponseDto): IncidentResponseDto {
  return { ...dto, adminNotes: null };
}

@Injectable()
export class IncidentService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly categories: CategoryService,
  ) {}

  /**
   * Visibility model:
   *
   * - Admin / counsellor (`isSchoolAdmin`)        → all incidents in tenant.
   * - Teacher (STAFF with employeeId)             → incidents they reported
   *   OR incidents for students enrolled in their classes
   *   (sis_class_teachers + sis_enrollments).
   * - Parent (GUARDIAN)                           → own children's incidents
   *   via sis_student_guardians/sis_guardians keyed on actor.personId.
   *   admin_notes is stripped from every row in the response.
   * - Student                                     → no rows (the gate-tier
   *   permission BEH-001:read is not granted to students; this service is
   *   never reached by a student persona, but the predicate falls through
   *   to AND FALSE for safety).
   * - Anything else                               → no rows.
   *
   * Returns the SQL fragment + parameter to bind, plus a flag indicating
   * whether the caller is a manager (admin or counsellor) — managers see
   * `admin_notes` in their payload, everyone else gets a stripped DTO.
   */
  private buildVisibility(
    actor: ResolvedActor,
    start: number,
  ): { fragment: string; param: string | null; consumed: 0 | 1; isManager: boolean } {
    if (actor.isSchoolAdmin) {
      return { fragment: '', param: null, consumed: 0, isManager: true };
    }
    if (actor.personType === 'STAFF' && actor.employeeId) {
      // Teacher row scope: incidents they reported OR for students in their
      // classes via sis_class_teachers + ACTIVE sis_enrollments.
      return {
        fragment:
          'AND (i.reported_by = $' +
          start +
          '::uuid OR i.student_id IN (' +
          'SELECT e.student_id FROM sis_enrollments e ' +
          'JOIN sis_class_teachers ct ON ct.class_id = e.class_id ' +
          "WHERE e.status = 'ACTIVE' AND ct.teacher_employee_id = $" +
          start +
          '::uuid' +
          ')) ',
        param: actor.employeeId,
        consumed: 1,
        // Step 4 carries STAFF readers as managers for the admin_notes
        // payload — VPs and counsellors hold sch-001:admin via the school
        // admin role assignment so they would have already taken the
        // isSchoolAdmin branch above. A regular teacher (STAFF without
        // sch-001:admin in their tenant scope chain) is NOT a manager and
        // their payload should strip admin_notes; that is what this branch
        // returns by setting isManager=false below.
        isManager: false,
      };
    }
    if (actor.personType === 'GUARDIAN') {
      return {
        fragment:
          'AND i.student_id IN (' +
          'SELECT sg.student_id FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'WHERE g.person_id = $' +
          start +
          '::uuid' +
          ') ',
        param: actor.personId,
        consumed: 1,
        isManager: false,
      };
    }
    // STUDENT or anything unrecognised: no rows.
    return { fragment: 'AND FALSE ', param: null, consumed: 0, isManager: false };
  }

  async list(query: ListIncidentsQueryDto, actor: ResolvedActor): Promise<IncidentResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 200);
    const visibility = this.buildVisibility(actor, 1);
    const sql: string[] = [SELECT_INCIDENT_BASE, 'WHERE 1=1 '];
    const params: unknown[] = [];
    let idx = 1;
    if (visibility.consumed === 1) {
      sql.push(visibility.fragment);
      params.push(visibility.param);
      idx++;
    } else if (visibility.fragment) {
      sql.push(visibility.fragment);
    }
    if (query.status) {
      sql.push('AND i.status = $' + idx + ' ');
      params.push(query.status);
      idx++;
    }
    if (query.severity) {
      sql.push('AND c.severity = $' + idx + ' ');
      params.push(query.severity);
      idx++;
    }
    if (query.categoryId) {
      sql.push('AND i.category_id = $' + idx + '::uuid ');
      params.push(query.categoryId);
      idx++;
    }
    if (query.studentId) {
      sql.push('AND i.student_id = $' + idx + '::uuid ');
      params.push(query.studentId);
      idx++;
    }
    if (query.fromDate) {
      sql.push('AND i.incident_date >= $' + idx + '::date ');
      params.push(query.fromDate);
      idx++;
    }
    if (query.toDate) {
      sql.push('AND i.incident_date <= $' + idx + '::date ');
      params.push(query.toDate);
      idx++;
    }
    sql.push(
      // CRITICAL/HIGH first then chronological — surfaces the worst
      // incidents at the top of the admin queue.
      "ORDER BY CASE c.severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, " +
        'i.incident_date DESC, i.created_at DESC ',
    );
    sql.push('LIMIT ' + limit);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<IncidentRow[]>(sql.join(''), ...params);
    });

    if (rows.length === 0) return [];

    // Bulk-load actions for all returned incidents in one round-trip.
    const ids = rows.map((r) => r.id);
    const actionRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ActionRow[]>(
        SELECT_ACTION_BASE + 'WHERE a.incident_id = ANY($1::uuid[]) ' + 'ORDER BY a.created_at ASC',
        ids,
      );
    });
    const actionsByIncident = new Map<string, ActionResponseDto[]>();
    for (const a of actionRows) {
      const list = actionsByIncident.get(a.incident_id) ?? [];
      list.push(rowToActionDto(a));
      actionsByIncident.set(a.incident_id, list);
    }

    return rows.map((r) => {
      const dto = this.rowToDto(r, actionsByIncident.get(r.id) ?? []);
      return visibility.isManager ? dto : stripForNonManager(dto);
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<IncidentResponseDto> {
    return this.loadOrFail(id, actor);
  }

  /**
   * Submit a new incident. Stamps reported_by from actor.employeeId; refuses
   * if the caller has no hr_employees row (parents and students reach this
   * code path only if the IAM gate misroutes — defence in depth). Emits
   * beh.incident.reported with the full join shape on the wire so the Step
   * 6 BehaviourNotificationConsumer can fan out to school admins without a
   * second DB read.
   */
  async create(input: CreateIncidentDto, actor: ResolvedActor): Promise<IncidentResponseDto> {
    if (!actor.employeeId) {
      throw new ForbiddenException('Only staff with an employee record can report incidents');
    }
    const tenant = getCurrentTenant();
    const id = generateId();

    // Validate the supplied category is active in this tenant.
    const category = await this.categories.assertActive(input.categoryId);

    // Validate the supplied student exists in this tenant. The DB-enforced
    // FK rejects bogus UUIDs at the schema layer; this pre-check surfaces a
    // friendly 400 instead of letting Postgres raise on INSERT.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 AS ok FROM sis_students WHERE id = $1::uuid LIMIT 1',
        input.studentId,
      )) as Array<{ ok: number }>;
      if (rows.length === 0) {
        throw new BadRequestException('studentId does not match a student in this school');
      }
    });

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO sis_discipline_incidents ' +
          '(id, school_id, student_id, reported_by, category_id, description, ' +
          'incident_date, incident_time, location, witnesses, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::time, $9, $10, 'OPEN')",
        id,
        tenant.schoolId,
        input.studentId,
        actor.employeeId,
        input.categoryId,
        input.description,
        input.incidentDate,
        input.incidentTime ?? null,
        input.location ?? null,
        input.witnesses ?? null,
      );
    });

    const dto = await this.loadOrFailNoAuth(id);
    const studentName = fullName(dto.studentFirstName, dto.studentLastName);
    void this.kafka.emit({
      topic: 'beh.incident.reported',
      key: id,
      sourceModule: 'discipline',
      payload: {
        incidentId: id,
        // Universal sourceRefId escape hatch for the Cycle 7 TaskWorker
        // — the worker's pickSourceRefId helper looks for this field
        // first so the AUTO-task created from the Step 3 seeded rule
        // carries source_ref_id matching the incident id (matches the
        // Cycle 8 tkt.ticket.assigned convention).
        sourceRefId: id,
        schoolId: tenant.schoolId,
        studentId: input.studentId,
        // The Step 3 auto-task rule's title_template renders against
        // {student_name} + {category_name}; the description_template
        // against {reporter_name} + {incident_date} + {severity}. The
        // template renderer flattens camelCase → snake_case so we ship
        // camelCase here and the worker resolves both forms.
        studentName,
        studentGradeLevel: dto.studentGradeLevel,
        categoryId: input.categoryId,
        categoryName: category.name,
        severity: category.severity,
        reportedById: actor.employeeId,
        reportedByName: dto.reportedByName,
        // Explicit alias for the title/description templates that use
        // {reporter_name}.
        reporterName: dto.reportedByName,
        incidentDate: input.incidentDate,
        description: input.description,
        status: 'OPEN' as IncidentStatus,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    return dto;
  }

  /**
   * Admin transitions OPEN → UNDER_REVIEW. Locks the incident row inside
   * one tenant tx; refuses on RESOLVED (use reopen) or already
   * UNDER_REVIEW. Optional adminNotes appended.
   */
  async review(
    id: string,
    input: ReviewIncidentDto,
    actor: ResolvedActor,
  ): Promise<IncidentResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can review incidents');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status, admin_notes FROM sis_discipline_incidents WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string; admin_notes: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Incident ' + id);
      const row = lockRows[0]!;
      if (row.status === 'UNDER_REVIEW') {
        throw new BadRequestException('Incident is already UNDER_REVIEW');
      }
      if (row.status === 'RESOLVED') {
        throw new BadRequestException(
          'Cannot move RESOLVED incident to UNDER_REVIEW; reopen the incident first',
        );
      }
      const updates = ["status = 'UNDER_REVIEW'", 'updated_at = now()'];
      const params: unknown[] = [id];
      if (input.adminNotes) {
        const merged = row.admin_notes
          ? row.admin_notes + '\n\n' + input.adminNotes
          : input.adminNotes;
        updates.push('admin_notes = $2');
        params.push(merged);
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_discipline_incidents SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id, actor);
  }

  /**
   * Admin transitions OPEN/UNDER_REVIEW → RESOLVED. Sets resolved_by from
   * actor.employeeId (so the audit row shows the resolving staff member,
   * NOT the platform_users id) plus resolved_at = now() in the same UPDATE
   * — the multi-column resolved_chk requires both fields populated when
   * status='RESOLVED'. Emits beh.incident.resolved.
   */
  async resolve(
    id: string,
    input: ResolveIncidentDto,
    actor: ResolvedActor,
  ): Promise<IncidentResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can resolve incidents');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Resolving admin must have an employee record');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id, status, admin_notes FROM sis_discipline_incidents WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ id: string; status: string; admin_notes: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Incident ' + id);
      const row = lockRows[0]!;
      if (row.status === 'RESOLVED') {
        throw new BadRequestException('Incident is already RESOLVED');
      }
      const updates = [
        "status = 'RESOLVED'",
        'resolved_by = $2::uuid',
        'resolved_at = now()',
        'updated_at = now()',
      ];
      const params: unknown[] = [id, actor.employeeId];
      if (input.adminNotes) {
        const merged = row.admin_notes
          ? row.admin_notes + '\n\n' + input.adminNotes
          : input.adminNotes;
        updates.push('admin_notes = $3');
        params.push(merged);
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_discipline_incidents SET ' + updates.join(', ') + ' WHERE id = $1::uuid',
        ...params,
      );
    });
    const dto = await this.loadOrFailNoAuth(id);
    void this.kafka.emit({
      topic: 'beh.incident.resolved',
      key: id,
      sourceModule: 'discipline',
      payload: {
        incidentId: id,
        sourceRefId: id,
        schoolId: tenant.schoolId,
        studentId: dto.studentId,
        studentName: fullName(dto.studentFirstName, dto.studentLastName),
        categoryId: dto.categoryId,
        categoryName: dto.categoryName,
        severity: dto.severity,
        resolvedById: actor.employeeId,
        resolvedByName: dto.resolvedByName,
        resolvedByAccountId: actor.accountId,
        // Surface the original reporter so the Step 6 consumer can decide
        // whether to suppress a self-resolution notification (mirrors
        // Cycle 8 follow-up 2 pattern for tickets).
        reportedById: dto.reportedById,
        reportedByName: dto.reportedByName,
        resolvedAt: dto.resolvedAt,
      },
      tenantId: tenant.schoolId,
      tenantSubdomain: tenant.subdomain,
    });
    return dto;
  }

  /**
   * Admin reopens a RESOLVED incident → OPEN. Clears resolved_by +
   * resolved_at in the same UPDATE so the multi-column resolved_chk stays
   * satisfied (working states require both fields NULL).
   */
  async reopen(id: string, actor: ResolvedActor): Promise<IncidentResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can reopen incidents');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lockRows = (await tx.$queryRawUnsafe(
        'SELECT status FROM sis_discipline_incidents WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ status: string }>;
      if (lockRows.length === 0) throw new NotFoundException('Incident ' + id);
      if (lockRows[0]!.status !== 'RESOLVED') {
        throw new BadRequestException('Only RESOLVED incidents can be reopened');
      }
      await tx.$executeRawUnsafe(
        "UPDATE sis_discipline_incidents SET status = 'OPEN', resolved_by = NULL, " +
          'resolved_at = NULL, updated_at = now() WHERE id = $1::uuid',
        id,
      );
    });
    return this.loadOrFail(id, actor);
  }

  // ─── Internal helpers ─────────────────────────────────────────

  /**
   * Public helper used by ActionService.create to validate the incident
   * exists in this tenant and is not RESOLVED before assigning a new
   * consequence. Returns the locked-tx-friendly minimal shape; callers
   * should still verify row scope separately if needed.
   */
  async loadForActionWrite(id: string, actor: ResolvedActor): Promise<IncidentResponseDto> {
    const dto = await this.loadOrFail(id, actor);
    if (dto.status === 'RESOLVED') {
      throw new BadRequestException(
        'Cannot add an action to a RESOLVED incident. Reopen the incident first.',
      );
    }
    return dto;
  }

  private async loadOrFail(id: string, actor: ResolvedActor): Promise<IncidentResponseDto> {
    const visibility = this.buildVisibility(actor, 2);
    const sql =
      SELECT_INCIDENT_BASE +
      'WHERE i.id = $1::uuid ' +
      (visibility.fragment ? visibility.fragment : '');
    const params: unknown[] = [id];
    if (visibility.consumed === 1) params.push(visibility.param);

    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<IncidentRow[]>(sql, ...params);
    });
    if (rows.length === 0) throw new NotFoundException('Incident ' + id);

    const actions = await this.loadActions(id);
    const dto = this.rowToDto(rows[0]!, actions);
    return visibility.isManager ? dto : stripForNonManager(dto);
  }

  private async loadOrFailNoAuth(id: string): Promise<IncidentResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<IncidentRow[]>(
        SELECT_INCIDENT_BASE + 'WHERE i.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Incident ' + id);
    const actions = await this.loadActions(id);
    return this.rowToDto(rows[0]!, actions);
  }

  private async loadActions(incidentId: string): Promise<ActionResponseDto[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ActionRow[]>(
        SELECT_ACTION_BASE + 'WHERE a.incident_id = $1::uuid ORDER BY a.created_at ASC',
        incidentId,
      );
    });
    return rows.map(rowToActionDto);
  }

  private rowToDto(r: IncidentRow, actions: ActionResponseDto[]): IncidentResponseDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      studentId: r.student_id,
      studentFirstName: r.student_first,
      studentLastName: r.student_last,
      studentGradeLevel: r.student_grade,
      reportedById: r.reported_by,
      reportedByName: fullName(r.reporter_first, r.reporter_last),
      categoryId: r.category_id,
      categoryName: r.category_name,
      severity: r.severity as Severity,
      description: r.description,
      incidentDate: r.incident_date,
      incidentTime: r.incident_time,
      location: r.location,
      witnesses: r.witnesses,
      status: r.status as IncidentStatus,
      resolvedById: r.resolved_by,
      resolvedByName: fullName(r.resolver_first, r.resolver_last),
      resolvedAt: r.resolved_at,
      adminNotes: r.admin_notes,
      actions,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
