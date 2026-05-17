import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  EngagementScoreService,
  computeCompositeScore,
  resolveEngagementLevel,
} from './engagement-score.service';
import type { EngagementLevelThresholds, EngagementScoreWeights } from './dto/engagement.dto';

/**
 * P2-24a — EngagementScoreWorker.
 *
 * Weekly sweep across every active school. Per tenant:
 *   1. Load weights + thresholds from school_config (fallback to
 *      defaults).
 *   2. Read every pay_family_accounts row and resolve the 5
 *      cross-module components per family:
 *         attendance      — % of school events the family attended
 *                           via sis_attendance_records joined to
 *                           students linked to the family.
 *         communication   — % of msg_messages addressed to the
 *                           parent that have a msg_message_reads row.
 *         conference      — % of attended eng_conference_bookings
 *                           over total bookings booked.
 *         volunteer       — confirmed evt_volunteers normalized
 *                           against a 10-event ceiling.
 *         payment         — % of pay_invoices that are PAID or
 *                           partially paid on time (no OVERDUE).
 *   3. UPSERT eng_family_engagement_scores keyed on
 *      (family_account_id, score_date).
 *
 * The worker is best-effort: missing source tables (e.g. evt_volunteers
 * in a tenant that has not enabled events yet) gracefully resolve to
 * 0 for that component. Each component is clamped to [0, 100] before
 * the weighted sum.
 *
 * Run cadence: weekly (7d) by default. Configurable via
 * ENG_SCORE_SWEEP_INTERVAL_MS env var. The worker resolves the
 * scoreDate to today (UTC) so re-runs within the same day idempotently
 * UPSERT the row via the schema's UNIQUE(family_account_id, score_date).
 */
@Injectable()
export class EngagementScoreWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngagementScoreWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly scoreService: EngagementScoreService,
  ) {
    this.intervalMs = Number(process.env.ENG_SCORE_SWEEP_INTERVAL_MS) || 7 * 24 * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('EngagementScoreWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'EngagementScoreWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / (60 * 60 * 1000)) +
        ' hours',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ tenantsScanned: number; familiesScored: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({ where: { isActive: true } });

    let totalScored = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const scored = await this.tickForSchool(school.schemaName, school.id);
        totalScored += scored;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('EngagementScoreWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, familiesScored: totalScored };
  }

  async tickForSchool(schemaName: string, schoolId: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      // Load weights + thresholds
      const weights = await this.loadConfig<EngagementScoreWeights>(
        client,
        'engagement_score_weights',
        DEFAULT_WEIGHTS,
      );
      const thresholds = await this.loadConfig<EngagementLevelThresholds>(
        client,
        'engagement_level_thresholds',
        DEFAULT_THRESHOLDS,
      );

      // List all active family accounts in this school
      const families = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, account_holder_id::text AS account_holder_id
         FROM pay_family_accounts
         WHERE school_id = $1::uuid
         ORDER BY created_at ASC`,
        schoolId,
      )) as Array<{ id: string; account_holder_id: string }>;

      const today = new Date().toISOString().slice(0, 10);
      let scored = 0;
      for (const fam of families) {
        const components = await this.computeComponents(
          client,
          schoolId,
          fam.id,
          fam.account_holder_id,
        );
        const composite = computeCompositeScore(components, weights);
        const level = resolveEngagementLevel(composite, thresholds);

        await this.scoreService.upsertScore({
          schoolId,
          familyAccountId: fam.id,
          scoreDate: today,
          components,
          weights,
          thresholds,
          client,
        });
        scored += 1;
        this.logger.debug(
          'family ' + fam.id + ' scored composite=' + composite + ' level=' + level,
        );
      }
      return scored;
    });
  }

  /**
   * Resolve 5 engagement components for one family. Each component
   * returns a [0,100] percentage. Missing source tables / no data
   * resolves to 0 so the worker is best-effort and never crashes when
   * a tenant has not enabled a particular module.
   */
  async computeComponents(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    familyAccountId: string,
    accountHolderId: string,
  ): Promise<{
    attendance: number;
    communication: number;
    conference: number;
    volunteer: number;
    payment: number;
  }> {
    return {
      attendance: await this.attendanceComponent(client, schoolId, familyAccountId),
      communication: await this.communicationComponent(client, schoolId, accountHolderId),
      conference: await this.conferenceComponent(client, schoolId, accountHolderId),
      volunteer: await this.volunteerComponent(client, schoolId, accountHolderId),
      payment: await this.paymentComponent(client, schoolId, familyAccountId),
    };
  }

  // REVIEW-P2C24 BLOCKING 4 — every source query carries a current-school
  // predicate or school-derived JOIN so multi-school tenants (a single
  // tenant schema can host multiple schools) don't cross-leak engagement
  // signal from one school into another.

  // attendance_component — % of school events the family's students attended
  // IN THIS SCHOOL ONLY. Joins through sis_students.school_id so a family
  // with children at both schools in a multi-school tenant only counts
  // the current school's attendance toward this school's score.
  private async attendanceComponent(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    familyAccountId: string,
  ): Promise<number> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE ar.status IN ('PRESENT','TARDY'))::int AS attended,
           COUNT(*)::int AS total
         FROM sis_attendance_records ar
         JOIN pay_family_account_students fs ON fs.student_id = ar.student_id
         JOIN sis_students s ON s.id = ar.student_id
         WHERE fs.family_account_id = $1::uuid
           AND ar.school_id = $2::uuid
           AND s.school_id = $2::uuid
           AND ar.date >= (CURRENT_DATE - INTERVAL '60 days')`,
        familyAccountId,
        schoolId,
      )) as Array<{ attended: number; total: number }>;
      const r = rows[0];
      if (!r || Number(r.total) === 0) return 0;
      return Math.round((Number(r.attended) / Number(r.total)) * 100);
    } catch {
      return 0;
    }
  }

  // communication_component — msg_message_reads / msg_messages addressed to
  // the parent IN THIS SCHOOL. msg_thread_participants has `school_id`
  // (Cycle 3) so threads from another school in a multi-school tenant
  // are filtered out at the JOIN.
  //
  // Note: the original P2-24a SQL referenced tp.user_id + r.user_id which
  // don't exist (actual columns are tp.platform_user_id + r.reader_id).
  // The try/catch was swallowing the broken-SQL error so the worker
  // silently returned 0 for every family. Round 1 fix corrects both the
  // column names AND the school-scoping.
  private async communicationComponent(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    accountHolderId: string,
  ): Promise<number> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(DISTINCT r.message_id)::int AS read_count,
           COUNT(DISTINCT mp.id)::int AS total_count
         FROM msg_thread_participants tp
         JOIN msg_messages mp
           ON mp.thread_id = tp.thread_id
          AND mp.school_id = tp.school_id
         LEFT JOIN msg_message_reads r
           ON r.message_id = mp.id AND r.reader_id = tp.platform_user_id
         WHERE tp.platform_user_id = $1::uuid
           AND tp.school_id = $2::uuid
           AND mp.created_at >= (CURRENT_DATE - INTERVAL '60 days')`,
        accountHolderId,
        schoolId,
      )) as Array<{ read_count: number; total_count: number }>;
      const r = rows[0];
      if (!r || Number(r.total_count) === 0) return 0;
      return Math.round((Number(r.read_count) / Number(r.total_count)) * 100);
    } catch {
      return 0;
    }
  }

  // conference_component — % of bookings attended over total non-cancelled
  // IN THIS SCHOOL. eng_conference_bookings.school_id is populated by
  // ConferenceBookingService.book on every INSERT so the predicate is
  // direct.
  private async conferenceComponent(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    accountHolderId: string,
  ): Promise<number> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE attended IS TRUE)::int AS attended,
           COUNT(*) FILTER (WHERE cancelled_at IS NULL)::int AS total
         FROM eng_conference_bookings
         WHERE parent_id = $1::uuid
           AND school_id = $2::uuid
           AND booked_at >= (CURRENT_DATE - INTERVAL '180 days')`,
        accountHolderId,
        schoolId,
      )) as Array<{ attended: number; total: number }>;
      const r = rows[0];
      if (!r || Number(r.total) === 0) return 0;
      return Math.round((Number(r.attended) / Number(r.total)) * 100);
    } catch {
      return 0;
    }
  }

  // volunteer_component — confirmed volunteer signups in last 180 days
  // for events HOSTED BY THIS SCHOOL. evt_volunteers has no direct
  // school_id column, so we JOIN to evt_events.school_id.
  private async volunteerComponent(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    accountHolderId: string,
  ): Promise<number> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS c
         FROM evt_volunteers v
         JOIN evt_events e ON e.id = v.event_id
         WHERE v.person_id = $1::uuid
           AND v.status = 'CONFIRMED'
           AND e.school_id = $2::uuid
           AND v.created_at >= (CURRENT_DATE - INTERVAL '180 days')`,
        accountHolderId,
        schoolId,
      )) as Array<{ c: number }>;
      const c = rows[0] ? Number(rows[0].c) : 0;
      // 0 → 0%, 10+ events → 100%
      return Math.min(100, Math.round((c / 10) * 100));
    } catch {
      return 0;
    }
  }

  // payment_component — % of invoices in the last 180 days that are PAID
  // or PARTIALLY_PAID and not OVERDUE, IN THIS SCHOOL. pay_invoices has
  // a direct school_id column.
  private async paymentComponent(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    schoolId: string,
    familyAccountId: string,
  ): Promise<number> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('PAID','PARTIALLY_PAID'))::int AS on_time,
           COUNT(*)::int AS total
         FROM pay_invoices
         WHERE family_account_id = $1::uuid
           AND school_id = $2::uuid
           AND created_at >= (CURRENT_DATE - INTERVAL '180 days')`,
        familyAccountId,
        schoolId,
      )) as Array<{ on_time: number; total: number }>;
      const r = rows[0];
      if (!r || Number(r.total) === 0) return 100; // no bills = nothing overdue
      return Math.round((Number(r.on_time) / Number(r.total)) * 100);
    } catch {
      return 0;
    }
  }

  private async loadConfig<T>(
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
    },
    key: string,
    defaults: T,
  ): Promise<T> {
    try {
      const rows = (await client.$queryRawUnsafe(
        `SELECT config_value FROM school_config WHERE config_key = $1 LIMIT 1`,
        key,
      )) as Array<{ config_value: unknown }>;
      if (rows.length === 0) return defaults;
      const raw = rows[0]!.config_value;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === 'object') {
        return { ...defaults, ...(parsed as object) };
      }
      return defaults;
    } catch {
      return defaults;
    }
  }
}
