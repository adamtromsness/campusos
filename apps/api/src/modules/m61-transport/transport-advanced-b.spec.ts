import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, BadRequestException, NotFoundException } from '@nestjs/common';
import { runWithTenantContext } from '@shared/tenant/tenant.context';
import { PERMISSIONS_KEY } from '@shared/auth/require-permission.decorator';
import { RouteConstraintService } from './route-constraint.service';
import { RouteGenerationService } from './route-generation.service';
import { AdhocTripService } from './adhoc-trip.service';
import { ContractedRouteService } from './contracted-route.service';
import { RouteGenerationController } from './route-generation.controller';

const SCHOOL = {
  schoolId: '019e0f00-aaaa-7000-8000-aaaa00000001',
  subdomain: 'demo',
} as never;

const ADMIN_ACTOR = {
  accountId: '019e0f00-aaaa-7000-8000-bbbb00000001',
  personId: '019e0f00-aaaa-7000-8000-bbbb00000002',
  employeeId: '019e0f00-aaaa-7000-8000-bbbb00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: true,
} as never;

const STAFF_ACTOR = {
  accountId: '019e0f00-aaaa-7000-8000-cccc00000001',
  personId: '019e0f00-aaaa-7000-8000-cccc00000002',
  employeeId: '019e0f00-aaaa-7000-8000-cccc00000003',
  personType: 'STAFF' as const,
  isSchoolAdmin: false,
} as never;

const STUDENT_ACTOR = {
  accountId: '019e0f00-aaaa-7000-8000-dddd00000001',
  personId: '019e0f00-aaaa-7000-8000-dddd00000002',
  employeeId: null,
  personType: 'STUDENT' as const,
  isSchoolAdmin: false,
} as never;

const GUARDIAN_ACTOR = {
  accountId: '019e0f00-aaaa-7000-8000-eeee00000001',
  personId: '019e0f00-aaaa-7000-8000-eeee00000002',
  employeeId: null,
  personType: 'GUARDIAN' as const,
  isSchoolAdmin: false,
} as never;

const CONSTRAINT_ID = '019e0f00-aaaa-7000-8000-ff0000000001';
const REQUEST_ID = '019e0f00-aaaa-7000-8000-ff0000000002';
const CANDIDATE_ID = '019e0f00-aaaa-7000-8000-ff0000000003';
const ROUTE_ID = '019e0f00-aaaa-7000-8000-ff0000000004';
const TRIP_ID = '019e0f00-aaaa-7000-8000-ff0000000005';
const VEHICLE_ID = '019e0f00-aaaa-7000-8000-ff0000000006';
const DRIVER_ID = '019e0f00-aaaa-7000-8000-ff0000000007';

interface CapturedCall {
  sql: string;
  args: unknown[];
  fn: 'query' | 'execute';
}

function makeFake(handler: (call: CapturedCall) => unknown) {
  const capture: CapturedCall[] = [];
  const client = {
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'query' };
      capture.push(call);
      return handler(call) ?? [];
    },
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      const call: CapturedCall = { sql, args, fn: 'execute' };
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
    eventId?: string;
    payload: Record<string, unknown>;
  }> = [];
  const outbox = {
    enqueueInTx: vi.fn(async (_tx: unknown, opts: any) => {
      enqueued.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        eventId: opts.eventId,
        payload: opts.payload,
      });
      return 'outbox-id';
    }),
  };
  return { outbox, enqueued };
}

function makePermCheck(opts: { allow?: boolean } = {}) {
  const allow = opts.allow ?? true;
  return {
    hasAnyPermissionInTenant: vi.fn(async () => allow),
  };
}

function makeKafka() {
  const emitted: Array<{
    topic: string;
    sourceModule?: string;
    key?: string;
    payload: Record<string, unknown>;
  }> = [];
  const kafka = {
    emit: async (opts: any) => {
      emitted.push({
        topic: opts.topic,
        sourceModule: opts.sourceModule,
        key: opts.key,
        payload: opts.payload,
      });
    },
  };
  return { kafka, emitted };
}

function makeWorkflows(returnId: string | null = 'workflow-id-001') {
  const submissions: Array<{ body: any; actor: any }> = [];
  const wf = {
    submit: async (body: any, actor: any) => {
      submissions.push({ body, actor });
      if (returnId === null) {
        throw new BadRequestException('No active workflow template');
      }
      return { id: returnId };
    },
  };
  return { workflows: wf, submissions };
}

// ============================================================
// RouteConstraintService — permission gate + UNIQUE catch
// ============================================================
describe('RouteConstraintService — permission gate', () => {
  it('create() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new RouteConstraintService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ constraintName: 'Test' }, STUDENT_ACTOR),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create() accepts STAFF + admin', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select') && sql.includes('trn_route_constraints')) {
        return [
          {
            id: CONSTRAINT_ID,
            school_id: SCHOOL.schoolId,
            constraint_name: 'T',
            max_ride_time_minutes: 45,
            max_route_mileage: null,
            max_students_per_vehicle: null,
            required_arrival_buffer_minutes: 10,
            max_stops_per_route: null,
            walkable_radius_metres: 400,
            is_active: true,
            notes: null,
            created_by: null,
            created_at: new Date('2026-05-11T00:00:00Z'),
            updated_at: new Date('2026-05-11T00:00:00Z'),
          },
        ];
      }
      return [];
    });
    const svc = new RouteConstraintService(fake.tenantPrisma as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const dto = await svc.create({ constraintName: 'T' }, STAFF_ACTOR);
      expect(dto.constraintName).toBe('T');
    });
    const insert = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_route_constraints'),
    );
    expect(insert, 'INSERT into trn_route_constraints').toBeTruthy();
  });

  it('create() translates 23505 to a friendly 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('insert into trn_route_constraints')) {
        const err: any = new Error('Unique constraint failed (23505)');
        err.meta = { code: '23505' };
        throw err;
      }
      return [];
    });
    const svc = new RouteConstraintService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create({ constraintName: 'Duplicate' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// RouteGenerationService — manual candidate + approve keystone
// ============================================================
describe('RouteGenerationService — queue + manual candidate + approve', () => {
  it('queueRequest() refuses requestType=FULL_YEAR without academicYearId', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.queueRequest(
          {
            requestType: 'FULL_YEAR',
            constraintId: CONSTRAINT_ID,
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queueRequest() refuses DATE_RANGE without dateFrom/dateTo', async () => {
    const fake = makeFake(() => []);
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.queueRequest(
          { requestType: 'DATE_RANGE', constraintId: CONSTRAINT_ID, dateFrom: '2026-09-01' },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queueRequest() refuses inactive constraint profile', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select is_active from trn_route_constraints')) {
        return [{ is_active: false }];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.queueRequest(
          {
            requestType: 'FULL_YEAR',
            constraintId: CONSTRAINT_ID,
            academicYearId: '019e0f00-aaaa-7000-8000-ff0000000099',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addManualCandidate() refuses duplicate sequence_order across stops', async () => {
    const fake = makeFake(() => [{ status: 'RUNNING' }]);
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addManualCandidate(
          REQUEST_ID,
          {
            candidateName: 'X',
            direction: 'AM',
            vehicleTypeRequired: 'BUS',
            estimatedRouteMileage: 12.0,
            estimatedDurationMinutes: 25,
            maxStudentRideTimeMinutes: 20,
            stops: [
              {
                stopName: 'A',
                latitude: 39.7,
                longitude: -89.6,
                sequenceOrder: 1,
                studentIds: ['019e0f00-aaaa-7000-8000-ff0000000aaa'],
              },
              {
                stopName: 'B',
                latitude: 39.7,
                longitude: -89.6,
                sequenceOrder: 1,
                studentIds: ['019e0f00-aaaa-7000-8000-ff0000000bbb'],
              },
            ],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('addManualCandidate() refuses when parent request is COMPLETED', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_generation_requests')) {
        return [{ status: 'COMPLETED' }];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.addManualCandidate(
          REQUEST_ID,
          {
            candidateName: 'X',
            direction: 'AM',
            vehicleTypeRequired: 'BUS',
            estimatedRouteMileage: 12.0,
            estimatedDurationMinutes: 25,
            maxStudentRideTimeMinutes: 20,
            stops: [
              {
                stopName: 'A',
                latitude: 39.7,
                longitude: -89.6,
                sequenceOrder: 1,
                studentIds: ['019e0f00-aaaa-7000-8000-ff0000000aaa'],
              },
            ],
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approveCandidate() — keystone: creates trn_routes + trn_stops + trn_student_assignments inside one tx', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      // REVIEW-P2C11 BLOCKING 5 — lock SQL now JOINs through
      // trn_generation_requests for the school predicate and returns
      // academic_year_id inline.
      if (sql.includes('from trn_generation_candidates') && sql.includes('for update')) {
        return [
          {
            id: CANDIDATE_ID,
            request_id: REQUEST_ID,
            candidate_name: 'CandX',
            direction: 'AM',
            review_status: 'PENDING',
            total_students: 3,
            total_stops: 2,
            academic_year_id: null,
          },
        ];
      }
      if (sql.includes('from trn_vehicles where id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from hr_employees where id')) {
        return [{ ok: 1 }];
      }
      if (sql.includes('from trn_generation_candidate_stops')) {
        return [
          {
            id: 'stop-a',
            stop_name: 'A',
            address: null,
            latitude: '39.7',
            longitude: '-89.6',
            sequence_order: 1,
            scheduled_time: null,
            student_ids: ['019e0f00-aaaa-7000-8000-ff000000s001'],
          },
          {
            id: 'stop-b',
            stop_name: 'B',
            address: null,
            latitude: '39.71',
            longitude: '-89.61',
            sequence_order: 2,
            scheduled_time: null,
            student_ids: ['019e0f00-aaaa-7000-8000-ff000000s002'],
          },
        ];
      }
      // getById round-trip
      if (sql.includes('select id::text as id') && sql.includes('from trn_generation_candidates')) {
        return [
          {
            id: CANDIDATE_ID,
            request_id: REQUEST_ID,
            candidate_name: 'CandX',
            direction: 'AM',
            vehicle_type_required: 'BUS',
            total_students: 3,
            total_stops: 2,
            estimated_route_mileage: '15.0',
            estimated_duration_minutes: 30,
            max_student_ride_time_minutes: 28,
            all_constraints_satisfied: true,
            constraint_violations: null,
            review_status: 'APPROVED',
            reviewed_by: ADMIN_ACTOR.accountId,
            reviewed_at: new Date('2026-05-11T00:00:00Z'),
            review_notes: 'ok',
            approved_route_id: ROUTE_ID,
            created_at: new Date('2026-05-11T00:00:00Z'),
            updated_at: new Date('2026-05-11T00:00:00Z'),
          },
        ];
      }
      if (
        sql.includes('from trn_generation_candidate_stops') &&
        sql.includes('order by sequence_order asc')
      ) {
        return [];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.approveCandidate(
        CANDIDATE_ID,
        {
          routeName: 'Approved Route',
          vehicleId: VEHICLE_ID,
          driverId: DRIVER_ID,
          reviewNotes: 'ok',
        },
        ADMIN_ACTOR,
      );
    });

    const insertRoute = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_routes'),
    );
    expect(insertRoute, 'INSERT into trn_routes').toBeTruthy();

    const insertStops = fake.capture.filter((c) =>
      c.sql.toLowerCase().includes('insert into trn_stops'),
    );
    expect(insertStops.length, 'INSERT into trn_stops called per candidate stop').toBe(2);

    const insertAssignments = fake.capture.filter((c) =>
      c.sql.toLowerCase().includes('insert into trn_student_assignments'),
    );
    expect(insertAssignments.length, 'INSERT into trn_student_assignments per student').toBe(2);

    const flipCandidate = fake.capture.find(
      (c) =>
        c.sql
          .toLowerCase()
          .includes("update trn_generation_candidates set review_status = 'approved'") &&
        c.sql.toLowerCase().includes('approved_route_id'),
    );
    expect(flipCandidate, 'UPDATE candidate to APPROVED + stamp approved_route_id').toBeTruthy();
  });

  it('approveCandidate() refuses when review_status is not PENDING', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_generation_candidates') && sql.includes('for update')) {
        return [
          {
            id: CANDIDATE_ID,
            request_id: REQUEST_ID,
            candidate_name: 'CandX',
            direction: 'AM',
            review_status: 'REJECTED',
            total_students: 3,
            total_stops: 2,
          },
        ];
      }
      return [];
    });
    const { kafka } = makeKafka();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.approveCandidate(CANDIDATE_ID, { routeName: 'X' }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('markRequestCompleted() — emits trn.generation.completed with ADR-057 shape', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_generation_requests') && sql.includes('for update')) {
        return [
          { status: 'RUNNING', school_id: SCHOOL.schoolId, requested_by: ADMIN_ACTOR.accountId },
        ];
      }
      if (sql.includes('count(*)::int as routes_generated')) {
        return [{ routes_generated: 3, students_covered: 20 }];
      }
      if (sql.includes('select students_uncovered, completed_at')) {
        return [{ students_uncovered: 2, completed_at: new Date('2026-05-11T00:00:00Z') }];
      }
      // getRequestById hit
      if (sql.includes('select r.id::text as id') && sql.includes('from trn_generation_requests')) {
        return [
          {
            id: REQUEST_ID,
            school_id: SCHOOL.schoolId,
            requested_by: ADMIN_ACTOR.accountId,
            request_type: 'FULL_YEAR',
            academic_year_id: null,
            term_id: null,
            date_from: null,
            date_to: null,
            constraint_id: CONSTRAINT_ID,
            constraint_name: 'X',
            directions: 'BOTH',
            status: 'COMPLETED',
            optimiser_run_id: null,
            routes_generated: 3,
            students_covered: 20,
            students_uncovered: 2,
            error_message: null,
            queued_at: new Date('2026-05-11T00:00:00Z'),
            started_at: new Date('2026-05-11T00:00:00Z'),
            completed_at: new Date('2026-05-11T00:00:00Z'),
            created_at: new Date('2026-05-11T00:00:00Z'),
            updated_at: new Date('2026-05-11T00:00:00Z'),
          },
        ];
      }
      if (sql.includes('from trn_generation_candidates')) {
        return [];
      }
      return [];
    });
    const { outbox, enqueued } = makeOutbox();
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.markRequestCompleted(REQUEST_ID, ADMIN_ACTOR);
    });

    // REVIEW-P2C11 BLOCKING 3 — emit lands via outbox.enqueueInTx,
    // not best-effort kafka.emit.
    expect(enqueued.length, 'one trn.generation.completed envelope').toBe(1);
    expect(enqueued[0]!.topic).toBe('trn.generation.completed');
    expect(enqueued[0]!.sourceModule).toBe('transport');
    expect(enqueued[0]!.eventId, 'deterministic event_id present').toBeTruthy();
    expect(enqueued[0]!.payload).toMatchObject({
      requestId: REQUEST_ID,
      schoolId: SCHOOL.schoolId,
      routesGenerated: 3,
      studentsCovered: 20,
      studentsUncovered: 2,
    });
  });
});

// ============================================================
// AdhocTripService — wsk_approval_requests routing + lifecycle
// ============================================================
describe('AdhocTripService — workflow engine integration + lifecycle', () => {
  it('submit() routes through the workflow engine and stamps linked_approval_id', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_adhoc_trip_requests')) {
        return [
          {
            id: TRIP_ID,
            school_id: SCHOOL.schoolId,
            requested_by: ADMIN_ACTOR.accountId,
            requested_by_name: 'Tester',
            trip_purpose: 'ATHLETIC_EVENT',
            trip_date: new Date('2030-09-01'),
            departure_time: '08:30:00',
            return_time: '17:30:00',
            pickup_location: 'School',
            destination: 'Away',
            estimated_passengers: 35,
            special_requirements: null,
            linked_event_id: null,
            assigned_vehicle_id: null,
            assigned_vehicle_name: null,
            assigned_driver_id: null,
            assigned_driver_name: null,
            status: 'REQUESTED',
            linked_approval_id: 'workflow-id-001',
            approval_notes: null,
            cancellation_reason: null,
            scheduled_at: null,
            completed_at: null,
            created_at: new Date('2026-05-11T00:00:00Z'),
            updated_at: new Date('2026-05-11T00:00:00Z'),
          },
        ];
      }
      return [];
    });
    const { workflows, submissions } = makeWorkflows('workflow-id-001');
    const svc = new AdhocTripService(fake.tenantPrisma as never, workflows as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.submit(
        {
          tripPurpose: 'ATHLETIC_EVENT',
          tripDate: '2030-09-01',
          pickupLocation: 'School',
          destination: 'Away',
          estimatedPassengers: 35,
        },
        ADMIN_ACTOR,
      );
    });

    expect(submissions.length, 'workflow engine called once').toBe(1);
    expect(submissions[0]!.body).toMatchObject({
      requestType: 'TRN_ADHOC_TRIP',
      referenceTable: 'trn_adhoc_trip_requests',
    });

    const insertTrip = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('insert into trn_adhoc_trip_requests'),
    );
    expect(insertTrip, 'INSERT into trn_adhoc_trip_requests').toBeTruthy();

    const stampApproval = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('update trn_adhoc_trip_requests') &&
        c.sql.toLowerCase().includes('linked_approval_id'),
    );
    expect(stampApproval, 'stamps linked_approval_id after workflow engine returns').toBeTruthy();
  });

  it('submit() — workflow engine failure leaves the trip row in REQUESTED with linked_approval_id NULL', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_adhoc_trip_requests')) {
        return [
          {
            id: TRIP_ID,
            school_id: SCHOOL.schoolId,
            requested_by: ADMIN_ACTOR.accountId,
            requested_by_name: 'Tester',
            trip_purpose: 'ATHLETIC_EVENT',
            trip_date: new Date('2030-09-01'),
            departure_time: null,
            return_time: null,
            pickup_location: 'School',
            destination: 'Away',
            estimated_passengers: 35,
            special_requirements: null,
            linked_event_id: null,
            assigned_vehicle_id: null,
            assigned_vehicle_name: null,
            assigned_driver_id: null,
            assigned_driver_name: null,
            status: 'REQUESTED',
            linked_approval_id: null,
            approval_notes: null,
            cancellation_reason: null,
            scheduled_at: null,
            completed_at: null,
            created_at: new Date('2026-05-11T00:00:00Z'),
            updated_at: new Date('2026-05-11T00:00:00Z'),
          },
        ];
      }
      return [];
    });
    const { workflows } = makeWorkflows(null); // simulate no template configured
    const svc = new AdhocTripService(fake.tenantPrisma as never, workflows as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      const dto = await svc.submit(
        {
          tripPurpose: 'ATHLETIC_EVENT',
          tripDate: '2030-09-01',
          pickupLocation: 'School',
          destination: 'Away',
          estimatedPassengers: 35,
        },
        ADMIN_ACTOR,
      );
      expect(dto.linkedApprovalId).toBeNull();
    });

    const stampApproval = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('update trn_adhoc_trip_requests') &&
        c.sql.toLowerCase().includes('linked_approval_id'),
    );
    expect(stampApproval, 'no linked_approval_id UPDATE when workflow engine fails').toBeFalsy();
  });

  it('submit() refuses past tripDate', async () => {
    const fake = makeFake(() => []);
    const { workflows } = makeWorkflows();
    const svc = new AdhocTripService(fake.tenantPrisma as never, workflows as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.submit(
          {
            tripPurpose: 'FIELD_TRIP',
            tripDate: '2020-01-01',
            pickupLocation: 'A',
            destination: 'B',
            estimatedPassengers: 5,
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('assign() refuses to land vehicle on a REQUESTED trip', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('select status from trn_adhoc_trip_requests')) {
        return [{ status: 'REQUESTED' }];
      }
      return [];
    });
    const { workflows } = makeWorkflows();
    const svc = new AdhocTripService(fake.tenantPrisma as never, workflows as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.assign(TRIP_ID, { vehicleId: VEHICLE_ID, driverId: DRIVER_ID }, ADMIN_ACTOR),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('list() row-scopes a GUARDIAN actor to own submissions', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_adhoc_trip_requests')) {
        return [];
      }
      return [];
    });
    const { workflows } = makeWorkflows();
    const svc = new AdhocTripService(fake.tenantPrisma as never, workflows as never);
    await runWithTenantContext({ tenant: SCHOOL }, async () => {
      await svc.list(GUARDIAN_ACTOR, {});
    });
    const listCall = fake.capture.find((c) =>
      c.sql.toLowerCase().includes('from trn_adhoc_trip_requests'),
    );
    expect(listCall, 'list SQL captured').toBeTruthy();
    expect(listCall!.sql.includes('t.requested_by = $')).toBe(true);
  });
});

// ============================================================
// ContractedRouteService — UNIQUE catch + RESTRICT semantics
// ============================================================
describe('ContractedRouteService — UNIQUE(route_id) one-contract-per-route', () => {
  it('create() refuses STUDENT actors', async () => {
    const fake = makeFake(() => []);
    const svc = new ContractedRouteService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            routeId: ROUTE_ID,
            contractStartDate: '2026-09-01',
            contractEndDate: '2027-06-30',
          },
          STUDENT_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('create() refuses when contractEndDate < contractStartDate (app-layer pre-check)', async () => {
    const fake = makeFake(() => [{ ok: 1 }]);
    const svc = new ContractedRouteService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            routeId: ROUTE_ID,
            contractStartDate: '2027-09-01',
            contractEndDate: '2026-06-30',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() refuses when routeId does not match a route in this tenant', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_routes where id')) {
        return [];
      }
      return [];
    });
    const svc = new ContractedRouteService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            routeId: ROUTE_ID,
            contractStartDate: '2026-09-01',
            contractEndDate: '2027-06-30',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create() translates 23505 to "one contract per route" 400', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (sql.includes('from trn_routes where id')) return [{ ok: 1 }];
      if (sql.includes('insert into trn_contracted_routes')) {
        const err: any = new Error('Unique violation 23505');
        err.meta = { code: '23505' };
        throw err;
      }
      return [];
    });
    const svc = new ContractedRouteService(fake.tenantPrisma as never);
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.create(
          {
            routeId: ROUTE_ID,
            contractStartDate: '2026-09-01',
            contractEndDate: '2027-06-30',
          },
          ADMIN_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ============================================================
// Controller @RequirePermission metadata regression
// ============================================================
describe('RouteGenerationController — @RequirePermission metadata', () => {
  it('every write endpoint carries trn-001:write or trn-005:write metadata', () => {
    const proto = RouteGenerationController.prototype;
    // sample of write endpoints
    const writeMethods = [
      'createConstraint',
      'patchConstraint',
      'queueGenerationRequest',
      'cancelGenerationRequest',
      'addManualCandidate',
      'completeGenerationRequest',
      'approveCandidate',
      'rejectCandidate',
      'submitAdhocTrip',
      'approveAdhocTrip',
      'assignAdhocTrip',
      'completeAdhocTrip',
      'cancelAdhocTrip',
      'createContractedRoute',
      'patchContractedRoute',
    ];
    for (const m of writeMethods) {
      const meta = Reflect.getMetadata(PERMISSIONS_KEY, proto[m as keyof typeof proto] as never);
      expect(meta, m + ' has permission metadata').toBeTruthy();
      const codes = Array.isArray(meta) ? meta : [meta];
      const flat = codes.join(',');
      expect(flat).toMatch(/(trn-001:write|trn-005:write)/);
    }
  });

  it('every read endpoint carries trn-001:read or trn-005:read metadata', () => {
    const proto = RouteGenerationController.prototype;
    const readMethods = [
      'listConstraints',
      'getConstraint',
      'listGenerationRequests',
      'getGenerationRequest',
      'getCandidate',
      'listAdhocTrips',
      'getAdhocTrip',
      'listContractedRoutes',
      'getContractedRoute',
    ];
    for (const m of readMethods) {
      const meta = Reflect.getMetadata(PERMISSIONS_KEY, proto[m as keyof typeof proto] as never);
      expect(meta, m + ' has permission metadata').toBeTruthy();
      const codes = Array.isArray(meta) ? meta : [meta];
      const flat = codes.join(',');
      expect(flat).toMatch(/(trn-001:read|trn-005:read)/);
    }
  });
});

// ============================================================
// REVIEW-P2C11 ROUND 1 — school-scoping + outbox regression
// ============================================================
describe('REVIEW-P2C11 ROUND 1 — RouteGenerationService school-scoping + outbox', () => {
  it('BLOCKING 5 — cancelRequest lock + UPDATE both carry the school predicate', async () => {
    const fake = makeFake((c) => {
      const sql = c.sql.toLowerCase();
      if (
        sql.includes('select status from trn_generation_requests') &&
        sql.includes('for update')
      ) {
        return [{ status: 'RUNNING' }];
      }
      if (sql.includes('select r.id::text as id') && sql.includes('from trn_generation_requests')) {
        return [
          {
            id: REQUEST_ID,
            school_id: SCHOOL.schoolId,
            requested_by: ADMIN_ACTOR.accountId,
            request_type: 'FULL_YEAR',
            academic_year_id: null,
            term_id: null,
            date_from: null,
            date_to: null,
            constraint_id: CONSTRAINT_ID,
            constraint_name: 'X',
            directions: 'BOTH',
            status: 'CANCELLED',
            optimiser_run_id: null,
            routes_generated: null,
            students_covered: null,
            students_uncovered: null,
            error_message: null,
            queued_at: new Date(),
            started_at: null,
            completed_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          },
        ];
      }
      return [];
    });
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck() as never,
    );
    await runWithTenantContext({ tenant: SCHOOL }, async () =>
      svc.cancelRequest(REQUEST_ID, ADMIN_ACTOR),
    );
    const lock = fake.capture.find(
      (c) =>
        c.sql.toLowerCase().includes('select status from trn_generation_requests') &&
        c.sql.toLowerCase().includes('for update'),
    );
    expect(lock, 'cancelRequest lock').toBeTruthy();
    expect(lock!.sql.toLowerCase()).toContain('school_id = $1::uuid');
    expect(lock!.args[0]).toBe(SCHOOL.schoolId);

    const update = fake.capture.find((c) =>
      c.sql.toLowerCase().includes("update trn_generation_requests set status = 'cancelled'"),
    );
    expect(update, 'cancelRequest UPDATE').toBeTruthy();
    expect(update!.sql.toLowerCase()).toContain('school_id = $1::uuid');
  });

  it('BLOCKING 6 — RouteGenerationService refuses STAFF without trn-001:write', async () => {
    const fake = makeFake(() => []);
    const svc = new RouteGenerationService(
      fake.tenantPrisma as never,
      makeOutbox().outbox as never,
      makePermCheck({ allow: false }) as never,
    );
    await expect(
      runWithTenantContext({ tenant: SCHOOL }, async () =>
        svc.queueRequest(
          {
            requestType: 'FULL_YEAR',
            constraintId: CONSTRAINT_ID,
            academicYearId: '019e0f00-aaaa-7000-8000-ffffffffffff',
          },
          STAFF_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('BLOCKING 3 — deterministicGenerationCompletedEventId is stable + v5-shaped', async () => {
    const { deterministicGenerationCompletedEventId } = await import('./route-generation.service');
    const a = deterministicGenerationCompletedEventId('req-1');
    const b = deterministicGenerationCompletedEventId('req-1');
    const c = deterministicGenerationCompletedEventId('req-2');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.charAt(14)).toBe('5');
  });
});
