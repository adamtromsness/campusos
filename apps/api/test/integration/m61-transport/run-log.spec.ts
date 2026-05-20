import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { RunLogService } from '@modules/m61-transport/run-log.service';
import { InspectionService } from '@modules/m61-transport/inspection.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  TEST_SCHEMA,
} from '../helpers/tenant-context';
import {
  adminActor,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';
import {
  resetTransportTables,
  ensureTransportSeed,
  TEST_ROUTE_ID,
  TEST_VEHICLE_ID,
} from '../fixtures/transport';

describe('integration:m61-transport/run-log', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let runLogs: RunLogService;
  let inspections: InspectionService;
  const RUN_DATE = '2026-06-15';

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    inspections = new InspectionService(tenantPrisma);
    runLogs = new RunLogService(tenantPrisma, inspections);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetTransportTables(rawClient);
    await ensureTransportSeed(rawClient);

    // Set driver_id on the seeded route + assign valid CDL/MEDICAL
    await rawClient.$executeRawUnsafe(
      `UPDATE ${TEST_SCHEMA}.trn_routes SET driver_id = $1::uuid WHERE id = $2::uuid`,
      TEST_ADMIN_EMPLOYEE_ID,
      TEST_ROUTE_ID,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.trn_driver_credentials
         (id, driver_id, credential_type, credential_number, issued_date, expiry_date, status)
       VALUES
         (gen_random_uuid(), $1::uuid, 'CDL', 'CDL-RUN', '2024-01-01', '2028-01-01', 'VALID'),
         (gen_random_uuid(), $1::uuid, 'MEDICAL_CERTIFICATE', 'MED-RUN', '2024-01-01', '2028-01-01', 'VALID')
       ON CONFLICT DO NOTHING`,
      TEST_ADMIN_EMPLOYEE_ID,
    );
    // Pre-trip inspection PASS for today
    await withTestTenant(async () =>
      inspections.create(
        TEST_VEHICLE_ID,
        {
          inspectionDate: RUN_DATE,
          items: [{ itemName: 'Brakes', status: 'PASS' }],
        } as any,
        adminActor(),
      ),
    );
  });

  it('start + complete a run', async () => {
    const run = await withTestTenant(async () =>
      runLogs.start(
        {
          routeId: TEST_ROUTE_ID,
          runDate: RUN_DATE,
          odometerStart: 100000,
        } as any,
        adminActor(),
      ),
    );
    expect(run.status).toBe('IN_PROGRESS');
    expect(run.routeId).toBe(TEST_ROUTE_ID);

    const fetched = await withTestTenant(async () => runLogs.getById(run.id));
    expect(fetched.id).toBe(run.id);

    const completed = await withTestTenant(async () =>
      runLogs.complete(
        run.id,
        { odometerEnd: 100050, notes: 'Smooth run' } as any,
        adminActor(),
      ),
    );
    expect(completed.status).toBe('COMPLETED');
  });

  it('starting a second IN_PROGRESS run for same date rejects', async () => {
    await withTestTenant(async () =>
      runLogs.start(
        { routeId: TEST_ROUTE_ID, runDate: RUN_DATE } as any,
        adminActor(),
      ),
    );

    await expect(
      withTestTenant(async () =>
        runLogs.start({ routeId: TEST_ROUTE_ID, runDate: RUN_DATE } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('start refuses when pre-trip inspection is missing', async () => {
    const OTHER_DATE = '2026-06-20';
    await expect(
      withTestTenant(async () =>
        runLogs.start({ routeId: TEST_ROUTE_ID, runDate: OTHER_DATE } as any, adminActor()),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
