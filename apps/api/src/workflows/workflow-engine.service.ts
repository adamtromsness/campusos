import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import {
  ApprovalCommentResponseDto,
  ApprovalRequestResponseDto,
  ApprovalRequestStatus,
  ApprovalStepResponseDto,
  ApprovalStepStatus,
  ApproverType,
  ListApprovalsQueryDto,
  SubmitApprovalDto,
} from './dto/workflow.dto';

interface RequestRow {
  id: string;
  school_id: string;
  template_id: string;
  template_name: string;
  requester_id: string;
  requester_first_name: string | null;
  requester_last_name: string | null;
  request_type: string;
  reference_id: string | null;
  reference_table: string | null;
  status: string;
  submitted_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  request_id: string;
  step_order: number;
  approver_id: string;
  approver_first_name: string | null;
  approver_last_name: string | null;
  status: string;
  actioned_at: string | null;
  comments: string | null;
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: string;
  request_id: string;
  author_id: string;
  author_first_name: string | null;
  author_last_name: string | null;
  body: string;
  is_requester_visible: boolean;
  created_at: string;
}

interface TemplateStepRow {
  id: string;
  step_order: number;
  approver_type: string;
  approver_ref: string | null;
  timeout_hours: number | null;
}

function fullName(first: string | null, last: string | null): string | null {
  if (first && last) return first + ' ' + last;
  return null;
}

function requestRowToBase(row: RequestRow): Omit<ApprovalRequestResponseDto, 'steps' | 'comments'> {
  return {
    id: row.id,
    schoolId: row.school_id,
    templateId: row.template_id,
    templateName: row.template_name,
    requesterId: row.requester_id,
    requesterName: fullName(row.requester_first_name, row.requester_last_name),
    requestType: row.request_type,
    referenceId: row.reference_id,
    referenceTable: row.reference_table,
    status: row.status as ApprovalRequestStatus,
    submittedAt: row.submitted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stepRowToDto(row: StepRow): ApprovalStepResponseDto {
  return {
    id: row.id,
    requestId: row.request_id,
    stepOrder: row.step_order,
    approverId: row.approver_id,
    approverName: fullName(row.approver_first_name, row.approver_last_name),
    status: row.status as ApprovalStepStatus,
    actionedAt: row.actioned_at,
    comments: row.comments,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentRowToDto(row: CommentRow): ApprovalCommentResponseDto {
  return {
    id: row.id,
    requestId: row.request_id,
    authorId: row.author_id,
    authorName: fullName(row.author_first_name, row.author_last_name),
    body: row.body,
    isRequesterVisible: row.is_requester_visible,
    createdAt: row.created_at,
  };
}

const SELECT_REQUEST_BASE =
  'SELECT r.id::text AS id, r.school_id::text AS school_id, ' +
  'r.template_id::text AS template_id, t.name AS template_name, ' +
  'r.requester_id::text AS requester_id, ' +
  'rp.first_name AS requester_first_name, rp.last_name AS requester_last_name, ' +
  'r.request_type, r.reference_id::text AS reference_id, r.reference_table, r.status, ' +
  "TO_CHAR(r.submitted_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS submitted_at, " +
  "TO_CHAR(r.resolved_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS resolved_at, " +
  "TO_CHAR(r.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS created_at, " +
  "TO_CHAR(r.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS updated_at " +
  'FROM wsk_approval_requests r ' +
  'JOIN wsk_workflow_templates t ON t.id = r.template_id ' +
  'LEFT JOIN platform.platform_users rpu ON rpu.id = r.requester_id ' +
  'LEFT JOIN platform.iam_person rp ON rp.id = rpu.person_id ';

const SELECT_STEP_BASE =
  'SELECT s.id::text AS id, s.request_id::text AS request_id, s.step_order, ' +
  's.approver_id::text AS approver_id, ' +
  'ap.first_name AS approver_first_name, ap.last_name AS approver_last_name, ' +
  's.status, ' +
  "TO_CHAR(s.actioned_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS actioned_at, " +
  's.comments, ' +
  "TO_CHAR(s.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS created_at, " +
  "TO_CHAR(s.updated_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS updated_at " +
  'FROM wsk_approval_steps s ' +
  'LEFT JOIN platform.platform_users apu ON apu.id = s.approver_id ' +
  'LEFT JOIN platform.iam_person ap ON ap.id = apu.person_id ';

const SELECT_COMMENT_BASE =
  'SELECT c.id::text AS id, c.request_id::text AS request_id, ' +
  'c.author_id::text AS author_id, ' +
  'cp.first_name AS author_first_name, cp.last_name AS author_last_name, ' +
  'c.body, c.is_requester_visible, ' +
  "TO_CHAR(c.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SSOF') AS created_at " +
  'FROM wsk_approval_comments c ' +
  'LEFT JOIN platform.platform_users cpu ON cpu.id = c.author_id ' +
  'LEFT JOIN platform.iam_person cp ON cp.id = cpu.person_id ';

@Injectable()
export class WorkflowEngineService {
  private readonly logger = new Logger(WorkflowEngineService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  /**
   * Submit a new approval request. The source module hands us the
   * request_type plus an optional polymorphic reference (table + row
   * id); the engine resolves the active workflow template, creates the
   * wsk_approval_requests row, and activates Step 1 with a resolved
   * approver. Returns the full response including the new awaiting
   * step.
   *
   * Falls back gracefully when no template exists for the request type
   * — the source module gets a 400 with a clear message rather than a
   * silent no-op.
   */
  async submit(
    body: SubmitApprovalDto,
    actor: ResolvedActor,
  ): Promise<ApprovalRequestResponseDto> {
    const tenant = getCurrentTenant();
    const requesterId =
      body.requesterAccountId && actor.isSchoolAdmin ? body.requesterAccountId : actor.accountId;

    if (
      body.requesterAccountId &&
      body.requesterAccountId !== actor.accountId &&
      !actor.isSchoolAdmin
    ) {
      throw new ForbiddenException('Only admins can submit on behalf of another user');
    }
    if ((body.referenceId && !body.referenceTable) || (!body.referenceId && body.referenceTable)) {
      throw new BadRequestException('referenceId and referenceTable must be provided together');
    }

    const requestId = generateId();
    let createdStep: ApprovalStepResponseDto | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const tplRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM wsk_workflow_templates ' +
          'WHERE school_id = $1::uuid AND request_type = $2 AND is_active = true LIMIT 1',
        tenant.schoolId,
        body.requestType,
      );
      if (tplRows.length === 0) {
        throw new BadRequestException(
          'No active workflow template configured for request type "' + body.requestType + '"',
        );
      }
      const templateId = tplRows[0]!.id;

      const stepRows = await tx.$queryRawUnsafe<TemplateStepRow[]>(
        'SELECT id::text AS id, step_order, approver_type, approver_ref, timeout_hours ' +
          'FROM wsk_workflow_steps WHERE template_id = $1::uuid ORDER BY step_order ASC',
        templateId,
      );
      if (stepRows.length === 0) {
        throw new BadRequestException(
          'Workflow template "' + body.requestType + '" has no steps configured',
        );
      }

      const firstStep = stepRows[0]!;
      const approverId = await this.resolveApprover(tx, firstStep, requesterId, tenant.schoolId);
      if (!approverId) {
        throw new BadRequestException(
          'Could not resolve an approver for Step ' +
            firstStep.step_order +
            ' (approver_type=' +
            firstStep.approver_type +
            ')',
        );
      }

      await tx.$executeRawUnsafe(
        'INSERT INTO wsk_approval_requests ' +
          '(id, school_id, template_id, requester_id, request_type, reference_id, reference_table, status, submitted_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7, 'PENDING', now())",
        requestId,
        tenant.schoolId,
        templateId,
        requesterId,
        body.requestType,
        body.referenceId ?? null,
        body.referenceTable ?? null,
      );

      const stepId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO wsk_approval_steps ' +
          "(id, request_id, step_order, approver_id, status) " +
          "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'AWAITING')",
        stepId,
        requestId,
        firstStep.step_order,
        approverId,
      );

      const stepDto = await this.loadStep(tx, stepId);
      createdStep = stepDto;
    });

    void this.emitStepAwaiting(tenant.schoolId, tenant.subdomain, requestId, createdStep!);
    return this.getById(requestId, actor);
  }

  /**
   * Approve or reject an awaiting step. Locks the step row FOR UPDATE
   * inside one tx so two parallel approvers serialise. On approve: if
   * more steps remain, create + activate the next; otherwise resolve
   * the request as APPROVED. On reject: resolve the request as
   * REJECTED, mark every still-AWAITING step SKIPPED. Both terminal
   * paths fire approval.request.resolved exactly once.
   */
  async advanceStep(
    requestId: string,
    stepId: string,
    decision: 'APPROVED' | 'REJECTED',
    comments: string | undefined,
    actor: ResolvedActor,
  ): Promise<ApprovalRequestResponseDto> {
    const tenant = getCurrentTenant();
    let resolveStatus: 'APPROVED' | 'REJECTED' | null = null;
    let nextStep: ApprovalStepResponseDto | null = null;
    let resolvedRequestRow: RequestRow | null = null;

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const stepRows = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          request_id: string;
          step_order: number;
          approver_id: string;
          status: string;
        }>
      >(
        'SELECT id::text AS id, request_id::text AS request_id, step_order, ' +
          'approver_id::text AS approver_id, status ' +
          'FROM wsk_approval_steps WHERE id = $1::uuid AND request_id = $2::uuid FOR UPDATE',
        stepId,
        requestId,
      );
      if (stepRows.length === 0) throw new NotFoundException('Approval step ' + stepId);
      const step = stepRows[0]!;
      if (step.status !== 'AWAITING') {
        throw new BadRequestException(
          'Only AWAITING steps can be ' +
            (decision === 'APPROVED' ? 'approved' : 'rejected') +
            '; this one is ' +
            step.status,
        );
      }
      if (!actor.isSchoolAdmin && step.approver_id !== actor.accountId) {
        throw new ForbiddenException('You are not the assigned approver for this step');
      }

      const reqRows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        'SELECT status FROM wsk_approval_requests WHERE id = $1::uuid FOR UPDATE',
        requestId,
      );
      if (reqRows.length === 0) throw new NotFoundException('Approval request ' + requestId);
      if (reqRows[0]!.status !== 'PENDING') {
        throw new BadRequestException(
          'Cannot action a step on a ' + reqRows[0]!.status + ' request',
        );
      }

      // 1. Mark this step as APPROVED / REJECTED.
      await tx.$executeRawUnsafe(
        'UPDATE wsk_approval_steps SET status = $1, actioned_at = now(), comments = $2, updated_at = now() ' +
          'WHERE id = $3::uuid',
        decision,
        comments ?? null,
        stepId,
      );

      if (decision === 'REJECTED') {
        // Skip every remaining AWAITING step (none exist in
        // sequential mode but defensive for future is_parallel).
        await tx.$executeRawUnsafe(
          "UPDATE wsk_approval_steps SET status = 'SKIPPED', updated_at = now() " +
            "WHERE request_id = $1::uuid AND status = 'AWAITING'",
          requestId,
        );
        await tx.$executeRawUnsafe(
          "UPDATE wsk_approval_requests SET status = 'REJECTED', resolved_at = now(), updated_at = now() " +
            'WHERE id = $1::uuid',
          requestId,
        );
        resolveStatus = 'REJECTED';
      } else {
        // APPROVED — look up the next template step.
        const templateRows = await tx.$queryRawUnsafe<TemplateStepRow[]>(
          'SELECT ws.id::text AS id, ws.step_order, ws.approver_type, ws.approver_ref, ws.timeout_hours ' +
            'FROM wsk_workflow_steps ws ' +
            'JOIN wsk_approval_requests r ON r.template_id = ws.template_id ' +
            'WHERE r.id = $1::uuid AND ws.step_order > $2 ' +
            'ORDER BY ws.step_order ASC LIMIT 1',
          requestId,
          step.step_order,
        );

        if (templateRows.length === 0) {
          // No more steps — request resolved as APPROVED.
          await tx.$executeRawUnsafe(
            "UPDATE wsk_approval_requests SET status = 'APPROVED', resolved_at = now(), updated_at = now() " +
              'WHERE id = $1::uuid',
            requestId,
          );
          resolveStatus = 'APPROVED';
        } else {
          const nextTemplate = templateRows[0]!;
          // Resolve approver for the next step. Need requester_id from
          // the request row.
          const r2 = await tx.$queryRawUnsafe<Array<{ requester_id: string; school_id: string }>>(
            'SELECT requester_id::text AS requester_id, school_id::text AS school_id ' +
              'FROM wsk_approval_requests WHERE id = $1::uuid',
            requestId,
          );
          if (r2.length === 0) throw new NotFoundException('Approval request ' + requestId);
          const requesterId = r2[0]!.requester_id;
          const schoolId = r2[0]!.school_id;
          const nextApproverId = await this.resolveApprover(
            tx,
            nextTemplate,
            requesterId,
            schoolId,
          );
          if (!nextApproverId) {
            throw new BadRequestException(
              'Could not resolve an approver for the next step (approver_type=' +
                nextTemplate.approver_type +
                ')',
            );
          }
          const nextStepId = generateId();
          await tx.$executeRawUnsafe(
            'INSERT INTO wsk_approval_steps ' +
              "(id, request_id, step_order, approver_id, status) " +
              "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'AWAITING')",
            nextStepId,
            requestId,
            nextTemplate.step_order,
            nextApproverId,
          );
          const dto = await this.loadStep(tx, nextStepId);
          nextStep = dto;
        }
      }

      if (resolveStatus !== null) {
        const reqDetail = await tx.$queryRawUnsafe<RequestRow[]>(
          SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid',
          requestId,
        );
        if (reqDetail.length > 0) resolvedRequestRow = reqDetail[0]!;
      }
    });

    if (resolveStatus !== null && resolvedRequestRow !== null) {
      const r = resolvedRequestRow as RequestRow;
      void this.kafka.emit({
        topic: 'approval.request.resolved',
        key: requestId,
        sourceModule: 'workflows',
        payload: {
          requestId,
          requestType: r.request_type,
          referenceId: r.reference_id,
          referenceTable: r.reference_table,
          requesterId: r.requester_id,
          status: resolveStatus,
        },
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
      });
    } else if (nextStep !== null) {
      void this.emitStepAwaiting(
        tenant.schoolId,
        tenant.subdomain,
        requestId,
        nextStep as ApprovalStepResponseDto,
      );
    }

    return this.getById(requestId, actor);
  }

  /**
   * Requester-only — withdraws a still-PENDING request. Skips every
   * AWAITING step. Does NOT emit approval.request.resolved (the source
   * module shouldn't act on a withdrawn request — it's the requester's
   * own decision to pull back).
   */
  async withdraw(requestId: string, actor: ResolvedActor): Promise<ApprovalRequestResponseDto> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ requester_id: string; status: string }>>(
        'SELECT requester_id::text AS requester_id, status FROM wsk_approval_requests ' +
          'WHERE id = $1::uuid FOR UPDATE',
        requestId,
      );
      if (rows.length === 0) throw new NotFoundException('Approval request ' + requestId);
      const row = rows[0]!;
      if (!actor.isSchoolAdmin && row.requester_id !== actor.accountId) {
        throw new ForbiddenException('Only the requester can withdraw this request');
      }
      if (row.status !== 'PENDING') {
        throw new BadRequestException(
          'Only PENDING requests can be withdrawn; this one is ' + row.status,
        );
      }
      await tx.$executeRawUnsafe(
        "UPDATE wsk_approval_steps SET status = 'SKIPPED', updated_at = now() " +
          "WHERE request_id = $1::uuid AND status = 'AWAITING'",
        requestId,
      );
      await tx.$executeRawUnsafe(
        "UPDATE wsk_approval_requests SET status = 'WITHDRAWN', resolved_at = now(), updated_at = now() " +
          'WHERE id = $1::uuid',
        requestId,
      );
    });
    return this.getById(requestId, actor);
  }

  async addComment(
    requestId: string,
    body: string,
    isRequesterVisible: boolean,
    actor: ResolvedActor,
  ): Promise<ApprovalCommentResponseDto> {
    // Existence + row-scope check via the standard getById gate.
    await this.getById(requestId, actor);
    const id = generateId();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO wsk_approval_comments (id, request_id, author_id, body, is_requester_visible) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        id,
        requestId,
        actor.accountId,
        body,
        isRequesterVisible,
      );
    });
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CommentRow[]>(
        SELECT_COMMENT_BASE + 'WHERE c.id = $1::uuid',
        id,
      );
    });
    return commentRowToDto(rows[0]!);
  }

  /**
   * List approval requests visible to the caller. Default scope:
   *   - admin: every row in the tenant (or filter ?mine=true to see
   *            their own as a requester),
   *   - non-admin: own (requester_id = caller) + rows where the caller
   *            is the active approver on any step.
   */
  async list(
    query: ListApprovalsQueryDto,
    actor: ResolvedActor,
  ): Promise<ApprovalRequestResponseDto[]> {
    const params: any[] = [];
    let idx = 1;
    let where = 'WHERE 1=1 ';
    if (actor.isSchoolAdmin) {
      if (query.mine === true) {
        where += 'AND r.requester_id = $' + idx + '::uuid ';
        params.push(actor.accountId);
        idx++;
      }
    } else {
      // Non-admin scope: own OR I'm an approver on some step.
      where +=
        'AND (r.requester_id = $' +
        idx +
        '::uuid OR EXISTS ' +
        '(SELECT 1 FROM wsk_approval_steps ss WHERE ss.request_id = r.id AND ss.approver_id = $' +
        idx +
        '::uuid)) ';
      params.push(actor.accountId);
      idx++;
    }
    if (query.status) {
      where += 'AND r.status = $' + idx + ' ';
      params.push(query.status);
      idx++;
    }
    if (query.requestType) {
      where += 'AND r.request_type = $' + idx + ' ';
      params.push(query.requestType);
      idx++;
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + where + 'ORDER BY r.created_at DESC LIMIT 200',
        ...params,
      );
    });
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const steps = await this.loadStepsForRequests(ids);
    const comments = await this.loadCommentsForRequests(ids, actor);
    return rows.map((r) => ({
      ...requestRowToBase(r),
      steps: steps.filter((s) => s.requestId === r.id),
      comments: comments.filter((c) => c.requestId === r.id),
    }));
  }

  async getById(id: string, actor: ResolvedActor): Promise<ApprovalRequestResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RequestRow[]>(
        SELECT_REQUEST_BASE + 'WHERE r.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Approval request ' + id);
    const row = rows[0]!;
    const stepDtos = await this.loadStepsForRequests([id]);
    if (!actor.isSchoolAdmin) {
      const isRequester = row.requester_id === actor.accountId;
      const isApprover = stepDtos.some((s) => s.approverId === actor.accountId);
      if (!isRequester && !isApprover) {
        throw new NotFoundException('Approval request ' + id);
      }
    }
    const commentDtos = await this.loadCommentsForRequests([id], actor);
    return {
      ...requestRowToBase(row),
      steps: stepDtos,
      comments: commentDtos,
    };
  }

  // ── helpers ───────────────────────────────────────────────────────

  private async loadStep(tx: any, stepId: string): Promise<ApprovalStepResponseDto> {
    const rows = (await tx.$queryRawUnsafe(
      SELECT_STEP_BASE + 'WHERE s.id = $1::uuid',
      stepId,
    )) as StepRow[];
    if (rows.length === 0) throw new NotFoundException('Approval step ' + stepId);
    return stepRowToDto(rows[0]!);
  }

  private async loadStepsForRequests(requestIds: string[]): Promise<ApprovalStepResponseDto[]> {
    if (requestIds.length === 0) return [];
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StepRow[]>(
        SELECT_STEP_BASE +
          'WHERE s.request_id = ANY($1::uuid[]) ORDER BY s.request_id, s.step_order',
        requestIds,
      );
    });
    return rows.map(stepRowToDto);
  }

  private async loadCommentsForRequests(
    requestIds: string[],
    actor: ResolvedActor,
  ): Promise<ApprovalCommentResponseDto[]> {
    if (requestIds.length === 0) return [];
    // Non-admins who are the requester see only requester-visible
    // comments; approvers see everything (admin-internal too) so they
    // can collaborate. Admins always see all.
    const requesterClause = actor.isSchoolAdmin
      ? ''
      : ' AND (c.is_requester_visible = true OR EXISTS ' +
        '(SELECT 1 FROM wsk_approval_steps ss WHERE ss.request_id = c.request_id AND ss.approver_id = $2::uuid))';
    const sql =
      SELECT_COMMENT_BASE +
      'WHERE c.request_id = ANY($1::uuid[])' +
      requesterClause +
      ' ORDER BY c.request_id, c.created_at';
    const params: any[] = [requestIds];
    if (!actor.isSchoolAdmin) params.push(actor.accountId);
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<CommentRow[]>(sql, ...params);
    });
    return rows.map(commentRowToDto);
  }

  /**
   * Resolve a single account_id to act as the approver on a step.
   * SPECIFIC_USER returns the approver_ref directly. ROLE queries the
   * iam_role_assignment table for accounts holding the role token in
   * the school's scope chain. MANAGER and DEPARTMENT_HEAD are deferred
   * — they fall back to the first school admin so the engine still
   * makes progress (the plan acknowledges this fallback).
   *
   * The first matching account_id wins (deterministic by id) — the
   * engine is sequential-only this cycle so we need exactly one
   * approver per step.
   */
  private async resolveApprover(
    tx: any,
    step: TemplateStepRow,
    requesterId: string,
    schoolId: string,
  ): Promise<string | null> {
    const type = step.approver_type as ApproverType;
    if (type === 'SPECIFIC_USER') {
      if (!step.approver_ref) return null;
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id::text AS id FROM platform.platform_users WHERE id = $1::uuid LIMIT 1',
        step.approver_ref,
      )) as Array<{ id: string }>;
      return rows.length > 0 ? rows[0]!.id : null;
    }
    if (type === 'ROLE') {
      if (!step.approver_ref) return null;
      const roleName = roleTokenToName(step.approver_ref);
      const rows = (await tx.$queryRawUnsafe(
        'SELECT ra.account_id::text AS account_id FROM platform.iam_role_assignment ra ' +
          'JOIN platform.roles r ON r.id = ra.role_id ' +
          'JOIN platform.iam_scope sc ON sc.id = ra.scope_id ' +
          'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
          "WHERE ra.status = 'ACTIVE' AND r.name = $1 " +
          'AND ra.account_id <> $3::uuid ' +
          "AND ((stp.code = 'SCHOOL' AND sc.entity_id = $2::uuid) OR stp.code = 'PLATFORM') " +
          'ORDER BY ra.account_id LIMIT 1',
        roleName,
        schoolId,
        requesterId,
      )) as Array<{ account_id: string }>;
      if (rows.length > 0) return rows[0]!.account_id;
      // Fall through to school-admin fallback below if the role has no
      // active holders.
    }
    // MANAGER / DEPARTMENT_HEAD / ROLE-fallback — pick the first school
    // admin who is not the requester. Documented Phase 2 deferral; the
    // proper hr_employees / sis_departments traversal lands when those
    // relationships are populated.
    const adminRows = (await tx.$queryRawUnsafe(
      'SELECT DISTINCT eac.account_id::text AS account_id ' +
        'FROM platform.iam_effective_access_cache eac ' +
        'JOIN platform.iam_scope sc ON sc.id = eac.scope_id ' +
        'JOIN platform.iam_scope_type stp ON stp.id = sc.scope_type_id ' +
        "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
        'AND sc.is_active = true ' +
        'AND eac.account_id <> $2::uuid ' +
        "AND ((stp.code = 'SCHOOL' AND sc.entity_id = $1::uuid) OR stp.code = 'PLATFORM') " +
        'ORDER BY 1 LIMIT 1',
      schoolId,
      requesterId,
    )) as Array<{ account_id: string }>;
    if (adminRows.length > 0) {
      if (type === 'MANAGER' || type === 'DEPARTMENT_HEAD') {
        this.logger.log(
          '[workflow-engine] ' +
            type +
            ' resolution falling back to school admin (proper hr_employees / sis_departments traversal deferred)',
        );
      }
      return adminRows[0]!.account_id;
    }
    return null;
  }

  private emitStepAwaiting(
    schoolId: string,
    subdomain: string,
    requestId: string,
    step: ApprovalStepResponseDto,
  ): void {
    void this.kafka.emit({
      topic: 'approval.step.awaiting',
      key: step.id,
      sourceModule: 'workflows',
      payload: {
        requestId,
        stepId: step.id,
        stepOrder: step.stepOrder,
        approverId: step.approverId,
        approverName: step.approverName,
      },
      tenantId: schoolId,
      tenantSubdomain: subdomain,
    });
  }
}

/**
 * 'SCHOOL_ADMIN' → 'School Admin' (matching the seed-iam role names —
 * UPPER + spaces become underscores in the token form, the inverse is
 * lowercase + first-cap on each word).
 */
export function roleTokenToName(token: string): string {
  return token
    .toLowerCase()
    .split('_')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ');
}

