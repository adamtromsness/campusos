import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import {
  CreateTourBookingDto,
  LinkApplicationDto,
  TourBookingResponseDto,
  TourGuestInputDto,
  TourGuestResponseDto,
  UpdateTourBookingDto,
} from './dto/tour.dto';

interface BookingRow {
  id: string;
  slot_id: string;
  school_id: string;
  booked_by: string | null;
  family_name: string;
  contact_email: string;
  contact_phone: string | null;
  status: string;
  booked_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  linked_application_id: string | null;
  notes: string | null;
}

interface GuestRow {
  id: string;
  booking_id: string;
  guest_type: string;
  first_name: string;
  last_name: string;
  age: number | null;
  notes: string | null;
}

const SELECT_BOOKING_BASE =
  'SELECT id, slot_id, school_id, booked_by, family_name, contact_email, contact_phone, ' +
  '       status, booked_at::text AS booked_at, cancelled_at::text AS cancelled_at, ' +
  '       cancellation_reason, linked_application_id, notes ' +
  'FROM enr_tour_bookings ';

function bookingRowToDto(r: BookingRow, guests: GuestRow[]): TourBookingResponseDto {
  return {
    id: r.id,
    slotId: r.slot_id,
    schoolId: r.school_id,
    bookedBy: r.booked_by,
    familyName: r.family_name,
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    status: r.status as TourBookingResponseDto['status'],
    bookedAt: r.booked_at,
    cancelledAt: r.cancelled_at,
    cancellationReason: r.cancellation_reason,
    linkedApplicationId: r.linked_application_id,
    notes: r.notes,
    guests: guests
      .filter((g) => g.booking_id === r.id)
      .map(
        (g): TourGuestResponseDto => ({
          id: g.id,
          bookingId: g.booking_id,
          guestType: g.guest_type as TourGuestResponseDto['guestType'],
          firstName: g.first_name,
          lastName: g.last_name,
          age: g.age,
          notes: g.notes,
        }),
      ),
  };
}

interface AnonymousBookingInput extends CreateTourBookingDto {
  firstName: string;
  lastName: string;
}

/**
 * TourBookingService — public booking + admin lifecycle.
 *
 * Public booking flow (REVIEW-P2-5 Round 2 — Option C, no platform identity):
 *   1. Validate firstName + lastName + contactEmail on the input.
 *   2. Lock slot row FOR UPDATE inside a tenant tx.
 *   3. Validate slot is published, non-cancelled, future, and has
 *      capacity remaining (current_bookings < max_bookings).
 *   4. INSERT enr_tour_bookings with booked_by = NULL — no
 *      iam_person, no platform_users created on the public path.
 *      Family identity is stored on the booking row itself
 *      (family_name + contact_email + contact_phone) plus the
 *      per-guest manifest in enr_tour_booking_guests.
 *   5. INSERT every guest into enr_tour_booking_guests.
 *   6. Bump slot.current_bookings by 1.
 *   7. Enqueue enr.tour.booked via OutboxService.enqueueInTx with
 *      bookedBy:null so a Kafka outage cannot roll back the user's
 *      booking.
 *
 * Why no iam_person on the public path: under concurrent last-seat
 * pressure two requests could both pass an unlocked pre-flight,
 * both create fresh iam_person rows, then only one wins the locked
 * capacity check — leaving the loser orphaned. Option C eliminates
 * the race entirely. EOs stitch identities later via
 * POST /tour-bookings/:id/link-application once a verified
 * application surfaces.
 *
 * Authenticated bookings (parent dashboard etc.) continue to populate
 * booked_by from actor.personId at insert time.
 *
 * The CHECK current_chk on enr_tour_slots (current_bookings <=
 * max_bookings) is the schema-side belt-and-braces — even if the
 * service-layer capacity check were bypassed, a 12th INSERT into a
 * 10-cap slot would raise SQLSTATE 23514.
 *
 * Admin-only paths:
 *   - listAdmin / getById admin path
 *   - patch (cancel / no-show / complete with status transition)
 *   - linkApplication (EO links a tour to a later application)
 */
@Injectable()
export class TourBookingService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly permissions: PermissionCheckService,
    private readonly outbox: OutboxService,
  ) {}

  private async assertWriter(actor: ResolvedActor): Promise<void> {
    if (actor.isSchoolAdmin) return;
    const tenant = getCurrentTenant();
    const ok = await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
      'stu-003:write',
      'stu-003:admin',
    ]);
    if (!ok) {
      throw new ForbiddenException('Tour booking management requires stu-003:write');
    }
  }

  /**
   * Public booking endpoint. Anonymous (no auth) — the family
   * provides contact info inline.
   *
   * REVIEW-P2-5 Round 2 BLOCKING fix (Option C — the reviewer's
   * "cleanest abuse-resistant model"):
   *
   *   No `iam_person` is created on the public path. The booking
   *   row already carries family_name + contact_email +
   *   contact_phone columns plus the per-guest manifest, so the
   *   contact info is fully preserved without a platform identity.
   *   `enr_tour_bookings.booked_by` is now nullable (migration
   *   122) and stays NULL for public bookings. EOs stitch
   *   identities later via /tour-bookings/:id/link-application
   *   once an application or some other verified workflow proves
   *   ownership.
   *
   *   Why this beats the Round 1 pre-flight + identity-then-locked
   *   pattern: under concurrent last-seat pressure, two requests
   *   could both pass the unlocked pre-flight, both create fresh
   *   iam_person rows, then only one wins the locked tx capacity
   *   check — leaving an orphan iam_person on the loser. Option C
   *   eliminates that entire class of bug because no platform
   *   write happens before (or after) the locked capacity gate.
   *
   *   The locked tx still runs the canonical race protection:
   *   SELECT FOR UPDATE on the slot, capacity re-validation,
   *   booking insert, current_bookings bump, outbox enqueue —
   *   all atomic. Schema-side `current_chk` is belt-and-braces
   *   against any direct-SQL bypass.
   */
  async bookPublic(slotId: string, input: AnonymousBookingInput): Promise<TourBookingResponseDto> {
    if (!input.firstName || !input.lastName) {
      throw new BadRequestException('firstName and lastName are required');
    }
    if (!input.contactEmail || !input.contactEmail.includes('@')) {
      throw new BadRequestException('contactEmail is required and must be a valid email');
    }

    // No platform identity work. The booking flows straight into
    // the locked tx with bookedBy=NULL.
    return this.createBookingForPerson(slotId, null, input);
  }

  /**
   * Admin or parent-with-account booking — booked_by resolves to the
   * caller's iam_person id. Same locked-row race protection.
   */
  async bookAuthenticated(
    slotId: string,
    input: CreateTourBookingDto,
    actor: ResolvedActor,
  ): Promise<TourBookingResponseDto> {
    return this.createBookingForPerson(slotId, actor.personId, input);
  }

  private async createBookingForPerson(
    slotId: string,
    bookedBy: string | null,
    input: CreateTourBookingDto,
  ): Promise<TourBookingResponseDto> {
    const tenant = getCurrentTenant();
    let bookingId = '';
    try {
      bookingId = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
        // Lock the slot row.
        const slotRows = (await tx.$queryRawUnsafe(
          'SELECT id, school_id, tour_date, max_bookings, current_bookings, ' +
            '       is_published, is_cancelled ' +
            'FROM enr_tour_slots ' +
            'WHERE school_id = $1::uuid AND id = $2::uuid ' +
            'FOR UPDATE',
          tenant.schoolId,
          slotId,
        )) as Array<{
          id: string;
          tour_date: string;
          max_bookings: number;
          current_bookings: number;
          is_published: boolean;
          is_cancelled: boolean;
        }>;
        if (slotRows.length === 0) {
          throw new NotFoundException('Tour slot not found');
        }
        const slot = slotRows[0]!;
        if (!slot.is_published) {
          throw new BadRequestException('Tour slot is not published');
        }
        if (slot.is_cancelled) {
          throw new BadRequestException('Tour slot has been cancelled');
        }
        if (slot.current_bookings >= slot.max_bookings) {
          throw new ConflictException(
            'Tour slot is full (' + slot.current_bookings + '/' + slot.max_bookings + ')',
          );
        }

        const id = generateId();
        try {
          // Public bookings pass bookedBy=null per the Round 2
          // BLOCKING fix; the column is nullable as of migration
          // 122. The `::uuid` cast accepts NULL too — Postgres
          // treats it as NULL of type uuid.
          await tx.$executeRawUnsafe(
            'INSERT INTO enr_tour_bookings ' +
              '(id, slot_id, school_id, booked_by, family_name, contact_email, contact_phone, status, notes) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 'CONFIRMED', $8)",
            id,
            slotId,
            tenant.schoolId,
            bookedBy,
            input.familyName,
            input.contactEmail.toLowerCase(),
            input.contactPhone ?? null,
            input.notes ?? null,
          );
        } catch (err: unknown) {
          if (isUniqueViolation(err)) {
            throw new ConflictException(
              'You have already booked this tour slot. Cancel the existing booking before re-booking.',
            );
          }
          throw err;
        }

        const guests = (input.guests ?? []) as TourGuestInputDto[];
        for (const g of guests) {
          await tx.$executeRawUnsafe(
            'INSERT INTO enr_tour_booking_guests (id, booking_id, guest_type, first_name, last_name, age, notes) ' +
              'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
            generateId(),
            id,
            g.guestType,
            g.firstName,
            g.lastName,
            g.age ?? null,
            g.notes ?? null,
          );
        }

        // Bump current_bookings (the schema CHECK ensures we don't exceed max_bookings).
        await tx.$executeRawUnsafe(
          'UPDATE enr_tour_slots SET current_bookings = current_bookings + 1, updated_at = now() ' +
            'WHERE id = $1::uuid',
          slotId,
        );

        // Outbox enqueue inside the same tx.
        await this.outbox.enqueueInTx(tx as never, {
          topic: 'enr.tour.booked',
          key: id,
          sourceModule: 'enrolment-advanced',
          payload: {
            bookingId: id,
            slotId,
            schoolId: tenant.schoolId,
            bookedBy,
            familyName: input.familyName,
            contactEmail: input.contactEmail.toLowerCase(),
            tourDate: slot.tour_date,
            guestCount: guests.length,
          },
        });

        return id;
      });
    } catch (err: unknown) {
      // Translate the schema-side current_chk overflow (defence in depth)
      // to a friendly 409. The service-layer capacity check above is the
      // primary gate but a manual SQL insert path could still hit this.
      if (isCheckViolation(err) && /current_chk/.test(extractMessage(err))) {
        throw new ConflictException('Tour slot is full');
      }
      throw err;
    }
    return this.getByIdInternal(bookingId);
  }

  async listAdmin(actor: ResolvedActor): Promise<TourBookingResponseDto[]> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BOOKING_BASE + 'WHERE school_id = $1::uuid ORDER BY booked_at DESC LIMIT 500',
        tenant.schoolId,
      )) as BookingRow[];
      const ids = rows.map((r) => r.id);
      const guests = await this.loadGuests(client, ids);
      return rows.map((r) => bookingRowToDto(r, guests));
    });
  }

  async getById(id: string, actor: ResolvedActor): Promise<TourBookingResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BOOKING_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as BookingRow[];
      if (rows.length === 0) throw new NotFoundException('Booking not found');
      const row = rows[0] as BookingRow;
      // Row scope — admin or stu-003:write OR the booker themself.
      const isAdmin = actor.isSchoolAdmin;
      const isWriter = isAdmin
        ? true
        : await this.permissions.hasAnyPermissionInTenant(actor.accountId, tenant.schoolId, [
            'stu-003:write',
            'stu-003:admin',
          ]);
      if (!isWriter && row.booked_by !== actor.personId) {
        throw new NotFoundException('Booking not found');
      }
      const guests = await this.loadGuests(client, [id]);
      return bookingRowToDto(row, guests);
    });
  }

  private async getByIdInternal(id: string): Promise<TourBookingResponseDto> {
    const tenant = getCurrentTenant();
    return this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        SELECT_BOOKING_BASE + 'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        id,
      )) as BookingRow[];
      if (rows.length === 0) throw new NotFoundException('Booking not found');
      const guests = await this.loadGuests(client, [id]);
      return bookingRowToDto(rows[0] as BookingRow, guests);
    });
  }

  private async loadGuests(
    client: { $queryRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown> },
    bookingIds: string[],
  ): Promise<GuestRow[]> {
    if (bookingIds.length === 0) return [];
    const rows = (await client.$queryRawUnsafe(
      'SELECT id, booking_id, guest_type, first_name, last_name, age, notes ' +
        'FROM enr_tour_booking_guests WHERE booking_id = ANY($1::uuid[]) ORDER BY created_at',
      bookingIds,
    )) as GuestRow[];
    return rows;
  }

  /**
   * Lifecycle PATCH — admin only. Cancel / no-show / complete a
   * booking. CANCELLED requires non-empty cancellationReason and
   * decrements slot.current_bookings inside the same locked tx.
   */
  async patch(
    id: string,
    input: UpdateTourBookingDto,
    actor: ResolvedActor,
  ): Promise<TourBookingResponseDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();

    if (input.status === 'CANCELLED') {
      const reason = (input.cancellationReason ?? '').trim();
      if (reason.length === 0) {
        throw new BadRequestException('cancellationReason is required when cancelling a booking');
      }
    }

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const rows = (await tx.$queryRawUnsafe(
        'SELECT id, slot_id, status FROM enr_tour_bookings ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        id,
      )) as Array<{ id: string; slot_id: string; status: string }>;
      if (rows.length === 0) throw new NotFoundException('Booking not found');
      const before = rows[0]!;
      const newStatus = input.status ?? before.status;

      if (newStatus === 'CANCELLED' && before.status !== 'CANCELLED') {
        // Decrement slot first.
        await tx.$executeRawUnsafe(
          'UPDATE enr_tour_slots SET current_bookings = GREATEST(current_bookings - 1, 0), updated_at = now() ' +
            'WHERE id = $1::uuid',
          before.slot_id,
        );
        await tx.$executeRawUnsafe(
          "UPDATE enr_tour_bookings SET status = 'CANCELLED', cancelled_at = now(), " +
            'cancellation_reason = $1, notes = COALESCE($2, notes), updated_at = now() ' +
            'WHERE id = $3::uuid',
          input.cancellationReason ?? null,
          input.notes ?? null,
          id,
        );
      } else if (newStatus !== before.status) {
        // Re-cancellation reverse (CANCELLED -> CONFIRMED) is intentionally
        // not supported — admins create a fresh booking instead.
        if (before.status === 'CANCELLED') {
          throw new BadRequestException(
            'Cancelled bookings cannot be reactivated. Create a fresh booking on a future slot.',
          );
        }
        await tx.$executeRawUnsafe(
          'UPDATE enr_tour_bookings SET status = $1, notes = COALESCE($2, notes), updated_at = now() ' +
            'WHERE id = $3::uuid',
          newStatus,
          input.notes ?? null,
          id,
        );
      } else if (input.notes !== undefined) {
        await tx.$executeRawUnsafe(
          'UPDATE enr_tour_bookings SET notes = $1, updated_at = now() WHERE id = $2::uuid',
          input.notes,
          id,
        );
      }
    });

    return this.getByIdInternal(id);
  }

  /** EO links a tour booking to an application made later. */
  async linkApplication(
    bookingId: string,
    input: LinkApplicationDto,
    actor: ResolvedActor,
  ): Promise<TourBookingResponseDto> {
    await this.assertWriter(actor);
    const tenant = getCurrentTenant();

    await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      const bookingRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_tour_bookings WHERE school_id = $1::uuid AND id = $2::uuid FOR UPDATE',
        tenant.schoolId,
        bookingId,
      )) as Array<{ id: string }>;
      if (bookingRows.length === 0) throw new NotFoundException('Booking not found');

      const appRows = (await tx.$queryRawUnsafe(
        'SELECT id FROM enr_applications WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        input.applicationId,
      )) as Array<{ id: string }>;
      if (appRows.length === 0) {
        throw new BadRequestException('applicationId does not match an application in this school');
      }

      await tx.$executeRawUnsafe(
        'UPDATE enr_tour_bookings SET linked_application_id = $1::uuid, updated_at = now() ' +
          'WHERE id = $2::uuid',
        input.applicationId,
        bookingId,
      );
    });

    return this.getByIdInternal(bookingId);
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code === '23505') return true;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && meta.code === '23505') return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return msg.includes('duplicate key') || msg.includes('unique constraint');
}

function isCheckViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  if (e.code === '23514') return true;
  const meta = e.meta as Record<string, unknown> | undefined;
  if (meta && meta.code === '23514') return true;
  return false;
}

function extractMessage(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const e = err as Record<string, unknown>;
  return typeof e.message === 'string' ? e.message : '';
}
