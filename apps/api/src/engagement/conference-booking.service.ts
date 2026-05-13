import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { assertConferenceAdmin, isUniqueViolation } from './access';
import type {
  BookSlotDto,
  CancelBookingDto,
  ConferenceBookingDto,
  FollowUpAction,
  UpdateBookingDto,
} from './dto/engagement.dto';

interface BookingRow {
  id: string;
  slot_id: string;
  school_id: string;
  parent_id: string;
  student_id: string;
  booked_at: string;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  attended: boolean | null;
  conference_notes: string | null;
  follow_up_actions: unknown;
  parent_feedback_rating: number | null;
  parent_feedback_comments: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class ConferenceBookingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permCheck: PermissionCheckService,
  ) {}

  /**
   * REVIEW-P2C24 — admin tier for booking-on-behalf-of paths. Returns
   * true for school admin OR any non-parent actor holding mtg-002:write
   * or mtg-002:admin at the tenant scope. Used by book() to decide
   * whether to validate studentId against the guardian-link chain
   * (parent path) or just against current-school ownership (admin path).
   */
  private async isConferenceAdmin(actor: ResolvedActor, schoolId: string): Promise<boolean> {
    if (actor.isSchoolAdmin) return true;
    if (actor.personType === 'GUARDIAN' || actor.personType === 'STUDENT') return false;
    return this.permCheck.hasAnyPermissionInTenant(actor.accountId, schoolId, [
      'mtg-002:write',
      'mtg-002:admin',
    ]);
  }

  private toDto(row: BookingRow): ConferenceBookingDto {
    let follow: FollowUpAction[] | null = null;
    if (Array.isArray(row.follow_up_actions)) {
      follow = row.follow_up_actions as FollowUpAction[];
    } else if (row.follow_up_actions && typeof row.follow_up_actions === 'string') {
      try {
        const parsed = JSON.parse(row.follow_up_actions);
        if (Array.isArray(parsed)) follow = parsed as FollowUpAction[];
      } catch {
        follow = null;
      }
    }
    return {
      id: row.id,
      slotId: row.slot_id,
      schoolId: row.school_id,
      parentId: row.parent_id,
      studentId: row.student_id,
      bookedAt: row.booked_at,
      cancelledAt: row.cancelled_at,
      cancelledBy: row.cancelled_by,
      cancellationReason: row.cancellation_reason,
      attended: row.attended,
      conferenceNotes: row.conference_notes,
      followUpActions: follow,
      parentFeedbackRating:
        row.parent_feedback_rating === null ? null : Number(row.parent_feedback_rating),
      parentFeedbackComments: row.parent_feedback_comments,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private bookingSelectSql(): string {
    return `SELECT id::text AS id, slot_id::text AS slot_id, school_id::text AS school_id,
                   parent_id::text AS parent_id, student_id::text AS student_id,
                   booked_at::text AS booked_at,
                   cancelled_at::text AS cancelled_at,
                   cancelled_by::text AS cancelled_by,
                   cancellation_reason,
                   attended, conference_notes, follow_up_actions,
                   parent_feedback_rating, parent_feedback_comments,
                   created_at::text AS created_at, updated_at::text AS updated_at
            FROM eng_conference_bookings`;
  }

  /**
   * Parent: own bookings only.
   * Staff/admin: all (filtered by ?slotId, ?parentId).
   */
  async listMine(actor: ResolvedActor): Promise<ConferenceBookingDto[]> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.bookingSelectSql() +
          ' WHERE school_id = $1::uuid AND parent_id = $2::uuid ORDER BY booked_at DESC',
        tenant.schoolId,
        actor.accountId,
      );
    })) as BookingRow[];
    return rows.map((r) => this.toDto(r));
  }

  async list(
    actor: ResolvedActor,
    filters: { slotId?: string; parentId?: string; studentId?: string } = {},
  ): Promise<ConferenceBookingDto[]> {
    await assertConferenceAdmin(actor, this.permCheck, 'Listing bookings across families');
    const tenant = getCurrentTenant();
    const args: unknown[] = [tenant.schoolId];
    let where = ' WHERE school_id = $1::uuid';
    if (filters.slotId) {
      args.push(filters.slotId);
      where += ' AND slot_id = $' + args.length + '::uuid';
    }
    if (filters.parentId) {
      args.push(filters.parentId);
      where += ' AND parent_id = $' + args.length + '::uuid';
    }
    if (filters.studentId) {
      args.push(filters.studentId);
      where += ' AND student_id = $' + args.length + '::uuid';
    }
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.bookingSelectSql() + where + ' ORDER BY booked_at DESC',
        ...args,
      );
    })) as BookingRow[];
    return rows.map((r) => this.toDto(r));
  }

  async getById(actor: ResolvedActor, id: string): Promise<ConferenceBookingDto> {
    const tenant = getCurrentTenant();
    const rows = (await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe(
        this.bookingSelectSql() + ' WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      );
    })) as BookingRow[];
    if (rows.length === 0) {
      throw new NotFoundException(`Booking ${id} not found`);
    }
    const row = rows[0]!;
    // Parent row-scope: own bookings only
    if (
      actor.personType === 'GUARDIAN' &&
      row.parent_id !== actor.accountId &&
      !actor.isSchoolAdmin
    ) {
      throw new NotFoundException(`Booking ${id} not found`);
    }
    if (actor.personType === 'STUDENT') {
      // Students don't see conference bookings — engagement is parent surface
      throw new ForbiddenException('Conference bookings are restricted to parents and staff');
    }
    return this.toDto(row);
  }

  /**
   * THE ATOMIC SLOT BOOKING KEYSTONE.
   *
   * Implements the canonical lock-free booking pattern:
   *   UPDATE eng_conference_slots
   *   SET status = 'BOOKED', current_bookings = current_bookings + 1, updated_at = now()
   *   WHERE id = $1::uuid AND school_id = $2::uuid AND status = 'AVAILABLE'
   *   RETURNING id
   *
   * Zero rows returned means the slot was already booked / blocked /
   * does not exist — we translate that to 409 Conflict. The race is
   * impossible: Postgres serialises concurrent UPDATEs on the same row
   * and exactly one wins the AVAILABLE -> BOOKED transition.
   *
   * For slots with max_bookings > 1 (group sessions), we accept the
   * booking while current_bookings < max_bookings AND status='AVAILABLE'.
   * When current_bookings + 1 reaches max_bookings the slot flips to
   * BOOKED in the same UPDATE.
   *
   * The booking window enforcement (before booking_opens_at or after
   * booking_closes_at) is checked outside the locked UPDATE because
   * the conference event row is rarely contended; the window check
   * is a service-layer pre-flight 400, not a race.
   */
  async book(
    actor: ResolvedActor,
    slotId: string,
    input: BookSlotDto,
  ): Promise<ConferenceBookingDto> {
    if (actor.personType === 'STUDENT') {
      throw new ForbiddenException('Students cannot book parent-teacher conference slots');
    }
    const tenant = getCurrentTenant();

    const newBookingId = generateId();
    const insertedId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      // Load slot + parent conference event for window check
      const slotRows = (await tx.$queryRawUnsafe(
        `SELECT s.id::text AS id, s.conference_event_id::text AS conference_event_id,
                  s.max_bookings, s.current_bookings, s.status,
                  e.booking_opens_at::text AS booking_opens_at,
                  e.booking_closes_at::text AS booking_closes_at,
                  e.status AS event_status
           FROM eng_conference_slots s
           JOIN eng_conference_events e ON e.id = s.conference_event_id
           WHERE s.school_id = $1::uuid AND s.id = $2::uuid
           LIMIT 1`,
        tenant.schoolId,
        slotId,
      )) as Array<{
        id: string;
        conference_event_id: string;
        max_bookings: number;
        current_bookings: number;
        status: string;
        booking_opens_at: string;
        booking_closes_at: string;
        event_status: string;
      }>;
      if (slotRows.length === 0) {
        throw new NotFoundException(`Slot ${slotId} not found`);
      }
      const slot = slotRows[0]!;

      if (slot.event_status === 'COMPLETED') {
        throw new BadRequestException('Conference event is COMPLETED — booking is closed');
      }

      // Window enforcement — admin can override via the conference admin
      // path (assertConferenceAdmin); regular parents must respect the
      // window. Status of the event being DRAFT also means we are
      // pre-window.
      const now = Date.now();
      const opensAt = Date.parse(slot.booking_opens_at);
      const closesAt = Date.parse(slot.booking_closes_at);
      if (!actor.isSchoolAdmin) {
        if (now < opensAt) {
          throw new BadRequestException(
            `Booking opens at ${slot.booking_opens_at}. The window is not yet open.`,
          );
        }
        if (now > closesAt) {
          throw new BadRequestException(`Booking closed at ${slot.booking_closes_at}.`);
        }
      }

      // REVIEW-P2C24 BLOCKING 1 — Validate student is in current school AND
      // (for parent actors) is linked to this parent via sis_student_guardians.
      // Admin / conference-admin path skips the guardian-link check but
      // ALWAYS enforces school ownership. Mirrors the Cycle 6 family-account
      // student attach contract.
      const isConferenceAdmin = await this.isConferenceAdmin(actor, tenant.schoolId);
      if (isConferenceAdmin) {
        const stu = (await tx.$queryRawUnsafe(
          `SELECT id::text FROM sis_students
           WHERE id = $1::uuid AND school_id = $2::uuid
           LIMIT 1`,
          input.studentId,
          tenant.schoolId,
        )) as Array<{ id: string }>;
        if (stu.length === 0) {
          throw new BadRequestException(
            `studentId ${input.studentId} does not match a student in this school`,
          );
        }
      } else {
        // Parent / guardian — must be linked to this student
        const link = (await tx.$queryRawUnsafe(
          `SELECT s.id::text
             FROM sis_students s
             JOIN sis_student_guardians sg ON sg.student_id = s.id
             JOIN sis_guardians g ON g.id = sg.guardian_id
            WHERE s.school_id = $1::uuid
              AND s.id = $2::uuid
              AND g.person_id = $3::uuid
            LIMIT 1`,
          tenant.schoolId,
          input.studentId,
          actor.personId,
        )) as Array<{ id: string }>;
        if (link.length === 0) {
          throw new BadRequestException(
            `studentId ${input.studentId} is not linked to your account in this school`,
          );
        }
      }

      // For individual slots (max_bookings=1) the atomic transition is
      // status=AVAILABLE -> BOOKED. For group slots, increment current_bookings
      // and flip to BOOKED only when it reaches max_bookings.
      const updated = (await tx.$queryRawUnsafe(
        `UPDATE eng_conference_slots
           SET current_bookings = current_bookings + 1,
               status = CASE
                 WHEN current_bookings + 1 >= max_bookings THEN 'BOOKED'
                 ELSE status
               END,
               updated_at = now()
           WHERE id = $1::uuid
             AND school_id = $2::uuid
             AND status = 'AVAILABLE'
             AND current_bookings < max_bookings
           RETURNING id::text`,
        slotId,
        tenant.schoolId,
      )) as Array<{ id: string }>;
      if (updated.length === 0) {
        throw new ConflictException(`Slot ${slotId} is already booked or no longer available`);
      }

      // Insert booking row. The partial UNIQUE WHERE cancelled_at IS NULL
      // prevents the same (slot, parent, student) triple from holding two
      // active bookings concurrently.
      try {
        await tx.$executeRawUnsafe(
          `INSERT INTO eng_conference_bookings
               (id, slot_id, school_id, parent_id, student_id, booked_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now())`,
          newBookingId,
          slotId,
          tenant.schoolId,
          actor.accountId,
          input.studentId,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Roll back the slot transition by throwing — the outer tx will
          // abort the UPDATE. We surface a friendly 409.
          throw new ConflictException(
            `You already have an active booking for this slot and student`,
          );
        }
        throw err;
      }
      return newBookingId;
    });

    return this.getById(actor, insertedId);
  }

  async cancel(
    actor: ResolvedActor,
    id: string,
    input: CancelBookingDto,
  ): Promise<ConferenceBookingDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, slot_id::text AS slot_id,
                parent_id::text AS parent_id, cancelled_at::text AS cancelled_at
         FROM eng_conference_bookings
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; slot_id: string; parent_id: string; cancelled_at: string | null }>;
      if (rows.length === 0) {
        throw new NotFoundException(`Booking ${id} not found`);
      }
      const before = rows[0]!;
      if (before.cancelled_at) {
        throw new BadRequestException('Booking is already cancelled');
      }

      // Authorise: owner OR conference admin
      const isOwner = before.parent_id === actor.accountId;
      if (!isOwner && !actor.isSchoolAdmin) {
        const ok = await this.permCheck.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
          'mtg-002:write',
          'mtg-002:admin',
        ]);
        if (!ok) {
          throw new ForbiddenException(
            'Only the booking owner or a school administrator can cancel this booking',
          );
        }
      }

      // Flip booking to cancelled
      await tx.$executeRawUnsafe(
        `UPDATE eng_conference_bookings
         SET cancelled_at = now(), cancelled_by = $1::uuid,
             cancellation_reason = $2, updated_at = now()
         WHERE school_id = $3::uuid AND id = $4::uuid`,
        actor.accountId,
        input.reason ?? null,
        tenant.schoolId,
        id,
      );

      // Decrement slot.current_bookings + flip status back to AVAILABLE
      // when it drops to 0. The schema CHECK keeps current_bookings >= 0.
      await tx.$executeRawUnsafe(
        `UPDATE eng_conference_slots
         SET current_bookings = GREATEST(current_bookings - 1, 0),
             status = CASE
               WHEN GREATEST(current_bookings - 1, 0) = 0 AND status = 'BOOKED' THEN 'AVAILABLE'
               ELSE status
             END,
             updated_at = now()
         WHERE school_id = $1::uuid AND id = $2::uuid`,
        tenant.schoolId,
        before.slot_id,
      );
    });
    return this.getById(actor, id);
  }

  /**
   * Teacher / admin: mark attended, write notes, add follow-up actions.
   * Parent: post-meeting rating + comments.
   */
  async patch(
    actor: ResolvedActor,
    id: string,
    input: UpdateBookingDto,
  ): Promise<ConferenceBookingDto> {
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        `SELECT id::text AS id, parent_id::text AS parent_id
         FROM eng_conference_bookings
         WHERE school_id = $1::uuid AND id = $2::uuid
         FOR UPDATE`,
        tenant.schoolId,
        id,
      )) as Array<{ id: string; parent_id: string }>;
      if (rows.length === 0) {
        throw new NotFoundException(`Booking ${id} not found`);
      }
      const before = rows[0]!;

      const isOwner = before.parent_id === actor.accountId;
      const wantsStaffFields =
        input.attended !== undefined ||
        input.conferenceNotes !== undefined ||
        input.followUpActions !== undefined;
      const wantsParentFields =
        input.parentFeedbackRating !== undefined || input.parentFeedbackComments !== undefined;

      // REVIEW-P2C24 BLOCKING 3 — Staff outcome fields require
      // mtg-002:write or :admin (not just personType=STAFF). The
      // controller gate is mtg-002:read so parents can reach the
      // endpoint to write their own feedback; field-level authority
      // is the actual access boundary.
      if (wantsStaffFields) {
        const canWriteStaffFields = await this.isConferenceAdmin(actor, tenant.schoolId);
        if (!canWriteStaffFields) {
          throw new ForbiddenException(
            'Marking attendance, writing notes, or adding follow-up actions requires mtg-002:write or :admin',
          );
        }
      }
      // Parent feedback fields are owner-only. Staff cannot author
      // parent feedback on the parent's behalf — pre-pilot we can
      // introduce a dedicated correction workflow if schools ask for
      // it, but the default contract is "parent writes their own
      // satisfaction rating".
      if (wantsParentFields && !isOwner) {
        throw new ForbiddenException(
          'Only the booking owner (the parent) can submit parent feedback',
        );
      }

      const fields: string[] = [];
      const args: unknown[] = [];
      let pos = 1;
      if (input.attended !== undefined) {
        fields.push(`attended = $${pos}`);
        args.push(input.attended);
        pos += 1;
      }
      if (input.conferenceNotes !== undefined) {
        fields.push(`conference_notes = $${pos}`);
        args.push(input.conferenceNotes);
        pos += 1;
      }
      if (input.followUpActions !== undefined) {
        fields.push(`follow_up_actions = $${pos}::jsonb`);
        args.push(JSON.stringify(input.followUpActions));
        pos += 1;
      }
      if (input.parentFeedbackRating !== undefined) {
        fields.push(`parent_feedback_rating = $${pos}`);
        args.push(input.parentFeedbackRating);
        pos += 1;
      }
      if (input.parentFeedbackComments !== undefined) {
        fields.push(`parent_feedback_comments = $${pos}`);
        args.push(input.parentFeedbackComments);
        pos += 1;
      }
      fields.push('updated_at = now()');

      if (fields.length === 1) return;

      args.push(tenant.schoolId, id);
      const sql =
        'UPDATE eng_conference_bookings SET ' +
        fields.join(', ') +
        ` WHERE school_id = $${pos}::uuid AND id = $${pos + 1}::uuid`;
      await tx.$executeRawUnsafe(sql, ...args);
    });
    return this.getById(actor, id);
  }
}
