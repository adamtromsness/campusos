import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';
import { randomBytes } from 'crypto';

/*
 * seed-transport-advanced-c.ts — P2-11c Step 6 (Phase 2 Cycle 11 sub-cycle c).
 *
 * M61 Transportation Advanced — GPS Telemetry plus Fleet Dashboard.
 *
 * Idempotent — gated on whether trn_geofences already has rows for
 * the demo school. Re-runs are no-ops.
 *
 * Sections:
 *   A) 50 vehicle positions across 3 vehicles (simulated GPS trail
 *      across the last 24 hours).
 *   B) 3 geofences (1 SCHOOL circle, 1 STOP circle, 1 SPEED_ZONE
 *      polygon).
 *   C) 5 geofence enter and exit events.
 *   D) 3 ETA records (one per vehicle to its next stop).
 *   E) 8 dispatch events covering 5 distinct event_type values.
 *   F) 2 parent tracking tokens (1 active, 1 revoked) for Maya Chen
 *      and Ethan Rodriguez.
 *   G) 3 rpt_fleet_status rows (1 maintenance_overdue with open
 *      safety-critical repair, 1 with insurance expiring in 10 days,
 *      1 healthy).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedTransportAdvancedC(): Promise<void> {
  console.log('');
  console.log('  Transportation Advanced Seed C (P2-11c Step 6)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.trn_geofences WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  trn_geofences already populated for demo school. Skipping.');
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

  // Resolve the existing demo fleet (Bus #42 + Van #3 from seed-transport)
  const vehicleRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, registration FROM ' +
      TENANT_SCHEMA +
      '.trn_vehicles WHERE school_id = $1::uuid ORDER BY registration LIMIT 3',
    schoolId,
  )) as Array<{ id: string; registration: string }>;
  if (vehicleRows.length < 2) {
    throw new Error('seed:transport must run first — need at least 2 demo vehicles');
  }
  const bus42 = vehicleRows[0]!;
  const van3 = vehicleRows[1]!;
  // If only 2 vehicles exist, reuse Bus #42 for the third position trail
  const thirdVehicle = vehicleRows[2] ?? bus42;

  // Resolve route + stops (Route 7 — Elm Street AM from seed-transport)
  const routeRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' +
      TENANT_SCHEMA +
      ".trn_routes WHERE school_id = $1::uuid AND name LIKE 'Route 7%' LIMIT 1",
    schoolId,
  )) as Array<{ id: string; name: string }>;
  if (routeRows.length === 0) {
    throw new Error('Route 7 not found — run seed:transport first');
  }
  const route7Id = routeRows[0]!.id;

  const stopRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name, latitude::text AS lat, longitude::text AS lng FROM ' +
      TENANT_SCHEMA +
      '.trn_stops WHERE route_id = $1::uuid ORDER BY sequence_order LIMIT 3',
    route7Id,
  )) as Array<{ id: string; name: string; lat: string; lng: string }>;
  if (stopRows.length === 0) {
    throw new Error('No stops for Route 7 — run seed:transport first');
  }

  // Resolve Maya Chen + Ethan Rodriguez for parent tracking tokens
  const studentRows = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id, ip.first_name AS first FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
      "WHERE ip.first_name IN ('Maya', 'Ethan') LIMIT 2",
  )) as Array<{ id: string; first: string }>;
  const mayaId = studentRows.find((r) => r.first === 'Maya')?.id;
  const ethanId = studentRows.find((r) => r.first === 'Ethan')?.id;

  // ── A. Vehicle positions (50 rows across the 3 vehicles) ──
  console.log('  Seeding 50 vehicle positions...');
  const baseLat = 39.7;
  const baseLng = -89.6;
  // Use a fixed "today" anchor for reproducibility — points fall in the
  // partition window we created in the migration (2026-04-14 → 2026-08-09).
  const trailAnchor = new Date('2026-05-11T08:00:00Z');
  const vehiclesForTrail = [bus42, van3, thirdVehicle];
  for (let vIdx = 0; vIdx < vehiclesForTrail.length; vIdx++) {
    const vehicle = vehiclesForTrail[vIdx]!;
    // Skip duplicate vehicle trails (when only 2 vehicles exist, thirdVehicle = bus42)
    if (vIdx === 2 && thirdVehicle.id === bus42.id) break;
    for (let i = 0; i < 17; i++) {
      const offsetSec = i * 60; // 1 position per minute = 17 minutes of trail
      const recordedAt = new Date(trailAnchor.getTime() + offsetSec * 1000);
      const lat = baseLat + 0.001 * i + 0.0005 * vIdx;
      const lng = baseLng + 0.001 * i + 0.0005 * vIdx;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.trn_vehicle_positions (id, vehicle_id, latitude, longitude, speed_kmh, heading, recorded_at, source) ' +
          "VALUES ($1::uuid, $2::uuid, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7::timestamptz, 'GPS')",
        generateId(),
        vehicle.id,
        lat,
        lng,
        25 + (i % 12),
        (90 + i * 5) % 360,
        recordedAt.toISOString(),
      );
    }
  }

  // ── B. Geofences ──
  console.log('  Seeding 3 geofences (SCHOOL circle, STOP circle, SPEED_ZONE polygon)...');
  const schoolGeofenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_geofences (id, school_id, name, geofence_type, boundary, is_active, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'SCHOOL', $4::jsonb, true, $5, $6::uuid)",
    schoolGeofenceId,
    schoolId,
    'Lincoln Elementary Campus',
    JSON.stringify({
      type: 'circle',
      center: { lat: 39.7, lng: -89.6 },
      radius_metres: 200,
    }),
    'School grounds — bus entry triggers parent IN_APP notification',
    mitchell.accountId,
  );

  const stopGeofenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_geofences (id, school_id, name, geofence_type, boundary, is_active, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'STOP', $4::jsonb, true, $5, $6::uuid)",
    stopGeofenceId,
    schoolId,
    'Elm Street Stop 1 Zone',
    JSON.stringify({
      type: 'circle',
      center: { lat: 39.71, lng: -89.61 },
      radius_metres: 50,
    }),
    'First Elm Street pickup zone',
    mitchell.accountId,
  );

  const speedGeofenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.trn_geofences (id, school_id, name, geofence_type, boundary, speed_limit_kmh, is_active, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'SPEED_ZONE', $4::jsonb, 25, true, $5, $6::uuid)",
    speedGeofenceId,
    schoolId,
    'School Zone Speed Limit',
    JSON.stringify({
      type: 'polygon',
      coordinates: [
        [39.698, -89.602],
        [39.702, -89.602],
        [39.702, -89.598],
        [39.698, -89.598],
        [39.698, -89.602],
      ],
    }),
    '25 km/h speed-limited zone around school grounds',
    mitchell.accountId,
  );

  // ── C. Geofence events ──
  console.log('  Seeding 5 geofence events...');
  const events = [
    {
      geofence: stopGeofenceId,
      vehicle: bus42.id,
      type: 'ENTER',
      offset: 5 * 60,
      speed: 12,
    },
    {
      geofence: stopGeofenceId,
      vehicle: bus42.id,
      type: 'EXIT',
      offset: 7 * 60,
      speed: 20,
    },
    {
      geofence: schoolGeofenceId,
      vehicle: bus42.id,
      type: 'ENTER',
      offset: 15 * 60,
      speed: 18,
    },
    {
      geofence: schoolGeofenceId,
      vehicle: van3.id,
      type: 'ENTER',
      offset: 12 * 60,
      speed: 22,
    },
    {
      geofence: speedGeofenceId,
      vehicle: bus42.id,
      type: 'ENTER',
      offset: 14 * 60,
      speed: 23,
    },
  ];
  for (const ev of events) {
    const recordedAt = new Date(trailAnchor.getTime() + ev.offset * 1000);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_geofence_events (id, geofence_id, vehicle_id, event_type, recorded_at, speed_at_event, latitude, longitude) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::numeric, $7::numeric, $8::numeric)',
      generateId(),
      ev.geofence,
      ev.vehicle,
      ev.type,
      recordedAt.toISOString(),
      ev.speed,
      baseLat + 0.001,
      baseLng + 0.001,
    );
  }

  // ── D. ETA records (UPSERT-friendly snapshots) ──
  console.log('  Seeding 3 ETA records...');
  for (let i = 0; i < Math.min(3, stopRows.length); i++) {
    const stop = stopRows[i]!;
    const minutesAway = (i + 1) * 5;
    const etaAt = new Date(trailAnchor.getTime() + minutesAway * 60 * 1000);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_vehicle_eta (id, vehicle_id, stop_id, eta, confidence, distance_metres) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5, $6::numeric)',
      generateId(),
      bus42.id,
      stop.id,
      etaAt.toISOString(),
      i === 0 ? 'HIGH' : i === 1 ? 'MEDIUM' : 'LOW',
      minutesAway * 350,
    );
  }

  // ── E. Dispatch events ──
  console.log('  Seeding 8 dispatch events (covers 5 distinct event_type values)...');
  const dispatchEvents = [
    { vehicle: bus42.id, route: route7Id, type: 'ROUTE_STARTED', offset: 0, data: {} },
    {
      vehicle: bus42.id,
      route: route7Id,
      type: 'DELAY_REPORTED',
      offset: 3 * 60,
      data: { minutes_delayed: 5, reason: 'Traffic congestion on Main St' },
    },
    {
      vehicle: bus42.id,
      route: route7Id,
      type: 'STUDENT_NO_SHOW',
      offset: 6 * 60,
      data: { stop_name: 'Elm Street Stop 2', student_count: 1 },
    },
    {
      vehicle: bus42.id,
      route: route7Id,
      type: 'DETOUR',
      offset: 9 * 60,
      data: { reason: 'Road closure on Oak Lane', detour_length_metres: 800 },
    },
    {
      vehicle: bus42.id,
      route: route7Id,
      type: 'ROUTE_COMPLETED',
      offset: 20 * 60,
      data: { actual_duration_minutes: 27 },
    },
    {
      vehicle: van3.id,
      route: route7Id,
      type: 'ROUTE_STARTED',
      offset: 0,
      data: { note: 'Backup van — Bus #42 was delayed' },
    },
    {
      vehicle: van3.id,
      route: null,
      type: 'BREAKDOWN_REPORTED',
      offset: 8 * 60,
      data: { fault: 'Flat tyre on rear axle', location: '2nd and Pine' },
    },
    {
      vehicle: bus42.id,
      route: route7Id,
      type: 'EMERGENCY_STOP',
      offset: 4 * 60,
      data: { reason: 'Student medical event', resolution: 'Paramedics on scene' },
    },
  ];
  for (const dev of dispatchEvents) {
    const recordedAt = new Date(trailAnchor.getTime() + dev.offset * 1000);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_dispatch_events (id, school_id, vehicle_id, route_id, driver_id, event_type, event_data, recorded_at, recorded_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, $5, $6::jsonb, $7::timestamptz, $8::uuid)',
      generateId(),
      schoolId,
      dev.vehicle,
      dev.route,
      dev.type,
      JSON.stringify(dev.data),
      recordedAt.toISOString(),
      parkVp.accountId,
    );
  }

  // ── F. Parent tracking tokens ──
  console.log('  Seeding 2 parent tracking tokens (1 ACTIVE for Maya, 1 REVOKED for Ethan)...');
  function generateToken(): string {
    return randomBytes(32).toString('hex');
  }
  const expiresAt30d = new Date(trailAnchor.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (mayaId) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_parent_tracking_tokens (id, student_id, route_id, school_id, token, expires_at, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, true) ' +
        'ON CONFLICT DO NOTHING',
      generateId(),
      mayaId,
      route7Id,
      schoolId,
      generateToken(),
      expiresAt30d.toISOString(),
    );
  }
  if (ethanId) {
    // Revoked token — useful to verify the unauthenticated GET returns 410 Gone
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.trn_parent_tracking_tokens (id, student_id, route_id, school_id, token, expires_at, is_active, revoked_at, revoked_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, false, now(), $7::uuid) ' +
        'ON CONFLICT DO NOTHING',
      generateId(),
      ethanId,
      route7Id,
      schoolId,
      generateToken(),
      expiresAt30d.toISOString(),
      mitchell.accountId,
    );
  }

  // ── G. Fleet status snapshots ──
  console.log(
    '  Seeding 3 rpt_fleet_status snapshots (1 maintenance_overdue, 1 insurance expiring)...',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.rpt_fleet_status (id, vehicle_id, school_id, vehicle_registration, vehicle_status, days_until_insurance_expiry, days_until_registration_expiry, days_until_mot_expiry, days_until_licence_expiry, maintenance_overdue, last_incident_date, total_incidents_this_year, current_route_assignment, current_route_id, last_position_at, fuel_efficiency_last_month, open_safety_critical_repair_count) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 120, 180, 60, 90, true, NULL, 0, $6, $7::uuid, $8::timestamptz, 8.5, 1)',
    generateId(),
    bus42.id,
    schoolId,
    bus42.registration,
    'MAINTENANCE',
    'Route 7 — Elm Street AM',
    route7Id,
    new Date(trailAnchor.getTime() + 17 * 60 * 1000).toISOString(),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.rpt_fleet_status (id, vehicle_id, school_id, vehicle_registration, vehicle_status, days_until_insurance_expiry, days_until_registration_expiry, days_until_mot_expiry, days_until_licence_expiry, maintenance_overdue, last_incident_date, total_incidents_this_year, current_route_assignment, current_route_id, last_position_at, fuel_efficiency_last_month, open_safety_critical_repair_count) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 10, 200, 90, 60, false, NULL, 1, $6, NULL, $7::timestamptz, 12.3, 0)',
    generateId(),
    van3.id,
    schoolId,
    van3.registration,
    'ACTIVE',
    'Route 8 — Oak Lane PM',
    new Date(trailAnchor.getTime() + 11 * 60 * 1000).toISOString(),
  );
  if (thirdVehicle.id !== bus42.id) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.rpt_fleet_status (id, vehicle_id, school_id, vehicle_registration, vehicle_status, days_until_insurance_expiry, days_until_registration_expiry, days_until_mot_expiry, days_until_licence_expiry, maintenance_overdue, last_incident_date, total_incidents_this_year, current_route_assignment, current_route_id, last_position_at, fuel_efficiency_last_month, open_safety_critical_repair_count) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE', 365, 365, 365, 365, false, NULL, 0, NULL, NULL, NULL, NULL, 0)",
      generateId(),
      thirdVehicle.id,
      schoolId,
      thirdVehicle.registration,
    );
  }

  console.log('');
  console.log('  P2-11c seed complete.');
  console.log('');
}

async function main(): Promise<void> {
  try {
    await seedTransportAdvancedC();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
