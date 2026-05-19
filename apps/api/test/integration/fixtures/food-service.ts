import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import { TEST_SIS_ACADEMIC_YEAR_ID } from './sis';
import { TEST_ADMIN_PERSON_ID } from '../helpers/actor';

/**
 * Wave 6 — m63-food-service fixtures.
 */
export const TEST_MENU_CYCLE_ID = '019e0cf8-aaaa-7777-8888-000000063001';
export const TEST_MENU_CYCLE_B_ID = '019e0cf8-aaaa-7777-8888-000000063002';
export const TEST_MENU_ITEM_ID = '019e0cf8-aaaa-7777-8888-000000063003';
export const TEST_MENU_ITEM_PEANUT_ID = '019e0cf8-aaaa-7777-8888-000000063004';
export const TEST_INVENTORY_GROUP_ID = '019e0cf8-aaaa-7777-8888-000000063005';
export const TEST_INVENTORY_ITEM_ID = '019e0cf8-aaaa-7777-8888-000000063006';
export const TEST_POS_DEVICE_ID = '019e0cf8-aaaa-7777-8888-000000063007';
export const TEST_POS_DEVICE_B_ID = '019e0cf8-aaaa-7777-8888-000000063008';

const FDS_TABLES = [
  'fds_preorder_production_reports',
  'fds_meal_preorder_items',
  'fds_meal_preorders',
  'fds_preorder_windows',
  'fds_staff_meal_accounts',
  'fds_usda_reimbursement_claims',
  'fds_eligibility_determinations',
  'fds_eligibility_applications',
  'fds_dietary_update_requests',
  'fds_student_allergen_alerts',
  'fds_student_dietary_profiles',
  'fds_temperature_logs',
  'fds_production_records',
  'fds_recipe_ingredients',
  'fds_recipes',
  'fds_inventory_transfer_requests',
  'fds_inventory_levels',
  'fds_inventory_transactions',
  'fds_inventory_items',
  'fds_inventory_groups',
  'fds_cash_drawer_reconciliation',
  'fds_meal_transactions',
  'fds_meal_service_sessions',
  'fds_pos_devices',
  'fds_daily_menu_items',
  'fds_daily_menus',
  'fds_menu_items',
  'fds_menu_cycles',
];

export async function resetFoodServiceTables(client: PrismaClient): Promise<void> {
  const list = FDS_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureFoodServiceSeed(client: PrismaClient): Promise<void> {
  // Menu cycle (created_by NOT NULL)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_menu_cycles (id, school_id, name, cycle_length_days, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Standard 4-week', 28, true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MENU_CYCLE_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_menu_cycles (id, school_id, name, cycle_length_days, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'B 4-week', 28, true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MENU_CYCLE_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ADMIN_PERSON_ID,
  );

  // Menu item — no allergens
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_menu_items (id, school_id, name, category, allergen_codes, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Apple Slices', 'SIDE', ARRAY[]::text[], true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MENU_ITEM_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_PERSON_ID,
  );
  // Menu item — peanut allergen for cross-check tests
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_menu_items (id, school_id, name, category, allergen_codes, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'PB&J', 'MAIN', ARRAY['peanut']::text[], true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MENU_ITEM_PEANUT_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_PERSON_ID,
  );

  // POS devices
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_pos_devices (id, school_id, device_name, device_type, is_active)
     VALUES ($1::uuid, $2::uuid, 'Kiosk 1', 'CASHIER_STAFFED', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_POS_DEVICE_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.fds_pos_devices (id, school_id, device_name, device_type, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Kiosk', 'CASHIER_STAFFED', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_POS_DEVICE_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Inventory group + item moved out — schema requires created_by we don't have
  // for these; tests can seed these themselves on demand.
  void TEST_INVENTORY_GROUP_ID;
  void TEST_INVENTORY_ITEM_ID;

  // suppress unused import warning if academic year referenced later
  void TEST_SIS_ACADEMIC_YEAR_ID;
}
