import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-transport-advanced.ts — P2-11a Step 2 (Phase 2 Cycle 11 sub-cycle a).
 *
 * M61 Transportation Advanced — Fleet Maintenance plus Fuel plus Driver Hours.
 *
 * Idempotent — gated on whether trn_repair_categories already has rows
 * for the demo school. Re-runs are no-ops.
 *
 * Sections:
 *   A) 3 repair categories (1 safety-critical Brakes + 1 Body Work + 1 Electrical).
 *   B) 5 repairs (3 INTERNAL + 2 EXTERNAL_VENDOR with warranty_claim).
 *      Mix of SCHEDULED + IN_PROGRESS + COMPLETED status states.
 *   C) 8 parts inventory rows (2 below min_stock_level).
 *   D) 6 vehicle components across Bus #42 and Van #3 (1 approaching
 *      expected life).
 *   E) 10 fuel logs across both vehicles (allows efficiency computation
 *      on the consecutive rows).
 *   F) 5 driver hours logs for Linda Park (1 approaching weekly limit).
 *   G) 1 driver hours limit config row (EU WTD defaults).
 *   H) 2 vehicle lifecycle records.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedTransportAdvanced() {
  console.log('');
  console.log('  Transportation Advanced Seed (P2-11a Step 2)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.trn_repair_categories WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  trn_repair_categories already populated for demo school. Skipping.');
    return;
  }

  // ── Resolve vehicles ──
  async function findVehicleByRegistration(reg: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.trn_vehicles WHERE registration = $1 LIMIT 1',
      reg,
    )) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new Error('trn_vehicles row not found for ' + reg + ' — run seed:transport first');
    }
    return rows[0]!.id;
  }

  const bus42 = await findVehicleByRegistration('BUS-42');
  const van3 = await findVehicleByRegistration('VAN-3');

  // Resolve Linda Park's hr_employees row (the driver in seed-transport)
  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const park = await findUserByEmail('vp@demo.campusos.dev');
  const driverRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
    park.personId,
  )) as Array<{ id: string }>;
  if (driverRows.length === 0) {
    throw new Error("Linda Park's hr_employees row not found — run seed:hr first");
  }
  const driverEmployeeId = driverRows[0]!.id;

  // ── A. 3 repair categories ──
  console.log('  Seeding 3 repair categories (1 safety-critical)...');
  const brakesCategoryId = generateId();
  const bodyCategoryId = generateId();
  const electricalCategoryId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_repair_categories (id, school_id, name, is_safety_critical) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true)',
    brakesCategoryId,
    schoolId,
    'Brakes & Suspension',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_repair_categories (id, school_id, name, is_safety_critical) ' +
      'VALUES ($1::uuid, $2::uuid, $3, false)',
    bodyCategoryId,
    schoolId,
    'Body Work',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_repair_categories (id, school_id, name, is_safety_critical) ' +
      'VALUES ($1::uuid, $2::uuid, $3, false)',
    electricalCategoryId,
    schoolId,
    'Electrical',
  );

  // ── B. 5 repairs (3 INTERNAL, 2 EXTERNAL_VENDOR with warranty_claim) ──
  console.log('  Seeding 5 repairs...');

  // Internal completed brake pad replacement (safety-critical, COMPLETED)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_repairs ' +
      '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, labour_hours, total_cost, performed_by_type, status, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '45 days', 48200, $4, $5, 2.5, 320.00, 'INTERNAL', 'COMPLETED', now() - INTERVAL '45 days')",
    generateId(),
    bus42,
    brakesCategoryId,
    'Front brake pads worn below 2mm.',
    'Replaced front brake pads and resurfaced rotors.',
  );

  // Internal completed body panel repair (non-safety-critical)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_repairs ' +
      '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, labour_hours, total_cost, performed_by_type, status, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '20 days', 49100, $4, $5, 4.0, 180.00, 'INTERNAL', 'COMPLETED', now() - INTERVAL '20 days')",
    generateId(),
    bus42,
    bodyCategoryId,
    'Minor dent and scrape on rear quarter panel.',
    'Pulled dent, sanded, primed, painted.',
  );

  // Internal SCHEDULED brake check (safety-critical, blocks vehicle)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_repairs ' +
      '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, labour_hours, total_cost, performed_by_type, status, scheduled_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE + INTERVAL '3 days', 49400, $4, $5, 1.5, 95.00, 'INTERNAL', 'SCHEDULED', now() + INTERVAL '3 days')",
    generateId(),
    bus42,
    brakesCategoryId,
    'Rear brake squeal under braking.',
    'Inspect rear brake pads, rotors, and calipers.',
  );

  // External vendor COMPLETED with warranty claim
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_repairs ' +
      '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, labour_hours, total_cost, performed_by_type, vendor_account_id, warranty_claim, status, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '90 days', 47800, $4, $5, 6.0, 1450.00, 'EXTERNAL_VENDOR', $6::uuid, true, 'COMPLETED', now() - INTERVAL '90 days')",
    generateId(),
    bus42,
    electricalCategoryId,
    'Alternator failure under load.',
    'Vendor replaced alternator. Warranty claim filed with Bosch.',
    generateId(), // soft vendor_account_id
  );

  // External vendor IN_PROGRESS with warranty claim (van)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_repairs ' +
      '(id, vehicle_id, category_id, repair_date, mileage_at_repair, problem_description, work_performed, labour_hours, total_cost, performed_by_type, vendor_account_id, warranty_claim, status, started_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '2 days', 31200, $4, $5, 0, 0.00, 'EXTERNAL_VENDOR', $6::uuid, true, 'IN_PROGRESS', now() - INTERVAL '2 days')",
    generateId(),
    van3,
    electricalCategoryId,
    'Starter motor intermittent failure.',
    'Vendor diagnosing. Warranty claim opened with Ford.',
    generateId(),
  );

  // ── C. 8 parts inventory (2 below min_stock_level) ──
  console.log('  Seeding 8 parts inventory rows (2 below threshold)...');
  const partsSeed = [
    { name: 'Air Filter — Blue Bird', number: 'AF-BB-A1', qty: 12, min: 4, cost: 18.5 },
    { name: 'Brake Pads — Front Set', number: 'BP-FS-2020', qty: 2, min: 4, cost: 64.0 }, // low
    { name: 'Brake Pads — Rear Set', number: 'BP-RS-2020', qty: 6, min: 4, cost: 58.0 },
    { name: 'Oil Filter', number: 'OF-STD', qty: 24, min: 10, cost: 9.25 },
    { name: 'Engine Oil 15W-40 (5L)', number: 'OIL-1540-5L', qty: 1, min: 6, cost: 32.0 }, // low
    { name: 'Wiper Blades — 22 inch', number: 'WB-22', qty: 8, min: 4, cost: 14.0 },
    { name: 'Headlight Bulb H7', number: 'HL-H7', qty: 16, min: 6, cost: 11.5 },
    { name: 'Coolant 5L', number: 'COOL-5L', qty: 10, min: 4, cost: 22.0 },
  ];
  for (const p of partsSeed) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_parts_inventory (id, school_id, part_name, part_number, quantity_on_hand, min_stock_level, unit_cost, last_restocked_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, CURRENT_DATE - INTERVAL '14 days')",
      generateId(),
      schoolId,
      p.name,
      p.number,
      p.qty,
      p.min,
      p.cost,
    );
  }

  // ── D. 6 components across Bus #42 and Van #3 ──
  console.log('  Seeding 6 vehicle components (1 approaching end of life)...');

  // Bus #42 components
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'TYRE', 'Front-left Michelin XZE2', CURRENT_DATE - INTERVAL '300 days', 42000, 40000, 24, 'ACTIVE')",
    generateId(),
    bus42,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'TYRE', 'Front-right Michelin XZE2', CURRENT_DATE - INTERVAL '300 days', 42000, 40000, 24, 'ACTIVE')",
    generateId(),
    bus42,
  );
  // Battery approaching end of life — installed 700 days ago, expected_life_months=24 -> due
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'BATTERY', 'Bosch S5 12V 95Ah', CURRENT_DATE - INTERVAL '700 days', 32000, NULL, 24, 'ACTIVE')",
    generateId(),
    bus42,
  );
  // Brake set — replaced 45 days ago by the historical repair above
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'BRAKE', 'Front brake pads (post-repair)', CURRENT_DATE - INTERVAL '45 days', 48200, 25000, NULL, 'ACTIVE')",
    generateId(),
    bus42,
  );

  // Van #3 components
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, warranty_provider, warranty_expiry_date, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'BATTERY', 'Ford OEM 12V 70Ah', CURRENT_DATE - INTERVAL '120 days', 28500, NULL, 36, 'Ford Warranty', CURRENT_DATE + INTERVAL '900 days', 'ACTIVE')",
    generateId(),
    van3,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_components (id, vehicle_id, component_type, description, installed_date, installed_mileage, expected_life_miles, expected_life_months, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'ALTERNATOR', 'Bosch reman alternator', CURRENT_DATE - INTERVAL '90 days', 30100, 80000, NULL, 'ACTIVE')",
    generateId(),
    van3,
  );

  // ── E. 10 fuel logs across both vehicles ──
  console.log('  Seeding 10 fuel logs...');
  const fuelSeed = [
    { v: bus42, days: 28, odo: 47000.0, qty: 95.5, cost: 121.6, type: 'DIESEL' },
    { v: bus42, days: 21, odo: 47650.0, qty: 92.0, cost: 117.1, type: 'DIESEL' },
    { v: bus42, days: 14, odo: 48300.0, qty: 90.5, cost: 115.2, type: 'DIESEL' },
    { v: bus42, days: 7, odo: 48950.0, qty: 96.0, cost: 122.2, type: 'DIESEL' },
    { v: bus42, days: 1, odo: 49500.0, qty: 88.0, cost: 112.0, type: 'DIESEL' },
    { v: van3, days: 30, odo: 30000.0, qty: 55.0, cost: 70.2, type: 'PETROL' },
    { v: van3, days: 21, odo: 30400.0, qty: 52.0, cost: 66.3, type: 'PETROL' },
    { v: van3, days: 14, odo: 30800.0, qty: 54.0, cost: 68.9, type: 'PETROL' },
    { v: van3, days: 7, odo: 31000.0, qty: 50.0, cost: 63.8, type: 'PETROL' },
    { v: van3, days: 1, odo: 31250.0, qty: 53.0, cost: 67.6, type: 'PETROL' },
  ];
  for (const f of fuelSeed) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_vehicle_fuel_logs (id, vehicle_id, logged_by, log_date, odometer_reading, fuel_quantity, fuel_cost, fuel_type, refuel_location) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - ($4 || ' days')::interval, $5, $6, $7, $8, 'Shell Springfield Depot')",
      generateId(),
      f.v,
      driverEmployeeId,
      f.days,
      f.odo,
      f.qty,
      f.cost,
      f.type,
    );
  }

  // ── F. 5 driver hours logs for Linda Park ──
  console.log('  Seeding 5 driver hours logs (1 approaching weekly limit)...');
  // Pick a series of 5 days within the current ISO week so the cumulative
  // computation lands within one weekly window. duty_start_at and duty_end_at
  // anchor on UTC for simplicity. The service-layer cumulative recompute uses
  // ISO week so all 5 land in the same bucket.
  // approaching-limit row: 5th log carries duty totals that push the weekly
  // cumulative_weekly_minutes to roughly 2600 minutes — within the 90 percent
  // threshold of the 2880-minute default cap (2592).
  const hoursSeed = [
    { startOffsetH: 4 * 24 + 6, durMinutes: 540, drivingMinutes: 480, breakMinutes: 60 }, // 4 days ago, 9h shift
    { startOffsetH: 3 * 24 + 6, durMinutes: 540, drivingMinutes: 470, breakMinutes: 70 }, // 3 days ago
    { startOffsetH: 2 * 24 + 6, durMinutes: 540, drivingMinutes: 490, breakMinutes: 50 }, // 2 days ago
    { startOffsetH: 1 * 24 + 6, durMinutes: 540, drivingMinutes: 480, breakMinutes: 60 }, // 1 day ago
    { startOffsetH: 6, durMinutes: 540, drivingMinutes: 470, breakMinutes: 70 }, // today
  ];
  let cumulative = 0;
  for (const h of hoursSeed) {
    cumulative += h.drivingMinutes;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_driver_hours_logs (id, driver_id, log_date, duty_start_at, duty_end_at, driving_minutes, break_minutes, cumulative_weekly_minutes) ' +
        "VALUES ($1::uuid, $2::uuid, (now() - ($3 || ' hours')::interval)::date, now() - ($3 || ' hours')::interval, now() - ($3 || ' hours')::interval + ($4 || ' minutes')::interval, $5, $6, $7)",
      generateId(),
      driverEmployeeId,
      h.startOffsetH,
      h.durMinutes,
      h.drivingMinutes,
      h.breakMinutes,
      cumulative,
    );
  }

  // ── G. 1 driver hours limit config ──
  console.log('  Seeding 1 driver hours limit config (EU WTD defaults)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_driver_hours_limits (id, school_id, weekly_driving_limit_minutes, daily_driving_limit_minutes, mandatory_break_after_minutes, approaching_limit_threshold_pct, jurisdiction) ' +
      "VALUES ($1::uuid, $2::uuid, 2880, 600, 270, 90, 'US_FEDERAL')",
    generateId(),
    schoolId,
  );

  // ── H. 2 vehicle lifecycle records ──
  console.log('  Seeding 2 vehicle lifecycle records...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_lifecycle (id, vehicle_id, purchase_date, purchase_price, expected_life_years, expected_life_miles, depreciation_method, current_book_value, book_value_computed_at) ' +
      "VALUES ($1::uuid, $2::uuid, CURRENT_DATE - INTERVAL '5 years', 95000.00, 12, 250000, 'STRAIGHT_LINE', 55400.00, now())",
    generateId(),
    bus42,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_lifecycle (id, vehicle_id, purchase_date, purchase_price, expected_life_years, expected_life_miles, depreciation_method, current_book_value, book_value_computed_at) ' +
      "VALUES ($1::uuid, $2::uuid, CURRENT_DATE - INTERVAL '3 years', 42000.00, 8, 180000, 'DECLINING_BALANCE', 26200.00, now())",
    generateId(),
    van3,
  );

  console.log('');
  console.log('  Transportation Advanced seed complete.');
  console.log('    3 repair categories (1 safety-critical)');
  console.log('    5 repairs (3 INTERNAL, 2 EXTERNAL_VENDOR with warranty)');
  console.log('    8 parts (2 below threshold)');
  console.log('    6 vehicle components (1 approaching end of life)');
  console.log('    10 fuel logs');
  console.log('    5 driver hours logs (1 approaching weekly limit)');
  console.log('    1 driver hours limit config');
  console.log('    2 vehicle lifecycle records');
  console.log('');
}

seedTransportAdvanced()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
