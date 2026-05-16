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
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
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
import { OutboxService } from '../kafka/outbox.service';
import { RedisService } from '../notifications/redis.service';

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
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE} ORDER BY s.scheduled_at ASC`,
      )) as ScheduledRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  async getById(actor: ResolvedActor, id: string): Promise<ScheduledPublicationDto> {
    void actor;
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE} WHERE s.id = $1::uuid LIMIT 1`,
        id,
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
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE} WHERE s.publication_id = $1::uuid AND s.status = 'SCHEDULED' LIMIT 1`,
        publicationId,
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
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      // Validate parent publication status — only APPROVED or DRAFT can
      // be scheduled (PUBLISHED is already out; ARCHIVED is terminal).
      const pubRows = (await client.$queryRawUnsafe(
        'SELECT status FROM pub_publications WHERE id = $1::uuid FOR UPDATE',
        publicationId,
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
      const rows = (await client.$queryRawUnsafe(
        `${SELECT_SCHEDULED_BASE} WHERE s.id = $1::uuid LIMIT 1`,
        id,
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
    return this.tenantPrisma.executeInTenantTransaction(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT id::text AS id, status FROM pub_scheduled_publications
         WHERE publication_id = $1::uuid AND status = 'SCHEDULED'
         FOR UPDATE LIMIT 1`,
        publicationId,
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
        `${SELECT_SCHEDULED_BASE} WHERE s.id = $1::uuid LIMIT 1`,
        id,
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
    await this.assertCanRead(actor, publicationId);
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT publication_id::text AS publication_id,
                total_recipients, total_views, unique_views, total_opens, total_link_clicks, total_bounces,
                avg_read_time_seconds, last_event_at::text AS last_event_at,
                last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics WHERE publication_id = $1::uuid LIMIT 1`,
        publicationId,
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
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        `SELECT publication_id::text AS publication_id,
                total_recipients, total_views, unique_views, total_opens, total_link_clicks, total_bounces,
                avg_read_time_seconds, last_event_at::text AS last_event_at,
                last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics ORDER BY last_event_at DESC NULLS LAST LIMIT 100`,
      )) as AnalyticsRow[];
      return rows.map((r) => this.rowToDto(r));
    });
  }

  // INGEST KEYSTONE — atomic counter increments per event type.
  async ingestEvent(
    publicationId: string,
    input: IngestAnalyticsEventDto,
  ): Promise<PublicationAnalyticsDto> {
    // Upsert a zero-valued row if missing — fixes the "first event arrives
    // before any UI ever read /analytics" race.
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        `INSERT INTO pub_publication_analytics (publication_id) VALUES ($1::uuid)
         ON CONFLICT (publication_id) DO NOTHING`,
        publicationId,
      );
    });

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

    return this.tenantPrisma.executeInTenantContext(async (client) => {
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
      const rows = (await client.$queryRawUnsafe(
        `SELECT publication_id::text AS publication_id,
                total_recipients, total_views, unique_views, total_opens, total_link_clicks, total_bounces,
                avg_read_time_seconds, last_event_at::text AS last_event_at,
                last_updated_at::text AS last_updated_at
         FROM pub_publication_analytics WHERE publication_id = $1::uuid LIMIT 1`,
        publicationId,
      )) as AnalyticsRow[];
      return this.rowToDto(rows[0]!);
    });
  }

  // Setter for the total_recipients column — called by
  // DistributionService.distribute + ScheduledPublishWorker once the
  // audience is materialised.
  async setRecipientTotal(publicationId: string, total: number): Promise<void> {
    await this.tenantPrisma.executeInTenantContext(async (client) => {
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
      // Use a tenant transaction so the schedule flip + publication
      // update + outbox enqueue commit atomically.
      const ripe = (await client.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.publication_id::text AS publication_id
         FROM pub_scheduled_publications s
         WHERE s.status = 'SCHEDULED' AND s.scheduled_at <= now()
         ORDER BY s.scheduled_at ASC
         LIMIT 50`,
      )) as Array<{ id: string; publication_id: string }>;

      let flipped = 0;
      for (const row of ripe) {
        try {
          await client.$executeRawUnsafe(
            `UPDATE pub_scheduled_publications
             SET status = 'PUBLISHED', published_at = now(), updated_at = now()
             WHERE id = $1::uuid AND status = 'SCHEDULED'`,
            row.id,
          );
          // Look up publication context for the envelope.
          const pubRows = (await client.$queryRawUnsafe(
            `SELECT title, status, series_id::text AS series_id
             FROM pub_publications WHERE id = $1::uuid LIMIT 1`,
            row.publication_id,
          )) as Array<{ title: string; status: string; series_id: string | null }>;
          if (pubRows.length === 0) continue;
          const pub = pubRows[0]!;
          if (pub.status !== 'PUBLISHED') {
            await client.$executeRawUnsafe(
              `UPDATE pub_publications
               SET status = 'PUBLISHED', published_at = now(), updated_at = now()
               WHERE id = $1::uuid`,
              row.publication_id,
            );
            // Auto-create the final STATUS_CHANGE version via the worker
            // path. We replicate the captureForStatusChange shape inline
            // because we cannot inject VersionService into a worker
            // without a circular module dependency.
            const snapshotPayload = await this.composeSnapshot(client, row.publication_id);
            const nextVersionRows = (await client.$queryRawUnsafe(
              `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
               FROM pub_publication_versions WHERE publication_id = $1::uuid`,
              row.publication_id,
            )) as Array<{ next: number }>;
            const nextVersion = Number(nextVersionRows[0]!.next);
            await client.$executeRawUnsafe(
              `INSERT INTO pub_publication_versions
                 (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by)
               VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 'STATUS_CHANGE',
                       'Published by ScheduledPublishWorker',
                       (SELECT scheduled_by FROM pub_scheduled_publications WHERE id = $5::uuid))`,
              generateId(),
              row.publication_id,
              nextVersion,
              JSON.stringify(snapshotPayload),
              row.id,
            );
          }
          // Resolve audience by walking pub_distribution_recipients
          // already populated by the editor's call to
          // POST /publications/:id/distribute prior to scheduling. If
          // none exists yet, just emit with totalRecipients=0.
          const recipientRows = (await client.$queryRawUnsafe(
            `SELECT COUNT(*)::int AS n FROM pub_distribution_recipients WHERE publication_id = $1::uuid`,
            row.publication_id,
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
          // Bump attempts + record last_error — row stays SCHEDULED so the
          // next poll retries.
          await client.$executeRawUnsafe(
            `UPDATE pub_scheduled_publications
             SET worker_attempts = worker_attempts + 1,
                 last_error = $1,
                 updated_at = now()
             WHERE id = $2::uuid AND status = 'SCHEDULED'`,
            msg.slice(0, 500),
            row.id,
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
  ): Promise<Record<string, unknown>> {
    const pubs = (await client.$queryRawUnsafe(
      `SELECT title, status, publication_type, published_at::text AS published_at
       FROM pub_publications WHERE id = $1::uuid LIMIT 1`,
      publicationId,
    )) as Array<{
      title: string;
      status: string;
      publication_type: string;
      published_at: string | null;
    }>;
    if (pubs.length === 0) return {};
    const pub = pubs[0]!;
    const sections = (await client.$queryRawUnsafe(
      `SELECT id::text AS id, title, body, section_type, sort_order, is_approved
       FROM pub_sections WHERE publication_id = $1::uuid ORDER BY sort_order`,
      publicationId,
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
