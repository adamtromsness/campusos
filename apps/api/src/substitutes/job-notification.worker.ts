import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { OutboxService } from '../kafka/outbox.service';
import { generateId } from '@campusos/database';

/**
 * JobNotificationWorker — P2-9b Step 6.
 *
 * Tier-2 MARKETPLACE escalation worker. Polls sub_job_postings WHERE
 * escalate_to_marketplace_at <= now() AND status='OPEN' AND
 * notification_tier='POOL' AND no notification with response='ACCEPTED'.
 *
 * On each matching job:
 *   - Flip notification_tier='MARKETPLACE'.
 *   - Find candidate substitutes via the matching engine criteria:
 *     - grade_levels overlap (when job.grade_level is set, match against
 *       substitute profile grade_levels array).
 *     - Active profile + isAvailable=true.
 *     - Not already notified for this job (excluded via partial UNIQUE).
 *     - Not BLOCKED this school in platform_sub_preferences.
 *     - Available on job_date (BLOCKED-overrides-RECURRING resolver).
 *     - At least one VERIFIED credential.
 *   - INSERT sub_job_notifications rows (tier=MARKETPLACE,
 *     acceptance_window_expires_at = now() + acceptance_window_minutes).
 *
 * Emits sub.job.escalated for downstream notification fan-out.
 *
 * Configurable via env:
 *   SUB_NOTIFICATION_DISABLED=1            fully disable
 *   SUB_NOTIFICATION_INTERVAL_MS           poll interval (default 60s)
 *   SUB_NOTIFICATION_WARMUP_MS             first-tick delay (default 30s)
 */
@Injectable()
export class JobNotificationWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(JobNotificationWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit(): void {
    if (process.env.SUB_NOTIFICATION_DISABLED === '1') {
      this.logger.log('JobNotificationWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.SUB_NOTIFICATION_INTERVAL_MS || 60_000);
    const warmup = Number(process.env.SUB_NOTIFICATION_WARMUP_MS || 30_000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('job-notification tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('job-notification tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'JobNotificationWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip job-notification tick — previous still running');
      return;
    }
    this.running = true;
    try {
      const schools = await this.loadActiveSchools();
      for (const school of schools) {
        await this.tickForTenant(school);
      }
    } finally {
      this.running = false;
    }
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      const client = this.tenantPrisma.getPlatformClient();
      const rows = (await client.$queryRawUnsafe(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      )) as Array<{
        id: string;
        subdomain: string;
        schema_name: string;
        organisation_id: string | null;
      }>;
      return rows.map((r) => ({
        schoolId: r.id,
        subdomain: r.subdomain,
        schemaName: r.schema_name,
        organisationId: r.organisation_id,
        isFrozen: false,
        planTier: 'STANDARD' as const,
        homeRegion: process.env.AWS_REGION ?? 'us-east-1',
      }));
    } catch (e: unknown) {
      this.logger.warn(
        'job-notification: could not load schools: ' + ((e as Error)?.message || String(e)),
      );
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      await runWithTenantContextAsync({ tenant }, async () => {
        // Find jobs ripe for marketplace escalation
        const ripeJobs = await this.tenantPrisma.executeInTenantContext(async (client) => {
          return (await client.$queryRawUnsafe(
            `SELECT id::text AS id, school_id::text AS school_id,
                    grade_level, subject, job_date::text AS job_date,
                    acceptance_window_minutes
             FROM sub_job_postings j
             WHERE escalate_to_marketplace_at IS NOT NULL
               AND escalate_to_marketplace_at <= now()
               AND status = 'OPEN'
               AND notification_tier = 'POOL'
               AND NOT EXISTS (
                 SELECT 1 FROM sub_job_notifications n
                 WHERE n.job_id = j.id AND n.response = 'ACCEPTED'
               )
             LIMIT 25`,
          )) as Array<{
            id: string;
            school_id: string;
            grade_level: string | null;
            subject: string | null;
            job_date: string;
            acceptance_window_minutes: number;
          }>;
        });

        for (const job of ripeJobs) {
          await this.escalateJob(tenant, job);
        }
      });
    } catch (e: unknown) {
      this.logger.warn(
        'job-notification: tenant tick failed for ' +
          tenant.subdomain +
          ': ' +
          ((e as Error)?.stack || (e as Error)?.message || String(e)),
      );
    }
  }

  private async escalateJob(
    tenant: TenantInfo,
    job: {
      id: string;
      school_id: string;
      grade_level: string | null;
      subject: string | null;
      job_date: string;
      acceptance_window_minutes: number;
    },
  ): Promise<void> {
    const platform = this.tenantPrisma.getPlatformClient();

    // Build the candidate query against the platform schema.
    const params: unknown[] = [job.school_id, job.job_date];
    let sql = `
      SELECT p.id::text AS substitute_id
      FROM platform.platform_substitute_profiles p
      WHERE p.is_active = true AND p.is_available = true
        AND NOT EXISTS (
          SELECT 1 FROM platform.platform_sub_preferences pref
          WHERE pref.substitute_id = p.id AND pref.school_id = $1::uuid
            AND pref.preference_type = 'BLOCKED'
        )
        AND EXISTS (
          SELECT 1 FROM platform.platform_sub_credentials c
          WHERE c.substitute_id = p.id AND c.verification_status = 'VERIFIED'
        )
        AND (
          EXISTS (
            SELECT 1 FROM platform.platform_sub_availability a
            WHERE a.substitute_id = p.id AND a.availability_type = 'RECURRING'
              AND a.day_of_week = EXTRACT(DOW FROM $2::date)::int
          )
          OR EXISTS (
            SELECT 1 FROM platform.platform_sub_availability a
            WHERE a.substitute_id = p.id AND a.availability_type = 'SPECIFIC'
              AND a.specific_date = $2::date
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM platform.platform_sub_availability a
          WHERE a.substitute_id = p.id AND a.availability_type = 'BLOCKED'
            AND a.specific_date = $2::date
        )`;

    if (job.grade_level) {
      sql += ` AND p.grade_levels && ARRAY[$3]::text[]`;
      params.push(job.grade_level);
    }

    const candidates = (await platform.$queryRawUnsafe(sql, ...params)) as Array<{
      substitute_id: string;
    }>;

    if (candidates.length === 0) {
      // No candidates — still flip the tier so we don't keep re-polling.
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE sub_job_postings
           SET notification_tier = 'MARKETPLACE', updated_at = now()
           WHERE id = $1::uuid`,
          job.id,
        );
      });
      this.logger.log(
        'job-notification: tenant=' +
          tenant.subdomain +
          ' job=' +
          job.id +
          ' escalated to MARKETPLACE with 0 candidates',
      );
      return;
    }

    const notifiedAt = new Date();
    const expiresAt = new Date(notifiedAt.getTime() + job.acceptance_window_minutes * 60 * 1000);

    let insertedCount = 0;
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      for (const c of candidates) {
        const result = (await tx.$queryRawUnsafe(
          `INSERT INTO sub_job_notifications (id, job_id, substitute_id, notification_tier, notified_at, acceptance_window_expires_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'MARKETPLACE', $4::timestamptz, $5::timestamptz)
           ON CONFLICT (job_id, substitute_id) DO NOTHING
           RETURNING id`,
          generateId(),
          job.id,
          c.substitute_id,
          notifiedAt.toISOString(),
          expiresAt.toISOString(),
        )) as Array<{ id: string }>;
        if (result.length > 0) insertedCount++;
      }

      // Flip tier on the job
      await tx.$executeRawUnsafe(
        `UPDATE sub_job_postings
         SET notification_tier = 'MARKETPLACE', updated_at = now()
         WHERE id = $1::uuid`,
        job.id,
      );

      // Emit sub.job.escalated for downstream
      await this.outbox.enqueueInTx(tx as never, {
        topic: 'sub.job.escalated',
        key: job.id,
        sourceModule: 'substitutes',
        payload: {
          jobId: job.id,
          schoolId: job.school_id,
          fromTier: 'POOL',
          toTier: 'MARKETPLACE',
          newNotifications: insertedCount,
          totalCandidates: candidates.length,
          escalatedAt: notifiedAt.toISOString(),
        },
      });
    });

    this.logger.log(
      'job-notification: tenant=' +
        tenant.subdomain +
        ' job=' +
        job.id +
        ' escalated POOL -> MARKETPLACE (' +
        insertedCount +
        ' new notifications across ' +
        candidates.length +
        ' candidates)',
    );
  }
}
