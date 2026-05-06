import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-facilities.ts — Cycle 21 Step 4.
 *
 * M65 Facilities Management. Idempotent — gated on whether
 * fac_buildings already has rows for the demo school.
 *
 * Sections:
 *   A) 1 building "Main Building" (3 floors, 2005) + 12 spaces with
 *      sch_room_id cross-links on the 6 classroom spaces (joined to
 *      Cycle 5 sch_rooms by name).
 *   B) 2 space bookings (gym + cafeteria) CONFIRMED far enough in
 *      the future that the EXCLUDE gist accepts them.
 *   C) 1 indefinite space closure on Room 101 for pipe repair —
 *      linked to the seeded REPAIR work order in section D.
 *   D) 2 work orders + 3 activity rows: REPAIR pipe leak HIGH
 *      COMPLETED with full timeline; INSTALLATION whiteboard MEDIUM
 *      OPEN.
 *   E) 1 PM plan + 6 checklist items + 1 task last month + 6
 *      results (5 PASS + 1 FAIL); the FAIL is linked to a follow-up
 *      work order to mirror the Step 6 service behaviour.
 *   F) 2 inspection types + 1 fire inspection PASSED_WITH_CONDITIONS
 *      + 1 MAJOR violation due in 30 days.
 *   G) 2 zones + 2 zone assignments (Martinez Zone A MORNING, second
 *      custodian Zone B AFTERNOON).
 *   H) 5 supply items, with floor cleaner deliberately below the
 *      reorder threshold so the smoke + CAT can drive the
 *      fac.supply.reorder_needed emit on a quantity adjustment.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedFacilities() {
  console.log('');
  console.log('  Facilities Seed (Cycle 21 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.fac_buildings WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  fac_buildings already populated for demo school. Skipping.');
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
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const vp = await findUserByEmail('vp@demo.campusos.dev');

  // Resolve hr_employees.id for the staff personas (Cycle 4 bridge).
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, ip.first_name || $1 || ip.last_name AS name ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id',
    ' ',
  )) as Array<{ id: string; name: string }>;
  const empByName = new Map(employees.map((e) => [e.name, e.id]));
  const martinezId = empByName.get('Linda Park'); // Park stands in for the FM persona
  const secondCustodianId = empByName.get('Marcus Hayes'); // Hayes stands in for the second custodian

  // Resolve sch_rooms by name so we can populate fac_spaces.sch_room_id
  // for the 6 classroom spaces.
  const rooms = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.sch_rooms ORDER BY name',
  )) as Array<{ id: string; name: string }>;
  const roomByName = new Map(rooms.map((r) => [r.name, r.id]));

  // ── Section A: building + spaces ──
  const buildingId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_buildings (id, school_id, name, code, year_built, total_floors, address) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
    buildingId,
    schoolId,
    'Main Building',
    'MB',
    2005,
    3,
    '100 School Lane, Springfield, IL 62701',
  );

  // 12 spaces: 6 classrooms (with sch_room cross-link), gym, cafeteria, 2 corridors,
  // office, storage room.
  const spaces: Array<{
    id: string;
    name: string;
    floor: string;
    space_type: string;
    area_sqft: number | null;
    sch_room_id: string | null;
  }> = [
    {
      id: generateId(),
      name: 'Room 101',
      floor: '1',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 101') ?? null,
    },
    {
      id: generateId(),
      name: 'Room 102',
      floor: '1',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 102') ?? null,
    },
    {
      id: generateId(),
      name: 'Room 103',
      floor: '1',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 103') ?? null,
    },
    {
      id: generateId(),
      name: 'Room 104',
      floor: '2',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 104') ?? null,
    },
    {
      id: generateId(),
      name: 'Room 105',
      floor: '2',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 105') ?? null,
    },
    {
      id: generateId(),
      name: 'Room 106',
      floor: '2',
      space_type: 'CLASSROOM',
      area_sqft: 720,
      sch_room_id: roomByName.get('Room 106') ?? null,
    },
    {
      id: generateId(),
      name: 'Gymnasium',
      floor: '1',
      space_type: 'GYM',
      area_sqft: 4800,
      sch_room_id: roomByName.get('Gymnasium') ?? null,
    },
    {
      id: generateId(),
      name: 'Cafeteria',
      floor: '1',
      space_type: 'CAFETERIA',
      area_sqft: 2400,
      sch_room_id: null,
    },
    {
      id: generateId(),
      name: 'Ground Floor Corridor',
      floor: '1',
      space_type: 'CORRIDOR',
      area_sqft: 600,
      sch_room_id: null,
    },
    {
      id: generateId(),
      name: 'Upper Floor Corridor',
      floor: '2',
      space_type: 'CORRIDOR',
      area_sqft: 600,
      sch_room_id: null,
    },
    {
      id: generateId(),
      name: 'Main Office',
      floor: '1',
      space_type: 'OFFICE',
      area_sqft: 320,
      sch_room_id: null,
    },
    {
      id: generateId(),
      name: 'Janitor Storage',
      floor: '1',
      space_type: 'STORAGE',
      area_sqft: 120,
      sch_room_id: null,
    },
  ];

  for (const sp of spaces) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_spaces (id, building_id, name, floor, space_type, area_sqft, sch_room_id) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)',
      sp.id,
      buildingId,
      sp.name,
      sp.floor,
      sp.space_type,
      sp.area_sqft,
      sp.sch_room_id,
    );
  }

  const room101Id = spaces.find((s) => s.name === 'Room 101')!.id;
  const room102Id = spaces.find((s) => s.name === 'Room 102')!.id;
  const gymId = spaces.find((s) => s.name === 'Gymnasium')!.id;
  const cafeteriaId = spaces.find((s) => s.name === 'Cafeteria')!.id;

  // ── Section B: 2 space bookings (future-dated to avoid EXCLUDE conflicts) ──
  const bookingIds = { gym: generateId(), caf: generateId() };
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_space_bookings (id, space_id, booked_by, title, starts_at, ends_at, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-09-15 14:00:00+00'::timestamptz, '2026-09-15 15:00:00+00'::timestamptz, 'CONFIRMED', $5)",
    bookingIds.gym,
    gymId,
    teacher.personId,
    'Grade 5 Assembly',
    'Per the Cycle 21 vertical slice deliverable',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_space_bookings (id, space_id, booked_by, title, starts_at, ends_at, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '2026-09-20 18:00:00+00'::timestamptz, '2026-09-20 20:00:00+00'::timestamptz, 'CONFIRMED', $5)",
    bookingIds.caf,
    cafeteriaId,
    principal.personId,
    'PTC Welcome Event',
    'Parent-Teacher Conference reception',
  );

  // ── Section D: 2 work orders (placed before C so the closure can link to it) ──
  const woRepairId = generateId();
  const woInstallId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_work_orders (id, school_id, work_order_type, priority, space_id, building_id, assigned_to_id, status, completed_at, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'REPAIR', 'HIGH', $3::uuid, $4::uuid, $5::uuid, 'COMPLETED', now() - interval '2 days', $6, $7::uuid)",
    woRepairId,
    schoolId,
    room101Id,
    buildingId,
    martinezId,
    'Pipe leak under sink — replaced fittings + cleaned up water damage',
    principal.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_work_orders (id, school_id, work_order_type, priority, space_id, building_id, status, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'INSTALLATION', 'MEDIUM', $3::uuid, $4::uuid, 'OPEN', $5, $6::uuid)",
    woInstallId,
    schoolId,
    room102Id,
    buildingId,
    'Install replacement classroom whiteboard',
    principal.personId,
  );

  // 3 activity rows on the COMPLETED repair work order
  const activities: Array<{
    actorId: string;
    activity_type: string;
    metadata: object;
    offsetHours: number;
  }> = [
    {
      actorId: martinezId!,
      activity_type: 'STATUS_CHANGE',
      metadata: { from: 'OPEN', to: 'IN_PROGRESS' },
      offsetHours: 48,
    },
    {
      actorId: martinezId!,
      activity_type: 'COMMENT',
      metadata: { body: 'Replaced fittings under the sink. Drying out the floor now.' },
      offsetHours: 36,
    },
    {
      actorId: martinezId!,
      activity_type: 'STATUS_CHANGE',
      metadata: { from: 'IN_PROGRESS', to: 'COMPLETED' },
      offsetHours: 24,
    },
  ];
  for (const a of activities) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_work_order_activity (id, work_order_id, actor_id, activity_type, metadata, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, now() - ($6 || ' hours')::interval)",
      generateId(),
      woRepairId,
      a.actorId,
      a.activity_type,
      JSON.stringify(a.metadata),
      a.offsetHours.toString(),
    );
  }

  // ── Section C: 1 closure on Room 101 linked to the repair WO ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_space_closures (id, school_id, space_id, closure_reason, starts_at, ends_at, affects_scheduling, linked_work_order_id, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() - interval '3 days', NULL, true, $5::uuid, $6::uuid)",
    generateId(),
    schoolId,
    room101Id,
    'Pipe leak repair — water damage cleanup',
    woRepairId,
    principal.personId,
  );

  // ── Section E: 1 PM plan + 6 items + 1 task + 6 results ──
  const planId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_preventive_maintenance_plans (id, school_id, name, description, frequency_months, target_type, target_id, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 1, 'BUILDING', $5::uuid, $6::uuid)",
    planId,
    schoolId,
    'Monthly HVAC Inspection',
    'Standard 6-point check on the HVAC system: filters, belts, thermostat, ductwork, refrigerant, and drainage.',
    buildingId,
    principal.personId,
  );

  const items = [
    'Air filters inspected and replaced if needed',
    'Belts inspected for wear',
    'Thermostat calibration verified',
    'Ductwork inspected for leaks',
    'Refrigerant levels checked',
    'Condensate drainage cleared',
  ];
  const itemIds: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const id = generateId();
    itemIds.push(id);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_preventive_maintenance_checklist_items (id, plan_id, item_name, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4)',
      id,
      planId,
      items[i],
      i + 1,
    );
  }

  const taskId = generateId();
  // Last month task: COMPLETED
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_preventive_maintenance_tasks (id, plan_id, scheduled_date, assigned_to, status, completed_at, completed_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, (CURRENT_DATE - interval '1 month')::date, $3::uuid, 'COMPLETED', now() - interval '20 days', $4::uuid, $5)",
    taskId,
    planId,
    martinezId,
    martinezId,
    'Routine inspection — 1 belt found worn; follow-up work order opened',
  );

  // 5 PASS + 1 FAIL — the belts (item index 1) failed
  const followupWoId = generateId();
  for (let i = 0; i < itemIds.length; i++) {
    const passed = i !== 1; // index 1 = belts -> FAIL
    if (i === 1) {
      // Insert the follow-up work order first so the FK on
      // fac_maintenance_checklist_results.follow_up_work_order_id resolves.
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fac_work_orders (id, school_id, work_order_type, priority, building_id, assigned_to_id, status, description, created_by, scheduled_date) ' +
          "VALUES ($1::uuid, $2::uuid, 'REPAIR', 'MEDIUM', $3::uuid, $4::uuid, 'OPEN', $5, $6::uuid, (CURRENT_DATE + interval '3 days')::date)",
        followupWoId,
        schoolId,
        buildingId,
        martinezId,
        'HVAC belt replacement — flagged by Monthly HVAC Inspection PM checklist (worn)',
        principal.personId,
      );
    }
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_maintenance_checklist_results (id, task_id, checklist_item_id, passed, notes, follow_up_work_order_id, submitted_by, submitted_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, now() - interval '20 days')",
      generateId(),
      taskId,
      itemIds[i],
      passed,
      passed ? null : 'Belt visibly worn — follow-up work order opened',
      passed ? null : followupWoId,
      martinezId,
    );
  }

  // ── Section F: 2 inspection types + 1 inspection + 1 violation ──
  const fireTypeId = generateId();
  const elevatorTypeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_inspection_types (id, school_id, name, authority, frequency_months, is_mandatory, failure_escalation_days) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 12, true, 30)',
    fireTypeId,
    schoolId,
    'Annual Fire Inspection',
    'County Fire Marshal',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_inspection_types (id, school_id, name, authority, frequency_months, is_mandatory, failure_escalation_days) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 12, true, 60)',
    elevatorTypeId,
    schoolId,
    'Elevator Certification',
    'State Elevator Board',
  );

  const fireInspId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_inspections (id, school_id, inspection_type_id, building_id, scheduled_date, conducted_date, inspector_name, inspector_agency, outcome, next_due_date, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, (CURRENT_DATE - interval '14 days')::date, (CURRENT_DATE - interval '14 days')::date, $5, $6, 'PASSED_WITH_CONDITIONS', (CURRENT_DATE + interval '11 months')::date, $7, $8::uuid)",
    fireInspId,
    schoolId,
    fireTypeId,
    buildingId,
    'Captain Davis',
    'Springfield Fire Department',
    'Building generally compliant. Emergency exit signage requires replacement on the ground floor corridor.',
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_inspection_violations (id, inspection_id, description, severity, due_date) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'MAJOR', (CURRENT_DATE + interval '16 days')::date)",
    generateId(),
    fireInspId,
    'Emergency exit signage in Ground Floor Corridor is faded and partially illegible. Replace per NFPA 101.',
  );

  // ── Section G: 2 zones + 2 assignments ──
  const zoneAId = generateId();
  const zoneBId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_zones (id, school_id, name, description, color) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
    zoneAId,
    schoolId,
    'Zone A: Ground Floor',
    'Main Building ground floor — classrooms 101-103, cafeteria, gym, ground corridor',
    '#3d7ab5',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_zones (id, school_id, name, description, color) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
    zoneBId,
    schoolId,
    'Zone B: Upper Floors',
    'Main Building floors 2-3 — classrooms 104-106, upper corridor, office',
    '#28a745',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_zone_assignments (id, zone_id, employee_id, effective_from, shift, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, (CURRENT_DATE - interval '60 days')::date, 'MORNING', $4::uuid)",
    generateId(),
    zoneAId,
    martinezId,
    principal.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_zone_assignments (id, zone_id, employee_id, effective_from, shift, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, (CURRENT_DATE - interval '60 days')::date, 'AFTERNOON', $4::uuid)",
    generateId(),
    zoneBId,
    secondCustodianId,
    principal.personId,
  );

  // ── Section H: 5 supply items ──
  const supplies: Array<{ item_name: string; unit: string; qty: number; threshold: number }> = [
    { item_name: 'Floor cleaner', unit: 'L', qty: 3, threshold: 5 }, // BELOW threshold (drives reorder)
    { item_name: 'Paper towels', unit: 'roll', qty: 12, threshold: 10 },
    { item_name: 'Trash bags', unit: 'box', qty: 20, threshold: 15 },
    { item_name: 'Glass cleaner', unit: 'L', qty: 8, threshold: 5 },
    { item_name: 'Mop heads', unit: 'unit', qty: 4, threshold: 3 },
  ];
  for (const s of supplies) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_supply_inventory (id, building_id, item_name, unit, current_quantity, reorder_threshold, preferred_supplier) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
      generateId(),
      buildingId,
      s.item_name,
      s.unit,
      s.qty,
      s.threshold,
      'Springfield Cleaning Supply Co',
    );
  }

  // Suppress unused vp variable warning by referencing it in a noop log
  void vp;

  console.log('  Seeded 1 building + 12 spaces + 2 bookings + 1 closure');
  console.log(
    '  Seeded 2 work orders + 3 activity rows + 1 PM plan + 6 items + 1 task + 6 results (5 PASS + 1 FAIL → follow-up WO)',
  );
  console.log(
    '  Seeded 2 inspection types + 1 fire inspection PASSED_WITH_CONDITIONS + 1 MAJOR violation',
  );
  console.log('  Seeded 2 zones + 2 assignments + 5 supply items (1 below reorder threshold)');
}

async function main() {
  try {
    await seedFacilities();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('Facilities seed failed:', err);
  process.exit(1);
});
