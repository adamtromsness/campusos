import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 8 — m60-tickets fixtures.
 *
 * Seeds canonical categories, subcategories, SLA policies, vendors
 * per school. Wipes every tkt_* table per test.
 */
export const TEST_TKT_CAT_IT_A_ID = '019e0cf8-aaaa-7777-8888-000000060001';
export const TEST_TKT_CAT_FAC_A_ID = '019e0cf8-aaaa-7777-8888-000000060002';
export const TEST_TKT_CAT_IT_B_ID = '019e0cf8-aaaa-7777-8888-000000060003';
export const TEST_TKT_SUBCAT_A_ID = '019e0cf8-aaaa-7777-8888-000000060011';
export const TEST_TKT_SLA_A_ID = '019e0cf8-aaaa-7777-8888-000000060021';
export const TEST_TKT_VENDOR_A_ID = '019e0cf8-aaaa-7777-8888-000000060031';

// Tables wiped per test.
const TICKET_TABLES = [
  'tkt_problem_tickets',
  'tkt_problems',
  'tkt_ticket_activity',
  'tkt_ticket_tags',
  'tkt_ticket_attachments',
  'tkt_ticket_comments',
  'tkt_tickets',
  'tkt_vendors',
  'tkt_sla_policies',
  'tkt_subcategories',
  'tkt_categories',
];

export async function resetTicketsTables(client: PrismaClient): Promise<void> {
  const list = TICKET_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureTicketsSeed(client: PrismaClient): Promise<void> {
  // Categories per school
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_categories (id, school_id, name, icon, is_active)
     VALUES ($1::uuid, $2::uuid, 'IT', 'computer', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_CAT_IT_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_categories (id, school_id, name, icon, is_active)
     VALUES ($1::uuid, $2::uuid, 'Facilities', 'building', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_CAT_FAC_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_categories (id, school_id, name, icon, is_active)
     VALUES ($1::uuid, $2::uuid, 'B IT', 'computer', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_CAT_IT_B_ID,
    TEST_SCHOOL_B_ID,
  );
  // Subcategory
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_subcategories
       (id, category_id, name, auto_assign_to_role, is_active)
     VALUES ($1::uuid, $2::uuid, 'Laptop', NULL, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_SUBCAT_A_ID,
    TEST_TKT_CAT_IT_A_ID,
  );
  // SLA policy MEDIUM
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_sla_policies
       (id, school_id, category_id, priority, response_hours, resolution_hours)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEDIUM', 4, 24)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_SLA_A_ID,
    TEST_SCHOOL_ID,
    TEST_TKT_CAT_IT_A_ID,
  );
  // Vendor
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tkt_vendors
       (id, school_id, vendor_name, vendor_type, contact_name, is_preferred, is_active)
     VALUES ($1::uuid, $2::uuid, 'AcmeIT', 'IT_REPAIR', 'Joe Vendor', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TKT_VENDOR_A_ID,
    TEST_SCHOOL_ID,
  );
}

export async function resetAndSeedTickets(client: PrismaClient): Promise<void> {
  await resetTicketsTables(client);
  await ensureTicketsSeed(client);
}
