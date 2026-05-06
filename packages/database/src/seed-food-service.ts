import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-food-service.ts — Cycle 20 Step 4.
 *
 * M63 Food Service. Idempotent — gated on whether fds_menu_cycles
 * already has rows for the demo school.
 *
 * Sections:
 *   A) 1 menu cycle ("Week A" 5-day) + 8 menu items with realistic
 *      allergen_codes covering MILK / WHEAT / PEANUTS / SOYBEANS.
 *   B) 2 daily menus (Monday + Tuesday lunch this week) + 7 menu
 *      items assigned across them.
 *   C) 1 POS device "Main Cafeteria Register" CASHIER_STAFFED + 1
 *      LUNCH session yesterday COMPLETED.
 *   D) 3 sample transactions: Maya LUNCH_ACCOUNT $3.50, Ethan CASH
 *      $3.50, third student FREE_MEAL $0.00.
 *   E) 3 dietary profiles: Maya STANDARD, Ethan STANDARD, third
 *      student VEGETARIAN + free_meal_eligible=true.
 *   F) 2 allergen alerts (SAFETY KEYSTONE SEED): Maya PEANUTS
 *      CRITICAL, Ethan MILK CRITICAL. These mirror Cycle 10 health
 *      data via manual seed sync — the Phase 2 Kafka consumer on
 *      hlth.allergy_alert.changed will replace this manual upsert.
 *   G) 1 NSLP application + determination: third student CATEGORICAL
 *      (SNAP), APPROVED FREE.
 *   H) 2 temperature logs: walk-in fridge 3.2C compliant + hot hold
 *      58C NON-COMPLIANT with corrective action.
 *   I) 1 cash reconciliation: yesterday opening $50, expected $57,
 *      actual $56.85, variance -$0.15, VARIANCE_FLAGGED.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedFoodService() {
  console.log('');
  console.log('  Food Service Seed (Cycle 20 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.fds_menu_cycles WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  fds_menu_cycles already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  async function findStudentByPersonName(
    first: string,
    last: string,
  ): Promise<{ sisStudentId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS sis_id, p.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2 LIMIT 1',
      first,
      last,
    )) as Array<{ sis_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('sis_students not found for ' + first + ' ' + last);
    return { sisStudentId: rows[0]!.sis_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const rivera = await findUserByEmail('teacher@demo.campusos.dev');
  const davidChen = await findUserByEmail('parent@demo.campusos.dev');
  const maya = await findStudentByPersonName('Maya', 'Chen');
  const ethan = await findStudentByPersonName('Ethan', 'Rodriguez');

  // Resolve a current academic year for the eligibility application
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_academic_years WHERE name = '2025-2026' LIMIT 1",
  )) as Array<{ id: string }>;
  const academicYearId = yearRows[0]?.id ?? null;

  // ── A. 1 menu cycle + 8 items ──
  console.log('  Seeding 1 menu cycle + 8 menu items...');
  const weekACycle = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_menu_cycles (id, school_id, name, description, cycle_length_days, is_active, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, $6::uuid)',
    weekACycle,
    schoolId,
    'Week A',
    'Standard 5-day rotating lunch menu — Week A.',
    5,
    mitchell.accountId,
  );

  const items: Record<string, { id: string; name: string; allergens: string[] }> = {};
  const itemSpec: Array<{
    key: string;
    name: string;
    category: string;
    cost: number;
    cal: number;
    codes: string[];
    veg?: boolean;
    gf?: boolean;
  }> = [
    {
      key: 'nuggets',
      name: 'Chicken Nuggets',
      category: 'MAIN',
      cost: 1.95,
      cal: 320,
      codes: ['WHEAT', 'SOYBEANS'],
    },
    {
      key: 'grilledCheese',
      name: 'Grilled Cheese',
      category: 'MAIN',
      cost: 1.85,
      cal: 380,
      codes: ['MILK', 'WHEAT'],
      veg: true,
    },
    {
      key: 'pbj',
      name: 'PBJ Sandwich',
      category: 'MAIN',
      cost: 1.75,
      cal: 360,
      codes: ['PEANUTS', 'WHEAT'],
      veg: true,
    },
    {
      key: 'pasta',
      name: 'Pasta Marinara',
      category: 'MAIN',
      cost: 1.65,
      cal: 340,
      codes: ['WHEAT'],
      veg: true,
    },
    {
      key: 'fruit',
      name: 'Fresh Fruit Salad',
      category: 'SIDE',
      cost: 0.85,
      cal: 95,
      codes: [],
      veg: true,
      gf: true,
    },
    {
      key: 'salad',
      name: 'Garden Salad',
      category: 'SIDE',
      cost: 0.75,
      cal: 60,
      codes: [],
      veg: true,
      gf: true,
    },
    {
      key: 'apple',
      name: 'Apple Juice',
      category: 'DRINK',
      cost: 0.45,
      cal: 110,
      codes: [],
      veg: true,
      gf: true,
    },
    {
      key: 'choco',
      name: 'Chocolate Milk',
      category: 'DRINK',
      cost: 0.55,
      cal: 150,
      codes: ['MILK'],
      veg: true,
      gf: true,
    },
  ];
  for (const s of itemSpec) {
    const id = generateId();
    items[s.key] = { id, name: s.name, allergens: s.codes };
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_menu_items (id, school_id, name, category, unit_cost, calories, allergens, allergen_codes, is_vegetarian, is_gluten_free, created_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], $8::text[], $9, $10, $11::uuid)',
      id,
      schoolId,
      s.name,
      s.category,
      s.cost,
      s.cal,
      s.codes,
      s.codes,
      s.veg ?? false,
      s.gf ?? false,
      mitchell.accountId,
    );
  }

  // ── B. 2 daily menus + 7 daily items ──
  console.log('  Seeding 2 daily menus (Monday + Tuesday lunch)...');
  const mondayMenu = generateId();
  const tuesdayMenu = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_daily_menus (id, school_id, menu_date, cycle_id, meal_type, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, CURRENT_DATE - INTERVAL '1 day', $3::uuid, 'LUNCH', $4::uuid)",
    mondayMenu,
    schoolId,
    weekACycle,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_daily_menus (id, school_id, menu_date, cycle_id, meal_type, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, CURRENT_DATE, $3::uuid, 'LUNCH', $4::uuid)",
    tuesdayMenu,
    schoolId,
    weekACycle,
    mitchell.accountId,
  );

  const dailyAssignments = [
    { menu: mondayMenu, item: 'nuggets' },
    { menu: mondayMenu, item: 'pasta' },
    { menu: mondayMenu, item: 'fruit' },
    { menu: mondayMenu, item: 'apple' },
    { menu: tuesdayMenu, item: 'grilledCheese' },
    { menu: tuesdayMenu, item: 'salad' },
    { menu: tuesdayMenu, item: 'choco' },
  ];
  for (const a of dailyAssignments) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_daily_menu_items (id, daily_menu_id, menu_item_id, quantity_prepared, is_available) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, 60, true)',
      generateId(),
      a.menu,
      items[a.item]!.id,
    );
  }

  // ── C. 1 POS device + 1 session ──
  console.log('  Seeding 1 POS device + 1 LUNCH session (yesterday COMPLETED)...');
  const posDevice = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_pos_devices (id, school_id, device_name, location, device_type, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'Main Cafeteria Register', 'Cafeteria — checkout 1', 'CASHIER_STAFFED', true)",
    posDevice,
    schoolId,
  );

  const yesterdaySession = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_meal_service_sessions (id, school_id, service_date, meal_type, opened_by, opened_at, closed_by, closed_at) ' +
      "VALUES ($1::uuid, $2::uuid, CURRENT_DATE - INTERVAL '1 day', 'LUNCH', $3::uuid, " +
      "CURRENT_DATE - INTERVAL '1 day' + INTERVAL '11 hours', $3::uuid, CURRENT_DATE - INTERVAL '1 day' + INTERVAL '13 hours 15 minutes')",
    yesterdaySession,
    schoolId,
    mitchell.accountId,
  );

  // ── D. 3 sample transactions ──
  console.log('  Seeding 3 sample transactions...');
  // Maya: LUNCH_ACCOUNT (Maya doesn't have a CRITICAL allergen for nuggets/pasta/fruit/apple — yesterday's menu is safe)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_meal_transactions (id, patron_id, patron_type, session_id, pos_device_id, items, total, payment_method, served_at, served_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'STUDENT', $3::uuid, $4::uuid, $5::jsonb, 3.50, 'LUNCH_ACCOUNT', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '11 hours 30 minutes', $6::uuid)",
    generateId(),
    maya.personId,
    yesterdaySession,
    posDevice,
    JSON.stringify([
      { itemId: items.nuggets!.id, name: 'Chicken Nuggets', price: 1.95 },
      { itemId: items.fruit!.id, name: 'Fresh Fruit Salad', price: 0.85 },
      { itemId: items.apple!.id, name: 'Apple Juice', price: 0.45 },
    ]),
    mitchell.accountId,
  );
  // Ethan: CASH (also nuggets — no MILK, safe yesterday)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_meal_transactions (id, patron_id, patron_type, session_id, pos_device_id, items, total, payment_method, served_at, served_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'STUDENT', $3::uuid, $4::uuid, $5::jsonb, 3.50, 'CASH', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '12 hours 5 minutes', $6::uuid)",
    generateId(),
    ethan.personId,
    yesterdaySession,
    posDevice,
    JSON.stringify([
      { itemId: items.nuggets!.id, name: 'Chicken Nuggets', price: 1.95 },
      { itemId: items.salad!.id, name: 'Garden Salad', price: 0.75 },
      { itemId: items.apple!.id, name: 'Apple Juice', price: 0.45 },
    ]),
    mitchell.accountId,
  );
  // Free meal — third student gets FREE_MEAL $0.00 (using a third student via lookup)
  // For seed, we use Maya again as a placeholder for the free-meal pattern since the
  // tenant only ships 2 student personas; we'll create the third dietary profile
  // pointing at the Aiden Park student that Cycle 6 seeded.
  const aidenRows = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS sis_id, p.id::text AS person_id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person p ON p.id = ps.person_id ' +
      "WHERE p.first_name = 'Aiden' AND p.last_name = 'Johnson' LIMIT 1",
  )) as Array<{ sis_id: string; person_id: string }>;
  const aiden = aidenRows[0];
  if (aiden) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_meal_transactions (id, patron_id, patron_type, session_id, pos_device_id, items, total, payment_method, served_at, served_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'STUDENT', $3::uuid, $4::uuid, $5::jsonb, 0.00, 'FREE_MEAL', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '12 hours 25 minutes', $6::uuid)",
      generateId(),
      aiden.person_id,
      yesterdaySession,
      posDevice,
      JSON.stringify([
        { itemId: items.pasta!.id, name: 'Pasta Marinara', price: 1.65 },
        { itemId: items.fruit!.id, name: 'Fresh Fruit Salad', price: 0.85 },
        { itemId: items.apple!.id, name: 'Apple Juice', price: 0.45 },
      ]),
      mitchell.accountId,
    );
  }

  // ── E. 3 dietary profiles ──
  console.log('  Seeding 3 dietary profiles...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_student_dietary_profiles (id, student_id, school_id, meal_plan_type, free_meal_eligible) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'STANDARD', false)",
    generateId(),
    maya.sisStudentId,
    schoolId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_student_dietary_profiles (id, student_id, school_id, meal_plan_type, free_meal_eligible) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'STANDARD', false)",
    generateId(),
    ethan.sisStudentId,
    schoolId,
  );
  if (aiden) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_student_dietary_profiles (id, student_id, school_id, meal_plan_type, free_meal_eligible) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'VEGETARIAN', true)",
      generateId(),
      aiden.sis_id,
      schoolId,
    );
  }

  // ── F. 2 allergen alerts (SAFETY KEYSTONE) ──
  console.log('  Seeding 2 allergen alerts (SAFETY KEYSTONE)...');
  // Maya PEANUTS CRITICAL — mirrors Cycle 10 hlth_health_alerts (use a synthetic source id)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_student_allergen_alerts (id, student_id, school_id, allergen_code, allergen_display_name, severity, source_health_alert_id, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PEANUTS', 'Peanuts (anaphylactic)', 'CRITICAL', $4::uuid, true)",
    generateId(),
    maya.sisStudentId,
    schoolId,
    generateId(),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_student_allergen_alerts (id, student_id, school_id, allergen_code, allergen_display_name, severity, source_health_alert_id, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MILK', 'Milk (severe lactose response)', 'CRITICAL', $4::uuid, true)",
    generateId(),
    ethan.sisStudentId,
    schoolId,
    generateId(),
  );

  // ── G. 1 NSLP application + determination ──
  if (aiden) {
    console.log('  Seeding 1 NSLP application + determination (Aiden, FREE)...');
    const appId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_eligibility_applications (id, school_id, student_id, submitted_by, academic_year_id, household_size, snap_benefit_case_number, application_type, status, submitted_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 4, 'SNAP-IL-44893', 'CATEGORICAL', 'APPROVED', now() - INTERVAL '14 days')",
      appId,
      schoolId,
      aiden.sis_id,
      mitchell.accountId,
      academicYearId,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fds_eligibility_determinations (id, application_id, determined_by, determined_at, eligibility_category, effective_from, effective_to, notification_sent) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '12 days', 'FREE', CURRENT_DATE - INTERVAL '12 days', CURRENT_DATE + INTERVAL '11 months', true)",
      generateId(),
      appId,
      mitchell.accountId,
    );
  }

  // ── H. 2 temperature logs ──
  console.log('  Seeding 2 temperature logs (1 compliant, 1 NON-COMPLIANT)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_temperature_logs (id, school_id, check_location, location_name, temperature_celsius, safe_range_min, safe_range_max, is_compliant, logged_by, logged_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'REFRIGERATOR', 'Walk-in Fridge', 3.2, 0.0, 5.0, true, $3::uuid, now() - INTERVAL '4 hours')",
    generateId(),
    schoolId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_temperature_logs (id, school_id, check_location, location_name, temperature_celsius, safe_range_min, safe_range_max, is_compliant, corrective_action, logged_by, logged_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'HOT_HOLD', 'Hot Hold Counter', 58.0, 63.0, 74.0, false, 'Reheated to 74C and resumed service after 12-minute hold above 63C.', $3::uuid, now() - INTERVAL '3 hours')",
    generateId(),
    schoolId,
    mitchell.accountId,
  );

  // ── I. 1 cash reconciliation ──
  console.log('  Seeding 1 cash drawer reconciliation (variance flagged)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fds_cash_drawer_reconciliation (id, session_id, pos_device_id, opening_balance, expected_closing_balance, actual_closing_balance, variance, reconciled_by, reconciled_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 50.00, 57.00, 56.85, -0.15, $4::uuid, now() - INTERVAL '23 hours', 'VARIANCE_FLAGGED')",
    generateId(),
    yesterdaySession,
    posDevice,
    mitchell.accountId,
  );

  // Reduce unused-binding lint chatter
  void rivera;
  void davidChen;

  console.log('');
  console.log('  Food Service seed complete.');
  console.log('    Menu cycles: 1 (Week A) / Menu items: 8');
  console.log('    Daily menus: 2 (Monday + Tuesday lunch) / Daily items: 7');
  console.log('    POS devices: 1 / Sessions: 1 / Transactions: ' + (aiden ? 3 : 2));
  console.log(
    '    Dietary profiles: ' + (aiden ? 3 : 2) + ' / Allergen alerts: 2 (Maya PEANUTS, Ethan MILK)',
  );
  console.log('    Eligibility apps: ' + (aiden ? 1 : 0) + ' / Determinations: ' + (aiden ? 1 : 0));
  console.log('    Temperature logs: 2 (1 compliant + 1 NON-COMPLIANT)');
  console.log('    Cash reconciliation: 1 (VARIANCE_FLAGGED)');
}

seedFoodService()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
