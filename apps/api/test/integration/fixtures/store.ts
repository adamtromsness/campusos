import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 6 — m67-store fixtures.
 *
 * Each test resets the store schema and calls ensureStoreSeed (or builds its
 * own setup). The IDs here are deterministic so cross-school isolation tests
 * can predict School B seeds.
 */
export const TEST_STORE_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000067001';
export const TEST_STORE_PUBLIC_ID = '019e0cf8-aaaa-7777-8888-000000067002';
export const TEST_STORE_B_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000067003';
export const TEST_PRODUCT_A_ID = '019e0cf8-aaaa-7777-8888-000000067010';
export const TEST_PRODUCT_B_ID = '019e0cf8-aaaa-7777-8888-000000067011';
export const TEST_PRODUCT_BACKORDER_ID = '019e0cf8-aaaa-7777-8888-000000067012';
export const TEST_INVENTORY_A_ID = '019e0cf8-aaaa-7777-8888-000000067020';
export const TEST_INVENTORY_B_ID = '019e0cf8-aaaa-7777-8888-000000067021';
export const TEST_INVENTORY_BACKORDER_ID = '019e0cf8-aaaa-7777-8888-000000067022';
export const TEST_SHIPPING_OPTION_ID = '019e0cf8-aaaa-7777-8888-000000067030';
export const TEST_EXTERNAL_CUSTOMER_ID = '019e0cf8-aaaa-7777-8888-000000067040';
export const TEST_EXTERNAL_CUSTOMER_B_ID = '019e0cf8-aaaa-7777-8888-000000067041';

const STORE_TABLES = [
  'str_inventory_adjustments',
  'str_promotion_products',
  'str_promotions',
  'str_loyalty_transactions',
  'str_loyalty_config',
  'str_gift_card_transactions',
  'str_gift_cards',
  'str_wishlists',
  'str_price_schedules',
  'str_order_approvals',
  'str_order_lines',
  'str_orders',
  'str_store_revenue',
  'str_shipping_options',
  'str_external_customers',
  'str_product_inventory',
  'str_category_hierarchy',
  'str_products',
  'str_stores',
];

/** Wipe every str_* table in the integration test schema. */
export async function resetStoreTables(client: PrismaClient): Promise<void> {
  const list = STORE_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Seed canonical stores + products + inventory for both schools.
 * Tests can layer on top; resetStoreTables() reverts to empty.
 */
export async function ensureStoreSeed(client: PrismaClient): Promise<void> {
  // School A — STUDENT store
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_stores (id, school_id, store_type, name, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'STUDENT', 'Demo Student Store', 'Test student store', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_STORE_STUDENT_ID,
    TEST_SCHOOL_ID,
  );
  // School A — PUBLIC store
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_stores (id, school_id, store_type, name, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'PUBLIC', 'Demo Public Store', 'Test public store', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_STORE_PUBLIC_ID,
    TEST_SCHOOL_ID,
  );
  // School B — STUDENT store
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_stores (id, school_id, store_type, name, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'STUDENT', 'School B Student Store', NULL, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_STORE_B_STUDENT_ID,
    TEST_SCHOOL_B_ID,
  );

  // Products
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, sku, category, price, cost, is_active, backorder_allowed)
     VALUES ($1::uuid, $2::uuid, 'Test T-Shirt', 'SKU-A', 'Apparel', 15.00, 8.00, true, false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PRODUCT_A_ID,
    TEST_STORE_STUDENT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, sku, category, price, cost, is_active, backorder_allowed)
     VALUES ($1::uuid, $2::uuid, 'Test Hoodie', 'SKU-B', 'Apparel', 25.00, 12.00, true, false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PRODUCT_B_ID,
    TEST_STORE_STUDENT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_products (id, store_id, name, sku, category, price, cost, is_active, backorder_allowed)
     VALUES ($1::uuid, $2::uuid, 'Test Cap (backorder)', 'SKU-BO', 'Apparel', 10.00, 4.00, true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PRODUCT_BACKORDER_ID,
    TEST_STORE_STUDENT_ID,
  );

  // Inventory
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity)
     VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 100, 0, 10, 50)
     ON CONFLICT (id) DO NOTHING`,
    TEST_INVENTORY_A_ID,
    TEST_PRODUCT_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity)
     VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 50, 0, 5, 25)
     ON CONFLICT (id) DO NOTHING`,
    TEST_INVENTORY_B_ID,
    TEST_PRODUCT_B_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, quantity_reserved, reorder_point, reorder_quantity)
     VALUES ($1::uuid, $2::uuid, 'DISTRICT', $3::uuid, 0, 0, 5, 10)
     ON CONFLICT (id) DO NOTHING`,
    TEST_INVENTORY_BACKORDER_ID,
    TEST_PRODUCT_BACKORDER_ID,
    TEST_SCHOOL_ID,
  );

  // Shipping option for the public store
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_shipping_options (id, store_id, method_name, estimated_days, flat_rate, is_active)
     VALUES ($1::uuid, $2::uuid, 'Standard ground', 5, 5.00, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SHIPPING_OPTION_ID,
    TEST_STORE_PUBLIC_ID,
  );

  // External customer for EXTERNAL orders
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_external_customers (id, school_id, name, email, shipping_address)
     VALUES ($1::uuid, $2::uuid, 'Jane Doe', 'jane@example.com', '123 Main St')
     ON CONFLICT (id) DO NOTHING`,
    TEST_EXTERNAL_CUSTOMER_ID,
    TEST_SCHOOL_ID,
  );
  // School B external customer used for cross-school checks
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.str_external_customers (id, school_id, name, email, shipping_address)
     VALUES ($1::uuid, $2::uuid, 'B Customer', 'b@example.com', '999 B Street')
     ON CONFLICT (id) DO NOTHING`,
    TEST_EXTERNAL_CUSTOMER_B_ID,
    TEST_SCHOOL_B_ID,
  );
}
