import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { generateId, getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant';
import { getCurrentTenant } from '@shared/tenant';
import type { ResolvedActor } from '@modules/m00-platform';
import { PermissionCheckService } from '@modules/m00-platform';
import { canEditPublication, isUniqueViolation } from './access';
import { deterministicPublicationPublishedEventId } from './event-ids';
import type {
  AnalyticsEventType,
  CancelScheduledPublicationDto,
  CreateScheduledPublicationDto,
  IngestAnalyticsEventDto,
  PublicationAnalyticsDto,
  ScheduledPublicationDto,
} from './dto/publications.dto';
import { OutboxService } from '@shared/kafka';
import { RedisService } from '@shared/cache';

interface ScheduledRow {
  id: string;
  publication_id: string;
  publication_title: string | null;
  scheduled_at: string;
  timezone: string;
  status: 'SCHEDULED' | 'PUBLISHED' | 'CANCELLED';
  scheduled_by: string;
  scheduled_by_name: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  published_at: string | null;
  worker_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SCHEDULED_BASE = `
  SELECT
    s.id::text AS id,
    s.publication_id::text AS publication_id,
    (SELECT p.title FROM pub_publications p WHERE p.id = s.publication_id LIMIT 1) AS publication_title,
    s.scheduled_at::text AS scheduled_at,
    s.timezone,
    s.status,
    s.scheduled_by::text AS scheduled_by,
    (SELECT pu.email FROM platform.platform_users pu WHERE pu.id = s.scheduled_by LIMIT 1) AS scheduled_by_name,
    s.cancelled_at::text AS cancelled_at,
    s.cancelled_by::text AS cancelled_by,
    s.cancellation_reason,
    s.published_at::text AS published_at,
    s.worker_attempts,
    s.last_error,
    s.created_at::text AS created_at,
    s.updated_at::text AS updated_at
  FROM pub_scheduled_publications s
`;

/**
 * ScheduledPublishService — Phase 2 Cycle 26 Step 4.
 *
 * One-to-one with the parent publication via UNIQUE publication_id —
 * a publication carries at most one active schedule. Editors create
 * the schedule, the Step 4 ScheduledPublishWorker fires it when
 * scheduled_at <= now() under the partial INDEX hot path, and the
 * editor can cancel any time before fire.
 */
@Injectable()
export class ScheduledPublishService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissionCheck: PermissionCheckService,
  ) {}

  async list(actor: ResolvedActor): Promise<ScheduledPublicationDto[]> {
    void actor;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B2 — JOIN through pub_publications.school_id so the
      // list cannot leak a foreign-school schedule in a multi-school tenant.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE}
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $1::uuid
         ORDER BY s.scheduled_at ASC`,
        tenant.schoolId,
      )) as ScheduledRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<ScheduledPublicationDto> {
    void actor;
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B2 — forged schedule UUID for a foreign-school
      // publication collapses to 404 (don't-leak-existence).
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE}
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
         WHERE s.id = $1::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      )) as ScheduledRow[];
      if (rows.length === 0) throw new NotFoundException('Schedule not found');
      return this.rowToDto(rows[0]!);
    });
  }

  async getForPublication(
    actor: ResolvedActor,
    publicationId: string,
  ): Promise<ScheduledPublicationDto | null> {
    await this.assertCanAccess(actor, publicationId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B2 — defence-in-depth school predicate.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE}
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
         WHERE s.publication_id = $1::uuid AND s.status = 'SCHEDULED' LIMIT 1`,
        publicationId,
        tenant.schoolId,
      )) as ScheduledRow[];
      return rows.length ? this.rowToDto(rows[0]!) : null;
    });
  }

  async schedule(
    actor: ResolvedActor,
    publicationId: string,
    input: CreateScheduledPublicationDto,
  ): Promise<ScheduledPublicationDto> {
    await this.assertCanAccess(actor, publicationId);
    const scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('scheduledAt must be a valid ISO 8601 timestamp.');
    }
    if (scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be in the future.');
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B2 — lock the publication FOR UPDATE with the
      // school predicate so two concurrent schedules from different schools
      // serialise on row locks and a forged publication id collapses to 404.
      const pubRows = (await client.$queryRawUnsafe(
        'SELECT status FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid FOR UPDATE',
        publicationId,
        tenant.schoolId,
      )) as Array<{ status: string }>;
      if (pubRows.length === 0) throw new NotFoundException('Publication not found');
      const pubStatus = pubRows[0]!.status;
      if (!['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(pubStatus)) {
        throw new BadRequestException(
          `Cannot schedule a publication in status ${pubStatus}. Only DRAFT, IN_REVIEW, or APPROVED publications can be scheduled.`,
        );
      }
      const id = generateId();
      try {
        await client.$executeRawUnsafe(
          `INSERT INTO pub_scheduled_publications
             (id, publication_id, scheduled_at, timezone, status, scheduled_by)
           VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4, 'SCHEDULED', $5::uuid)`,
          id,
          publicationId,
          scheduledAt.toISOString(),
          input.timezone ?? 'America/Chicago',
          actor.accountId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException(
            'This publication already has an active schedule. Cancel it before creating a new one.',
          );
        }
        throw err;
      }
      // REVIEW-P2C26 R-B2 — reload via parent publication school predicate.
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE}
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
         WHERE s.id = $1::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      )) as ScheduledRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  async cancel(
    actor: ResolvedActor,
    publicationId: string,
    input: CancelScheduledPublicationDto,
  ): Promise<ScheduledPublicationDto> {
    await this.assertCanAccess(actor, publicationId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // REVIEW-P2C26 R-B2 — JOIN through the parent publication school
      // predicate when looking up the schedule to lock. Belt-and-braces with
      // the assertCanAccess gate.
      const rows = (await client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.status
         FROM pub_scheduled_publications s
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
         WHERE s.publication_id = $1::uuid AND s.status = 'SCHEDULED'
         FOR UPDATE OF s LIMIT 1`,
        publicationId,
        tenant.schoolId,
      )) as Array<{ id: string; status: string }>;
      if (rows.length === 0) {
        throw new NotFoundException('No active schedule found for this publication.');
      }
      const id = rows[0]!.id;
      await client.$executeRawUnsafe(
        `UPDATE pub_scheduled_publications
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancelled_by = $1::uuid,
             cancellation_reason = $2,
             updated_at = now()
         WHERE id = $3::uuid`,
        actor.accountId,
        input.cancellationReason ?? null,
        id,
      );
      const fresh = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE}
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
         WHERE s.id = $1::uuid LIMIT 1`,
        id,
        tenant.schoolId,
      )) as ScheduledRow[];
      return this.rowToDto(fresh[0]!);
    });
  }

  private async assertCanAccess(actor: ResolvedActor, publicationId: string): Promise<void> {
    const tenant = getCurrentTenant();
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      ),
    )) as Array<unknown>;
    if (exists.length === 0) throw new NotFoundException('Publication not found');
    const ok = await canEditPublication(
      this.tenantPrisma,
      this.permissionCheck,
      actor,
      publicationId,
    );
    if (!ok) {
      throw new ForbiddenException('Only editors and collaborators may schedule this publication.');
    }
  }

  private rowToDto(row: ScheduledRow): ScheduledPublicationDto {
    return {
      id: row.id,
      publicationId: row.publication_id,
      publicationTitle: row.publication_title,
      scheduledAt: row.scheduled_at,
      timezone: row.timezone,
      status: row.status,
      scheduledById: row.scheduled_by,
      scheduledByName: row.scheduled_by_name,
      cancelledAt: row.cancelled_at,
      cancelledById: row.cancelled_by,
      cancellationReason: row.cancellation_reason,
      publishedAt: row.published_at,
      workerAttempts: row.worker_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface AnalyticsRow {
  publication_id: string;
  total_recipients: number;
  total_views: number;
  unique_views: number;
  total_opens: number;
  total_link_clicks: number;
  total_bounces: number;
  avg_read_time_seconds: number | null;
  last_event_at: string | null;
  last_updated_at: string;
}

/**
 * PublicationAnalyticsService — Phase 2 Cycle 26 Step 4.
 *
 * Per-publication engagement counters. Counters are incremented
 * atomically via SQL-level UPDATE ... SET counter = counter + 1 so
 * concurrent events from the Cycle 14 fan-out pipeline cannot lose
 * counts. The Step 6 vertical-slice test exercises the atomic-
 * increment path under 5 parallel POSTs.
 *
 * Unique-view dedup uses a Redis SET notif:pub-views:{publicationId}
 * with 24-hour TTL. ingestEvent VIEW increments unique_views ONLY
 * when SADD returns 1 (member was new) — the SET membership
 * keystone. When Redis is unavailable the unique-view increment
 * degrades to skipping (total_views still increments).
 */
@Injectable()
export class PublicationAnalyticsService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissionCheck: PermissionCheckService,
    private readonly redis: RedisService,
  ) {}

  async get(actor: ResolvedActor, publicationId: string): Promise<PublicationAnalyticsDto> {
    // REVIEW-P2C26 R-B3 — assertCanRead now validates publication ownership
    // BEFORE the admin short-circuit so a school admin can't pull foreign-
    // school analytics by guessing a publication UUID.
    await this.assertCanRead(actor, publicationId);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B3 — JOIN through pub_publications.school_id so the
      // analytics row read also enforces school ownership at the SQL layer.
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.publication_id::text AS publication_id,
                a.total_recipients, a.total_views, a.unique_views, a.total_opens,
                a.total_link_clicks, a.total_bounces,
                a.avg_read_time_seconds, a.last_event_at::text AS last_event_at,
                a.last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics a
         JOIN pub_publications p ON p.id = a.publication_id AND p.school_id = $2::uuid
         WHERE a.publication_id = $1::uuid LIMIT 1`,
        publicationId,
        tenant.schoolId,
      )) as AnalyticsRow[];
      if (rows.length === 0) {
        // Return a zero-valued shell — analytics rows are lazy.
        return this.zero(publicationId);
      }
      return this.rowToDto(rows[0]!);
    });
  }

  async summary(actor: ResolvedActor): Promise<PublicationAnalyticsDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException(
        'Only school admins may read the publication analytics summary.',
      );
    }
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      // REVIEW-P2C26 R-B3 — JOIN through pub_publications.school_id so the
      // summary cannot leak foreign-school publication analytics in a
      // multi-school tenant pool.
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.publication_id::text AS publication_id,
                a.total_recipients, a.total_views, a.unique_views, a.total_opens,
                a.total_link_clicks, a.total_bounces,
                a.avg_read_time_seconds, a.last_event_at::text AS last_event_at,
                a.last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics a
         JOIN pub_publications p ON p.id = a.publication_id AND p.school_id = $1::uuid
         ORDER BY a.last_event_at DESC NULLS LAST LIMIT 100`,
        tenant.schoolId,
      )) as AnalyticsRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  // INGEST KEYSTONE — atomic counter increments per event type, gated by
  // (1) publication-belongs-to-current-school (R-B3) and (2) the
  // contribution ledger for redelivery idempotency (R-B4).
  async ingestEvent(
    actor: ResolvedActor,
    publicationId: string,
    input: IngestAnalyticsEventDto,
  ): Promise<PublicationAnalyticsDto> {
    void actor;
    const tenant = getCurrentTenant();

    // REVIEW-P2C26 R-B3 — publication MUST belong to the current school.
    // Without this, any user with pub-001:read could submit analytics
    // events for foreign-school publication UUIDs.
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      ),
    )) as Array<unknown>;
    if (exists.length === 0) throw new NotFoundException('Publication not found');

    // REVIEW-P2C26 R-B4 — manual-route ingestion (no source_event_id
    // supplied) gets a fresh UUID so each call lands one ledger row.
    // Future Cycle 14 fan-out consumer SHOULD pass the envelope event_id
    // + its consumer group so redelivery short-circuits cleanly.
    const consumerGroup = input.consumerGroup ?? 'MANUAL';
    const sourceEventId = input.sourceEventId ?? generateId();

    let uniqueViewIncrement = 0;
    if (input.eventType === 'VIEW' && input.recipientAccountId) {
      // SADD returns 1 if the member was new — that's our "unique view"
      // signal. Redis TTL on the SET caps memory growth at 24h.
      uniqueViewIncrement = await this.redis.markUniquePublicationView(
        publicationId,
        input.recipientAccountId,
      );
    }

    const colByEvent: Record<AnalyticsEventType, string> = {
      VIEW: 'total_views',
      OPEN: 'total_opens',
      LINK_CLICK: 'total_link_clicks',
      BOUNCE: 'total_bounces',
    };
    const counterCol = colByEvent[input.eventType];

    // REVIEW-P2C26 R-B4 — wrap the ledger INSERT + the counter UPDATE in
    // one tenant tx so a duplicate envelope rolls back the bump on 23505.
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // Upsert a zero-valued analytics row first.
      await client.$executeRawUnsafe(
        `INSERT INTO pub_publication_analytics (publication_id) VALUES ($1::uuid)
         ON CONFLICT (publication_id) DO NOTHING`,
        publicationId,
      );

      // Ledger gate — on duplicate (23505) short-circuit and return the
      // current analytics row without bumping any counters.
      try {
        await client.$executeRawUnsafe(
          `INSERT INTO pub_publication_analytics_contributions
             (id, consumer_group, source_event_id, publication_id, event_type)
           VALUES ($1::uuid, $2, $3, $4::uuid, $5)`,
          generateId(),
          consumerGroup,
          sourceEventId,
          publicationId,
          input.eventType,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Redelivery — return the current analytics row unchanged.
          const cur = (await client.$queryRawUnsafe(
            `SELECT a.publication_id::text AS publication_id,
                    a.total_recipients, a.total_views, a.unique_views, a.total_opens,
                    a.total_link_clicks, a.total_bounces,
                    a.avg_read_time_seconds, a.last_event_at::text AS last_event_at,
                    a.last_updated_at::text AS last_updated_at
             FROM pub_publication_analytics a
             JOIN pub_publications p ON p.id = a.publication_id AND p.school_id = $2::uuid
             WHERE a.publication_id = $1::uuid LIMIT 1`,
            publicationId,
            tenant.schoolId,
          )) as AnalyticsRow[];
          return cur.length > 0 ? this.rowToDto(cur[0]!) : this.zero(publicationId);
        }
        throw err;
      }

      // Atomic counter bump via SQL-level math (no read-then-write race).
      // Plus running-avg update when readTimeSeconds is supplied on VIEW.
      const readTime = input.readTimeSeconds;
      if (input.eventType === 'VIEW' && typeof readTime === 'number') {
        await client.$executeRawUnsafe(
          `UPDATE pub_publication_analytics
           SET ${counterCol} = ${counterCol} + 1,
               unique_views = unique_views + $1,
               avg_read_time_seconds = CASE
                 WHEN avg_read_time_seconds IS NULL THEN $2
                 ELSE ROUND(avg_read_time_seconds + (($2 - avg_read_time_seconds)::numeric / GREATEST(${counterCol} + 1, 1)))::int
               END,
               last_event_at = now(),
               last_updated_at = now()
           WHERE publication_id = $3::uuid`,
          uniqueViewIncrement,
          readTime,
          publicationId,
        );
      } else {
        await client.$executeRawUnsafe(
          `UPDATE pub_publication_analytics
           SET ${counterCol} = ${counterCol} + 1,
               unique_views = unique_views + $1,
               last_event_at = now(),
               last_updated_at = now()
           WHERE publication_id = $2::uuid`,
          uniqueViewIncrement,
          publicationId,
        );
      }
      // REVIEW-P2C26 R-B3 — reload via parent publication school predicate.
      const rows = (await client.$queryRawUnsafe(
        `SELECT a.publication_id::text AS publication_id,
                a.total_recipients, a.total_views, a.unique_views, a.total_opens,
                a.total_link_clicks, a.total_bounces,
                a.avg_read_time_seconds, a.last_event_at::text AS last_event_at,
                a.last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics a
         JOIN pub_publications p ON p.id = a.publication_id AND p.school_id = $2::uuid
         WHERE a.publication_id = $1::uuid LIMIT 1`,
        publicationId,
        tenant.schoolId,
      )) as AnalyticsRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  // Setter for the total_recipients column — called by
  // DistributionService.distribute + ScheduledPublishWorker once the
  // audience is materialised. REVIEW-P2C26 R-B3 — carries school predicate
  // through the parent publication to refuse cross-school writes.
  async setRecipientTotal(publicationId: string, total: number): Promise<void> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const exists = (await client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      )) as Array<unknown>;
      if (exists.length === 0) throw new NotFoundException('Publication not found');
      await client.$executeRawUnsafe(
        `INSERT INTO pub_publication_analytics (publication_id, total_recipients)
         VALUES ($1::uuid, $2)
         ON CONFLICT (publication_id) DO UPDATE
         SET total_recipients = EXCLUDED.total_recipients, last_updated_at = now()`,
        publicationId,
        total,
      );
    });
  }

  private async assertCanRead(actor: ResolvedActor, publicationId: string): Promise<void> {
    // REVIEW-P2C26 R-B3 — validate publication ownership BEFORE the admin
    // short-circuit. A school admin holds the gate-tier permission but the
    // actual access boundary is the publication's school ownership. Without
    // this check, a forged publication UUID would let an admin pull foreign-
    // school analytics.
    const tenant = getCurrentTenant();
    const exists = (await this.tenantPrisma.executeInTenantContext(async (client) =>
      client.$queryRawUnsafe(
        'SELECT 1 FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1',
        publicationId,
        tenant.schoolId,
      ),
    )) as Array<unknown>;
    if (exists.length === 0) throw new NotFoundException('Publication not found');
    if (actor.isSchoolAdmin) return;
    const ok = await canEditPublication(
      this.tenantPrisma,
      this.permissionCheck,
      actor,
      publicationId,
    );
    if (!ok) {
      throw new ForbiddenException(
        'Only editors, collaborators, and school admins may read publication analytics.',
      );
    }
  }

  private zero(publicationId: string): PublicationAnalyticsDto {
    return {
      publicationId,
      totalRecipients: 0,
      totalViews: 0,
      uniqueViews: 0,
      totalOpens: 0,
      totalLinkClicks: 0,
      totalBounces: 0,
      avgReadTimeSeconds: null,
      lastEventAt: null,
      lastUpdatedAt: new Date(0).toISOString(),
    };
  }

  private rowToDto(row: AnalyticsRow): PublicationAnalyticsDto {
    return {
      publicationId: row.publication_id,
      totalRecipients: Number(row.total_recipients),
      totalViews: Number(row.total_views),
      uniqueViews: Number(row.unique_views),
      totalOpens: Number(row.total_opens),
      totalLinkClicks: Number(row.total_link_clicks),
      totalBounces: Number(row.total_bounces),
      avgReadTimeSeconds:
        row.avg_read_time_seconds !== null ? Number(row.avg_read_time_seconds) : null,
      lastEventAt: row.last_event_at,
      lastUpdatedAt: row.last_updated_at,
    };
  }
}

/**
 * ScheduledPublishWorker — Phase 2 Cycle 26 Step 4.
 *
 * Polls every minute. Per active school:
 *   UPDATE pub_scheduled_publications
 *   SET status='PUBLISHED', published_at=now(), updated_at=now()
 *   WHERE status='SCHEDULED' AND scheduled_at <= now()
 *   RETURNING id, publication_id
 *
 * For each flipped row, flips the parent publication to PUBLISHED if
 * not already there (re-using the multi-column lockstep that
 * DistributionService.distribute uses) and enqueues
 * pub.publication.published to the platform outbox INSIDE the same
 * transaction. The deterministic event_id is keyed on publicationId
 * so a redelivery from this worker AND from the existing
 * DistributionService.distribute path produce the same envelope.
 *
 * The auto-version hook on PublicationService.patchStatus fires
 * naturally because the worker calls UPDATE on the parent
 * publication via the canonical path.
 *
 * Best-effort per tenant. An exception in one tenant doesn't abort
 * the rest.
 *
 * Run cadence: every minute by default. Configurable via
 * PUB_SCHEDULED_PUBLISH_INTERVAL_MS env var.
 */
@Injectable()
export class ScheduledPublishWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledPublishWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {
    this.intervalMs = Number(process.env.PUB_SCHEDULED_PUBLISH_INTERVAL_MS) || 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('ScheduledPublishWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'ScheduledPublishWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 1000) +
        ' seconds',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ tenantsScanned: number; rowsFlipped: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({
      where: { isActive: true },
    });
    let totalFlipped = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const flipped = await this.tickForSchool(school.schemaName, school.id, school.subdomain);
        totalFlipped += flipped;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('ScheduledPublishWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsFlipped: totalFlipped };
  }

  async tickForSchool(schemaName: string, schoolId: string, subdomain: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      // REVIEW-P2C26 R-B2 — JOIN through pub_publications.school_id so the
      // worker only sees schedules whose parent publication belongs to the
      // tenant context this pass is running in. In a multi-school tenant
      // pool, the School A pass cannot pick up School B's ripe schedules.
      const ripe = (await client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.publication_id::text AS publication_id
         FROM pub_scheduled_publications s
         JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $1::uuid
         WHERE s.status = 'SCHEDULED' AND s.scheduled_at <= now()
         ORDER BY s.scheduled_at ASC
         LIMIT 50`,
        schoolId,
      )) as Array<{ id: string; publication_id: string }>;

      let flipped = 0;
      for (const row of ripe) {
        try {
          // REVIEW-P2C26 R-B2 — schedule UPDATE carries school predicate
          // through the publication JOIN (defence-in-depth alongside the
          // ripe query's school filter).
          await client.$executeRawUnsafe(
            `UPDATE pub_scheduled_publications s
             SET status = 'PUBLISHED', published_at = now(), updated_at = now()
             FROM pub_publications p
             WHERE s.id = $1::uuid AND s.status = 'SCHEDULED'
               AND p.id = s.publication_id AND p.school_id = $2::uuid`,
            row.id,
            schoolId,
          );
          // Look up publication context for the envelope. School predicate
          // ensures foreign-school publication ids cannot leak into the
          // envelope payload.
          const pubRows = (await client.$queryRawUnsafe(
            `SELECT title, status, series_id::text AS series_id
             FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
            row.publication_id,
            schoolId,
          )) as Array<{ title: string; status: string; series_id: string | null }>;
          if (pubRows.length === 0) continue;
          const pub = pubRows[0]!;
          if (pub.status !== 'PUBLISHED') {
            // REVIEW-P2C26 R-B2 — publication UPDATE carries the school
            // predicate so a forged publication id in the ripe row cannot
            // flip a foreign-school publication to PUBLISHED.
            await client.$executeRawUnsafe(
              `UPDATE pub_publications
               SET status = 'PUBLISHED', published_at = now(), updated_at = now()
               WHERE id = $1::uuid AND school_id = $2::uuid`,
              row.publication_id,
              schoolId,
            );
            // REVIEW-P2C26 R-M2 — auto-create the final STATUS_CHANGE
            // version inline because the worker writes the publication
            // UPDATE via raw SQL (not via PublicationService.patchStatus)
            // to avoid pulling the request-path service + its setter-wired
            // VersionService dependency into a background worker. Inline
            // INSERT mirrors VersionService.captureInTx + carries the
            // school predicate through the parent publication JOIN.
            const snapshotPayload = await this.composeSnapshot(
              client,
              row.publication_id,
              schoolId,
            );
            const nextVersionRows = (await client.$queryRawUnsafe(
              `SELECT COALESCE(MAX(v.version_number), 0) + 1 AS next
               FROM pub_publication_versions v
               JOIN pub_publications p ON p.id = v.publication_id AND p.school_id = $2::uuid
               WHERE v.publication_id = $1::uuid`,
              row.publication_id,
              schoolId,
            )) as Array<{ next: number }>;
            const nextVersion = Number(nextVersionRows[0]!.next);
            await client.$executeRawUnsafe(
              `INSERT INTO pub_publication_versions
                 (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by)
               VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'STATUS_CHANGE',
                       'Published by ScheduledPublishWorker',
                       (SELECT s.scheduled_by FROM pub_scheduled_publications s
                          JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $6::uuid
                          WHERE s.id = $5::uuid))`,
              generateId(),
              row.publication_id,
              nextVersion,
              JSON.stringify(snapshotPayload),
              row.id,
              schoolId,
            );
          }
          // REVIEW-P2C26 R-B2 — recipient count via parent publication
          // JOIN so the totalRecipients on the wire reflects only the
          // current school's audience materialisation.
          const recipientRows = (await client.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n
             FROM pub_distribution_recipients r
             JOIN pub_publications p ON p.id = r.publication_id AND p.school_id = $2::uuid
             WHERE r.publication_id = $1::uuid`,
            row.publication_id,
            schoolId,
          )) as Array<{ n: number }>;
          await this.outbox.enqueueInTx(client, {
            topic: 'pub.publication.published',
            payload: {
              publicationId: row.publication_id,
              sourceRefId: row.publication_id,
              schoolId,
              title: pub.title,
              seriesId: pub.series_id,
              totalRecipients: Number(recipientRows[0]!.n),
              publishedById: null,
              publishedAt: new Date().toISOString(),
              triggeredBy: 'SCHEDULED_PUBLISH_WORKER',
            },
            sourceModule: 'publications',
            eventId: deterministicPublicationPublishedEventId(row.publication_id),
            tenantId: schoolId,
            tenantSubdomain: subdomain,
            key: row.publication_id,
          });
          flipped += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `ScheduledPublishWorker failed for schedule ${row.id} in ${schemaName}: ${msg}`,
          );
          // REVIEW-P2C26 R-B2 — failure-attempt UPDATE also carries the
          // school predicate via the publication JOIN so a worker error
          // doesn't bump a foreign-school schedule's attempts counter.
          await client.$executeRawUnsafe(
            `UPDATE pub_scheduled_publications s
             SET worker_attempts = s.worker_attempts + 1,
                 last_error = $1,
                 updated_at = now()
             FROM pub_publications p
             WHERE s.id = $2::uuid AND s.status = 'SCHEDULED'
               AND p.id = s.publication_id AND p.school_id = $3::uuid`,
            msg.slice(0, 500),
            row.id,
            schoolId,
          );
        }
      }
      if (flipped > 0) {
        this.logger.log(
          'ScheduledPublishWorker flipped ' +
            flipped +
            ' publication(s) to PUBLISHED in ' +
            schemaName,
        );
      }
      return flipped;
    });
  }

  private async composeSnapshot(
    client: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    publicationId: string,
    schoolId: string,
  ): Promise<Record<string, unknown>> {
    // REVIEW-P2C26 R-B2 — worker snapshot composer carries the school
    // predicate through both reads (matches the request-path
    // VersionService.composeSnapshot shape).
    const pubs = (await client.$queryRawUnsafe(
      `SELECT title, status, publication_type, published_at::text AS published_at
       FROM pub_publications WHERE id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
      publicationId,
      schoolId,
    )) as Array<{
      title: string;
      status: string;
      publication_type: string;
      published_at: string | null;
    }>;
    if (pubs.length === 0) return {};
    const pub = pubs[0]!;
    const sections = (await client.$queryRawUnsafe(
      `SELECT s.id::text AS id, s.title, s.body, s.section_type, s.sort_order, s.is_approved
       FROM pub_sections s
       JOIN pub_publications p ON p.id = s.publication_id AND p.school_id = $2::uuid
       WHERE s.publication_id = $1::uuid ORDER BY s.sort_order`,
      publicationId,
      schoolId,
    )) as Array<{
      id: string;
      title: string;
      body: string | null;
      section_type: string;
      sort_order: number;
      is_approved: boolean;
    }>;
    return {
      title: pub.title,
      status: pub.status,
      publicationType: pub.publication_type,
      publishedAt: pub.published_at,
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        body: s.body,
        sectionType: s.section_type,
        sortOrder: s.sort_order,
        isApproved: s.is_approved,
      })),
    };
  }
}
