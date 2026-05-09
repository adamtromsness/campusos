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
import {
  AssemblyPointDto,
  CreateProcedureDto,
  ExternalContactDto,
  ProcedureDto,
  ProcedureStepDto,
  ProcedureType,
  UpdateProcedureDto,
} from './dto/incident.dto';
import { isUniqueViolation } from './incident-type.service';

interface ProcedureRow {
  id: string;
  school_id: string;
  procedure_type: string;
  title: string;
  procedure_steps: unknown;
  primary_contact_id: string;
  secondary_contact_id: string | null;
  external_contacts: unknown;
  assembly_points: unknown;
  last_reviewed_at: string;
  reviewed_by: string;
  next_review_date: string;
  is_active: boolean;
  procedure_document_s3_key: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PROC_BASE =
  'SELECT id::text AS id, school_id::text AS school_id, procedure_type, title, ' +
  '       procedure_steps, primary_contact_id::text AS primary_contact_id, ' +
  '       secondary_contact_id::text AS secondary_contact_id, ' +
  '       external_contacts, assembly_points, ' +
  '       last_reviewed_at::text AS last_reviewed_at, ' +
  '       reviewed_by::text AS reviewed_by, ' +
  '       next_review_date::text AS next_review_date, ' +
  '       is_active, procedure_document_s3_key, ' +
  '       created_at::text AS created_at, updated_at::text AS updated_at ' +
  'FROM inc_emergency_procedures ';

@Injectable()
export class ProcedureService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
  ) {}

  async list(includeInactive = false): Promise<ProcedureDto[]> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const where = includeInactive
        ? 'school_id = $1::uuid'
        : 'school_id = $1::uuid AND is_active = true';
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROC_BASE + 'WHERE ' + where + ' ORDER BY procedure_type',
        tenant.schoolId,
      )) as ProcedureRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getByType(procedureType: ProcedureType): Promise<ProcedureDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROC_BASE +
          'WHERE school_id = $1::uuid AND procedure_type = $2 AND is_active = true LIMIT 1',
        tenant.schoolId,
        procedureType,
      )) as ProcedureRow[];
      if (rows.length === 0)
        throw new NotFoundException('No active procedure for ' + procedureType);
      return this.rowToDto(rows[0]!);
    });
  }

  async getById(id: string): Promise<ProcedureDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROC_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as ProcedureRow[];
      if (rows.length === 0) throw new NotFoundException('Procedure not found');
      return this.rowToDto(rows[0]!);
    });
  }

  /** Internal-no-actor variant for the worker to look up the active procedure
   * for a procedure_type and read its primary_contact_id when fanning out
   * URGENT response tasks.
   */
  async loadActiveByTypeInternal(procedureType: string): Promise<ProcedureRow | null> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_PROC_BASE +
          'WHERE school_id = $1::uuid AND procedure_type = $2 AND is_active = true LIMIT 1',
        tenant.schoolId,
        procedureType,
      )) as ProcedureRow[];
      return rows.length > 0 ? rows[0]! : null;
    });
  }

  async create(input: CreateProcedureDto, actor: ResolvedActor): Promise<ProcedureDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    if (new Date(input.nextReviewDate) < new Date(input.lastReviewedAt)) {
      throw new BadRequestException('nextReviewDate must be on or after lastReviewedAt');
    }
    const id = generateId();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO inc_emergency_procedures ' +
            '(id, school_id, procedure_type, title, procedure_steps, primary_contact_id, ' +
            ' secondary_contact_id, external_contacts, assembly_points, last_reviewed_at, ' +
            ' reviewed_by, next_review_date, procedure_document_s3_key) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid, $8::jsonb, $9::jsonb, ' +
            ' $10::date, $11::uuid, $12::date, $13)',
          id,
          tenant.schoolId,
          input.procedureType,
          input.title,
          JSON.stringify(input.procedureSteps),
          input.primaryContactId,
          input.secondaryContactId ?? null,
          input.externalContacts ? JSON.stringify(input.externalContacts) : null,
          input.assemblyPoints ? JSON.stringify(input.assemblyPoints) : null,
          input.lastReviewedAt,
          input.reviewedBy,
          input.nextReviewDate,
          input.procedureDocumentS3Key ?? null,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'An active procedure for ' +
              input.procedureType +
              ' already exists. Deactivate it first or use PATCH to update.',
          );
        }
        throw err;
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_PROC_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ProcedureRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async patch(id: string, input: UpdateProcedureDto, actor: ResolvedActor): Promise<ProcedureDto> {
    await this.assertAdmin(actor);
    const tenant = getCurrentTenant();

    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT last_reviewed_at::text AS last_reviewed_at, ' +
          '       next_review_date::text AS next_review_date ' +
          'FROM inc_emergency_procedures ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ last_reviewed_at: string; next_review_date: string }>;
      if (lock.length === 0) throw new NotFoundException('Procedure not found');

      const effLast = input.lastReviewedAt ?? lock[0]!.last_reviewed_at;
      const effNext = input.nextReviewDate ?? lock[0]!.next_review_date;
      if (new Date(effNext) < new Date(effLast)) {
        throw new BadRequestException('nextReviewDate must be on or after lastReviewedAt');
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      let n = 1;
      const push = (sql: string, value: unknown) => {
        sets.push(sql + ' = $' + n);
        values.push(value);
        n += 1;
      };
      if (input.title !== undefined) push('title', input.title);
      if (input.procedureSteps !== undefined)
        (sets.push('procedure_steps = $' + n + '::jsonb'),
          values.push(JSON.stringify(input.procedureSteps)),
          n++);
      if (input.primaryContactId !== undefined)
        (sets.push('primary_contact_id = $' + n + '::uuid'),
          values.push(input.primaryContactId),
          n++);
      if (input.secondaryContactId !== undefined)
        (sets.push('secondary_contact_id = $' + n + '::uuid'),
          values.push(input.secondaryContactId),
          n++);
      if (input.externalContacts !== undefined)
        (sets.push('external_contacts = $' + n + '::jsonb'),
          values.push(input.externalContacts ? JSON.stringify(input.externalContacts) : null),
          n++);
      if (input.assemblyPoints !== undefined)
        (sets.push('assembly_points = $' + n + '::jsonb'),
          values.push(input.assemblyPoints ? JSON.stringify(input.assemblyPoints) : null),
          n++);
      if (input.lastReviewedAt !== undefined)
        (sets.push('last_reviewed_at = $' + n + '::date'), values.push(input.lastReviewedAt), n++);
      if (input.nextReviewDate !== undefined)
        (sets.push('next_review_date = $' + n + '::date'), values.push(input.nextReviewDate), n++);
      if (input.reviewedBy !== undefined)
        (sets.push('reviewed_by = $' + n + '::uuid'), values.push(input.reviewedBy), n++);
      if (input.procedureDocumentS3Key !== undefined)
        push('procedure_document_s3_key', input.procedureDocumentS3Key);
      if (input.isActive !== undefined) push('is_active', input.isActive);
      if (sets.length === 0) {
        const rows = (await tx.$queryRawUnsafe(
          SELECT_PROC_BASE + 'WHERE id = $1::uuid LIMIT 1',
          id,
        )) as ProcedureRow[];
        return this.rowToDto(rows[0]!);
      }
      sets.push('updated_at = now()');
      values.push(id, tenant.schoolId);

      try {
        await tx.$executeRawUnsafe(
          'UPDATE inc_emergency_procedures SET ' +
            sets.join(', ') +
            ' WHERE id = $' +
            n +
            '::uuid AND school_id = $' +
            (n + 1) +
            '::uuid',
          ...values,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new BadRequestException(
            'Activating this procedure conflicts with another active procedure of the same type.',
          );
        }
        throw err;
      }

      const rows = (await tx.$queryRawUnsafe(
        SELECT_PROC_BASE + 'WHERE id = $1::uuid LIMIT 1',
        id,
      )) as ProcedureRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  private async assertAdmin(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'saf-001:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Procedure CRUD requires saf-001:admin or school admin.');
    }
  }

  rowToDto(r: ProcedureRow): ProcedureDto {
    return {
      id: r.id,
      schoolId: r.school_id,
      procedureType: r.procedure_type as ProcedureType,
      title: r.title,
      procedureSteps: (r.procedure_steps as ProcedureStepDto[]) ?? [],
      primaryContactId: r.primary_contact_id,
      secondaryContactId: r.secondary_contact_id,
      externalContacts: (r.external_contacts as ExternalContactDto[] | null) ?? null,
      assemblyPoints: (r.assembly_points as AssemblyPointDto[] | null) ?? null,
      lastReviewedAt: r.last_reviewed_at,
      reviewedBy: r.reviewed_by,
      nextReviewDate: r.next_review_date,
      isActive: r.is_active,
      procedureDocumentS3Key: r.procedure_document_s3_key,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}
