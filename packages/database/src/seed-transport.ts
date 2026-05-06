import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-transport.ts — Cycle 19 Step 4.
 *
 * M61 Transportation. Idempotent — gated on whether trn_routes
 * already has rows for the demo school.
 *
 * Sections:
 *   A) 2 routes + 8 stops — Route 7 "Elm Street AM" (5 stops) and
 *      Route 8 "Oak Lane PM" (3 stops).
 *   B) 2 vehicles + 4 documents — Bus #42 (BUS, capacity 48) and
 *      Van #3 (VAN, capacity 12). 2 documents per vehicle.
 *   C) 1 driver + 3 credentials — Linda Park stands in for the
 *      Transportation Coordinator persona since the demo seed ships
 *      only 5 personas (Mitchell, Park, Hayes, Rivera, plus the
 *      synthetic admin@). CDL + MEDICAL_CERTIFICATE + BACKGROUND_CHECK,
 *      all VALID.
 *   D) 2 student assignments — Maya at Stop #2, Ethan at Stop #4.
 *   E) 2 bus passes — Maya + Ethan ANNUAL QR.
 *   F) 1 pre-trip inspection (yesterday) with 6 items all PASS.
 *   G) 1 route run log (yesterday) COMPLETED.
 *   H) 2 ridership records (yesterday) BOARDING.
 *   I) 1 maintenance schedule.
 *
 * Existing-persona substitution: Linda Park covers the Driver role
 * because the demo seed does not ship a dedicated Martinez. Rivera
 * stays the teacher; Park is the VP and is also reused here as the
 * Driver. The Step 6 DriverCredentialService treats whoever holds
 * a credential row as the driver — the role mapping in the IAM seed
 * is a separate decision.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedTransport() {
  console.log('');
  console.log('  Transportation Seed (Cycle 19 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.trn_routes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  trn_routes already populated for demo school. Skipping.');
    return;
  }

  // ── Resolve refs ──
  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const park = await findUserByEmail('vp@demo.campusos.dev');

  // Resolve Park's hr_employees row (the driver)
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

  // Resolve Maya + Ethan student ids
  async function findStudentByPersonName(
    first: string,
    last: string,
  ): Promise<{ sisStudentId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2 LIMIT 1',
      first,
      last,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('sis_students not found for ' + first + ' ' + last);
    return { sisStudentId: rows[0]!.id };
  }

  const maya = await findStudentByPersonName('Maya', 'Chen');
  const ethan = await findStudentByPersonName('Ethan', 'Rodriguez');

  // Academic year
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_academic_years WHERE name = '2025-2026' LIMIT 1",
  )) as Array<{ id: string }>;
  if (yearRows.length === 0) throw new Error('2025-2026 academic year not found');
  const academicYearId = yearRows[0]!.id;

  // ── A. 2 routes + 8 stops ──
  console.log('  Seeding 2 routes + 8 stops...');
  const route7 = generateId();
  const route8 = generateId();

  // Vehicle ids reserved up front so route can carry vehicle_id at create
  const bus42 = generateId();
  const van3 = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_routes (id, school_id, name, description, direction, vehicle_id, driver_id, status, academic_year_id, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'AM', $5::uuid, $6::uuid, 'ACTIVE', $7::uuid, $8::uuid)",
    route7,
    schoolId,
    'Route 7 — Elm Street AM',
    'Morning pickup along Elm Street through the Oakridge subdivision.',
    bus42,
    driverEmployeeId,
    academicYearId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_routes (id, school_id, name, description, direction, vehicle_id, status, academic_year_id, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'PM', $5::uuid, 'ACTIVE', $6::uuid, $7::uuid)",
    route8,
    schoolId,
    'Route 8 — Oak Lane PM',
    'Afternoon dropoff along Oak Lane.',
    van3,
    academicYearId,
    mitchell.accountId,
  );

  const stops: Record<string, string> = {};
  const route7Stops = [
    { seq: 1, name: 'Elm & Maple', addr: '100 Elm Street', time: '07:15:00' },
    { seq: 2, name: 'Elm & Birch', addr: '250 Elm Street', time: '07:20:00' },
    { seq: 3, name: 'Elm & Oakridge', addr: '450 Elm Street', time: '07:25:00' },
    { seq: 4, name: 'Birch & Pine', addr: '120 Birch Avenue', time: '07:32:00' },
    { seq: 5, name: 'Lincoln Elementary', addr: '500 Education Way', time: '07:45:00' },
  ];
  for (const s of route7Stops) {
    const id = generateId();
    stops['route7_' + s.seq] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_stops (id, route_id, name, address, sequence_order, scheduled_time) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::time)',
      id,
      route7,
      s.name,
      s.addr,
      s.seq,
      s.time,
    );
  }
  const route8Stops = [
    { seq: 1, name: 'Lincoln Elementary', addr: '500 Education Way', time: '15:30:00' },
    { seq: 2, name: 'Oak Lane & 5th', addr: '120 Oak Lane', time: '15:42:00' },
    { seq: 3, name: 'Oak Lane & 12th', addr: '380 Oak Lane', time: '15:55:00' },
  ];
  for (const s of route8Stops) {
    const id = generateId();
    stops['route8_' + s.seq] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_stops (id, route_id, name, address, sequence_order, scheduled_time) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::time)',
      id,
      route8,
      s.name,
      s.addr,
      s.seq,
      s.time,
    );
  }

  // ── B. 2 vehicles + 4 documents ──
  console.log('  Seeding 2 vehicles + 4 documents...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicles (id, school_id, registration, make, model, year, capacity, vehicle_type, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'BUS-42', 'Blue Bird', 'All American', 2020, 48, 'BUS', 'ACTIVE')",
    bus42,
    schoolId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicles (id, school_id, registration, make, model, year, capacity, vehicle_type, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'VAN-3', 'Ford', 'Transit', 2022, 12, 'VAN', 'ACTIVE')",
    van3,
    schoolId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_documents (id, vehicle_id, document_type, document_number, issued_date, expiry_date, is_current) ' +
      "VALUES ($1::uuid, $2::uuid, 'INSURANCE', 'INS-2026-042', CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE + INTERVAL '300 days', true)",
    generateId(),
    bus42,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_documents (id, vehicle_id, document_type, document_number, issued_date, expiry_date, is_current) ' +
      "VALUES ($1::uuid, $2::uuid, 'MOT', 'MOT-2026-042', CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE + INTERVAL '335 days', true)",
    generateId(),
    bus42,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_documents (id, vehicle_id, document_type, document_number, issued_date, expiry_date, is_current) ' +
      "VALUES ($1::uuid, $2::uuid, 'INSURANCE', 'INS-2026-003', CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE + INTERVAL '270 days', true)",
    generateId(),
    van3,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_vehicle_documents (id, vehicle_id, document_type, document_number, issued_date, expiry_date, is_current) ' +
      "VALUES ($1::uuid, $2::uuid, 'MOT', 'MOT-2026-003', CURRENT_DATE - INTERVAL '20 days', CURRENT_DATE + INTERVAL '345 days', true)",
    generateId(),
    van3,
  );

  // ── C. 1 driver + 3 credentials ──
  console.log("  Seeding 3 driver credentials for Linda Park's hr_employees row...");
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_driver_credentials (id, driver_id, credential_type, credential_number, issued_date, expiry_date, status, verified_by, verified_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'CDL', 'CDL-CA-IL-44893', CURRENT_DATE - INTERVAL '300 days', CURRENT_DATE + INTERVAL '430 days', 'VALID', $3::uuid, now())",
    generateId(),
    driverEmployeeId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_driver_credentials (id, driver_id, credential_type, credential_number, issued_date, expiry_date, status, verified_by, verified_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'MEDICAL_CERTIFICATE', 'MED-2026-44893', CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE + INTERVAL '275 days', 'VALID', $3::uuid, now())",
    generateId(),
    driverEmployeeId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_driver_credentials (id, driver_id, credential_type, credential_number, issued_date, expiry_date, status, verified_by, verified_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'BACKGROUND_CHECK', 'BGC-2024-44893', CURRENT_DATE - INTERVAL '500 days', CURRENT_DATE + INTERVAL '595 days', 'VALID', $3::uuid, now())",
    generateId(),
    driverEmployeeId,
    mitchell.accountId,
  );

  // ── D. 2 student assignments ──
  console.log('  Seeding 2 student assignments (Maya stop #2, Ethan stop #4)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_student_assignments (id, student_id, route_id, stop_id, academic_year_id, direction, effective_from, is_override, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'AM', CURRENT_DATE - INTERVAL '90 days', false, $6::uuid)",
    generateId(),
    maya.sisStudentId,
    route7,
    stops['route7_2'],
    academicYearId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_student_assignments (id, student_id, route_id, stop_id, academic_year_id, direction, effective_from, is_override, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'AM', CURRENT_DATE - INTERVAL '90 days', false, $6::uuid)",
    generateId(),
    ethan.sisStudentId,
    route7,
    stops['route7_4'],
    academicYearId,
    mitchell.accountId,
  );

  // ── E. 2 bus passes ──
  console.log('  Seeding 2 ANNUAL bus passes (Maya + Ethan)...');
  const mayaPass = generateId();
  const ethanPass = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_bus_passes (id, student_id, academic_year_id, pass_type, qr_code_token, is_active, valid_from, valid_to, issued_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ANNUAL', $4, true, CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE + INTERVAL '275 days', $5::uuid)",
    mayaPass,
    maya.sisStudentId,
    academicYearId,
    'BPS-MAYA-' + mayaPass.replace(/-/g, '').slice(0, 16).toUpperCase(),
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_bus_passes (id, student_id, academic_year_id, pass_type, qr_code_token, is_active, valid_from, valid_to, issued_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ANNUAL', $4, true, CURRENT_DATE - INTERVAL '90 days', CURRENT_DATE + INTERVAL '275 days', $5::uuid)",
    ethanPass,
    ethan.sisStudentId,
    academicYearId,
    'BPS-ETHAN-' + ethanPass.replace(/-/g, '').slice(0, 16).toUpperCase(),
    mitchell.accountId,
  );

  // ── F. 1 pre-trip inspection (yesterday) ──
  console.log('  Seeding 1 pre-trip inspection on Bus #42 (yesterday, all PASS)...');
  const inspectionId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_pre_trip_inspections (id, vehicle_id, driver_id, inspection_date, overall_status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - INTERVAL '1 day', 'PASS', 'All systems nominal.')",
    inspectionId,
    bus42,
    driverEmployeeId,
  );
  const inspectionItems = [
    'Tyres',
    'Brakes',
    'Lights',
    'Mirrors',
    'Emergency exit',
    'First aid kit',
  ];
  for (const item of inspectionItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_pre_trip_inspection_items (id, inspection_id, item_name, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3, 'PASS')",
      generateId(),
      inspectionId,
      item,
    );
  }

  // ── G. 1 route run log (yesterday) ──
  console.log('  Seeding 1 route run log (yesterday COMPLETED)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_route_run_logs (id, route_id, vehicle_id, driver_id, run_date, departure_time, arrival_time, odometer_start, odometer_end, students_boarded, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, CURRENT_DATE - INTERVAL '1 day', " +
      "CURRENT_DATE - INTERVAL '1 day' + INTERVAL '7 hours 10 minutes', " +
      "CURRENT_DATE - INTERVAL '1 day' + INTERVAL '7 hours 50 minutes', " +
      "85432, 85451, 15, 'COMPLETED')",
    generateId(),
    route7,
    bus42,
    driverEmployeeId,
  );

  // ── H. 2 ridership records (yesterday) ──
  console.log('  Seeding 2 ridership records (Maya + Ethan BOARDING yesterday)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_ridership_records (id, student_id, route_id, stop_id, scan_direction, scanned_at, scan_method, bus_pass_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BOARDING', " +
      "CURRENT_DATE - INTERVAL '1 day' + INTERVAL '7 hours 21 minutes', 'QR_CODE', $5::uuid)",
    generateId(),
    maya.sisStudentId,
    route7,
    stops['route7_2'],
    mayaPass,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_ridership_records (id, student_id, route_id, stop_id, scan_direction, scanned_at, scan_method, bus_pass_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BOARDING', " +
      "CURRENT_DATE - INTERVAL '1 day' + INTERVAL '7 hours 33 minutes', 'QR_CODE', $5::uuid)",
    generateId(),
    ethan.sisStudentId,
    route7,
    stops['route7_4'],
    ethanPass,
  );

  // ── I. 1 maintenance schedule ──
  console.log('  Seeding 1 maintenance schedule (Bus #42 oil change)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_maintenance_schedules (id, vehicle_id, service_type, interval_miles, interval_months, last_service_date, last_service_mileage, next_due_date, next_due_mileage, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'Oil Change', 5000, 6, CURRENT_DATE - INTERVAL '90 days', 80000, CURRENT_DATE + INTERVAL '60 days', 85000, 'ON_SCHEDULE')",
    generateId(),
    bus42,
  );

  console.log('');
  console.log('  Transport seed complete.');
  console.log('    Routes: 2 / Stops: 8 / Student assignments: 2');
  console.log('    Vehicles: 2 / Vehicle documents: 4');
  console.log('    Driver credentials: 3 (all VALID, Linda Park stand-in)');
  console.log('    Bus passes: 2 / Inspections: 1 / Inspection items: 6');
  console.log('    Route run logs: 1 / Ridership records: 2');
  console.log('    Maintenance schedules: 1');
}

seedTransport()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
