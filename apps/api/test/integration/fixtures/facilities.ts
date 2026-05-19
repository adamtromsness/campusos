import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 6 — m65-facilities fixtures.
 *
 * Buildings, spaces, inspection types, zones, supply inventory pre-seeded so
 * tests can layer on top.
 */
export const TEST_BUILDING_ID = '019e0cf8-aaaa-7777-8888-000000065001';
export const TEST_BUILDING_B_ID = '019e0cf8-aaaa-7777-8888-000000065002';
export const TEST_SPACE_ID = '019e0cf8-aaaa-7777-8888-000000065003';
export const TEST_SPACE_B_ID = '019e0cf8-aaaa-7777-8888-000000065004';
export const TEST_INSPECTION_TYPE_ID = '019e0cf8-aaaa-7777-8888-000000065005';
export const TEST_INSPECTION_TYPE_B_ID = '019e0cf8-aaaa-7777-8888-000000065006';
export const TEST_ZONE_ID = '019e0cf8-aaaa-7777-8888-000000065007';
export const TEST_SUPPLY_ID = '019e0cf8-aaaa-7777-8888-000000065008';
export const TEST_ASSET_CATEGORY_ID = '019e0cf8-aaaa-7777-8888-000000065009';

const FAC_TABLES = [
  'fac_supply_stocktake_items',
  'fac_supply_stocktakes',
  'fac_supply_transactions',
  'fac_supply_inventory',
  'fac_cleaning_route_stop_completions',
  'fac_cleaning_route_completions',
  'fac_cleaning_route_assignments',
  'fac_cleaning_route_stops',
  'fac_cleaning_routes',
  'fac_zone_inspections',
  'fac_zone_assignments',
  'fac_zones',
  'fac_inspection_violations',
  'fac_inspections',
  'fac_inspection_types',
  'fac_work_order_parts',
  'fac_work_order_attachments',
  'fac_work_order_activity',
  'fac_work_orders',
  'fac_maintenance_checklist_results',
  'fac_preventive_maintenance_tasks',
  'fac_preventive_maintenance_checklist_items',
  'fac_preventive_maintenance_plans',
  'fac_fire_drills',
  'fac_asset_disposals',
  'fac_asset_maintenance_records',
  'fac_assets',
  'fac_asset_categories',
  'fac_energy_targets',
  'fac_energy_readings',
  'fac_utility_meters',
  'fac_space_utilization_records',
  'fac_sustainability_initiatives',
  'fac_space_closures',
  'fac_space_bookings',
  'fac_spaces',
  'fac_buildings',
];

export async function resetFacilitiesTables(client: PrismaClient): Promise<void> {
  const list = FAC_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureFacilitiesSeed(client: PrismaClient): Promise<void> {
  // Buildings
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_buildings (id, school_id, name, code, year_built, total_floors, address, is_active)
     VALUES ($1::uuid, $2::uuid, 'Main Building', 'MAIN', 2000, 3, '100 Test St', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BUILDING_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_buildings (id, school_id, name, code, is_active)
     VALUES ($1::uuid, $2::uuid, 'B School Building', 'B-BLDG', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BUILDING_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Spaces
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_spaces (id, building_id, name, floor, space_type, area_sqft, is_active)
     VALUES ($1::uuid, $2::uuid, 'Room 101', '1', 'CLASSROOM', 800, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SPACE_ID,
    TEST_BUILDING_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_spaces (id, building_id, name, floor, space_type, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Room', '1', 'CLASSROOM', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SPACE_B_ID,
    TEST_BUILDING_B_ID,
  );

  // Inspection types
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_inspection_types (id, school_id, name, authority, frequency_months, is_mandatory)
     VALUES ($1::uuid, $2::uuid, 'Fire Marshal Inspection', 'Fire Marshal', 12, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_INSPECTION_TYPE_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_inspection_types (id, school_id, name, authority, frequency_months, is_mandatory)
     VALUES ($1::uuid, $2::uuid, 'B Fire Inspection', 'Fire Marshal', 12, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_INSPECTION_TYPE_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Zone
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_zones (id, school_id, name, description, color)
     VALUES ($1::uuid, $2::uuid, 'East Wing Zone', 'Custodial East Wing', '#ff0000')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ZONE_ID,
    TEST_SCHOOL_ID,
  );

  // Supply (note: no school_id; scoped via building)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_supply_inventory (id, building_id, item_name, unit, current_quantity, reorder_threshold, preferred_supplier)
     VALUES ($1::uuid, $2::uuid, 'Paper Towels', 'CASE', 25, 10, 'Cleaners Plus')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUPPLY_ID,
    TEST_BUILDING_ID,
  );

  // Asset category
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fac_asset_categories (id, school_id, name, depreciation_years, is_active)
     VALUES ($1::uuid, $2::uuid, 'HVAC', 15, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ASSET_CATEGORY_ID,
    TEST_SCHOOL_ID,
  );
}
