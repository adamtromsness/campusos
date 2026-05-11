import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-food-service-advanced.ts — Phase 2 Cycle 10 sub-cycle a (P2-10a).
 *
 * Idempotent. Gated on whether the demo school already has any
 * fds_recipes rows.
 *
 * Sections:
 *   A) 2 inventory groups (Main Kitchen LUNCH + Breakfast Programme
 *      BREAKFAST), Main Kitchen managed by principal Mitchell.
 *   B) 10 inventory items across PROTEIN / DAIRY / GRAIN / VEGETABLE /
 *      FRUIT / CONDIMENT / BEVERAGE categories. Realistic allergen_codes
 *      on the dairy and grain items.
 *   C) 10 inventory levels (one per item in Main Kitchen, with one
 *      item AT the reorder threshold so the Step 6 InventoryService
 *      low-stock emit hot path has a row to demonstrate).
 *   D) 15 inventory transactions covering 6 RECEIPT rows, 5 USAGE
 *      rows, 2 WASTE rows, 1 paired TRANSFER_OUT + TRANSFER_IN with
 *      a shared transfer_reference_id. Spread across last 30 days
 *      so the partition routing exercises 2026-04 + 2026-05.
 *   E) 1 transfer request — COMPLETED, with transfer_reference_id
 *      pointing at the paired transactions from section D.
 *   F) 3 recipes — Chicken Tenders ENTREE with 5 ingredients (auto
 *      allergens WHEAT + MILK, computed cost), Veggie Wrap ENTREE
 *      with 4 ingredients (WHEAT), Fruit Salad SIDE with 3 ingredients
 *      (no allergens). Ingredients linked to inventory_item_id when
 *      available.
 *   G) 2 staff meal accounts — Mitchell PAYROLL, Rivera COMPLIMENTARY.
 */

const TENANT_SCHEMA = 'tenant_demo';

interface RecipeSpec {
  name: string;
  category:
    | 'ENTREE'
    | 'SIDE'
    | 'VEGETABLE'
    | 'FRUIT'
    | 'GRAIN'
    | 'DAIRY'
    | 'BEVERAGE'
    | 'SNACK'
    | 'DESSERT';
  servingYield: number;
  prepMin: number;
  cookMin: number;
  instructions: string;
  ingredients: Array<{
    name: string;
    quantity: number;
    unit: string;
    allergens: string[];
    unitCost: number;
    inventoryItemKey?: string;
  }>;
}

const RECIPES: RecipeSpec[] = [
  {
    name: 'Chicken Tenders',
    category: 'ENTREE',
    servingYield: 100,
    prepMin: 20,
    cookMin: 18,
    instructions:
      'Bread chicken strips in seasoned flour and panko. Bake at 200C for 18 minutes until internal temp reaches 74C. Hold at 63C until service.',
    ingredients: [
      {
        name: 'Chicken breast',
        quantity: 25.0,
        unit: 'lb',
        allergens: [],
        unitCost: 3.5,
        inventoryItemKey: 'chicken_breast',
      },
      {
        name: 'Panko breadcrumbs',
        quantity: 3.0,
        unit: 'lb',
        allergens: ['WHEAT'],
        unitCost: 2.1,
        inventoryItemKey: 'panko',
      },
      {
        name: 'Buttermilk',
        quantity: 2.0,
        unit: 'qt',
        allergens: ['MILK'],
        unitCost: 1.85,
        inventoryItemKey: 'buttermilk',
      },
      { name: 'Seasoned flour', quantity: 1.5, unit: 'lb', allergens: ['WHEAT'], unitCost: 0.75 },
      { name: 'Vegetable oil', quantity: 0.5, unit: 'gal', allergens: [], unitCost: 4.2 },
    ],
  },
  {
    name: 'Veggie Wrap',
    category: 'ENTREE',
    servingYield: 80,
    prepMin: 15,
    cookMin: 0,
    instructions:
      'Spread hummus on tortilla. Layer cucumber, bell peppers, spinach, shredded carrot. Roll tightly, cut on bias, serve chilled.',
    ingredients: [
      {
        name: 'Flour tortilla',
        quantity: 80,
        unit: 'each',
        allergens: ['WHEAT'],
        unitCost: 0.18,
        inventoryItemKey: 'tortilla',
      },
      { name: 'Hummus', quantity: 5.0, unit: 'lb', allergens: [], unitCost: 3.2 },
      {
        name: 'Mixed greens',
        quantity: 8.0,
        unit: 'lb',
        allergens: [],
        unitCost: 4.5,
        inventoryItemKey: 'mixed_greens',
      },
      { name: 'Roasted vegetables', quantity: 6.0, unit: 'lb', allergens: [], unitCost: 2.8 },
    ],
  },
  {
    name: 'Fresh Fruit Salad',
    category: 'SIDE',
    servingYield: 120,
    prepMin: 25,
    cookMin: 0,
    instructions:
      'Dice fruit uniformly. Toss with lemon juice. Chill below 5C and serve within 4 hours.',
    ingredients: [
      {
        name: 'Apples',
        quantity: 10.0,
        unit: 'lb',
        allergens: [],
        unitCost: 1.6,
        inventoryItemKey: 'apples',
      },
      { name: 'Strawberries', quantity: 5.0, unit: 'lb', allergens: [], unitCost: 3.4 },
      { name: 'Grapes', quantity: 5.0, unit: 'lb', allergens: [], unitCost: 2.9 },
    ],
  },
];

interface ItemSpec {
  key: string;
  name: string;
  unit: string;
  category:
    | 'PROTEIN'
    | 'DAIRY'
    | 'GRAIN'
    | 'VEGETABLE'
    | 'FRUIT'
    | 'CONDIMENT'
    | 'BEVERAGE'
    | 'PACKAGING'
    | 'OTHER';
  allergenCodes: string[];
  reorderThreshold: number;
  unitCost: number;
  initialQuantity: number;
}

const ITEMS: ItemSpec[] = [
  {
    key: 'chicken_breast',
    name: 'Chicken breast (boneless)',
    unit: 'lb',
    category: 'PROTEIN',
    allergenCodes: [],
    reorderThreshold: 30.0,
    unitCost: 3.5,
    initialQuantity: 75.0,
  },
  {
    key: 'buttermilk',
    name: 'Buttermilk',
    unit: 'qt',
    category: 'DAIRY',
    allergenCodes: ['MILK'],
    reorderThreshold: 6.0,
    unitCost: 1.85,
    initialQuantity: 12.0,
  },
  {
    key: 'panko',
    name: 'Panko breadcrumbs',
    unit: 'lb',
    category: 'GRAIN',
    allergenCodes: ['WHEAT'],
    reorderThreshold: 10.0,
    unitCost: 2.1,
    initialQuantity: 25.0,
  },
  {
    key: 'tortilla',
    name: 'Flour tortilla (10 inch)',
    unit: 'each',
    category: 'GRAIN',
    allergenCodes: ['WHEAT'],
    reorderThreshold: 100,
    unitCost: 0.18,
    initialQuantity: 400,
  },
  {
    key: 'mixed_greens',
    name: 'Mixed greens',
    unit: 'lb',
    category: 'VEGETABLE',
    allergenCodes: [],
    reorderThreshold: 20.0,
    unitCost: 4.5,
    initialQuantity: 35.0,
  },
  {
    key: 'apples',
    name: 'Apples (gala)',
    unit: 'lb',
    category: 'FRUIT',
    allergenCodes: [],
    reorderThreshold: 30.0,
    unitCost: 1.6,
    initialQuantity: 65.0,
  },
  {
    key: 'cheese',
    name: 'Shredded cheddar',
    unit: 'lb',
    category: 'DAIRY',
    allergenCodes: ['MILK'],
    reorderThreshold: 15.0,
    unitCost: 4.2,
    initialQuantity: 22.0,
  },
  {
    key: 'milk_carton',
    name: 'Milk carton (8 oz)',
    unit: 'each',
    category: 'BEVERAGE',
    allergenCodes: ['MILK'],
    reorderThreshold: 200,
    unitCost: 0.35,
    initialQuantity: 480,
  },
  {
    key: 'ketchup',
    name: 'Ketchup (1 gal)',
    unit: 'gal',
    category: 'CONDIMENT',
    allergenCodes: [],
    reorderThreshold: 4.0,
    unitCost: 6.5,
    initialQuantity: 4.0,
  },
  {
    key: 'rice',
    name: 'White rice (50 lb)',
    unit: 'bag',
    category: 'GRAIN',
    allergenCodes: [],
    reorderThreshold: 2.0,
    unitCost: 28.5,
    initialQuantity: 8.0,
  },
];

function union(...arrays: string[][]): string[] {
  const set = new Set<string>();
  for (const arr of arrays) for (const v of arr) if (v) set.add(v);
  return Array.from(set).sort();
}

async function seed(): Promise<void> {
  console.log('');
  console.log('  Food Service Advanced Seed (P2-10a)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const recipeCount = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.fds_recipes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (recipeCount[0]!.c > 0) {
    console.log('  Demo school already has fds_recipes rows — skipping idempotent seed.');
    return;
  }

  // Resolve principal + a teacher employee.
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, pu.email AS email FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.platform_users pu ON pu.id = e.account_id WHERE e.school_id = $1::uuid',
    schoolId,
  )) as Array<{ id: string; email: string }>;
  const mitchell = employees.find((e) => e.email === 'principal@demo.campusos.dev');
  const rivera = employees.find((e) => e.email === 'teacher@demo.campusos.dev');
  if (!mitchell) throw new Error('principal@ employee not found — run seed-hr first');
  if (!rivera) throw new Error('teacher@ employee not found — run seed-hr first');

  // ── A. 2 inventory groups ──
  console.log('  Seeding 2 inventory groups...');
  const mainKitchenId = generateId();
  const breakfastId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_inventory_groups (id, school_id, name, group_type, location, managed_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    mainKitchenId,
    schoolId,
    'Main Kitchen',
    'LUNCH',
    'Building A — Ground Floor',
    mitchell.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_inventory_groups (id, school_id, name, group_type, location) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
    breakfastId,
    schoolId,
    'Breakfast Programme',
    'BREAKFAST',
    'Building A — Cafeteria North',
  );

  // ── B. 10 inventory items ──
  console.log('  Seeding 10 inventory items...');
  const itemIds: Record<string, string> = {};
  for (const it of ITEMS) {
    const id = generateId();
    itemIds[it.key] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_inventory_items (id, school_id, name, unit, category, allergen_codes, reorder_threshold, unit_cost) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, $8)',
      id,
      schoolId,
      it.name,
      it.unit,
      it.category,
      it.allergenCodes,
      it.reorderThreshold,
      it.unitCost,
    );
  }

  // ── C. 10 inventory levels in Main Kitchen ──
  // We deliberately stock Ketchup AT the reorder threshold so the
  // Step 5 InventoryService low-stock emit has a row at the boundary.
  console.log('  Seeding 10 inventory levels (1 at reorder threshold)...');
  for (const it of ITEMS) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        ".fds_inventory_levels (id, group_id, item_id, quantity_on_hand, last_counted_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() - INTERVAL '2 days')",
      generateId(),
      mainKitchenId,
      itemIds[it.key],
      it.initialQuantity,
    );
  }

  // ── D. 15 inventory transactions ──
  console.log(
    '  Seeding 15 inventory transactions (6 RECEIPT, 5 USAGE, 2 WASTE, 2 TRANSFER paired)...',
  );
  const txnRows: Array<{
    type: 'RECEIPT' | 'USAGE' | 'WASTE' | 'TRANSFER_OUT' | 'TRANSFER_IN';
    itemKey: string;
    qty: number;
    groupId: string;
    daysAgo: number;
    transferRef?: string;
  }> = [
    { type: 'RECEIPT', itemKey: 'chicken_breast', qty: 50.0, groupId: mainKitchenId, daysAgo: 28 },
    { type: 'RECEIPT', itemKey: 'panko', qty: 25.0, groupId: mainKitchenId, daysAgo: 28 },
    { type: 'RECEIPT', itemKey: 'milk_carton', qty: 480, groupId: mainKitchenId, daysAgo: 14 },
    { type: 'RECEIPT', itemKey: 'mixed_greens', qty: 35.0, groupId: mainKitchenId, daysAgo: 10 },
    { type: 'RECEIPT', itemKey: 'apples', qty: 60.0, groupId: mainKitchenId, daysAgo: 7 },
    { type: 'RECEIPT', itemKey: 'tortilla', qty: 400, groupId: mainKitchenId, daysAgo: 5 },
    { type: 'USAGE', itemKey: 'chicken_breast', qty: -25.0, groupId: mainKitchenId, daysAgo: 6 },
    { type: 'USAGE', itemKey: 'panko', qty: -3.0, groupId: mainKitchenId, daysAgo: 6 },
    { type: 'USAGE', itemKey: 'buttermilk', qty: -2.0, groupId: mainKitchenId, daysAgo: 6 },
    { type: 'USAGE', itemKey: 'milk_carton', qty: -180, groupId: mainKitchenId, daysAgo: 2 },
    { type: 'USAGE', itemKey: 'apples', qty: -10.0, groupId: mainKitchenId, daysAgo: 2 },
    { type: 'WASTE', itemKey: 'mixed_greens', qty: -2.0, groupId: mainKitchenId, daysAgo: 1 },
    { type: 'WASTE', itemKey: 'apples', qty: -1.5, groupId: mainKitchenId, daysAgo: 1 },
  ];

  const sharedTransferRef = generateId();
  txnRows.push(
    {
      type: 'TRANSFER_OUT',
      itemKey: 'milk_carton',
      qty: -60,
      groupId: mainKitchenId,
      daysAgo: 3,
      transferRef: sharedTransferRef,
    },
    {
      type: 'TRANSFER_IN',
      itemKey: 'milk_carton',
      qty: 60,
      groupId: breakfastId,
      daysAgo: 3,
      transferRef: sharedTransferRef,
    },
  );

  for (const row of txnRows) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_inventory_transactions (id, school_id, group_id, item_id, transaction_type, quantity_delta, performed_by, transaction_at, transfer_reference_id) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, now() - ($8::text)::interval, $9::uuid)',
      generateId(),
      schoolId,
      row.groupId,
      itemIds[row.itemKey],
      row.type,
      row.qty,
      mitchell.id,
      row.daysAgo + ' days',
      row.transferRef ?? null,
    );
  }

  // ── E. 1 transfer request COMPLETED ──
  console.log('  Seeding 1 inventory transfer request (COMPLETED, paired with section D)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_inventory_transfer_requests (id, school_id, from_group_id, to_group_id, item_id, quantity, reason, status, requested_by, reviewed_by, reviewed_at, completed_at, transfer_reference_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, 'COMPLETED', $8::uuid, $9::uuid, now() - INTERVAL '3 days', now() - INTERVAL '3 days', $10::uuid)",
    generateId(),
    schoolId,
    mainKitchenId,
    breakfastId,
    itemIds.milk_carton,
    60,
    'Breakfast programme weekly resupply.',
    mitchell.id,
    mitchell.id,
    sharedTransferRef,
  );

  // ── F. 3 recipes + ingredients with auto-computed aggregates ──
  console.log('  Seeding 3 recipes + ingredients with auto-computed allergens + cost...');
  for (const r of RECIPES) {
    const recipeId = generateId();
    const allergens = union(...r.ingredients.map((ing) => ing.allergens));
    const cost =
      r.ingredients.reduce((sum, ing) => sum + ing.unitCost * ing.quantity, 0) / r.servingYield;
    const costRounded = Math.round(cost * 100) / 100;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_recipes (id, school_id, name, category, serving_yield, prep_time_minutes, cook_time_minutes, instructions, allergens, cost_per_serving, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11::uuid)',
      recipeId,
      schoolId,
      r.name,
      r.category,
      r.servingYield,
      r.prepMin,
      r.cookMin,
      r.instructions,
      allergens,
      costRounded,
      mitchell.id,
    );
    for (const ing of r.ingredients) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fds_recipe_ingredients (id, recipe_id, inventory_item_id, ingredient_name, quantity, unit, allergens, unit_cost) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::text[], $8)',
        generateId(),
        recipeId,
        ing.inventoryItemKey ? itemIds[ing.inventoryItemKey] : null,
        ing.name,
        ing.quantity,
        ing.unit,
        ing.allergens,
        ing.unitCost,
      );
    }
  }

  // ── G. 2 staff meal accounts ──
  console.log('  Seeding 2 staff meal accounts (1 PAYROLL, 1 COMPLIMENTARY)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_staff_meal_accounts (id, employee_id, school_id, balance, deduction_method, daily_limit) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 0.00, 'PAYROLL', 8.00)",
    generateId(),
    mitchell.id,
    schoolId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_staff_meal_accounts (id, employee_id, school_id, balance, deduction_method) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 0.00, 'COMPLIMENTARY')",
    generateId(),
    rivera.id,
    schoolId,
  );

  console.log('');
  console.log('  Food Service Advanced (P2-10a) seed complete.');
  console.log('    Inventory groups: 2 (Main Kitchen LUNCH + Breakfast Programme BREAKFAST)');
  console.log('    Inventory items: 10 / Inventory levels: 10 (Ketchup AT reorder threshold)');
  console.log('    Inventory transactions: 15 (6 RECEIPT, 5 USAGE, 2 WASTE, 2 TRANSFER paired)');
  console.log('    Transfer requests: 1 (COMPLETED, paired with the TRANSFER transactions)');
  console.log('    Recipes: 3 / Ingredients: 12 / allergens + cost auto-computed in seed');
  console.log('    Staff meal accounts: 2 (Mitchell PAYROLL, Rivera COMPLIMENTARY)');
}

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
