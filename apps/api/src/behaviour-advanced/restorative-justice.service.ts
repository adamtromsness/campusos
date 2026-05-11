import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { OutboxService } from '../kafka/outbox.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import {
  CompleteRjActionDto,
  CreateRjActionDto,
  CreateRjConferenceDto,
  RjActionResponseDto,
  RjActionStatus,
  RjConferenceResponseDto,
  RjConferenceStatus,
  UpdateRjConferenceDto,
} from './dto/behaviour-advanced.dto';
import { deterministicRjResolvedEventId } from './event-ids';

interface ConferenceRow {
  id: string;
  school_id: string;
  incident_id: string;
  facilitator_id: string | null;
  facilitator_first: string | null;
  facilitator_last: string | null;
  offender_student_id: string;
  offender_first: string | null;
  offender_last: string | null;
  harmed_party_ids: string[];
  parent_notified_at: string | null;
  conference_date: string | null;
  conference_location: string | null;
  conference_notes: string | null;
  status: string;
  resolution_date: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  conference_id: string;
  action_description: string;
  assigned_to_student_id: string;
  assigned_first: string | null;
  assigned_last: string | null;
  due_date: string;
  status: string;
  completed_at: string | null;
  verified_by: string | null;
  verifier_first: string | null;
  verifier_last: string | null;
  evidence_notes: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_CONF_BASE =
  'SELECT c.id::text AS id, c.school_id::text AS school_id, ' +
  'c.incident_id::text AS incident_id, ' +
  'c.facilitator_id::text AS facilitator_id, ' +
  'fp.first_name AS facilitator_first, fp.last_name AS facilitator_last, ' +
  'c.offender_student_id::text AS offender_student_id, ' +
  'op.first_name AS offender_first, op.last_name AS offender_last, ' +
  '(SELECT ARRAY_AGG(x::text) FROM unnest(c.harmed_party_ids) AS x) AS harmed_party_ids, ' +
  'TO_CHAR(c.parent_notified_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS parent_notified_at, ' +
  'TO_CHAR(c.conference_date, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS conference_date, ' +
  'c.conference_location, c.conference_notes, c.status, ' +
  'TO_CHAR(c.resolution_date, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS resolution_date, ' +
  'TO_CHAR(c.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(c.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_restorative_justice_conferences c ' +
  'LEFT JOIN hr_employees fe ON fe.id = c.facilitator_id ' +
  'LEFT JOIN platform.iam_person fp ON fp.id = fe.person_id ' +
  'JOIN sis_students os ON os.id = c.offender_student_id ' +
  'JOIN platform.platform_students ops ON ops.id = os.platform_student_id ' +
  'JOIN platform.iam_person op ON op.id = ops.person_id ';

const SELECT_ACTION_BASE =
  'SELECT a.id::text AS id, a.conference_id::text AS conference_id, ' +
  'a.action_description, a.assigned_to_student_id::text AS assigned_to_student_id, ' +
  'sp.first_name AS assigned_first, sp.last_name AS assigned_last, ' +
  "TO_CHAR(a.due_date, 'YYYY-MM-DD') AS due_date, " +
  'a.status, ' +
  'TO_CHAR(a.completed_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS completed_at, ' +
  'a.verified_by::text AS verified_by, ' +
  'vp.first_name AS verifier_first, vp.last_name AS verifier_last, ' +
  'a.evidence_notes, ' +
  'TO_CHAR(a.created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
  'TO_CHAR(a.updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
  'FROM sis_rj_agreement_actions a ' +
  'JOIN sis_students s ON s.id = a.assigned_to_student_id ' +
  'JOIN platform.platform_students sps ON sps.id = s.platform_student_id ' +
  'JOIN platform.iam_person sp ON sp.id = sps.person_id ' +
  'LEFT JOIN hr_employees ve ON ve.id = a.verified_by ' +
  'LEFT JOIN platform.iam_person vp ON vp.id = ve.person_id ';

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function rowToConfDto(r: ConferenceRow): RjConferenceResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    incidentId: r.incident_id,
    facilitatorId: r.facilitator_id,
    facilitatorName: fullName(r.facilitator_first, r.facilitator_last),
    offenderStudentId: r.offender_student_id,
    offenderStudentName: fullName(r.offender_first, r.offender_last),
    harmedPartyIds: r.harmed_party_ids ?? [],
    parentNotifiedAt: r.parent_notified_at,
    conferenceDate: r.conference_date,
    conferenceLocation: r.conference_location,
    conferenceNotes: r.conference_notes,
    status: r.status as RjConferenceStatus,
    resolutionDate: r.resolution_date,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToActionDto(r: ActionRow): RjActionResponseDto {
  return {
    id: r.id,
    conferenceId: r.conference_id,
    actionDescription: r.action_description,
    assignedToStudentId: r.assigned_to_student_id,
    assignedToStudentName: fullName(r.assigned_first, r.assigned_last),
    dueDate: r.due_date,
    status: r.status as RjActionStatus,
    completedAt: r.completed_at,
    verifiedBy: r.verified_by,
    verifiedByName: fullName(r.verifier_first, r.verifier_last),
    evidenceNotes: r.evidence_notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Restorative Justice Service (P2-14 Step 3).
 *
 * Counsellor-led restorative justice conferences structured around a
 * Cycle 9 sis_discipline_incidents row. Conference creation requires
 * BEH-001:write held only by Staff and admin (per the seed-iam grants).
 * Teachers with BEH-001:read can view RJ outcomes but cannot initiate.
 *
 * Lifecycle:
 *   SCHEDULED → IN_PROGRESS → AGREEMENT_REACHED → RESOLVED_SUCCESSFULLY
 *                                              ↘ FAILED
 *
 * RESOLVED_SUCCESSFULLY is reached by the auto-transition path in
 * `completeAction()` when every agreement action lands COMPLETED. The
 * service emits `beh.rj_conference.resolved` via the durable outbox
 * (OutboxService.enqueueInTx) inside the same tenant tx as the status
 * flip — a Kafka outage cannot roll back the user's action.
 *
 * Multi-column completed_chk on sis_rj_agreement_actions enforces
 * (completed_at, verified_by) populated together when status=COMPLETED
 * and both null on PENDING/OVERDUE.
 */
@Injectable()
export class RestorativeJusticeService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
    private readonly permissions: PermissionCheckService,
  ) {}

  /**
   * Counsellor scope = admin OR holds beh-001:write. Mirrors the
   * Cycle 9 BehaviorPlanService.hasCounsellorScope helper.
   */
  private async hasCounsellorScope(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'beh-001:write',
      'beh-001:admin',
    ]);
  }

  async listConferences(_actor: ResolvedActor): Promise<RjConferenceResponseDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_CONF_BASE + 'WHERE c.school_id = $1::uuid ' + 'ORDER BY c.created_at DESC',
        tenant.schoolId,
      )) as ConferenceRow[];
      return rows.map(rowToConfDto);
    });
  }

  async getConferenceById(id: string, _actor: ResolvedActor): Promise<RjConferenceResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_CONF_BASE + 'WHERE c.school_id = $1::uuid AND c.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ConferenceRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('RJ conference not found');
      const conf = rowToConfDto(first);
      const actionRows = (await client.$queryRawUnsafe(
        SELECT_ACTION_BASE +
          'WHERE a.conference_id = $1::uuid ORDER BY a.due_date ASC, a.created_at ASC',
        id,
      )) as ActionRow[];
      conf.actions = actionRows.map(rowToActionDto);
      return conf;
    });
  }

  /**
   * Initiate a restorative justice conference from a Cycle 9 incident.
   * Counsellor/admin only. Validates incident exists in this school +
   * offender_student belongs to this school + every harmed_party id
   * belongs to this school.
   */
  async createConference(
    input: CreateRjConferenceDto,
    actor: ResolvedActor,
  ): Promise<RjConferenceResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException(
        'Only counsellors or admins can initiate restorative justice conferences',
      );
    }
    if (!input.harmedPartyIds || input.harmedPartyIds.length === 0) {
      throw new BadRequestException('harmedPartyIds must contain at least one student');
    }
    const tenant = getCurrentTenant();
    const facilitatorId = actor.employeeId;
    if (!facilitatorId) {
      throw new BadRequestException(
        'Caller has no hr_employees row in this school. Cannot facilitate a conference.',
      );
    }

    const confId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Validate incident exists in tenant
      const inc = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_discipline_incidents WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        input.incidentId,
      )) as Array<{ id: string }>;
      if (inc.length === 0) {
        throw new BadRequestException(
          'incidentId does not match a discipline incident in this school',
        );
      }
      // Validate offender student
      const off = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        input.offenderStudentId,
      )) as Array<{ id: string }>;
      if (off.length === 0) {
        throw new BadRequestException('offenderStudentId does not match a student in this school');
      }
      // Validate harmed parties
      const hp = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = ANY($2::uuid[])',
        tenant.schoolId,
        input.harmedPartyIds,
      )) as Array<{ id: string }>;
      if (hp.length !== input.harmedPartyIds.length) {
        throw new BadRequestException(
          'one or more harmedPartyIds do not match students in this school',
        );
      }

      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_restorative_justice_conferences ' +
          '(id, school_id, incident_id, facilitator_id, offender_student_id, harmed_party_ids, ' +
          ' parent_notified_at, conference_date, conference_location, conference_notes, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid[], ' +
          ' now(), $7::timestamptz, $8, $9, $10)',
        id,
        tenant.schoolId,
        input.incidentId,
        facilitatorId,
        input.offenderStudentId,
        input.harmedPartyIds,
        input.conferenceDate ?? null,
        input.conferenceLocation ?? null,
        input.conferenceNotes ?? null,
        'SCHEDULED',
      );
      return id;
    });

    return this.getConferenceById(confId, actor);
  }

  /**
   * Lifecycle PATCH. Status flips lock the row FOR UPDATE inside one
   * tenant tx. SCHEDULED → IN_PROGRESS, IN_PROGRESS → AGREEMENT_REACHED,
   * any non-terminal → FAILED. RESOLVED_SUCCESSFULLY is reached only
   * via the auto-transition path in `completeAction()`.
   */
  async updateConference(
    id: string,
    input: UpdateRjConferenceDto,
    actor: ResolvedActor,
  ): Promise<RjConferenceResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can edit RJ conferences');
    }
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const cur = (await tx.$queryRawUnsafe(
        'SELECT status FROM sis_restorative_justice_conferences ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ status: string }>;
      const curRow = cur[0];
      if (!curRow) throw new NotFoundException('RJ conference not found');
      const curStatus = curRow.status;

      if (input.status && input.status !== curStatus) {
        const allowed: Record<string, string[]> = {
          SCHEDULED: ['IN_PROGRESS', 'FAILED'],
          IN_PROGRESS: ['AGREEMENT_REACHED', 'FAILED'],
          AGREEMENT_REACHED: ['FAILED'],
          RESOLVED_SUCCESSFULLY: [],
          FAILED: [],
        };
        const valid = allowed[curStatus] ?? [];
        if (!valid.includes(input.status)) {
          throw new BadRequestException(
            'Cannot transition from ' + curStatus + ' to ' + input.status,
          );
        }
        const isTerminal = input.status === 'FAILED';
        await tx.$executeRawUnsafe(
          'UPDATE sis_restorative_justice_conferences SET status = $1, ' +
            (isTerminal ? 'resolution_date = now(), ' : '') +
            'conference_date = COALESCE($2::timestamptz, conference_date), ' +
            'conference_location = COALESCE($3, conference_location), ' +
            'conference_notes = COALESCE($4, conference_notes), ' +
            'updated_at = now() ' +
            'WHERE school_id = $5::uuid AND id = $6::uuid',
          input.status,
          input.conferenceDate ?? null,
          input.conferenceLocation ?? null,
          input.conferenceNotes ?? null,
          tenant.schoolId,
          id,
        );
      } else {
        // Notes / date update only
        await tx.$executeRawUnsafe(
          'UPDATE sis_restorative_justice_conferences SET ' +
            'conference_date = COALESCE($1::timestamptz, conference_date), ' +
            'conference_location = COALESCE($2, conference_location), ' +
            'conference_notes = COALESCE($3, conference_notes), ' +
            'updated_at = now() ' +
            'WHERE school_id = $4::uuid AND id = $5::uuid',
          input.conferenceDate ?? null,
          input.conferenceLocation ?? null,
          input.conferenceNotes ?? null,
          tenant.schoolId,
          id,
        );
      }
    });
    return this.getConferenceById(id, actor);
  }

  /**
   * Add an action to the conference agreement. Counsellor/admin only.
   * Each action gets a due date plus assigned student. Status defaults
   * to PENDING; OverdueActionWorker flips to OVERDUE on the nightly
   * sweep.
   */
  async addAction(
    conferenceId: string,
    input: CreateRjActionDto,
    actor: ResolvedActor,
  ): Promise<RjActionResponseDto> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can add agreement actions');
    }
    const tenant = getCurrentTenant();
    const actionId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const conf = (await tx.$queryRawUnsafe(
        'SELECT status FROM sis_restorative_justice_conferences ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        conferenceId,
      )) as Array<{ status: string }>;
      const confRow = conf[0];
      if (!confRow) throw new NotFoundException('RJ conference not found');
      if (confRow.status === 'RESOLVED_SUCCESSFULLY' || confRow.status === 'FAILED') {
        throw new BadRequestException(
          'Cannot add actions to a conference in status ' + confRow.status,
        );
      }
      // Validate assignee student
      const stu = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM sis_students WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        input.assignedToStudentId,
      )) as Array<{ id: string }>;
      if (stu.length === 0) {
        throw new BadRequestException(
          'assignedToStudentId does not match a student in this school',
        );
      }
      const id = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO sis_rj_agreement_actions ' +
          '(id, conference_id, action_description, assigned_to_student_id, due_date, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::date, $6)',
        id,
        conferenceId,
        input.actionDescription,
        input.assignedToStudentId,
        input.dueDate,
        'PENDING',
      );
      return id;
    });
    return this.getActionById(actionId);
  }

  private async getActionById(id: string): Promise<RjActionResponseDto> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_ACTION_BASE + 'WHERE a.id = $1::uuid LIMIT 1',
        id,
      )) as ActionRow[];
      const first = rows[0];
      if (!first) throw new NotFoundException('Action not found');
      return rowToActionDto(first);
    });
  }

  /**
   * Mark action COMPLETED with evidence. Counsellor/admin only. If
   * every action on the parent conference ends up COMPLETED, the
   * service auto-transitions the conference to RESOLVED_SUCCESSFULLY
   * inside the same tenant tx and emits beh.rj_conference.resolved
   * via the durable outbox.
   */
  async completeAction(
    actionId: string,
    input: CompleteRjActionDto,
    actor: ResolvedActor,
  ): Promise<{ action: RjActionResponseDto; conferenceResolved: boolean }> {
    if (!(await this.hasCounsellorScope(actor))) {
      throw new ForbiddenException('Only counsellors or admins can complete agreement actions');
    }
    const tenant = getCurrentTenant();
    const verifierId = actor.employeeId;
    if (!verifierId) {
      throw new BadRequestException('Caller has no hr_employees row in this school.');
    }

    const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the action + conference rows
      const action = (await tx.$queryRawUnsafe(
        'SELECT a.id::text AS id, a.conference_id::text AS conference_id, a.status ' +
          'FROM sis_rj_agreement_actions a ' +
          'JOIN sis_restorative_justice_conferences c ON c.id = a.conference_id ' +
          'WHERE a.id = $1::uuid AND c.school_id = $2::uuid ' +
          'FOR UPDATE OF a',
        actionId,
        tenant.schoolId,
      )) as Array<{ id: string; conference_id: string; status: string }>;
      const actionRow = action[0];
      if (!actionRow) throw new NotFoundException('Action not found');
      if (actionRow.status === 'COMPLETED') {
        throw new BadRequestException('Action is already COMPLETED');
      }

      const confId = actionRow.conference_id;

      // Flip action to COMPLETED with timestamp + verifier — schema
      // completed_chk requires all 3 together
      await tx.$executeRawUnsafe(
        'UPDATE sis_rj_agreement_actions SET status = $1, completed_at = now(), ' +
          'verified_by = $2::uuid, evidence_notes = COALESCE($3, evidence_notes), ' +
          'updated_at = now() WHERE id = $4::uuid',
        'COMPLETED',
        verifierId,
        input.evidenceNotes ?? null,
        actionId,
      );

      // Check if ALL actions for this conference are now COMPLETED
      const counts = (await tx.$queryRawUnsafe(
        'SELECT ' +
          "  COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS done, " +
          '  COUNT(*)::int AS total ' +
          'FROM sis_rj_agreement_actions WHERE conference_id = $1::uuid',
        confId,
      )) as Array<{ done: number; total: number }>;

      let resolved = false;
      const countRow = counts[0];
      if (countRow && countRow.total > 0 && countRow.done === countRow.total) {
        // Auto-transition conference to RESOLVED_SUCCESSFULLY
        const confRows = (await tx.$queryRawUnsafe(
          'SELECT offender_student_id::text AS offender_student_id, ' +
            'harmed_party_ids, status FROM sis_restorative_justice_conferences ' +
            'WHERE id = $1::uuid FOR UPDATE',
          confId,
        )) as Array<{
          offender_student_id: string;
          harmed_party_ids: string[];
          status: string;
        }>;
        const confRow = confRows[0];
        if (confRow && confRow.status !== 'RESOLVED_SUCCESSFULLY' && confRow.status !== 'FAILED') {
          await tx.$executeRawUnsafe(
            'UPDATE sis_restorative_justice_conferences SET ' +
              "status = 'RESOLVED_SUCCESSFULLY', resolution_date = now(), updated_at = now() " +
              'WHERE id = $1::uuid',
            confId,
          );
          resolved = true;

          // Durable outbox emit — beh.rj_conference.resolved
          await this.outbox.enqueueInTx(tx, {
            topic: 'beh.rj_conference.resolved',
            key: confId,
            payload: {
              conferenceId: confId,
              schoolId: tenant.schoolId,
              offenderStudentId: confRow.offender_student_id,
              harmedPartyIds: confRow.harmed_party_ids,
              resolvedAt: new Date().toISOString(),
              actionCount: countRow.total,
              sourceRefId: confId,
            },
            sourceModule: 'behaviour-advanced',
            eventId: deterministicRjResolvedEventId(confId),
          });
        }
      }

      return { confId, resolved };
    });

    const action = await this.getActionById(actionId);
    return { action, conferenceResolved: result.resolved };
  }

  async listActionsForConference(conferenceId: string): Promise<RjActionResponseDto[]> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_ACTION_BASE +
          'WHERE a.conference_id = $1::uuid ORDER BY a.due_date ASC, a.created_at ASC',
        conferenceId,
      )) as ActionRow[];
      return rows.map(rowToActionDto);
    });
  }
}
