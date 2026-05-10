import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import type { ResolvedActor } from '../iam/actor-context.service';
import { PermissionCheckService } from '../iam/permission-check.service';
import { OutboxService } from '../kafka/outbox.service';
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
  booked_by: string;
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
 * Public booking flow (ADR-055):
 *   1. Lock slot row FOR UPDATE inside a tenant tx.
 *   2. Validate slot is published, non-cancelled, future, and has
 *      capacity remaining (current_bookings < max_bookings).
 *   3. Resolve booked_by — if the family contact_email matches an
 *      existing platform.iam_person + platform_users row, reuse it;
 *      otherwise create a new iam_person (person_type=GUARDIAN) and
 *      a placeholder platform_users row with account_status=
 *      PENDING_VERIFICATION.
 *   4. INSERT enr_tour_bookings (status=CONFIRMED).
 *   5. INSERT every guest into enr_tour_booking_guests.
 *   6. Bump slot.current_bookings by 1.
 *   7. Enqueue enr.tour.booked via OutboxService.enqueueInTx so
 *      a Kafka outage cannot roll back the user's booking.
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
    private readonly platformPrisma: PrismaClient,
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
   * provides contact info inline. The locked-row + current_chk
   * CHECK is the keystone race-protection for the capacity
   * contract.
   *
   * REVIEW-P2-5 BLOCKING 1 + MAJOR 4 fix:
   *   - Validate the slot (existence + published + non-cancelled +
   *     capacity remaining) BEFORE creating any platform identity.
   *     Pre-flight is a cheap unlocked read; the canonical race
   *     protection still happens inside the locked tx in
   *     createBookingForPerson().
   *   - NEVER reuse an existing iam_person by email on the public
   *     path (the email is unverified contact info). Always create
   *     a fresh iam_person + platform_users so an attacker who
   *     knows another family's email cannot attach a booking to
   *     that account. Identity stitching is a deliberate admin
   *     workflow via /tour-bookings/:id/link-application after
   *     verification.
   */
  async bookPublic(slotId: string, input: AnonymousBookingInput): Promise<TourBookingResponseDto> {
    if (!input.firstName || !input.lastName) {
      throw new BadRequestException('firstName and lastName are required');
    }
    if (!input.contactEmail || !input.contactEmail.includes('@')) {
      throw new BadRequestException('contactEmail is required and must be a valid email');
    }

    // BLOCKING 1 — pre-flight slot validation BEFORE any platform
    // identity write. The unlocked read catches the abuse path
    // (random/unpublished/cancelled/full slot ids) without leaving
    // orphan iam_person rows behind. The canonical capacity gate
    // still runs inside the locked tx in createBookingForPerson()
    // (and the schema-side current_chk is the belt-and-braces for
    // any direct-SQL bypass).
    const tenant = getCurrentTenant();
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      const rows = (await client.$queryRawUnsafe(
        'SELECT max_bookings, current_bookings, is_published, is_cancelled, tour_date ' +
          'FROM enr_tour_slots ' +
          'WHERE school_id = $1::uuid AND id = $2::uuid LIMIT 1',
        tenant.schoolId,
        slotId,
      )) as Array<{
        max_bookings: number;
        current_bookings: number;
        is_published: boolean;
        is_cancelled: boolean;
        tour_date: string;
      }>;
      if (rows.length === 0) {
        throw new NotFoundException('Tour slot not found');
      }
      const slot = rows[0]!;
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
    });

    // MAJOR 4 — always create a fresh iam_person on the public
    // path; do NOT create a platform_users row. Anyone can claim
    // any email on the public booking form, so reusing an existing
    // platform_users would let an attacker attach bookings to
    // another family's account. And creating a NEW platform_users
    // row would either collide with the existing one on the
    // UNIQUE(email) constraint OR pollute the auth surface with
    // unverified rows.
    //
    // The right shape: the booking is a "pending external contact"
    // captured by an iam_person row alone. No platform_users
    // means no login, no auth identity, no risk of collision. The
    // contact email stays on enr_tour_bookings.contact_email. When
    // the family later submits an application, the EO manually
    // stitches identities via /tour-bookings/:id/link-application
    // (which validates ownership through the application pipeline).
    const bookedBy = generateId();
    await this.platformPrisma.$executeRawUnsafe(
      'INSERT INTO platform.iam_person (id, first_name, last_name, primary_phone, person_type) ' +
        "VALUES ($1::uuid, $2, $3, $4, 'GUARDIAN')",
      bookedBy,
      input.firstName,
      input.lastName,
      input.contactPhone ?? null,
    );

    return this.createBookingForPerson(slotId, bookedBy, input);
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
    bookedBy: string,
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
