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
import { OutboxService } from '../kafka/outbox.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  PARENT_UPDATE_TARGETS,
  type AutoApprovalRuleDto,
  type ParentUpdateRequestDto,
  type ParentUpdateStatus,
  type ParentUpdateTarget,
  type ReviewParentUpdateDto,
  type SubmitParentUpdateDto,
  type UpsertAutoApprovalRuleDto,
} from './dto/sis-advanced.dto';
import {
  deterministicParentUpdateReviewedEventId,
  deterministicParentUpdateSubmittedEventId,
} from './event-ids';

interface RequestRow {
  id: string;
  school_id: string;
  submitted_by: string;
  target_type: string;
  target_id: string;
  proposed_changes: Record<string, unknown>;
  change_reason: string | null;
  status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  applied_at: string | null;
  created_at: string;
}

interface RuleRow {
  id: string;
  school_id: string;
  target_type: string;
  field_name: string;
  auto_approve: boolean;
}

@Injectable()
export class ParentUpdateService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private rowToDto(r: RequestRow): ParentUpdateRequestDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      submittedBy: r.submitted_by,
      targetType: r.target_type as ParentUpdateTarget,
      targetId: r.target_id,
      proposedChanges: r.proposed_changes,
      changeReason: r.change_reason,
      status: r.status as ParentUpdateStatus,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      reviewerNotes: r.reviewer_notes,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
    };
  }

  private ruleRowToDto(r: RuleRow): AutoApprovalRuleDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      targetType: r.target_type as ParentUpdateTarget,
      fieldName: r.field_name,
      autoApprove: r.auto_approve,
    };
  }

  private async isAdmin(actor: ResolvedActor): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    const tenant = getCurrentTenant();
    return this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-002:admin',
    ]);
  }

  /**
   * Auto-approval check — every field in proposed_changes must have an
   * active auto_approve=true rule for the (school, target_type, field).
   * If ANY field lacks a true rule, the request defaults to PENDING.
   */
  private async shouldAutoApprove(
    schoolId: string,
    targetType: string,
    fields: string[],
  ): Promise<boolean> {
    if (fields.length === 0) return false;
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<Array<{ field_name: string; auto_approve: boolean }>>(
        'SELECT field_name, auto_approve FROM sis_auto_approval_rules ' +
          'WHERE school_id = $1::uuid AND target_type = $2 AND field_name = ANY($3::text[])',
        schoolId,
        targetType,
        fields,
      ),
    );
    if (rows.length === 0) return false;
    const allowed = new Set(rows.filter((r) => r.auto_approve === true).map((r) => r.field_name));
    return fields.every((f) => allowed.has(f));
  }

  async submitRequest(
    dto: SubmitParentUpdateDto,
    actor: ResolvedActor,
  ): Promise<ParentUpdateRequestDto> {
    if (!PARENT_UPDATE_TARGETS.includes(dto.targetType)) {
      throw new BadRequestException(
        'targetType must be one of ' + PARENT_UPDATE_TARGETS.join(', '),
      );
    }
    if (
      typeof dto.proposedChanges !== 'object' ||
      dto.proposedChanges === null ||
      Array.isArray(dto.proposedChanges)
    ) {
      throw new BadRequestException('proposedChanges must be a JSON object');
    }
    const fields = Object.keys(dto.proposedChanges);
    if (fields.length === 0) {
      throw new BadRequestException('proposedChanges must contain at least one field');
    }

    // Parent row scope — verify the GUARDIAN actor is linked to the
    // target. STUDENT_INFO requires sis_student_guardians link; GUARDIAN_INFO
    // requires the actor's own iam_person.id matches the guardian; admin
    // bypasses. STAFF on-behalf submission is allowed for admins only.
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'GUARDIAN') {
        throw new ForbiddenException('Only guardians can submit parent update requests.');
      }
      const owns = await this.verifyGuardianTargetLink(actor, dto.targetType, dto.targetId);
      if (!owns) {
        throw new ForbiddenException('You are not authorised to update this record.');
      }
    }

    const tenant = getCurrentTenant();
    const autoApprove = await this.shouldAutoApprove(tenant.schoolId, dto.targetType, fields);
    const status: ParentUpdateStatus = autoApprove ? 'AUTO_APPROVED' : 'PENDING';
    const id = generateId();

    // REVIEW-P2C13 BLOCKING 3 — INSERT + outbox emit land in one tx
    // so the downstream notification is durable. OutboxPublisherWorker
    // publishes when the broker recovers; deterministic event id means
    // a retry lands the same envelope.
    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const insertSql = autoApprove
        ? 'INSERT INTO sis_parent_info_update_requests ' +
          '(id, school_id, submitted_by, target_type, target_id, proposed_changes, ' +
          'change_reason, status, applied_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::jsonb, $7, 'AUTO_APPROVED', now())"
        : 'INSERT INTO sis_parent_info_update_requests ' +
          '(id, school_id, submitted_by, target_type, target_id, proposed_changes, ' +
          'change_reason, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::jsonb, $7, 'PENDING')";
      await tx.$executeRawUnsafe(
        insertSql,
        id,
        tenant.schoolId,
        actor.personId,
        dto.targetType,
        dto.targetId,
        JSON.stringify(dto.proposedChanges),
        dto.changeReason ?? null,
      );

      const after = await tx.$queryRawUnsafe<RequestRow[]>(
        'SELECT id::text, school_id::text, submitted_by::text, target_type, target_id::text, ' +
          'proposed_changes, change_reason, status, reviewed_by::text, reviewed_at::text, ' +
          'reviewer_notes, applied_at::text, created_at::text ' +
          'FROM sis_parent_info_update_requests WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );

      await this.outbox.enqueueInTx(tx, {
        topic: 'sis.parent_update.submitted',
        key: id,
        sourceModule: 'sis-advanced',
        eventId: deterministicParentUpdateSubmittedEventId(id),
        payload: {
          requestId: id,
          schoolId: tenant.schoolId,
          submittedBy: actor.personId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          status: after[0]!.status,
          autoApproved: autoApprove,
          sourceRefId: id,
        },
      });

      return after;
    });
    void status;

    return this.rowToDto(rows[0]!);
  }

  /**
   * Verify the guardian actor has a link to the supplied target in
   * the CURRENT tenant's school. REVIEW-P2C13 BLOCKING 3 — every
   * lookup now joins through sis_students.school_id = tenant.schoolId
   * so a guardian linked to children across schools cannot submit a
   * request under the wrong school context.
   */
  private async verifyGuardianTargetLink(
    actor: ResolvedActor,
    targetType: string,
    targetId: string,
  ): Promise<boolean> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      if (targetType === 'STUDENT_INFO') {
        const rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_student_guardians sg ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          targetId,
          actor.personId,
          tenant.schoolId,
        );
        return rows.length > 0;
      }
      if (targetType === 'GUARDIAN_INFO') {
        // Guardian must be linked to at least one student in the
        // calling tenant's school. Cross-school guardian identities
        // cannot mutate a "their own" record in a school they have
        // no children in.
        const rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_guardians g ' +
            'JOIN sis_student_guardians sg ON sg.guardian_id = g.id ' +
            'JOIN sis_students s ON s.id = sg.student_id ' +
            'WHERE g.id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          targetId,
          actor.personId,
          tenant.schoolId,
        );
        return rows.length > 0;
      }
      if (targetType === 'EMERGENCY_CONTACT') {
        const rows = await client.$queryRawUnsafe<Array<{ ok: number }>>(
          'SELECT 1 AS ok FROM sis_emergency_contacts ec ' +
            'JOIN sis_student_guardians sg ON sg.student_id = ec.student_id ' +
            'JOIN sis_guardians g ON g.id = sg.guardian_id ' +
            'JOIN sis_students s ON s.id = ec.student_id ' +
            'WHERE ec.id = $1::uuid AND g.person_id = $2::uuid ' +
            'AND s.school_id = $3::uuid LIMIT 1',
          targetId,
          actor.personId,
          tenant.schoolId,
        );
        return rows.length > 0;
      }
      return false;
    });
  }

  async listRequests(
    actor: ResolvedActor,
    filters: { status?: string },
  ): Promise<ParentUpdateRequestDto[]> {
    const tenant = getCurrentTenant();
    const sql =
      'SELECT id::text, school_id::text, submitted_by::text, target_type, target_id::text, ' +
      'proposed_changes, change_reason, status, reviewed_by::text, reviewed_at::text, ' +
      'reviewer_notes, applied_at::text, created_at::text ' +
      'FROM sis_parent_info_update_requests WHERE school_id = $1::uuid ' +
      '$ROW_SCOPE$ $STATUS_FILTER$ ORDER BY created_at DESC';
    const params: unknown[] = [tenant.schoolId];
    let rowScope = '';
    let statusFilter = '';
    if (!actor.isSchoolAdmin) {
      params.push(actor.personId);
      rowScope = 'AND submitted_by = $' + params.length + '::uuid ';
    }
    if (filters.status) {
      params.push(filters.status);
      statusFilter = 'AND status = $' + params.length + ' ';
    }
    const finalSql = sql.replace('$ROW_SCOPE$', rowScope).replace('$STATUS_FILTER$', statusFilter);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequestRow[]>(finalSql, ...params),
    );
    return rows.map((r) => this.rowToDto(r));
  }

  async getByIdOrFail(id: string, actor: ResolvedActor): Promise<ParentUpdateRequestDto> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RequestRow[]>(
        'SELECT id::text, school_id::text, submitted_by::text, target_type, target_id::text, ' +
          'proposed_changes, change_reason, status, reviewed_by::text, reviewed_at::text, ' +
          'reviewer_notes, applied_at::text, created_at::text ' +
          'FROM sis_parent_info_update_requests WHERE school_id = $1::uuid AND id = $2::uuid',
        tenant.schoolId,
        id,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Parent update request not found');
    const row = rows[0]!;
    if (!actor.isSchoolAdmin && row.submitted_by !== actor.personId) {
      throw new NotFoundException('Parent update request not found');
    }
    return this.rowToDto(row);
  }

  async reviewRequest(
    id: string,
    dto: ReviewParentUpdateDto,
    actor: ResolvedActor,
  ): Promise<ParentUpdateRequestDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can review parent update requests.');
    }
    if (dto.decision !== 'APPROVED' && dto.decision !== 'REJECTED') {
      throw new BadRequestException('decision must be APPROVED or REJECTED');
    }
    const tenant = getCurrentTenant();

    // REVIEW-P2C13 BLOCKING 3 — lock + update + reload all carry the
    // school_id predicate so a School A admin cannot review a School
    // B request by guessing the UUID. Outbox emit happens inside the
    // same tenant tx so the downstream notification is durable.
    const rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
        'SELECT id::text AS id, status FROM sis_parent_info_update_requests ' +
          'WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        id,
        tenant.schoolId,
      );
      if (locked.length === 0) throw new NotFoundException('Parent update request not found');
      if (locked[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Request is in status ' + locked[0]!.status + '; only PENDING requests can be reviewed.',
        );
      }
      const appliedAt = dto.decision === 'APPROVED' ? 'now()' : 'NULL';
      await tx.$executeRawUnsafe(
        'UPDATE sis_parent_info_update_requests SET status = $1, reviewed_by = $2::uuid, ' +
          'reviewed_at = now(), reviewer_notes = $3, applied_at = ' +
          appliedAt +
          ', updated_at = now() WHERE id = $4::uuid AND school_id = $5::uuid',
        dto.decision,
        actor.personId,
        dto.reviewerNotes ?? null,
        id,
        tenant.schoolId,
      );
      const after = await tx.$queryRawUnsafe<RequestRow[]>(
        'SELECT id::text, school_id::text, submitted_by::text, target_type, target_id::text, ' +
          'proposed_changes, change_reason, status, reviewed_by::text, reviewed_at::text, ' +
          'reviewer_notes, applied_at::text, created_at::text ' +
          'FROM sis_parent_info_update_requests WHERE id = $1::uuid AND school_id = $2::uuid',
        id,
        tenant.schoolId,
      );

      await this.outbox.enqueueInTx(tx, {
        topic: 'sis.parent_update.reviewed',
        key: id,
        sourceModule: 'sis-advanced',
        eventId: deterministicParentUpdateReviewedEventId(id),
        payload: {
          requestId: id,
          schoolId: tenant.schoolId,
          decision: dto.decision,
          reviewedBy: actor.personId,
          reviewedAt: after[0]!.reviewed_at,
          reviewerNotes: dto.reviewerNotes ?? null,
          sourceRefId: id,
        },
      });

      return after;
    });

    return this.rowToDto(rows[0]!);
  }

  // ─── Auto-approval rules ───

  async listRules(): Promise<AutoApprovalRuleDto[]> {
    const tenant = getCurrentTenant();
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RuleRow[]>(
        'SELECT id::text, school_id::text, target_type, field_name, auto_approve ' +
          'FROM sis_auto_approval_rules WHERE school_id = $1::uuid ORDER BY target_type, field_name',
        tenant.schoolId,
      ),
    );
    return rows.map((r) => this.ruleRowToDto(r));
  }

  async upsertRule(
    dto: UpsertAutoApprovalRuleDto,
    actor: ResolvedActor,
  ): Promise<AutoApprovalRuleDto> {
    if (!(await this.isAdmin(actor))) {
      throw new ForbiddenException('Only admins can configure auto-approval rules.');
    }
    if (!PARENT_UPDATE_TARGETS.includes(dto.targetType)) {
      throw new BadRequestException(
        'targetType must be one of ' + PARENT_UPDATE_TARGETS.join(', '),
      );
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$executeRawUnsafe(
        'INSERT INTO sis_auto_approval_rules (id, school_id, target_type, field_name, auto_approve) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5) ' +
          'ON CONFLICT (school_id, target_type, field_name) DO UPDATE SET ' +
          'auto_approve = EXCLUDED.auto_approve, updated_at = now()',
        id,
        tenant.schoolId,
        dto.targetType,
        dto.fieldName,
        dto.autoApprove,
      ),
    );
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<RuleRow[]>(
        'SELECT id::text, school_id::text, target_type, field_name, auto_approve ' +
          'FROM sis_auto_approval_rules WHERE school_id = $1::uuid AND target_type = $2 AND field_name = $3',
        tenant.schoolId,
        dto.targetType,
        dto.fieldName,
      ),
    );
    return this.ruleRowToDto(rows[0]!);
  }
}
