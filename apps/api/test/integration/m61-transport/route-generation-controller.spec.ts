import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { RouteGenerationController } from '@modules/m61-transport/route-generation.controller';
import { RouteConstraintService } from '@modules/m61-transport/route-constraint.service';
import { RouteGenerationService } from '@modules/m61-transport/route-generation.service';
import { AdhocTripService } from '@modules/m61-transport/adhoc-trip.service';
import { ContractedRouteService } from '@modules/m61-transport/contracted-route.service';
import {
  type ActorContextService,
  type ResolvedActor,
  PermissionCheckService,
} from '@modules/m00-platform';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import { withTestTenant } from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
} from '../fixtures/transport';
import { TEST_SIS_ACADEMIC_YEAR_ID } from '../fixtures/sis';

class StubActorContext {
  async resolveActor(): Promise<ResolvedActor> {
    return adminActor();
  }
}

class StubWorkflows {
  async submit(): Promise<never> {
    throw new Error('NO_TEMPLATE_CONFIGURED');
  }
}

describe('integration:m61-transport/route-generation-controller', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let ctl: RouteGenerationController;
  let req: any;
  let constraintId: string;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    const outbox = new OutboxService();

    const constraints = new RouteConstraintService(tenantPrisma);
    const generation = new RouteGenerationService(tenantPrisma, outbox, permCheck);
    const adhoc = new AdhocTripService(tenantPrisma, new StubWorkflows() as any);
    const contracted = new ContractedRouteService(tenantPrisma);

    ctl = new RouteGenerationController(
      constraints,
      generation,
      adhoc,
      contracted,
      new StubActorContext() as unknown as ActorContextService,
    );

    req = {
      user: {
        sub: TEST_ADMIN_ACCOUNT_ID,
        accountId: TEST_ADMIN_ACCOUNT_ID,
        personId: TEST_ADMIN_PERSON_ID,
        email: 'admin@test',
        displayName: 'Admin',
        sessionId: 'sess',
      },
    };
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);
  });

  it('route constraints — list + create + get + patch', async () => {
    const c = await withTestTenant(async () =>
      ctl.createConstraint(
        {
          constraintName: 'School-A profile',
          maxRideTimeMinutes: 40,
          maxStudentsPerVehicle: 50,
        } as any,
        req,
      ),
    );
    expect(c.constraintName).toBe('School-A profile');
    constraintId = c.id;

    const list = await withTestTenant(async () => ctl.listConstraints());
    expect(list.map((x: any) => x.id)).toContain(c.id);

    const fetched = await withTestTenant(async () => ctl.getConstraint(c.id));
    expect(fetched.id).toBe(c.id);

    const patched = await withTestTenant(async () =>
      ctl.patchConstraint(c.id, { isActive: false } as any, req),
    );
    expect(patched.isActive).toBe(false);
  });

  it('contracted routes — list + create + get + patch', async () => {
    const c = await withTestTenant(async () =>
      ctl.createContractedRoute(
        {
          routeId: TEST_ROUTE_ID,
          contractStartDate: '2026-01-01',
          contractEndDate: '2027-01-01',
          dailyRate: 200,
          paymentFrequency: 'MONTHLY',
        } as any,
        req,
      ),
    );
    expect(c.routeId).toBe(TEST_ROUTE_ID);

    const list = await withTestTenant(async () => ctl.listContractedRoutes());
    expect(list.map((x: any) => x.id)).toContain(c.id);

    const fetched = await withTestTenant(async () => ctl.getContractedRoute(c.id));
    expect(fetched.id).toBe(c.id);

    const patched = await withTestTenant(async () =>
      ctl.patchContractedRoute(c.id, { performanceRating: 4.5 } as any, req),
    );
    expect(Number(patched.performanceRating)).toBe(4.5);
  });

  it('adhoc trips — submit + list + get + approve + assign + complete', async () => {
    const t = await withTestTenant(async () =>
      ctl.submitAdhocTrip(
        {
          tripPurpose: 'FIELD_TRIP',
          tripDate: '2027-09-15',
          pickupLocation: 'School',
          destination: 'Museum',
          estimatedPassengers: 30,
        } as any,
        req,
      ),
    );
    expect(t.status).toBe('REQUESTED');

    const list = await withTestTenant(async () => ctl.listAdhocTrips(req));
    expect(list.map((x: any) => x.id)).toContain(t.id);

    const fetched = await withTestTenant(async () => ctl.getAdhocTrip(t.id, req));
    expect(fetched.id).toBe(t.id);

    const approved = await withTestTenant(async () =>
      ctl.approveAdhocTrip(t.id, { approvalNotes: 'OK' } as any, req),
    );
    expect(approved.status).toBe('APPROVED');

    const cancelled = await withTestTenant(async () =>
      ctl.cancelAdhocTrip(t.id, { cancellationReason: 'No longer needed' } as any, req),
    );
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('generation requests — list, get returns 404 for missing', async () => {
    const list = await withTestTenant(async () => ctl.listGenerationRequests());
    expect(Array.isArray(list)).toBe(true);
  });

  it('generation requests — queue + list + get + cancel', async () => {
    // Need a constraint first
    const c = await withTestTenant(async () =>
      ctl.createConstraint(
        { constraintName: 'For-Gen', maxRideTimeMinutes: 40 } as any,
        req,
      ),
    );

    const queued = await withTestTenant(async () =>
      ctl.queueGenerationRequest(
        {
          requestType: 'FULL_YEAR',
          constraintId: c.id,
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
        } as any,
        req,
      ),
    );
    expect(queued.status).toBe('QUEUED');

    const fetched = await withTestTenant(async () => ctl.getGenerationRequest(queued.id));
    expect(fetched.id).toBe(queued.id);

    const cancelled = await withTestTenant(async () =>
      ctl.cancelGenerationRequest(queued.id, req),
    );
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('generation requests — add manual candidate + complete', async () => {
    const c = await withTestTenant(async () =>
      ctl.createConstraint(
        { constraintName: 'Manual-Gen', maxRideTimeMinutes: 40 } as any,
        req,
      ),
    );
    const queued = await withTestTenant(async () =>
      ctl.queueGenerationRequest(
        {
          requestType: 'FULL_YEAR',
          constraintId: c.id,
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
        } as any,
        req,
      ),
    );

    const cand = await withTestTenant(async () =>
      ctl.addManualCandidate(
        queued.id,
        {
          candidateName: 'Route A AM',
          direction: 'AM',
          vehicleTypeRequired: 'BUS',
          estimatedRouteMileage: 12,
          estimatedDurationMinutes: 35,
          maxStudentRideTimeMinutes: 35,
          allConstraintsSatisfied: true,
          stops: [
            {
              stopName: 'Stop 1',
              latitude: 33.5,
              longitude: -84.5,
              sequenceOrder: 1,
              scheduledTime: '07:30:00',
              studentIds: [],
            },
            {
              stopName: 'Stop 2',
              latitude: 33.6,
              longitude: -84.6,
              sequenceOrder: 2,
              scheduledTime: '07:35:00',
              studentIds: [],
            },
          ],
        } as any,
        req,
      ),
    );
    expect(cand.candidateName).toBe('Route A AM');

    const cFetched = await withTestTenant(async () => ctl.getCandidate(cand.id));
    expect(cFetched.id).toBe(cand.id);

    // The request is now RUNNING — mark completed
    const completed = await withTestTenant(async () =>
      ctl.completeGenerationRequest(queued.id, req),
    );
    expect(completed.status).toBe('COMPLETED');
  });

  it('generation requests — approve + reject candidates', async () => {
    const c = await withTestTenant(async () =>
      ctl.createConstraint(
        { constraintName: 'Approve-Gen', maxRideTimeMinutes: 40 } as any,
        req,
      ),
    );
    const queued = await withTestTenant(async () =>
      ctl.queueGenerationRequest(
        {
          requestType: 'FULL_YEAR',
          constraintId: c.id,
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
        } as any,
        req,
      ),
    );

    const cand1 = await withTestTenant(async () =>
      ctl.addManualCandidate(
        queued.id,
        {
          candidateName: 'Approve-Route',
          direction: 'AM',
          vehicleTypeRequired: 'BUS',
          estimatedRouteMileage: 10,
          estimatedDurationMinutes: 30,
          maxStudentRideTimeMinutes: 30,
          allConstraintsSatisfied: true,
          stops: [
            {
              stopName: 'Approve Stop 1',
              latitude: 33.5,
              longitude: -84.5,
              sequenceOrder: 1,
              scheduledTime: '07:30:00',
              studentIds: [],
            },
          ],
        } as any,
        req,
      ),
    );

    const approved = await withTestTenant(async () =>
      ctl.approveCandidate(
        cand1.id,
        {
          routeName: 'Generated Route Alpha',
          reviewNotes: 'Looks good',
        } as any,
        req,
      ),
    );
    expect(approved.reviewStatus).toBe('APPROVED');

    // Now reject a second candidate
    const cand2 = await withTestTenant(async () =>
      ctl.addManualCandidate(
        queued.id,
        {
          candidateName: 'Reject-Route',
          direction: 'PM',
          vehicleTypeRequired: 'BUS',
          estimatedRouteMileage: 11,
          estimatedDurationMinutes: 32,
          maxStudentRideTimeMinutes: 32,
          allConstraintsSatisfied: true,
          stops: [
            {
              stopName: 'Reject Stop 1',
              latitude: 33.6,
              longitude: -84.6,
              sequenceOrder: 1,
              scheduledTime: '14:30:00',
              studentIds: [],
            },
          ],
        } as any,
        req,
      ),
    );
    const rejected = await withTestTenant(async () =>
      ctl.rejectCandidate(cand2.id, { reviewNotes: 'Not optimal' } as any, req),
    );
    expect(rejected.reviewStatus).toBe('REJECTED');
  });
});
