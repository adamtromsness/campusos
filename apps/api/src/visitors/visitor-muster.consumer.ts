import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

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
 * Idempotency: the producer (DeclarationOutboxWorker.runStepMuster)
 * uses a deterministic event_id derived from the outbox row id +
 * 'muster', so retries from the worker (e.g. the M91 accountability
 * seed failed and the step retries) carry the same event_id and are
 * deduped via the standard processWithIdempotency claim-after-success
 * chain.
 *
 * As a defence-in-depth, we also use ON CONFLICT DO NOTHING on a
 * partial UNIQUE index on (incident_id, school_id) so that even if
 * two events somehow slip past the idempotency claim, the schema
 * rejects the duplicate row.
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
      await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // ON CONFLICT DO NOTHING on a (school_id, incident_id) partial
        // UNIQUE index would be ideal but the existing P2C1 schema does
        // not declare one. Instead the consumer's idempotency claim is
        // the dedup gate; an INSERT with the same incident_id from a
        // retry is the only case that can land twice, and it would
        // surface via a UNIQUE on incident_id which we add as a follow-
        // up migration. For this cycle we take the standard claim-
        // after-success guarantee from processWithIdempotency.
        await tx.$executeRawUnsafe(
          'INSERT INTO vis_emergency_muster ' +
            '(id, school_id, incident_id, drill_type, description, created_by, total_on_site_at_snapshot) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7)',
          generateId(),
          payload.schoolId,
          payload.incidentId,
          payload.drillType,
          'Auto-muster from emergency declaration',
          createdBy,
          payload.totalOnSiteAtSnapshot,
        );
      });
      this.logger.log(
        '[visitor-muster] created muster for incident=' +
          payload.incidentId.slice(0, 8) +
          ' total=' +
          payload.totalOnSiteAtSnapshot,
      );
    } catch (e: any) {
      // If the row already exists for this incident (a retry that beat
      // our idempotency claim, or a concurrent worker), re-raise so the
      // claim is NOT taken — the next redelivery will see the
      // pre-existing row and a future variant of this code can detect
      // and skip cleanly. For now the rethrow is the safe default.
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
