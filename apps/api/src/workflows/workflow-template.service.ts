import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import type { ApproverType } from './dto/workflow.dto';

export interface WorkflowTemplateStepDto {
  id: string;
  stepOrder: number;
  approverType: ApproverType;
  approverRef: string | null;
  isParallel: boolean;
  timeoutHours: number | null;
  escalationTargetId: string | null;
}

export interface WorkflowTemplateDto {
  id: string;
  schoolId: string;
  name: string;
  requestType: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  steps: WorkflowTemplateStepDto[];
}

interface TemplateRow {
  id: string;
  school_id: string;
  name: string;
  request_type: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  id: string;
  template_id: string;
  step_order: number;
  approver_type: string;
  approver_ref: string | null;
  is_parallel: boolean;
  timeout_hours: number | null;
  escalation_target_id: string | null;
}

@Injectable()
export class WorkflowTemplateService {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Admin-only read of every workflow template configured for the
   * tenant. Each row includes its ordered steps inline so the UI can
   * render the chain in one round-trip.
   */
  async list(actor: ResolvedActor): Promise<WorkflowTemplateDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can view workflow templates');
    }
    const tenant = getCurrentTenant();
    const templates = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TemplateRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, request_type, description, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM wsk_workflow_templates WHERE school_id = $1::uuid ORDER BY name',
        tenant.schoolId,
      );
    });
    if (templates.length === 0) return [];
    const steps = await this.loadSteps(templates.map((t) => t.id));
    return templates.map((t) =>
      rowToDto(
        t,
        steps.filter((s) => s.template_id === t.id),
      ),
    );
  }

  async getById(id: string, actor: ResolvedActor): Promise<WorkflowTemplateDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can view workflow templates');
    }
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<TemplateRow[]>(
        'SELECT id::text AS id, school_id::text AS school_id, name, request_type, description, is_active, ' +
          'TO_CHAR(created_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS created_at, ' +
          'TO_CHAR(updated_at, \'YYYY-MM-DD"T"HH24:MI:SSOF\') AS updated_at ' +
          'FROM wsk_workflow_templates WHERE id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Workflow template ' + id);
    const steps = await this.loadSteps([id]);
    return rowToDto(rows[0]!, steps);
  }

  private async loadSteps(templateIds: string[]): Promise<StepRow[]> {
    if (templateIds.length === 0) return [];
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<StepRow[]>(
        'SELECT id::text AS id, template_id::text AS template_id, step_order, approver_type, ' +
          'approver_ref, is_parallel, timeout_hours, ' +
          'escalation_target_id::text AS escalation_target_id ' +
          'FROM wsk_workflow_steps WHERE template_id = ANY($1::uuid[]) ' +
          'ORDER BY template_id, step_order',
        templateIds,
      );
    });
  }
}

function rowToDto(row: TemplateRow, steps: StepRow[]): WorkflowTemplateDto {
  return {
    id: row.id,
    schoolId: row.school_id,
    name: row.name,
    requestType: row.request_type,
    description: row.description,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps: steps.map((s) => ({
      id: s.id,
      stepOrder: s.step_order,
      approverType: s.approver_type as ApproverType,
      approverRef: s.approver_ref,
      isParallel: s.is_parallel,
      timeoutHours: s.timeout_hours,
      escalationTargetId: s.escalation_target_id,
    })),
  };
}
