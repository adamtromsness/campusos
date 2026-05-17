import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import { RidershipService } from './ridership.service';
import { NoShowAlertResponseDto, NoShowResolution, ResolveNoShowDto } from './dto/transport.dto';

interface AlertRow {
  id: string;
  student_id: string;
  student_name: string | null;
  route_id: string;
  expected_date: Date;
  expected_stop_id: string;
  expected_stop_name: string | null;
  alert_time: Date;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  parent_notified_at: Date | null;
  resolution_notes: string | null;
}

const SELECT_ALERT_BASE =
  'SELECT a.id::text AS id, a.student_id::text AS student_id, ' +
  "(SELECT (ip.first_name || ' ' || ip.last_name) FROM platform.iam_person ip " +
  '  JOIN platform.platform_students ps ON ps.person_id = ip.id ' +
  '  JOIN sis_students s ON s.platform_student_id = ps.id WHERE s.id = a.student_id) AS student_name, ' +
  'a.route_id::text AS route_id, a.expected_date, a.expected_stop_id::text AS expected_stop_id, ' +
  '(SELECT name FROM trn_stops WHERE id = a.expected_stop_id) AS expected_stop_name, ' +
  'a.alert_time, a.resolution, a.resolved_by::text AS resolved_by, a.resolved_at, ' +
  'a.parent_notified_at, a.resolution_notes ' +
  'FROM trn_no_show_alerts a ';

function rowToDto(r: AlertRow): NoShowAlertResponseDto {
  return {
    id: r.id,
    studentId: r.student_id,
    studentName: r.student_name,
    routeId: r.route_id,
    expectedDate: r.expected_date.toISOString().slice(0, 10),
    expectedStopId: r.expected_stop_id,
    expectedStopName: r.expected_stop_name,
    alertTime: r.alert_time.toISOString(),
    resolution: r.resolution as NoShowResolution | null,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    parentNotifiedAt: r.parent_notified_at ? r.parent_notified_at.toISOString() : null,
    resolutionNotes: r.resolution_notes,
  };
}

/**
 * Safeguarding keystone. The NoShowWorker compares expected ridership
 * (trn_student_assignments) against actual scans (trn_ridership_records)
 * for the current date and creates trn_no_show_alerts rows for any
 * student expected on a route who didn't scan a BOARDING within the
 * grace window.
 *
 * UNIQUE(student, route, expected_date, expected_stop) is the
 * schema-side dedup gate so a worker re-run cannot double-fire.
 *
 * The worker is exposed via POST /transport/no-shows/_run-once_ for
 * the Step 10 CAT and ops triage. A scheduled cron is deferred to
 * Cycle 19.1 ops wiring per the plan's "configurable schedule" note.
 */
@Injectable()
export class NoShowService {
  private readonly logger = new Logger('NoShowWorker');

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly ridership: RidershipService,
    private readonly kafka: KafkaProducerService,
  ) {}

  async list(
    actor: ResolvedActor,
    args: { date?: string; resolved?: boolean },
  ): Promise<NoShowAlertResponseDto[]> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can read no-show alerts');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (args.date) {
      where.push('a.expected_date = $' + (params.length + 1) + '::date');
      params.push(args.date);
    }
    if (args.resolved === false) {
      where.push('a.resolution IS NULL');
    } else if (args.resolved === true) {
      where.push('a.resolution IS NOT NULL');
    }
    const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        SELECT_ALERT_BASE +
          whereSql +
          ' ORDER BY a.expected_date DESC, a.alert_time DESC LIMIT 200',
        ...params,
      );
    })) as AlertRow[];
    return rows.map(rowToDto);
  }

  /**
   * REVIEW-CYCLE19 MAJOR 8 — lock the alert row + reject if a
   * resolution is already set (unless admin overrides). Two TC users
   * resolving the same alert at the same time now serialise on the
   * row lock instead of last-writer-wins.
   */
  async resolve(
    alertId: string,
    input: ResolveNoShowDto,
    actor: ResolvedActor,
  ): Promise<NoShowAlertResponseDto> {
    if (!actor.isSchoolAdmin && actor.personType !== 'STAFF') {
      throw new ForbiddenException('Only admins or staff can resolve no-show alerts');
    }
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        'SELECT id, resolution FROM trn_no_show_alerts WHERE id = $1::uuid FOR UPDATE',
        alertId,
      )) as Array<{ id: string; resolution: string | null }>;
      if (locked.length === 0) throw new NotFoundException('Alert not found');
      if (locked[0]!.resolution !== null && !actor.isSchoolAdmin) {
        // Idempotent same-resolution noop is OK; otherwise reject.
        if (locked[0]!.resolution !== input.resolution) {
          throw new BadRequestException(
            'Alert is already resolved with ' +
              locked[0]!.resolution +
              '. Only a school admin can change the resolution.',
          );
        }
      }
      await tx.$executeRawUnsafe(
        'UPDATE trn_no_show_alerts SET resolution = $1, resolved_by = $2::uuid, resolved_at = now(), ' +
          ' parent_notified_at = CASE WHEN $1 = $3 THEN now() ELSE parent_notified_at END, ' +
          ' resolution_notes = $4, updated_at = now() ' +
          ' WHERE id = $5::uuid',
        input.resolution,
        actor.accountId,
        'PARENT_NOTIFIED',
        input.resolutionNotes ?? null,
        alertId,
      );
    });
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(SELECT_ALERT_BASE + 'WHERE a.id = $1::uuid LIMIT 1', alertId);
    })) as AlertRow[];
    if (rows.length === 0) throw new NotFoundException('Alert not found');
    return rowToDto(rows[0]!);
  }

  /**
   * Run the no-show detection sweep for the supplied date (default
   * today). For each ACTIVE route, walks the union of permanent
   * assignments + override assignments effective today and inserts
   * trn_no_show_alerts ON CONFLICT DO NOTHING for any student missing
   * a BOARDING scan.
   *
   * Returns the array of alert ids freshly created so the CAT can
   * verify a specific run inserted exactly the rows expected.
   */
  async runOnce(args: { date?: string } = {}): Promise<{
    inserted: number;
    insertedIds: string[];
  }> {
    const tenant = getCurrentTenant();
    const today = args.date ?? new Date().toISOString().slice(0, 10);
    const inserted: string[] = [];

    // Pull all (route, student, stop, direction) tuples expected today.
    //
    // REVIEW-CYCLE19 BLOCKING 1 — exclude students with an APPROVED
    // route-change request for the date so:
    //   - NO_BUS opt-outs do not generate false-positive safeguarding
    //     alerts for the permanent assignment;
    //   - DIFFERENT_STOP / DIFFERENT_ROUTE approvals materialise an
    //     `is_override = true` row (with parent_request_id set) AND
    //     the permanent assignment is suppressed for that day, so a
    //     student isn't paged at both their original AND override stop.
    //
    // The override row itself drives the expectation when present.
    const expected = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        'SELECT a.student_id::text AS student_id, a.route_id::text AS route_id, a.stop_id::text AS stop_id, a.direction ' +
          'FROM trn_student_assignments a ' +
          'JOIN trn_routes r ON r.id = a.route_id ' +
          "WHERE r.school_id = $1::uuid AND r.status = 'ACTIVE' " +
          ' AND a.effective_from <= $2::date AND (a.effective_to IS NULL OR a.effective_to >= $2::date) ' +
          ' AND NOT (' +
          '   a.is_override = false AND EXISTS (' +
          '     SELECT 1 FROM trn_route_change_requests rcr ' +
          '     WHERE rcr.student_id = a.student_id ' +
          '       AND rcr.change_date = $2::date ' +
          "       AND rcr.status = 'APPROVED'" +
          '   )' +
          ' )',
        tenant.schoolId,
        today,
      );
    })) as Array<{ student_id: string; route_id: string; stop_id: string; direction: string }>;

    for (const e of expected) {
      const hasScan = await this.ridership.hasBoardingScan(e.student_id, e.route_id, today);
      if (hasScan) continue;
      // Insert ON CONFLICT DO NOTHING — UNIQUE(student, route, expected_date, expected_stop) is the dedup gate
      const id = generateId();
      const inserts = (await this.tenantPrisma.executeInTenantContext(async (client) => {
        return client.$queryRawUnsafe(
          'INSERT INTO trn_no_show_alerts (id, student_id, route_id, expected_date, expected_stop_id, alert_time) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::uuid, now()) ' +
            'ON CONFLICT (student_id, route_id, expected_date, expected_stop_id) DO NOTHING ' +
            'RETURNING id::text AS id',
          id,
          e.student_id,
          e.route_id,
          today,
          e.stop_id,
        );
      })) as Array<{ id: string }>;

      if (inserts.length > 0) {
        const newId = inserts[0]!.id;
        inserted.push(newId);
        await this.kafka.emit({
          topic: 'trn.no_show.detected',
          key: newId,
          sourceModule: 'transport',
          payload: {
            alertId: newId,
            studentId: e.student_id,
            routeId: e.route_id,
            expectedStopId: e.stop_id,
            expectedDate: today,
            direction: e.direction,
          },
        });
      }
    }

    this.logger.log(
      `[no-show-worker] tenant=${tenant.schoolId} date=${today} expected=${expected.length} inserted=${inserted.length}`,
    );
    return { inserted: inserted.length, insertedIds: inserted };
  }
}
