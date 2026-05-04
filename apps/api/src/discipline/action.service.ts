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
import { ActionTypeService } from './action-type.service';
import { IncidentService } from './incident.service';
import { ActionResponseDto, CreateActionDto, UpdateActionDto } from './dto/discipline.dto';

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

const SELECT_BASE =
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

function rowToDto(r: ActionRow): ActionResponseDto {
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

@Injectable()
export class ActionService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly incidents: IncidentService,
    private readonly actionTypes: ActionTypeService,
  ) {}

  /**
   * List actions attached to an incident. Visibility flows through the
   * parent incident — if the caller can see the incident via
   * IncidentService row scope, they can read its actions.
   */
  async listForIncident(incidentId: string, actor: ResolvedActor): Promise<ActionResponseDto[]> {
    // Touch the incident first so the row-scope predicate fires + 404s
    // for non-participants. Discards the dto, we only need the access check.
    await this.incidents.getById(incidentId, actor);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BASE + 'WHERE a.incident_id = $1::uuid ORDER BY a.created_at ASC',
        incidentId,
      )) as ActionRow[];
      return rows.map(rowToDto);
    });
  }

  /**
   * Admin assigns a consequence on an incident. Validates the incident is
   * not RESOLVED, the action type is active, the (incident, action_type)
   * pair is unique. If the action type's requires_parent_notification flag
   * is true, resolves the portal-enabled guardian account ids via
   * sis_student_guardians and emits beh.action.parent_notification_required
   * with the guardian list inline so the Step 6 BehaviourNotificationConsumer
   * can fan out IN_APP notifications without re-querying.
   */
  async create(
    incidentId: string,
    input: CreateActionDto,
    actor: ResolvedActor,
  ): Promise<ActionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can assign disciplinary actions');
    }
    if (!actor.employeeId) {
      throw new ForbiddenException('Assigning admin must have an employee record');
    }
    // assertActive verifies tenant scope on the incident as well — admins
    // bypass row-scope but the service still validates that the incident
    // exists in this tenant via IncidentService.loadForActionWrite.
    const incident = await this.incidents.loadForActionWrite(incidentId, actor);
    const actionType = await this.actionTypes.assertActive(input.actionTypeId);

    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }

    const id = generateId();
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantContext(async (client) => {
      try {
        await client.$executeRawUnsafe(
          'INSERT INTO sis_discipline_actions ' +
            '(id, incident_id, action_type_id, assigned_by, start_date, end_date, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7)',
          id,
          incidentId,
          input.actionTypeId,
          actor.employeeId,
          input.startDate ?? null,
          input.endDate ?? null,
          input.notes ?? null,
        );
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          throw new BadRequestException(
            'An action of this type is already assigned to this incident. Edit the existing action instead.',
          );
        }
        throw err;
      }
    });

    // If the action type requires parent notification, resolve the
    // portal-enabled guardians for the student now and emit the event so
    // the Step 6 BehaviourNotificationConsumer can fan out IN_APP
    // notifications to each guardian's account id without re-querying.
    if (actionType.requiresParentNotification) {
      const guardianAccountIds = await this.resolveGuardianAccountIds(incident.studentId);
      const studentName = fullName(incident.studentFirstName, incident.studentLastName);
      void this.kafka.emit({
        topic: 'beh.action.parent_notification_required',
        key: id,
        sourceModule: 'discipline',
        payload: {
          actionId: id,
          incidentId,
          schoolId: tenant.schoolId,
          studentId: incident.studentId,
          studentName,
          categoryName: incident.categoryName,
          severity: incident.severity,
          actionTypeId: actionType.id,
          actionTypeName: actionType.name,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          guardianAccountIds,
          assignedById: actor.employeeId,
          assignedByAccountId: actor.accountId,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    }

    return this.loadOrFail(id);
  }

  async update(
    id: string,
    input: UpdateActionDto,
    actor: ResolvedActor,
  ): Promise<ActionResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can update disciplinary actions');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (input.startDate !== undefined) {
      sets.push('start_date = $' + idx + '::date');
      params.push(input.startDate);
      idx++;
    }
    if (input.endDate !== undefined) {
      sets.push('end_date = $' + idx + '::date');
      params.push(input.endDate);
      idx++;
    }
    if (input.notes !== undefined) {
      sets.push('notes = $' + idx);
      params.push(input.notes);
      idx++;
    }
    if (input.parentNotified !== undefined) {
      sets.push('parent_notified = $' + idx);
      params.push(input.parentNotified);
      idx++;
      // Stamp parent_notified_at = now() when flipping to true; clear when
      // flipping back to false (keeps the column self-consistent).
      if (input.parentNotified === true) {
        sets.push('parent_notified_at = COALESCE(parent_notified_at, now())');
      } else {
        sets.push('parent_notified_at = NULL');
      }
    }
    if (sets.length === 0) return this.loadOrFail(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the row + validate dates inside the tx so a date-flip can't
      // race with a separate parent_notified flip.
      const lockRows = (await tx.$queryRawUnsafe(
        "SELECT TO_CHAR(start_date, 'YYYY-MM-DD') AS start_date, TO_CHAR(end_date, 'YYYY-MM-DD') AS end_date " +
          'FROM sis_discipline_actions WHERE id = $1::uuid FOR UPDATE',
        id,
      )) as Array<{ start_date: string | null; end_date: string | null }>;
      if (lockRows.length === 0) throw new NotFoundException('Action ' + id);
      const row = lockRows[0]!;
      const newStart = input.startDate !== undefined ? input.startDate : row.start_date;
      const newEnd = input.endDate !== undefined ? input.endDate : row.end_date;
      if (newStart && newEnd && newEnd < newStart) {
        throw new BadRequestException('endDate must be on or after startDate');
      }
      await tx.$executeRawUnsafe(
        'UPDATE sis_discipline_actions SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
    });
    return this.loadOrFail(id);
  }

  /**
   * Admin removes a consequence. Refused on RESOLVED incidents — historical
   * actions on a resolved record are part of the audit trail and admins
   * should reopen the incident first if a correction is needed.
   */
  async remove(id: string, actor: ResolvedActor): Promise<void> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can delete disciplinary actions');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT a.id::text AS id, i.status AS incident_status FROM sis_discipline_actions a ' +
          'JOIN sis_discipline_incidents i ON i.id = a.incident_id ' +
          'WHERE a.id = $1::uuid FOR UPDATE OF a',
        id,
      )) as Array<{ id: string; incident_status: string }>;
      if (rows.length === 0) throw new NotFoundException('Action ' + id);
      if (rows[0]!.incident_status === 'RESOLVED') {
        throw new BadRequestException(
          'Cannot delete an action on a RESOLVED incident. Reopen the incident first.',
        );
      }
      await tx.$executeRawUnsafe('DELETE FROM sis_discipline_actions WHERE id = $1::uuid', id);
    });
  }

  // ─── Internal helpers ─────────────────────────────────────────

  private async loadOrFail(id: string): Promise<ActionResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<ActionRow[]>(SELECT_BASE + 'WHERE a.id = $1::uuid', id);
    });
    if (rows.length === 0) throw new NotFoundException('Action ' + id);
    return rowToDto(rows[0]!);
  }

  /**
   * Resolve the portal-enabled guardian account ids for a student.
   * Mirrors the AttendanceNotificationConsumer pattern — only guardians
   * with portal_access=true AND a non-null platform_users.id (i.e. they
   * have a login) are returned. The consumer-side fan-out enqueues IN_APP
   * notifications to each id.
   */
  private async resolveGuardianAccountIds(studentId: string): Promise<string[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT pu.id::text AS account_id ' +
          'FROM sis_student_guardians sg ' +
          'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
          'JOIN platform.platform_users pu ON pu.person_id = g.person_id ' +
          'WHERE sg.student_id = $1::uuid AND sg.portal_access = true ' +
          'AND pu.id IS NOT NULL',
        studentId,
      );
    });
    return rows.map((r) => r.account_id);
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
