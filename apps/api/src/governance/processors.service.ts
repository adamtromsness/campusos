import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import type {
  CreateDpaDto,
  CreateProcessorDto,
  DpaDto,
  ProcessorDto,
  UpdateDpaDto,
  UpdateProcessorDto,
} from './dto/governance.dto';

/**
 * ProcessorService — GDPR Article 28 third-party processor register +
 * Data Processing Agreements.
 *
 * Two compliance gap rules surface:
 *   - dpa_in_place=false  → DPA missing.
 *   - DPA status=EXPIRED  → DPA needs renewal.
 *
 * Both surface as `hasDpaGap=true` on the DTO.
 *
 * "DPO scope" = school admin OR holds dpo-002:write.
 */
@Injectable()
export class ProcessorService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  async assertReadScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-002:read',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Processor register access is restricted to the DPO scope (dpo-002:read).',
      );
    }
  }

  async assertWriteScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-002:write',
    ]);
    if (!ok) {
      throw new ForbiddenException(
        'Only the DPO can mutate the processor register / DPAs (dpo-002:write).',
      );
    }
  }

  async assertAdminScope(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'dpo-002:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Only the DPO admin can hard-delete processor rows.');
    }
  }

  private rowToProcessorDto(r: Record<string, unknown>): ProcessorDto {
    const status = (r.dpa_status as ProcessorDto['dpaStatus']) ?? null;
    const hasDpaGap = !(r.dpa_in_place as boolean) || status === 'EXPIRED';
    const next = r.next_review_date ? String(r.next_review_date).slice(0, 10) : null;
    const reviewDue = next ? new Date(next + 'T00:00:00Z').getTime() <= Date.now() : false;
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      processorName: r.processor_name as string,
      processorType: r.processor_type as ProcessorDto['processorType'],
      registeredCountry: r.registered_country as string,
      dataCategoriesProcessed: (r.data_categories_processed as string[]) ?? [],
      dpaInPlace: r.dpa_in_place as boolean,
      dpaId: (r.dpa_id as string | null) ?? null,
      dpaStatus: status,
      adequacyDecisionApplicable: r.adequacy_decision_applicable as boolean,
      transferMechanism: (r.transfer_mechanism as ProcessorDto['transferMechanism']) ?? null,
      lastReviewedAt: r.last_reviewed_at ? String(r.last_reviewed_at).slice(0, 10) : null,
      nextReviewDate: next ?? '',
      notes: (r.notes as string | null) ?? null,
      hasDpaGap,
      reviewDue,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async listProcessors(
    actor: ResolvedActor,
    args?: { gapsOnly?: boolean },
  ): Promise<ProcessorDto[]> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const where: string[] = ['p.school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (args?.gapsOnly) where.push('p.dpa_in_place = false');
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.*, dpa.status AS dpa_status
           FROM dpo_third_party_processors p
           LEFT JOIN dpo_data_processing_agreements dpa ON dpa.id = p.dpa_id
          WHERE ${where.join(' AND ')}
          ORDER BY p.dpa_in_place ASC, p.processor_name ASC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProcessorDto(r));
  }

  async getProcessor(actor: ResolvedActor, id: string): Promise<ProcessorDto> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT p.*, dpa.status AS dpa_status
           FROM dpo_third_party_processors p
           LEFT JOIN dpo_data_processing_agreements dpa ON dpa.id = p.dpa_id
          WHERE p.id = $1::uuid AND p.school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`Processor ${id} not found.`);
    return this.rowToProcessorDto(rows[0]!);
  }

  async createProcessor(actor: ResolvedActor, input: CreateProcessorDto): Promise<ProcessorDto> {
    await this.assertWriteScope(actor);
    if (input.dataCategoriesProcessed.length === 0) {
      throw new BadRequestException('dataCategoriesProcessed must contain at least one entry.');
    }
    const tenant = getCurrentTenant();
    const id = generateId();
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO dpo_third_party_processors
           (id, school_id, processor_name, processor_type, registered_country, data_categories_processed,
            dpa_in_place, dpa_id, adequacy_decision_applicable, transfer_mechanism, next_review_date, notes)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], false, NULL, $7, $8, $9::date, $10)`,
          id,
          tenant.schoolId,
          input.processorName,
          input.processorType,
          input.registeredCountry,
          input.dataCategoriesProcessed,
          input.adequacyDecisionApplicable ?? false,
          input.transferMechanism ?? null,
          input.nextReviewDate,
          input.notes ?? null,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(
          `A processor named "${input.processorName}" already exists for this school.`,
        );
      }
      throw err;
    }
    return this.getProcessor(actor, id);
  }

  async updateProcessor(
    actor: ResolvedActor,
    id: string,
    input: UpdateProcessorDto,
  ): Promise<ProcessorDto> {
    await this.assertWriteScope(actor);
    const existing = await this.getProcessor(actor, id);
    if (input.dataCategoriesProcessed && input.dataCategoriesProcessed.length === 0) {
      throw new BadRequestException('dataCategoriesProcessed must contain at least one entry.');
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown, cast?: string) => {
      sets.push(`${col} = $${i}${cast ?? ''}`);
      params.push(val);
      i++;
    };
    if (input.processorName !== undefined) push('processor_name', input.processorName);
    if (input.processorType !== undefined) push('processor_type', input.processorType);
    if (input.registeredCountry !== undefined) push('registered_country', input.registeredCountry);
    if (input.dataCategoriesProcessed !== undefined)
      push('data_categories_processed', input.dataCategoriesProcessed, '::text[]');
    if (input.adequacyDecisionApplicable !== undefined)
      push('adequacy_decision_applicable', input.adequacyDecisionApplicable);
    if (input.transferMechanism !== undefined) push('transfer_mechanism', input.transferMechanism);
    if (input.lastReviewedAt !== undefined)
      push('last_reviewed_at', input.lastReviewedAt, '::date');
    if (input.nextReviewDate !== undefined)
      push('next_review_date', input.nextReviewDate, '::date');
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    params.push(id);
    params.push(tenant.schoolId);
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE dpo_third_party_processors SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
          ...params,
        );
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new BadRequestException(`A processor with that name already exists for this school.`);
      }
      throw err;
    }
    return this.getProcessor(actor, id);
  }

  async deleteProcessor(actor: ResolvedActor, id: string): Promise<void> {
    await this.assertAdminScope(actor);
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const result = await tx.$executeRawUnsafe(
        `DELETE FROM dpo_third_party_processors WHERE id = $1::uuid AND school_id = $2::uuid`,
        id,
        tenant.schoolId,
      );
      if (result === 0) throw new NotFoundException(`Processor ${id} not found.`);
    });
  }

  // ─── DPAs ─────────────────────────────────────────────────────────

  private rowToDpaDto(r: Record<string, unknown>): DpaDto {
    return {
      id: r.id as string,
      schoolId: r.school_id as string,
      processorId: r.processor_id as string,
      agreementReference: r.agreement_reference as string,
      effectiveFrom: String(r.effective_from).slice(0, 10),
      effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
      documentS3Key: r.document_s3_key as string,
      subProcessorsDisclosed: r.sub_processors_disclosed as boolean,
      subProcessorListS3Key: (r.sub_processor_list_s3_key as string | null) ?? null,
      reviewDate: String(r.review_date).slice(0, 10),
      signedById: r.signed_by as string,
      status: r.status as DpaDto['status'],
      notes: (r.notes as string | null) ?? null,
      createdAt: (r.created_at as Date).toISOString(),
      updatedAt: (r.updated_at as Date).toISOString(),
    };
  }

  async listDpas(actor: ResolvedActor, processorId?: string): Promise<DpaDto[]> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const where: string[] = ['school_id = $1::uuid'];
    const params: unknown[] = [tenant.schoolId];
    if (processorId) {
      where.push(`processor_id = $${params.length + 1}::uuid`);
      params.push(processorId);
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_data_processing_agreements WHERE ${where.join(' AND ')} ORDER BY effective_from DESC`,
        ...params,
      );
    })) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToDpaDto(r));
  }

  async getDpa(actor: ResolvedActor, id: string): Promise<DpaDto> {
    await this.assertReadScope(actor);
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT * FROM dpo_data_processing_agreements WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      );
    })) as Array<Record<string, unknown>>;
    if (rows.length === 0) throw new NotFoundException(`DPA ${id} not found.`);
    return this.rowToDpaDto(rows[0]!);
  }

  async createDpa(actor: ResolvedActor, input: CreateDpaDto): Promise<DpaDto> {
    await this.assertWriteScope(actor);
    // Verify processor in same school
    const processor = await this.getProcessor(actor, input.processorId);
    const tenant = getCurrentTenant();
    const id = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO dpo_data_processing_agreements
         (id, school_id, processor_id, agreement_reference, effective_from, effective_to,
          document_s3_key, sub_processors_disclosed, sub_processor_list_s3_key, review_date,
          signed_by, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7, $8, $9, $10::date, $11::uuid, 'ACTIVE', $12)`,
        id,
        tenant.schoolId,
        input.processorId,
        input.agreementReference,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.documentS3Key,
        input.subProcessorsDisclosed ?? false,
        input.subProcessorListS3Key ?? null,
        input.reviewDate,
        actor.accountId,
        input.notes ?? null,
      );
      // Backlink the processor to this DPA
      await tx.$executeRawUnsafe(
        `UPDATE dpo_third_party_processors SET dpa_in_place = true, dpa_id = $1::uuid, updated_at = now() WHERE id = $2::uuid AND school_id = $3::uuid`,
        id,
        input.processorId,
        tenant.schoolId,
      );
    });
    void processor;
    return this.getDpa(actor, id);
  }

  async updateDpa(actor: ResolvedActor, id: string, input: UpdateDpaDto): Promise<DpaDto> {
    await this.assertWriteScope(actor);
    const existing = await this.getDpa(actor, id);
    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    const push = (col: string, val: unknown, cast?: string) => {
      sets.push(`${col} = $${i}${cast ?? ''}`);
      params.push(val);
      i++;
    };
    if (input.agreementReference !== undefined)
      push('agreement_reference', input.agreementReference);
    if (input.effectiveFrom !== undefined) push('effective_from', input.effectiveFrom, '::date');
    if (input.effectiveTo !== undefined) push('effective_to', input.effectiveTo, '::date');
    if (input.documentS3Key !== undefined) push('document_s3_key', input.documentS3Key);
    if (input.subProcessorsDisclosed !== undefined)
      push('sub_processors_disclosed', input.subProcessorsDisclosed);
    if (input.subProcessorListS3Key !== undefined)
      push('sub_processor_list_s3_key', input.subProcessorListS3Key);
    if (input.reviewDate !== undefined) push('review_date', input.reviewDate, '::date');
    if (input.status !== undefined) push('status', input.status);
    if (input.notes !== undefined) push('notes', input.notes);
    if (sets.length === 0) return existing;
    sets.push('updated_at = now()');
    const tenant = getCurrentTenant();
    params.push(id);
    params.push(tenant.schoolId);
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE dpo_data_processing_agreements SET ${sets.join(', ')} WHERE id = $${i}::uuid AND school_id = $${i + 1}::uuid`,
        ...params,
      );
      // If the DPA was just terminated/expired, ensure backlink reflects the gap
      if (input.status === 'EXPIRED' || input.status === 'TERMINATED') {
        await tx.$executeRawUnsafe(
          `UPDATE dpo_third_party_processors SET dpa_in_place = false, updated_at = now() WHERE dpa_id = $1::uuid AND school_id = $2::uuid`,
          id,
          tenant.schoolId,
        );
      } else if (input.status === 'ACTIVE') {
        await tx.$executeRawUnsafe(
          `UPDATE dpo_third_party_processors SET dpa_in_place = true, updated_at = now() WHERE dpa_id = $1::uuid AND school_id = $2::uuid`,
          id,
          tenant.schoolId,
        );
      }
    });
    return this.getDpa(actor, id);
  }

  private isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; meta?: { code?: string }; message?: string };
    if (e?.code === '23505') return true;
    if (e?.meta?.code === '23505') return true;
    if (typeof e?.message === 'string' && /23505|duplicate key/.test(e.message)) return true;
    return false;
  }
}
