import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-incident.ts — Phase 2 Cycle 2 (P2C2) Step 4.
 *
 * M91 Incident & Emergency. Idempotent — gated on whether
 * inc_incident_types already has rows for the demo school.
 *
 * Sections:
 *   A) 5 incident types — LOCKDOWN (CRITICAL, requires_lockdown=true),
 *      FIRE_EVACUATION (CRITICAL), SHELTER_IN_PLACE (HIGH),
 *      MEDICAL_EMERGENCY (HIGH), MISSING_STUDENT (CRITICAL).
 *   B) 3 emergency procedures — FIRE_EVACUATION (6 steps with time
 *      targets), LOCKDOWN (8 steps), MEDICAL_EMERGENCY (5 steps).
 *      Each with primary contact, assembly points, external contacts.
 *   C) 1 historical RESOLVED incident (fire drill last month) with
 *      5 timeline entries + 15 accountability records (all
 *      ACCOUNTED_FOR after the drill) + materialised summary.
 *   D) 1 reunification record (1 student released to parent during
 *      that drill — verifies the cross-cycle integration with P2C1
 *      vis_visitors).
 *   E) 2 drills — 1 SCHEDULED for next Friday, 1 COMPLETED 2 weeks
 *      ago with 98% participation.
 *   F) 2 non-discipline incidents — playground injury (STUDENT_INJURY,
 *      MEDIUM, OPEN, follow_up_ticket_id soft ref) + broken window
 *      (PROPERTY_DAMAGE, LOW, CLOSED).
 *   G) 1 declaration outbox row (for the resolved incident, all
 *      three step columns stamped).
 *
 * Idempotent re-runs short-circuit on the gate.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedIncident() {
  console.log('');
  console.log('  Incident & Emergency Seed (P2C2 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.inc_incident_types WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  inc_incident_types already populated for demo school. Skipping.');
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
  const vp = await findUserByEmail('vp@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const counsellor = await findUserByEmail('counsellor@demo.campusos.dev');

  // ----- A) 5 incident types -------------------------------------------------
  console.log('  Seeding 5 incident types ...');
  const lockdownTypeId = generateId();
  const fireTypeId = generateId();
  const shelterTypeId = generateId();
  const medicalTypeId = generateId();
  const missingTypeId = generateId();

  const types = [
    {
      id: lockdownTypeId,
      code: 'LOCKDOWN',
      name: 'Lockdown',
      severity: 'CRITICAL',
      lockdown: true,
      tmpl: 'A lockdown is currently in effect. Move to the nearest secure room and follow staff instructions.',
    },
    {
      id: fireTypeId,
      code: 'FIRE_EVACUATION',
      name: 'Fire Evacuation',
      severity: 'CRITICAL',
      lockdown: false,
      tmpl: 'Fire alarm activated. Evacuate to the assembly point.',
    },
    {
      id: shelterTypeId,
      code: 'SHELTER_IN_PLACE',
      name: 'Shelter in Place',
      severity: 'HIGH',
      lockdown: false,
      tmpl: 'Shelter in place. Remain in your current location until further notice.',
    },
    {
      id: medicalTypeId,
      code: 'MEDICAL_EMERGENCY',
      name: 'Medical Emergency',
      severity: 'HIGH',
      lockdown: false,
      tmpl: 'A medical emergency response is underway. Clear corridors for first responders.',
    },
    {
      id: missingTypeId,
      code: 'MISSING_STUDENT',
      name: 'Missing Student',
      severity: 'CRITICAL',
      lockdown: false,
      tmpl: 'A student is unaccounted for. Staff please confirm your roster.',
    },
  ];
  for (const t of types) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.inc_incident_types ' +
        '(id, school_id, code, name, severity, requires_lockdown, notification_template) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
      t.id,
      schoolId,
      t.code,
      t.name,
      t.severity,
      t.lockdown,
      t.tmpl,
    );
  }

  // ----- B) 3 emergency procedures ------------------------------------------
  console.log('  Seeding 3 emergency procedures ...');
  const fireSteps = [
    {
      step_number: 1,
      action: 'Evacuate immediate room via nearest fire exit',
      responsible_role: 'TEACHER',
      time_target_seconds: 60,
    },
    {
      step_number: 2,
      action: 'Take roster + grab-bag from designated location',
      responsible_role: 'TEACHER',
      time_target_seconds: 30,
    },
    {
      step_number: 3,
      action: 'Walk class to front parking-lot assembly area',
      responsible_role: 'TEACHER',
      time_target_seconds: 240,
    },
    {
      step_number: 4,
      action: 'Take roll at assembly point and report to incident commander',
      responsible_role: 'TEACHER',
      time_target_seconds: 120,
    },
    {
      step_number: 5,
      action: 'Coordinate building sweep with fire dept on arrival',
      responsible_role: 'PRINCIPAL',
      time_target_seconds: 300,
    },
    {
      step_number: 6,
      action: 'All-clear sound + return to classrooms in orderly waves',
      responsible_role: 'PRINCIPAL',
      time_target_seconds: 600,
    },
  ];
  const lockdownSteps = [
    {
      step_number: 1,
      action: 'Lock classroom door; cover window; turn off lights',
      responsible_role: 'TEACHER',
      time_target_seconds: 30,
    },
    {
      step_number: 2,
      action: 'Move students to the safe corner away from doors and windows',
      responsible_role: 'TEACHER',
      time_target_seconds: 30,
    },
    {
      step_number: 3,
      action: 'Silence all phones and devices',
      responsible_role: 'TEACHER',
      time_target_seconds: 30,
    },
    {
      step_number: 4,
      action: 'Take silent roll - identify any missing students',
      responsible_role: 'TEACHER',
      time_target_seconds: 60,
    },
    {
      step_number: 5,
      action: 'Notify the front office via the silent panic signal',
      responsible_role: 'TEACHER',
      time_target_seconds: 15,
    },
    {
      step_number: 6,
      action: 'Wait for police all-clear; ignore fire alarms unless instructed by police',
      responsible_role: 'TEACHER',
      time_target_seconds: 0,
    },
    {
      step_number: 7,
      action: 'Coordinate with arriving police; provide building keys',
      responsible_role: 'PRINCIPAL',
      time_target_seconds: 120,
    },
    {
      step_number: 8,
      action: 'Resume normal operations only after police all-clear',
      responsible_role: 'PRINCIPAL',
      time_target_seconds: 0,
    },
  ];
  const medicalSteps = [
    {
      step_number: 1,
      action: 'Call 911 and brief dispatch with location + nature',
      responsible_role: 'NURSE',
      time_target_seconds: 60,
    },
    {
      step_number: 2,
      action: 'Begin first aid; assign a runner to meet EMS at the front entrance',
      responsible_role: 'NURSE',
      time_target_seconds: 30,
    },
    {
      step_number: 3,
      action: 'Notify the principal and the parent / guardian',
      responsible_role: 'PRINCIPAL',
      time_target_seconds: 120,
    },
    {
      step_number: 4,
      action: 'Clear corridors between the patient and the front entrance',
      responsible_role: 'STAFF',
      time_target_seconds: 60,
    },
    {
      step_number: 5,
      action: 'Document the incident in the immutable timeline + nurse log',
      responsible_role: 'NURSE',
      time_target_seconds: 600,
    },
  ];

  const externalContacts = JSON.stringify([
    { agency: 'Local Police', phone: '+1-217-555-0911', notes: 'Lockdown coordinator' },
    { agency: 'Fire Department', phone: '+1-217-555-0911', notes: 'Building sweep + all-clear' },
    { agency: 'EMS Dispatch', phone: '+1-217-555-0911', notes: 'Medical response' },
  ]);
  const fireAssembly = JSON.stringify([
    { name: 'Front Parking Lot - East Side', priority: 1, capacity: 400 },
    { name: 'Front Parking Lot - West Side (overflow)', priority: 2, capacity: 200 },
  ]);
  const lockdownAssembly = JSON.stringify([
    { name: 'Police staging - Library', priority: 1, capacity: 1 },
  ]);
  const medicalAssembly = JSON.stringify([
    { name: 'Front entrance - EMS arrival', priority: 1, capacity: 1 },
  ]);

  const fireProcId = generateId();
  const lockdownProcId = generateId();
  const medicalProcId = generateId();

  for (const p of [
    {
      id: fireProcId,
      type: 'FIRE_EVACUATION',
      title: 'Fire Evacuation Procedure',
      steps: JSON.stringify(fireSteps),
      assembly: fireAssembly,
    },
    {
      id: lockdownProcId,
      type: 'LOCKDOWN',
      title: 'Lockdown Procedure',
      steps: JSON.stringify(lockdownSteps),
      assembly: lockdownAssembly,
    },
    {
      id: medicalProcId,
      type: 'MEDICAL_EMERGENCY',
      title: 'Medical Emergency Procedure',
      steps: JSON.stringify(medicalSteps),
      assembly: medicalAssembly,
    },
  ]) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.inc_emergency_procedures ' +
        '(id, school_id, procedure_type, title, procedure_steps, primary_contact_id, secondary_contact_id, ' +
        ' external_contacts, assembly_points, last_reviewed_at, reviewed_by, next_review_date, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::uuid, $7::uuid, $8::jsonb, $9::jsonb, ' +
        ' $10::date, $11::uuid, $12::date, true)',
      p.id,
      schoolId,
      p.type,
      p.title,
      p.steps,
      principal.accountId,
      vp.accountId,
      externalContacts,
      p.assembly,
      '2026-04-15',
      principal.accountId,
      '2026-10-15',
    );
  }

  // ----- C) 1 historical RESOLVED incident with timeline + accountability ----
  console.log('  Seeding 1 historical RESOLVED fire-drill incident ...');
  const histIncidentId = generateId();
  const declaredAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  const resolvedAt = new Date(declaredAt.getTime() + 23 * 60 * 1000); // 23 mins after declared

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_incidents ' +
      '(id, school_id, incident_type_id, declared_by, declared_at, title, description, status, ' +
      ' resolved_at, resolved_by, resolution_notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, ' +
      ' $8, $9::timestamptz, $10::uuid, $11)',
    histIncidentId,
    schoolId,
    fireTypeId,
    principal.accountId,
    declaredAt.toISOString(),
    'Q3 Fire Drill',
    'Quarterly fire-evacuation drill - all students and staff to front parking lot.',
    'RESOLVED',
    resolvedAt.toISOString(),
    principal.accountId,
    'All clear. 245 students + 35 staff + 3 visitors mustered correctly. Drill duration 21 minutes.',
  );

  // Timeline (5 entries)
  const timelineEntries = [
    {
      secs: 0,
      type: 'DECLARED',
      desc: 'Fire drill declared by principal',
      meta: { source: 'manual' },
    },
    {
      secs: 90,
      type: 'PROCEDURE_STARTED',
      desc: 'Evacuation procedure initiated; alarm sounded',
      meta: {},
    },
    {
      secs: 480,
      type: 'BUILDING_CLEARED',
      desc: 'Building A confirmed clear by floor warden',
      meta: { building: 'A' },
    },
    {
      secs: 720,
      type: 'BUILDING_CLEARED',
      desc: 'Building B confirmed clear by floor warden',
      meta: { building: 'B' },
    },
    {
      secs: 1380,
      type: 'ALL_CLEAR',
      desc: 'All-clear sounded; students returning to classrooms',
      meta: {},
    },
  ];
  for (const e of timelineEntries) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.inc_incident_timeline ' +
        '(id, incident_id, recorded_by, event_type, description, metadata, recorded_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::timestamptz)',
      generateId(),
      histIncidentId,
      principal.accountId,
      e.type,
      e.desc,
      JSON.stringify(e.meta),
      new Date(declaredAt.getTime() + e.secs * 1000).toISOString(),
    );
  }

  // Accountability — 15 records all final state ACCOUNTED_FOR
  const accountabilityIds: string[] = [];
  for (let i = 0; i < 15; i++) {
    const personType = i < 10 ? 'STUDENT' : i < 13 ? 'STAFF' : 'VISITOR';
    const recId = generateId();
    accountabilityIds.push(recId);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.inc_accountability_records ' +
        '(id, incident_id, person_id, person_type, status, last_updated_by, last_updated_at, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::timestamptz, $8)',
      recId,
      histIncidentId,
      generateId(),
      personType,
      'ACCOUNTED_FOR',
      vp.accountId,
      new Date(declaredAt.getTime() + 720 * 1000).toISOString(),
      'Mustered at assembly point.',
    );
  }

  // Materialised summary — 15 ACCOUNTED_FOR, 0 of every other status
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_accountability_summary ' +
      '(id, incident_id, total_people, accounted_for, unknown, evacuated, medical_assistance, missing, last_updated_at) ' +
      'VALUES ($1::uuid, $2::uuid, 15, 15, 0, 0, 0, 0, $3::timestamptz)',
    generateId(),
    histIncidentId,
    resolvedAt.toISOString(),
  );

  // ----- D) 1 reunification record ------------------------------------------
  console.log('  Seeding 1 reunification record (cross-cycle to P2C1) ...');
  // Look up a vis_visitors row from the demo seed (or fall back to a synthetic UUID).
  const visRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.vis_visitors WHERE school_id = $1::uuid LIMIT 1',
    schoolId,
  )) as Array<{ id: string }>;
  const releasedToId = visRows.length > 0 ? visRows[0]!.id : generateId();

  const studentRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_students LIMIT 1',
  )) as Array<{ id: string }>;
  const studentId = studentRows.length > 0 ? studentRows[0]!.id : generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_reunification_records ' +
      '(id, incident_id, student_id, released_to_id, released_by, released_at, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7)',
    generateId(),
    histIncidentId,
    studentId,
    releasedToId,
    vp.accountId,
    new Date(declaredAt.getTime() + 1500 * 1000).toISOString(),
    'Released to signed-in parent at front reunification station.',
  );

  // ----- E) 2 drills (1 SCHEDULED + 1 COMPLETED) -----------------------------
  console.log('  Seeding 2 drills ...');
  const scheduledFor = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // +5 days
  const completedAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // -14 days
  const completedScheduledAt = new Date(completedAt.getTime() - 30 * 60 * 1000);

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_drills ' +
      '(id, school_id, incident_type_id, procedure_type, scheduled_at, status, created_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::uuid, $8)',
    generateId(),
    schoolId,
    fireTypeId,
    'FIRE_EVACUATION',
    scheduledFor.toISOString(),
    'SCHEDULED',
    principal.accountId,
    'Quarterly fire drill.',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_drills ' +
      '(id, school_id, incident_type_id, procedure_type, scheduled_at, status, completed_at, ' +
      ' duration_seconds, participation_rate, created_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::timestamptz, $8, $9, $10::uuid, $11)',
    generateId(),
    schoolId,
    fireTypeId,
    'FIRE_EVACUATION',
    completedScheduledAt.toISOString(),
    'COMPLETED',
    completedAt.toISOString(),
    1260,
    0.98,
    principal.accountId,
    'Building cleared in 21 minutes. 2 students late to assembly point - addressed in homeroom.',
  );

  // ----- F) 2 non-discipline incidents ---------------------------------------
  console.log('  Seeding 2 non-discipline incidents ...');
  const studentInjuryId = generateId();
  const propertyDamageId = generateId();
  const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const olderDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_non_discipline_incidents ' +
      '(id, school_id, incident_type, location, incident_date, description, students_involved, ' +
      ' staff_involved, witnesses, reported_by, severity, follow_up_ticket_id, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7::uuid[], $8::uuid[], $9, ' +
      ' $10::uuid, $11, $12::uuid, $13)',
    studentInjuryId,
    schoolId,
    'STUDENT_INJURY',
    'Playground - climbing frame',
    recentDate.toISOString(),
    'Student fell from the second-tier monkey-bar bay landing on left wrist. Walked to nurse under own power, no obvious deformity. Nurse iced wrist + parent notified to consider X-ray.',
    studentRows.length > 0 ? '{' + studentRows[0]!.id + '}' : '{}',
    '{}',
    'Mr. Rivera (recess supervisor)',
    teacher.accountId,
    'MEDIUM',
    generateId(),
    'OPEN',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_non_discipline_incidents ' +
      '(id, school_id, incident_type, location, incident_date, description, witnesses, ' +
      ' reported_by, severity, status, resolution, reviewed_by, reviewed_at, closed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, $7, $8::uuid, $9, $10, $11, ' +
      ' $12::uuid, $13::timestamptz, $14::timestamptz)',
    propertyDamageId,
    schoolId,
    'PROPERTY_DAMAGE',
    'Gymnasium - east window',
    olderDate.toISOString(),
    'Window pane cracked overnight - cause unknown. Glazier called the next morning.',
    'Custodian discovered on opening rounds.',
    counsellor.accountId,
    'LOW',
    'CLOSED',
    'Glazier replaced pane next morning. Cost charged to facilities maintenance budget.',
    principal.accountId,
    new Date(olderDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    new Date(olderDate.getTime() + 48 * 60 * 60 * 1000).toISOString(),
  );

  // ----- G) 1 declaration outbox row (all steps stamped for the resolved incident)
  console.log('  Seeding 1 historical outbox row ...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.inc_declaration_outbox ' +
      '(id, incident_id, school_id, declared_at, tasks_created_at, muster_taken_at, alert_sent_at, ' +
      ' attempt_count) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6::timestamptz, ' +
      ' $7::timestamptz, 1)',
    generateId(),
    histIncidentId,
    schoolId,
    declaredAt.toISOString(),
    new Date(declaredAt.getTime() + 5000).toISOString(),
    new Date(declaredAt.getTime() + 12000).toISOString(),
    new Date(declaredAt.getTime() + 18000).toISOString(),
  );

  console.log('');
  console.log('  M91 Incident & Emergency seed complete.');
  console.log('  - 5 incident types, 3 procedures, 1 RESOLVED incident with 5 timeline entries,');
  console.log(
    '  - 15 accountability records + 1 summary, 1 reunification, 2 drills, 2 non-discipline,',
  );
  console.log('  - 1 outbox row (all steps stamped).');
  console.log('');
}

seedIncident()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
