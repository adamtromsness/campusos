import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { prefixedTopic, unprefixTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { RedisService } from '../notifications/redis.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';
import { buildPlaceholderValues, renderTemplate } from './template-render';

/**
 * TaskWorker (Cycle 7 Step 4) — sole writer to tsk_tasks per ADR-011.
 *
 * On startup the worker reads tsk_auto_task_rules across every active
 * tenant, builds the union of trigger_event_type values, and subscribes
 * to that set under consumer group `task-worker`. For each inbound event
 * it:
 *
 *   1. unwraps the ADR-057 envelope and reconstructs TenantInfo,
 *   2. runs read-only IdempotencyService.isClaimed (claim-after-success),
 *   3. queries active rules for this tenant matching the event_type,
 *   4. AND-evaluates tsk_auto_task_conditions against the payload,
 *   5. for each passing rule, executes the actions in sort_order:
 *        - CREATE_ACKNOWLEDGEMENT → INSERT tsk_acknowledgements rows
 *        - CREATE_TASK             → INSERT tsk_tasks rows (one per
 *                                     resolved owner) with source=AUTO
 *                                     and source_ref_id from payload
 *        - SEND_NOTIFICATION       → reserved for future cycles
 *   6. claims the event id only after success.
 *
 * Auto-task dedup is dual-layer per the Step 1 schema notes. Per-(owner,
 * source_ref_id) Redis SET NX on `tsk:auto:{owner}:{source_ref_id}` is
 * the authoritative dedup since the partitioned tsk_tasks table cannot
 * carry a UNIQUE constraint that excludes the partition column. The
 * partial INDEX on (owner_id, source, source_ref_id) WHERE
 * source != 'MANUAL' is read-side investigation support only.
 *
 * Subscription is dynamic at boot. Adding a new auto-task rule with a
 * never-before-seen trigger_event_type at runtime requires a worker
 * restart — documented limitation; the seed only adds rules at
 * provisioning time today.
 */

const CONSUMER_GROUP = 'task-worker';

interface RuleRow {
  id: string;
  title_template: string;
  description_template: string | null;
  priority: string;
  due_offset_hours: number | null;
  task_category: string;
  target_role: string | null;
}

interface ConditionRow {
  field_path: string;
  operator: string;
  value: unknown;
}

interface ActionRow {
  action_type: string;
  action_config: Record<string, unknown>;
}

@Injectable()
export class TaskWorker implements OnModuleInit {
  private readonly logger = new Logger(TaskWorker.name);

  constructor(
    private readonly platform: PrismaClient,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly kafka: KafkaProducerService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bootstrapSubscriptions();
  }

  /**
   * Build the union of trigger_event_type values across every active
   * tenant and subscribe to that set under group `task-worker`.
   */
  private async bootstrapSubscriptions(): Promise<void> {
    const schools = await this.platform.school.findMany({
      where: { isActive: true },
      include: { routing: true },
    });
    const eventTypes = new Set<string>();
    for (const school of schools) {
      if (!school.routing || !school.routing.isActive) continue;
      try {
        await this.tenantPrisma.executeInExplicitSchema(
          school.routing.schemaName,
          async (client) => {
            const rows = await client.$queryRawUnsafe<Array<{ trigger_event_type: string }>>(
              'SELECT DISTINCT trigger_event_type FROM tsk_auto_task_rules WHERE is_active = true',
            );
            for (const r of rows) eventTypes.add(r.trigger_event_type);
          },
        );
      } catch (e: any) {
        this.logger.warn('Skipped tenant ' + school.subdomain + ' rule scan: ' + (e?.message || e));
      }
    }
    if (eventTypes.size === 0) {
      this.logger.log(
        'TaskWorker found no active auto-task rules across any tenant — not subscribing',
      );
      return;
    }
    const topics = Array.from(eventTypes).sort().map(prefixedTopic);
    const self = this;
    await this.consumer.subscribe({
      topics,
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
    this.logger.log(
      'TaskWorker subscribed to ' + topics.length + ' topic(s): ' + topics.join(', '),
    );
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    const event = unwrapEnvelope<Record<string, unknown>>(msg, this.logger);
    if (!event) return;
    const eventType = unprefixTopic(msg.topic);
    const self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.runRulesForEvent(eventType, event);
      },
    );
  }

  private async runRulesForEvent(
    eventType: string,
    event: UnwrappedEvent<Record<string, unknown>>,
  ): Promise<void> {
    const rules = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<RuleRow[]>(
        'SELECT id::text AS id, title_template, description_template, priority, ' +
          'due_offset_hours, task_category, target_role ' +
          'FROM tsk_auto_task_rules ' +
          'WHERE trigger_event_type = $1 AND is_active = true',
        eventType,
      );
    });
    if (rules.length === 0) {
      this.logger.debug('[' + CONSUMER_GROUP + '] no active rules for ' + eventType + ' — drop');
      return;
    }

    for (const rule of rules) {
      const conditions = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<ConditionRow[]>(
          'SELECT field_path, operator, value FROM tsk_auto_task_conditions WHERE rule_id = $1::uuid',
          rule.id,
        );
      });
      if (!evaluateConditions(conditions, event.payload)) {
        this.logger.debug(
          '[' + CONSUMER_GROUP + '] rule ' + rule.id + ' conditions did not match for ' + eventType,
        );
        continue;
      }

      const ownerIds = await this.resolveOwners(rule, eventType, event);
      if (ownerIds.length === 0) {
        this.logger.debug(
          '[' + CONSUMER_GROUP + '] rule ' + rule.id + ' resolved 0 owners for ' + eventType,
        );
        continue;
      }

      const actions = await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe<ActionRow[]>(
          'SELECT action_type, action_config FROM tsk_auto_task_actions ' +
            'WHERE rule_id = $1::uuid ORDER BY sort_order',
          rule.id,
        );
      });

      // Per-rule shared state — a CREATE_ACKNOWLEDGEMENT action lands an
      // ack id that the next CREATE_TASK in the same rule links to.
      let ackIdsByOwner: Map<string, string> | null = null;

      for (const action of actions) {
        if (action.action_type === 'CREATE_ACKNOWLEDGEMENT') {
          ackIdsByOwner = await this.createAcknowledgements(rule, ownerIds, event);
        } else if (action.action_type === 'CREATE_TASK') {
          await this.createTasks(rule, ownerIds, event, ackIdsByOwner);
        } else if (action.action_type === 'SEND_NOTIFICATION') {
          // Reserved for future cycles. The Cycle 3 NotificationQueue
          // already covers most notification needs; this slot exists for
          // task-rule-driven notifications that don't fit that path.
          this.logger.debug(
            '[' +
              CONSUMER_GROUP +
              '] SEND_NOTIFICATION action on rule ' +
              rule.id +
              ' is reserved — skipping',
          );
        }
      }
    }
  }

  /**
   * Resolve the owners (platform_users.id values) for a rule given the
   * inbound event. The keystone path is ASSIGNMENT_POSTED → every
   * enrolled student in payload.classId. Other paths fall back to a
   * single-recipient lookup based on common payload field names.
   */
  private async resolveOwners(
    rule: RuleRow,
    eventType: string,
    event: UnwrappedEvent<Record<string, unknown>>,
  ): Promise<string[]> {
    const p = event.payload;
    if (eventType === 'cls.assignment.posted') {
      const classId = strField(p, 'classId') ?? strField(p, 'class_id');
      if (!classId) return [];
      return this.loadStudentAccountsForClass(classId);
    }
    if (rule.target_role === 'SCHOOL_ADMIN') {
      return this.loadSchoolAdminAccounts(event.tenant.schoolId);
    }
    if (rule.target_role === 'STUDENT') {
      const studentId = strField(p, 'studentId') ?? strField(p, 'student_id');
      if (!studentId) return [];
      const acct = await this.lookupStudentAccount(studentId);
      return acct ? [acct] : [];
    }
    if (rule.target_role === 'GUARDIAN') {
      const guardianAccount =
        strField(p, 'guardianAccountId') ?? strField(p, 'guardian_account_id');
      if (guardianAccount) return [guardianAccount];
      return [];
    }
    // Fallback — a payload that already carries the resolved recipient
    // account id. Used by sys.profile.update_requested and similar
    // future emits.
    const recipient =
      strField(p, 'recipientAccountId') ??
      strField(p, 'recipient_account_id') ??
      strField(p, 'accountId') ??
      strField(p, 'account_id');
    return recipient ? [recipient] : [];
  }

  private async loadSchoolAdminAccounts(schoolId: string): Promise<string[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT DISTINCT eac.account_id::text AS account_id ' +
          'FROM platform.iam_effective_access_cache eac ' +
          'JOIN platform.iam_scope s ON s.id = eac.scope_id ' +
          'JOIN platform.iam_scope_type st ON st.id = s.scope_type_id ' +
          "WHERE 'sch-001:admin' = ANY(eac.permission_codes) " +
          'AND s.is_active = true ' +
          "AND ((st.code = 'SCHOOL' AND s.entity_id = $1::uuid) OR st.code = 'PLATFORM')",
        schoolId,
      );
    });
    return rows.map((r) => r.account_id);
  }

  private async loadStudentAccountsForClass(classId: string): Promise<string[]> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT pu.id::text AS account_id ' +
          'FROM sis_enrollments e ' +
          'JOIN sis_students s ON s.id = e.student_id ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.platform_users pu ON pu.person_id = ps.person_id ' +
          "WHERE e.class_id = $1::uuid AND e.status = 'ACTIVE'",
        classId,
      );
    });
    return rows.map((r) => r.account_id);
  }

  private async lookupStudentAccount(studentId: string): Promise<string | null> {
    const rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ account_id: string }>>(
        'SELECT pu.id::text AS account_id ' +
          'FROM sis_students s ' +
          'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
          'JOIN platform.platform_users pu ON pu.person_id = ps.person_id ' +
          'WHERE s.id = $1::uuid LIMIT 1',
        studentId,
      );
    });
    return rows.length > 0 ? rows[0]!.account_id : null;
  }

  /**
   * Create a tsk_acknowledgements row per resolved owner. Returns a map
   * from owner_id to the freshly minted acknowledgement id so the
   * companion CREATE_TASK action in the same rule can link them.
   */
  private async createAcknowledgements(
    rule: RuleRow,
    ownerIds: string[],
    event: UnwrappedEvent<Record<string, unknown>>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const sourceRefId = pickSourceRefId(event.payload) ?? null;
    if (!sourceRefId) {
      this.logger.warn(
        '[' +
          CONSUMER_GROUP +
          '] CREATE_ACKNOWLEDGEMENT skipped — no resolvable source ref id on rule ' +
          rule.id,
      );
      return out;
    }
    const placeholders = buildPlaceholderValues(event.payload);
    const title = renderTemplate(rule.title_template, placeholders);
    const sourceType = inferAckSourceType(event.topic);
    for (const ownerId of ownerIds) {
      const ackId = generateId();
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO tsk_acknowledgements (id, school_id, subject_id, source_type, source_ref_id, source_table, title, created_by) ' +
              'VALUES ($1::uuid, $2::uuid, ' +
              '(SELECT person_id FROM platform.platform_users WHERE id = $3::uuid), ' +
              '$4, $5::uuid, $6, $7, $3::uuid)',
            ackId,
            event.tenant.schoolId,
            ownerId,
            sourceType,
            sourceRefId,
            event.topic,
            title,
          );
        });
        out.set(ownerId, ackId);
      } catch (e: any) {
        this.logger.warn(
          '[' +
            CONSUMER_GROUP +
            '] tsk_acknowledgements insert failed for owner=' +
            ownerId +
            ': ' +
            (e?.message || e),
        );
      }
    }
    return out;
  }

  /**
   * Create a tsk_tasks row per resolved owner. Per-(owner, source_ref_id)
   * Redis SET NX is the authoritative dedup; a duplicate inbound event
   * (different event_id but same source_ref_id) is silently dropped.
   * Emits task.created per row that lands.
   */
  private async createTasks(
    rule: RuleRow,
    ownerIds: string[],
    event: UnwrappedEvent<Record<string, unknown>>,
    ackIdsByOwner: Map<string, string> | null,
  ): Promise<void> {
    const sourceRefId = pickSourceRefId(event.payload);
    const placeholders = buildPlaceholderValues(event.payload);
    const title = renderTemplate(rule.title_template, placeholders);
    const description = rule.description_template
      ? renderTemplate(rule.description_template, placeholders)
      : null;
    const dueAt = computeDueAt(rule.due_offset_hours, event);

    for (const ownerId of ownerIds) {
      // Per-(owner, source_ref_id) Redis dedup. Skipped when no source
      // ref id (a manual-style auto-task with no domain anchor).
      if (sourceRefId) {
        const dedupKey = 'tsk:auto:' + event.tenant.subdomain + ':' + ownerId + ':' + sourceRefId;
        const claimed = await this.redis.claimIdempotency(dedupKey, 60 * 60 * 24 * 30);
        if (!claimed) {
          this.logger.debug(
            '[' +
              CONSUMER_GROUP +
              '] dedup hit on ' +
              dedupKey +
              ' — skipping task creation for owner=' +
              ownerId,
          );
          continue;
        }
      }
      const taskId = generateId();
      const ackId = ackIdsByOwner ? (ackIdsByOwner.get(ownerId) ?? null) : null;
      try {
        await this.tenantPrisma.executeInTenantContext(async (client) => {
          await client.$executeRawUnsafe(
            'INSERT INTO tsk_tasks ' +
              '(id, school_id, owner_id, title, description, source, source_ref_id, ' +
              ' priority, status, task_category, acknowledgement_id, due_at) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'AUTO', $6::uuid, $7, 'TODO', $8, $9::uuid, $10::timestamptz)",
            taskId,
            event.tenant.schoolId,
            ownerId,
            title,
            description,
            sourceRefId,
            rule.priority,
            rule.task_category,
            ackId,
            dueAt,
          );
        });
      } catch (e: any) {
        this.logger.warn(
          '[' +
            CONSUMER_GROUP +
            '] tsk_tasks insert failed for owner=' +
            ownerId +
            ': ' +
            (e?.message || e),
        );
        continue;
      }
      void this.kafka.emit({
        topic: 'task.created',
        key: taskId,
        sourceModule: 'tasks',
        correlationId: event.eventId,
        payload: {
          taskId,
          ownerId,
          title,
          priority: rule.priority,
          taskCategory: rule.task_category,
          source: 'AUTO',
          sourceRefId,
          dueAt,
        },
        tenantId: event.tenant.schoolId,
        tenantSubdomain: event.tenant.subdomain,
      });
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string' && v.length > 0) return v;
  return null;
}

/**
 * Pick the source-ref id from the inbound payload. Tries common naming
 * conventions in priority order. Returns null when nothing matches —
 * Redis SET NX will be skipped and dedup falls back to the consumer-
 * group claim.
 */
function pickSourceRefId(payload: Record<string, unknown>): string | null {
  const candidates = [
    'referenceId',
    'reference_id',
    'assignmentId',
    'assignment_id',
    'gradeId',
    'grade_id',
    'requestId',
    'request_id',
    'announcementId',
    'announcement_id',
    'consentId',
    'consent_id',
    'leaveRequestId',
    'leave_request_id',
  ];
  for (const k of candidates) {
    const v = strField(payload, k);
    if (v) return v;
  }
  return null;
}

function inferAckSourceType(topic: string): string {
  if (topic.indexOf('announcement') >= 0) return 'ANNOUNCEMENT';
  if (topic.indexOf('consent') >= 0) return 'CONSENT_REQUEST';
  if (topic.indexOf('discipline') >= 0) return 'DISCIPLINE_RECORD';
  if (topic.indexOf('policy') >= 0) return 'POLICY_DOCUMENT';
  if (topic.indexOf('form') >= 0) return 'SIGNED_FORM';
  return 'CUSTOM';
}

/**
 * Compute the due_at timestamp from the rule's offset and the event's
 * occurred_at (falling back to now). Returns null when no offset is set
 * — the resulting task has no due date.
 */
function computeDueAt(
  offsetHours: number | null,
  event: UnwrappedEvent<Record<string, unknown>>,
): string | null {
  if (offsetHours === null || offsetHours === undefined) return null;
  const base = strField(event.payload, 'due_at') ?? strField(event.payload, 'dueAt');
  if (offsetHours === 0 && base) return base;
  const start = base ? new Date(base) : new Date();
  const due = new Date(start.getTime() + offsetHours * 60 * 60 * 1000);
  return due.toISOString();
}

/**
 * AND-evaluate every condition row against the inbound payload. Returns
 * true when conditions is empty (rule fires unconditionally). A field
 * path that resolves to undefined fails most operators except EXISTS
 * (false) and NOT_EQUALS / NOT_IN (true) — same semantics as JSONLogic.
 */
export function evaluateConditions(
  conditions: ConditionRow[],
  payload: Record<string, unknown>,
): boolean {
  for (const c of conditions) {
    if (!evaluateCondition(c, payload)) return false;
  }
  return true;
}

function evaluateCondition(condition: ConditionRow, payload: Record<string, unknown>): boolean {
  const actual = resolvePath(payload, condition.field_path);
  switch (condition.operator) {
    case 'EXISTS':
      return actual !== undefined && actual !== null;
    case 'EQUALS':
      return jsonEqual(actual, condition.value);
    case 'NOT_EQUALS':
      return !jsonEqual(actual, condition.value);
    case 'IN':
      return Array.isArray(condition.value) && condition.value.some((v) => jsonEqual(actual, v));
    case 'NOT_IN':
      return !(Array.isArray(condition.value) && condition.value.some((v) => jsonEqual(actual, v)));
    case 'GT':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual > condition.value
      );
    case 'LT':
      return (
        typeof actual === 'number' &&
        typeof condition.value === 'number' &&
        actual < condition.value
      );
    default:
      return false;
  }
}

function resolvePath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const parts = path.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}
