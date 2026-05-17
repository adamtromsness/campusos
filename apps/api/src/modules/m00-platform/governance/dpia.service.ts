import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { RopaService } from './ropa.service';
import type { CreateDpiaDto, DpiaDto, DpiaRiskEntry, UpdateDpiaDto } from './dto/governance.dto';

/**
 * DpiaService — GDPR Article 35 Data Protection Impact Assessment.
 *
 * Lifecycle: SCOPING → IN_PROGRESS → COMPLETED → APPROVED / REJECTED.
 * No reverse path (REJECTED is terminal). Update path stamps
 * completed_at + completed_by on the COMPLETED transition; APPROVED
 * stamps approved_by. Soft FK to dpo_processing_activities.id allows
 * the DPIA to attach to any processing activity in the school; once
 * APPROVED, the matching processing activity should also have its
 * dpia_id pointer updated (linking is service-level, not enforced by
 * the schema since the relationship is cross-table circular).
 */
@Injectable()
export class DpiaService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ropa: RopaService,
  ) {}

  private rowToDpiaDto(r: Record<string, unknown>): DpiaDto {
    let risks: DpiaRiskEntry[] = [];
    const raw = r.risks_identified;
    if (Array.isArray(raw)) {
      risks = raw as DpiaRiskEntry[];
    } else if (raw && typeof raw === 'object') {
      const arr = raw as { length?: number };
      if (typeof arr.length === 'number') {
        risks = Array.from(arr as Iterable<DpiaRiskEntry>);
      }
    }
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      processingActivityId: (r.processing_activity_id as string | null) ?? null,
      processingActivityName: (r.processing_activity_name as string | null) ?? null,
      dpiaTitle: r.dpia_title as string,
      triggerReason: r.trigger_reason as string,
      status: r.status as DpiaDto['status'],
      descriptionOfProcessing: r.description_of_processing as string,
      necessityProportionalityAssessment:
        (r.necessity_proportionality_assessment as string | null) ?? null,
      risksIdentified: risks,
      residualRiskLevel: (r.residual_risk_level as DpiaDto['residualRiskLevel']) ?? null,
      dpoOpinion: (r.dpo_opinion as string | null) ?? null,
      supervisoryAuthorityConsultationRequired:
        r.supervisory_authority_consultation_required as boolean,
      completedAt: r.completed_at ? String(r.completed_at).slice(0, 10) : null,
      completedById: (r.completed_by as string | null) ?? null,
      approvedById: (r.approved_by as string | null) ?? null,
      documentS3Key: (r.document_s3_key as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async list(actor: ResolvedActor, args?: { status?: string }): Promise<DpiaDto[]> {
    await this.ropa.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const where: string[] = ['d.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args?.status) {
      where.push(`d.status = $${params.length + 1}`);
      params.push(args.status);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT d.*, pa.activity_name AS processing_activity_name
           FROM dpo_dpias d
           LEFT JOIN dpo_processing_activities pa ON pa.id = d.processing_activity_id
          WHERE ${where.join(' AND ')}
          ORDER BY d.created_at DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDpiaDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<DpiaDto> {
    await this.ropa.assertDpoReadScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT d.*, pa.activity_name AS processing_activity_name
           FROM dpo_dpias d
           LEFT JOIN dpo_processing_activities pa ON pa.id = d.processing_activity_id
          WHERE d.id = $1::uuid AND d.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`DPIA ${id} not found.`);
    return this.rowToDpiaDto(rows[0]!);
  }

  private async assertProcessingActivityExists(
    processingActivityId: string | undefined,
  ): Promise<void> {
    if (!processingActivityId) return;
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT 1 AS x FROM dpo_processing_activities WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        processingActivityId,
        tenant.schoolId,
      );
    })) as Array<unknown>;
    if (rows.length === 0) {
      throw new BadRequestException(
        `processingActivityId ${processingActivityId} does not match a processing activity in this school.`,
      );
    }
  }

  async create(actor: ResolvedActor, input: CreateDpiaDto): Promise<DpiaDto> {
    await this.ropa.assertDpoWriteScope(actor);
    await this.assertProcessingActivityExists(input.processingActivityId);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_dpias
         (id, school_id, processing_activity_id, dpia_title, trigger_reason, status,
          description_of_processing, necessity_proportionality_assessment, risks_identified,
          supervisory_authority_consultation_required)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'SCOPING', $6, $7, $8::jsonb, $9)`,
        id,
        tenant.schoolId,
        input.processingActivityId ?? null,
        input.dpiaTitle,
        input.triggerReason,
        input.descriptionOfProcessing,
        input.necessityProportionalityAssessment ?? null,
        JSON.stringify(input.risksIdentified ?? []),
        input.supervisoryAuthorityConsultationRequired ?? false,
      );
    });
    return this.getById(actor, id);
  }

  async update(actor: ResolvedActor, id: string, input: UpdateDpiaDto): Promise<DpiaDto> {
    await this.ropa.assertDpoWriteScope(actor);
    const existing = await this.getById(actor, id);
    if (existing.status === 'REJECTED' && input.status && input.status !== 'REJECTED') {
      throw new BadRequestException(
        'A REJECTED DPIA cannot transition to another status. Open a new DPIA instead.',
      );
    }
    if (
      existing.status === 'APPROVED' &&
      input.status &&
      input.status !== 'APPROVED' &&
      input.status !== 'REJECTED'
    ) {
      throw new BadRequestException(
        'An APPROVED DPIA can only transition to REJECTED. Other transitions are blocked.',
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown, cast?: string) => {
      sets.push(`${col} = $${i}${cast ?? ''}`);
      params.push(val);
      i++;
    };
    if (input.dpiaTitle !== undefined) push('dpia_title', input.dpiaTitle);
    if (input.triggerReason !== undefined) push('trigger_reason', input.triggerReason);
    if (input.status !== undefined) push('status', input.status);
    if (input.descriptionOfProcessing !== undefined)
      push('description_of_processing', input.descriptionOfProcessing);
    if (input.necessityProportionalityAssessment !== undefined)
      push('necessity_proportionality_assessment', input.necessityProportionalityAssessment);
    if (input.risksIdentified !== undefined)
      push('risks_identified', JSON.stringify(input.risksIdentified), '::jsonb');
    if (input.residualRiskLevel !== undefined) push('residual_risk_level', input.residualRiskLevel);
    if (input.dpoOpinion !== undefined) push('dpo_opinion', input.dpoOpinion);
    if (input.supervisoryAuthorityConsultationRequired !== undefined)
      push(
        'supervisory_authority_consultation_required',
        input.supervisoryAuthorityConsultationRequired,
      );
    if (input.documentS3Key !== undefined) push('document_s3_key', input.documentS3Key);
    if (input.status === 'COMPLETED' && existing.status !== 'COMPLETED') {
      const completedAt = input.completedAt ?? new Date().toISOString().slice(0, 10);
      push('completed_at', completedAt, '::date');
      push('completed_by', input.completedById ?? actor.accountId, '::uuid');
    }
    if (input.status === 'APPROVED' && existing.status !== 'APPROVED') {
      push('approved_by', input.approvedById ?? actor.accountId, '::uuid');
      if (existing.completedAt === null) {
        const completedAt = new Date().toISOString().slice(0, 10);
        push('completed_at', completedAt, '::date');
        push('completed_by', actor.accountId, '::uuid');
      }
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE dpo_dpias SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
      );
    });
    return this.getById(actor, id);
  }

  async remove(actor: ResolvedActor, id: string): Promise<void> {
    await this.ropa.assertDpoAdminScope(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `DELETE FROM dpo_dpias WHERE id = $1::uuid AND school_id = $2::uuid`,
        id,
        tenant.schoolId,
      );
      if (result === 0) throw new NotFoundException(`DPIA ${id} not found.`);
    });
  }
}
