import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-wellbeing.ts — Cycle 11.1 Step 3.
 *
 * Idempotent. Gated on whether svc_wellbeing_survey_templates already
 * has rows for the demo school. Re-running is a no-op once the seed
 * has landed.
 *
 * Six sections:
 *   A) 1 svc_wellbeing_survey_templates row — "Weekly Emotional
 *      Check-In" by Hayes (counsellor), frequency_recommendation=
 *      WEEKLY, is_active=true.
 *   B) 5 svc_wellbeing_questions rows on the template, in sort_order:
 *        Q1 EMOTIONAL  SCALE_1_5    "How are you feeling today?"
 *        Q2 SOCIAL     SCALE_1_5    "Do you feel connected to your classmates?"
 *        Q3 SAFETY     YES_NO       "Do you want to talk to someone about something?"
 *        Q4 EMOTIONAL  EMOJI_SCALE  "How was your week overall?"
 *        Q5 ACADEMIC   SCALE_1_5    "How confident do you feel about your schoolwork?"
 *   C) 1 svc_wellbeing_deployments row — CASELOAD targeting (Hayes's
 *      active caseload, which auto-resolves to Maya at the Step 4
 *      service layer; the seed plants Ethan's check-in as a second
 *      participant to exercise the multi-student deployment shape per
 *      the plan), status=ACTIVE, deployed last week, total_targeted=2,
 *      total_completed=1.
 *   D) 2 svc_wellbeing_checkins rows:
 *        - Maya, COMPLETED last week, flagged_for_follow_up=true,
 *          assigned_counselor=Hayes (Q3 YES triggers the Step 5 alert
 *          evaluation logic which sets the flag and creates the
 *          WANTS_TO_TALK alert below).
 *        - Ethan, completed_at=null (PENDING — demonstrates the Step 7
 *          student UI pending state). Linked to the same deployment so
 *          the dashboard rollup reads total_targeted=2.
 *   E) 5 svc_wellbeing_responses rows for Maya's completed check-in:
 *        Q1 numeric=3 (mid-range)
 *        Q2 numeric=4 (connected)
 *        Q3 numeric=1 (YES — wants to talk; this row is the alert trigger)
 *        Q4 numeric=3 (mid emoji)
 *        Q5 numeric=4 (confident)
 *   F) 1 svc_wellbeing_alerts row — WANTS_TO_TALK linked to Maya's Q3
 *      response, status=ACKNOWLEDGED, acknowledged_by=Hayes,
 *      resolution_notes "Scheduled a 1:1 session to discuss.".
 */

const TENANT_SCHEMA = 'tenant_demo';

function isoDateOffset(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d;
}

async function seedWellbeing() {
  console.log('');
  console.log('  Wellbeing Seed (Cycle 11.1 Step 3 — Templates + Deployment + Check-Ins + Alert)');
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

  const hayesEmpId = await findEmployeeId('counsellor@demo.campusos.dev');
  const mayaStudentId = await findStudentIdByName('Maya', 'Chen');
  const ethanStudentId = await findStudentIdByName('Ethan', 'Rodriguez');

  // ── 2. Idempotency gate ──────────────────────────────────────
  const existingTemplates = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_survey_templates WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingTemplates[0] && existingTemplates[0].c > 0) {
    console.log('  svc_wellbeing_survey_templates already populated for demo school — skipping');
    return;
  }

  // ── 3. Template + 5 questions ─────────────────────────────────
  console.log('  A) survey template:');
  const templateId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_survey_templates (id, school_id, name, description, frequency_recommendation, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Weekly Emotional Check-In', $3, 'WEEKLY', true, $4::uuid)",
    templateId,
    schoolId,
    'A short weekly pulse to surface how students are feeling across emotional, social, safety, and academic dimensions. Question 3 (Do you want to talk to someone?) triggers a WANTS_TO_TALK alert when answered YES so the counsellor can follow up.',
    hayesEmpId,
  );
  console.log("     - 1 template 'Weekly Emotional Check-In' (Hayes, WEEKLY, ACTIVE)");

  console.log('  B) 5 questions:');
  const q1Id = generateId();
  const q2Id = generateId();
  const q3Id = generateId();
  const q4Id = generateId();
  const q5Id = generateId();

  const questions: Array<{
    id: string;
    text: string;
    type: string;
    domain: string;
    sort: number;
  }> = [
    {
      id: q1Id,
      text: 'How are you feeling today?',
      type: 'SCALE_1_5',
      domain: 'EMOTIONAL',
      sort: 0,
    },
    {
      id: q2Id,
      text: 'Do you feel connected to your classmates?',
      type: 'SCALE_1_5',
      domain: 'SOCIAL',
      sort: 1,
    },
    {
      id: q3Id,
      text: 'Do you want to talk to someone about something?',
      type: 'YES_NO',
      domain: 'SAFETY',
      sort: 2,
    },
    {
      id: q4Id,
      text: 'How was your week overall?',
      type: 'EMOJI_SCALE',
      domain: 'EMOTIONAL',
      sort: 3,
    },
    {
      id: q5Id,
      text: 'How confident do you feel about your schoolwork?',
      type: 'SCALE_1_5',
      domain: 'ACADEMIC',
      sort: 4,
    },
  ];

  for (const q of questions) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.svc_wellbeing_questions (id, template_id, question_text, question_type, domain, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
      q.id,
      templateId,
      q.text,
      q.type,
      q.domain,
      q.sort,
    );
    console.log('     - Q' + (q.sort + 1) + ' ' + q.domain + '/' + q.type + ' "' + q.text + '"');
  }

  // ── 4. Deployment ────────────────────────────────────────────
  console.log('  C) deployment:');
  const deploymentId = generateId();
  const deployedAt = isoDateOffset(-7); // last week
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_deployments (id, school_id, template_id, deployed_by, deploy_at, target_type, target_ids, status, total_targeted, total_completed) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, 'CUSTOM_LIST', ARRAY[$6::uuid, $7::uuid], 'ACTIVE', 2, 1)",
    deploymentId,
    schoolId,
    templateId,
    hayesEmpId,
    deployedAt.toISOString(),
    mayaStudentId,
    ethanStudentId,
  );
  console.log(
    '     - 1 deployment CUSTOM_LIST [Maya, Ethan] ACTIVE deployed=' +
      deployedAt.toISOString().slice(0, 10) +
      ' total_targeted=2 total_completed=1',
  );

  // ── 5. Check-ins ─────────────────────────────────────────────
  console.log('  D) 2 check-ins:');
  const mayaCheckinId = generateId();
  const ethanCheckinId = generateId();
  const mayaCompletedAt = isoDateOffset(-5);

  // Maya — COMPLETED + flagged_for_follow_up=true (Q3 YES triggered the alert)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_checkins (id, school_id, student_id, template_id, deployment_id, completed_at, flagged_for_follow_up, assigned_counselor_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, true, $7::uuid)',
    mayaCheckinId,
    schoolId,
    mayaStudentId,
    templateId,
    deploymentId,
    mayaCompletedAt.toISOString(),
    hayesEmpId,
  );
  console.log(
    '     - Maya COMPLETED ' +
      mayaCompletedAt.toISOString().slice(0, 10) +
      ' flagged=true (Q3 YES triggered WANTS_TO_TALK)',
  );

  // Ethan — PENDING (completed_at=null)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_checkins (id, school_id, student_id, template_id, deployment_id, assigned_counselor_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid)',
    ethanCheckinId,
    schoolId,
    ethanStudentId,
    templateId,
    deploymentId,
    hayesEmpId,
  );
  console.log('     - Ethan PENDING (completed_at=null) — demonstrates student UI to-do list');

  // ── 6. 5 responses for Maya ───────────────────────────────────
  console.log("  E) 5 responses for Maya's completed check-in:");
  const responses: Array<{ id: string; questionId: string; numeric: number; comment: string }> = [
    { id: generateId(), questionId: q1Id, numeric: 3, comment: 'Q1 mid-range emotional' },
    { id: generateId(), questionId: q2Id, numeric: 4, comment: 'Q2 connected' },
    { id: generateId(), questionId: q3Id, numeric: 1, comment: 'Q3 YES — wants to talk (alert)' },
    { id: generateId(), questionId: q4Id, numeric: 3, comment: 'Q4 mid emoji' },
    { id: generateId(), questionId: q5Id, numeric: 4, comment: 'Q5 confident' },
  ];

  let mayaQ3ResponseId: string | null = null;
  for (const r of responses) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.svc_wellbeing_responses (id, checkin_id, question_id, numeric_response) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
      r.id,
      mayaCheckinId,
      r.questionId,
      r.numeric,
    );
    console.log('     - ' + r.comment + ' numeric=' + r.numeric);
    if (r.questionId === q3Id) mayaQ3ResponseId = r.id;
  }
  if (!mayaQ3ResponseId) throw new Error('Failed to capture Q3 response id');

  // ── 7. Alert ──────────────────────────────────────────────────
  console.log('  F) 1 alert:');
  const alertId = generateId();
  const alertAcknowledgedAt = isoDateOffset(-4);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_wellbeing_alerts (id, student_id, response_id, alert_type, status, acknowledged_by, acknowledged_at, resolution_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'WANTS_TO_TALK', 'ACKNOWLEDGED', $4::uuid, $5::timestamptz, $6)",
    alertId,
    mayaStudentId,
    mayaQ3ResponseId,
    hayesEmpId,
    alertAcknowledgedAt.toISOString(),
    "Scheduled a 1:1 session with Maya to discuss what's on her mind. Will follow up after the session and update the alert status to RESOLVED.",
  );
  console.log(
    '     - WANTS_TO_TALK Maya / Q3 response / status=ACKNOWLEDGED by Hayes ' +
      alertAcknowledgedAt.toISOString().slice(0, 10),
  );

  console.log('');
  console.log('  Wellbeing seed complete!');
}

seedWellbeing()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => process.exit(1));
  });
