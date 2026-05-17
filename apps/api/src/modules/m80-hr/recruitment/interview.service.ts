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
import { ApplicationService } from './application.service';
import {
  CreateInterviewPanelDto,
  InterviewDto,
  InterviewEvaluationDto,
  InterviewPanelDto,
  InterviewStatus,
  ScheduleInterviewDto,
  SubmitEvaluationDto,
  UpdateInterviewDto,
} from './dto/recruitment.dto';

interface PanelRow {
  id: string;
  posting_id: string;
  panel_name: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

interface PanelMemberRow {
  id: string;
  panel_id: string;
  panelist_person_id: string;
  panelist_first: string | null;
  panelist_last: string | null;
  role_in_panel: string | null;
}

interface InterviewRow {
  id: string;
  application_id: string;
  panel_id: string;
  panel_name: string | null;
  scheduled_at: string;
  duration_minutes: number | null;
  location: string | null;
  meeting_url: string | null;
  status: string;
  notes: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

interface EvaluationRow {
  id: string;
  interview_id: string;
  evaluator_id: string;
  evaluator_first: string | null;
  evaluator_last: string | null;
  rating: string;
  strengths: string | null;
  concerns: string | null;
  notes: string | null;
  submitted_at: string;
}

@Injectable()
export class InterviewService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly applications: ApplicationService,
  ) {}

  // ---------- Panels ------------------------------------------------------

  async listPanels(postingId: string, actor: ResolvedActor): Promise<InterviewPanelDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const panels = (await client.$queryRawUnsafe(
        'SELECT pn.id::text AS id, pn.posting_id::text AS posting_id, pn.panel_name, pn.notes, ' +
          '       pn.is_active, pn.created_at::text AS created_at ' +
          'FROM hr_interview_panels pn ' +
          'JOIN hr_job_postings p ON p.id = pn.posting_id ' +
          'WHERE p.school_id = $1::uuid AND pn.posting_id = $2::uuid ' +
          'ORDER BY pn.panel_name',
        tenant.schoolId,
        postingId,
      )) as PanelRow[];
      if (panels.length === 0) return [];
      const panelIds = panels.map((p) => p.id);
      const members = (await client.$queryRawUnsafe(
        'SELECT m.id::text AS id, m.panel_id::text AS panel_id, ' +
          '       m.panelist_person_id::text AS panelist_person_id, ' +
          '       ip.first_name AS panelist_first, ip.last_name AS panelist_last, ' +
          '       m.role_in_panel ' +
          'FROM hr_interview_panel_members m ' +
          'LEFT JOIN platform.iam_person ip ON ip.id = m.panelist_person_id ' +
          'WHERE m.panel_id = ANY($1::uuid[])',
        panelIds,
      )) as PanelMemberRow[];
      const byPanel = new Map<string, PanelMemberRow[]>();
      for (const m of members) {
        if (!byPanel.has(m.panel_id)) byPanel.set(m.panel_id, []);
        byPanel.get(m.panel_id)!.push(m);
      }
      return panels.map((p) => this.panelRowToDto(p, byPanel.get(p.id) ?? []));
    });
  }

  async createPanel(
    input: CreateInterviewPanelDto,
    actor: ResolvedActor,
  ): Promise<InterviewPanelDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    // Verify posting belongs to this tenant.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_job_postings WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.postingId,
      )) as Array<{ id: string }>;
      if (r.length === 0)
        throw new BadRequestException('postingId does not belong to this school.');
    });
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_interview_panels (id, posting_id, panel_name, notes, created_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)',
          id,
          input.postingId,
          input.panelName,
          input.notes ?? null,
          actor.accountId,
        );
      } catch (e: any) {
        if (this.isUniqueViolation(e)) {
          throw new BadRequestException('A panel with this name already exists for the posting.');
        }
        throw e;
      }
      for (const personId of input.panelistPersonIds) {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_interview_panel_members (id, panel_id, panelist_person_id) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid) ON CONFLICT DO NOTHING',
          generateId(),
          id,
          personId,
        );
      }
      const panels = await this.listPanels(input.postingId, actor);
      const created = panels.find((p) => p.id === id);
      if (!created) throw new NotFoundException('Panel not found post-create');
      return created;
    });
  }

  // ---------- Interviews -------------------------------------------------

  async schedule(input: ScheduleInterviewDto, actor: ResolvedActor): Promise<InterviewDto> {
    await this.assertAdmin(actor);
    const application = await this.applications.loadInternal(input.applicationId);
    if (!application) {
      throw new BadRequestException('applicationId does not belong to this school.');
    }
    // Confirm panel belongs to the same posting.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT id FROM hr_interview_panels WHERE id = $1::uuid AND posting_id = $2::uuid AND is_active = true LIMIT 1',
        input.panelId,
        application.postingId,
      )) as Array<{ id: string }>;
      if (r.length === 0) {
        throw new BadRequestException(
          "panelId does not belong to this application's posting or is inactive.",
        );
      }
    });
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO hr_interviews ' +
          '(id, application_id, panel_id, scheduled_at, duration_minutes, location, meeting_url, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6, $7, $8)',
        id,
        input.applicationId,
        input.panelId,
        input.scheduledAt,
        input.durationMinutes ?? null,
        input.location ?? null,
        input.meetingUrl ?? null,
        input.notes ?? null,
      );
      // Advance the application status — first interview moves it
      // out of SCREENING / SUBMITTED into INTERVIEW_SCHEDULED.
      await this.applications.advanceStatusInTx(tx, input.applicationId, 'INTERVIEW_SCHEDULED');
      return this.getById(id, actor);
    });
  }

  async listForApplication(applicationId: string, actor: ResolvedActor): Promise<InterviewDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        this.SELECT_INTERVIEW_BASE() +
          'WHERE p.school_id = $1::uuid AND i.application_id = $2::uuid ' +
          'ORDER BY i.scheduled_at DESC',
        tenant.schoolId,
        applicationId,
      )) as InterviewRow[];
      return rows.map((r) => this.interviewRowToDto(r));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<InterviewDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        this.SELECT_INTERVIEW_BASE() + 'WHERE p.school_id = $1::uuid AND i.id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as InterviewRow[];
      if (rows.length === 0) throw new NotFoundException('Interview not found');
      return this.interviewRowToDto(rows[0]!);
    });
  }

  async patch(id: string, input: UpdateInterviewDto, actor: ResolvedActor): Promise<InterviewDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT i.id, i.status, i.application_id::text AS application_id ' +
          'FROM hr_interviews i ' +
          'JOIN hr_applications a ON a.id = i.application_id ' +
          'JOIN hr_job_postings p ON p.id = a.posting_id ' +
          'WHERE p.school_id = $1::uuid AND i.id = $2::uuid FOR UPDATE OF i',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string; application_id: string }>;
      if (lock.length === 0) throw new NotFoundException('Interview not found');
      const cur = lock[0]!.status as InterviewStatus;
      if (cur === 'COMPLETED' || cur === 'NO_SHOW' || cur === 'CANCELLED') {
        // Only allow notes editing on terminal interviews; status
        // re-flips are rejected per the lockstep CHECK on
        // completed_at + cancelled_at.
        if (input.status !== undefined && input.status !== cur) {
          throw new BadRequestException('Cannot transition out of terminal status ' + cur + '.');
        }
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (col: string, value: unknown) => {
        sets.push(col + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.notes !== undefined) push('notes', input.notes);
      if (input.status !== undefined && input.status !== cur) {
        const target = input.status;
        push('status', target);
        if (target === 'COMPLETED') {
          sets.push('completed_at = now()');
        } else if (target === 'CANCELLED') {
          const reason = input.cancellationReason?.trim();
          if (!reason) {
            throw new BadRequestException('CANCELLED interviews require cancellationReason.');
          }
          sets.push('cancelled_at = now()');
          push('cancellation_reason', reason);
        }
      }

      if (sets.length === 0) return this.getById(id, actor);
      sets.push('updated_at = now()');
      values.push(id);
      await tx.$executeRawUnsafe(
        'UPDATE hr_interviews SET ' + sets.join(', ') + ' WHERE id = $' + n + '::uuid',
        ...values,
      );
      // When the only interview on an application completes, advance
      // application status to INTERVIEW_COMPLETED so the offer
      // surface can pick it up. Idempotent — the UPDATE is a no-op
      // when status already matches.
      if (input.status === 'COMPLETED') {
        await this.applications.advanceStatusInTx(
          tx,
          lock[0]!.application_id,
          'INTERVIEW_COMPLETED',
        );
      }
      return this.getById(id, actor);
    });
  }

  // ---------- Evaluations ------------------------------------------------

  async submitEvaluation(
    interviewId: string,
    input: SubmitEvaluationDto,
    actor: ResolvedActor,
  ): Promise<InterviewEvaluationDto> {
    if (!actor.personId) {
      throw new ForbiddenException('Evaluations must be submitted under a named user.');
    }
    // Confirm interview is in this tenant + reachable. The service-layer
    // check reuses getById which gates on assertAdmin, so we manually
    // verify the panelist scope: the actor must be a member of the
    // panel that conducted the interview.
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT 1 FROM hr_interview_panel_members m ' +
          'JOIN hr_interviews i ON i.panel_id = m.panel_id ' +
          'JOIN hr_applications a ON a.id = i.application_id ' +
          'JOIN hr_job_postings p ON p.id = a.posting_id ' +
          'WHERE i.id = $1::uuid AND m.panelist_person_id = $2::uuid AND p.school_id = $3::uuid LIMIT 1',
        interviewId,
        actor.personId,
        tenant.schoolId,
      )) as unknown[];
      if (rows.length === 0) {
        throw new ForbiddenException(
          'Only panel members for this interview can submit evaluations.',
        );
      }
    });
    const id = generateId();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO hr_interview_evaluations ' +
            '(id, interview_id, evaluator_id, rating, strengths, concerns, notes) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7) ' +
            'ON CONFLICT (interview_id, evaluator_id) DO UPDATE SET ' +
            '  rating = EXCLUDED.rating, ' +
            '  strengths = EXCLUDED.strengths, ' +
            '  concerns = EXCLUDED.concerns, ' +
            '  notes = EXCLUDED.notes, ' +
            '  submitted_at = now(), updated_at = now()',
          id,
          interviewId,
          actor.personId,
          input.rating,
          input.strengths ?? null,
          input.concerns ?? null,
          input.notes ?? null,
        );
      } catch (e: any) {
        throw e;
      }
      const rows = (await tx.$queryRawUnsafe(
        this.SELECT_EVALUATION_BASE() +
          'WHERE e.interview_id = $1::uuid AND e.evaluator_id = $2::uuid LIMIT 1',
        interviewId,
        actor.personId,
      )) as EvaluationRow[];
      return this.evaluationRowToDto(rows[0]!);
    });
  }

  async listEvaluations(
    interviewId: string,
    actor: ResolvedActor,
  ): Promise<InterviewEvaluationDto[]> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        this.SELECT_EVALUATION_BASE() +
          'JOIN hr_interviews i ON i.id = e.interview_id ' +
          'JOIN hr_applications a ON a.id = i.application_id ' +
          'JOIN hr_job_postings p ON p.id = a.posting_id ' +
          'WHERE p.school_id = $1::uuid AND e.interview_id = $2::uuid ' +
          'ORDER BY e.submitted_at DESC',
        tenant.schoolId,
        interviewId,
      )) as EvaluationRow[];
      return rows.map((r) => this.evaluationRowToDto(r));
    });
  }

  // ---------- helpers ----------------------------------------------------

  private SELECT_INTERVIEW_BASE(): string {
    return (
      'SELECT i.id::text AS id, i.application_id::text AS application_id, ' +
      '       i.panel_id::text AS panel_id, pn.panel_name, ' +
      '       i.scheduled_at::text AS scheduled_at, i.duration_minutes, i.location, i.meeting_url, ' +
      '       i.status, i.notes, i.completed_at::text AS completed_at, ' +
      '       i.cancelled_at::text AS cancelled_at, i.cancellation_reason ' +
      'FROM hr_interviews i ' +
      'JOIN hr_interview_panels pn ON pn.id = i.panel_id ' +
      'JOIN hr_applications a ON a.id = i.application_id ' +
      'JOIN hr_job_postings p ON p.id = a.posting_id '
    );
  }

  private SELECT_EVALUATION_BASE(): string {
    return (
      'SELECT e.id::text AS id, e.interview_id::text AS interview_id, ' +
      '       e.evaluator_id::text AS evaluator_id, ' +
      '       ip.first_name AS evaluator_first, ip.last_name AS evaluator_last, ' +
      '       e.rating, e.strengths, e.concerns, e.notes, ' +
      '       e.submitted_at::text AS submitted_at ' +
      'FROM hr_interview_evaluations e ' +
      'LEFT JOIN platform.iam_person ip ON ip.id = e.evaluator_id '
    );
  }

  // REVIEW-P2-4b BLOCKING #1 — admin check on hr-011, not hr-002.
  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'hr-011:admin',
      'hr-011:write',
    ]);
    if (!ok) {
      throw new ForbiddenException('Recruitment administration requires hr-011 or school admin.');
    }
  }

  private panelRowToDto(p: PanelRow, members: PanelMemberRow[]): InterviewPanelDto {
    return {
      id: p.id,
      postingId: p.posting_id,
      panelName: p.panel_name,
      notes: p.notes,
      isActive: p.is_active,
      members: members.map((m) => ({
        id: m.id,
        panelistPersonId: m.panelist_person_id,
        panelistName:
          m.panelist_first || m.panelist_last
            ? [m.panelist_first, m.panelist_last].filter(Boolean).join(' ')
            : null,
        roleInPanel: m.role_in_panel,
      })),
      createdAt: p.created_at,
    };
  }

  private interviewRowToDto(r: InterviewRow): InterviewDto {
    return {
      id: r.id,
      applicationId: r.application_id,
      panelId: r.panel_id,
      panelName: r.panel_name,
      scheduledAt: r.scheduled_at,
      durationMinutes: r.duration_minutes,
      location: r.location,
      meetingUrl: r.meeting_url,
      status: r.status as InterviewStatus,
      notes: r.notes,
      completedAt: r.completed_at,
      cancelledAt: r.cancelled_at,
      cancellationReason: r.cancellation_reason,
    };
  }

  private evaluationRowToDto(r: EvaluationRow): InterviewEvaluationDto {
    const name =
      r.evaluator_first || r.evaluator_last
        ? [r.evaluator_first, r.evaluator_last].filter(Boolean).join(' ')
        : null;
    return {
      id: r.id,
      interviewId: r.interview_id,
      evaluatorId: r.evaluator_id,
      evaluatorName: name,
      rating: r.rating as InterviewEvaluationDto['rating'],
      strengths: r.strengths,
      concerns: r.concerns,
      notes: r.notes,
      submittedAt: r.submitted_at,
    };
  }

  private isUniqueViolation(err: any): boolean {
    if (!err) return false;
    if (err.code === 'P2010' && err.meta?.code === '23505') return true;
    if (typeof err.message === 'string' && /unique/i.test(err.message)) return true;
    return false;
  }
}
