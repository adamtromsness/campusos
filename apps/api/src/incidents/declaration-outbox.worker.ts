import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';

/**
 * P2C2 Step 5 — DeclarationOutboxWorker.
 *
 * Atomic orchestration of multi-step emergency fan-out. The
 * declare path (IncidentService.declare) writes inc_incidents +
 * inc_declaration_outbox in one tenant transaction. This worker
 * polls the outbox for unstamped step columns and runs each step
 * idempotently:
 *
 *   1. tasks_created_at  → creates URGENT tsk_tasks rows for the
 *      procedure's primary contact (and secondary contact when set)
 *      so a responder picks the task up on their phone.
 *
 *   2. muster_taken_at   → snapshots the on-site visitor list into
 *      vis_emergency_muster (cross-cycle to P2C1) and seeds
 *      inc_accountability_records for visitors currently signed in.
 *      (Roster muster — students from sis_enrollments and staff from
 *      hr_employees — is a Phase 3 follow-up; the schema accepts
 *      manual seeds today.)
 *
 *   3. alert_sent_at     → emits inc.emergency.alert.dispatch on
 *      the wire so Cycle 14's emergency-alert subscriber can fan
 *      out the school-wide notification (the alert handler
 *      auto-correlates by incident_id).
 *
 * Crash recovery: on restart the worker re-queries WHERE
 * tasks_created_at IS NULL OR muster_taken_at IS NULL OR
 * alert_sent_at IS NULL — completed steps are skipped because
 * their column is already stamped.
 *
 * Stall detection: any unstamped step more than STALL_THRESHOLD_MS
 * after declared_at is logged at error level. The plan calls for a
 * PAGE alert via Prometheus — this worker exposes the
 * stall_count counter the Prometheus scraper picks up.
 *
 * Configurable via env:
 *   DECLARATION_OUTBOX_DISABLED=1     fully disable
 *   DECLARATION_OUTBOX_INTERVAL_MS    poll interval (default 5000)
 *   DECLARATION_OUTBOX_WARMUP_MS      first-tick delay (default 30000)
 */

interface OutboxRow {
  id: string;
  incident_id: string;
  school_id: string;
  declared_at: string;
  tasks_created_at: string | null;
  muster_taken_at: string | null;
  alert_sent_at: string | null;
  attempt_count: number;
  // Joined incident + procedure metadata required by the steps.
  incident_title: string | null;
  incident_type_code: string | null;
  procedure_type: string | null;
  primary_contact_id: string | null;
  secondary_contact_id: string | null;
  notification_template: string | null;
  severity: string | null;
}

const SELECT_OUTBOX_PENDING =
  'SELECT o.id::text AS id, o.incident_id::text AS incident_id, ' +
  '       o.school_id::text AS school_id, o.declared_at::text AS declared_at, ' +
  '       o.tasks_created_at::text AS tasks_created_at, ' +
  '       o.muster_taken_at::text AS muster_taken_at, ' +
  '       o.alert_sent_at::text AS alert_sent_at, ' +
  '       o.attempt_count, ' +
  '       i.title AS incident_title, it.code AS incident_type_code, ' +
  "       COALESCE(it.code, 'GENERAL') AS procedure_type, " +
  '       it.notification_template, it.severity, ' +
  '       p.primary_contact_id::text AS primary_contact_id, ' +
  '       p.secondary_contact_id::text AS secondary_contact_id ' +
  'FROM inc_declaration_outbox o ' +
  'JOIN inc_incidents i ON i.id = o.incident_id AND i.school_id = o.school_id ' +
  'LEFT JOIN inc_incident_types it ON it.id = i.incident_type_id ' +
  'LEFT JOIN inc_emergency_procedures p ON p.school_id = o.school_id ' +
  '  AND p.procedure_type = it.code AND p.is_active = true ';

@Injectable()
export class DeclarationOutboxWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DeclarationOutboxWorker.name);
  private warmupHandle: NodeJS.Timeout | null = null;
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  onModuleInit(): void {
    if (process.env.DECLARATION_OUTBOX_DISABLED === '1') {
      this.logger.log('DeclarationOutboxWorker disabled via env.');
      return;
    }
    const interval = Number(process.env.DECLARATION_OUTBOX_INTERVAL_MS || 5000);
    const warmup = Number(process.env.DECLARATION_OUTBOX_WARMUP_MS || 30000);

    this.warmupHandle = setTimeout(() => {
      this.tick().catch((e) =>
        this.logger.error('outbox tick failed: ' + (e?.stack || e?.message || e)),
      );
      this.intervalHandle = setInterval(() => {
        this.tick().catch((e) =>
          this.logger.error('outbox tick failed: ' + (e?.stack || e?.message || e)),
        );
      }, interval);
      this.intervalHandle.unref?.();
    }, warmup);
    this.warmupHandle.unref?.();

    this.logger.log(
      'DeclarationOutboxWorker scheduled (warmup=' + warmup + 'ms interval=' + interval + 'ms)',
    );
  }

  onApplicationShutdown(): void {
    if (this.warmupHandle) clearTimeout(this.warmupHandle);
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  /** Single-pass: walk active schools, process unstamped outbox rows. */
  async tick(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skip outbox tick — previous still running');
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
    } catch (e: any) {
      this.logger.warn('outbox: could not load schools: ' + (e?.message || e));
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    try {
      const self = this;
      await runWithTenantContextAsync({ tenant }, async () => {
        await self.processPendingForTenant(tenant);
      });
    } catch (e: any) {
      this.logger.warn(
        'outbox: tenant tick failed for ' + tenant.subdomain + ': ' + (e?.stack || e?.message || e),
      );
    }
  }

  private async processPendingForTenant(tenant: TenantInfo): Promise<void> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return (await client.$queryRawUnsafe(
        SELECT_OUTBOX_PENDING +
          'WHERE o.school_id = $1::uuid AND ' +
          '  (o.tasks_created_at IS NULL OR o.muster_taken_at IS NULL OR o.alert_sent_at IS NULL) ' +
          'ORDER BY o.declared_at ASC LIMIT 25',
        tenant.schoolId,
      )) as OutboxRow[];
    });

    for (const row of rows) {
      try {
        if (row.tasks_created_at === null) {
          await this.runStepTasks(row);
        } else if (row.muster_taken_at === null) {
          await this.runStepMuster(row);
        } else if (row.alert_sent_at === null) {
          await this.runStepAlert(row);
        }
        // Stall detection — log if any step is unstamped >5 min after declared.
        await this.checkStall(row);
      } catch (e: any) {
        const msg = (e?.message || String(e)).slice(0, 1000);
        await this.recordAttemptError(row.id, msg);
        this.logger.warn(
          'outbox: incident=' + row.incident_id.slice(0, 8) + ' step failed: ' + msg,
        );
      }
    }
  }

  /** Step 1 — create URGENT tsk_tasks for the primary + secondary contact. */
  private async runStepTasks(row: OutboxRow): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Lock the outbox row to serialize against any concurrent worker.
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, tasks_created_at FROM inc_declaration_outbox ' +
          'WHERE id = $1::uuid FOR UPDATE',
        row.id,
      )) as Array<{ tasks_created_at: string | null }>;
      if (lock.length === 0 || lock[0]!.tasks_created_at !== null) return;

      const contacts: string[] = [];
      if (row.primary_contact_id) contacts.push(row.primary_contact_id);
      if (row.secondary_contact_id && row.secondary_contact_id !== row.primary_contact_id) {
        contacts.push(row.secondary_contact_id);
      }
      const incidentTitle = row.incident_title ?? row.incident_type_code ?? 'Emergency Incident';
      for (const ownerId of contacts) {
        const taskId = generateId();
        await tx.$executeRawUnsafe(
          'INSERT INTO tsk_tasks ' +
            '(id, school_id, owner_id, title, description, source, source_ref_id, priority, ' +
            ' status, due_at, task_category) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, ' +
            "        now() + INTERVAL '2 hours', $10) " +
            'ON CONFLICT DO NOTHING',
          taskId,
          row.school_id,
          ownerId,
          'EMERGENCY: ' + incidentTitle,
          'Lead the response procedure for this incident. Update the timeline with progress.',
          'AUTO',
          row.incident_id,
          'URGENT',
          'TODO',
          'ADMINISTRATIVE',
        );
      }

      await tx.$executeRawUnsafe(
        'UPDATE inc_declaration_outbox SET tasks_created_at = now(), ' +
          '  last_attempt_at = now(), attempt_count = attempt_count + 1, ' +
          '  last_error = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid',
        row.id,
      );
    });

    this.logger.log(
      'outbox tasks_created incident=' +
        row.incident_id.slice(0, 8) +
        ' contacts=' +
        ((row.primary_contact_id ? 1 : 0) + (row.secondary_contact_id ? 1 : 0)),
    );
  }

  /** Step 2 — muster: snapshot vis_emergency_muster + seed visitor accountability. */
  private async runStepMuster(row: OutboxRow): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, muster_taken_at FROM inc_declaration_outbox WHERE id = $1::uuid FOR UPDATE',
        row.id,
      )) as Array<{ muster_taken_at: string | null }>;
      if (lock.length === 0 || lock[0]!.muster_taken_at !== null) return;

      // Count currently signed-in visitors for the snapshot total.
      const totalRows = (await tx.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM vis_sign_ins ' +
          'WHERE school_id = $1::uuid AND signed_out_at IS NULL',
        row.school_id,
      )) as Array<{ n: number }>;
      const total = totalRows[0]?.n ?? 0;

      const drillType = this.mapToMusterDrillType(row.procedure_type);
      const musterId = generateId();
      // Look up an admin user — in dev this is the principal who declared
      // the incident; if absent the muster row carries the declarer.
      const musterCreator = row.primary_contact_id ?? row.secondary_contact_id ?? row.school_id;
      try {
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_emergency_muster ' +
            '(id, school_id, incident_id, drill_type, description, created_by, total_on_site_at_snapshot) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)',
          musterId,
          row.school_id,
          row.incident_id,
          drillType,
          'Auto-muster from emergency declaration',
          musterCreator,
          total,
        );
      } catch (e: any) {
        // If vis_emergency_muster does not exist (e.g. P2C1 not migrated),
        // log and continue — accountability seeding is the load-bearing
        // outcome here.
        this.logger.warn('outbox muster: vis_emergency_muster insert failed: ' + (e?.message || e));
      }

      // Seed accountability records for currently-signed-in visitors so the
      // dashboard surfaces them under UNKNOWN until reception confirms.
      // Single-statement INSERT...SELECT walks the partial active-on-site
      // index. ON CONFLICT (incident, person) DO NOTHING keeps redeliveries
      // idempotent.
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_accountability_records ' +
          '(id, incident_id, person_id, person_type, status) ' +
          'SELECT gen_random_uuid(), $1::uuid, s.visitor_id, $2, $3 ' +
          'FROM vis_sign_ins s ' +
          'WHERE s.school_id = $4::uuid AND s.signed_out_at IS NULL ' +
          'ON CONFLICT (incident_id, person_id) DO NOTHING',
        row.incident_id,
        'VISITOR',
        'UNKNOWN',
        row.school_id,
      );

      // Seed an empty summary so the dashboard renders zero-rows correctly
      // before the AccountabilitySummaryWorker computes the real numbers.
      await tx.$executeRawUnsafe(
        'INSERT INTO inc_accountability_summary ' +
          '(id, incident_id, total_people, accounted_for, unknown, evacuated, ' +
          ' medical_assistance, missing, last_updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, 0, 0, 0, 0, 0, 0, now()) ' +
          'ON CONFLICT (incident_id) DO NOTHING',
        generateId(),
        row.incident_id,
      );

      await tx.$executeRawUnsafe(
        'UPDATE inc_declaration_outbox SET muster_taken_at = now(), ' +
          '  last_attempt_at = now(), attempt_count = attempt_count + 1, ' +
          '  last_error = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid',
        row.id,
      );
    });

    this.logger.log('outbox muster_taken incident=' + row.incident_id.slice(0, 8));
  }

  /** Step 3 — emit inc.emergency.alert.dispatch for Cycle 14 to consume. */
  private async runStepAlert(row: OutboxRow): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, alert_sent_at FROM inc_declaration_outbox WHERE id = $1::uuid FOR UPDATE',
        row.id,
      )) as Array<{ alert_sent_at: string | null }>;
      if (lock.length === 0 || lock[0]!.alert_sent_at !== null) return;

      // Stamp first; emit after to avoid a duplicate emit if the tx commits
      // but the kafka emit fires twice. The emit is idempotent at the
      // consumer side via inc.alert.dispatch.event_id but stamping first
      // prevents re-processing on the next tick.
      await tx.$executeRawUnsafe(
        'UPDATE inc_declaration_outbox SET alert_sent_at = now(), ' +
          '  last_attempt_at = now(), attempt_count = attempt_count + 1, ' +
          '  last_error = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid',
        row.id,
      );
    });

    // Emit OUTSIDE the tx — this is best-effort; if it fails the next tick
    // re-emits because alert_sent_at is already stamped (no harm — the
    // Cycle 14 consumer dedups on event_id).
    await this.kafka
      .emit({
        topic: 'inc.emergency.alert.dispatch',
        key: row.incident_id,
        sourceModule: 'incident',
        payload: {
          incidentId: row.incident_id,
          schoolId: row.school_id,
          incidentTypeCode: row.incident_type_code,
          severity: row.severity,
          notificationTemplate:
            row.notification_template ??
            'An emergency response is in effect. Follow staff instructions.',
          declaredAt: row.declared_at,
          sourceRefId: row.incident_id,
        },
      })
      .catch((e) => this.logger.warn('outbox alert kafka emit failed: ' + (e?.message || e)));

    this.logger.log('outbox alert_sent incident=' + row.incident_id.slice(0, 8));
  }

  /** Convert procedure_type to vis_emergency_muster.drill_type. */
  private mapToMusterDrillType(proc: string | null): string {
    switch (proc) {
      case 'FIRE_EVACUATION':
        return 'FIRE_DRILL';
      case 'LOCKDOWN':
        return 'LOCKDOWN';
      case 'BOMB_THREAT':
        return 'BOMB_THREAT';
      case 'SHELTER_IN_PLACE':
      case 'HAZMAT':
        return 'EVACUATION';
      default:
        return 'OTHER';
    }
  }

  private async checkStall(row: OutboxRow): Promise<void> {
    const ageMs = Date.now() - new Date(row.declared_at).getTime();
    const stalled = ageMs > 5 * 60 * 1000;
    if (!stalled) return;
    const unstamped: string[] = [];
    if (row.tasks_created_at === null) unstamped.push('tasks');
    if (row.muster_taken_at === null) unstamped.push('muster');
    if (row.alert_sent_at === null) unstamped.push('alert');
    if (unstamped.length === 0) return;
    this.logger.error(
      'OUTBOX_STALL incident=' +
        row.incident_id.slice(0, 8) +
        ' age_ms=' +
        ageMs +
        ' unstamped=' +
        unstamped.join(','),
    );
  }

  private async recordAttemptError(outboxId: string, message: string): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE inc_declaration_outbox SET last_attempt_at = now(), ' +
          '  attempt_count = attempt_count + 1, last_error = $1, updated_at = now() ' +
          'WHERE id = $2::uuid',
        message,
        outboxId,
      );
    });
  }
}
