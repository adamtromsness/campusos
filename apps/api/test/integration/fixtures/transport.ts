import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_ACADEMIC_YEAR_B_ID } from './sis';

/**
 * Wave 6 — m61-transport fixtures.
 *
 * Routes, vehicles, stops, geofences pre-seeded for tests.
 */
export const TEST_VEHICLE_ID = '019e0cf8-aaaa-7777-8888-000000061001';
export const TEST_VEHICLE_B_ID = '019e0cf8-aaaa-7777-8888-000000061002';
export const TEST_ROUTE_ID = '019e0cf8-aaaa-7777-8888-000000061003';
export const TEST_ROUTE_B_ID = '019e0cf8-aaaa-7777-8888-000000061004';
export const TEST_STOP_ID = '019e0cf8-aaaa-7777-8888-000000061005';
export const TEST_GEOFENCE_ID = '019e0cf8-aaaa-7777-8888-000000061006';

const TRN_TABLES = [
  'trn_parent_tracking_tokens',
  'trn_vehicle_eta',
  'trn_no_show_alerts',
  'trn_delay_reports',
  'trn_dispatch_events',
  'trn_ridership_records',
  'trn_bus_passes',
  'trn_route_run_logs',
  'trn_route_change_log',
  'trn_route_change_requests',
  'trn_student_assignments',
  'trn_driver_hours_logs',
  'trn_driver_hours_limits',
  'trn_driver_credentials',
  'trn_pre_trip_inspection_items',
  'trn_pre_trip_inspections',
  'trn_vehicle_fuel_logs',
  'trn_vehicle_components',
  'trn_vehicle_repairs',
  'trn_repair_categories',
  'trn_parts_inventory',
  'trn_vehicle_lifecycle',
  'trn_vehicle_documents',
  'trn_maintenance_schedules',
  // trn_vehicle_positions + trn_geofence_events are partitioned; TRUNCATE
  // works on the parent table including all child partitions.
  'trn_geofence_events',
  'trn_vehicle_positions',
  'trn_geofences',
  'trn_stops',
  'trn_routes',
  'trn_vehicles',
];

export async function resetTransportTables(client: PrismaClient): Promise<void> {
  const list = TRN_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureTransportSeed(client: PrismaClient): Promise<void> {
  // School A vehicle
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_vehicles (id, school_id, registration, make, model, year, capacity, vehicle_type, status)
     VALUES ($1::uuid, $2::uuid, 'BUS-A1', 'Blue Bird', 'All American', 2022, 50, 'BUS', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_VEHICLE_ID,
    TEST_SCHOOL_ID,
  );
  // School B vehicle
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_vehicles (id, school_id, registration, make, model, year, capacity, vehicle_type, status)
     VALUES ($1::uuid, $2::uuid, 'BUS-B1', 'Blue Bird', 'All American', 2022, 50, 'BUS', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_VEHICLE_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // School A route
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_routes (id, school_id, name, direction, vehicle_id, academic_year_id, status)
     VALUES ($1::uuid, $2::uuid, 'Route 1', 'AM', $3::uuid, $4::uuid, 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ROUTE_ID,
    TEST_SCHOOL_ID,
    TEST_VEHICLE_ID,
    TEST_SIS_ACADEMIC_YEAR_ID,
  );
  // School B route
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_routes (id, school_id, name, direction, vehicle_id, academic_year_id, status)
     VALUES ($1::uuid, $2::uuid, 'Route 1 B', 'AM', $3::uuid, $4::uuid, 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ROUTE_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_VEHICLE_B_ID,
    TEST_SIS_ACADEMIC_YEAR_B_ID,
  );

  // Route stop
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_stops (id, route_id, name, address, latitude, longitude, sequence_order, scheduled_time)
     VALUES ($1::uuid, $2::uuid, 'Main St & Elm', '100 Main St', 33.5, -84.5, 1, '07:30:00')
     ON CONFLICT (id) DO NOTHING`,
    TEST_STOP_ID,
    TEST_ROUTE_ID,
  );

  // Geofence
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.trn_geofences (id, school_id, name, geofence_type, boundary, is_active)
     VALUES ($1::uuid, $2::uuid, 'School Zone', 'SCHOOL', '{"type":"circle","centerLat":33.5,"centerLng":-84.5,"radiusMeters":200}'::jsonb, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_GEOFENCE_ID,
    TEST_SCHOOL_ID,
  );
}
