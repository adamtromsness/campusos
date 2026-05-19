import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import { TEST_ADMIN_PERSON_ID } from '../helpers/actor';

/**
 * Wave 6 — m62-it fixtures.
 */
export const TEST_ASSET_CATEGORY_ID = '019e0cf8-aaaa-7777-8888-000000062001';
export const TEST_ASSET_CATEGORY_B_ID = '019e0cf8-aaaa-7777-8888-000000062002';
export const TEST_ASSET_ID = '019e0cf8-aaaa-7777-8888-000000062003';
export const TEST_ASSET_B_ID = '019e0cf8-aaaa-7777-8888-000000062004';
export const TEST_LICENCE_ID = '019e0cf8-aaaa-7777-8888-000000062005';

const TECH_TABLES = [
  'tech_inventory_audit_items',
  'tech_inventory_audits',
  'tech_licence_renewals',
  'tech_device_usage_summaries',
  'tech_remote_actions',
  'tech_monitoring_alerts',
  'tech_monitoring_checks',
  'tech_config_documentation',
  'tech_phone_extensions',
  'tech_device_selections',
  'tech_device_options',
  'tech_procurement_orders',
  'tech_infrastructure_items',
  'tech_mdm_alerts',
  'tech_mdm_sync_logs',
  'tech_repair_records',
  'tech_damage_reports',
  'tech_credential_access_log',
  'tech_credential_vault',
  'tech_software_assignments',
  'tech_software_licences',
  'tech_asset_documents',
  'tech_asset_assignments',
  'tech_assets',
  'tech_asset_categories',
];

export async function resetItTables(client: PrismaClient): Promise<void> {
  const list = TECH_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureItSeed(client: PrismaClient): Promise<void> {
  // Asset categories
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tech_asset_categories (id, school_id, name, depreciation_years, maintenance_interval_months, is_active)
     VALUES ($1::uuid, $2::uuid, 'Laptop', 4, 12, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ASSET_CATEGORY_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tech_asset_categories (id, school_id, name, depreciation_years, maintenance_interval_months, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Laptop', 4, 12, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ASSET_CATEGORY_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Assets
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tech_assets (id, school_id, category_id, asset_tag, serial_number, make, model, purchase_date, purchase_cost, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'AT-A-001', 'SN-A-001', 'Dell', 'Latitude 5520', '2024-01-15', 1000, 'AVAILABLE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ASSET_ID,
    TEST_SCHOOL_ID,
    TEST_ASSET_CATEGORY_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tech_assets (id, school_id, category_id, asset_tag, serial_number, make, model, purchase_date, purchase_cost, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'AT-B-001', 'SN-B-001', 'Dell', 'Latitude 5520', '2024-01-15', 1000, 'AVAILABLE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ASSET_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ASSET_CATEGORY_B_ID,
  );

  // Software licence (created_by NOT NULL)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tech_software_licences (id, school_id, software_name, vendor, licence_type, total_seats, used_seats, expiry_date, annual_cost, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, 'Office 365', 'Microsoft', 'PER_SEAT', 100, 0, '2027-12-31', 12000, true, $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LICENCE_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_PERSON_ID,
  );
}
