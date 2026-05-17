import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  CreateRenewalDto,
  PatchRenewalDto,
  RenewalDto,
  RENEWAL_STAGES,
  RenewalStage,
} from '../dto/crm.dto';
import { AccountService, rowToRenewalDto } from './account.service';

/**
 * P2-21a — RenewalService.
 *
 * Renewal-pipeline CRUD. Endpoint inventory:
 *   GET    /crm/renewals                — pipeline board (group-by-stage)
 *   GET    /crm/renewals/upcoming       — renewals in next 90 days
 *   GET    /crm/renewals/:id            — single
 *   POST   /crm/renewals                — create
 *   PATCH  /crm/renewals/:id            — update
 *
 * Stage is the Kanban column; default UPCOMING. CHURNING is the
 * "this one's slipping" marker that lets the CSM team triage.
 */
@Injectable()
export class RenewalService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly accounts: AccountService,
  ) {}

  async list(stage?: RenewalStage): Promise<RenewalDto[]> {
    const where = stage ? `WHERE stage = $1` : '';
    const params = stage ? [stage] : [];
    const rows = await this.platform.$queryRawUnsafe<RawRenewalRow[]>(
      `SELECT id::text, account_id::text, renewal_date::text, current_mrr_cents,
              proposed_mrr_cents, stage, risk_factors, assigned_csm::text, notes,
              created_at, updated_at
       FROM platform.crm_renewal_pipeline ${where}
       ORDER BY renewal_date ASC LIMIT 500`,
      ...params,
    );
    return rows.map(rowToRenewalDto);
  }

  async upcoming(daysAhead = 90): Promise<RenewalDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawRenewalRow[]>(
      `SELECT id::text, account_id::text, renewal_date::text, current_mrr_cents,
              proposed_mrr_cents, stage, risk_factors, assigned_csm::text, notes,
              created_at, updated_at
       FROM platform.crm_renewal_pipeline
       WHERE renewal_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
       ORDER BY renewal_date ASC`,
      String(daysAhead),
    );
    return rows.map(rowToRenewalDto);
  }

  async getById(id: string): Promise<RenewalDto> {
    const rows = await this.platform.$queryRawUnsafe<RawRenewalRow[]>(
      `SELECT id::text, account_id::text, renewal_date::text, current_mrr_cents,
              proposed_mrr_cents, stage, risk_factors, assigned_csm::text, notes,
              created_at, updated_at
       FROM platform.crm_renewal_pipeline WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) throw new NotFoundException(`Renewal ${id} not found.`);
    return rowToRenewalDto(rows[0]!);
  }

  async create(input: CreateRenewalDto): Promise<RenewalDto> {
    await this.accounts.loadOrFail(input.accountId);
    const id = generateId();
    const stage: RenewalStage = input.stage ?? 'UPCOMING';
    if (!RENEWAL_STAGES.includes(stage)) {
      throw new NotFoundException(`Unknown stage ${stage}`);
    }
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.crm_renewal_pipeline
        (id, account_id, renewal_date, current_mrr_cents, proposed_mrr_cents,
         stage, risk_factors, assigned_csm, notes)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::text[], $8::uuid, $9)`,
      id,
      input.accountId,
      input.renewalDate,
      input.currentMrrCents,
      input.proposedMrrCents ?? null,
      stage,
      input.riskFactors ?? [],
      input.assignedCsm ?? null,
      input.notes ?? null,
    );
    return this.getById(id);
  }

  async patch(id: string, input: PatchRenewalDto): Promise<RenewalDto> {
    await this.getById(id);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace('$$', `$${params.length}`));
    };
    if (input.renewalDate !== undefined) push('renewal_date = $$::date', input.renewalDate);
    if (input.currentMrrCents !== undefined) push('current_mrr_cents = $$', input.currentMrrCents);
    if (input.proposedMrrCents !== undefined)
      push('proposed_mrr_cents = $$', input.proposedMrrCents);
    if (input.stage !== undefined) push('stage = $$', input.stage);
    if (input.riskFactors !== undefined) push('risk_factors = $$::text[]', input.riskFactors);
    if (input.assignedCsm !== undefined) push('assigned_csm = $$::uuid', input.assignedCsm || null);
    if (input.notes !== undefined) push('notes = $$', input.notes || null);

    if (sets.length === 0) return this.getById(id);
    sets.push('updated_at = now()');
    params.push(id);
    await this.platform.$executeRawUnsafe(
      `UPDATE platform.crm_renewal_pipeline SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
      ...params,
    );
    return this.getById(id);
  }
}

interface RawRenewalRow {
  id: string;
  account_id: string;
  renewal_date: string;
  current_mrr_cents: number;
  proposed_mrr_cents: number | null;
  stage: string;
  risk_factors: string[];
  assigned_csm: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}
