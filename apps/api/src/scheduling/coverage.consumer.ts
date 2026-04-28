import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { ConsumedMessage, KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { IdempotencyService } from '../kafka/idempotency.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { prefixedTopic } from '../kafka/event-envelope';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../notifications/consumers/notification-consumer-base';

/**
 * CoverageConsumer (Cycle 5 Step 6).
 *
 * Subscribes to `hr.leave.coverage_needed` (group: `coverage-consumer`),
 * republished by Cycle 4's LeaveNotificationConsumer when a leave is
 * approved. The inbound payload carries:
 *
 *   { requestId, employeeId, startDate, endDate,
 *     affectedClasses: [{classId, sectionCode, courseName}] }
 *
 * For each (class, date) pair where:
 *   - the date falls in [startDate, endDate],
 *   - the class has an active timetable slot covering that date,
 *
 * we INSERT one `sch_coverage_requests` row with status=OPEN. The
 * UNIQUE(timetable_slot_id, coverage_date) on `sch_coverage_requests` is
 * the schema-side dedup — a Kafka redelivery of the same approved leave
 * tries to INSERT the same rows and 23505s harmlessly (we swallow it).
 *
 * On top of that, the deterministic `event_id` from REVIEW-CYCLE4 MAJOR 3
 * means a redelivery of the exact same `hr.leave.coverage_needed` event
 * carries the same id, so `IdempotencyService.claim` on the wrapper drops
 * the duplicate before it touches the DB at all. The schema-side UNIQUE
 * is the belt-and-braces line of defence.
 *
 * After successfully inserting the new rows we emit `sch.coverage.needed`
 * once with the list of created request ids — a lightweight admin-feed
 * topic for Step 8's coverage board UI to react to.
 */
interface CoverageNeededPayload {
  requestId: string;
  employeeId: string;
  startDate: string;
  endDate: string;
  affectedClasses: Array<{
    classId: string;
    sectionCode?: string;
    courseName?: string;
  }>;
}

interface SlotMatch {
  slot_id: string;
  class_id: string;
  section_code: string;
  course_name: string;
  period_id: string;
  period_day_of_week: number | null;
}

var CONSUMER_GROUP = 'coverage-consumer';

@Injectable()
export class CoverageConsumer implements OnModuleInit {
  private readonly logger = new Logger(CoverageConsumer.name);

  constructor(
    private readonly consumer: KafkaConsumerService,
    private readonly idempotency: IdempotencyService,
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async onModuleInit(): Promise<void> {
    var self = this;
    await this.consumer.subscribe({
      topics: [prefixedTopic('hr.leave.coverage_needed')],
      groupId: CONSUMER_GROUP,
      handler: function (msg: ConsumedMessage): Promise<void> {
        return self.handle(msg);
      },
    });
  }

  private async handle(msg: ConsumedMessage): Promise<void> {
    var event = unwrapEnvelope<CoverageNeededPayload>(msg, this.logger);
    if (!event) return;
    var p = event.payload;
    if (!p.requestId || !p.employeeId || !p.startDate || !p.endDate) {
      this.logger.warn(
        'Dropping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — missing requestId / employeeId / dates',
      );
      return;
    }
    if (!Array.isArray(p.affectedClasses) || p.affectedClasses.length === 0) {
      this.logger.debug(
        'Skipping ' +
          msg.topic +
          ' (eventId=' +
          event.eventId +
          ') — no affected classes in payload',
      );
      return;
    }
    var self = this;
    await processWithIdempotency(
      CONSUMER_GROUP,
      event as UnwrappedEvent<unknown>,
      this.idempotency,
      this.logger,
      async function () {
        await self.createCoverageRequests(event!);
      },
    );
  }

  /**
   * For each affected class, find the active timetable slot(s) and create a
   * sch_coverage_requests row for every date in [startDate, endDate] that
   * the slot covers. Slots with `day_of_week=NULL` apply every weekday
   * (the seed shape — most rotation-driven schedules will populate the
   * column, but the demo seed leaves it NULL so periods apply Mon–Fri).
   */
  private async createCoverageRequests(
    event: UnwrappedEvent<CoverageNeededPayload>,
  ): Promise<void> {
    var p = event.payload;
    var classIds = p.affectedClasses.map(function (c) {
      return c.classId;
    });
    var dates = enumerateWeekdayDates(p.startDate, p.endDate);
    if (dates.length === 0) {
      this.logger.debug(
        '[' +
          CONSUMER_GROUP +
          '] no weekday dates between ' +
          p.startDate +
          ' and ' +
          p.endDate,
      );
      return;
    }
    var schoolId = event.tenant.schoolId;
    var self = this;
    var createdIds: string[] = [];
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var slots = await self.loadActiveSlots(tx, classIds, p.startDate, p.endDate);
      if (slots.length === 0) {
        self.logger.debug(
          '[' +
            CONSUMER_GROUP +
            '] no active slots for classes ' +
            classIds.join(',') +
            ' in date range',
        );
        return;
      }
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i]!;
        for (var j = 0; j < dates.length; j++) {
          var date = dates[j]!;
          if (
            slot.period_day_of_week !== null &&
            slot.period_day_of_week !== isoWeekdayIndex(date)
          ) {
            continue;
          }
          var coverageId = generateId();
          try {
            await tx.$executeRawUnsafe(
              "INSERT INTO sch_coverage_requests (id, school_id, timetable_slot_id, absent_teacher_id, leave_request_id, coverage_date, status) " +
                "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, 'OPEN')",
              coverageId,
              schoolId,
              slot.slot_id,
              p.employeeId,
              p.requestId,
              date,
            );
            createdIds.push(coverageId);
          } catch (e: any) {
            var code = e?.code || e?.meta?.code;
            var msg = e?.message || '';
            if (code === '23505' || /sch_coverage_requests_slot_date_uq/.test(msg)) {
              // Already created on a previous run — fine, schema dedup wins.
              self.logger.debug(
                '[' +
                  CONSUMER_GROUP +
                  '] coverage already exists for slot=' +
                  slot.slot_id +
                  ' date=' +
                  date,
              );
              continue;
            }
            throw e;
          }
        }
      }
    });

    if (createdIds.length > 0) {
      this.logger.log(
        '[' +
          CONSUMER_GROUP +
          '] created ' +
          createdIds.length +
          ' OPEN coverage rows for leave ' +
          p.requestId,
      );
      void this.kafka.emit({
        topic: 'sch.coverage.needed',
        key: p.requestId,
        sourceModule: 'scheduling',
        correlationId: event.eventId,
        payload: {
          leaveRequestId: p.requestId,
          employeeId: p.employeeId,
          startDate: p.startDate,
          endDate: p.endDate,
          createdCoverageIds: createdIds,
        },
        tenantId: event.tenant.schoolId,
        tenantSubdomain: event.tenant.subdomain,
      });
    } else {
      this.logger.debug(
        '[' + CONSUMER_GROUP + '] no new coverage rows for leave ' + p.requestId,
      );
    }
  }

  /**
   * Load active timetable slots for the supplied class ids whose
   * effective_from <= endDate AND (effective_to IS NULL OR effective_to >=
   * startDate). Returns one row per slot; the caller iterates dates × slots
   * to create coverage rows.
   */
  private async loadActiveSlots(
    tx: any,
    classIds: string[],
    startDate: string,
    endDate: string,
  ): Promise<SlotMatch[]> {
    if (classIds.length === 0) return [];
    var placeholders = classIds
      .map(function (_: string, i: number) {
        return '$' + (i + 1) + '::uuid';
      })
      .join(',');
    var startIdx = classIds.length + 1;
    var endIdx = classIds.length + 2;
    return tx.$queryRawUnsafe(
      'SELECT ts.id::text AS slot_id, ts.class_id::text AS class_id, c.section_code, co.name AS course_name, ' +
        'ts.period_id::text AS period_id, p.day_of_week AS period_day_of_week ' +
        'FROM sch_timetable_slots ts ' +
        'JOIN sis_classes c ON c.id = ts.class_id ' +
        'JOIN sis_courses co ON co.id = c.course_id ' +
        'JOIN sch_periods p ON p.id = ts.period_id ' +
        'WHERE ts.class_id IN (' +
        placeholders +
        ') ' +
        'AND ts.effective_from <= $' +
        endIdx +
        '::date ' +
        'AND (ts.effective_to IS NULL OR ts.effective_to >= $' +
        startIdx +
        '::date) ' +
        'ORDER BY p.start_time',
      ...classIds,
      startDate,
      endDate,
    );
  }
}

/**
 * Enumerate every weekday (Mon–Fri) date in [startDate, endDate].
 * The CoverageConsumer drops weekends because `sch_periods.day_of_week`
 * uses ISO 0=Mon..6=Sun and the seed only schedules Mon–Fri periods.
 */
export function enumerateWeekdayDates(startDate: string, endDate: string): string[] {
  var out: string[] = [];
  var current = new Date(startDate + 'T00:00:00Z');
  var end = new Date(endDate + 'T00:00:00Z');
  if (current > end) return out;
  var max = 366; // safety bound
  for (var i = 0; i <= max && current <= end; i++) {
    var day = current.getUTCDay(); // 0=Sun..6=Sat
    if (day !== 0 && day !== 6) {
      out.push(current.toISOString().slice(0, 10));
    }
    current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
}

/**
 * ISO weekday index 0=Mon..6=Sun for a YYYY-MM-DD string. Matches the
 * convention used by `sch_periods.day_of_week`.
 */
export function isoWeekdayIndex(date: string): number {
  var d = new Date(date + 'T00:00:00Z').getUTCDay(); // 0=Sun..6=Sat
  return (d + 6) % 7; // shift to 0=Mon..6=Sun
}
