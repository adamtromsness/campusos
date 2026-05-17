import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import { prefixedTopic } from '@shared/kafka';
import { TenantPrismaService } from '@shared/tenant';
import { processWithIdempotency, unwrapEnvelope } from '@shared/kafka';

/**
 * VisitorMusterConsumer — REVIEW-P2C2 ROUND 1 BLOCKING fix.
 *
 * Owns the cross-module write into vis_emergency_muster on behalf of
 * the M91 Incident & Emergency module. The M91 DeclarationOutboxWorker
 * emits inc.emergency.muster.requested as part of its multi-step fan-
 * out; this consumer creates the matching vis_emergency_muster row
 * in the Visitor Management namespace it owns. Per the v11 cross-
 * module contract, no module writes another module's tables — events
 * cross the boundary, not direct INSERTs.
 *
 * Idempotency is layered:
 *
 *   1. The producer (DeclarationOutboxWorker.runStepMuster) uses a
 *      deterministic event_id derived from the outbox row id +
 *      'muster', so retries from the worker (e.g. the M91 acc-
 *      ountability seed failed and the step retries) carry the same
 *      event_id and are deduped via the standard
 *      processWithIdempotency claim-after-success chain.
 *
 *   2. REVIEW-P2C2 ROUND 2 closeout — schema-side defence-in-depth:
 *      migration 108 adds a partial UNIQUE INDEX on
 *      (school_id, incident_id) WHERE incident_id IS NOT NULL. The
 *      INSERT below uses ON CONFLICT DO NOTHING so a duplicate
 *      delivery (e.g. consumer crashed AFTER INSERT commit but
 *      BEFORE idempotency claim → Kafka redelivery) is a no-op
 *      success. The claim then succeeds normally and the redelivery
 *      drops out of the consumer-group queue. No second muster row
 *      is ever created for the same incident.
 *
 *      Stand-alone drills (incident_id NULL) stay free to coexist —
 *      the partial WHERE clause does not constrain them.
 */

const CONSUMER_GROUP = 'visitor-muster-consumer';

interface MusterRequestPayload {
  incidentId: string;
  schoolId: string;
  drillType: string;
  totalOnSiteAtSnapshot: number;
  createdBy: string | null;
  declaredAt: string;
  sourceRefId?: string;
}

@Injectable()
export class VisitorMusterConsumer implements OnModuleInit {
  private readonly logger = new Logger(VisitorMusterConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('inc.emergency.muster.requested')],
      groupId: CONSUMER_GROUP,
      handler: (msg: ConsumedMessage) => self.handle(msg),
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<MusterRequestPayload>(msg, this.logger);
    if (!event) return;

    const self = this;
    await processWithIdempotency(CONSUMER_GROUP, event, this.idempotency, this.logger, async () => {
      await self.materialiseMuster(event.payload);
    });
  }

  private async materialiseMuster(payload: MusterRequestPayload): Promise<void> {
    // The createdBy column is NOT NULL on vis_emergency_muster. If the
    // M91 producer has no procedure-contact id (procedure not configured
    // for this incident type), drop in the school's first admin so the
    // muster row can land. This matches the legacy code path the M91
    // worker used to take inline.
    const createdBy =
      payload.createdBy ?? (await this.lookupFallbackCreator(payload.schoolId)) ?? payload.schoolId; // last-resort sentinel — schema accepts any UUID
    try {
      // REVIEW-P2C2 Round 2 closeout — ON CONFLICT (school_id,
      // incident_id) DO NOTHING (against the migration-108 partial
      // UNIQUE INDEX) makes a duplicate delivery an idempotent no-op.
      // A worker crash between commit and idempotency claim is now
      // safe: the redelivery hits ON CONFLICT, the consumer claims,
      // and the redelivery drops out cleanly.
      const result = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        return (await tx.$queryRawUnsafe(
          'INSERT INTO vis_emergency_muster ' +
            '(id, school_id, incident_id, drill_type, description, created_by, total_on_site_at_snapshot) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7) ' +
            'ON CONFLICT (school_id, incident_id) WHERE incident_id IS NOT NULL ' +
            '  DO NOTHING ' +
            'RETURNING id::text AS id',
          generateId(),
          payload.schoolId,
          payload.incidentId,
          payload.drillType,
          'Auto-muster from emergency declaration',
          createdBy,
          payload.totalOnSiteAtSnapshot,
        )) as Array<{ id: string }>;
      });
      if (result.length === 0) {
        // ON CONFLICT branch fired — a prior delivery already created
        // the muster row. Treat as idempotent success so the consumer
        // claim records and the redelivery drops cleanly.
        this.logger.log(
          '[visitor-muster] muster already exists for incident=' +
            payload.incidentId.slice(0, 8) +
            ' (idempotent no-op via ON CONFLICT)',
        );
      } else {
        this.logger.log(
          '[visitor-muster] created muster for incident=' +
            payload.incidentId.slice(0, 8) +
            ' total=' +
            payload.totalOnSiteAtSnapshot,
        );
      }
    } catch (e: any) {
      // Real failure (DB outage, schema drift, FK violation). Re-raise
      // so the idempotency claim is NOT taken and the next redelivery
      // retries.
      this.logger.warn(
        '[visitor-muster] insert failed for incident=' +
          payload.incidentId.slice(0, 8) +
          ': ' +
          (e?.message || e),
      );
      throw e;
    }
  }

  private async lookupFallbackCreator(schoolId: string): Promise<string | null> {
    try {
      const platform = this.tenantPrisma.getPlatformClient();
      const rows = (await platform.$queryRawUnsafe(
        'SELECT DISTINCT eac.account_id::text AS account_id ' +
          'FROM platform.iam_effective_access_cache eac ' +
          'JOIN platform.iam_scope s ON s.id = eac.scope_id ' +
          'JOIN platform.iam_scope_type st ON st.id = s.scope_type_id ' +
          "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
          'AND s.is_active = true ' +
          "AND ((st.code = 'SCHOOL' AND s.entity_id = $1::uuid) OR st.code = 'PLATFORM') " +
          'LIMIT 1',
        schoolId,
      )) as Array<{ account_id: string }>;
      return rows.length > 0 ? rows[0]!.account_id : null;
    } catch {
      return null;
    }
  }
}
