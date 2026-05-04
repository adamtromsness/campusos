import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-behaviour.ts — Cycle 9 Step 3.
 *
 * Idempotent. Gated on whether sis_discipline_categories already has rows for
 * the demo school. Re-running is a no-op once the seed has landed.
 *
 * Six sections:
 *   A) 6 sis_discipline_categories — Tardiness LOW, Dress Code Violation LOW,
 *      Disrespect MEDIUM, Disruptive Behaviour MEDIUM, Fighting HIGH,
 *      Weapons/Dangerous Items CRITICAL.
 *   B) 5 sis_discipline_action_types — Verbal Warning (no notification),
 *      Written Warning (no notification), Detention (notify), In-School
 *      Suspension (notify), Out-of-School Suspension (notify).
 *   C) 3 sample sis_discipline_incidents:
 *      I1 Maya — Disruptive Behaviour MEDIUM, reported by Rivera, RESOLVED
 *         with a Verbal Warning action.
 *      I2 Maya — Disrespect MEDIUM, reported by Rivera, UNDER_REVIEW with a
 *         Detention action (parent_notified=true with parent_notified_at
 *         populated). This is the source incident the Step 3 BIP links to.
 *      I3 Ethan Rodriguez — Tardiness LOW, OPEN, no actions yet. The Step 4
 *         IncidentService will resolve this scenario in the CAT.
 *   D) 1 sample BIP for Maya — plan_type=BIP, status=ACTIVE, created_by=Hayes
 *      (counsellor), source_incident_id=I2. target_behaviors,
 *      replacement_behaviors, reinforcement_strategies all populated as
 *      2-element arrays. review_date = today + 30 days. 3 goals — 1
 *      IN_PROGRESS, 1 NOT_STARTED, 1 MET.
 *   E) 1 pending svc_bip_teacher_feedback — Hayes requests feedback from
 *      Rivera on Maya's BIP. submitted_at=NULL while pending; the partial
 *      UNIQUE on (plan_id, teacher_id) WHERE submitted_at IS NULL keeps the
 *      counsellor from accidentally double-requesting.
 *   F) 2 auto-task rules — beh.incident.reported -> SCHOOL_ADMIN
 *      ADMINISTRATIVE / 24h ("Review incident: {student_name} —
 *      {category_name}"), and beh.bip.feedback_requested -> null target_role
 *      with the worker resolving the recipient from
 *      payload.recipientAccountId/accountId fallback (matching the Cycle 8
 *      tkt.ticket.assigned pattern). NORMAL / ADMINISTRATIVE / 72h
 *      ("BIP feedback requested: {student_name}").
 */

const TENANT_SCHEMA = 'tenant_demo';
const TODAY_ISO = new Date().toISOString();
const TODAY_DATE = TODAY_ISO.slice(0, 10);

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

async function seedBehaviour() {
  console.log('');
  console.log(
    '  Behaviour Seed (Cycle 9 Step 3 — Categories + Action Types + Incidents + BIP + Auto-task rules)',
  );
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  async function findEmployeeId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT he.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees he ' +
        'JOIN platform.iam_person p ON p.id = he.person_id ' +
        'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees not found for ' + email);
    return rows[0].id;
  }

  async function findStudentIdByName(firstName: string, lastName: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2',
      firstName,
      lastName,
    )) as Array<{ id: string }>;
    if (rows.length === 0)
      throw new Error('sis_students not found for ' + firstName + ' ' + lastName);
    return rows[0].id;
  }

  const [riveraEmpId, mitchellEmpId, hayesEmpId] = await Promise.all([
    findEmployeeId('teacher@demo.campusos.dev'),
    findEmployeeId('principal@demo.campusos.dev'),
    findEmployeeId('counsellor@demo.campusos.dev'),
  ]);

  const [mayaStudentId, ethanStudentId] = await Promise.all([
    findStudentIdByName('Maya', 'Chen'),
    findStudentIdByName('Ethan', 'Rodriguez'),
  ]);

  // Idempotency gate — checks sis_discipline_categories for the demo school.
  const existingCats = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.sis_discipline_categories WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingCats[0] && existingCats[0].c > 0) {
    console.log('  sis_discipline_categories already populated for demo school — skipping');
    return;
  }

  // ── 2. Categories ─────────────────────────────────────────────
  console.log('  A) categories:');
  interface CategorySpec {
    name: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
  }
  const categorySpecs: CategorySpec[] = [
    {
      name: 'Tardiness',
      severity: 'LOW',
      description: 'Late to class without an excused reason.',
    },
    {
      name: 'Dress Code Violation',
      severity: 'LOW',
      description: 'Attire that does not meet the school dress code policy.',
    },
    {
      name: 'Disrespect',
      severity: 'MEDIUM',
      description:
        'Disrespectful behaviour toward staff or peers, including inappropriate language.',
    },
    {
      name: 'Disruptive Behaviour',
      severity: 'MEDIUM',
      description: 'Repeated classroom disruption that interferes with instruction.',
    },
    {
      name: 'Fighting',
      severity: 'HIGH',
      description: 'Physical altercation between students.',
    },
    {
      name: 'Weapons/Dangerous Items',
      severity: 'CRITICAL',
      description:
        'Possession of a weapon or dangerous item on school property. Triggers immediate admin escalation and parent notification.',
    },
  ];

  const categoryIdByName: Record<string, string> = {};
  for (const spec of categorySpecs) {
    const id = generateId();
    categoryIdByName[spec.name] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_discipline_categories (id, school_id, name, severity, description) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      id,
      schoolId,
      spec.name,
      spec.severity,
      spec.description,
    );
  }
  console.log(
    '     - Tardiness LOW, Dress Code Violation LOW, Disrespect MEDIUM, Disruptive Behaviour MEDIUM, Fighting HIGH, Weapons/Dangerous Items CRITICAL',
  );

  // ── 3. Action types ───────────────────────────────────────────
  console.log('  B) action types:');
  interface ActionTypeSpec {
    name: string;
    requiresParentNotification: boolean;
    description: string;
  }
  const actionTypeSpecs: ActionTypeSpec[] = [
    {
      name: 'Verbal Warning',
      requiresParentNotification: false,
      description: 'A verbal reminder of expectations. No formal record sent home.',
    },
    {
      name: 'Written Warning',
      requiresParentNotification: false,
      description: 'A written record placed in the student file. No parent notification yet.',
    },
    {
      name: 'Detention',
      requiresParentNotification: true,
      description: 'After-school detention. Parent receives an IN_APP notification.',
    },
    {
      name: 'In-School Suspension',
      requiresParentNotification: true,
      description: 'Student is removed from class and placed in supervised study. Parent notified.',
    },
    {
      name: 'Out-of-School Suspension',
      requiresParentNotification: true,
      description: 'Student is sent home for a defined window. Parent notified.',
    },
  ];

  const actionTypeIdByName: Record<string, string> = {};
  for (const spec of actionTypeSpecs) {
    const id = generateId();
    actionTypeIdByName[spec.name] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_discipline_action_types (id, school_id, name, requires_parent_notification, description) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      id,
      schoolId,
      spec.name,
      spec.requiresParentNotification,
      spec.description,
    );
  }
  console.log(
    '     - Verbal Warning + Written Warning (no notification), Detention + In-School + Out-of-School Suspension (notify)',
  );

  // ── 4. Sample incidents + actions ─────────────────────────────
  console.log('  C) sample incidents:');
  // Back-date the resolved/under-review incidents so the Step 4 IncidentService
  // can compute "recent activity" relative dates without the demo looking
  // unrealistically clustered around today.
  const i1Created = '2026-04-15 09:30:00+00';
  const i2Created = '2026-04-22 11:00:00+00';
  const i3Created = '2026-05-01 08:15:00+00';

  // I1 Maya — Disruptive Behaviour MEDIUM — RESOLVED
  const i1Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_discipline_incidents (id, school_id, student_id, reported_by, category_id, description, incident_date, incident_time, location, status, resolved_by, resolved_at, admin_notes, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::time, $9, 'RESOLVED', $10::uuid, $11::timestamptz, $12, $13::timestamptz, $11::timestamptz)",
    i1Id,
    schoolId,
    mayaStudentId,
    riveraEmpId,
    categoryIdByName['Disruptive Behaviour'],
    'Talking out of turn repeatedly during the algebra lesson. Refused to settle when asked twice.',
    '2026-04-15',
    '09:30:00',
    'Room 101',
    mitchellEmpId,
    '2026-04-16 10:00:00+00',
    'Spoke with Maya after class. She was apologetic. Verbal warning logged.',
    i1Created,
  );

  // I1 action: Verbal Warning, no parent notification
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_discipline_actions (id, incident_id, action_type_id, assigned_by, notes, parent_notified) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, false)',
    generateId(),
    i1Id,
    actionTypeIdByName['Verbal Warning'],
    mitchellEmpId,
    'Brief one-on-one conversation. Reminded of class participation expectations.',
  );

  // I2 Maya — Disrespect MEDIUM — UNDER_REVIEW with Detention
  const i2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_discipline_incidents (id, school_id, student_id, reported_by, category_id, description, incident_date, incident_time, location, witnesses, status, admin_notes, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::time, $9, $10, 'UNDER_REVIEW', $11, $12::timestamptz, $12::timestamptz)",
    i2Id,
    schoolId,
    mayaStudentId,
    riveraEmpId,
    categoryIdByName['Disrespect'],
    'Verbal altercation with peer during lunch. Used inappropriate language toward a classmate. Refused to follow staff instructions to stop.',
    '2026-04-22',
    '11:00:00',
    'Cafeteria',
    'Linda Park (lunch supervisor)',
    'Pattern: this is the second medium-severity incident this term. Counsellor (Hayes) recommended a behaviour intervention plan. BIP drafted and now active.',
    i2Created,
  );

  // I2 action: Detention with parent notified
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_discipline_actions (id, incident_id, action_type_id, assigned_by, start_date, end_date, notes, parent_notified, parent_notified_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, true, $8::timestamptz)',
    generateId(),
    i2Id,
    actionTypeIdByName['Detention'],
    mitchellEmpId,
    '2026-04-23',
    '2026-04-23',
    '1-day after-school detention. Counsellor referral attached.',
    '2026-04-22 14:30:00+00',
  );

  // I3 Ethan Rodriguez — Tardiness LOW — OPEN, no actions yet
  const i3Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_discipline_incidents (id, school_id, student_id, reported_by, category_id, description, incident_date, incident_time, location, status, created_at, updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::date, $8::time, $9, 'OPEN', $10::timestamptz, $10::timestamptz)",
    i3Id,
    schoolId,
    ethanStudentId,
    riveraEmpId,
    categoryIdByName['Tardiness'],
    'Late to first period three times this week. No prior contact from family about an issue.',
    '2026-05-01',
    '08:15:00',
    'Room 101',
    i3Created,
  );

  console.log(
    '     - I1 Maya Disruptive Behaviour MEDIUM RESOLVED + Verbal Warning, I2 Maya Disrespect MEDIUM UNDER_REVIEW + Detention (parent notified), I3 Ethan Tardiness LOW OPEN',
  );

  // ── 5. Sample BIP ─────────────────────────────────────────────
  console.log('  D) sample BIP:');
  const bipId = generateId();
  const bipReviewDate = isoDateOffset(30);

  // Postgres TEXT[] literal via $::text[] cast on a comma-joined ARRAY[...] expression
  // is the cleanest path. Use parameterised arrays via Prisma's $executeRawUnsafe.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_behavior_plans (id, school_id, student_id, plan_type, status, created_by, review_date, target_behaviors, replacement_behaviors, reinforcement_strategies, source_incident_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'BIP', 'ACTIVE', $4::uuid, $5::date, $6::text[], $7::text[], $8::text[], $9::uuid)",
    bipId,
    schoolId,
    mayaStudentId,
    hayesEmpId,
    bipReviewDate,
    ['Verbal confrontation with peers', 'Refusal to follow staff instructions'],
    ['Use I-statements', 'Request a break when frustrated'],
    ['Positive verbal praise from teachers', 'Weekly check-in with counsellor'],
    i2Id,
  );
  console.log('     - 1 BIP for Maya (ACTIVE, review_date=' + bipReviewDate + ', linked to I2)');

  // ── 6. Goals ──────────────────────────────────────────────────
  console.log('  D2) goals:');
  interface GoalSpec {
    text: string;
    baseline?: string;
    target?: string;
    measurement?: string;
    progress: 'NOT_STARTED' | 'IN_PROGRESS' | 'MET' | 'NOT_MET';
    lastAssessedAt?: string;
  }
  const goalSpecs: GoalSpec[] = [
    {
      text: 'Reduce verbal confrontations to fewer than 2 per week.',
      baseline: '5 per week',
      target: '< 2 per week',
      measurement: 'Weekly tally by classroom teachers, reviewed by counsellor.',
      progress: 'IN_PROGRESS',
      lastAssessedAt: TODAY_DATE,
    },
    {
      text: 'Use I-statements in 3 out of 5 conflict situations.',
      baseline: '0 out of 5',
      target: '3 out of 5',
      measurement: 'Counsellor observation log + role-play assessments.',
      progress: 'NOT_STARTED',
    },
    {
      text: 'Attend weekly counsellor check-in.',
      baseline: '0 sessions',
      target: '1 session per week',
      measurement: 'Attendance log maintained by counsellor.',
      progress: 'MET',
      lastAssessedAt: TODAY_DATE,
    },
  ];

  for (const spec of goalSpecs) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.svc_behavior_plan_goals (id, plan_id, goal_text, baseline_frequency, target_frequency, measurement_method, progress, last_assessed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::date)',
      generateId(),
      bipId,
      spec.text,
      spec.baseline ?? null,
      spec.target ?? null,
      spec.measurement ?? null,
      spec.progress,
      spec.lastAssessedAt ?? null,
    );
  }
  console.log('     - 3 goals (1 IN_PROGRESS, 1 NOT_STARTED, 1 MET)');

  // ── 7. Pending feedback request ───────────────────────────────
  console.log('  E) pending teacher feedback request:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_bip_teacher_feedback (id, plan_id, teacher_id, requested_by, requested_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz)',
    generateId(),
    bipId,
    riveraEmpId,
    hayesEmpId,
    TODAY_ISO,
  );
  console.log(
    '     - Hayes (counsellor) requests feedback from Rivera (Maya teacher), submitted_at=NULL',
  );

  // ── 8. Auto-task rules ────────────────────────────────────────
  console.log('  F) auto-task rules:');
  interface RuleSpec {
    triggerEventType: string;
    targetRole: string | null;
    titleTemplate: string;
    descriptionTemplate: string;
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    dueOffsetHours: number;
    category: 'ACADEMIC' | 'PERSONAL' | 'ADMINISTRATIVE' | 'ACKNOWLEDGEMENT';
  }
  const ruleSpecs: RuleSpec[] = [
    {
      triggerEventType: 'beh.incident.reported',
      targetRole: 'SCHOOL_ADMIN',
      titleTemplate: 'Review incident: {student_name} — {category_name}',
      descriptionTemplate: 'Reported by {reporter_name} on {incident_date}. Severity: {severity}.',
      priority: 'NORMAL',
      dueOffsetHours: 24,
      category: 'ADMINISTRATIVE',
    },
    {
      triggerEventType: 'beh.bip.feedback_requested',
      // null target_role — the worker uses payload.recipientAccountId /
      // accountId fallback to land on the specific teacher_id, mirroring
      // the Cycle 8 tkt.ticket.assigned pattern. The Step 5 FeedbackService
      // emits the inbound event with the teacher's account id pre-resolved.
      targetRole: null,
      titleTemplate: 'BIP feedback requested: {student_name}',
      descriptionTemplate:
        'Counsellor {requester_name} has requested your observations on the behaviour intervention plan strategies.',
      priority: 'NORMAL',
      dueOffsetHours: 72,
      category: 'ADMINISTRATIVE',
    },
  ];

  for (const spec of ruleSpecs) {
    const ruleId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tsk_auto_task_rules (id, school_id, trigger_event_type, target_role, title_template, description_template, priority, due_offset_hours, task_category, is_system, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, true, true)',
      ruleId,
      schoolId,
      spec.triggerEventType,
      spec.targetRole,
      spec.titleTemplate,
      spec.descriptionTemplate,
      spec.priority,
      spec.dueOffsetHours,
      spec.category,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tsk_auto_task_actions (id, rule_id, action_type, action_config, sort_order) ' +
        "VALUES ($1::uuid, $2::uuid, 'CREATE_TASK', '{}'::jsonb, 0)",
      generateId(),
      ruleId,
    );
  }
  console.log(
    '     - beh.incident.reported -> SCHOOL_ADMIN ADMINISTRATIVE 24h; beh.bip.feedback_requested -> recipient teacher ADMINISTRATIVE 72h',
  );

  console.log('');
  console.log('  Behaviour seed complete. ' + TODAY_ISO);
}

seedBehaviour()
  .then(() => disconnectAll())
  .catch(async (err) => {
    console.error(err);
    await disconnectAll();
    process.exit(1);
  });
