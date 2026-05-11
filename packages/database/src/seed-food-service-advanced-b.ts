import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-food-service-advanced-b.ts — Phase 2 Cycle 10 sub-cycle b (P2-10b).
 *
 * Idempotent. Gated on whether the demo school already has any
 * fds_preorder_windows rows.
 *
 * Sections:
 *   A) 2 preorder windows.
 *      - Tomorrow LUNCH, open from yesterday at 18:00 to tomorrow at
 *        09:30 — currently OPEN.
 *      - Next-week BREAKFAST, opens in 3 days. Currently CLOSED to
 *        new orders but exists so the admin queue and reports surface
 *        the upcoming slot.
 *   B) 5 preorders.
 *      - 3 CONFIRMED preorders for tomorrow LUNCH (Maya, Ethan,
 *        Aiden).
 *      - 1 PENDING preorder for tomorrow LUNCH (Lily — pending
 *        admin confirmation).
 *      - 1 CANCELLED preorder for tomorrow LUNCH (Oliver — cancelled
 *        by guardian).
 *   C) 11 preorder line items across the 5 preorders.
 *   D) 1 production report (JSONB) generated for tomorrow LUNCH. The
 *      report aggregates the 3 CONFIRMED preorders' items.
 *   E) Backfill recipe_id on the existing P2-10a Chicken Tenders
 *      production_record (if any production_records row exists in
 *      Cycle 20 seed) so the new FK link is exercised.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seed(): Promise<void> {
  console.log('');
  console.log('  Food Service Advanced Seed (P2-10b)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const windowCount = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.fds_preorder_windows WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (windowCount[0]!.c > 0) {
    console.log('  Demo school already has fds_preorder_windows rows — skipping idempotent seed.');
    return;
  }

  // Resolve admin actor (principal) + a few students + their guardians.
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, e.account_id::text AS account_id, pu.email AS email FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.platform_users pu ON pu.id = e.account_id WHERE e.school_id = $1::uuid',
    schoolId,
  )) as Array<{ id: string; account_id: string; email: string }>;
  const mitchell = employees.find((e) => e.email === 'principal@demo.campusos.dev');
  if (!mitchell) throw new Error('principal@ employee not found — run seed-hr first');

  // Pull a few students for the preorders.
  const students = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id, ip.first_name AS first_name, ip.last_name AS last_name FROM ' +
      TENANT_SCHEMA +
      '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person ip ON ip.id = ps.person_id WHERE s.school_id = $1::uuid ORDER BY ip.first_name LIMIT 5',
    schoolId,
  )) as Array<{ id: string; first_name: string; last_name: string }>;
  if (students.length < 5) {
    throw new Error('expected at least 5 students for the demo school — run seed-sis first');
  }
  const [maya, ethan, aiden, lily, oliver] = students;

  // Resolve guardian accountId for Maya/Ethan/Aiden — at least one guardian
  // per student. We pick the first guardian per student to act as
  // ordered_by on the parent-submitted preorders.
  const guardians = (await client.$queryRawUnsafe(
    'SELECT DISTINCT ON (sg.student_id) sg.student_id::text AS student_id, ' +
      'g.account_id::text AS account_id ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.sis_student_guardians sg ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.sis_guardians g ON g.id = sg.guardian_id ' +
      'WHERE sg.student_id = ANY($1::uuid[]) AND g.account_id IS NOT NULL ' +
      'ORDER BY sg.student_id, sg.created_at',
    students.map((s) => s.id),
  )) as Array<{ student_id: string; account_id: string }>;
  const guardianByStudent = new Map(guardians.map((g) => [g.student_id, g.account_id]));

  // Resolve 2-3 menu items for the preorders. We pick the first 3
  // active + preorderable items.
  const menuItems = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name, allergen_codes FROM ' +
      TENANT_SCHEMA +
      '.fds_menu_items WHERE school_id = $1::uuid AND is_active = true AND is_preorderable = true ' +
      'ORDER BY name LIMIT 3',
    schoolId,
  )) as Array<{ id: string; name: string; allergen_codes: string[] }>;
  if (menuItems.length < 2) {
    throw new Error(
      'expected at least 2 active+preorderable menu items — run seed-food-service (Cycle 20) first',
    );
  }
  const [itemA, itemB, itemC] = menuItems;

  // ── A. 2 preorder windows ──
  console.log(
    '  Seeding 2 preorder windows (tomorrow LUNCH open + next-week BREAKFAST upcoming)...',
  );
  const tomorrowLunchId = generateId();
  const nextWeekBreakfastId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_preorder_windows (id, school_id, service_date, meal_type, opens_at, closes_at, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, current_date + 1, 'LUNCH', now() - interval '15 hours', current_date + 1 + interval '9 hours 30 minutes', $3, $4::uuid)",
    tomorrowLunchId,
    schoolId,
    'Pre-order window for tomorrow lunch. Closes at 09:30 the morning of service.',
    mitchell.account_id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_preorder_windows (id, school_id, service_date, meal_type, opens_at, closes_at, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, current_date + 8, 'BREAKFAST', current_date + 3 + interval '18 hours', current_date + 8 + interval '6 hours', $3, $4::uuid)",
    nextWeekBreakfastId,
    schoolId,
    'Next-week breakfast preorder window. Opens in 3 days for parents to plan ahead.',
    mitchell.account_id,
  );

  // ── B + C. 5 preorders + 11 line items ──
  console.log('  Seeding 5 preorders (3 CONFIRMED, 1 PENDING, 1 CANCELLED) + 11 line items...');

  // Helper to insert a preorder + its items.
  type ItemSpec = { menuItemId: string; quantity: number; notes?: string };
  async function insertPreorder(
    studentId: string,
    orderedByAccount: string,
    status: 'PENDING' | 'CONFIRMED' | 'CANCELLED',
    items: ItemSpec[],
    warningAllergens: string[],
    cancellationReason: string | null,
  ): Promise<void> {
    const preorderId = generateId();
    const confirmedAt = status === 'CONFIRMED' ? "now() - interval '2 hours'" : 'NULL';
    const cancelledAt = status === 'CANCELLED' ? "now() - interval '4 hours'" : 'NULL';
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_meal_preorders (id, school_id, student_id, preorder_window_id, ordered_by, status, allergen_check_passed, warning_allergens, confirmed_at, cancelled_at, cancellation_reason) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, true, $7::text[], ' +
        confirmedAt +
        ', ' +
        cancelledAt +
        ', $8)',
      preorderId,
      schoolId,
      studentId,
      tomorrowLunchId,
      orderedByAccount,
      status,
      warningAllergens,
      cancellationReason,
    );
    for (const item of items) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fds_meal_preorder_items (id, preorder_id, menu_item_id, quantity, notes) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
        generateId(),
        preorderId,
        item.menuItemId,
        item.quantity,
        item.notes ?? null,
      );
    }
  }

  await insertPreorder(
    maya!.id,
    guardianByStudent.get(maya!.id) ?? mitchell.account_id,
    'CONFIRMED',
    [
      { menuItemId: itemA!.id, quantity: 1 },
      { menuItemId: itemB!.id, quantity: 1 },
      { menuItemId: itemC ? itemC.id : itemA!.id, quantity: 1, notes: 'Side requested' },
    ],
    [],
    null,
  );
  await insertPreorder(
    ethan!.id,
    guardianByStudent.get(ethan!.id) ?? mitchell.account_id,
    'CONFIRMED',
    [
      { menuItemId: itemA!.id, quantity: 1 },
      { menuItemId: itemB!.id, quantity: 1 },
    ],
    [],
    null,
  );
  await insertPreorder(
    aiden!.id,
    guardianByStudent.get(aiden!.id) ?? mitchell.account_id,
    'CONFIRMED',
    [
      { menuItemId: itemA!.id, quantity: 1 },
      { menuItemId: itemC ? itemC.id : itemB!.id, quantity: 1 },
    ],
    [],
    null,
  );
  await insertPreorder(
    lily!.id,
    guardianByStudent.get(lily!.id) ?? mitchell.account_id,
    'PENDING',
    [{ menuItemId: itemB!.id, quantity: 1 }],
    [],
    null,
  );
  await insertPreorder(
    oliver!.id,
    guardianByStudent.get(oliver!.id) ?? mitchell.account_id,
    'CANCELLED',
    [
      { menuItemId: itemA!.id, quantity: 1 },
      { menuItemId: itemB!.id, quantity: 1 },
      { menuItemId: itemC ? itemC.id : itemA!.id, quantity: 1 },
    ],
    [],
    'Family will dine off-campus tomorrow.',
  );

  // ── D. 1 production report ──
  console.log('  Generating production report for tomorrow LUNCH (3 CONFIRMED preorders)...');
  const itemBreakdown: Array<{
    menuItemId: string;
    menuItemName: string;
    totalQuantity: number;
    orderCount: number;
  }> = [];
  const accumulator = new Map<string, { name: string; total: number; orders: Set<string> }>();
  // The 3 CONFIRMED preorders' items (re-derived synchronously so the
  // report row is internally consistent without round-tripping through
  // a SELECT aggregation).
  const confirmedItemSummary = [
    { studentId: maya!.id, itemId: itemA!.id, qty: 1 },
    { studentId: maya!.id, itemId: itemB!.id, qty: 1 },
    { studentId: maya!.id, itemId: (itemC ?? itemA)!.id, qty: 1 },
    { studentId: ethan!.id, itemId: itemA!.id, qty: 1 },
    { studentId: ethan!.id, itemId: itemB!.id, qty: 1 },
    { studentId: aiden!.id, itemId: itemA!.id, qty: 1 },
    { studentId: aiden!.id, itemId: (itemC ?? itemB)!.id, qty: 1 },
  ];
  for (const row of confirmedItemSummary) {
    const mi = menuItems.find((m) => m.id === row.itemId);
    if (!mi) continue;
    const cur = accumulator.get(row.itemId) ?? {
      name: mi.name,
      total: 0,
      orders: new Set<string>(),
    };
    cur.total += row.qty;
    cur.orders.add(row.studentId);
    accumulator.set(row.itemId, cur);
  }
  for (const [id, agg] of accumulator) {
    itemBreakdown.push({
      menuItemId: id,
      menuItemName: agg.name,
      totalQuantity: agg.total,
      orderCount: agg.orders.size,
    });
  }
  itemBreakdown.sort((a, b) => a.menuItemName.localeCompare(b.menuItemName));

  // Dietary breakdown — UNNEST(allergen_codes) per item, count distinct
  // affected orders. Drive directly from the items so the report stays
  // internally consistent.
  const dietaryAccum = new Map<string, Set<string>>();
  for (const row of confirmedItemSummary) {
    const mi = menuItems.find((m) => m.id === row.itemId);
    if (!mi) continue;
    for (const code of mi.allergen_codes ?? []) {
      const set = dietaryAccum.get(code) ?? new Set<string>();
      set.add(row.studentId);
      dietaryAccum.set(code, set);
    }
  }
  const dietaryBreakdown = Array.from(dietaryAccum.entries())
    .map(([allergen, orders]) => ({ allergen, affectedOrders: orders.size }))
    .sort((a, b) => a.allergen.localeCompare(b.allergen));

  const totalItems = itemBreakdown.reduce((sum, r) => sum + r.totalQuantity, 0);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_preorder_production_reports (id, school_id, service_date, meal_type, total_orders, total_items, report_data, generated_by, generated_at) ' +
      "VALUES ($1::uuid, $2::uuid, current_date + 1, 'LUNCH', $3, $4, $5::jsonb, $6::uuid, now())",
    generateId(),
    schoolId,
    3,
    totalItems,
    JSON.stringify({ itemBreakdown, dietaryBreakdown }),
    mitchell.account_id,
  );

  // ── E. backfill recipe_id on an existing fds_production_records row ──
  console.log(
    '  Backfilling recipe_id on the existing Cycle 20 production_records row (if any)...',
  );
  const productionRecordCount = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.fds_production_records WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (productionRecordCount[0]!.c > 0) {
    const chickenTenders = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        ".fds_recipes WHERE school_id = $1::uuid AND name = 'Chicken Tenders' LIMIT 1",
      schoolId,
    )) as Array<{ id: string }>;
    if (chickenTenders.length > 0) {
      const recipeId = chickenTenders[0]!.id;
      // Find the first production record and link it. NULL → recipeId.
      await client.$executeRawUnsafe(
        'UPDATE ' +
          TENANT_SCHEMA +
          '.fds_production_records SET recipe_id = $1::uuid, updated_at = now() ' +
          'WHERE school_id = $2::uuid AND recipe_id IS NULL ' +
          'AND id IN (SELECT id FROM ' +
          TENANT_SCHEMA +
          '.fds_production_records WHERE school_id = $2::uuid ORDER BY meal_service_date DESC LIMIT 1)',
        recipeId,
        schoolId,
      );
    }
  }

  console.log('');
  console.log('  Food Service Advanced (P2-10b) seed complete.');
  console.log('    Preorder windows: 2 (tomorrow LUNCH open + next-week BREAKFAST upcoming)');
  console.log('    Preorders: 5 (3 CONFIRMED, 1 PENDING, 1 CANCELLED)');
  console.log('    Preorder line items: 11');
  console.log('    Production reports: 1 (tomorrow LUNCH, 3 CONFIRMED, ' + totalItems + ' items)');
  console.log('    Production record recipe_id backfill: attempted (idempotent NULL → recipe)');
}

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
