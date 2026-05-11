import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-transport-advanced-b.ts — P2-11b Step 4 (Phase 2 Cycle 11 sub-cycle b).
 *
 * M61 Transportation Advanced — Route Generation Pipeline plus Ad-Hoc
 * Trips plus Contracted Routes.
 *
 * Idempotent — gated on whether trn_route_constraints already has rows
 * for the demo school. Re-runs are no-ops.
 *
 * Sections:
 *   A) 1 constraint profile ("2026 Standard").
 *   B) 1 generation request (COMPLETED with 3 candidates, 20 students
 *      covered, 2 uncovered).
 *   C) 3 candidates (1 APPROVED — flipped to a live trn_routes row,
 *      1 REJECTED, 1 PENDING).
 *   D) 12 candidate stops distributed across the 3 candidates.
 *   E) 1 ad-hoc trip (SCHEDULED, athletic event).
 *   F) 1 contracted route.
 *   G) 2 route change requests (1 APPROVED with override, 1 PENDING).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedTransportAdvancedB() {
  console.log('');
  console.log('  Transportation Advanced Seed B (P2-11b Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.trn_route_constraints WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  trn_route_constraints already populated for demo school. Skipping.');
    return;
  }

  // ── Resolve fixtures ──
  async function findUserByEmail(email: string): Promise<{
    accountId: string;
    personId: string;
  }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const parkVp = await findUserByEmail('vp@demo.campusos.dev');
  const parent = await findUserByEmail('parent@demo.campusos.dev');

  // Look up driver (Linda Park) hr_employee id
  const driverRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
    parkVp.personId,
  )) as Array<{ id: string }>;
  if (driverRows.length === 0) {
    throw new Error("Linda Park's hr_employees row not found — run seed:hr first");
  }
  const driverEmployeeId = driverRows[0]!.id;

  // Look up Bus #42
  const vehicleRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.trn_vehicles WHERE registration = $1 LIMIT 1',
    'BUS-42',
  )) as Array<{ id: string }>;
  if (vehicleRows.length === 0) {
    throw new Error('trn_vehicles BUS-42 not found — run seed:transport first');
  }
  const bus42 = vehicleRows[0]!.id;

  // Look up Route 7 (an existing trn_routes row) for the contracted route fixture
  const routeRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.trn_routes WHERE name = $1 LIMIT 1',
    'Route 7 — Elm Street AM',
  )) as Array<{ id: string }>;
  if (routeRows.length === 0) {
    throw new Error('Route 7 not found — run seed:transport first');
  }
  const route7Id = routeRows[0]!.id;

  // Resolve the academic year referenced by Route 7
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT academic_year_id::text AS id FROM ' + TENANT_SCHEMA + '.trn_routes WHERE id = $1::uuid',
    route7Id,
  )) as Array<{ id: string | null }>;
  const academicYearId = yearRows[0]?.id ?? null;

  // Resolve Maya Chen's sis_students id (for the route change request)
  const mayaRows = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'WHERE ps.person_id = (SELECT id FROM platform.iam_person WHERE first_name = $1 AND last_name = $2 LIMIT 1) ' +
      'LIMIT 1',
    'Maya',
    'Chen',
  )) as Array<{ id: string }>;
  if (mayaRows.length === 0) {
    throw new Error("Maya Chen's sis_students row not found — run seed:sis first");
  }
  const mayaStudentId = mayaRows[0]!.id;

  // ── A. Constraint profile ──
  console.log('  Seeding 1 constraint profile ("2026 Standard")...');
  const constraintId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_route_constraints (id, school_id, constraint_name, max_ride_time_minutes, max_route_mileage, max_students_per_vehicle, required_arrival_buffer_minutes, max_stops_per_route, walkable_radius_metres, notes, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, 45, 35.0, 48, 10, 12, 400, $4, $5::uuid)',
    constraintId,
    schoolId,
    '2026 Standard',
    'Default constraint profile for the 2026 academic year. 45-minute ride time cap and 400m walkable radius match the state regulations.',
    mitchell.accountId,
  );

  // ── B. Generation request ──
  console.log('  Seeding 1 COMPLETED generation request...');
  const generationRequestId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_generation_requests (id, school_id, requested_by, request_type, academic_year_id, constraint_id, directions, status, optimiser_run_id, routes_generated, students_covered, students_uncovered, queued_at, started_at, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FULL_YEAR', $4::uuid, $5::uuid, 'BOTH', 'COMPLETED', $6, 3, 20, 2, now() - INTERVAL '7 days', now() - INTERVAL '7 days', now() - INTERVAL '7 days' + INTERVAL '23 minutes')",
    generationRequestId,
    schoolId,
    mitchell.accountId,
    academicYearId,
    constraintId,
    'sched-solver-job-019e0e88',
  );

  // ── C + D. Candidates and candidate stops ──
  console.log('  Seeding 3 candidates and 12 candidate stops...');

  // Candidate 1: APPROVED — also creates a live trn_routes row
  const candidate1Id = generateId();
  const approvedRouteId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_routes (id, school_id, name, description, direction, vehicle_id, driver_id, status, academic_year_id, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'AM', $5::uuid, $6::uuid, 'ACTIVE', $7::uuid, $8::uuid)",
    approvedRouteId,
    schoolId,
    'Route 9 — Maple Heights AM (Generated)',
    'Approved from generation candidate by Sarah Mitchell.',
    bus42,
    driverEmployeeId,
    academicYearId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_generation_candidates (id, request_id, candidate_name, direction, vehicle_type_required, total_students, total_stops, estimated_route_mileage, estimated_duration_minutes, max_student_ride_time_minutes, all_constraints_satisfied, review_status, reviewed_by, reviewed_at, review_notes, approved_route_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'AM', 'BUS', 12, 5, 18.4, 38, 32, true, 'APPROVED', $4::uuid, now() - INTERVAL '5 days', $5, $6::uuid)",
    candidate1Id,
    generationRequestId,
    'Maple Heights AM',
    mitchell.accountId,
    'Within all constraints. Bus #42 assigned, Linda Park driver.',
    approvedRouteId,
  );

  // Candidate 1 stops — 5 stops
  const stops1 = [
    {
      name: 'Maple Heights Plaza',
      addr: '100 Maple Ave',
      lat: 39.7817,
      lng: -89.6501,
      seq: 1,
      time: '07:15',
      students: 3,
    },
    {
      name: 'Oakhurst Elementary',
      addr: '212 Oak Crest Dr',
      lat: 39.7825,
      lng: -89.6488,
      seq: 2,
      time: '07:20',
      students: 2,
    },
    {
      name: 'Riverside Apartments',
      addr: '345 River Rd',
      lat: 39.7842,
      lng: -89.647,
      seq: 3,
      time: '07:25',
      students: 3,
    },
    {
      name: 'Civic Center Park',
      addr: '500 Park Way',
      lat: 39.7858,
      lng: -89.6452,
      seq: 4,
      time: '07:30',
      students: 2,
    },
    {
      name: 'Lincoln Academy',
      addr: '1200 School Dr',
      lat: 39.788,
      lng: -89.642,
      seq: 5,
      time: '07:45',
      students: 2,
    },
  ];
  for (const s of stops1) {
    const studentIds = Array.from({ length: s.students }, () => generateId());
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_generation_candidate_stops (id, candidate_id, stop_name, address, latitude, longitude, sequence_order, scheduled_time, student_ids, student_count) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::time, $9::uuid[], $10::int)',
      generateId(),
      candidate1Id,
      s.name,
      s.addr,
      s.lat,
      s.lng,
      s.seq,
      s.time,
      studentIds,
      s.students,
    );
  }

  // Candidate 2: REJECTED — violates max-stops constraint
  const candidate2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_generation_candidates (id, request_id, candidate_name, direction, vehicle_type_required, total_students, total_stops, estimated_route_mileage, estimated_duration_minutes, max_student_ride_time_minutes, all_constraints_satisfied, constraint_violations, review_status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'AM', 'BUS', 6, 4, 22.1, 52, 48, false, $4::jsonb, 'REJECTED', $5::uuid, now() - INTERVAL '4 days', $6)",
    candidate2Id,
    generationRequestId,
    'Riverside Long Loop AM',
    JSON.stringify({
      violations: [
        {
          rule: 'max_ride_time_minutes',
          configuredValue: 45,
          observedValue: 48,
          severity: 'WARNING',
        },
      ],
    }),
    mitchell.accountId,
    'Ride time exceeds 45-minute cap. Re-plan with smaller catchment.',
  );

  const stops2 = [
    {
      name: 'River Bend Crossing',
      addr: '800 River Ln',
      lat: 39.771,
      lng: -89.6612,
      seq: 1,
      time: '06:55',
      students: 2,
    },
    {
      name: 'East Riverside Park',
      addr: '950 East Park Rd',
      lat: 39.7702,
      lng: -89.658,
      seq: 2,
      time: '07:05',
      students: 1,
    },
    {
      name: 'Hillview Court',
      addr: '1010 Hillview Ct',
      lat: 39.7692,
      lng: -89.6543,
      seq: 3,
      time: '07:15',
      students: 2,
    },
    {
      name: 'Lincoln Academy',
      addr: '1200 School Dr',
      lat: 39.788,
      lng: -89.642,
      seq: 4,
      time: '07:47',
      students: 1,
    },
  ];
  for (const s of stops2) {
    const studentIds = Array.from({ length: s.students }, () => generateId());
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_generation_candidate_stops (id, candidate_id, stop_name, address, latitude, longitude, sequence_order, scheduled_time, student_ids, student_count) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::time, $9::uuid[], $10::int)',
      generateId(),
      candidate2Id,
      s.name,
      s.addr,
      s.lat,
      s.lng,
      s.seq,
      s.time,
      studentIds,
      s.students,
    );
  }

  // Candidate 3: PENDING — awaiting TC review
  const candidate3Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_generation_candidates (id, request_id, candidate_name, direction, vehicle_type_required, total_students, total_stops, estimated_route_mileage, estimated_duration_minutes, max_student_ride_time_minutes, all_constraints_satisfied) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'PM', 'MINIBUS', 2, 3, 8.2, 19, 18, true)",
    candidate3Id,
    generationRequestId,
    'Maple Heights PM',
  );

  const stops3 = [
    {
      name: 'Lincoln Academy',
      addr: '1200 School Dr',
      lat: 39.788,
      lng: -89.642,
      seq: 1,
      time: '15:30',
      students: 2,
    },
    {
      name: 'Civic Center Park',
      addr: '500 Park Way',
      lat: 39.7858,
      lng: -89.6452,
      seq: 2,
      time: '15:42',
      students: 0,
    },
    {
      name: 'Maple Heights Plaza',
      addr: '100 Maple Ave',
      lat: 39.7817,
      lng: -89.6501,
      seq: 3,
      time: '15:49',
      students: 0,
    },
  ];
  for (const s of stops3) {
    const studentIds = Array.from({ length: s.students }, () => generateId());
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_generation_candidate_stops (id, candidate_id, stop_name, address, latitude, longitude, sequence_order, scheduled_time, student_ids, student_count) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric, $7::int, $8::time, $9::uuid[], $10::int)',
      generateId(),
      candidate3Id,
      s.name,
      s.addr,
      s.lat,
      s.lng,
      s.seq,
      s.time,
      studentIds,
      s.students,
    );
  }

  // ── E. Ad-hoc trip ──
  console.log('  Seeding 1 SCHEDULED ad-hoc athletic-event trip...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_adhoc_trip_requests (id, school_id, requested_by, trip_purpose, trip_date, departure_time, return_time, pickup_location, destination, estimated_passengers, special_requirements, assigned_vehicle_id, assigned_driver_id, status, scheduled_at, approval_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATHLETIC_EVENT', CURRENT_DATE + INTERVAL '14 days', '08:30', '17:30', $4, $5, 35, $6, $7::uuid, $8::uuid, 'SCHEDULED', now() - INTERVAL '2 days', $9)",
    generateId(),
    schoolId,
    mitchell.accountId,
    'Lincoln Academy parking lot',
    'Springfield High School (varsity basketball away game)',
    'Wheelchair-accessible seat for one student. Two coaches plus 32 student athletes.',
    bus42,
    driverEmployeeId,
    'Vehicle inspected and assigned. Driver confirmed.',
  );

  // ── F. Contracted route ──
  console.log('  Seeding 1 contracted route...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_contracted_routes (id, route_id, contract_reference, contract_start_date, contract_end_date, daily_rate, payment_frequency, performance_rating, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE + INTERVAL '305 days', 425.00, 'MONTHLY', 4.5, $4, $5::uuid)",
    generateId(),
    route7Id,
    'CONTRACT-2026-OAKLEAF-TRANSIT',
    'Operated by Oakleaf Transit. Performance review monthly. Latest rating 4.5/5.',
    mitchell.accountId,
  );

  // ── G. Route change requests ──
  console.log('  Seeding 2 route change requests (1 APPROVED, 1 PENDING)...');

  // 1 APPROVED route change request — different stop tomorrow (with override stamped)
  const approvedChangeId = generateId();
  const overrideId = generateId();
  const route7StopRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.trn_stops WHERE route_id = $1::uuid ORDER BY sequence_order ASC LIMIT 1',
    route7Id,
  )) as Array<{ id: string }>;
  if (route7StopRows.length > 0) {
    const route7FirstStop = route7StopRows[0]!.id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_student_assignments (id, student_id, route_id, stop_id, direction, effective_from, effective_to, is_override, parent_request_id, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'AM', CURRENT_DATE + INTERVAL '1 day', CURRENT_DATE + INTERVAL '1 day', true, $5::uuid, $6::uuid)",
      overrideId,
      mayaStudentId,
      route7Id,
      route7FirstStop,
      approvedChangeId,
      mitchell.accountId,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_route_change_requests (id, school_id, student_id, submitted_by, change_date, change_type, requested_route_id, requested_stop_id, reason, status, reviewed_by, reviewed_at, review_notes, override_assignment_id) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, CURRENT_DATE + INTERVAL '1 day', 'DIFFERENT_STOP', $5::uuid, $6::uuid, $7, 'APPROVED', $8::uuid, now() - INTERVAL '1 hour', $9, $10::uuid)",
      approvedChangeId,
      schoolId,
      mayaStudentId,
      parent.accountId,
      route7Id,
      route7FirstStop,
      'Grandparent picking Maya up from Maple Heights Plaza on Thursday.',
      mitchell.accountId,
      'Approved — one-day override stamped.',
      overrideId,
    );
  }

  // 1 PENDING route change request (no override yet)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_route_change_requests (id, school_id, student_id, submitted_by, change_date, change_type, reason, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, CURRENT_DATE + INTERVAL '3 days', 'NO_BUS', $5, 'PENDING')",
    generateId(),
    schoolId,
    mayaStudentId,
    parent.accountId,
    'Doctor appointment in the afternoon — picking Maya up directly.',
  );

  console.log('');
  console.log('  Transportation Advanced (B) seed complete.');
  console.log('    1 constraint profile ("2026 Standard")');
  console.log('    1 COMPLETED generation request');
  console.log('    3 candidates (1 APPROVED + 1 REJECTED + 1 PENDING)');
  console.log('    12 candidate stops across 3 candidates');
  console.log('    1 SCHEDULED ad-hoc athletic-event trip');
  console.log('    1 contracted route (Route 7 — Oakleaf Transit)');
  console.log('    2 route change requests (1 APPROVED with override + 1 PENDING)');
  console.log('');
}

seedTransportAdvancedB()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
