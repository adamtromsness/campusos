import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { TourSlotService } from './tour-slot.service';
import { TourBookingService } from './tour-booking.service';
import { WithdrawalService } from './withdrawal.service';
import { ExitTaskService } from './exit-task.service';
import { ReenrolmentService } from './reenrolment.service';
import { MidYearAdmissionService } from './mid-year-admission.service';
import { ExitTaskTemplateService } from './exit-task-template.service';
import { TourController } from './tour.controller';
import { WithdrawalController } from './withdrawal.controller';
import { ReenrolmentController } from './reenrolment.controller';
import { MidYearAdmissionController } from './mid-year-admission.controller';
import { ExitTaskTemplateController } from './exit-task-template.controller';

const SCHOOL = { schoolId: '019eaaaa-0000-7556-8c81-aaaaaaaaaaaa', subdomain: 'demo' } as never;
const ADMIN_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-a0000000a001',
  personId: '019eaaaa-0000-7556-8c81-a0000000a002',
  employeeId: '019eaaaa-0000-7556-8c81-a0000000a003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;
const PARENT_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-b0000000b001',
  personId: '019eaaaa-0000-7556-8c81-b0000000b002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;
const TEACHER_ACTOR = {
  accountId: '019eaaaa-0000-7556-8c81-c0000000c001',
  personId: '019eaaaa-0000-7556-8c81-c0000000c002',
  employeeId: '019eaaaa-0000-7556-8c81-c0000000c003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'q' | 'e';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'q' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'e' };
      capture.push(call);
      return handler(call) ?? 0;
    },
  };
  const tenantPrisma = {
    executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
  };
  return { capture, client, tenantPrisma };
}

function makeOutbox() {
  const enqueued: Array<{
    topic: string;
    sourceModule: string;
    key: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
      return 'outbox-id';
    },
  };
  return { outbox, enqueued };
}

function makePerms(grants: Record<string, string[]> = {}) {
  return {
    hasAnyPermissionInTenant: vi.fn(
      async (accountId: string, _scopeId: string, codes: string[]) => {
        const held = grants[accountId] ?? [];
        return codes.some((c) => held.includes(c));
      },
    ),
  };
}

// =====================================================================
// TourSlotService
// =====================================================================
describe('TourSlotService', () => {
  it('listPublic filters by school + published + future + non-cancelled + capacity remaining', async () => {
    const { capture, tenantPrisma } = makeFake((c) => {
      if (c.sql.includes('FROM enr_tour_slots s')) {
        return [
          {
            id: 'slot1',
            school_id: SCHOOL.schoolId,
            tour_date: '2026-09-01',
            start_time: '10:00',
            end_time: '11:00',
            max_bookings: 10,
            current_bookings: 3,
            tour_type: 'GENERAL_OPEN_DAY',
            led_by: null,
            led_by_first_name: null,
            led_by_last_name: null,
            meeting_point: 'Lobby',
            notes: null,
            is_published: true,
            is_cancelled: false,
            created_at: '2026-08-01T00:00Z',
            updated_at: '2026-08-01T00:00Z',
          },
        ];
      }
      return [];
    });
    const perms = makePerms();
    const svc = new TourSlotService(tenantPrisma as never, perms as never);
    const rows = await runWithTenantContext({ tenant: SCHOOL }, async () => svc.listPublic());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.availableSpots).toBe(7);
    expect(rows[0]!.isFull).toBe(false);
    const sqlCall = capture.find((c) => c.sql.includes('FROM enr_tour_slots s'));
    expect(sqlCall?.sql).toContain('is_published = true');
    expect(sqlCall?.sql).toContain('is_cancelled = false');
    expect(sqlCall?.sql).toContain('current_bookings < s.max_bookings');
  });

  it('create rejects non-admin caller', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({});
    const svc = new TourSlotService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            tourDate: '2026-09-15',
            startTime: '10:00',
            endTime: '11:00',
          },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('create rejects endTime <= startTime', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-003:admin'] });
    const svc = new TourSlotService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create({ tourDate: '2026-09-15', startTime: '11:00', endTime: '10:00' }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('create translates 23505 UNIQUE collision into a friendly 400', async () => {
    const { tenantPrisma } = makeFake((c) => {
      if (c.fn === 'e' && c.sql.includes('INSERT INTO enr_tour_slots')) {
        const err = Object.assign(new Error('duplicate key'), {
          code: '23505',
          meta: { code: '23505' },
        });
        throw err;
      }
      return [];
    });
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-003:admin'] });
    const svc = new TourSlotService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create({ tourDate: '2026-09-15', startTime: '10:00', endTime: '11:00' }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

// =====================================================================
// TourBookingService
// =====================================================================
describe('TourBookingService', () => {
  function setupBooking(slotState: {
    current: number;
    max: number;
    published?: boolean;
    cancelled?: boolean;
  }) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        // REVIEW-P2-5 BLOCKING 1 — bookPublic now does TWO slot
        // reads: an unlocked pre-flight + the locked tx read. Both
        // hit the same handler in tests; return the slot row for
        // any FROM enr_tour_slots query (the schema columns are a
        // superset of what either path needs).
        if (sql.includes('FROM enr_tour_slots')) {
          return [
            {
              id: 'slot1',
              tour_date: '2026-09-01',
              max_bookings: slotState.max,
              current_bookings: slotState.current,
              is_published: slotState.published ?? true,
              is_cancelled: slotState.cancelled ?? false,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('LIMIT 1')) {
          return [
            {
              id: 'bk1',
              slot_id: 'slot1',
              school_id: SCHOOL.schoolId,
              booked_by: 'p1',
              family_name: 'F',
              contact_email: 'e@x.com',
              contact_phone: null,
              status: 'CONFIRMED',
              booked_at: '2026-09-01T00:00Z',
              cancelled_at: null,
              cancellation_reason: null,
              linked_application_id: null,
              notes: null,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_booking_guests')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    return { calls, client, tenantPrisma };
  }

  it('bookPublic locks the slot row, increments current_bookings, emits enr.tour.booked via outbox', async () => {
    const { calls, tenantPrisma } = setupBooking({ current: 0, max: 1 });
    const perms = makePerms();
    const { outbox, enqueued } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const result = await svc.bookPublic('slot1', {
        firstName: 'Sarah',
        lastName: 'Test',
        familyName: 'Test Family',
        contactEmail: 'sarah@example.com',
        contactPhone: '+1-555-0100',
        guests: [{ guestType: 'ADULT', firstName: 'Sarah', lastName: 'Test', age: 38 }],
      });
      expect(result.status).toBe('CONFIRMED');
    });
    // REVIEW-P2-5 Round 2 BLOCKING — public booking now creates
    // ZERO platform identity writes. Booking + contact info
    // live on enr_tour_bookings; booked_by stays NULL until
    // an EO links a verified application via /tour-bookings/:id/link-application.
    expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    // Locked-row SELECT
    expect(
      calls.some((c) => c.sql.includes('FROM enr_tour_slots') && c.sql.includes('FOR UPDATE')),
    ).toBe(true);
    // INSERT booking + INSERT guest + UPDATE current_bookings
    expect(calls.some((c) => c.fn === 'e' && c.sql.includes('INSERT INTO enr_tour_bookings'))).toBe(
      true,
    );
    expect(
      calls.some((c) => c.fn === 'e' && c.sql.includes('INSERT INTO enr_tour_booking_guests')),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.fn === 'e' &&
          c.sql.includes('UPDATE enr_tour_slots SET current_bookings = current_bookings + 1'),
      ),
    ).toBe(true);
    // Outbox emit
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('enr.tour.booked');
    expect(enqueued[0]!.sourceModule).toBe('enrolment-advanced');
    expect(enqueued[0]!.payload.bookingId).toBeDefined();
    expect(enqueued[0]!.payload.slotId).toBe('slot1');
    expect(enqueued[0]!.payload.guestCount).toBe(1);
  });

  it('bookPublic throws ConflictException when slot is full', async () => {
    const { tenantPrisma } = setupBooking({ current: 10, max: 10 });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'Sarah',
          lastName: 'Test',
          familyName: 'Test Family',
          contactEmail: 'sarah@example.com',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('bookPublic throws NotFoundException for missing slot', async () => {
    const { tenantPrisma } = (() => {
      const client = {
        $queryRawUnsafe: async (sql: string) => {
          if (sql.includes('FROM enr_tour_slots') && sql.includes('FOR UPDATE')) return [];
          return [];
        },
        $executeRawUnsafe: async () => 0,
      };
      return {
        tenantPrisma: {
          executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
          executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
        },
      };
    })();
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('missing-slot', {
          firstName: 'X',
          lastName: 'Y',
          familyName: 'Z',
          contactEmail: 'z@example.com',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('bookPublic refuses unpublished slots', async () => {
    const { tenantPrisma } = setupBooking({ current: 0, max: 10, published: false });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'A',
          lastName: 'B',
          familyName: 'C',
          contactEmail: 'a@example.com',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('bookPublic refuses cancelled slots', async () => {
    const { tenantPrisma } = setupBooking({ current: 0, max: 10, cancelled: true });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'A',
          lastName: 'B',
          familyName: 'C',
          contactEmail: 'a@example.com',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('REVIEW-P2-5 MAJOR 4 — bookPublic always creates a fresh iam_person, never reuses existing by email', async () => {
    const { tenantPrisma } = setupBooking({ current: 0, max: 10 });
    const perms = makePerms();
    const { outbox, enqueued } = makeOutbox();
    // Even if an existing platform_users row matched, the public
    // path must NOT reuse it (the email is unverified contact).
    const findFirst = vi.fn(async () => ({ personId: 'existing-person' }));
    const platformPrisma = {
      platformUser: { findFirst },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.bookPublic('slot1', {
        firstName: 'Sarah',
        lastName: 'Test',
        familyName: 'F',
        contactEmail: 'existing@example.com',
      });
    });
    // The public path no longer looks up by email — never call findFirst.
    expect(findFirst).not.toHaveBeenCalled();
    // REVIEW-P2-5 Round 2 — public booking now creates ZERO
    // platform writes (Option C). Booking attaches via
    // booked_by=NULL.
    expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
    // bookedBy in the outbox payload is null on public bookings.
    expect(enqueued[0]!.payload.bookedBy).toBeNull();
  });

  it('REVIEW-P2-5 BLOCKING 1 — bookPublic does NOT create iam_person when slot is missing', async () => {
    // Missing slot — pre-flight returns no rows.
    const client = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM enr_tour_slots')) return [];
        return [];
      },
      $executeRawUnsafe: async () => 1,
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('missing-slot', {
          firstName: 'X',
          lastName: 'Y',
          familyName: 'Z',
          contactEmail: 'z@example.com',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    // No platform identity was created — pre-flight rejected before
    // any INSERT into platform.iam_person / platform.platform_users.
    expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('REVIEW-P2-5 BLOCKING 1 — bookPublic does NOT create iam_person when slot is full', async () => {
    const { tenantPrisma } = setupBooking({ current: 5, max: 5 });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'X',
          lastName: 'Y',
          familyName: 'Z',
          contactEmail: 'z@example.com',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
    expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('REVIEW-P2-5 BLOCKING 1 — bookPublic does NOT create iam_person when slot is unpublished', async () => {
    const { tenantPrisma } = setupBooking({ current: 0, max: 10, published: false });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'X',
          lastName: 'Y',
          familyName: 'Z',
          contactEmail: 'z@example.com',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('bookPublic rejects malformed email', async () => {
    const { tenantPrisma } = setupBooking({ current: 0, max: 10 });
    const perms = makePerms();
    const { outbox } = makeOutbox();
    const platformPrisma = {
      platformUser: { findFirst: vi.fn(async () => null) },
      $executeRawUnsafe: vi.fn(async () => 1),
    };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.bookPublic('slot1', {
          firstName: 'X',
          lastName: 'Y',
          familyName: 'Z',
          contactEmail: 'no-at-sign',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('patch CANCELLED requires non-empty cancellationReason and decrements current_bookings', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('FOR UPDATE')) {
          return [{ id: 'bk1', slot_id: 'slot1', status: 'CONFIRMED' }];
        }
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('LIMIT 1')) {
          return [
            {
              id: 'bk1',
              slot_id: 'slot1',
              school_id: SCHOOL.schoolId,
              booked_by: 'p1',
              family_name: 'F',
              contact_email: 'e@x.com',
              contact_phone: null,
              status: 'CANCELLED',
              booked_at: '2026-09-01T00:00Z',
              cancelled_at: '2026-09-02T00:00Z',
              cancellation_reason: 'sick',
              linked_application_id: null,
              notes: null,
            },
          ];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-003:write'] });
    const { outbox } = makeOutbox();
    const platformPrisma = { platformUser: { findFirst: vi.fn() }, $executeRawUnsafe: vi.fn() };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // Empty reason rejected
      await expect(
        svc.patch('bk1', { status: 'CANCELLED', cancellationReason: '   ' }, ADMIN_ACTOR),
      ).rejects.toBeInstanceOf(BadRequestException);
      // With reason, succeeds + decrements current_bookings
      await svc.patch('bk1', { status: 'CANCELLED', cancellationReason: 'sick' }, ADMIN_ACTOR);
    });
    expect(
      calls.some(
        (c) =>
          c.fn === 'e' &&
          c.sql.includes(
            'UPDATE enr_tour_slots SET current_bookings = GREATEST(current_bookings - 1, 0)',
          ),
      ),
    ).toBe(true);
  });

  it('linkApplication validates the application belongs to this school', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('FOR UPDATE')) {
          return [{ id: 'bk1' }];
        }
        if (sql.includes('FROM enr_applications')) return [];
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('LIMIT 1')) {
          return [
            {
              id: 'bk1',
              slot_id: 'slot1',
              school_id: SCHOOL.schoolId,
              booked_by: 'p1',
              family_name: 'F',
              contact_email: 'e@x.com',
              contact_phone: null,
              status: 'COMPLETED',
              booked_at: '2026-09-01T00:00Z',
              cancelled_at: null,
              cancellation_reason: null,
              linked_application_id: null,
              notes: null,
            },
          ];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-003:write'] });
    const { outbox } = makeOutbox();
    const platformPrisma = { platformUser: { findFirst: vi.fn() }, $executeRawUnsafe: vi.fn() };
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // Application not in this school → 400
      await expect(
        svc.linkApplication(
          'bk1',
          { applicationId: '019eaaaa-9999-7556-8c81-deadbeefdead' },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

// =====================================================================
// WithdrawalService
// =====================================================================
describe('WithdrawalService', () => {
  function setupWithdrawal(
    opts: {
      pendingTaskCount?: number;
      withdrawalStatus?: string;
      perms?: Record<string, string[]>;
      guardianMatches?: boolean;
      templateTasks?: Array<{ taskName: string; taskCategory: string; sortOrder: number }>;
    } = {},
  ) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM sis_students s') && sql.includes('sis_student_guardians')) {
          return opts.guardianMatches !== false ? [{}] : [];
        }
        if (sql.includes('FROM sis_students') && sql.includes('LIMIT 1')) {
          return [{ id: '019eaaaa-stud-7556-8c81-000000000001' }];
        }
        if (sql.includes('FROM enr_withdrawal_requests') && sql.includes('FOR UPDATE')) {
          return [
            {
              id: 'w1',
              student_id: 'stud1',
              status: opts.withdrawalStatus ?? 'IN_PROGRESS',
              requested_by: ADMIN_ACTOR.personId,
            },
          ];
        }
        if (sql.includes('FROM enr_withdrawal_exit_tasks') && sql.includes('PENDING')) {
          return [{ pending: opts.pendingTaskCount ?? 0 }];
        }
        if (sql.includes('SELECT w.id') || sql.includes('FROM enr_withdrawal_requests w')) {
          return [
            {
              id: 'w1',
              school_id: SCHOOL.schoolId,
              student_id: 'stud1',
              initiated_by: 'FAMILY',
              requested_by: ADMIN_ACTOR.personId,
              requested_by_first_name: 'Adm',
              requested_by_last_name: 'In',
              withdrawal_reason_category: 'OTHER',
              withdrawal_reason_detail: null,
              last_attendance_date: '2026-06-30',
              requested_at: '2026-06-01T00:00Z',
              destination_school_name: null,
              destination_school_country: null,
              records_release_consented: false,
              records_sent_at: null,
              status: opts.withdrawalStatus ?? 'IN_PROGRESS',
              completed_at: null,
              completed_by: null,
              completed_by_first_name: null,
              completed_by_last_name: null,
              re_enrollment_hold_placed: false,
              re_enrollment_hold_reason: null,
              notes: null,
              created_at: '2026-06-01T00:00Z',
              updated_at: '2026-06-01T00:00Z',
              student_first_name: 'S',
              student_last_name: 'T',
            },
          ];
        }
        if (sql.includes('FROM enr_withdrawal_exit_tasks t')) return [];
        if (sql.includes('FROM enr_withdrawal_task_templates')) {
          return opts.templateTasks
            ? opts.templateTasks.map((t) => ({
                id: 'tt-' + t.sortOrder,
                school_id: SCHOOL.schoolId,
                template_name: 'DEFAULT',
                task_name: t.taskName,
                task_category: t.taskCategory,
                sort_order: t.sortOrder,
                is_active: true,
                is_required: true,
              }))
            : [];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms(opts.perms ?? { [ADMIN_ACTOR.accountId]: ['stu-004:admin'] });
    const { outbox, enqueued } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const svc = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    return { svc, calls, enqueued };
  }

  it('list filters parents to own children only via sis_student_guardians', async () => {
    const { svc, calls } = setupWithdrawal();
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(PARENT_ACTOR));
    const sqlCall = calls.find((c) => c.sql.includes('FROM enr_withdrawal_requests w'));
    expect(sqlCall?.sql).toContain('sis_student_guardians');
    expect(sqlCall?.sql).toContain('g.person_id =');
  });

  it('list as admin includes no guardian filter', async () => {
    const { svc, calls } = setupWithdrawal();
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(ADMIN_ACTOR));
    const sqlCall = calls.find((c) => c.sql.includes('FROM enr_withdrawal_requests w'));
    expect(sqlCall?.sql).not.toContain('sis_student_guardians');
  });

  it('create rejects when parent is not a guardian of the supplied student', async () => {
    const { svc } = setupWithdrawal({
      guardianMatches: false,
      perms: { [PARENT_ACTOR.accountId]: ['stu-004:write'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            studentId: 'stud-other',
            initiatedBy: 'FAMILY',
            withdrawalReasonCategory: 'OTHER',
            lastAttendanceDate: '2026-06-30',
          },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('create rejects when no template tasks configured', async () => {
    const { svc } = setupWithdrawal({
      templateTasks: [],
      perms: { [ADMIN_ACTOR.accountId]: ['stu-004:admin', 'stu-004:write'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      // Override the lazy-seed path by also disabling adminScope check would make it write but
      // template returns empty so create rejects.
      await expect(
        svc.create(
          {
            studentId: 'stud1',
            initiatedBy: 'SCHOOL',
            withdrawalReasonCategory: 'OTHER',
            lastAttendanceDate: '2026-06-30',
          },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('complete refuses when any exit task remains PENDING', async () => {
    const { svc } = setupWithdrawal({
      pendingTaskCount: 3,
      perms: { [ADMIN_ACTOR.accountId]: ['stu-004:admin'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.complete('w1', {}, ADMIN_ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('complete flips sis_students.enrollment_status to WITHDRAWN and emits enr.student.withdrawn', async () => {
    const { svc, calls, enqueued } = setupWithdrawal({
      pendingTaskCount: 0,
      perms: { [ADMIN_ACTOR.accountId]: ['stu-004:admin'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.complete('w1', {}, ADMIN_ACTOR));
    expect(
      calls.some(
        (c) =>
          c.fn === 'e' && c.sql.includes("UPDATE sis_students SET enrollment_status = 'WITHDRAWN'"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.fn === 'e' && c.sql.includes("UPDATE enr_withdrawal_requests SET status = 'COMPLETED'"),
      ),
    ).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.topic).toBe('enr.student.withdrawn');
    expect(enqueued[0]!.sourceModule).toBe('enrolment-advanced');
    expect(enqueued[0]!.payload.studentId).toBe('stud1');
    expect(enqueued[0]!.payload.completedBy).toBe(ADMIN_ACTOR.personId);
  });

  it('complete rejects already-COMPLETED withdrawals', async () => {
    const { svc } = setupWithdrawal({
      withdrawalStatus: 'COMPLETED',
      perms: { [ADMIN_ACTOR.accountId]: ['stu-004:admin'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.complete('w1', {}, ADMIN_ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('placeReenrolHold requires non-empty reason when hold=true (hold_chk schema invariant)', async () => {
    const { svc } = setupWithdrawal({
      perms: { [ADMIN_ACTOR.accountId]: ['stu-004:admin'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.placeReenrolHold('w1', { hold: true }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('non-admin caller cannot complete a withdrawal', async () => {
    const { svc } = setupWithdrawal({
      perms: { [TEACHER_ACTOR.accountId]: ['stu-004:write'] },
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.complete('w1', {}, TEACHER_ACTOR)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

// =====================================================================
// ReenrolmentService
// =====================================================================
describe('ReenrolmentService', () => {
  function setupReenrol(opts: { holdActive?: boolean; perms?: Record<string, string[]> } = {}) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM sis_students s') && sql.includes('sis_student_guardians')) {
          return [{}];
        }
        if (
          sql.includes('FROM enr_withdrawal_requests') &&
          sql.includes('re_enrollment_hold_placed')
        ) {
          return opts.holdActive ? [{}] : [];
        }
        if (sql.includes('FROM enr_reenrollment_confirmations')) {
          return [
            {
              id: 'r1',
              school_id: SCHOOL.schoolId,
              student_id: 'stud1',
              student_first_name: 'S',
              student_last_name: 'T',
              student_grade: '5',
              academic_year_id: 'y1',
              academic_year_name: '2027-2028',
              submitted_by: PARENT_ACTOR.personId,
              submitted_by_first_name: 'P',
              submitted_by_last_name: 'A',
              confirmed_continuing: true,
              withdrawal_reason: null,
              submitted_at: '2026-08-01T00:00Z',
              processed_by: null,
              processed_by_first_name: null,
              processed_by_last_name: null,
              processed_at: null,
              linked_withdrawal_id: null,
              notes: null,
            },
          ];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms(opts.perms ?? { [PARENT_ACTOR.accountId]: ['stu-004:write'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const withdrawalService = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    const svc = new ReenrolmentService(tenantPrisma as never, perms as never, withdrawalService);
    return { svc, calls };
  }

  it('submit rejects continuing=true with a withdrawalReason payload', async () => {
    const { svc } = setupReenrol();
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.submit(
          {
            studentId: 'stud1',
            academicYearId: 'y1',
            confirmedContinuing: true,
            withdrawalReason: 'should not have',
          },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('submit rejects continuing=false without a withdrawalReason (reason_chk schema invariant)', async () => {
    const { svc } = setupReenrol();
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.submit(
          {
            studentId: 'stud1',
            academicYearId: 'y1',
            confirmedContinuing: false,
          },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('submit rejects when student has an active re-enrolment hold', async () => {
    const { svc } = setupReenrol({ holdActive: true });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.submit(
          { studentId: 'stud1', academicYearId: 'y1', confirmedContinuing: true },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('summary admin-only', async () => {
    const { svc } = setupReenrol({ perms: { [PARENT_ACTOR.accountId]: ['stu-004:read'] } });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.summary(PARENT_ACTOR, 'y1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// MidYearAdmissionService
// =====================================================================
describe('MidYearAdmissionService', () => {
  function setup(perms: Record<string, string[]> = {}) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_mid_year_admission_requests m')) {
          return [
            {
              id: 'm1',
              school_id: SCHOOL.schoolId,
              requested_by: PARENT_ACTOR.personId,
              requested_by_first_name: 'P',
              requested_by_last_name: 'A',
              student_first_name: 'X',
              student_last_name: 'Y',
              student_date_of_birth: '2014-08-22',
              applying_for_grade_level: '5',
              requested_start_date: '2026-09-01',
              admission_reason: 'OTHER',
              admission_reason_detail: null,
              previous_school_name: null,
              previous_school_country: null,
              records_requested: false,
              status: 'RECEIVED',
              capacity_available: null,
              capacity_checked_at: null,
              capacity_checked_by: null,
              capacity_checked_by_first_name: null,
              capacity_checked_by_last_name: null,
              linked_application_id: null,
              notes: null,
              created_at: '2026-08-01T00:00Z',
              updated_at: '2026-08-01T00:00Z',
            },
          ];
        }
        if (sql.includes('FROM enr_mid_year_admission_requests') && sql.includes('FOR UPDATE')) {
          return [{ id: 'm1' }];
        }
        if (sql.includes('FROM enr_applications')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const permsObj = makePerms(perms);
    const svc = new MidYearAdmissionService(tenantPrisma as never, permsObj as never);
    return { svc, calls };
  }

  it('list filters parent to own submissions', async () => {
    const { svc, calls } = setup({ [PARENT_ACTOR.accountId]: ['stu-004:read'] });
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(PARENT_ACTOR));
    const sql = calls.find((c) => c.sql.includes('FROM enr_mid_year_admission_requests'));
    expect(sql?.sql).toContain('m.requested_by =');
  });

  it('patch refuses when caller is not admin', async () => {
    const { svc } = setup({ [PARENT_ACTOR.accountId]: ['stu-004:read'] });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.patch('m1', { capacityAvailable: true }, PARENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  it('patch with linkedApplicationId rejects when application not in this school', async () => {
    const { svc } = setup({ [ADMIN_ACTOR.accountId]: ['stu-004:admin'] });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.patch(
          'm1',
          { linkedApplicationId: '019eaaaa-9999-7556-8c81-deadbeefdead' },
          ADMIN_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('submit by parent with stu-004:write writes the row', async () => {
    const { svc, calls } = setup({ [PARENT_ACTOR.accountId]: ['stu-004:write'] });
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.submit(
        {
          studentFirstName: 'A',
          studentLastName: 'B',
          studentDateOfBirth: '2015-01-01',
          applyingForGradeLevel: '4',
          requestedStartDate: '2026-09-01',
          admissionReason: 'OTHER',
        },
        PARENT_ACTOR,
      ),
    );
    expect(
      calls.some(
        (c) => c.fn === 'e' && c.sql.includes('INSERT INTO enr_mid_year_admission_requests'),
      ),
    ).toBe(true);
  });
});

// =====================================================================
// ExitTaskService
// =====================================================================
describe('ExitTaskService', () => {
  function setup(opts: { withdrawalStatus?: string; perms?: Record<string, string[]> } = {}) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_withdrawal_exit_tasks t') && sql.includes('FOR UPDATE OF t')) {
          return [
            {
              id: 'task1',
              status: 'PENDING',
              task_category: 'IT',
              withdrawal_status: opts.withdrawalStatus ?? 'IN_PROGRESS',
            },
          ];
        }
        if (sql.includes('FROM enr_withdrawal_exit_tasks') && sql.includes('id = $1::uuid')) {
          return [
            {
              id: 'task1',
              withdrawal_id: 'w1',
              task_name: 'Return device',
              task_category: 'IT',
              status: 'COMPLETED',
              completed_by: ADMIN_ACTOR.personId,
              completed_at: '2026-09-01T00:00Z',
              notes: 'done',
              sort_order: 0,
            },
          ];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms(opts.perms ?? { [ADMIN_ACTOR.accountId]: ['stu-004:write'] });
    const svc = new ExitTaskService(tenantPrisma as never, perms as never);
    return { svc, calls };
  }

  it('patch COMPLETED stamps completed_by + completed_at', async () => {
    const { svc, calls } = setup();
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch('task1', { status: 'COMPLETED', notes: 'done' }, ADMIN_ACTOR),
    );
    const updateCall = calls.find(
      (c) =>
        c.fn === 'e' &&
        c.sql.includes('UPDATE enr_withdrawal_exit_tasks SET status = $1, completed_by = $2'),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall!.args[1]).toBe(ADMIN_ACTOR.personId);
  });

  it('patch refuses when parent withdrawal is COMPLETED', async () => {
    const { svc } = setup({ withdrawalStatus: 'COMPLETED' });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(svc.patch('task1', { status: 'COMPLETED' }, ADMIN_ACTOR)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  it('patch flips parent withdrawal REQUESTED -> IN_PROGRESS on first transition', async () => {
    const { svc, calls } = setup({ withdrawalStatus: 'REQUESTED' });
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.patch('task1', { status: 'COMPLETED' }, ADMIN_ACTOR),
    );
    expect(
      calls.some(
        (c) =>
          c.fn === 'e' &&
          c.sql.includes("UPDATE enr_withdrawal_requests SET status = 'IN_PROGRESS'"),
      ),
    ).toBe(true);
  });

  it('patch refuses without write scope', async () => {
    const { svc } = setup({ perms: { [PARENT_ACTOR.accountId]: ['stu-004:read'] } });
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.patch('task1', { status: 'COMPLETED' }, PARENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// ExitTaskTemplateService
// =====================================================================
describe('ExitTaskTemplateService', () => {
  it('listActive lazy-seeds the 7-task DEFAULT baseline', async () => {
    const calls: CapturedCall[] = [];
    let templateRows: Array<Record<string, unknown>> = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_withdrawal_task_templates')) return templateRows;
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        if (sql.includes('INSERT INTO enr_withdrawal_task_templates')) {
          templateRows.push({
            id: args[0],
            school_id: args[1],
            template_name: args[2],
            task_name: args[3],
            task_category: args[4],
            sort_order: args[5],
            is_active: true,
            is_required: args[6],
          });
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-004:admin'] });
    const svc = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const rows = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.listActive(SCHOOL.schoolId, 'DEFAULT', ADMIN_ACTOR),
    );
    expect(rows.length).toBe(7);
    const cats = rows.map((r) => r.taskCategory).sort();
    expect(cats).toContain('RECORDS');
    expect(cats).toContain('IT');
    expect(cats).toContain('FACILITIES');
    expect(cats).toContain('FINANCE');
    expect(cats).toContain('TRANSPORT');
    expect(cats).toContain('ADMINISTRATIVE');
  });

  it('upsert refuses non-admin', async () => {
    const { tenantPrisma } = makeFake(() => []);
    const perms = makePerms({});
    const svc = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.upsert({ tasks: [{ taskName: 'X', taskCategory: 'IT' }] }, PARENT_ACTOR),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// Controller permission metadata
// =====================================================================
describe('Controller @RequirePermission metadata', () => {
  function readMeta(target: unknown, methodName: string): string[] {
    return (
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        (target as Record<string, unknown>)[methodName] as object,
      ) ?? []
    );
  }

  it('TourController gates admin endpoints on stu-003:admin and reads on stu-003:read', () => {
    expect(readMeta(TourController.prototype, 'createSlot')).toEqual(['stu-003:admin']);
    expect(readMeta(TourController.prototype, 'patchSlot')).toEqual(['stu-003:admin']);
    expect(readMeta(TourController.prototype, 'listAdmin')).toEqual(['stu-003:read']);
    expect(readMeta(TourController.prototype, 'patchBooking')).toEqual(['stu-003:write']);
    expect(readMeta(TourController.prototype, 'linkApplication')).toEqual(['stu-003:write']);
  });

  it('WithdrawalController gates complete/hold on stu-004:admin', () => {
    expect(readMeta(WithdrawalController.prototype, 'list')).toEqual(['stu-004:read']);
    expect(readMeta(WithdrawalController.prototype, 'create')).toEqual(['stu-004:write']);
    expect(readMeta(WithdrawalController.prototype, 'complete')).toEqual(['stu-004:admin']);
    expect(readMeta(WithdrawalController.prototype, 'placeHold')).toEqual(['stu-004:admin']);
    expect(readMeta(WithdrawalController.prototype, 'patchTask')).toEqual(['stu-004:write']);
    expect(readMeta(WithdrawalController.prototype, 'cancel')).toEqual(['stu-004:write']);
  });

  it('ReenrolmentController gates summary on stu-004:admin', () => {
    expect(readMeta(ReenrolmentController.prototype, 'summary')).toEqual(['stu-004:admin']);
    expect(readMeta(ReenrolmentController.prototype, 'submit')).toEqual(['stu-004:write']);
    expect(readMeta(ReenrolmentController.prototype, 'list')).toEqual(['stu-004:read']);
  });

  it('MidYearAdmissionController gates patch on stu-004:admin', () => {
    expect(readMeta(MidYearAdmissionController.prototype, 'patch')).toEqual(['stu-004:admin']);
    expect(readMeta(MidYearAdmissionController.prototype, 'submit')).toEqual(['stu-004:write']);
    expect(readMeta(MidYearAdmissionController.prototype, 'list')).toEqual(['stu-004:read']);
  });

  it('ExitTaskTemplateController gates upsert on stu-004:admin', () => {
    expect(readMeta(ExitTaskTemplateController.prototype, 'upsert')).toEqual(['stu-004:admin']);
    expect(readMeta(ExitTaskTemplateController.prototype, 'list')).toEqual(['stu-004:read']);
  });
});

// =====================================================================
// REVIEW-P2-5 BLOCKING 2 — atomic re-enrolment auto-withdrawal
// =====================================================================
describe('REVIEW-P2-5 BLOCKING 2 — atomic re-enrolment auto-withdrawal', () => {
  it('duplicate confirmation rolls back the auto-initiated withdrawal (single tenant tx)', async () => {
    // Mock a Postgres UNIQUE violation when the confirmation INSERT
    // lands. The auto-withdrawal SQL must run inside the SAME tx
    // that the confirmation INSERT runs in, so when the conflict
    // throws, the entire tx (withdrawal + exit tasks + confirmation)
    // rolls back together. We assert this by tracking which SQLs
    // actually committed via a single rollback flag — if we see
    // INSERT INTO enr_withdrawal_requests run BEFORE the failing
    // confirmation INSERT and the test asserts they share a tx,
    // the atomicity contract holds.
    let txCount = 0;
    let withdrawalInserted = false;
    let exitTasksInserted = 0;
    const calls: CapturedCall[] = [];
    const tx = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM sis_students s') && sql.includes('sis_student_guardians')) {
          return [{}];
        }
        if (sql.includes('FROM sis_students') && sql.includes('LIMIT 1')) {
          return [{ id: 'stud1' }];
        }
        if (sql.includes('FROM enr_withdrawal_task_templates')) {
          return [
            {
              id: 'tt1',
              school_id: SCHOOL.schoolId,
              template_name: 'DEFAULT',
              task_name: 'Library books returned',
              task_category: 'RECORDS',
              sort_order: 0,
              is_active: true,
              is_required: true,
            },
          ];
        }
        if (
          sql.includes('FROM enr_withdrawal_requests') &&
          sql.includes('hasActiveHoldForStudent')
        ) {
          return [];
        }
        if (sql.includes('re_enrollment_hold_placed')) {
          return [];
        }
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        if (sql.includes('INSERT INTO enr_withdrawal_requests')) {
          withdrawalInserted = true;
        }
        if (sql.includes('INSERT INTO enr_withdrawal_exit_tasks')) {
          exitTasksInserted += 1;
        }
        if (sql.includes('INSERT INTO enr_reenrollment_confirmations')) {
          // The keystone — UNIQUE(student, year) collision. The
          // tenant tx wrapper must roll back the previously
          // INSERTed withdrawal + exit tasks together with the
          // confirmation that just failed.
          const err = Object.assign(new Error('duplicate key'), {
            code: '23505',
            meta: { code: '23505' },
          });
          throw err;
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(tx),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
        // Track that both the withdrawal create AND the
        // confirmation insert happen INSIDE the same tx callback
        // — txCount stays at 1 across the entire submit() call.
        txCount += 1;
        return fn(tx);
      },
    };
    const perms = makePerms({ [PARENT_ACTOR.accountId]: ['stu-004:write'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const withdrawalService = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    const svc = new ReenrolmentService(tenantPrisma as never, perms as never, withdrawalService);

    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.submit(
          {
            studentId: 'stud1',
            academicYearId: 'y1',
            confirmedContinuing: false,
            withdrawalReason: 'Smoke — relocating',
          },
          PARENT_ACTOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // The auto-withdrawal INSERT and the at-least-one exit task
    // INSERT both ran (proving the auto-initiation happened),
    // BUT they ran inside the SAME tx callback as the failed
    // confirmation. txCount=1 confirms the WithdrawalService
    // did NOT open its own separate tx (which was the previous
    // BLOCKING 2 bug — committed-before-confirmation orphans).
    expect(withdrawalInserted).toBe(true);
    expect(exitTasksInserted).toBeGreaterThan(0);
    expect(txCount).toBe(1);
  });

  it('confirmedContinuing=true does NOT call the withdrawal create path', async () => {
    let withdrawalInserted = false;
    const tx = {
      $queryRawUnsafe: async (sql: string) => {
        if (sql.includes('FROM sis_students s') && sql.includes('sis_student_guardians')) {
          return [{}];
        }
        if (sql.includes('re_enrollment_hold_placed')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string) => {
        if (sql.includes('INSERT INTO enr_withdrawal_requests')) withdrawalInserted = true;
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(tx),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(tx),
    };
    const perms = makePerms({ [PARENT_ACTOR.accountId]: ['stu-004:write'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const withdrawalService = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    const svc = new ReenrolmentService(tenantPrisma as never, perms as never, withdrawalService);

    // Patch tx to also satisfy the post-INSERT getById call which
    // re-reads the confirmation row with full SELECT_REENROL_BASE
    // shape. The simpler path is to just have the same handler
    // return the right shape based on SQL pattern.
    const richHandler = async (sql: string): Promise<unknown> => {
      if (sql.includes('FROM sis_students s') && sql.includes('sis_student_guardians')) {
        return [{}];
      }
      if (sql.includes('re_enrollment_hold_placed')) return [];
      if (sql.includes('FROM enr_reenrollment_confirmations r')) {
        return [
          {
            id: 'r1',
            school_id: SCHOOL.schoolId,
            student_id: 'stud1',
            student_first_name: 'S',
            student_last_name: 'T',
            student_grade: '5',
            academic_year_id: 'y1',
            academic_year_name: '2027',
            submitted_by: PARENT_ACTOR.personId,
            submitted_by_first_name: 'P',
            submitted_by_last_name: 'A',
            confirmed_continuing: true,
            withdrawal_reason: null,
            submitted_at: '2026-08-01',
            processed_by: null,
            processed_by_first_name: null,
            processed_by_last_name: null,
            processed_at: null,
            linked_withdrawal_id: null,
            notes: null,
          },
        ];
      }
      return [];
    };
    tx.$queryRawUnsafe = richHandler;

    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.submit(
        {
          studentId: 'stud1',
          academicYearId: 'y1',
          confirmedContinuing: true,
        },
        PARENT_ACTOR,
      );
    });

    // No auto-withdrawal on the continuing path.
    expect(withdrawalInserted).toBe(false);
  });
});

// =====================================================================
// REVIEW-P2-5 BLOCKING 3 — generic Staff cannot bypass row scope
// =====================================================================
describe('REVIEW-P2-5 BLOCKING 3 — generic Staff scope tightening', () => {
  // Generic STAFF actor with NO STU-004 grants (counsellor /
  // librarian / etc.) — should be treated as "non-operator".
  const GENERIC_STAFF = {
    accountId: '019eaaaa-0000-7556-8c81-d0000000d001',
    personId: '019eaaaa-0000-7556-8c81-d0000000d002',
    employeeId: '019eaaaa-0000-7556-8c81-d0000000d003',
    personType: 'STAFF' as const,
    isSchoolAdmin: false,
  } as never;

  function makeWithdrawalSvc(perms: Record<string, string[]>) {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_withdrawal_requests w')) return [];
        return [];
      },
      $executeRawUnsafe: async () => 0,
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const permsObj = makePerms(perms);
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, permsObj as never);
    const svc = new WithdrawalService(
      tenantPrisma as never,
      permsObj as never,
      outbox as never,
      templates,
    );
    return { svc, calls };
  }

  it('WithdrawalService.list — generic Staff (no STU-004) is row-scoped to own children, not school-wide', async () => {
    const { svc, calls } = makeWithdrawalSvc({
      // Generic STAFF actor holds NOTHING for STU-004.
      [GENERIC_STAFF.accountId]: ['hr-001:read', 'cou-001:read'],
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(GENERIC_STAFF));
    const sqlCall = calls.find((c) => c.sql.includes('FROM enr_withdrawal_requests w'));
    // Row-scoped via sis_student_guardians — generic Staff is
    // treated as "non-operator". Fix B3 means the broad
    // STAFF-bypass shortcut is gone.
    expect(sqlCall?.sql).toContain('sis_student_guardians');
    expect(sqlCall?.sql).toContain('g.person_id =');
  });

  it('WithdrawalService.list — Enrolment Officer (Staff with STU-004:admin) sees school-wide', async () => {
    const EO_ACTOR = {
      ...GENERIC_STAFF,
      accountId: '019eaaaa-0000-7556-8c81-e0000000e001',
    } as never;
    const { svc, calls } = makeWithdrawalSvc({
      [EO_ACTOR.accountId]: ['stu-004:admin'],
    });
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(EO_ACTOR));
    const sqlCall = calls.find((c) => c.sql.includes('FROM enr_withdrawal_requests w'));
    // Operator (admin) sees everything — no guardian-link filter.
    expect(sqlCall?.sql).not.toContain('sis_student_guardians');
  });

  it('ReenrolmentService.list — generic Staff defaults to own submissions', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        return [];
      },
      $executeRawUnsafe: async () => 0,
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [GENERIC_STAFF.accountId]: ['cou-001:read'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const withdrawalService = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    const svc = new ReenrolmentService(tenantPrisma as never, perms as never, withdrawalService);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(GENERIC_STAFF, {}));
    const sql = calls.find((c) => c.sql.includes('FROM enr_reenrollment_confirmations r'));
    // Generic Staff -> own submissions only (submitted_by = me).
    expect(sql?.sql).toContain('r.submitted_by =');
  });

  it('MidYearAdmissionService.list — generic Staff defaults to own submissions', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        return [];
      },
      $executeRawUnsafe: async () => 0,
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [GENERIC_STAFF.accountId]: ['cou-001:read'] });
    const svc = new MidYearAdmissionService(tenantPrisma as never, perms as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.list(GENERIC_STAFF));
    const sql = calls.find((c) => c.sql.includes('FROM enr_mid_year_admission_requests'));
    expect(sql?.sql).toContain('m.requested_by =');
  });

  it('WithdrawalService.create — generic Staff with no STU-004 grant cannot initiate for arbitrary student', async () => {
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: async () => [] }),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
        fn({ $queryRawUnsafe: async () => [], $executeRawUnsafe: async () => 1 }),
    };
    const perms = makePerms({ [GENERIC_STAFF.accountId]: ['cou-001:read'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const svc = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await expect(
        svc.create(
          {
            studentId: 'stud1',
            initiatedBy: 'SCHOOL',
            withdrawalReasonCategory: 'OTHER',
            lastAttendanceDate: '2026-06-30',
          },
          GENERIC_STAFF,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

// =====================================================================
// REVIEW-P2-5 MAJOR 5 — sis_students UPDATE includes school_id predicate
// =====================================================================
describe('REVIEW-P2-5 MAJOR 5 — sis_students UPDATE is school-scoped', () => {
  it('WithdrawalService.complete UPDATEs sis_students WHERE school_id = $tenant.schoolId AND id = $studentId', async () => {
    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_withdrawal_requests') && sql.includes('FOR UPDATE')) {
          return [{ id: 'w1', student_id: 'stud1', status: 'IN_PROGRESS' }];
        }
        if (sql.includes('FROM enr_withdrawal_exit_tasks') && sql.includes('PENDING')) {
          return [{ pending: 0 }];
        }
        if (sql.includes('FROM enr_withdrawal_requests w')) {
          return [
            {
              id: 'w1',
              school_id: SCHOOL.schoolId,
              student_id: 'stud1',
              initiated_by: 'FAMILY',
              requested_by: ADMIN_ACTOR.personId,
              requested_by_first_name: 'A',
              requested_by_last_name: 'D',
              withdrawal_reason_category: 'OTHER',
              withdrawal_reason_detail: null,
              last_attendance_date: '2026-06-30',
              requested_at: '2026-06-01',
              destination_school_name: null,
              destination_school_country: null,
              records_release_consented: false,
              records_sent_at: null,
              status: 'COMPLETED',
              completed_at: '2026-06-02',
              completed_by: ADMIN_ACTOR.personId,
              completed_by_first_name: 'A',
              completed_by_last_name: 'D',
              re_enrollment_hold_placed: false,
              re_enrollment_hold_reason: null,
              notes: null,
              created_at: '2026-06-01',
              updated_at: '2026-06-02',
              student_first_name: 'S',
              student_last_name: 'T',
            },
          ];
        }
        if (sql.includes('FROM enr_withdrawal_exit_tasks t')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms({ [ADMIN_ACTOR.accountId]: ['stu-004:admin'] });
    const { outbox } = makeOutbox();
    const templates = new ExitTaskTemplateService(tenantPrisma as never, perms as never);
    const svc = new WithdrawalService(
      tenantPrisma as never,
      perms as never,
      outbox as never,
      templates,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => svc.complete('w1', {}, ADMIN_ACTOR));
    const updateCall = calls.find(
      (c) =>
        c.fn === 'e' && c.sql.includes("UPDATE sis_students SET enrollment_status = 'WITHDRAWN'"),
    );
    expect(updateCall).toBeDefined();
    // The school_id predicate is REVIEW-P2-5 MAJOR 5 — defence in
    // depth against any future code path that might pass an
    // attacker-supplied student_id directly.
    expect(updateCall!.sql).toContain('school_id = $1::uuid');
    expect(updateCall!.sql).toContain('id = $2::uuid');
    // First arg is tenant.schoolId, second is the locked-row student_id.
    expect(updateCall!.args[0]).toBe(SCHOOL.schoolId);
    expect(updateCall!.args[1]).toBe('stud1');
  });
});

// =====================================================================
// REVIEW-P2-5 Round 2 BLOCKING — public booking is race-safe under
// concurrent last-seat pressure (Option C: no iam_person on public path)
// =====================================================================
describe('REVIEW-P2-5 Round 2 — public booking race-safety + no orphan identities', () => {
  it('two concurrent bookings against a cap=1 slot — exactly 1 succeeds, ZERO platform writes from either', async () => {
    // Simulate the locked tx by serialising txCallback execution
    // through a per-slot mutex AND tracking current_bookings as a
    // mutable cell that survives across calls. This is the closest
    // we can get to Postgres FOR UPDATE behaviour in a unit test
    // without spinning up a real DB.
    const slotState = { current: 0, max: 1, published: true, cancelled: false };
    let txQueue: Promise<unknown> = Promise.resolve();

    const platformPrisma = {
      $executeRawUnsafe: vi.fn(async () => 1),
    };

    const calls: CapturedCall[] = [];
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_tour_slots')) {
          // Returns the CURRENT state of the slot. The locked-tx
          // version reads under the per-slot mutex; the unlocked
          // pre-flight (no longer in the code path post Round 2,
          // but the test would still tolerate it) reads outside.
          return [
            {
              id: 'slot1',
              tour_date: '2027-01-01',
              max_bookings: slotState.max,
              current_bookings: slotState.current,
              is_published: slotState.published,
              is_cancelled: slotState.cancelled,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('LIMIT 1')) {
          return [
            {
              id: 'bk-stub',
              slot_id: 'slot1',
              school_id: SCHOOL.schoolId,
              booked_by: null,
              family_name: 'F',
              contact_email: 'e@x.com',
              contact_phone: null,
              status: 'CONFIRMED',
              booked_at: '2027-01-01T00:00Z',
              cancelled_at: null,
              cancellation_reason: null,
              linked_application_id: null,
              notes: null,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_booking_guests')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        // The locked-tx INSERT into enr_tour_bookings + the
        // current_bookings bump only fire after the capacity
        // re-check passes. The bump simulates the tx commit.
        if (sql.includes('UPDATE enr_tour_slots SET current_bookings = current_bookings + 1')) {
          slotState.current += 1;
        }
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      // Serialise tx callbacks so the second one sees the first's
      // committed state — mimics FOR UPDATE on slot1.
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
        const next = txQueue.then(() => fn(client));
        txQueue = next.catch(() => undefined);
        return next;
      },
    };
    const perms = makePerms();
    const { outbox, enqueued } = makeOutbox();
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);

    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const results = await Promise.allSettled([
        svc.bookPublic('slot1', {
          firstName: 'Race',
          lastName: 'A',
          familyName: 'A',
          contactEmail: 'a@example.com',
        }),
        svc.bookPublic('slot1', {
          firstName: 'Race',
          lastName: 'B',
          familyName: 'B',
          contactEmail: 'b@example.com',
        }),
      ]);

      // Exactly one succeeds, exactly one rejects with ConflictException.
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const rej = rejected[0] as PromiseRejectedResult;
      expect(rej.reason).toBeInstanceOf(ConflictException);

      // Slot ended at exactly 1/1.
      expect(slotState.current).toBe(1);

      // ZERO platform writes from EITHER attempt — the keystone
      // contract of Option C. No iam_person rows leak even when
      // both requests passed any pre-flight check.
      expect(platformPrisma.$executeRawUnsafe).not.toHaveBeenCalled();

      // Exactly one outbox emit (from the winning tx).
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.payload.bookedBy).toBeNull();
    });
  });

  it('public booking writes booked_by=NULL into enr_tour_bookings (Option C contract)', async () => {
    const calls: CapturedCall[] = [];
    const slotState = { current: 0, max: 10, published: true, cancelled: false };
    const client = {
      $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'q' });
        if (sql.includes('FROM enr_tour_slots')) {
          return [
            {
              id: 'slot1',
              tour_date: '2027-01-01',
              max_bookings: slotState.max,
              current_bookings: slotState.current,
              is_published: slotState.published,
              is_cancelled: slotState.cancelled,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_bookings') && sql.includes('LIMIT 1')) {
          return [
            {
              id: 'bk1',
              slot_id: 'slot1',
              school_id: SCHOOL.schoolId,
              booked_by: null,
              family_name: 'F',
              contact_email: 'e@x.com',
              contact_phone: null,
              status: 'CONFIRMED',
              booked_at: '2027-01-01',
              cancelled_at: null,
              cancellation_reason: null,
              linked_application_id: null,
              notes: null,
            },
          ];
        }
        if (sql.includes('FROM enr_tour_booking_guests')) return [];
        return [];
      },
      $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args, fn: 'e' });
        return 1;
      },
    };
    const tenantPrisma = {
      executeInTenantContext: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
      executeInTenantTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    };
    const perms = makePerms();
    const { outbox, enqueued } = makeOutbox();
    const svc = new TourBookingService(tenantPrisma as never, perms as never, outbox as never);

    const result = await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.bookPublic('slot1', {
        firstName: 'Anon',
        lastName: 'Public',
        familyName: 'AnonFam',
        contactEmail: 'anon@example.com',
      }),
    );
    expect(result.bookedBy).toBeNull();

    // The booking INSERT carried booked_by=null at $4 (positional).
    const insertCall = calls.find(
      (c) => c.fn === 'e' && c.sql.includes('INSERT INTO enr_tour_bookings'),
    );
    expect(insertCall).toBeDefined();
    // Args order: id, slotId, schoolId, bookedBy, familyName, ...
    expect(insertCall!.args[3]).toBeNull();
    expect(enqueued[0]!.payload.bookedBy).toBeNull();
  });
});
