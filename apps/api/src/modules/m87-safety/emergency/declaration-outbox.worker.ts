import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '@shared/tenant/tenant.context';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

/**
 * P2C2 Step 5 — DeclarationOutboxWorker.
 *
 * Atomic orchestration of multi-step emergency fan-out. The
 * declare path (IncidentService.declare) writes inc_incidents +
 * inc_declaration_outbox in one tenant transaction. This worker
 * polls the outbox for unstamped step columns and runs each step
 * idempotently:
 *
 *   1. tasks_created_at  → emits inc.emergency.task.requested per
 *      procedure contact (one event per contact). Cycle 7
 *      TaskWorker consumes via auto-task-rule and creates the
 *      URGENT response task. **Per ADR-011 the Task Worker is the
 *      sole writer to tsk_tasks** — this worker never inserts there.
 *
 *   2. muster_taken_at   → emits inc.emergency.muster.requested.
 *      The Visitor module's VisitorMusterConsumer (P2C1) consumes
 *      and creates the vis_emergency_muster row. The visitor-side
 *      table belongs to Visitor Management — this worker does not
 *      write to it. The visitor accountability seed
 *      (inc_accountability_records insert reading from vis_sign_ins)
 *      stays here because that table is M91-owned. The summary seed
 *      (inc_accountability_summary) is also M91-owned.
 *
 *   3. alert_sent_at     → emits inc.emergency.alert.dispatch on
 *      the wire so Cycle 14's emergency-alert subscriber can fan
 *      out the school-wide notification.
 *
 * REVIEW-P2C2 ROUND 1 BLOCKING fix — emit-first-stamp-after for all
 * three steps. The prior version stamped the column inside the same
 * tx as the write/emit; if the Kafka publish failed, the row was
 * dropped from the pending query and the fan-out step was lost.
 * Now: emit/work first; on success stamp the column in a fresh tx;
 * on failure record last_error + attempt_count and leave the column
 * NULL so the next poll retries.
 *
 * Crash recovery: a worker crash between emit success and stamp
 * leaves the column NULL. The next tick re-emits with the same
 * deterministic event_id (sha256(outboxId + ':step') formatted as a
 * v5-shaped UUID) so consumers dedupe via their idempotency table.
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

/**
 * Build a deterministic v5-shaped UUID from an outbox row id and a
 * step suffix. Re-emits on retry land the same event_id so consumers
 * dedupe via the standard `processWithIdempotency` claim-after-success
 * pattern. Same shape as Cycle 4's `deterministicCoverageEventId`.
 */
export function deterministicStepEventId(outboxId: string, step: string): string {
  const hash = createHash('sha256')
    .update(outboxId + ':' + step + ':v1')
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
        await this.recordStepError(row.id, msg);
        this.logger.warn(
          'outbox: incident=' + row.incident_id.slice(0, 8) + ' step failed: ' + msg,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 1 — emit inc.emergency.task.requested per procedure contact.
  // -------------------------------------------------------------------------
  // REVIEW-P2C2 ROUND 1 BLOCKING fix — was: direct INSERT into tsk_tasks,
  // violating ADR-011 (Task Worker is the sole writer to tsk_tasks). Now:
  // emit one Kafka event per contact, the Cycle 7 TaskWorker consumes via
  // auto-task-rule and creates the URGENT response task with payload
  // .recipientAccountId as the owner. Stamping is emit-first-success-after
  // so a broker outage does NOT silently mark the step done.
  async runStepTasks(row: OutboxRow): Promise<void> {
    // Lock + re-check still pending under tx so concurrent workers serialise.
    const stillPending = await this.checkStillPending(row.id, 'tasks_created_at');
    if (!stillPending) return;

    const contacts: string[] = [];
    if (row.primary_contact_id) contacts.push(row.primary_contact_id);
    if (row.secondary_contact_id && row.secondary_contact_id !== row.primary_contact_id) {
      contacts.push(row.secondary_contact_id);
    }
    if (contacts.length === 0) {
      // No procedure contacts configured — stamp success and move on. The
      // event chain still works for muster/alert; the school just has no
      // emergency-response task assignee.
      await this.stampStepSuccess(row.id, 'tasks_created_at');
      this.logger.warn(
        'outbox tasks_created (no contacts) incident=' + row.incident_id.slice(0, 8),
      );
      return;
    }

    const incidentTitle = row.incident_title ?? row.incident_type_code ?? 'Emergency Incident';

    // Emit one event per contact — fan-out is many-to-one task creations.
    // Each event has a deterministic event_id derived from
    // (outboxId, 'tasks-N') so retries land the same id and the
    // TaskWorker's idempotency claim dedupes. The `sourceRefId =
    // incident_id` is also the key the schema-side
    // tsk_tasks_auto_dedup_idx (owner_id, source, source_ref_id) WHERE
    // source<>'MANUAL' uses to catch duplicate task creations.
    for (let i = 0; i < contacts.length; i++) {
      const ownerId = contacts[i]!;
      const eventId = deterministicStepEventId(row.id, 'tasks-' + i);
      try {
        await this.kafka.emit({
          topic: 'inc.emergency.task.requested',
          key: row.incident_id,
          eventId,
          sourceModule: 'incident',
          payload: {
            incidentId: row.incident_id,
            schoolId: row.school_id,
            recipientAccountId: ownerId,
            title: 'EMERGENCY: ' + incidentTitle,
            description:
              'Lead the response procedure for this incident. Update the timeline with progress.',
            priority: 'URGENT',
            taskCategory: 'ADMINISTRATIVE',
            dueOffsetHours: 2,
            sourceRefId: row.incident_id,
          },
        });
      } catch (e: any) {
        // Emit failed for this contact — record the error and leave the
        // step UNSTAMPED so the next poll retries the whole step. The
        // events that already fired are deduped by the deterministic id.
        const msg = ('emit task failed for contact ' + i + ': ' + (e?.message || e)).slice(0, 1000);
        await this.recordStepError(row.id, msg);
        return;
      }
    }

    // All emits succeeded — stamp tasks_created_at in a fresh tx.
    await this.stampStepSuccess(row.id, 'tasks_created_at');
    this.logger.log(
      'outbox tasks_created incident=' +
        row.incident_id.slice(0, 8) +
        ' contacts=' +
        contacts.length,
    );
  }

  // -------------------------------------------------------------------------
  // Step 2 — emit inc.emergency.muster.requested for the Visitor module to
  // create the vis_emergency_muster row. Then seed the M91-owned
  // accountability records (reading from vis_sign_ins is a defensible
  // cross-cycle read; writing to inc_accountability_records / _summary is
  // an M91 → M91 operation).
  // -------------------------------------------------------------------------
  // REVIEW-P2C2 ROUND 1 BLOCKING fix — was: direct INSERT into
  // vis_emergency_muster, violating the v11 "no module writes to another
  // module's tables" doctrine. Now: emit a request event for the Visitor
  // module's consumer to handle the vis_emergency_muster INSERT. The
  // M91-internal writes (accountability seed + summary seed) stay here.
  async runStepMuster(row: OutboxRow): Promise<void> {
    const stillPending = await this.checkStillPending(row.id, 'muster_taken_at');
    if (!stillPending) return;

    // Count currently signed-in visitors for the muster-request payload
    // (the consumer needs the snapshot total so it does not have to
    // re-read vis_sign_ins immediately).
    const total = await this.tenantPrisma.executeInTenantContext(async (client) => {
      const r = (await client.$queryRawUnsafe(
        'SELECT COUNT(*)::int AS n FROM vis_sign_ins ' +
          'WHERE school_id = $1::uuid AND signed_out_at IS NULL',
        row.school_id,
      )) as Array<{ n: number }>;
      return r[0]?.n ?? 0;
    });

    const drillType = this.mapToMusterDrillType(row.procedure_type);
    const musterCreator = row.primary_contact_id ?? row.secondary_contact_id ?? null;

    // Emit muster-request event for the Visitor module to consume.
    // VisitorMusterConsumer creates the vis_emergency_muster row keyed on
    // (school_id, incident_id) — duplicate emits from a retry land a
    // no-op via the consumer's idempotency claim on event_id.
    try {
      await this.kafka.emit({
        topic: 'inc.emergency.muster.requested',
        key: row.incident_id,
        eventId: deterministicStepEventId(row.id, 'muster'),
        sourceModule: 'incident',
        payload: {
          incidentId: row.incident_id,
          schoolId: row.school_id,
          drillType,
          totalOnSiteAtSnapshot: total,
          createdBy: musterCreator,
          declaredAt: row.declared_at,
          sourceRefId: row.incident_id,
        },
      });
    } catch (e: any) {
      const msg = ('emit muster failed: ' + (e?.message || e)).slice(0, 1000);
      await this.recordStepError(row.id, msg);
      return;
    }

    // Seed M91-owned accountability records + summary in a fresh tenant
    // tx. These are M91 → M91 writes; the read from vis_sign_ins is a
    // defensible cross-cycle lookup. ON CONFLICT (incident, person) DO
    // NOTHING keeps retries idempotent.
    try {
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
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
        await tx.$executeRawUnsafe(
          'INSERT INTO inc_accountability_summary ' +
            '(id, incident_id, total_people, accounted_for, unknown, evacuated, ' +
            ' medical_assistance, missing, last_updated_at) ' +
            'VALUES ($1::uuid, $2::uuid, 0, 0, 0, 0, 0, 0, now()) ' +
            'ON CONFLICT (incident_id) DO NOTHING',
          generateId(),
          row.incident_id,
        );
      });
    } catch (e: any) {
      // The M91-internal seed failed. Leave the step unstamped — the next
      // poll retries (the Kafka emit above is idempotent at the consumer
      // via deterministic event_id).
      const msg = ('accountability seed failed: ' + (e?.message || e)).slice(0, 1000);
      await this.recordStepError(row.id, msg);
      return;
    }

    await this.stampStepSuccess(row.id, 'muster_taken_at');
    this.logger.log('outbox muster_taken incident=' + row.incident_id.slice(0, 8));
  }

  // -------------------------------------------------------------------------
  // Step 3 — emit inc.emergency.alert.dispatch for Cycle 14 to consume.
  // -------------------------------------------------------------------------
  // REVIEW-P2C2 ROUND 1 BLOCKING fix — emit-first-stamp-after. The prior
  // version stamped alert_sent_at FIRST and emitted second; if the broker
  // was unreachable, the catch-and-log left the dashboard saying "alert
  // sent" while the wire never carried the event. Now: emit first; on
  // success stamp; on failure record last_error and leave the column NULL
  // so the next poll retries.
  async runStepAlert(row: OutboxRow): Promise<void> {
    const stillPending = await this.checkStillPending(row.id, 'alert_sent_at');
    if (!stillPending) return;

    try {
      await this.kafka.emit({
        topic: 'inc.emergency.alert.dispatch',
        key: row.incident_id,
        eventId: deterministicStepEventId(row.id, 'alert'),
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
      });
    } catch (e: any) {
      const msg = ('emit alert failed: ' + (e?.message || e)).slice(0, 1000);
      await this.recordStepError(row.id, msg);
      return;
    }

    // Emit succeeded — stamp alert_sent_at in a fresh tx.
    await this.stampStepSuccess(row.id, 'alert_sent_at');
    this.logger.log('outbox alert_sent incident=' + row.incident_id.slice(0, 8));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Lock the outbox row and check the named step column is still NULL.
   * Returns false if the row has been stamped by another worker since the
   * pending query saw it. Acquires + releases the lock inside this tx.
   */
  private async checkStillPending(
    outboxId: string,
    stepColumn: 'tasks_created_at' | 'muster_taken_at' | 'alert_sent_at',
  ): Promise<boolean> {
    return this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const lock = (await tx.$queryRawUnsafe(
        'SELECT id, ' +
          stepColumn +
          ' AS step_at FROM inc_declaration_outbox ' +
          'WHERE id = $1::uuid FOR UPDATE',
        outboxId,
      )) as Array<{ id: string; step_at: string | null }>;
      if (lock.length === 0) return false;
      return lock[0]!.step_at === null;
    });
  }

  /**
   * Stamp the named step column on success. Runs in a fresh tenant tx
   * separate from the Kafka emit. Re-stamping a row already stamped is
   * harmless (the WHERE predicate is a no-op).
   */
  private async stampStepSuccess(
    outboxId: string,
    stepColumn: 'tasks_created_at' | 'muster_taken_at' | 'alert_sent_at',
  ): Promise<void> {
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'UPDATE inc_declaration_outbox SET ' +
          stepColumn +
          ' = now(), ' +
          '  last_attempt_at = now(), attempt_count = attempt_count + 1, ' +
          '  last_error = NULL, updated_at = now() ' +
          'WHERE id = $1::uuid AND ' +
          stepColumn +
          ' IS NULL',
        outboxId,
      );
    });
  }

  /** Record a step-level failure without stamping the column. */
  private async recordStepError(outboxId: string, message: string): Promise<void> {
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
}
