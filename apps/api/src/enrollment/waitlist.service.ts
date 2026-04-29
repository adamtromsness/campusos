import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { ResolvedActor } from '../iam/actor-context.service';
import { CapacitySummaryService } from './capacity-summary.service';
import {
  ListWaitlistQueryDto,
  OfferFromWaitlistDto,
  WaitlistEntryResponseDto,
} from './dto/waitlist.dto';

interface WaitlistRow {
  id: string;
  school_id: string;
  enrollment_period_id: string;
  application_id: string;
  student_first_name: string;
  student_last_name: string;
  grade_level: string;
  priority_score: string;
  position: number;
  status: string;
  added_at: string;
  offered_at: string | null;
}

function waitlistRowToDto(r: WaitlistRow): WaitlistEntryResponseDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    enrollmentPeriodId: r.enrollment_period_id,
    applicationId: r.application_id,
    studentFirstName: r.student_first_name,
    studentLastName: r.student_last_name,
    gradeLevel: r.grade_level,
    priorityScore: Number(r.priority_score),
    position: Number(r.position),
    status: r.status as WaitlistEntryResponseDto['status'],
    addedAt: r.added_at,
    offeredAt: r.offered_at,
  };
}

var SELECT_WAITLIST_BASE =
  'SELECT w.id, w.school_id, w.enrollment_period_id, w.application_id, ' +
  'a.student_first_name, a.student_last_name, w.grade_level, w.priority_score::text, ' +
  'w.position, w.status, w.added_at, w.offered_at ' +
  'FROM enr_waitlist_entries w ' +
  'JOIN enr_applications a ON a.id = w.application_id ';

@Injectable()
export class WaitlistService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly kafka: KafkaProducerService,
    private readonly capacity: CapacitySummaryService,
  ) {}

  /**
   * List waitlist entries. Admin-only — non-admins do not see the
   * waitlist directly; their own waitlisted state surfaces via their
   * application status.
   */
  async list(
    query: ListWaitlistQueryDto,
    actor: ResolvedActor,
  ): Promise<WaitlistEntryResponseDto[]> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can read the waitlist directly');
    }
    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      var sql = SELECT_WAITLIST_BASE + 'WHERE 1=1 ';
      var params: any[] = [];
      var idx = 1;
      if (query.enrollmentPeriodId) {
        sql += 'AND w.enrollment_period_id = $' + idx + '::uuid ';
        params.push(query.enrollmentPeriodId);
        idx++;
      }
      if (query.gradeLevel) {
        sql += 'AND w.grade_level = $' + idx + ' ';
        params.push(query.gradeLevel);
        idx++;
      }
      if (query.status) {
        sql += 'AND w.status = $' + idx + ' ';
        params.push(query.status);
        idx++;
      }
      sql += 'ORDER BY w.grade_level, w.position';
      return client.$queryRawUnsafe<WaitlistRow[]>(sql, ...params);
    });
    return rows.map(waitlistRowToDto);
  }

  /**
   * Move a waitlisted applicant to the offer stage. Locks the waitlist
   * row (state-machine transition) inside the same tx that flips its
   * status to OFFERED, flips the parent application to ACCEPTED, and
   * inserts the new enr_offers row. Admin-only.
   *
   * The schema's UNIQUE on enr_offers.application_id is the safety net
   * if a race somehow slips by — second admin attempt fails with 23505
   * which we surface as 400.
   */
  async offerFromWaitlist(
    waitlistEntryId: string,
    body: OfferFromWaitlistDto,
    actor: ResolvedActor,
  ): Promise<WaitlistEntryResponseDto> {
    if (!actor.isSchoolAdmin) {
      throw new ForbiddenException('Only admins can offer from the waitlist');
    }
    var schoolId = getCurrentTenant().schoolId;
    var nowIso = new Date().toISOString();
    if (new Date(body.responseDeadline) <= new Date(nowIso)) {
      throw new BadRequestException('responseDeadline must be after now');
    }

    var snapshot = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var rows = (await tx.$queryRawUnsafe(
        'SELECT w.id, w.application_id, w.status, w.enrollment_period_id, w.grade_level, ' +
          'a.status AS application_status, a.applying_for_grade ' +
          'FROM enr_waitlist_entries w JOIN enr_applications a ON a.id = w.application_id ' +
          'WHERE w.id = $1::uuid FOR UPDATE OF w, a',
        waitlistEntryId,
      )) as Array<{
        id: string;
        application_id: string;
        status: string;
        enrollment_period_id: string;
        grade_level: string;
        application_status: string;
        applying_for_grade: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Waitlist entry ' + waitlistEntryId + ' not found');
      }
      var entry = rows[0]!;
      if (entry.status !== 'ACTIVE') {
        throw new BadRequestException(
          'Waitlist entry is in status ' + entry.status + '; only ACTIVE entries can be offered',
        );
      }

      var existingOffer = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_offers WHERE application_id = $1::uuid',
        entry.application_id,
      )) as Array<{ id: string }>;
      if (existingOffer.length > 0) {
        throw new BadRequestException('Application already has an offer issued');
      }

      var offerId = generateId();
      await tx.$executeRawUnsafe(
        'INSERT INTO enr_offers (id, school_id, application_id, offer_type, issued_at, response_deadline, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNCONDITIONAL', $4::timestamptz, $5::timestamptz, 'ISSUED')",
        offerId,
        schoolId,
        entry.application_id,
        nowIso,
        body.responseDeadline,
      );
      // Application moves to ACCEPTED so an offer is sitting on top of an
      // accepted application — same shape as the standard accept path.
      await tx.$executeRawUnsafe(
        "UPDATE enr_applications SET status = 'ACCEPTED', reviewed_at = now(), reviewed_by = $1::uuid, updated_at = now() WHERE id = $2::uuid",
        actor.accountId,
        entry.application_id,
      );
      await tx.$executeRawUnsafe(
        "UPDATE enr_waitlist_entries SET status = 'OFFERED', offered_at = $1::timestamptz, updated_at = now() WHERE id = $2::uuid",
        nowIso,
        waitlistEntryId,
      );
      await this.capacity.recompute(tx, entry.enrollment_period_id, entry.applying_for_grade);
      return { entry: entry, offerId: offerId };
    });

    void this.kafka.emit({
      topic: 'enr.application.status_changed',
      key: snapshot.entry.application_id,
      sourceModule: 'enrollment',
      payload: {
        applicationId: snapshot.entry.application_id,
        previousStatus: snapshot.entry.application_status,
        newStatus: 'ACCEPTED',
        reviewedBy: actor.accountId,
      },
    });
    void this.kafka.emit({
      topic: 'enr.offer.issued',
      key: snapshot.offerId,
      sourceModule: 'enrollment',
      payload: {
        offerId: snapshot.offerId,
        applicationId: snapshot.entry.application_id,
        offerType: 'UNCONDITIONAL',
        responseDeadline: body.responseDeadline,
        applyingForGrade: snapshot.entry.applying_for_grade,
        promotedFromWaitlist: true,
      },
    });

    var rows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<WaitlistRow[]>(
        SELECT_WAITLIST_BASE + 'WHERE w.id = $1::uuid',
        waitlistEntryId,
      );
    });
    return waitlistRowToDto(rows[0]!);
  }
}
