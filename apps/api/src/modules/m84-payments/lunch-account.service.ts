import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import { createHash } from 'crypto';
import { OutboxService } from '@shared/kafka';
import type { ResolvedActor } from '@modules/m00-platform';

/**
 * REVIEW-P2-6 BLOCKING 4 — deterministic event_id for the durable
 * low-balance outbox enqueue. Hash of (accountId, alertedAt) so a
 * redelivered fds.meal.served event that re-stamps the same throttle
 * window produces the same id (consumer-side dedup catches it). Same
 * v5-shaped UUID pattern as deterministicCreditNoteEventId /
 * deterministicReversalEventId / deterministicPayrollEventId.
 */
export function deterministicLowBalanceEventId(accountId: string, alertedAt: string): string {
  const hash = createHash('sha256')
    .update(accountId + ':' + alertedAt + ':pay.lunch.low_balance:v1')
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
import {
  DepositLunchAccountDto,
  LunchAccountResponseDto,
  LunchAccountWithTransactionsDto,
  LunchTransactionResponseDto,
  LunchTransactionType,
  LunchTransferResponseDto,
  LunchTransferType,
  TransferLunchBalanceDto,
  UpdateLunchAccountDto,
} from './dto/lunch-account.dto';

interface AccountRow {
  id: string;
  school_id: string;
  student_id: string;
  student_name: string | null;
  balance: string;
  low_balance_threshold: string;
  auto_replenish_enabled: boolean;
  auto_replenish_amount: string | null;
  last_low_balance_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TransactionRow {
  id: string;
  school_id: string;
  lunch_account_id: string;
  amount: string;
  transaction_type: string;
  meal_date: string | null;
  pos_device_id: string | null;
  source_event_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

interface TransferRow {
  id: string;
  school_id: string;
  from_account_id: string;
  to_account_id: string | null;
  transfer_type: string;
  amount: string;
  reason: string;
  refund_id: string | null;
  processed_by: string;
  processed_at: string;
}

const SELECT_ACCOUNT_BASE =
  'SELECT a.id, a.school_id, a.student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.platform_students ps " +
  ' JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
  ' JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id LIMIT 1) AS student_name, ' +
  'a.balance::text, a.low_balance_threshold::text, a.auto_replenish_enabled, a.auto_replenish_amount::text, ' +
  'a.last_low_balance_alert_at, a.created_at, a.updated_at ' +
  'FROM pay_lunch_accounts a ';

function accountRowToDto(r: AccountRow): LunchAccountResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    studentName: r.student_name,
    balance: Number(r.balance),
    lowBalanceThreshold: Number(r.low_balance_threshold),
    autoReplenishEnabled: r.auto_replenish_enabled,
    autoReplenishAmount: r.auto_replenish_amount === null ? null : Number(r.auto_replenish_amount),
    lastLowBalanceAlertAt: r.last_low_balance_alert_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function transactionRowToDto(r: TransactionRow): LunchTransactionResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    lunchAccountId: r.lunch_account_id,
    amount: Number(r.amount),
    transactionType: r.transaction_type as LunchTransactionType,
    mealDate: r.meal_date,
    posDeviceId: r.pos_device_id,
    sourceEventId: r.source_event_id,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function transferRowToDto(r: TransferRow): LunchTransferResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    fromAccountId: r.from_account_id,
    toAccountId: r.to_account_id,
    transferType: r.transfer_type as LunchTransferType,
    amount: Number(r.amount),
    reason: r.reason,
    refundId: r.refund_id,
    processedBy: r.processed_by,
    processedAt: r.processed_at,
  };
}

/**
 * LunchAccountService — Phase 2 Cycle 6 (P2-6).
 *
 * Manages M84 .1 lunch accounts. The cafeteria POS path debits
 * accounts via the Step 10 LunchAccountConsumer. The parent path
 * deposits via this service. Year-end and family transfers are
 * IMMUTABLE balance transfers — no UPDATE / no DELETE service
 * methods. Corrections are made by creating an offsetting transfer
 * in the other direction.
 *
 * Authorisation contract:
 *   - fin-001:read   — admin sees all accounts; parent sees own
 *                      children's via row-scope through
 *                      sis_student_guardians.
 *   - fin-001:write  — parent deposits into own children's
 *                      accounts; admin can deposit on behalf.
 *   - fin-001:admin  — admin processes balance transfers
 *                      (IMMUTABLE), updates account settings,
 *                      lists low-balance accounts.
 */
@Injectable()
export class LunchAccountService {
  private readonly logger = new Logger(LunchAccountService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async getForStudent(
    studentId: string,
    actor: ResolvedActor,
    options: { transactionsLimit?: number } = {},
  ): Promise<LunchAccountWithTransactionsDto> {
    await this.assertCanReadStudent(studentId, actor);
    const accountRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AccountRow[]>(
        SELECT_ACCOUNT_BASE + 'WHERE a.student_id = $1::uuid',
        studentId,
      ),
    )) as AccountRow[];
    if (accountRows.length === 0) {
      throw new NotFoundException('Lunch account for student ' + studentId + ' not found');
    }
    const dto = accountRowToDto(accountRows[0]!);
    const txLimit = Math.min(options.transactionsLimit ?? 25, 100);
    const txRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransactionRow[]>(
        'SELECT id, school_id, lunch_account_id, amount::text, transaction_type, meal_date, pos_device_id, source_event_id, notes, created_by, created_at ' +
          'FROM pay_lunch_transactions WHERE lunch_account_id = $1::uuid ORDER BY created_at DESC LIMIT $2::int',
        dto.id,
        txLimit,
      ),
    )) as TransactionRow[];
    return {
      account: dto,
      transactions: txRows.map(transactionRowToDto),
      lowBalance: dto.balance <= dto.lowBalanceThreshold,
    };
  }

  async getById(id: string, actor: ResolvedActor): Promise<LunchAccountResponseDto> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AccountRow[]>(SELECT_ACCOUNT_BASE + 'WHERE a.id = $1::uuid', id),
    );
    if (rows.length === 0) throw new NotFoundException('Lunch account ' + id + ' not found');
    const dto = accountRowToDto(rows[0]!);
    await this.assertCanReadStudent(dto.studentId, actor);
    return dto;
  }

  async listLowBalance(actor: ResolvedActor): Promise<LunchAccountResponseDto[]> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can list low-balance lunch accounts');
    const schoolId = getCurrentTenant().schoolId;
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<AccountRow[]>(
        SELECT_ACCOUNT_BASE +
          'WHERE a.school_id = $1::uuid AND a.balance <= a.low_balance_threshold ORDER BY a.balance ASC',
        schoolId,
      ),
    )) as AccountRow[];
    return rows.map(accountRowToDto);
  }

  async deposit(
    accountId: string,
    body: DepositLunchAccountDto,
    actor: ResolvedActor,
  ): Promise<LunchTransactionResponseDto> {
    const account = await this.getById(accountId, actor);
    if (body.amount <= 0) throw new BadRequestException('amount must be > 0');
    const schoolId = getCurrentTenant().schoolId;
    const txId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT id FROM pay_lunch_accounts WHERE id = $1::uuid FOR UPDATE',
        account.id,
      );
      await tx.$executeRawUnsafe(
        'INSERT INTO pay_lunch_transactions (id, school_id, lunch_account_id, amount, transaction_type, notes, created_by) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, 'DEPOSIT', $5, $6::uuid)",
        txId,
        schoolId,
        account.id,
        body.amount.toFixed(2),
        body.notes ?? null,
        actor.accountId,
      );
      await tx.$executeRawUnsafe(
        'UPDATE pay_lunch_accounts SET balance = balance + $2::numeric, updated_at = now() WHERE id = $1::uuid',
        account.id,
        body.amount.toFixed(2),
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransactionRow[]>(
        'SELECT id, school_id, lunch_account_id, amount::text, transaction_type, meal_date, pos_device_id, source_event_id, notes, created_by, created_at FROM pay_lunch_transactions WHERE id = $1::uuid',
        txId,
      ),
    )) as TransactionRow[];
    return transactionRowToDto(rows[0]!);
  }

  async update(
    id: string,
    body: UpdateLunchAccountDto,
    actor: ResolvedActor,
  ): Promise<LunchAccountResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can update lunch account settings');
    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (body.lowBalanceThreshold !== undefined) {
      sets.push('low_balance_threshold = $' + idx + '::numeric');
      params.push(body.lowBalanceThreshold.toFixed(2));
      idx++;
    }
    if (body.autoReplenishEnabled !== undefined) {
      sets.push('auto_replenish_enabled = $' + idx);
      params.push(body.autoReplenishEnabled);
      idx++;
    }
    if (body.autoReplenishAmount !== undefined) {
      sets.push('auto_replenish_amount = $' + idx + '::numeric');
      params.push(body.autoReplenishAmount.toFixed(2));
      idx++;
    }
    if (sets.length === 0) return this.getById(id, actor);
    sets.push('updated_at = now()');
    params.push(id);
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const result = await client.$executeRawUnsafe(
        'UPDATE pay_lunch_accounts SET ' + sets.join(', ') + ' WHERE id = $' + idx + '::uuid',
        ...params,
      );
      if (result === 0) throw new NotFoundException('Lunch account ' + id + ' not found');
    });
    return this.getById(id, actor);
  }

  /**
   * IMMUTABLE balance transfer. Inserts a pay_lunch_account_balance_transfers
   * row and atomically adjusts the from + to balances inside one tenant
   * tx. The schema has no UPDATE / DELETE path, mirroring ADR-010.
   * Service has no update/delete methods either — corrections are made
   * by creating an offsetting transfer.
   */
  async transfer(
    body: TransferLunchBalanceDto,
    actor: ResolvedActor,
  ): Promise<LunchTransferResponseDto> {
    if (!actor.isSchoolAdmin)
      throw new ForbiddenException('Only admins can process lunch account balance transfers');
    if (body.amount <= 0) throw new BadRequestException('amount must be > 0');
    if (body.transferType === 'REFUND_TO_FAMILY' && !body.refundId) {
      throw new BadRequestException('refundId is required for REFUND_TO_FAMILY transfer type');
    }
    if (
      (body.transferType === 'SIBLING_TRANSFER' || body.transferType === 'NEXT_YEAR_ROLLOVER') &&
      !body.toAccountId
    ) {
      throw new BadRequestException('toAccountId is required for ' + body.transferType);
    }
    if (body.transferType === 'REFUND_TO_FAMILY' && body.toAccountId) {
      throw new BadRequestException('toAccountId must be NULL for REFUND_TO_FAMILY');
    }
    if (body.toAccountId && body.toAccountId === body.fromAccountId) {
      throw new BadRequestException('toAccountId must be different from fromAccountId');
    }
    const schoolId = getCurrentTenant().schoolId;
    const transferId = generateId();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const fromRows = (await tx.$queryRawUnsafe(
        'SELECT id, balance::text FROM pay_lunch_accounts WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        body.fromAccountId,
        schoolId,
      )) as Array<{ id: string; balance: string }>;
      if (fromRows.length === 0)
        throw new NotFoundException('Source lunch account ' + body.fromAccountId + ' not found');
      const fromBalance = Number(fromRows[0]!.balance);
      if (body.amount > fromBalance + 0.001) {
        throw new BadRequestException(
          'Transfer amount $' +
            body.amount.toFixed(2) +
            ' exceeds source balance $' +
            fromBalance.toFixed(2),
        );
      }
      if (body.toAccountId) {
        const toRows = (await tx.$queryRawUnsafe(
          'SELECT id FROM pay_lunch_accounts WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
          body.toAccountId,
          schoolId,
        )) as Array<{ id: string }>;
        if (toRows.length === 0)
          throw new NotFoundException(
            'Destination lunch account ' + body.toAccountId + ' not found',
          );
      }
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_lunch_account_balance_transfers ' +
            '(id, school_id, from_account_id, to_account_id, transfer_type, amount, reason, refund_id, processed_by) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7, $8, $9::uuid)',
          transferId,
          schoolId,
          body.fromAccountId,
          body.toAccountId ?? null,
          body.transferType,
          body.amount.toFixed(2),
          body.reason,
          body.refundId ?? null,
          actor.accountId,
        );
      } catch (err) {
        if (err instanceof Error && /pay_lunch_xfer/.test(err.message)) {
          throw new BadRequestException('Transfer rejected by schema invariant: ' + err.message);
        }
        throw err;
      }
      await tx.$executeRawUnsafe(
        'UPDATE pay_lunch_accounts SET balance = balance - $2::numeric, updated_at = now() WHERE id = $1::uuid',
        body.fromAccountId,
        body.amount.toFixed(2),
      );
      if (body.toAccountId) {
        await tx.$executeRawUnsafe(
          'UPDATE pay_lunch_accounts SET balance = balance + $2::numeric, updated_at = now() WHERE id = $1::uuid',
          body.toAccountId,
          body.amount.toFixed(2),
        );
      }
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe<TransferRow[]>(
        'SELECT id, school_id, from_account_id, to_account_id, transfer_type, amount::text, reason, refund_id, processed_by, processed_at FROM pay_lunch_account_balance_transfers WHERE id = $1::uuid',
        transferId,
      ),
    )) as TransferRow[];
    return transferRowToDto(rows[0]!);
  }

  /**
   * Internal — called by the Step 10 LunchAccountConsumer when an
   * fds.meal.served event arrives. Idempotent via the partial UNIQUE
   * INDEX on pay_lunch_transactions.source_event_id (catches Kafka
   * redelivery). Returns true if a new transaction was created and
   * the balance crossed the low_balance_threshold (so the caller
   * can emit pay.lunch.low_balance).
   */
  async chargeMealFromConsumer(input: {
    studentId: string;
    amount: number;
    mealDate: string;
    posDeviceId: string | null;
    sourceEventId: string;
    posSessionId: string | null;
  }): Promise<{
    created: boolean;
    balanceCrossedThreshold: boolean;
    account: LunchAccountResponseDto | null;
  }> {
    const schoolId = getCurrentTenant().schoolId;
    let result: {
      created: boolean;
      balanceCrossedThreshold: boolean;
      account: LunchAccountResponseDto | null;
    } = {
      created: false,
      balanceCrossedThreshold: false,
      account: null,
    };
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const accountRows = (await tx.$queryRawUnsafe(
        'SELECT id, balance::text, low_balance_threshold::text, last_low_balance_alert_at FROM pay_lunch_accounts WHERE student_id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        input.studentId,
        schoolId,
      )) as Array<{
        id: string;
        balance: string;
        low_balance_threshold: string;
        last_low_balance_alert_at: string | null;
      }>;
      if (accountRows.length === 0) {
        this.logger.warn(
          'Lunch account for student ' +
            input.studentId +
            ' not found — fds.meal.served event dropped',
        );
        return;
      }
      const account = accountRows[0]!;
      const oldBalance = Number(account.balance);
      const threshold = Number(account.low_balance_threshold);
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO pay_lunch_transactions (id, school_id, lunch_account_id, amount, transaction_type, meal_date, pos_device_id, source_event_id) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::numeric, 'MEAL_CHARGE', $5::date, $6, $7::uuid)",
          generateId(),
          schoolId,
          account.id,
          input.amount.toFixed(2),
          input.mealDate,
          input.posDeviceId,
          input.sourceEventId,
        );
        result.created = true;
      } catch (err) {
        if (err instanceof Error && /pay_lunch_tx_event_dedup_uq|23505/.test(err.message)) {
          // Redelivery — same event already landed.
          this.logger.debug(
            'Skipping duplicate MEAL_CHARGE for source_event_id ' + input.sourceEventId,
          );
          return;
        }
        throw err;
      }
      await tx.$executeRawUnsafe(
        'UPDATE pay_lunch_accounts SET balance = balance - $2::numeric, updated_at = now() WHERE id = $1::uuid',
        account.id,
        input.amount.toFixed(2),
      );
      const newBalance = Number((oldBalance - input.amount).toFixed(2));
      // Throttle alerts: only emit if we just crossed the threshold
      // AND last alert was > 24h ago (or never).
      const lastAlertAt = account.last_low_balance_alert_at
        ? new Date(account.last_low_balance_alert_at).getTime()
        : 0;
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      if (oldBalance > threshold && newBalance <= threshold && lastAlertAt < oneDayAgo) {
        result.balanceCrossedThreshold = true;
        // REVIEW-P2-6 BLOCKING 4 — stamp the throttle row AND enqueue
        // the durable outbox envelope INSIDE the same tenant tx. If
        // Kafka is down the OutboxPublisherWorker retries until it
        // succeeds, but the throttle stamp does not "lose" the alert
        // because both rows commit atomically. If the tx rolls back
        // the throttle stamp also rolls back so the next event will
        // re-evaluate. Resolve student name via JOINs inside the tx
        // so we do not have to read the account back outside the tx.
        const stampRows = (await tx.$queryRawUnsafe(
          'UPDATE pay_lunch_accounts SET last_low_balance_alert_at = now() WHERE id = $1::uuid RETURNING last_low_balance_alert_at::text AS alerted_at',
          account.id,
        )) as Array<{ alerted_at: string }>;
        const alertedAt = stampRows[0]?.alerted_at ?? new Date().toISOString();
        const studentRows = (await tx.$queryRawUnsafe(
          "SELECT s.id::text AS student_id, p.first_name || ' ' || p.last_name AS student_name " +
            'FROM sis_students s ' +
            'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
            'JOIN platform.iam_person p ON p.id = ps.person_id ' +
            'WHERE s.id = $1::uuid',
          input.studentId,
        )) as Array<{ student_id: string; student_name: string }>;
        const studentName = studentRows[0]?.student_name ?? '';
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'pay.lunch.low_balance',
          key: account.id,
          sourceModule: 'payments',
          eventId: deterministicLowBalanceEventId(account.id, alertedAt),
          payload: {
            lunchAccountId: account.id,
            studentId: input.studentId,
            studentName,
            schoolId,
            balance: newBalance,
            threshold,
            sourceRefId: account.id,
          },
        });
      }
    });
    if (result.created) {
      const accountRows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<AccountRow[]>(
          SELECT_ACCOUNT_BASE + 'WHERE a.student_id = $1::uuid',
          input.studentId,
        ),
      )) as AccountRow[];
      result.account = accountRows.length > 0 ? accountRowToDto(accountRows[0]!) : null;
    }
    return result;
  }

  /** Row-scope: admin all; parent linked-children only via sis_student_guardians. */
  private async assertCanReadStudent(studentId: string, actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    if (actor.personType === 'STUDENT') {
      // Resolve the calling student's own sis_students.id.
      const rows = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<{ id: string }>>(
          'SELECT s.id FROM sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id WHERE ps.person_id = $1::uuid LIMIT 1',
          actor.personId,
        ),
      )) as Array<{ id: string }>;
      if (rows.length === 0 || rows[0]!.id !== studentId) {
        throw new NotFoundException('Lunch account not found');
      }
      return;
    }
    if (actor.personType === 'GUARDIAN' && actor.personId) {
      const linked = (await this.tenantPrisma.executeInTenantContext(async (client) =>
        client.$queryRawUnsafe<Array<unknown>>(
          'SELECT 1 FROM sis_student_guardians sg JOIN sis_guardians g ON g.id = sg.guardian_id WHERE sg.student_id = $1::uuid AND g.person_id = $2::uuid LIMIT 1',
          studentId,
          actor.personId,
        ),
      )) as Array<unknown>;
      if (linked.length === 0) {
        throw new NotFoundException('Lunch account not found');
      }
      return;
    }
    throw new ForbiddenException(
      'Only admins, the student, or a linked guardian can read lunch accounts',
    );
  }
}
