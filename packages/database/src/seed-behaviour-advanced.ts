import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-behaviour-advanced.ts — Phase 2 Cycle 14 Step 2.
 *
 * Idempotent. Gated on whether sis_restorative_justice_conferences already has
 * rows for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Seeds:
 *   A) 1 RJ conference (AGREEMENT_REACHED) linked to a Cycle 9 discipline
 *      incident, with 3 agreement actions:
 *      - 1 COMPLETED (letter of apology, verified by Hayes)
 *      - 1 PENDING (conflict resolution workshop, due +14d)
 *      - 1 OVERDUE (follow-up check-in, due 2 days ago)
 *   B) 2 peer mediations:
 *      - 1 RESOLVED (friendship conflict, with outcome)
 *      - 1 REFERRED (pending scheduling)
 *   C) 15 positive behaviour points across 4 students, 3 categories
 *      (Respect, Responsibility, Leadership).
 *   D) 4 behaviour rewards:
 *      - Homework Pass 50pts INDIVIDUAL (unlimited)
 *      - Extra Recess 100pts CLASS (unlimited)
 *      - Sticker 10pts PHYSICAL (50 available)
 *      - Digital Badge 25pts DIGITAL (unlimited)
 *   E) 2 redemption rows in sis_positive_behaviour_points
 *      (transaction_type=REDEMPTION):
 *      - Maya redeems Homework Pass (50pts)
 *      - Aiden redeems Sticker (10pts)
 */

const TENANT_SCHEMA = 'tenant_demo';

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

async function seedBehaviourAdvanced() {
  console.log('');
  console.log(
    '  Behaviour Advanced Seed (P2C14 Step 2 — RJ conferences + peer mediation + positive behaviour points + rewards)',
  );
  console.log('');

  const client = getPlatformClient();

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

  // ── Idempotency gate ──────────────────────────────────────────
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.sis_restorative_justice_conferences WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0] && existing[0].c > 0) {
    console.log(
      '  sis_restorative_justice_conferences already populated for demo school — skipping',
    );
    return;
  }

  const [riveraEmpId, hayesEmpId, mitchellEmpId] = await Promise.all([
    findEmployeeId('teacher@demo.campusos.dev'),
    findEmployeeId('counsellor@demo.campusos.dev'),
    findEmployeeId('principal@demo.campusos.dev'),
  ]);

  const [mayaStudentId, ethanStudentId] = await Promise.all([
    findStudentIdByName('Maya', 'Chen'),
    findStudentIdByName('Ethan', 'Rodriguez'),
  ]);

  // Find Aiden + Sofia + Olivia for additional positive-point recipients.
  // The Cycle 1 + 6 seed lands at least 15 students. We pick by grade+enrolment.
  const otherStudents = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'WHERE s.school_id = $1::uuid AND s.id NOT IN ($2::uuid, $3::uuid) ' +
      'ORDER BY s.created_at LIMIT 4',
    schoolId,
    mayaStudentId,
    ethanStudentId,
  )) as Array<{ id: string }>;
  if (otherStudents.length < 2) throw new Error('Need at least 4 other students for seed');
  const aidenStudentId = otherStudents[0].id;
  const sofiaStudentId = otherStudents[1].id;
  const mediatorStudentId = otherStudents[2]?.id ?? aidenStudentId;
  const partyBStudentId = otherStudents[3]?.id ?? sofiaStudentId;

  // Find an existing Cycle 9 incident to link the RJ conference to.
  const incidentRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_discipline_incidents WHERE school_id = $1::uuid AND student_id = $2::uuid LIMIT 1',
    schoolId,
    ethanStudentId,
  )) as Array<{ id: string }>;
  let incidentId: string;
  if (incidentRows.length > 0) {
    incidentId = incidentRows[0].id;
  } else {
    // Fall back to any incident in the school.
    const anyIncident = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_discipline_incidents WHERE school_id = $1::uuid LIMIT 1',
      schoolId,
    )) as Array<{ id: string }>;
    if (anyIncident.length === 0)
      throw new Error('No sis_discipline_incidents found — run seed:behaviour first');
    incidentId = anyIncident[0].id;
  }

  // ── A) RJ conference ─────────────────────────────────────────
  console.log('  A) RJ conference + 3 agreement actions');
  const confId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_restorative_justice_conferences ' +
      '(id, school_id, incident_id, facilitator_id, offender_student_id, harmed_party_ids, ' +
      ' parent_notified_at, conference_date, conference_location, conference_notes, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, ARRAY[$6::uuid], ' +
      ' $7::timestamptz, $8::timestamptz, $9, $10, $11)',
    confId,
    schoolId,
    incidentId,
    hayesEmpId,
    ethanStudentId,
    mayaStudentId,
    isoDateOffset(-3) + 'T15:00:00Z',
    isoDateOffset(-2) + 'T14:00:00Z',
    'Counsellor office, Room 201',
    'Ethan acknowledged pushing Maya. Maya described how it affected her. Both agreed to written actions.',
    'AGREEMENT_REACHED',
  );

  // Action 1 — COMPLETED letter of apology
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_rj_agreement_actions ' +
      '(id, conference_id, action_description, assigned_to_student_id, due_date, status, completed_at, verified_by, evidence_notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::date, $6, $7::timestamptz, $8::uuid, $9)',
    generateId(),
    confId,
    'Write a letter of apology to Maya describing what happened and what you will do differently.',
    ethanStudentId,
    isoDateOffset(1),
    'COMPLETED',
    isoDateOffset(-1) + 'T16:00:00Z',
    hayesEmpId,
    'Letter delivered to Maya in counsellor office. Maya accepted.',
  );

  // Action 2 — PENDING workshop attendance
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_rj_agreement_actions ' +
      '(id, conference_id, action_description, assigned_to_student_id, due_date, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::date, $6)',
    generateId(),
    confId,
    'Attend conflict resolution workshop with counsellor.',
    ethanStudentId,
    isoDateOffset(14),
    'PENDING',
  );

  // Action 3 — OVERDUE check-in (due 2 days ago, still PENDING — OverdueWorker will flip)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_rj_agreement_actions ' +
      '(id, conference_id, action_description, assigned_to_student_id, due_date, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::date, $6)',
    generateId(),
    confId,
    'Complete a follow-up check-in with counsellor.',
    ethanStudentId,
    isoDateOffset(-2),
    'OVERDUE',
  );

  // ── B) Peer mediations ───────────────────────────────────────
  console.log('  B) peer mediations (1 RESOLVED + 1 REFERRED)');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_peer_mediations ' +
      '(id, school_id, mediator_student_id, party_a_student_id, party_b_student_id, referred_by, ' +
      ' conflict_description, mediation_date, outcome, status, is_mediator_trained) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8::timestamptz, $9, $10, $11)',
    generateId(),
    schoolId,
    mediatorStudentId,
    aidenStudentId,
    sofiaStudentId,
    riveraEmpId,
    'Friendship conflict over a lunch group exclusion incident.',
    isoDateOffset(-5) + 'T13:00:00Z',
    'Both parties agreed to a respectful conversation and to sit together at lunch this week.',
    'RESOLVED',
    true,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_peer_mediations ' +
      '(id, school_id, mediator_student_id, party_a_student_id, party_b_student_id, referred_by, ' +
      ' conflict_description, status, is_mediator_trained) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9)',
    generateId(),
    schoolId,
    mediatorStudentId,
    mayaStudentId,
    partyBStudentId,
    hayesEmpId,
    'Pending scheduling — minor classroom dispute referred for mediation.',
    'REFERRED',
    true,
  );

  // ── C) Behaviour rewards ─────────────────────────────────────
  console.log('  C) 4 behaviour rewards');
  const homeworkPassId = generateId();
  const extraRecessId = generateId();
  const stickerId = generateId();
  const digitalBadgeId = generateId();

  const rewards = [
    {
      id: homeworkPassId,
      name: 'Homework Pass',
      description: 'Skip one homework assignment without penalty.',
      cost: 50,
      type: 'INDIVIDUAL',
      qty: null as number | null,
    },
    {
      id: extraRecessId,
      name: 'Extra Recess',
      description: 'Whole-class reward — extra 15 minutes of recess for the day.',
      cost: 100,
      type: 'CLASS',
      qty: null,
    },
    {
      id: stickerId,
      name: 'Sticker',
      description: 'Choose a sticker from the prize box.',
      cost: 10,
      type: 'PHYSICAL',
      qty: 50,
    },
    {
      id: digitalBadgeId,
      name: 'Digital Badge',
      description: 'Earn a digital achievement badge on your profile.',
      cost: 25,
      type: 'DIGITAL',
      qty: null,
    },
  ];
  for (const r of rewards) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_behaviour_rewards (id, school_id, reward_name, description, points_cost, reward_type, quantity_available) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
      r.id,
      schoolId,
      r.name,
      r.description,
      r.cost,
      r.type,
      r.qty,
    );
  }

  // ── D) Positive behaviour points (15 AWARDs across 4 students, 3 categories) ──
  console.log('  D) 15 positive behaviour AWARDs');
  const studentList = [mayaStudentId, ethanStudentId, aidenStudentId, sofiaStudentId];
  const categories: Array<{ cat: string; points: number; reason: string }> = [
    { cat: 'Respect', points: 5, reason: 'Held the door open for a classmate.' },
    { cat: 'Respect', points: 10, reason: 'Helped a struggling classmate with classwork.' },
    { cat: 'Respect', points: 5, reason: 'Showed kindness to a new student.' },
    { cat: 'Responsibility', points: 10, reason: 'Submitted all homework on time this week.' },
    { cat: 'Responsibility', points: 5, reason: 'Arrived on time every day this week.' },
    { cat: 'Responsibility', points: 5, reason: 'Returned a found item to the office.' },
    { cat: 'Leadership', points: 15, reason: 'Led the group project successfully.' },
    { cat: 'Leadership', points: 10, reason: 'Volunteered to peer tutor.' },
    { cat: 'Respect', points: 5, reason: 'Cleaned up classroom without being asked.' },
    { cat: 'Responsibility', points: 10, reason: 'Reported a safety issue to staff.' },
    { cat: 'Leadership', points: 10, reason: 'Mediated a classmate dispute.' },
    { cat: 'Respect', points: 5, reason: 'Showed empathy during a difficult moment.' },
    { cat: 'Responsibility', points: 5, reason: 'Took initiative on a class chore.' },
    { cat: 'Leadership', points: 10, reason: 'Captain of the spirit week committee.' },
    { cat: 'Respect', points: 5, reason: 'Modelled active listening in discussion.' },
  ];
  for (let i = 0; i < categories.length; i++) {
    const student = studentList[i % studentList.length];
    const awarder = i % 2 === 0 ? riveraEmpId : hayesEmpId;
    const c = categories[i];
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_positive_behaviour_points ' +
        '(id, school_id, student_id, awarded_by, transaction_type, category, points, reason, awarded_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, now() - ($9 || $10)::interval)',
      generateId(),
      schoolId,
      student,
      awarder,
      'AWARD',
      c.cat,
      c.points,
      c.reason,
      i.toString(),
      ' days',
    );
  }

  // ── E) 2 redemptions ─────────────────────────────────────────
  console.log('  E) 2 redemptions');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_positive_behaviour_points ' +
      '(id, school_id, student_id, awarded_by, transaction_type, points, reason, reward_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)',
    generateId(),
    schoolId,
    mayaStudentId,
    hayesEmpId,
    'REDEMPTION',
    50,
    'Redeemed Homework Pass',
    homeworkPassId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_positive_behaviour_points ' +
      '(id, school_id, student_id, awarded_by, transaction_type, points, reason, reward_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::uuid)',
    generateId(),
    schoolId,
    aidenStudentId,
    riveraEmpId,
    'REDEMPTION',
    10,
    'Redeemed Sticker',
    stickerId,
  );

  // Decrement sticker quantity_available (50 -> 49) since one was redeemed
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      '.sis_behaviour_rewards SET quantity_available = quantity_available - 1 WHERE id = $1::uuid AND quantity_available IS NOT NULL',
    stickerId,
  );

  console.log('');
  console.log('  Behaviour Advanced seed COMPLETE');
  console.log('');
}

seedBehaviourAdvanced()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
