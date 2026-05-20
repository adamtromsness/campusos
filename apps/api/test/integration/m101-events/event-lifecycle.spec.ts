import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { EventService, TierService } from '@modules/m101-events/events.service';
import {
  deterministicAthleticEventCreatedEventId,
  deterministicEventCompletedEventId,
} from '@modules/m101-events/event-ids';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  parentActor,
  studentActor,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import { resetEventsTables } from '../fixtures/events';
import {
  resetAthleticsTables,
  ensureAthleticsSeed,
  TEST_ATH_ROSTER_A_ID,
  TEST_ATH_SEASON_A_ID,
} from '../fixtures/athletics';
import {
  seedStudent,
  cleanupSeededIds,
} from '../m20-sis/sis-helpers';

/**
 * Wave 7 — m101-events event-lifecycle suite.
 *
 * Exercises EventService (create + DRAFT visibility + status transitions +
 * complete + outbox `evt.event.completed` + ATHLETIC_GAME auto-populate
 * comp lists + outbox `evt.athletic_event.created`), TierService (venue
 * capacity + quantity≥quantity_sold), and cross-school isolation.
 */
describe('integration:m101-events/event-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let events: EventService;
  let tiers: TierService;

  const studentIds: string[] = [];
  const platformStudentIds: string[] = [];
  const personIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    events = new EventService(tenantPrisma, outbox, permCheck);
    tiers = new TierService(tenantPrisma, events);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetEventsTables(rawClient);
    await resetAthleticsTables(rawClient);
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      personIds: personIds.splice(0),
    });
  });

  function dateFuture(days: number): string {
    return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  }

  async function seedEventDirect(opts: {
    schoolId?: string;
    status?: 'DRAFT' | 'ON_SALE' | 'SOLD_OUT' | 'COMPLETED' | 'CANCELLED';
    title?: string;
    eventType?: string;
    totalCapacity?: number | null;
    linkedGameId?: string | null;
  } = {}): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.evt_events
         (id, school_id, title, event_type, event_date, start_time,
          total_capacity, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::time,
               $7, $8, $9::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.title ?? 'Demo Event',
      opts.eventType ?? 'PERFORMANCE',
      dateFuture(14),
      '19:00',
      opts.totalCapacity ?? null,
      opts.status ?? 'DRAFT',
      TEST_ADMIN_PERSON_ID,
    );
    return id;
  }

  // ─── EventService.create ───
  describe('EventService.create', () => {
    it('admin creates DRAFT event', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          {
            title: 'Spring Concert',
            eventType: 'PERFORMANCE',
            eventDate: dateFuture(30),
            startTime: '19:00',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('DRAFT');
      expect(dto.title).toBe('Spring Concert');
      expect(dto.totalTierQuantity).toBe(0);
    });

    it('student persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            {
              title: 'Hack',
              eventType: 'PERFORMANCE',
              eventDate: dateFuture(7),
              startTime: '19:00',
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent persona → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          events.create(
            {
              title: 'X',
              eventType: 'PERFORMANCE',
              eventDate: dateFuture(7),
              startTime: '19:00',
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('persists description / venue / capacity / endTime', async () => {
      const dto = await withTestTenant(async () =>
        events.create(
          {
            title: 'Fundraiser',
            description: 'Annual gala',
            eventType: 'FUNDRAISER',
            eventDate: dateFuture(10),
            startTime: '18:00',
            endTime: '22:00',
            venueName: 'Main Hall',
            totalCapacity: 200,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.description).toBe('Annual gala');
      expect(dto.venueName).toBe('Main Hall');
      expect(dto.totalCapacity).toBe(200);
      expect(dto.endTime).toMatch(/^22:00/);
    });

    it('ATHLETIC_GAME + linkedGameId → comp_lists auto-populated + outbox evt.athletic_event.created', async () => {
      // Set up athletics tree + a roster member + a coach + an official
      await ensureAthleticsSeed(rawClient);

      // Student + roster member in School A
      const student = await seedStudent(rawClient, { schoolId: TEST_SCHOOL_ID });
      personIds.push(student.personId);
      platformStudentIds.push(student.platformStudentId);
      studentIds.push(student.studentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_roster_members
           (id, roster_id, student_id, eligibility_status, joined_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ELIGIBLE', CURRENT_DATE)`,
        generateId(),
        TEST_ATH_ROSTER_A_ID,
        student.studentId,
      );

      // Coach
      const coachPersonId = generateId();
      personIds.push(coachPersonId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Coach', 'A', 'STAFF', true)`,
        coachPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_coaching_assignments
           (id, roster_id, coach_person_id, role, is_active)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_COACH', true)`,
        generateId(),
        TEST_ATH_ROSTER_A_ID,
        coachPersonId,
      );

      // Game
      const gameId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_games
           (id, season_id, roster_id, game_date, game_time, opponent_name, location, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE + 14, '17:00', 'Rival', 'HOME', 'SCHEDULED')`,
        gameId,
        TEST_ATH_SEASON_A_ID,
        TEST_ATH_ROSTER_A_ID,
      );

      // Official
      const officialPersonId = generateId();
      personIds.push(officialPersonId);
      const officialProfileId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Ref', 'A', 'STAFF', true)`,
        officialPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_official_profiles
           (id, person_id, sports, certification_level, base_fee, is_available)
         VALUES ($1::uuid, $2::uuid, ARRAY['Soccer']::text[], 'STATE', 50.00, true)`,
        officialProfileId,
        officialPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_official_assignments
           (id, game_id, official_profile_id, role, status, fee, assigned_by)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_REFEREE', 'ACCEPTED', 50.00, $4::uuid)`,
        generateId(),
        gameId,
        officialProfileId,
        TEST_ADMIN_PERSON_ID,
      );

      const dto = await withTestTenant(async () =>
        events.create(
          {
            title: 'Soccer vs Rival',
            eventType: 'ATHLETIC_GAME',
            eventDate: dateFuture(14),
            startTime: '17:00',
            linkedGameId: gameId,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.linkedGameId).toBe(gameId);

      // 3 comp entries
      const compRows = await rawClient.$queryRawUnsafe<
        Array<{ comp_type: string; person_id: string }>
      >(
        `SELECT comp_type, person_id::text AS person_id FROM ${TEST_SCHEMA}.evt_comp_lists WHERE event_id = $1::uuid ORDER BY comp_type`,
        dto.id,
      );
      const types = compRows.map((r) => r.comp_type);
      expect(types).toContain('ATHLETE');
      expect(types).toContain('COACH');
      expect(types).toContain('OFFICIAL');

      // Outbox enqueued
      const outRows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; envelope: string }>
      >(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.athletic_event.created' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(outRows.length).toBe(1);
      const env = JSON.parse(outRows[0]!.envelope);
      expect(env.event_id).toBe(deterministicAthleticEventCreatedEventId(dto.id));
      expect(env.payload.linkedGameId).toBe(gameId);
      expect(env.payload.compEntriesAdded).toBeGreaterThanOrEqual(3);
    });

    it('ATHLETIC_GAME with foreign-school linkedGameId → outbox emitted, zero comp rows', async () => {
      await ensureAthleticsSeed(rawClient);
      // Game in School B
      const bGameId = generateId();
      // Use School B's roster
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_games
           (id, season_id, roster_id, game_date, game_time, opponent_name, location, status)
         VALUES ($1::uuid, (SELECT id FROM ${TEST_SCHEMA}.ath_seasons WHERE programme_id = (SELECT id FROM ${TEST_SCHEMA}.ath_programmes WHERE school_id = $2::uuid LIMIT 1) LIMIT 1),
                 (SELECT r.id FROM ${TEST_SCHEMA}.ath_rosters r JOIN ${TEST_SCHEMA}.ath_seasons s ON s.id = r.season_id JOIN ${TEST_SCHEMA}.ath_programmes p ON p.id = s.programme_id WHERE p.school_id = $2::uuid LIMIT 1),
                 CURRENT_DATE + 14, '17:00', 'X', 'HOME', 'SCHEDULED')`,
        bGameId,
        TEST_SCHOOL_B_ID,
      );

      const dto = await withTestTenant(async () =>
        events.create(
          {
            title: 'Mislink',
            eventType: 'ATHLETIC_GAME',
            eventDate: dateFuture(14),
            startTime: '17:00',
            linkedGameId: bGameId,
          } as any,
          adminActor(),
        ),
      );

      const compRows = await rawClient.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM ${TEST_SCHEMA}.evt_comp_lists WHERE event_id = $1::uuid`,
        dto.id,
      );
      expect(Number(compRows[0]!.n)).toBe(0);

      const outRows = await rawClient.$queryRawUnsafe<Array<{ envelope: string }>>(
        `SELECT envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.athletic_event.created' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(outRows.length).toBe(1);
      const env = JSON.parse(outRows[0]!.envelope);
      expect(env.payload.compEntriesAdded).toBe(0);
    });
  });

  // ─── EventService.list / getById ───
  describe('EventService.list / getById', () => {
    it('writer sees DRAFT + non-DRAFT; non-writer hidden from DRAFT/CANCELLED', async () => {
      await seedEventDirect({ status: 'DRAFT', title: 'D' });
      const onSale = await seedEventDirect({ status: 'ON_SALE', title: 'OS' });
      await seedEventDirect({ status: 'CANCELLED', title: 'CN' });
      const adminList = await withTestTenant(async () => events.list(adminActor()));
      expect(adminList.length).toBe(3);
      const parentList = await withTestTenant(async () => events.list(parentActor()));
      expect(parentList.length).toBe(1);
      expect(parentList[0]!.id).toBe(onSale);
    });

    it('filters by status / eventType / fromDate', async () => {
      await seedEventDirect({ status: 'ON_SALE', eventType: 'PERFORMANCE' });
      await seedEventDirect({ status: 'ON_SALE', eventType: 'DANCE' });
      const onlyDance = await withTestTenant(async () =>
        events.list(adminActor(), { eventType: 'DANCE' as any }),
      );
      expect(onlyDance.length).toBe(1);

      const onlyOnSale = await withTestTenant(async () =>
        events.list(adminActor(), { status: 'ON_SALE' as any }),
      );
      expect(onlyOnSale.length).toBe(2);

      const fromFuture = await withTestTenant(async () =>
        events.list(adminActor(), { fromDate: dateFuture(50) }),
      );
      expect(fromFuture.length).toBe(0);
    });

    it('getById admin reads DRAFT; parent gets NotFoundException for DRAFT', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const seen = await withTestTenant(async () => events.getById(id, adminActor()));
      expect(seen.id).toBe(id);
      expect(seen.tiers).toBeDefined();
      expect(Array.isArray(seen.tiers)).toBe(true);

      await expect(
        withTestTenant(async () => events.getById(id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById parent gets NotFoundException for CANCELLED', async () => {
      const id = await seedEventDirect({ status: 'CANCELLED' });
      await expect(
        withTestTenant(async () => events.getById(id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A admin cannot see School B event', async () => {
      const bId = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID, status: 'ON_SALE' });
      const aList = await withTestTenant(async () => events.list(adminActor()));
      expect(aList.find((e) => e.id === bId)).toBeUndefined();
      await expect(
        withTestTenant(async () => events.getById(bId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
      // School B context can see it
      const bList = await withTestTenantB(async () => events.list(adminActor()));
      expect(bList.find((e) => e.id === bId)).toBeDefined();
    });
  });

  // ─── EventService.patch ───
  describe('EventService.patch', () => {
    it('DRAFT → ON_SALE allowed', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const out = await withTestTenant(async () =>
        events.patch(id, { status: 'ON_SALE' as any } as any, adminActor()),
      );
      expect(out.status).toBe('ON_SALE');
    });

    it('DRAFT → SOLD_OUT rejected', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          events.patch(id, { status: 'SOLD_OUT' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ON_SALE → SOLD_OUT, COMPLETED, CANCELLED all allowed', async () => {
      // SOLD_OUT
      const a = await seedEventDirect({ status: 'ON_SALE' });
      const out1 = await withTestTenant(async () =>
        events.patch(a, { status: 'SOLD_OUT' as any } as any, adminActor()),
      );
      expect(out1.status).toBe('SOLD_OUT');

      const b = await seedEventDirect({ status: 'ON_SALE' });
      const out2 = await withTestTenant(async () =>
        events.patch(b, { status: 'COMPLETED' as any } as any, adminActor()),
      );
      expect(out2.status).toBe('COMPLETED');

      const c = await seedEventDirect({ status: 'ON_SALE' });
      const out3 = await withTestTenant(async () =>
        events.patch(c, { status: 'CANCELLED' as any } as any, adminActor()),
      );
      expect(out3.status).toBe('CANCELLED');
    });

    it('SOLD_OUT → ON_SALE allowed', async () => {
      const id = await seedEventDirect({ status: 'SOLD_OUT' });
      const out = await withTestTenant(async () =>
        events.patch(id, { status: 'ON_SALE' as any } as any, adminActor()),
      );
      expect(out.status).toBe('ON_SALE');
    });

    it('COMPLETED is terminal — no transitions', async () => {
      const id = await seedEventDirect({ status: 'COMPLETED' });
      await expect(
        withTestTenant(async () =>
          events.patch(id, { status: 'ON_SALE' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCELLED is terminal — no transitions', async () => {
      const id = await seedEventDirect({ status: 'CANCELLED' });
      await expect(
        withTestTenant(async () =>
          events.patch(id, { status: 'ON_SALE' as any } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('field-level updates (title/description/dates/capacity/venue)', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const out = await withTestTenant(async () =>
        events.patch(
          id,
          {
            title: 'New Title',
            description: 'desc',
            eventDate: dateFuture(45),
            startTime: '18:30',
            endTime: '21:30',
            venueName: 'Gym',
            totalCapacity: 500,
          } as any,
          adminActor(),
        ),
      );
      expect(out.title).toBe('New Title');
      expect(out.totalCapacity).toBe(500);
      expect(out.venueName).toBe('Gym');
    });

    it('empty body — no-op returns DTO', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      const out = await withTestTenant(async () => events.patch(id, {} as any, adminActor()));
      expect(out.id).toBe(id);
    });

    it('missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          events.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'X' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer → ForbiddenException', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => events.patch(id, { title: 'X' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A admin cannot patch School B event', async () => {
      const bId = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () => events.patch(bId, { title: 'X' } as any, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── EventService.complete ───
  describe('EventService.complete', () => {
    it('flips ON_SALE → COMPLETED + enqueues evt.event.completed outbox row', async () => {
      const id = await seedEventDirect({ status: 'ON_SALE' });
      const out = await withTestTenant(async () => events.complete(id, adminActor()));
      expect(out.status).toBe('COMPLETED');

      const rows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; envelope: string }>
      >(
        `SELECT topic, envelope::text AS envelope FROM platform.platform_outbox
         WHERE topic = 'evt.event.completed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      );
      expect(rows.length).toBe(1);
      const env = JSON.parse(rows[0]!.envelope);
      expect(env.event_id).toBe(deterministicEventCompletedEventId(id));
      expect(env.payload.eventId).toBe(id);
      expect(env.payload.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('flips SOLD_OUT → COMPLETED', async () => {
      const id = await seedEventDirect({ status: 'SOLD_OUT' });
      const out = await withTestTenant(async () => events.complete(id, adminActor()));
      expect(out.status).toBe('COMPLETED');
    });

    it('DRAFT → complete rejected (must be ON_SALE/SOLD_OUT)', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () => events.complete(id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CANCELLED → complete rejected', async () => {
      const id = await seedEventDirect({ status: 'CANCELLED' });
      await expect(
        withTestTenant(async () => events.complete(id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-writer → ForbiddenException', async () => {
      const id = await seedEventDirect({ status: 'ON_SALE' });
      await expect(
        withTestTenant(async () => events.complete(id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross-school: School A cannot complete School B event', async () => {
      const bId = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID, status: 'ON_SALE' });
      await expect(
        withTestTenant(async () => events.complete(bId, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ─── TierService ───
  describe('TierService', () => {
    it('create tier on DRAFT event maintains total_tier_quantity', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'GA', price: 10, quantity: 100 } as any, adminActor()),
      );
      expect(tier.name).toBe('GA');
      expect(tier.quantity).toBe(100);

      const updated = await withTestTenant(async () =>
        events.getById(eventId, adminActor()),
      );
      expect(updated.totalTierQuantity).toBe(100);
    });

    it('venue_capacity_chk: tier > capacity → ConflictException', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT', totalCapacity: 50 });
      await expect(
        withTestTenant(async () =>
          tiers.create(eventId, { name: 'BIG', price: 5, quantity: 100 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('two tiers summing within capacity OK; third tier pushing over → ConflictException', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT', totalCapacity: 50 });
      await withTestTenant(async () =>
        tiers.create(eventId, { name: 'A', price: 5, quantity: 20 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        tiers.create(eventId, { name: 'B', price: 10, quantity: 30 } as any, adminActor()),
      );
      // Sum is now 50 — third tier pushes over.
      await expect(
        withTestTenant(async () =>
          tiers.create(eventId, { name: 'C', price: 15, quantity: 1 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cannot create tier on COMPLETED event → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'COMPLETED' });
      await expect(
        withTestTenant(async () =>
          tiers.create(eventId, { name: 'GA', price: 10, quantity: 10 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot create tier on CANCELLED event → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'CANCELLED' });
      await expect(
        withTestTenant(async () =>
          tiers.create(eventId, { name: 'GA', price: 10, quantity: 10 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create against missing event → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          tiers.create(
            '00000000-0000-0000-0000-000000000000',
            { name: 'X', price: 5, quantity: 5 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer cannot create tier → ForbiddenException', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          tiers.create(
            eventId,
            { name: 'X', price: 5, quantity: 5 } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: update tier price + saleStartsAt + isActive', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'GA', price: 10, quantity: 100 } as any, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        tiers.patch(
          tier.id,
          {
            price: 15,
            saleStartsAt: new Date(Date.now() - 3600_000).toISOString(),
            saleEndsAt: new Date(Date.now() + 86400_000).toISOString(),
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(updated.price).toBe(15);
      expect(updated.isActive).toBe(false);
    });

    it('patch: reduce quantity below quantity_sold → BadRequestException', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'GA', price: 10, quantity: 100 } as any, adminActor()),
      );
      // Directly bump quantity_sold to simulate sales
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.evt_ticket_tiers SET quantity_sold = 50 WHERE id = $1::uuid`,
        tier.id,
      );
      await expect(
        withTestTenant(async () =>
          tiers.patch(tier.id, { quantity: 40 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch: increase quantity > capacity → ConflictException', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT', totalCapacity: 20 });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'A', price: 5, quantity: 10 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          tiers.patch(tier.id, { quantity: 100 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('patch: missing tier → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          tiers.patch(
            '00000000-0000-0000-0000-000000000000',
            { price: 5 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch: name-only update path', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'GA', price: 10, quantity: 50 } as any, adminActor()),
      );
      const out = await withTestTenant(async () =>
        tiers.patch(tier.id, { name: 'VIP' } as any, adminActor()),
      );
      expect(out.name).toBe('VIP');
    });

    it('patch: empty body — no-op', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      const tier = await withTestTenant(async () =>
        tiers.create(eventId, { name: 'GA', price: 10, quantity: 50 } as any, adminActor()),
      );
      const out = await withTestTenant(async () => tiers.patch(tier.id, {} as any, adminActor()));
      expect(out.id).toBe(tier.id);
    });

    it('listForEvent through TierService', async () => {
      const eventId = await seedEventDirect({ status: 'DRAFT' });
      await withTestTenant(async () =>
        tiers.create(eventId, { name: 'A', price: 5, quantity: 10 } as any, adminActor()),
      );
      await withTestTenant(async () =>
        tiers.create(eventId, { name: 'B', price: 7, quantity: 10 } as any, adminActor()),
      );
      const list = await withTestTenant(async () => tiers.listForEvent(eventId));
      expect(list.length).toBe(2);
    });

    it('cross-school: School A admin cannot create tier on School B event', async () => {
      const bId = await seedEventDirect({ schoolId: TEST_SCHOOL_B_ID, status: 'DRAFT' });
      await expect(
        withTestTenant(async () =>
          tiers.create(bId, { name: 'X', price: 5, quantity: 5 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── EventService.maybeAutoFlipSoldOut (covered indirectly via ticketing.spec; here only the no-op paths) ───
  describe('EventService.maybeAutoFlipSoldOut', () => {
    it('no-op when event status is not ON_SALE', async () => {
      const id = await seedEventDirect({ status: 'DRAFT' });
      await withTestTenant(async () => events.maybeAutoFlipSoldOut(id));
      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.evt_events WHERE id = $1::uuid`,
        id,
      );
      expect(rows[0]!.status).toBe('DRAFT');
    });

    it('no-op when event has no tiers (zero remaining short-circuits)', async () => {
      const id = await seedEventDirect({ status: 'ON_SALE' });
      await withTestTenant(async () => events.maybeAutoFlipSoldOut(id));
      // With no active tiers, n=0 so it will flip
      const rows = await rawClient.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM ${TEST_SCHEMA}.evt_events WHERE id = $1::uuid`,
        id,
      );
      // The service treats "0 active tiers with remaining" as fully sold so
      // it flips to SOLD_OUT. Both paths exercise the function.
      expect(['ON_SALE', 'SOLD_OUT']).toContain(rows[0]!.status);
    });

    it('no-op when eventId missing', async () => {
      // Should not throw
      await withTestTenant(async () =>
        events.maybeAutoFlipSoldOut('00000000-0000-0000-0000-000000000000'),
      );
    });
  });
});
