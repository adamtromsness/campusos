import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import {
  ContactDto,
  ContactRole,
  CreateContactDto,
  CreateInteractionDto,
  InteractionDto,
  InteractionType,
  PatchContactDto,
} from '../dto/crm.dto';
import { AccountService, rowToInteractionDto } from './account.service';

@Injectable()
export class ContactService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly accounts: AccountService,
  ) {}

  async listForAccount(accountId: string): Promise<ContactDto[]> {
    await this.accounts.loadOrFail(accountId);
    const rows = await this.platform.$queryRawUnsafe<RawContactRow[]>(
      `SELECT id::text, account_id::text, person_id::text, name, email, phone, role,
              is_primary, created_at, updated_at
       FROM platform.crm_contacts WHERE account_id = $1::uuid
       ORDER BY is_primary DESC, name ASC`,
      accountId,
    );
    return rows.map(rowToContactDto);
  }

  async create(accountId: string, input: CreateContactDto): Promise<ContactDto> {
    await this.accounts.loadOrFail(accountId);
    const id = generateId();
    await this.platform.$transaction(async (tx) => {
      if (input.isPrimary) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_contacts SET is_primary = false, updated_at = now()
           WHERE account_id = $1::uuid AND is_primary = true`,
          accountId,
        );
      }
      await tx.$executeRawUnsafe(
        `INSERT INTO platform.crm_contacts
          (id, account_id, person_id, name, email, phone, role, is_primary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)`,
        id,
        accountId,
        input.personId ?? null,
        input.name,
        input.email,
        input.phone ?? null,
        input.role,
        input.isPrimary ?? false,
      );
    });
    return this.getById(id);
  }

  async patch(id: string, input: PatchContactDto): Promise<ContactDto> {
    const existing = await this.getById(id);
    await this.platform.$transaction(async (tx) => {
      if (input.isPrimary === true) {
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_contacts SET is_primary = false, updated_at = now()
           WHERE account_id = $1::uuid AND is_primary = true AND id <> $2::uuid`,
          existing.accountId,
          id,
        );
      }
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (sql: string, value: unknown): void => {
        params.push(value);
        sets.push(sql.replace('$$', `$${params.length}`));
      };
      if (input.name !== undefined) push('name = $$', input.name);
      if (input.email !== undefined) push('email = $$', input.email);
      if (input.phone !== undefined) push('phone = $$', input.phone || null);
      if (input.role !== undefined) push('role = $$', input.role);
      if (input.isPrimary !== undefined) push('is_primary = $$', input.isPrimary);
      if (sets.length > 0) {
        sets.push('updated_at = now()');
        params.push(id);
        await tx.$executeRawUnsafe(
          `UPDATE platform.crm_contacts SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`,
          ...params,
        );
      }
    });
    return this.getById(id);
  }

  async remove(id: string): Promise<void> {
    await this.getById(id);
    await this.platform.$executeRawUnsafe(
      `DELETE FROM platform.crm_contacts WHERE id = $1::uuid`,
      id,
    );
  }

  async getById(id: string): Promise<ContactDto> {
    const rows = await this.platform.$queryRawUnsafe<RawContactRow[]>(
      `SELECT id::text, account_id::text, person_id::text, name, email, phone, role,
              is_primary, created_at, updated_at
       FROM platform.crm_contacts WHERE id = $1::uuid`,
      id,
    );
    if (rows.length === 0) throw new NotFoundException(`Contact ${id} not found.`);
    return rowToContactDto(rows[0]!);
  }

  // ── Interactions are scoped to this service for simplicity. ──────

  async listInteractions(accountId: string): Promise<InteractionDto[]> {
    await this.accounts.loadOrFail(accountId);
    const rows = await this.platform.$queryRawUnsafe<Parameters<typeof rowToInteractionDto>[0][]>(
      `SELECT id::text, account_id::text, contact_id::text, interaction_type, subject, notes,
              logged_by::text, interaction_at, created_at
       FROM platform.crm_interactions WHERE account_id = $1::uuid
       ORDER BY interaction_at DESC LIMIT 500`,
      accountId,
    );
    return rows.map(rowToInteractionDto);
  }

  async createInteraction(
    accountId: string,
    loggedBy: string,
    input: CreateInteractionDto,
  ): Promise<InteractionDto> {
    await this.accounts.loadOrFail(accountId);
    const id = generateId();
    await this.platform.$executeRawUnsafe(
      `INSERT INTO platform.crm_interactions
        (id, account_id, contact_id, interaction_type, subject, notes, logged_by, interaction_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::timestamptz)`,
      id,
      accountId,
      input.contactId ?? null,
      input.interactionType,
      input.subject,
      input.notes ?? null,
      loggedBy,
      input.interactionAt,
    );
    const rows = await this.platform.$queryRawUnsafe<Parameters<typeof rowToInteractionDto>[0][]>(
      `SELECT id::text, account_id::text, contact_id::text, interaction_type, subject, notes,
              logged_by::text, interaction_at, created_at
       FROM platform.crm_interactions WHERE id = $1::uuid`,
      id,
    );
    return rowToInteractionDto(rows[0]!);
  }
}

interface RawContactRow {
  id: string;
  account_id: string;
  person_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  is_primary: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToContactDto(row: RawContactRow): ContactDto {
  return {
    id: row.id,
    accountId: row.account_id,
    personId: row.person_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role as ContactRole,
    isPrimary: row.is_primary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// re-export to satisfy controller import shape
export type { InteractionType };
