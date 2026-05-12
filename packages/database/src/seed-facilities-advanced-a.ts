import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-facilities-advanced-a.ts — Phase 2 Cycle 18 sub-cycle a (P2-18a).
 *
 * M65 Facilities Advanced — cleaning routes + supply audit + work
 * order depth. Idempotent — gated on whether fac_cleaning_routes
 * already has rows for the demo school. Depends on Cycle 21 fac_*
 * tables being seeded (run seed:facilities first).
 *
 * Sections:
 *   A) 2 cleaning routes — North Wing Evening (EVENING, 6 stops) and
 *      Gymnasium AM (MORNING, 3 stops). Stops link to existing
 *      fac_spaces. cleaning_tasks TEXT[] is populated per stop.
 *   B) 2 assignments — one recurring weekday assignment + one one-off
 *      assignment for today.
 *   C) 2 completions — one COMPLETED for the recurring assignment on
 *      a recent date with 6 COMPLETED stops, one PARTIAL with 1 stop
 *      SKIPPED + 1 stop COMPLETED carrying issues_noted (drives the
 *      keystone Kafka emit demo).
 *   D) 2 zone inspections — one PASS, one FAIL with follow-up work
 *      order auto-linked.
 *   E) 10 supply transactions across 3 of the seeded inventory items
 *      (RECEIPTs + USAGEs).
 *   F) 1 COMPLETED stocktake with 8 items (2 of which have
 *      discrepancies — adjustments materialised as ADJUSTMENT
 *      fac_supply_transactions rows).
 *   G) 3 work order attachments + 4 parts on the COMPLETED REPAIR
 *      work order from the Cycle 21 seed.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedFacilitiesAdvancedA() {
  console.log('');
  console.log('  Facilities Advanced Seed (P2-18a)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.fac_cleaning_routes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  fac_cleaning_routes already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT pu.id::text AS account_id, ip.id::text AS person_id ' +
        'FROM platform.platform_users pu ' +
        'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
        'WHERE pu.email = $1 LIMIT 1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('User not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const counsellor = await findUserByEmail('counsellor@demo.campusos.dev');

  // Resolve hr_employees ids for the two custodian personas.
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, ip.first_name || $1 || ip.last_name AS name ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id',
    ' ',
  )) as Array<{ id: string; name: string }>;
  const empByName = new Map(employees.map((e) => [e.name, e.id]));
  const custodian1Id = empByName.get('Linda Park');
  const custodian2Id = empByName.get('Marcus Hayes');
  if (!custodian1Id || !custodian2Id) {
    throw new Error('Required custodian hr_employees rows missing — run seed:hr first');
  }

  // Resolve fac_spaces ids.
  const spaces = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.fac_spaces',
  )) as Array<{ id: string; name: string }>;
  if (spaces.length === 0) {
    throw new Error('No fac_spaces rows — run seed:facilities first');
  }
  const spaceByName = new Map(spaces.map((s) => [s.name, s.id]));

  // Resolve zones.
  const zones = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.fac_zones WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ id: string; name: string }>;
  const zoneByName = new Map(zones.map((z) => [z.name, z.id]));

  // Resolve fac_buildings + supply_inventory.
  const building = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".fac_buildings WHERE school_id = $1::uuid AND name = 'Main Building' LIMIT 1",
    schoolId,
  )) as Array<{ id: string }>;
  if (building.length === 0) throw new Error('Main Building missing — run seed:facilities first');
  const buildingId = building[0]!.id;

  const inventoryRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, item_name, current_quantity::float AS current_quantity ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.fac_supply_inventory WHERE building_id = $1::uuid',
    buildingId,
  )) as Array<{ id: string; item_name: string; current_quantity: number }>;
  const invByName = new Map(inventoryRows.map((r) => [r.item_name, r]));

  // Resolve a COMPLETED REPAIR work order to attach attachments + parts.
  const wo = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".fac_work_orders WHERE school_id = $1::uuid AND work_order_type = 'REPAIR' ORDER BY created_at LIMIT 1",
    schoolId,
  )) as Array<{ id: string }>;
  const completedWorkOrderId = wo[0]?.id ?? null;

  // ── Section A: 2 cleaning routes + stops ──
  const route1Id = generateId();
  const route2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_routes (id, school_id, name, shift, zone_id, estimated_duration_minutes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)',
    route1Id,
    schoolId,
    'North Wing Evening',
    'EVENING',
    zoneByName.get('Zone A — North Wing') ?? null,
    120,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_routes (id, school_id, name, shift, zone_id, estimated_duration_minutes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)',
    route2Id,
    schoolId,
    'Gymnasium AM',
    'MORNING',
    zoneByName.get('Zone B — Upper Floors') ?? null,
    60,
  );

  const route1StopNames = ['Room 101', 'Room 102', 'Room 103', 'Room 104', 'Corridor 1F', 'Office'];
  const route2StopNames = ['Gymnasium', 'Locker Rooms', 'Corridor 2F'];

  const route1Stops: Array<{ id: string; name: string }> = [];
  let stopOrder = 1;
  for (const name of route1StopNames) {
    const sid = spaceByName.get(name);
    if (!sid) continue;
    const stopId = generateId();
    route1Stops.push({ id: stopId, name });
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stops (id, route_id, space_id, stop_order, estimated_minutes, cleaning_tasks) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])',
      stopId,
      route1Id,
      sid,
      stopOrder,
      20,
      ['Sweep', 'Mop', 'Trash', 'Wipe surfaces'],
    );
    stopOrder += 1;
  }

  stopOrder = 1;
  for (const name of route2StopNames) {
    const sid = spaceByName.get(name);
    if (!sid) continue;
    const stopId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stops (id, route_id, space_id, stop_order, estimated_minutes, cleaning_tasks) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])',
      stopId,
      route2Id,
      sid,
      stopOrder,
      20,
      ['Sweep', 'Mop', 'Sanitize equipment'],
    );
    stopOrder += 1;
  }

  // ── Section B: 2 assignments — 1 recurring + 1 one-off ──
  const recurringAssignmentId = generateId();
  const oneOffAssignmentId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_route_assignments (id, route_id, employee_id, is_recurring, recurrence_days, effective_from, assigned_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, true, $4::smallint[], $5::date, $6::uuid, $7)',
    recurringAssignmentId,
    route1Id,
    custodian1Id,
    [1, 2, 3, 4, 5],
    '2026-05-01',
    principal.personId,
    'Weekday evening route',
  );
  const todayIso = new Date().toISOString().slice(0, 10);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_route_assignments (id, route_id, employee_id, is_recurring, assignment_date, assigned_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, false, $4::date, $5::uuid, $6)',
    oneOffAssignmentId,
    route2Id,
    custodian2Id,
    todayIso,
    principal.personId,
    'Special event cleanup',
  );

  // ── Section C: 2 completions ──
  // C1 — COMPLETED run yesterday on Route 1, all 6 stops COMPLETED.
  const completion1Id = generateId();
  const yesterdayIso = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_route_completions (id, route_id, assignment_id, employee_id, completion_date, started_at, completed_at, overall_status) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::timestamptz, $7::timestamptz, $8)',
    completion1Id,
    route1Id,
    recurringAssignmentId,
    custodian1Id,
    yesterdayIso,
    yesterdayIso + 'T17:00:00Z',
    yesterdayIso + 'T19:00:00Z',
    'COMPLETED',
  );
  for (const stop of route1Stops) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stop_completions (id, completion_id, stop_id, status, completed_at, tasks_completed) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLETED', $4::timestamptz, $5::text[])",
      generateId(),
      completion1Id,
      stop.id,
      yesterdayIso + 'T17:30:00Z',
      ['Sweep', 'Mop', 'Trash', 'Wipe surfaces'],
    );
  }

  // C2 — PARTIAL run today on Route 2, 1 COMPLETED + 1 SKIPPED + 1
  // COMPLETED with issues_noted (drives the keystone Kafka path demo).
  const completion2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_cleaning_route_completions (id, route_id, assignment_id, employee_id, completion_date, started_at, completed_at, overall_status) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::timestamptz, $7::timestamptz, $8)',
    completion2Id,
    route2Id,
    oneOffAssignmentId,
    custodian2Id,
    todayIso,
    todayIso + 'T07:00:00Z',
    todayIso + 'T08:30:00Z',
    'PARTIAL',
  );
  // Gymnasium stop — completed with issue noted.
  const route2StopIds = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, space_id::text AS space_id, stop_order FROM ' +
      TENANT_SCHEMA +
      '.fac_cleaning_route_stops WHERE route_id = $1::uuid ORDER BY stop_order',
    route2Id,
  )) as Array<{ id: string; space_id: string; stop_order: number }>;
  if (route2StopIds.length >= 3) {
    // Stop 1: COMPLETED with issue
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stop_completions (id, completion_id, stop_id, status, completed_at, tasks_completed, issues_noted) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLETED', $4::timestamptz, $5::text[], $6)",
      generateId(),
      completion2Id,
      route2StopIds[0]!.id,
      todayIso + 'T07:30:00Z',
      ['Sweep', 'Mop'],
      'Broken soap dispenser in mens room.',
    );
    // Stop 2: SKIPPED with reason
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stop_completions (id, completion_id, stop_id, status, completed_at, skip_reason) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'SKIPPED', $4::timestamptz, $5)",
      generateId(),
      completion2Id,
      route2StopIds[1]!.id,
      todayIso + 'T08:00:00Z',
      'Locker rooms in use by phys-ed class.',
    );
    // Stop 3: COMPLETED
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_cleaning_route_stop_completions (id, completion_id, stop_id, status, completed_at, tasks_completed) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLETED', $4::timestamptz, $5::text[])",
      generateId(),
      completion2Id,
      route2StopIds[2]!.id,
      todayIso + 'T08:25:00Z',
      ['Sweep', 'Mop', 'Sanitize equipment'],
    );
  }

  // ── Section D: 2 zone inspections — 1 PASS, 1 FAIL with follow-up WO ──
  const zoneAId = zoneByName.get('Zone A — North Wing') ?? null;
  const zoneBId = zoneByName.get('Zone B — Upper Floors') ?? null;
  if (zoneAId) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_zone_inspections (id, zone_id, inspector_id, inspection_date, overall_rating, notes, follow_up_required) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 'PASS', $5, false)",
      generateId(),
      zoneAId,
      principal.personId,
      yesterdayIso,
      'Floors clean. All bathrooms stocked. Trash empty.',
    );
  }
  if (zoneBId) {
    // FAIL — create follow-up work order first then link.
    const followUpWoId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_work_orders (id, school_id, work_order_type, priority, status, description, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'DEEP_CLEAN', 'HIGH', 'OPEN', $3, $4::uuid)",
      followUpWoId,
      schoolId,
      'Auto-created from FAILED zone inspection on Zone B — Upper Floors. Notes: Multiple bathrooms not cleaned. Trash overflowing. Reorder triggered.',
      principal.personId,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_zone_inspections (id, zone_id, inspector_id, inspection_date, overall_rating, notes, follow_up_required, follow_up_work_order_id) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 'FAIL', $5, true, $6::uuid)",
      generateId(),
      zoneBId,
      principal.personId,
      yesterdayIso,
      'Multiple bathrooms not cleaned. Trash overflowing. Reorder triggered.',
      followUpWoId,
    );
  }

  // ── Section E: 10 supply transactions ──
  const supplyItemNames = ['Floor cleaner', 'Paper towels', 'Trash bags'];
  let txCount = 0;
  for (const name of supplyItemNames) {
    const inv = invByName.get(name);
    if (!inv) continue;
    // Receipt 1 week ago
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_transactions (id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, transaction_at, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'RECEIPT', $4, $5::uuid, now() - interval '7 days', $6)",
      generateId(),
      buildingId,
      inv.id,
      10,
      principal.personId,
      'Weekly resupply',
    );
    txCount += 1;
    // USAGE 4 days ago
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_transactions (id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, transaction_at, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'USAGE', $4, $5::uuid, now() - interval '4 days', $6)",
      generateId(),
      buildingId,
      inv.id,
      -3,
      counsellor.personId,
      'North Wing rounds',
    );
    txCount += 1;
    // USAGE 2 days ago
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_transactions (id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, transaction_at, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'USAGE', $4, $5::uuid, now() - interval '2 days', $6)",
      generateId(),
      buildingId,
      inv.id,
      -2,
      counsellor.personId,
      'Refill rounds',
    );
    txCount += 1;
  }
  // 10th transaction: a WRITE_OFF on Floor cleaner.
  const fc = invByName.get('Floor cleaner');
  if (fc) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_transactions (id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, transaction_at, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'WRITE_OFF', $4, $5::uuid, now() - interval '1 day', $6)",
      generateId(),
      buildingId,
      fc.id,
      -1,
      principal.personId,
      'Spilled bottle, written off',
    );
    txCount += 1;
  }

  // ── Section F: 1 COMPLETED stocktake with 8 items (2 discrepancies) ──
  const stocktakeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_supply_stocktakes (id, school_id, building_id, conducted_by, stocktake_date, status, completed_at, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 'COMPLETED', now() - interval '3 hours', $6)",
    stocktakeId,
    schoolId,
    buildingId,
    principal.personId,
    yesterdayIso,
    'Quarterly supply audit',
  );

  // Stocktake items — match against inventoryRows. Most match expected,
  // 2 have discrepancies (which the seeded ADJUSTMENT transactions
  // model below). The actual_quantity columns reflect post-adjustment
  // state.
  const stocktakeItemsPlan: Array<{ name: string; expected: number; actual: number }> = [];
  for (const inv of inventoryRows.slice(0, 8)) {
    let actual = inv.current_quantity;
    let expected = inv.current_quantity;
    // Plant 2 discrepancies on the first 2 items.
    if (stocktakeItemsPlan.length === 0) {
      expected = inv.current_quantity + 2; // counted 2 short
    } else if (stocktakeItemsPlan.length === 1) {
      expected = Math.max(0, inv.current_quantity - 1); // counted 1 over
    }
    stocktakeItemsPlan.push({ name: inv.item_name, expected, actual });
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_stocktake_items (id, stocktake_id, inventory_id, expected_quantity, actual_quantity, discrepancy_notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
      generateId(),
      stocktakeId,
      inv.id,
      expected,
      actual,
      expected !== actual ? 'Audit discrepancy — adjusted post-completion' : null,
    );
  }

  // ADJUSTMENT transactions for the 2 discrepancies — matches what
  // SupplyAuditService.completeStocktake would write at runtime.
  for (let i = 0; i < 2; i++) {
    const plan = stocktakeItemsPlan[i];
    if (!plan || plan.expected === plan.actual) continue;
    const inv = invByName.get(plan.name);
    if (!inv) continue;
    const delta = plan.actual - plan.expected;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_transactions (id, building_id, inventory_id, transaction_type, quantity_delta, performed_by, transaction_at, reference_id, notes) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ADJUSTMENT', $4, $5::uuid, now() - interval '3 hours', $6::uuid, $7)",
      generateId(),
      buildingId,
      inv.id,
      delta,
      principal.personId,
      stocktakeId,
      'Stocktake adjustment delta ' + delta,
    );
    txCount += 1;
  }

  // ── Section G: 3 work order attachments + 4 parts ──
  if (completedWorkOrderId) {
    const attachments = [
      { type: 'PHOTO_BEFORE', filename: 'pipe-leak-before.jpg', s3_key: 's3://demo/wo/before.jpg' },
      { type: 'PHOTO_AFTER', filename: 'pipe-leak-after.jpg', s3_key: 's3://demo/wo/after.jpg' },
      { type: 'INVOICE', filename: 'plumbing-invoice.pdf', s3_key: 's3://demo/wo/invoice.pdf' },
    ];
    for (const a of attachments) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fac_work_order_attachments (id, work_order_id, s3_key, filename, attachment_type, file_size_bytes, uploaded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)',
        generateId(),
        completedWorkOrderId,
        a.s3_key,
        a.filename,
        a.type,
        a.type === 'INVOICE' ? 85_000 : 240_000,
        principal.personId,
      );
    }

    const parts = [
      { name: '1/2 inch copper pipe', qty: 3, unit: 'ft', unit_cost: 4.5 },
      { name: 'Pipe coupling', qty: 4, unit: 'EA', unit_cost: 2.75 },
      { name: 'Plumber putty', qty: 1, unit: 'tube', unit_cost: 6.25 },
      { name: 'Pipe sealant', qty: 1, unit: 'bottle', unit_cost: 9.0 },
    ];
    for (const p of parts) {
      const totalCost = Number((p.qty * p.unit_cost).toFixed(2));
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fac_work_order_parts (id, work_order_id, part_name, quantity, unit, unit_cost, total_cost, supplier) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)',
        generateId(),
        completedWorkOrderId,
        p.name,
        p.qty,
        p.unit,
        p.unit_cost,
        totalCost,
        'Acme Plumbing Supply',
      );
    }
  }

  console.log('  Seeded 2 cleaning routes + 9 stops + 2 assignments (1 recurring + 1 one-off)');
  console.log(
    '  Seeded 2 completions (1 COMPLETED with 6 stops + 1 PARTIAL with 1 SKIPPED + 1 issue)',
  );
  console.log('  Seeded 2 zone inspections (1 PASS + 1 FAIL with auto-linked follow-up WO)');
  console.log(
    '  Seeded ' +
      txCount +
      ' supply transactions + 1 COMPLETED stocktake with 8 items (2 discrepancies)',
  );
  console.log('  Seeded 3 work order attachments + 4 parts on the seeded REPAIR work order');
}

async function main() {
  try {
    await seedFacilitiesAdvancedA();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('Facilities Advanced (P2-18a) seed failed:', err);
  process.exit(1);
});
