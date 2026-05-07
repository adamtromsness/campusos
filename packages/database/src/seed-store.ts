import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-store.ts — Cycle 28 Step 4.
 *
 * M67 School Store. Idempotent — gated on whether str_stores already
 * has at least one STUDENT store for the demo school.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 2 stores: "Lincoln Academy Shop" STUDENT + "Eagle Merchandise"
 *     PUBLIC.
 *   - 6 products: 4 in STUDENT store (School Polo $25, PE Kit $35,
 *     Yearbook $20, Calculator $15) + 2 in PUBLIC store (Eagle Hoodie
 *     $45, Alumni Mug $12). PE Kit has reorder_point=5 to drive the
 *     reorder-signal scenario.
 *   - 6 inventory rows pinned to a synthetic BUILDING location.
 *   - 1 student order from Maya: 1 Polo + 1 Yearbook = $45, status
 *     COMPLETED, payment CHARGED. Approved by David Chen.
 *   - 1 external order from Jane Smith: 2 Hoodies + Standard Shipping
 *     = $95, SHIPPED with tracking number, payment CHARGED.
 *   - 1 approval (David approved Maya's order).
 *   - 1 external customer (Jane Smith).
 *   - 2 shipping options: Standard ($5, 5d) + Express ($12, 2d).
 *   - 1 revenue snapshot for the STUDENT store covering April 2026
 *     (1 order $45, $20 cost from polo $12 + yearbook $8, $25 margin).
 */

const TENANT_SCHEMA = 'tenant_demo';

const SCHOOL_BUILDING_ID = '019dd000-0000-7bb7-aa7f-000000000001';

async function main() {
  const client = getPlatformClient();

  const routingRows = (await client.$queryRawUnsafe(
    'SELECT schema_name FROM platform.platform_tenant_routing WHERE schema_name = $1 LIMIT 1',
    TENANT_SCHEMA,
  )) as Array<{ schema_name: string }>;
  if (routingRows.length === 0) {
    console.error(`Tenant ${TENANT_SCHEMA} not provisioned — run pnpm seed first`);
    process.exit(1);
  }

  const schoolRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string }>;
  const schoolId = schoolRows[0]!.id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.str_stores WHERE school_id = $1::uuid AND store_type = 'STUDENT' LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('Store seed already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve Maya + David + a building (any) so we can wire orders + customers
  const mayaPersonRows = (await client.$queryRawUnsafe(
    `SELECT ip.id::text AS id FROM platform.iam_person ip WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen' LIMIT 1`,
  )) as Array<{ id: string }>;
  const davidPersonRows = (await client.$queryRawUnsafe(
    `SELECT ip.id::text AS id FROM platform.iam_person ip WHERE ip.first_name = 'David' AND ip.last_name = 'Chen' LIMIT 1`,
  )) as Array<{ id: string }>;
  const mayaStudentRows = (await client.$queryRawUnsafe(
    `SELECT s.id::text AS id FROM ${TENANT_SCHEMA}.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person ip ON ip.id = ps.person_id WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen' LIMIT 1`,
  )) as Array<{ id: string }>;

  if (mayaPersonRows.length === 0 || davidPersonRows.length === 0 || mayaStudentRows.length === 0) {
    console.error('Maya / David / Maya-student missing — run prior seeds first');
    process.exit(1);
  }
  const mayaPersonId = mayaPersonRows[0]!.id;
  const davidPersonId = davidPersonRows[0]!.id;
  const mayaStudentId = mayaStudentRows[0]!.id;

  // ── Stores ──
  const studentStoreId = generateId();
  const publicStoreId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_stores (id, school_id, store_type, name, description) VALUES ($1::uuid, $2::uuid, 'STUDENT', 'Lincoln Academy Shop', 'School supplies, uniforms, and yearbook for Lincoln Academy students.')`,
    studentStoreId,
    schoolId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_stores (id, school_id, store_type, name, description) VALUES ($1::uuid, $2::uuid, 'PUBLIC', 'Eagle Merchandise', 'Lincoln Academy alumni and community shop.')`,
    publicStoreId,
    schoolId,
  );

  // ── Products ──
  const poloId = generateId();
  const peKitId = generateId();
  const yearbookId = generateId();
  const calculatorId = generateId();
  const hoodieId = generateId();
  const mugId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost) VALUES ($1::uuid, $2::uuid, 'School Polo', 'Navy blue uniform polo, embroidered Lincoln Academy crest.', 'POLO-BLU-M', 'Uniform', 25.00, 12.00)`,
    poloId,
    studentStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost) VALUES ($1::uuid, $2::uuid, 'PE Kit', 'Athletic shorts + Lincoln Academy tee bundle.', 'PE-KIT-S', 'Sportswear', 35.00, 18.00)`,
    peKitId,
    studentStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost) VALUES ($1::uuid, $2::uuid, 'Yearbook 2026', 'Hardcover, 240 pages, includes class photos and senior memories.', 'YRB-2026', 'Publications', 20.00, 8.00)`,
    yearbookId,
    studentStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost, backorder_allowed) VALUES ($1::uuid, $2::uuid, 'Scientific Calculator', 'TI-30XS Multiview, required for Algebra and above.', 'CALC-SCI', 'Supplies', 15.00, 7.50, true)`,
    calculatorId,
    studentStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost) VALUES ($1::uuid, $2::uuid, 'Eagle Hoodie', 'Heather grey hoodie with Eagle mascot, sizes S-XL.', 'HDY-GRY-L', 'Merchandise', 45.00, 22.00)`,
    hoodieId,
    publicStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_products (id, store_id, name, description, sku, category, price, cost) VALUES ($1::uuid, $2::uuid, 'Alumni Mug', '11oz ceramic mug with Lincoln Academy seal.', 'MUG-ALM', 'Merchandise', 12.00, 4.00)`,
    mugId,
    publicStoreId,
  );

  // ── Inventory ──
  const inv = [
    [poloId, 50, 5],
    [peKitId, 30, 5], // reorder_point=5 — drives the reorder-signal scenario
    [yearbookId, 100, 10],
    [calculatorId, 25, 5],
    [hoodieId, 25, 5],
    [mugId, 40, 10],
  ] as const;
  for (const [productId, qty, reorderPoint] of inv) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.str_product_inventory (id, product_id, location_type, location_id, quantity_on_hand, reorder_point, reorder_quantity) VALUES ($1::uuid, $2::uuid, 'BUILDING', $3::uuid, $4, $5, 25)`,
      generateId(),
      productId,
      SCHOOL_BUILDING_ID,
      qty,
      reorderPoint,
    );
  }

  // ── External customer ──
  const janeId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_external_customers (id, school_id, name, email, phone, shipping_address) VALUES ($1::uuid, $2::uuid, 'Jane Smith', 'jane.smith@example.com', '+1-217-555-0202', '500 Elm Street, Springfield, IL 62701')`,
    janeId,
    schoolId,
  );

  // ── Shipping options ──
  const standardShipId = generateId();
  const expressShipId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_shipping_options (id, store_id, method_name, estimated_days, flat_rate) VALUES ($1::uuid, $2::uuid, 'Standard Shipping', 5, 5.00)`,
    standardShipId,
    publicStoreId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_shipping_options (id, store_id, method_name, estimated_days, flat_rate) VALUES ($1::uuid, $2::uuid, 'Express Shipping', 2, 12.00)`,
    expressShipId,
    publicStoreId,
  );

  // ── Maya's STUDENT order (COMPLETED) ──
  const mayaOrderId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_orders (id, store_id, order_type, customer_person_id, student_id, order_number, order_date, status, subtotal, total, payment_status) VALUES ($1::uuid, $2::uuid, 'STUDENT', $3::uuid, $4::uuid, 'STR-2026-0001', '2026-04-15', 'COMPLETED', 45.00, 45.00, 'CHARGED')`,
    mayaOrderId,
    studentStoreId,
    mayaPersonId,
    mayaStudentId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_order_lines (id, order_id, product_id, quantity, unit_price, line_total, line_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 25.00, 25.00, 'FULFILLED')`,
    generateId(),
    mayaOrderId,
    poloId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_order_lines (id, order_id, product_id, quantity, unit_price, line_total, line_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 20.00, 20.00, 'FULFILLED')`,
    generateId(),
    mayaOrderId,
    yearbookId,
  );
  // Approval: David approved Maya's order on 2026-04-15
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_order_approvals (id, order_id, parent_person_id, status, requested_at, responded_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'APPROVED', '2026-04-15 09:00:00+00', '2026-04-15 18:30:00+00')`,
    generateId(),
    mayaOrderId,
    davidPersonId,
  );
  // Decrement inventory to reflect Maya's completed order
  await client.$executeRawUnsafe(
    `UPDATE ${TENANT_SCHEMA}.str_product_inventory SET quantity_on_hand = quantity_on_hand - 1 WHERE product_id = $1::uuid`,
    poloId,
  );
  await client.$executeRawUnsafe(
    `UPDATE ${TENANT_SCHEMA}.str_product_inventory SET quantity_on_hand = quantity_on_hand - 1 WHERE product_id = $1::uuid`,
    yearbookId,
  );

  // ── Jane Smith's EXTERNAL order (SHIPPED) ──
  const janeOrderId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_orders (id, store_id, order_type, external_customer_id, order_number, order_date, status, subtotal, shipping_cost, total, shipping_method, shipping_option_id, tracking_number, payment_status) VALUES ($1::uuid, $2::uuid, 'EXTERNAL', $3::uuid, 'EAGLE-2026-0001', '2026-04-20', 'SHIPPED', 90.00, 5.00, 95.00, 'SHIPPED', $4::uuid, 'USPS9405511899223456789012', 'CHARGED')`,
    janeOrderId,
    publicStoreId,
    janeId,
    standardShipId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_order_lines (id, order_id, product_id, quantity, unit_price, line_total, line_status) VALUES ($1::uuid, $2::uuid, $3::uuid, 2, 45.00, 90.00, 'FULFILLED')`,
    generateId(),
    janeOrderId,
    hoodieId,
  );
  await client.$executeRawUnsafe(
    `UPDATE ${TENANT_SCHEMA}.str_product_inventory SET quantity_on_hand = quantity_on_hand - 2 WHERE product_id = $1::uuid`,
    hoodieId,
  );

  // ── Revenue snapshot: STUDENT store, April 2026 ──
  // Maya's order: revenue $45, cost = 12 + 8 = $20, margin $25.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.str_store_revenue (id, store_id, period_start, period_end, total_orders, total_revenue, total_cost, gross_margin) VALUES ($1::uuid, $2::uuid, '2026-04-01', '2026-04-30', 1, 45.00, 20.00, 25.00)`,
    generateId(),
    studentStoreId,
  );

  console.log('Store seed complete:');
  console.log('  - 2 stores: "Lincoln Academy Shop" (STUDENT) + "Eagle Merchandise" (PUBLIC)');
  console.log(
    '  - 6 products: Polo, PE Kit, Yearbook, Calculator (STUDENT) + Hoodie, Mug (PUBLIC)',
  );
  console.log(
    '  - 6 inventory rows: Polo 49 / PE Kit 30 / Yearbook 99 / Calculator 25 / Hoodie 23 / Mug 40',
  );
  console.log("  - 2 orders: Maya's STUDENT order COMPLETED + Jane's EXTERNAL order SHIPPED");
  console.log("  - 1 approval: David approved Maya's order");
  console.log('  - 1 external customer + 2 shipping options');
  console.log('  - 1 revenue snapshot: STUDENT store April 2026 (1 order $45, $25 margin)');

  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
