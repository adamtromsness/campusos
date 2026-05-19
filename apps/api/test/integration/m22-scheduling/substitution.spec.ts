import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { Logger } from '@nestjs/common';

import { SubstitutionService } from '@modules/m22-scheduling/substitution.service';
import { CoverageService } from '@modules/m22-scheduling/coverage.service';
import { CoverageConsumer, enumerateWeekdayDates, isoWeekdayIndex } from '@modules/m22-scheduling/coverage.consumer';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';
import type { IdempotencyService } from '@shared/kafka/idempotency.service';

import {
  makeRecordingKafka,
  RecordingKafkaProducer,
} from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';

/**
 * m22-scheduling substitution / coverage integration tests. Covers:
 *   - SubstitutionService (432 lines — list, listForTeacher)
 *   - CoverageService (303 lines — list, getById, assign, cancel)
 *   - CoverageConsumer (302 lines — createCoverageRequests private logic
 *     + the exported enumerateWeekdayDates / isoWeekdayIndex helpers)
 */
describe('integration:m22-scheduling/substitution', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let substitutionService: SubstitutionService;
  let coverageService: CoverageService;
  let coverageConsumer: CoverageConsumer;

  // Stable infrastructure
  let bellScheduleId: string;
  let p1Id: string;
  let p2Id: string;
  let roomAId: string;
  let roomBId: string;
  let slotAId: string;
  let slotBId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    substitutionService = new SubstitutionService(tenantPrisma);
    coverageService = new CoverageService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );

    // Stub consumer dependencies — the consumer SUBSCRIBE on onModuleInit
    // isn't necessary for testing the handler in isolation. We construct
    // it with no-op stubs and call its private handle() method.
    const consumerStub = {
      subscribe: async () => undefined,
    } as any;
    const idempotencyStub: IdempotencyService = {
      isClaimed: async () => false,
      claim: async () => undefined,
    } as any;
    coverageConsumer = new CoverageConsumer(
      consumerStub,
      idempotencyStub,
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
    );

    // Wipe leftovers.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE name LIKE 'Sub Test%' AND school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE bell_schedule_id IN (SELECT id FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Sub Test%')`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE name LIKE 'Sub Test%'`,
    );

    // Build stable infra: bell + 2 periods + 2 rooms + 2 timetable slots.
    bellScheduleId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_bell_schedules
         (id, school_id, name, schedule_type, is_default)
       VALUES ($1::uuid, $2::uuid, $3, 'STANDARD', false)`,
      bellScheduleId,
      TEST_SCHOOL_ID,
      'Sub Test Schedule ' + Math.random().toString(36).slice(2, 6),
    );

    p1Id = generateId();
    p2Id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_periods
         (id, bell_schedule_id, name, day_of_week, start_time, end_time, period_type, sort_order)
       VALUES
         ($1::uuid, $3::uuid, 'P1', NULL, '08:00', '09:00', 'LESSON', 1),
         ($2::uuid, $3::uuid, 'P2', NULL, '09:05', '10:05', 'LESSON', 2)`,
      p1Id,
      p2Id,
      bellScheduleId,
    );

    roomAId = generateId();
    roomBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_rooms (id, school_id, name, capacity, room_type)
       VALUES
         ($1::uuid, $3::uuid, 'Sub Test Room A', 30, 'CLASSROOM'),
         ($2::uuid, $3::uuid, 'Sub Test Room B', 30, 'CLASSROOM')`,
      roomAId,
      roomBId,
      TEST_SCHOOL_ID,
    );

    slotAId = generateId();
    slotBId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_timetable_slots
         (id, school_id, class_id, period_id, teacher_id, room_id, effective_from, effective_to)
       VALUES
         ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, '2027-01-01', '2027-12-31'),
         ($2::uuid, $3::uuid, $4::uuid, $8::uuid, $6::uuid, $9::uuid, '2027-01-01', '2027-12-31')`,
      slotAId,
      slotBId,
      TEST_SCHOOL_ID,
      TEST_SIS_CLASS_ID,
      p1Id,
      TEST_TEACHER_EMPLOYEE_ID,
      roomAId,
      p2Id,
      roomBId,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_timetable_slots WHERE id IN ($1::uuid, $2::uuid)`,
      slotAId,
      slotBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_rooms WHERE id IN ($1::uuid, $2::uuid)`,
      roomAId,
      roomBId,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_periods WHERE id IN ($1::uuid, $2::uuid)`,
      p1Id,
      p2Id,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_bell_schedules WHERE id = $1::uuid`,
      bellScheduleId,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function seedCoverageRow(
    opts: {
      slotId?: string;
      absentTeacher?: string;
      coverageDate?: string;
      status?: 'OPEN' | 'ASSIGNED' | 'COVERED' | 'CANCELLED';
      schoolId?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sch_coverage_requests
         (id, school_id, timetable_slot_id, absent_teacher_id, coverage_date, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.slotId ?? slotAId,
      opts.absentTeacher ?? TEST_TEACHER_EMPLOYEE_ID,
      opts.coverageDate ?? '2027-03-15',
      opts.status ?? 'OPEN',
    );
    return id;
  }

  // ────────────────────────────────────────────────────────────────────
  // CoverageService.list / getById
  // ────────────────────────────────────────────────────────────────────
  describe('CoverageService.list', () => {
    it('admin sees all coverage rows', async () => {
      const id1 = await seedCoverageRow({ coverageDate: '2027-03-15' });
      const id2 = await seedCoverageRow({
        slotId: slotBId,
        coverageDate: '2027-03-16',
      });
      const list = await withTestTenant(async () =>
        coverageService.list({} as any, adminActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(id1);
      expect(ids).toContain(id2);
    });

    it('non-admin without employeeId sees []', async () => {
      await seedCoverageRow();
      const result = await withTestTenant(async () =>
        coverageService.list({} as any, {
          accountId: '00000000-0000-0000-0000-000000000099',
          personId: '00000000-0000-0000-0000-000000000099',
          employeeId: null,
          personType: 'STAFF',
          isSchoolAdmin: false,
        } as any),
      );
      expect(result).toEqual([]);
    });

    it('non-admin sees only rows where they are absent or assigned', async () => {
      const mine = await seedCoverageRow({
        absentTeacher: TEST_TEACHER_EMPLOYEE_ID,
        coverageDate: '2027-03-15',
      });
      const other = await seedCoverageRow({
        absentTeacher: TEST_ADMIN_EMPLOYEE_ID,
        slotId: slotBId,
        coverageDate: '2027-03-15',
      });
      const list = await withTestTenant(async () =>
        coverageService.list({} as any, teacherActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(other);
    });

    it('list filters by date range and status', async () => {
      const open1 = await seedCoverageRow({ status: 'OPEN', coverageDate: '2027-05-01' });
      const open2 = await seedCoverageRow({
        status: 'OPEN',
        slotId: slotBId,
        coverageDate: '2027-06-01',
      });
      const list = await withTestTenant(async () =>
        coverageService.list(
          { fromDate: '2027-05-01', toDate: '2027-05-15', status: 'OPEN' } as any,
          adminActor(),
        ),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(open1);
      expect(ids).not.toContain(open2);
    });

    it('getById unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          coverageService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById: non-admin uninvolved → NotFoundException', async () => {
      const id = await seedCoverageRow({ absentTeacher: TEST_ADMIN_EMPLOYEE_ID });
      await expect(
        withTestTenant(async () => coverageService.getById(id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CoverageService.assign
  // ────────────────────────────────────────────────────────────────────
  describe('CoverageService.assign', () => {
    it('admin assigns OPEN → ASSIGNED, emits sch.coverage.assigned', async () => {
      const id = await seedCoverageRow();
      const dto = await withTestTenant(async () =>
        coverageService.assign(
          id,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID, notes: 'auto' } as any,
          adminActor(),
        ),
      );
      expect(dto.status).toBe('ASSIGNED');
      expect(dto.assignedSubstituteId).toBe(TEST_ADMIN_EMPLOYEE_ID);

      // Substitution row inserted
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE coverage_request_id = $1::uuid`,
        id,
      )) as Array<{ id: string }>;
      expect(rows.length).toBe(1);

      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'sch.coverage.assigned',
      );
      expect(emits.length).toBe(1);
      expect(emits[0]!.key).toBe(id);
    });

    it('non-admin assign → ForbiddenException', async () => {
      const id = await seedCoverageRow();
      await expect(
        withTestTenant(async () =>
          coverageService.assign(
            id,
            { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assign unknown → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          coverageService.assign(
            '00000000-0000-0000-0000-000000000000',
            { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assign on already-ASSIGNED → BadRequestException', async () => {
      const id = await seedCoverageRow();
      await withTestTenant(async () =>
        coverageService.assign(
          id,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          coverageService.assign(
            id,
            { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('substituteId === absent_teacher_id → BadRequestException', async () => {
      const id = await seedCoverageRow({ absentTeacher: TEST_TEACHER_EMPLOYEE_ID });
      await expect(
        withTestTenant(async () =>
          coverageService.assign(
            id,
            { substituteId: TEST_TEACHER_EMPLOYEE_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CoverageService.cancel
  // ────────────────────────────────────────────────────────────────────
  describe('CoverageService.cancel', () => {
    it('admin cancels OPEN → CANCELLED', async () => {
      const id = await seedCoverageRow();
      const dto = await withTestTenant(async () =>
        coverageService.cancel(id, { notes: 'no longer needed' } as any, adminActor()),
      );
      expect(dto.status).toBe('CANCELLED');
    });

    it('admin cancels ASSIGNED → CANCELLED, substitution row dropped', async () => {
      const id = await seedCoverageRow();
      await withTestTenant(async () =>
        coverageService.assign(
          id,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        coverageService.cancel(id, {} as any, adminActor()),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE coverage_request_id = $1::uuid`,
        id,
      )) as Array<{ id: string }>;
      expect(rows.length).toBe(0);
    });

    it('cancel already-CANCELLED → BadRequestException', async () => {
      const id = await seedCoverageRow();
      await withTestTenant(async () =>
        coverageService.cancel(id, {} as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          coverageService.cancel(id, {} as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel non-admin → ForbiddenException', async () => {
      const id = await seedCoverageRow();
      await expect(
        withTestTenant(async () =>
          coverageService.cancel(id, {} as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          coverageService.cancel(
            '00000000-0000-0000-0000-000000000000',
            {} as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SubstitutionService
  // ────────────────────────────────────────────────────────────────────
  describe('SubstitutionService', () => {
    async function seedAssignedCoverage(opts: { coverageDate?: string } = {}): Promise<{
      coverageId: string;
      substitutionId: string;
    }> {
      const coverageId = await seedCoverageRow({
        coverageDate: opts.coverageDate ?? '2027-03-20',
      });
      await withTestTenant(async () =>
        coverageService.assign(
          coverageId,
          { substituteId: TEST_ADMIN_EMPLOYEE_ID } as any,
          adminActor(),
        ),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.sch_substitution_timetable WHERE coverage_request_id = $1::uuid LIMIT 1`,
        coverageId,
      )) as Array<{ id: string }>;
      return { coverageId, substitutionId: rows[0]!.id };
    }

    it('list returns substitutions', async () => {
      const { substitutionId } = await seedAssignedCoverage();
      const list = await withTestTenant(async () =>
        substitutionService.list({} as any),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(substitutionId);
    });

    it('list filters by date range', async () => {
      const a = await seedAssignedCoverage({ coverageDate: '2027-04-01' });
      const b = await seedAssignedCoverage({ coverageDate: '2027-05-01' });
      const list = await withTestTenant(async () =>
        substitutionService.list({
          fromDate: '2027-04-01',
          toDate: '2027-04-30',
        } as any),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(a.substitutionId);
      expect(ids).not.toContain(b.substitutionId);
    });

    it('listForTeacher only returns rows where they are the substitute', async () => {
      const { substitutionId } = await seedAssignedCoverage();
      const mine = await withTestTenant(async () =>
        substitutionService.listForTeacher(TEST_ADMIN_EMPLOYEE_ID, {} as any),
      );
      expect(mine.map((r) => r.id)).toContain(substitutionId);

      const other = await withTestTenant(async () =>
        substitutionService.listForTeacher(TEST_TEACHER_EMPLOYEE_ID, {} as any),
      );
      expect(other.map((r) => r.id)).not.toContain(substitutionId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // CoverageConsumer
  // ────────────────────────────────────────────────────────────────────
  describe('CoverageConsumer helpers', () => {
    it('enumerateWeekdayDates skips weekends', () => {
      // 2027-03-15 is Monday, 2027-03-21 is Sunday
      const dates = enumerateWeekdayDates('2027-03-15', '2027-03-21');
      expect(dates).toEqual([
        '2027-03-15',
        '2027-03-16',
        '2027-03-17',
        '2027-03-18',
        '2027-03-19',
      ]);
    });

    it('enumerateWeekdayDates handles start > end', () => {
      const dates = enumerateWeekdayDates('2027-03-15', '2027-03-10');
      expect(dates).toEqual([]);
    });

    it('isoWeekdayIndex returns Mon=0 ... Sun=6', () => {
      expect(isoWeekdayIndex('2027-03-15')).toBe(0); // Mon
      expect(isoWeekdayIndex('2027-03-19')).toBe(4); // Fri
      expect(isoWeekdayIndex('2027-03-21')).toBe(6); // Sun
    });
  });

  describe('CoverageConsumer handle', () => {
    it('inserts OPEN coverage rows for each weekday in range', async () => {
      const requestId = generateId();
      const eventId = generateId();
      // Drive the consumer via simulated unwrap. Easiest path: call
      // handle() with a synthesised ConsumedMessage that contains the
      // envelope shape unwrapEnvelope expects.
      const envelope = {
        event_id: eventId,
        event_type: 'hr.leave.coverage_needed',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        tenant_id: TEST_SCHOOL_ID,
        tenant_subdomain: 'test',
        source_module: 'hr',
        correlation_id: null,
        payload: {
          requestId,
          employeeId: TEST_TEACHER_EMPLOYEE_ID,
          startDate: '2027-04-05', // Monday
          endDate: '2027-04-09', // Friday
          affectedClasses: [{ classId: TEST_SIS_CLASS_ID }],
        },
      };
      const msg = {
        topic: 'hr.leave.coverage_needed',
        partition: 0,
        offset: '0',
        key: requestId,
        payload: envelope,
        headers: { 'tenant-id': TEST_SCHOOL_ID, 'tenant-subdomain': 'test' },
        timestamp: new Date().toISOString(),
      } as any;

      // Invoke the private handle() method (cast as any).
      await (coverageConsumer as any).handle(msg);

      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT id, coverage_date::text AS date, status, school_id::text AS school_id
           FROM ${TEST_SCHEMA}.sch_coverage_requests
         WHERE leave_request_id = $1::uuid
         ORDER BY coverage_date`,
        requestId,
      )) as Array<{ id: string; date: string; status: string; school_id: string }>;

      // 5 weekdays × 2 slots (slotA + slotB) = 10 rows. Both slots have
      // day_of_week=NULL so they apply every weekday.
      expect(rows.length).toBe(10);
      expect(rows.every((r) => r.status === 'OPEN')).toBe(true);
      expect(rows.every((r) => r.school_id === TEST_SCHOOL_ID)).toBe(true);

      // sch.coverage.needed emitted
      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'sch.coverage.needed',
      );
      expect(emits.length).toBe(1);
      expect(emits[0]!.key).toBe(requestId);
    });

    it('drops payload with missing required fields', async () => {
      const envelope = {
        event_id: generateId(),
        event_type: 'hr.leave.coverage_needed',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        tenant_id: TEST_SCHOOL_ID,
        tenant_subdomain: 'test',
        source_module: 'hr',
        correlation_id: null,
        payload: { requestId: generateId() }, // missing employeeId / dates
      };
      const msg = {
        topic: 'hr.leave.coverage_needed',
        partition: 0,
        offset: '0',
        key: 'k',
        value: JSON.stringify(envelope),
        headers: { 'tenant-id': TEST_SCHOOL_ID, 'tenant-subdomain': 'test' },
      } as any;
      await (coverageConsumer as any).handle(msg);
      // No new rows
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE leave_request_id = $1::uuid`,
        envelope.payload.requestId,
      )) as Array<{ count: number }>;
      expect(rows[0]!.count).toBe(0);
    });

    it('skips empty affectedClasses array', async () => {
      const requestId = generateId();
      const envelope = {
        event_id: generateId(),
        event_type: 'hr.leave.coverage_needed',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        tenant_id: TEST_SCHOOL_ID,
        tenant_subdomain: 'test',
        source_module: 'hr',
        correlation_id: null,
        payload: {
          requestId,
          employeeId: TEST_TEACHER_EMPLOYEE_ID,
          startDate: '2027-04-05',
          endDate: '2027-04-09',
          affectedClasses: [],
        },
      };
      const msg = {
        topic: 'hr.leave.coverage_needed',
        partition: 0,
        offset: '0',
        key: 'k',
        value: JSON.stringify(envelope),
        headers: { 'tenant-id': TEST_SCHOOL_ID, 'tenant-subdomain': 'test' },
      } as any;
      await (coverageConsumer as any).handle(msg);
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE leave_request_id = $1::uuid`,
        requestId,
      )) as Array<{ count: number }>;
      expect(rows[0]!.count).toBe(0);
    });

    it('redelivery is idempotent via IdempotencyService — second call drops the event', async () => {
      // The production redelivery contract uses deterministic event_id +
      // IdempotencyService.isClaimed. In this test we drive the same
      // pattern: the consumer uses an IdempotencyService stub that
      // returns true on the second call so the work is skipped.
      const requestId = generateId();
      const eventId = generateId();
      const envelope = {
        event_id: eventId,
        event_type: 'hr.leave.coverage_needed',
        event_version: 1,
        occurred_at: new Date().toISOString(),
        published_at: new Date().toISOString(),
        tenant_id: TEST_SCHOOL_ID,
        tenant_subdomain: 'test',
        source_module: 'hr',
        correlation_id: null,
        payload: {
          requestId,
          employeeId: TEST_TEACHER_EMPLOYEE_ID,
          startDate: '2027-05-03', // Mon
          endDate: '2027-05-04', // Tue
          affectedClasses: [{ classId: TEST_SIS_CLASS_ID }],
        },
      };
      const msg = {
        topic: 'hr.leave.coverage_needed',
        partition: 0,
        offset: '0',
        key: requestId,
        payload: envelope,
        headers: { 'tenant-id': TEST_SCHOOL_ID, 'tenant-subdomain': 'test' },
        timestamp: new Date().toISOString(),
      } as any;

      // First call — unclaimed, runs the work.
      let claimed = false;
      const stubIdempotency = {
        isClaimed: async () => claimed,
        claim: async () => {
          claimed = true;
        },
      };
      const consumerStub = { subscribe: async () => undefined } as any;
      const localConsumer = new CoverageConsumer(
        consumerStub,
        stubIdempotency as any,
        tenantPrisma,
        kafka as unknown as KafkaProducerService,
      );

      await (localConsumer as any).handle(msg);
      const firstCount = ((await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE leave_request_id = $1::uuid`,
        requestId,
      )) as Array<{ count: number }>)[0]!.count;
      expect(firstCount).toBeGreaterThan(0);

      // Re-deliver — IdempotencyService now reports claimed=true; the
      // wrapper drops the event before the DB is touched.
      await (localConsumer as any).handle(msg);
      const secondCount = ((await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.sch_coverage_requests WHERE leave_request_id = $1::uuid`,
        requestId,
      )) as Array<{ count: number }>)[0]!.count;
      expect(secondCount).toBe(firstCount);
    });
  });
});
