import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { LedgerService } from './ledger.service';
import {
  FamilyAccountResponseDto,
  FamilyAccountStatus,
  FamilyAccountStudentDto,
  PaymentAuthPolicy,
} from './dto/family-account.dto';

interface AccountRow {
  id: string;
  school_id: string;
  account_holder_id: string;
  account_holder_first_name: string;
  account_holder_last_name: string;
  account_holder_email: string | null;
  account_number: string;
  status: string;
  payment_authorisation_policy: string;
  created_at: string;
  updated_at: string;
}

interface StudentLinkRow {
  family_account_id: string;
  student_id: string;
  student_number: string;
  first_name: string;
  last_name: string;
  grade_level: string;
  added_at: string;
}

function studentRowToDto(r: StudentLinkRow): FamilyAccountStudentDto {
  return {
    studentId: r.student_id,
    studentNumber: r.student_number,
    firstName: r.first_name,
    lastName: r.last_name,
    gradeLevel: r.grade_level,
    addedAt: r.added_at,
  };
}

function accountRowToDto(
  r: AccountRow,
  students: StudentLinkRow[],
  balance: number,
): FamilyAccountResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    accountHolderId: r.account_holder_id,
    accountHolderName: r.account_holder_first_name + ' ' + r.account_holder_last_name,
    accountHolderEmail: r.account_holder_email,
    accountNumber: r.account_number,
    status: r.status as FamilyAccountStatus,
    paymentAuthorisationPolicy: r.payment_authorisation_policy as PaymentAuthPolicy,
    balance: balance,
    students: students.filter((s) => s.family_account_id === r.id).map(studentRowToDto),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

var SELECT_ACCOUNT_BASE =
  'SELECT a.id, a.school_id, a.account_holder_id, ' +
  'ip.first_name AS account_holder_first_name, ip.last_name AS account_holder_last_name, ' +
  'pu.email AS account_holder_email, ' +
  'a.account_number, a.status, a.payment_authorisation_policy, a.created_at, a.updated_at ' +
  'FROM pay_family_accounts a ' +
  'JOIN platform.iam_person ip ON ip.id = a.account_holder_id ' +
  'LEFT JOIN platform.platform_users pu ON pu.person_id = a.account_holder_id ';

@Injectable()
export class FamilyAccountService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * List family accounts. Admin sees all; account holder (parent) sees
   * only their own account (matched on `account_holder_id =
   * actor.personId`). Other personas get an empty list.
   */
  async list(actor: ResolvedActor): Promise<FamilyAccountResponseDto[]> {
    var accounts = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_ACCOUNT_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (!actor.isSchoolAdmin) {
        // Parent persona sees only own account; everyone else sees nothing
        // (students can't see family billing per the plan).
        if (actor.personType !== 'GUARDIAN') return [] as AccountRow[];
        sql += 'AND a.account_holder_id = $' + idx + '::uuid ';
        params.push(actor.personId);
        idx++;
      }
      sql += 'ORDER BY a.created_at DESC';
      return client.$queryRawUnsafe<AccountRow[]>(sql, ...params);
    });
    if (accounts.length === 0) return [];
    var ids = accounts.map((a) => a.id);
    var students = await this.loadStudentsFor(ids);
    var dtos: FamilyAccountResponseDto[] = [];
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i]!;
      var balance = await this.ledger.getBalance(a.id);
      dtos.push(accountRowToDto(a, students, balance.balance));
    }
    return dtos;
  }

  async getById(id: string, actor: ResolvedActor): Promise<FamilyAccountResponseDto> {
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<AccountRow[]>(
        SELECT_ACCOUNT_BASE + 'WHERE a.id = $1::uuid',
        id,
      );
    });
    if (rows.length === 0) throw new NotFoundException('Family account ' + id + ' not found');
    var row = rows[0]!;
    if (!actor.isSchoolAdmin) {
      if (actor.personType !== 'GUARDIAN' || row.account_holder_id !== actor.personId) {
        throw new NotFoundException('Family account ' + id + ' not found');
      }
    }
    var students = await this.loadStudentsFor([id]);
    var balance = await this.ledger.getBalance(id);
    return accountRowToDto(row, students, balance.balance);
  }

  async listStudents(accountId: string, actor: ResolvedActor): Promise<FamilyAccountStudentDto[]> {
    // Re-use the row-scope check from getById.
    await this.getById(accountId, actor);
    var rows = await this.loadStudentsFor([accountId]);
    return rows.map(studentRowToDto);
  }

  /**
   * Internal — used by InvoiceService.generateFromSchedule and
   * PaymentService.pay to enforce parent-side ownership of an
   * invoice / payment by checking the account_holder_id.
   */
  async assertCanWriteAccount(accountId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_holder_id: string }>>(
        'SELECT account_holder_id FROM pay_family_accounts WHERE id = $1::uuid',
        accountId,
      );
    });
    if (rows.length === 0) {
      throw new NotFoundException('Family account ' + accountId + ' not found');
    }
    if (rows[0]!.account_holder_id !== actor.personId) {
      throw new ForbiddenException('Not authorised on this family account');
    }
  }

  private async loadStudentsFor(accountIds: string[]): Promise<StudentLinkRow[]> {
    if (accountIds.length === 0) return [];
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      var placeholders = accountIds
        .map((_: string, i: number) => '$' + (i + 1) + '::uuid')
        .join(',');
      return client.$queryRawUnsafe<StudentLinkRow[]>(
        'SELECT l.family_account_id, l.student_id, s.student_number, ps.first_name, ps.last_name, s.grade_level, l.added_at ' +
          'FROM pay_family_account_students l ' +
          'JOIN sis_students s ON s.id = l.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'WHERE l.family_account_id IN (' +
          placeholders +
          ') ' +
          'ORDER BY ps.last_name, ps.first_name',
        ...accountIds,
      );
    });
  }
}
