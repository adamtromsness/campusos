import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { AccountAssignmentDto, AssignmentRole, CreateAccountAssignmentDto } from '../dto/ops.dto';
import { OpsEmployeeService } from './ops-employee.service';

/**
 * P2-21b — AccountAssignmentService.
 *
 * Maps ops_employees to crm_accounts (CSM, TAM, AE). UNIQUE(account,
 * employee) so a single employee holds at most one assignment role
 * per account. is_primary signals the primary CSM (or TAM / AE) on
 * the account for default-routing logic in the CRM UI.
 */
@Injectable()
export class AccountAssignmentService {
  constructor(
    private readonly platform: PrismaClient,
    private readonly employees: OpsEmployeeService,
  ) {}

  async listForAccount(accountId: string): Promise<AccountAssignmentDto[]> {
    const rows = await this.platform.$queryRawUnsafe<RawRow[]>(
      `SELECT id::text, account_id::text, employee_id::text, assignment_role,
              is_primary, created_at, updated_at
         FROM platform.ops_account_assignments
         WHERE account_id = $1::uuid
         ORDER BY is_primary DESC, created_at ASC`,
      accountId,
    );
    return rows.map(rowToDto);
  }

  async listForEmployee(employeeId: string): Promise<AccountAssignmentDto[]> {
    await this.employees.loadOrFail(employeeId);
    const rows = await this.platform.$queryRawUnsafe<RawRow[]>(
      `SELECT id::text, account_id::text, employee_id::text, assignment_role,
              is_primary, created_at, updated_at
         FROM platform.ops_account_assignments
         WHERE employee_id = $1::uuid
         ORDER BY is_primary DESC, created_at ASC`,
      employeeId,
    );
    return rows.map(rowToDto);
  }

  async create(input: CreateAccountAssignmentDto): Promise<AccountAssignmentDto> {
    await this.employees.loadOrFail(input.employeeId);
    const id = generateId();
    try {
      await this.platform.$executeRawUnsafe(
        `INSERT INTO platform.ops_account_assignments
          (id, account_id, employee_id, assignment_role, is_primary)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)`,
        id,
        input.accountId,
        input.employeeId,
        input.assignmentRole,
        input.isPrimary ?? false,
      );
    } catch (e: unknown) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      if (
        err?.code === 'P2002' ||
        err?.meta?.code === '23505' ||
        (typeof err?.message === 'string' && err.message.includes('23505'))
      ) {
        throw new ConflictException(
          `Employee ${input.employeeId} is already assigned to account ${input.accountId}.`,
        );
      }
      throw e;
    }
    const rows = await this.platform.$queryRawUnsafe<RawRow[]>(
      `SELECT id::text, account_id::text, employee_id::text, assignment_role,
              is_primary, created_at, updated_at
         FROM platform.ops_account_assignments WHERE id = $1::uuid`,
      id,
    );
    return rowToDto(rows[0]!);
  }

  async remove(id: string): Promise<void> {
    const deleted = await this.platform.$executeRawUnsafe(
      `DELETE FROM platform.ops_account_assignments WHERE id = $1::uuid`,
      id,
    );
    if (deleted === 0) {
      throw new NotFoundException(`ops_account_assignments ${id} not found.`);
    }
  }
}

interface RawRow {
  id: string;
  account_id: string;
  employee_id: string;
  assignment_role: string;
  is_primary: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToDto(row: RawRow): AccountAssignmentDto {
  return {
    id: row.id,
    accountId: row.account_id,
    employeeId: row.employee_id,
    assignmentRole: row.assignment_role as AssignmentRole,
    isPrimary: row.is_primary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
