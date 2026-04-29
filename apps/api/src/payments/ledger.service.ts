import { Injectable } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { RedisService } from '../notifications/redis.service';
import {
  EntryType,
  LedgerBalanceDto,
  LedgerEntryDto,
  ListLedgerQueryDto,
} from './dto/ledger.dto';

interface LedgerRow {
  id: string;
  family_account_id: string;
  entry_type: string;
  amount: string;
  reference_id: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
}

function rowToDto(r: LedgerRow): LedgerEntryDto {
  return {
    id: r.id,
    familyAccountId: r.family_account_id,
    entryType: r.entry_type as EntryType,
    amount: Number(r.amount),
    referenceId: r.reference_id,
    description: r.description,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/**
 * LedgerService — the M84 Payments billing-engine source of truth.
 *
 * `pay_ledger_entries` is IMMUTABLE per ADR-010 (service-side discipline,
 * no DB trigger or revoke). Balance is always derivable from
 * SUM(amount) for the family account. CHARGE entries are positive by
 * convention, PAYMENT entries are negative, REFUND entries are positive
 * (they put money back into the balance owed). CREDIT and ADJUSTMENT
 * entries can be either sign — admin corrections.
 *
 * The `recordEntry` method is internal-only — it is called from inside
 * an open tenant transaction by InvoiceService.send / PaymentService.pay
 * / RefundService.issue so the ledger write is atomic with the lifecycle
 * change that caused it. Public read-side methods (`getBalance`,
 * `listEntries`) take their own tenant context.
 *
 * Balance caching: every read goes through Redis at
 * `ledger:balance:{accountId}` with TTL=30s per the Cycle 6 Step 7 plan.
 * Cache is invalidated on every write. The 30s TTL is the safety net
 * if a server restart misses an in-flight invalidate.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Internal — called inside an open tenant tx by the payment / invoice
   * / refund services. Inserts one row into pay_ledger_entries and
   * invalidates the balance cache. Caller MUST be inside a tx.
   */
  async recordEntry(
    tx: any,
    args: {
      familyAccountId: string;
      entryType: EntryType;
      amount: number;
      referenceId: string | null;
      description: string | null;
      createdBy: string | null;
    },
  ): Promise<string> {
    var entryId = generateId();
    await tx.$executeRawUnsafe(
      'INSERT INTO pay_ledger_entries (id, family_account_id, entry_type, amount, reference_id, description, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5::uuid, $6, $7::uuid)',
      entryId,
      args.familyAccountId,
      args.entryType,
      args.amount.toFixed(2),
      args.referenceId,
      args.description,
      args.createdBy,
    );
    // Invalidate the balance cache. Best-effort — RedisService is
    // resilient to outages, the 30s TTL is the safety net.
    void this.redis.invalidateLedgerBalance(args.familyAccountId);
    return entryId;
  }

  /**
   * Read-side: balance for a single family account. Tries the Redis
   * cache first, then falls back to a SUM(amount) over
   * pay_ledger_entries.
   */
  async getBalance(familyAccountId: string): Promise<LedgerBalanceDto> {
    var cached = await this.redis.getLedgerBalance(familyAccountId);
    if (cached !== null) {
      return {
        familyAccountId,
        balance: Number(cached),
        cached: true,
      };
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ bal: string }>>(
        'SELECT COALESCE(SUM(amount), 0)::text AS bal FROM pay_ledger_entries WHERE family_account_id = $1::uuid',
        familyAccountId,
      );
    });
    var balance = rows[0]?.bal ?? '0';
    await this.redis.setLedgerBalance(familyAccountId, balance);
    return {
      familyAccountId,
      balance: Number(balance),
      cached: false,
    };
  }

  /**
   * Read-side: paginated entries newest-first. Keyset cursor on
   * `created_at` so the partition pruning kicks in.
   */
  async listEntries(
    familyAccountId: string,
    query: ListLedgerQueryDto,
  ): Promise<LedgerEntryDto[]> {
    var limit = Math.min(query.limit ?? 50, 200);
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql =
        'SELECT id, family_account_id, entry_type, amount::text, reference_id, description, created_by, created_at ' +
        'FROM pay_ledger_entries WHERE family_account_id = $1::uuid ';
      var params: any[] = [familyAccountId];
      var idx = 2;
      if (query.before) {
        sql += 'AND created_at < $' + idx + '::timestamptz ';
        params.push(query.before);
        idx++;
      }
      if (query.referenceId) {
        sql += 'AND reference_id = $' + idx + '::uuid ';
        params.push(query.referenceId);
        idx++;
      }
      sql += 'ORDER BY created_at DESC LIMIT $' + idx + '::int';
      params.push(limit);
      return client.$queryRawUnsafe<LedgerRow[]>(sql, ...params);
    });
    return rows.map(rowToDto);
  }
}
