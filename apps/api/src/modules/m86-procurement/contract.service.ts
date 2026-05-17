import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { assertProcurementAdmin, assertProcurementReader, isUniqueViolation } from './access-advanced';
import { deterministicContractAmendedEventId } from './event-ids-advanced';
import type {
  ContractAmendmentDto,
  ContractDetailDto,
  ContractDto,
  ContractStatus,
  CreateContractAmendmentDto,
  CreateContractDto,
  UpdateContractDto,
} from './dto/commerce-advanced.dto';

interface ContractRow {
  id: string;
  school_id: string;
  vendor_id: string;
  contract_number: string;
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  total_value: string | number | null;
  spent_to_date: string | number;
  status: string;
  document_s3_key: string | null;
  renewal_reminder_days: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface AmendmentRow {
  id: string;
  contract_id: string;
  amendment_number: number;
  description: string;
  value_change: string | number;
  new_end_date: string | null;
  document_s3_key: string | null;
  approved_by: string | null;
  effective_date: string;
  created_at: string;
}

const ALLOWED_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  DRAFT: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['EXPIRING', 'RENEWED', 'TERMINATED'],
  EXPIRING: ['RENEWED', 'TERMINATED', 'ACTIVE'],
  RENEWED: ['ACTIVE', 'EXPIRING', 'TERMINATED'],
  TERMINATED: [],
};

@Injectable()
export class ContractService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private toDto(row: ContractRow): ContractDto {
    return {
      id: row.id,
      schoolId: row.school_id,
      vendorId: row.vendor_id,
      contractNumber: row.contract_number,
      title: row.title,
      description: row.description,
      startDate: row.start_date,
      endDate: row.end_date,
      totalValue: row.total_value === null ? null : Number(row.total_value),
      spentToDate: Number(row.spent_to_date),
      status: row.status as ContractStatus,
      documentS3Key: row.document_s3_key,
      renewalReminderDays: Number(row.renewal_reminder_days),
      notes: row.notes,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private amendmentToDto(row: AmendmentRow): ContractAmendmentDto {
    return {
      id: row.id,
      contractId: row.contract_id,
      amendmentNumber: Number(row.amendment_number),
      description: row.description,
      valueChange: Number(row.value_change),
      newEndDate: row.new_end_date,
      documentS3Key: row.document_s3_key,
      approvedBy: row.approved_by,
      effectiveDate: row.effective_date,
      createdAt: row.created_at,
    };
  }

  async list(actor: ResolvedActor, status?: ContractStatus): Promise<ContractDto[]> {
    await assertProcurementReader(actor, this.permCheck, 'Contract list');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const args: unknown[] = [tenant.schoolId];
      let where = '';
      if (status) {
        args.push(status);
        where = ' AND status = $2';
      }
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, vendor_id::text AS vendor_id,
                contract_number, title, description,
                start_date::text AS start_date, end_date::text AS end_date,
                total_value, spent_to_date, status, document_s3_key, renewal_reminder_days,
                notes, created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM prc_contracts
          WHERE school_id = $1::uuid${where}
          ORDER BY end_date ASC, contract_number`,
        ...args,
      )) as ContractRow[];
      return rows.map((r) => this.toDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<ContractDetailDto> {
    await assertProcurementReader(actor, this.permCheck, 'Contract read');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, school_id::text AS school_id, vendor_id::text AS vendor_id,
                contract_number, title, description,
                start_date::text AS start_date, end_date::text AS end_date,
                total_value, spent_to_date, status, document_s3_key, renewal_reminder_days,
                notes, created_by::text AS created_by,
                created_at::text AS created_at, updated_at::text AS updated_at
           FROM prc_contracts
          WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        id,
      )) as ContractRow[];
      if (rows.length === 0) throw new NotFoundException('Contract not found');
      const amendments = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, contract_id::text AS contract_id, amendment_number,
                description, value_change, new_end_date::text AS new_end_date,
                document_s3_key, approved_by::text AS approved_by,
                effective_date::text AS effective_date, created_at::text AS created_at
           FROM prc_contract_amendments
          WHERE contract_id = $1::uuid
          ORDER BY amendment_number ASC`,
        id,
      )) as AmendmentRow[];
      return {
        ...this.toDto(rows[0]!),
        amendments: amendments.map((a) => this.amendmentToDto(a)),
      };
    });
  }

  async create(actor: ResolvedActor, input: CreateContractDto): Promise<ContractDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Create contract');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    if (input.endDate < input.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Vendor must belong to current school.
      const vendor = (await tx.$queryRawUnsafe(
        `SELECT 1 AS ok FROM fin_suppliers WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
        input.vendorId,
        tenant.schoolId,
      )) as Array<{ ok: number }>;
      if (vendor.length === 0) {
        throw new BadRequestException('vendorId does not match a supplier in this school');
      }
      const id = generateId();
      try {
        const rows = (await tx.$queryRawUnsafe(
          `INSERT INTO prc_contracts
             (id, school_id, vendor_id, contract_number, title, description,
              start_date, end_date, total_value, document_s3_key, renewal_reminder_days,
              notes, created_by)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date, $8::date,
                   $9::numeric, $10, $11, $12, $13::uuid)
           RETURNING id::text AS id, school_id::text AS school_id, vendor_id::text AS vendor_id,
                     contract_number, title, description,
                     start_date::text AS start_date, end_date::text AS end_date,
                     total_value, spent_to_date, status, document_s3_key,
                     renewal_reminder_days, notes, created_by::text AS created_by,
                     created_at::text AS created_at, updated_at::text AS updated_at`,
          id,
          tenant.schoolId,
          input.vendorId,
          input.contractNumber,
          input.title,
          input.description ?? null,
          input.startDate,
          input.endDate,
          input.totalValue ?? null,
          input.documentS3Key ?? null,
          input.renewalReminderDays ?? 90,
          input.notes ?? null,
          actor.employeeId,
        )) as ContractRow[];
        return this.toDto(rows[0]!);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            `A contract numbered "${input.contractNumber}" already exists in this school`,
          );
        }
        throw err;
      }
    });
  }

  async patch(actor: ResolvedActor, id: string, input: UpdateContractDto): Promise<ContractDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Update contract');
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const existing = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, status, end_date::text AS end_date, start_date::text AS start_date
           FROM prc_contracts
          WHERE school_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; status: string; end_date: string; start_date: string }>;
      if (existing.length === 0) throw new NotFoundException('Contract not found');
      const current = existing[0]!;

      if (input.status !== undefined && input.status !== current.status) {
        const allowed = ALLOWED_TRANSITIONS[current.status as ContractStatus] || [];
        if (!allowed.includes(input.status)) {
          throw new BadRequestException(
            `Contract status cannot transition from ${current.status} to ${input.status}`,
          );
        }
      }
      const newEnd = input.endDate ?? current.end_date;
      if (newEnd < current.start_date) {
        throw new BadRequestException('endDate must be on or after startDate');
      }

      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (input.title !== undefined) {
        sets.push(`title = $${p}`);
        args.push(input.title);
        p++;
      }
      if (input.description !== undefined) {
        sets.push(`description = $${p}`);
        args.push(input.description);
        p++;
      }
      if (input.endDate !== undefined) {
        sets.push(`end_date = $${p}::date`);
        args.push(input.endDate);
        p++;
      }
      if (input.totalValue !== undefined) {
        sets.push(`total_value = $${p}::numeric`);
        args.push(input.totalValue);
        p++;
      }
      if (input.status !== undefined) {
        sets.push(`status = $${p}`);
        args.push(input.status);
        p++;
      }
      if (input.documentS3Key !== undefined) {
        sets.push(`document_s3_key = $${p}`);
        args.push(input.documentS3Key);
        p++;
      }
      if (input.renewalReminderDays !== undefined) {
        sets.push(`renewal_reminder_days = $${p}`);
        args.push(input.renewalReminderDays);
        p++;
      }
      if (input.notes !== undefined) {
        sets.push(`notes = $${p}`);
        args.push(input.notes);
        p++;
      }
      if (sets.length === 0) {
        const fresh = (await tx.$queryRawUnsafe(
          `SELECT id::text AS id, school_id::text AS school_id, vendor_id::text AS vendor_id,
                  contract_number, title, description,
                  start_date::text AS start_date, end_date::text AS end_date,
                  total_value, spent_to_date, status, document_s3_key, renewal_reminder_days,
                  notes, created_by::text AS created_by,
                  created_at::text AS created_at, updated_at::text AS updated_at
             FROM prc_contracts WHERE id = $1::uuid AND school_id = $2::uuid`,
          id,
          tenant.schoolId,
        )) as ContractRow[];
        return this.toDto(fresh[0]!);
      }
      sets.push(`updated_at = now()`);
      args.push(tenant.schoolId, id);
      const rows = (await tx.$queryRawUnsafe(
        `UPDATE prc_contracts
            SET ${sets.join(', ')}
          WHERE school_id = $${p}::uuid AND id = $${p + 1}::uuid
          RETURNING id::text AS id, school_id::text AS school_id, vendor_id::text AS vendor_id,
                    contract_number, title, description,
                    start_date::text AS start_date, end_date::text AS end_date,
                    total_value, spent_to_date, status, document_s3_key, renewal_reminder_days,
                    notes, created_by::text AS created_by,
                    created_at::text AS created_at, updated_at::text AS updated_at`,
        ...args,
      )) as ContractRow[];
      return this.toDto(rows[0]!);
    });
  }

  async amend(
    actor: ResolvedActor,
    contractId: string,
    input: CreateContractAmendmentDto,
  ): Promise<ContractAmendmentDto> {
    await assertProcurementAdmin(actor, this.permCheck, 'Amend contract');
    const tenant = getCurrentTenant();
    if (!actor.employeeId) {
      throw new BadRequestException('Caller does not have an employee record in this school');
    }
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const contract = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, total_value, end_date::text AS end_date, status
           FROM prc_contracts
          WHERE school_id = $1::uuid AND id = $2::uuid
          FOR UPDATE`,
        tenant.schoolId,
        contractId,
      )) as Array<{
        id: string;
        total_value: string | number | null;
        end_date: string;
        status: string;
      }>;
      if (contract.length === 0) throw new NotFoundException('Contract not found');
      const current = contract[0]!;
      if (current.status === 'TERMINATED') {
        throw new BadRequestException('Cannot amend a TERMINATED contract');
      }

      const nextNumberRows = (await tx.$queryRawUnsafe(
        `SELECT COALESCE(MAX(amendment_number), 0) + 1 AS n
           FROM prc_contract_amendments WHERE contract_id = $1::uuid`,
        contractId,
      )) as Array<{ n: number }>;
      const nextNumber = Number(nextNumberRows[0]?.n ?? 1);

      const id = generateId();
      const rows = (await tx.$queryRawUnsafe(
        `INSERT INTO prc_contract_amendments
           (id, contract_id, amendment_number, description, value_change, new_end_date,
            document_s3_key, approved_by, effective_date)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::date, $7, $8::uuid, $9::date)
         RETURNING id::text AS id, contract_id::text AS contract_id, amendment_number,
                   description, value_change, new_end_date::text AS new_end_date,
                   document_s3_key, approved_by::text AS approved_by,
                   effective_date::text AS effective_date, created_at::text AS created_at`,
        id,
        contractId,
        nextNumber,
        input.description,
        input.valueChange ?? 0,
        input.newEndDate ?? null,
        input.documentS3Key ?? null,
        actor.employeeId,
        input.effectiveDate,
      )) as AmendmentRow[];

      // Apply the amendment effects to the parent contract atomically.
      const valueChange = Number(input.valueChange ?? 0);
      const sets: string[] = [];
      const args: unknown[] = [];
      let p = 1;
      if (valueChange !== 0) {
        const baseline = Number(current.total_value ?? 0);
        sets.push(`total_value = $${p}::numeric`);
        args.push(baseline + valueChange);
        p++;
      }
      if (input.newEndDate) {
        sets.push(`end_date = $${p}::date`);
        args.push(input.newEndDate);
        p++;
      }
      if (sets.length > 0) {
        sets.push(`updated_at = now()`);
        args.push(tenant.schoolId, contractId);
        await tx.$executeRawUnsafe(
          `UPDATE prc_contracts SET ${sets.join(', ')}
            WHERE school_id = $${p}::uuid AND id = $${p + 1}::uuid`,
          ...args,
        );
      }

      // Emit prc.contract.amended via durable outbox.
      await this.outbox.enqueueInTx(tx, {
        topic: 'prc.contract.amended',
        payload: {
          contractId,
          amendmentId: id,
          amendmentNumber: nextNumber,
          valueChange,
          newEndDate: input.newEndDate ?? null,
          effectiveDate: input.effectiveDate,
          schoolId: tenant.schoolId,
          sourceRefId: id,
        },
        sourceModule: 'commerce',
        eventId: deterministicContractAmendedEventId(id),
        tenantId: tenant.schoolId,
        tenantSubdomain: tenant.subdomain,
        key: contractId,
      });

      return this.amendmentToDto(rows[0]!);
    });
  }
}
