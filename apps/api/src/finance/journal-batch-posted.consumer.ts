import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';
import { PostingService } from './posting.service';
import type { ResolvedActor } from '../iam/actor-context.service';

const CONSUMER_GROUP = 'journal-batch-posted-consumer';

interface JournalBatchPostedPayload {
  batchId: string;
  schoolId: string;
  batchName: string;
  entryCount: number;
  totalDebits: number | string;
  totalCredits: number | string;
  postedBy: string;
  lines: Array<{
    accountId: string;
    debit: number | string;
    credit: number | string;
    description: string | null;
    lineOrder: number;
  }>;
  sourceRefId: string;
}

/**
 * REVIEW-P2C29 Round 1 BLOCKING 5 fix — module boundary.
 *
 * The commerce JournalBatchService now emits fin.journal_batch.posted
 * after validating + flipping status, without writing to
 * fin_gl_entries. This consumer (the Finance module's owner of
 * fin_gl_entries) materialises the GL entries by calling
 * PostingService.createAndPost(), which:
 *   - checks fin_journal_batches.source_event_id UNIQUE for redelivery
 *     idempotency (Kafka redelivery returns the existing batch);
 *   - validates balanced double-entry via ADR-059 inside the tx;
 *   - resolves an OPEN period;
 *   - inserts fin_journal_batches + fin_gl_entries + bumps budget
 *     line actuals inside one atomic tenant transaction.
 *
 * The consumer is therefore the ONLY GL writer for the manual-batch
 * path. Commerce owns the source-of-truth `fin_journal_entry_batches`
 * + `fin_journal_entry_lines`; Finance owns the derived
 * `fin_journal_batches` + `fin_gl_entries`.
 *
 * processWithIdempotency already wraps the handler in
 * runWithTenantContextAsync({ tenant: event.tenant }) so every
 * executeInTenantContext below reads the tenant from
 * AsyncLocalStorage automatically.
 *
 * Failure handling: throws on configuration miss (no synthetic CFO
 * actor, no OPEN period, missing fund). The thrown error propagates
 * through processWithIdempotency which leaves the event unclaimed;
 * the standard consumer retry / DLQ chain catches the failure and
 * lands the event in platform.platform_dlq_messages for operator
 * action — manual journal batches must NOT be silently dropped on
 * configuration failure, matching the Cycle 26 GLConsumer contract.
 */
@Injectable()
export class JournalBatchPostedConsumer implements OnModuleInit {
  private readonly logger = new Logger(JournalBatchPostedConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly posting: PostingService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('fin.journal_batch.posted')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
    this.logger.log(`Subscribed to dev.fin.journal_batch.posted under group ${CONSUMER_GROUP}`);
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<JournalBatchPostedPayload>(msg, this.logger);
    if (!event) return;
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event,
      this.idempotency,
      this.logger,
      async function () {
        await self.process(event);
      },
    );
  }

  private async process(event: UnwrappedEvent<JournalBatchPostedPayload>): Promise<void> {
    const payload = event.payload;
    if (!payload || !Array.isArray(payload.lines) || payload.lines.length === 0) {
      this.logger.warn(
        `[${CONSUMER_GROUP}] dropping event ${event.eventId} — payload has no lines`,
      );
      return;
    }
    // REVIEW-P2C29 hardening — explicit cap on payload.lines length
    // before any iteration. The producer (commerce JournalBatchService)
    // emits with `fin_journal_entry_lines.batch_id` cardinality which
    // is admin-bounded, but a redelivered or corrupted Kafka envelope
    // could carry an unbounded array. CodeQL js/loop-bound-injection
    // requires a statically visible runtime check before the maps
    // below iterate the array.
    const MAX_BATCH_LINES = 1000;
    if (payload.lines.length > MAX_BATCH_LINES) {
      throw new Error(
        `[${CONSUMER_GROUP}] payload.lines length ${payload.lines.length} exceeds MAX_BATCH_LINES=${MAX_BATCH_LINES} for batch ${payload.batchId} — refusing to materialise GL entries`,
      );
    }
    const schoolId = event.tenant.schoolId;
    const cfo = await this.resolveSyntheticActor(schoolId);
    if (!cfo) {
      throw new Error(
        `[${CONSUMER_GROUP}] no ACTIVE hr_employees row for tenant ${schoolId} — cannot post manual journal batch ${payload.batchId}`,
      );
    }
    const fundByAccount = await this.resolveFundsForAccounts(
      payload.lines.map((ln) => ln.accountId),
    );
    const fallbackFundId = await this.resolveFallbackFund();
    if (!fallbackFundId) {
      throw new Error(
        `[${CONSUMER_GROUP}] no active fund configured for tenant ${schoolId} — cannot post manual journal batch ${payload.batchId}`,
      );
    }
    const batchNumber = `MAN-${payload.batchId.slice(0, 8).toUpperCase()}`;
    await this.posting.createAndPost(cfo, {
      batchNumber,
      description: `Manual journal batch: ${payload.batchName}`,
      batchType: 'ADJUSTMENT',
      sourceModule: 'commerce',
      // PostingService.createAndPost resolves today's OPEN period
      // when periodId is omitted; the DTO column requires a UUID so
      // we pass a sentinel that is ignored (mirrors GLConsumer).
      accountingPeriodId: '00000000-0000-0000-0000-000000000000',
      sourceEventId: event.eventId,
      entries: payload.lines.map((ln) => ({
        accountId: ln.accountId,
        // Resolve fund from the account's own fund_id; fall back to
        // the school's first active fund when the account does not
        // carry a fund_id directly (cross-fund chart entries).
        fundId: fundByAccount.get(ln.accountId) ?? fallbackFundId,
        debit: Number(ln.debit),
        credit: Number(ln.credit),
        description: ln.description ?? undefined,
        referenceType: 'fin_journal_entry_batches',
        referenceId: payload.batchId,
      })),
    });
    this.logger.log(
      `[${CONSUMER_GROUP}] posted GL batch from manual journal batch=${payload.batchId.slice(0, 8)} eventId=${event.eventId.slice(0, 8)}`,
    );
  }

  private async resolveFundsForAccounts(accountIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (accountIds.length === 0) return out;
    const unique = Array.from(new Set(accountIds));
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id, fund_id::text AS fund_id
           FROM fin_chart_of_accounts
          WHERE id = ANY($1::uuid[]) AND is_active = true`,
        unique,
      );
    })) as Array<{ id: string; fund_id: string | null }>;
    for (const r of rows) {
      if (r.fund_id) out.set(r.id, r.fund_id);
    }
    return out;
  }

  private async resolveFallbackFund(): Promise<string | null> {
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        `SELECT id::text AS id FROM fin_funds WHERE is_active = true ORDER BY fund_code LIMIT 1`,
      );
    })) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  /**
   * Resolve a synthetic actor matching the GLConsumer convention:
   * the first ACTIVE hr_employees row in the school. PostingService
   * requires an employee actor; this consumer follows the same
   * pattern so the posting authorisation path stays consistent
   * across automated and manual-batch posts.
   */
  private async resolveSyntheticActor(schoolId: string): Promise<ResolvedActor | null> {
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT e.id::text AS employee_id,
                e.person_id::text AS person_id,
                pu.id::text AS account_id
           FROM hr_employees e
           JOIN platform.iam_person p ON p.id = e.person_id
           LEFT JOIN platform.platform_users pu ON pu.person_id = e.person_id
          WHERE e.school_id = $1::uuid AND e.employment_status = 'ACTIVE'
          ORDER BY e.created_at
          LIMIT 1`,
        schoolId,
      )) as Array<{ employee_id: string; person_id: string; account_id: string | null }>;
      if (rows.length === 0) return null;
      const row = rows[0]!;
      const actor: ResolvedActor = {
        accountId: row.account_id ?? row.person_id,
        personId: row.person_id,
        personType: 'STAFF',
        employeeId: row.employee_id,
        isSchoolAdmin: true,
      };
      return actor;
    });
  }
}
