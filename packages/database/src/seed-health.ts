import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-health.ts — Cycle 10 Step 4.
 *
 * Idempotent. Gated on whether hlth_student_health_records already has
 * a row for Maya. Re-running is a no-op once the seed has landed.
 *
 * Eight sections:
 *   A) Maya's hlth_student_health_records — A+ blood type, structured
 *      JSONB allergies (Peanuts SEVERE Anaphylaxis + Dust mites MILD),
 *      Dr. Lee physician contact, emergency_medical_notes referencing
 *      the asthma plan.
 *   B) 2 hlth_medical_conditions — Asthma MODERATE ACTIVE with
 *      management_plan + Seasonal allergies MILD ACTIVE.
 *   C) 3 hlth_immunisations — DTaP CURRENT 2024-09, Flu OVERDUE due
 *      2025-10 (drives the OVERDUE compliance dashboard), MMR CURRENT
 *      2023-08.
 *   D) 1 hlth_medications + 1 hlth_medication_schedule + 2 hlth_medication_administrations
 *      Albuterol Inhaler INHALER PRN + scheduled 08:00 daily slot.
 *      Administration 1 — yesterday, administered by Sarah Mitchell
 *      (the school nurse stand-in), 1 puff, parent_notified=true.
 *      Administration 2 — today's slot was missed with reason
 *      STUDENT_ABSENT (Maya was out sick); was_missed=true,
 *      administered_at NULL per the missed_chk invariant.
 *   E) 2 hlth_nurse_visits —
 *        V1 Maya, yesterday, COMPLETED, reason "Wheezing episode",
 *           treatment "Administered inhaler", parent_notified=true,
 *           sent_home=false, follow_up_required=false.
 *        V2 Ethan Rodriguez, last week, COMPLETED, reason "Headache",
 *           treatment "Rest and water", parent_notified=false,
 *           sent_home=false.
 *   F) 1 hlth_iep_plans — Maya, plan_type=504, status=ACTIVE,
 *      case_manager_id=Hayes (counsellor). 2 hlth_iep_goals —
 *      Extended Time compliance baseline 60 percent target 90
 *      ACTIVE; Reduced Distraction compliance baseline qualitative
 *      target qualitative ACTIVE. 1 hlth_iep_goal_progress entry on
 *      goal 1 — recorded by Hayes, 75 percent. 1 hlth_iep_services —
 *      Speech therapy 30 min 2x weekly PULL_OUT. 2 hlth_iep_accommodations
 *      EXTENDED_TIME ALL_ASSESSMENTS effective 2025-08-15 +
 *      REDUCED_DISTRACTION ALL_ASSESSMENTS effective 2025-08-15.
 *   G) 1 hlth_screenings — Maya VISION 2026-04-01 REFER, screened by
 *      Marcus Hayes, follow_up_required=true, follow_up_completed=false,
 *      referral_notes "Schedule ophthalmologist appointment for further
 *      evaluation". This drives the Step 9 follow-up queue partial
 *      INDEX.
 *   H) 1 hlth_dietary_profiles — Maya, dietary_restrictions=ARRAY
 *      empty (no special dietary needs beyond the allergen),
 *      allergens=JSONB Peanuts SEVERE, pos_allergen_alert=true so
 *      the future POS / cafeteria integration shows a hard-stop alert.
 *
 *   I) 2 sis_student_active_accommodations rows — direct seed write
 *      to demonstrate the ADR-030 read model shape. Both rows
 *      reference Maya's source IEP accommodation rows from section
 *      F via source_iep_accommodation_id. Step 7 IepAccommodationConsumer
 *      will maintain these going forward via Kafka events.
 */

const TENANT_SCHEMA = 'tenant_demo';
const TODAY_ISO = new Date().toISOString();

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

function isoTimestampOffsetDays(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString();
}

async function seedHealth() {
  console.log('');
  console.log(
    '  Health Seed (Cycle 10 Step 4 — Maya health record + IEP + medications + visits + screening + dietary)',
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
    return rows[0]!.id;
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
    return rows[0]!.id;
  }

  const [mitchellEmpId, hayesEmpId] = await Promise.all([
    findEmployeeId('principal@demo.campusos.dev'),
    findEmployeeId('counsellor@demo.campusos.dev'),
  ]);

  const [mayaStudentId, ethanStudentId] = await Promise.all([
    findStudentIdByName('Maya', 'Chen'),
    findStudentIdByName('Ethan', 'Rodriguez'),
  ]);

  // Idempotency gate — checks hlth_student_health_records for Maya.
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.hlth_student_health_records WHERE student_id = $1::uuid',
    mayaStudentId,
  )) as Array<{ c: number }>;
  if (existing[0] && existing[0].c > 0) {
    console.log("  Maya's health record already exists — skipping");
    return;
  }

  // ── 2. Health record + conditions + immunisations ─────────────
  console.log('  A) health record:');
  const recordId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_student_health_records ' +
      '(id, school_id, student_id, blood_type, allergies, emergency_medical_notes, physician_name, physician_phone) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8)',
    recordId,
    schoolId,
    mayaStudentId,
    'A+',
    JSON.stringify([
      {
        allergen: 'Peanuts',
        severity: 'SEVERE',
        reaction: 'Anaphylaxis',
        notes: 'Carries an EpiPen at all times.',
      },
      { allergen: 'Dust mites', severity: 'MILD', reaction: 'Sneezing', notes: null },
    ]),
    'Asthma management plan on file. Inhaler available in the nurse office.',
    'Dr. Sarah Lee',
    '+1-217-555-9000',
  );
  console.log('     - Maya Chen, A+, peanut SEVERE allergy, Dr. Lee');

  console.log('  B) 2 conditions:');
  const condAsthmaId = generateId();
  const condAllergiesId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_medical_conditions ' +
      '(id, health_record_id, condition_name, diagnosis_date, is_active, severity, management_plan) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7), ' +
      '       ($8::uuid, $9::uuid, $10, $11::date, $12, $13, $14)',
    condAsthmaId,
    recordId,
    'Asthma',
    '2020-05-15',
    true,
    'MODERATE',
    'PRN albuterol inhaler. Avoid known triggers: dust, cold air, exercise without warm-up. Notify parent on every wheezing episode.',
    condAllergiesId,
    recordId,
    'Seasonal allergies',
    '2022-03-10',
    true,
    'MILD',
    'Loratadine PRN during allergy season. No urgent action required for typical sneezing.',
  );
  console.log('     - Asthma MODERATE ACTIVE + Seasonal allergies MILD ACTIVE');

  console.log('  C) 3 immunisations:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_immunisations ' +
      '(id, health_record_id, vaccine_name, administered_date, due_date, administered_by, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, NULL, $5, $6), ' +
      '       ($7::uuid, $8::uuid, $9, NULL, $10::date, NULL, $11), ' +
      '       ($12::uuid, $13::uuid, $14, $15::date, NULL, $16, $17)',
    generateId(),
    recordId,
    'DTaP',
    '2024-09-15',
    'Springfield Pediatrics — Dr. Lee',
    'CURRENT',
    generateId(),
    recordId,
    'Influenza (annual)',
    '2025-10-15',
    'OVERDUE',
    generateId(),
    recordId,
    'MMR',
    '2023-08-20',
    'Springfield Pediatrics — Dr. Lee',
    'CURRENT',
  );
  console.log('     - DTaP CURRENT 2024-09, Flu OVERDUE due 2025-10, MMR CURRENT 2023-08');

  // ── 3. Medication + schedule + administrations ────────────────
  console.log('  D) 1 medication + schedule + 2 administrations (1 administered, 1 missed):');
  const medId = generateId();
  const slotId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_medications ' +
      '(id, health_record_id, medication_name, dosage, frequency, route, prescribing_physician, is_self_administered, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9)',
    medId,
    recordId,
    'Albuterol Inhaler',
    '90mcg per puff',
    '2 puffs PRN, plus scheduled 08:00 daily',
    'INHALER',
    'Dr. Sarah Lee',
    true,
    true,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_medication_schedule ' +
      '(id, medication_id, scheduled_time, day_of_week, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::time, NULL, $4)',
    slotId,
    medId,
    '08:00',
    'Morning preventive dose before first period.',
  );
  // Administration 1 — yesterday, administered
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_medication_administrations ' +
      '(id, medication_id, schedule_entry_id, administered_by, administered_at, dose_given, notes, parent_notified, was_missed, missed_reason) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, $6, $7, $8, $9, NULL)',
    generateId(),
    medId,
    slotId,
    mitchellEmpId,
    isoTimestampOffsetDays(-1).slice(0, 10) + 'T08:05:00Z',
    '2 puffs',
    'Morning slot. Maya tolerated it well. No wheezing observed.',
    true,
    false,
  );
  // Administration 2 — today's slot missed (Maya absent)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_medication_administrations ' +
      '(id, medication_id, schedule_entry_id, administered_by, administered_at, dose_given, notes, parent_notified, was_missed, missed_reason) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, NULL, NULL, NULL, $4, false, $5, $6)',
    generateId(),
    medId,
    slotId,
    'Maya absent today — missed morning dose. Will be covered tomorrow if she returns.',
    true,
    'STUDENT_ABSENT',
  );
  console.log('     - Albuterol inhaler 08:00 daily; 1 administered yesterday, 1 missed today');

  // ── 4. Nurse visits ───────────────────────────────────────────
  console.log('  E) 2 nurse visits:');
  // V1 — Maya wheezing yesterday (linked to the inhaler administration)
  const visitMayaIso = isoTimestampOffsetDays(-1).slice(0, 10) + 'T10:30:00Z';
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_nurse_visits ' +
      '(id, school_id, visited_person_id, visited_person_type, nurse_id, visit_date, status, signed_in_at, signed_out_at, reason, treatment_given, parent_notified, sent_home, sent_home_at, follow_up_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, NULL, $14)',
    generateId(),
    schoolId,
    mayaStudentId,
    'STUDENT',
    mitchellEmpId,
    visitMayaIso,
    'COMPLETED',
    visitMayaIso,
    isoTimestampOffsetDays(-1).slice(0, 10) + 'T10:50:00Z',
    'Wheezing episode after gym class',
    'Administered albuterol inhaler 2 puffs. Resting period observed for 15 minutes. Symptoms resolved.',
    true,
    false,
    false,
  );
  // V2 — Ethan headache last week
  const visitEthanIso = isoTimestampOffsetDays(-7).slice(0, 10) + 'T13:15:00Z';
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_nurse_visits ' +
      '(id, school_id, visited_person_id, visited_person_type, nurse_id, visit_date, status, signed_in_at, signed_out_at, reason, treatment_given, parent_notified, sent_home, sent_home_at, follow_up_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, NULL, $14)',
    generateId(),
    schoolId,
    ethanStudentId,
    'STUDENT',
    mitchellEmpId,
    visitEthanIso,
    'COMPLETED',
    visitEthanIso,
    isoTimestampOffsetDays(-7).slice(0, 10) + 'T13:35:00Z',
    'Headache complaint',
    'Rest and water. Symptoms resolved within 20 minutes. No medication given.',
    false,
    false,
    false,
  );
  console.log('     - Maya wheezing yesterday COMPLETED + Ethan headache last week COMPLETED');

  // ── 5. IEP plan + goals + progress + service + accommodations ──
  console.log(
    '  F) 1 IEP plan (504, ACTIVE) + 2 goals + 1 progress + 1 service + 2 accommodations:',
  );
  const planId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_iep_plans ' +
      '(id, school_id, student_id, plan_type, status, start_date, review_date, case_manager_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7::date, $8::uuid)',
    planId,
    schoolId,
    mayaStudentId,
    '504',
    'ACTIVE',
    '2025-08-15',
    isoDateOffset(60),
    hayesEmpId,
  );
  const goalExtId = generateId();
  const goalDistId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_iep_goals ' +
      '(id, iep_plan_id, goal_text, measurement_criteria, baseline, target_value, current_value, goal_area, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9), ' +
      '       ($10::uuid, $11::uuid, $12, $13, $14, $15, $16, $17, $18)',
    goalExtId,
    planId,
    'Demonstrate compliance with extended time accommodation across all assessments',
    'Percentage of assessments completed within the extended time window without distress signals',
    '60 percent',
    '90 percent',
    '75 percent',
    'Academic',
    'ACTIVE',
    goalDistId,
    planId,
    'Demonstrate ability to use the reduced-distraction setting effectively across all assessments',
    'Qualitative observation of focus and task completion in the reduced-distraction environment',
    'Frequent off-task behaviour',
    'Sustained focus throughout assessment duration',
    'Mixed observations',
    'Behavioural',
    'ACTIVE',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_iep_goal_progress ' +
      '(id, goal_id, recorded_by, progress_value, observation_notes, recorded_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)',
    generateId(),
    goalExtId,
    hayesEmpId,
    '75 percent',
    'Steady improvement observed over the past month. Maya completed 3 of 4 recent assessments within the extended window without distress.',
    isoTimestampOffsetDays(-7),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_iep_services ' +
      '(id, iep_plan_id, service_type, provider_name, frequency, minutes_per_session, delivery_method) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
    generateId(),
    planId,
    'Speech therapy',
    'Sarah Reynolds (district SLP)',
    '2x weekly',
    30,
    'PULL_OUT',
  );
  const accExtId = generateId();
  const accDistId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_iep_accommodations ' +
      '(id, iep_plan_id, accommodation_type, description, applies_to, specific_assignment_types, effective_from) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, $6::date), ' +
      '       ($7::uuid, $8::uuid, $9, $10, $11, NULL, $12::date)',
    accExtId,
    planId,
    'EXTENDED_TIME',
    'Maya receives 1.5x time on all assessments and quizzes.',
    'ALL_ASSESSMENTS',
    '2025-08-15',
    accDistId,
    planId,
    'REDUCED_DISTRACTION',
    'Maya completes assessments in a quiet alternate location separate from the main classroom.',
    'ALL_ASSESSMENTS',
    '2025-08-15',
  );
  console.log(
    '     - 504 ACTIVE plan, 2 goals (1 with progress entry), Speech therapy 30min 2x weekly PULL_OUT, EXTENDED_TIME + REDUCED_DISTRACTION ALL_ASSESSMENTS',
  );

  // ── 6. Screening ──────────────────────────────────────────────
  console.log('  G) 1 screening:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_screenings ' +
      '(id, school_id, student_id, screening_type, screening_date, screened_by, result, result_notes, follow_up_required, follow_up_completed, referral_notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::uuid, $7, $8, $9, $10, $11)',
    generateId(),
    schoolId,
    mayaStudentId,
    'VISION',
    '2026-04-01',
    hayesEmpId,
    'REFER',
    'Distance vision below threshold in left eye. Right eye within normal range.',
    true,
    false,
    'Schedule ophthalmologist appointment for further evaluation.',
  );
  console.log('     - Maya VISION REFER follow-up required (drives admin queue)');

  // ── 7. Dietary profile ────────────────────────────────────────
  console.log('  H) 1 dietary profile with POS allergen alert:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_dietary_profiles ' +
      '(id, school_id, student_id, dietary_restrictions, allergens, special_meal_instructions, pos_allergen_alert) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text[], $5::jsonb, $6, $7)',
    generateId(),
    schoolId,
    mayaStudentId,
    [],
    JSON.stringify([{ allergen: 'Peanuts', severity: 'SEVERE', reaction: 'Anaphylaxis' }]),
    'Strict no-peanuts protocol. Verify ingredient lists at every service.',
    true,
  );
  console.log('     - Maya peanut SEVERE pos_allergen_alert=true');

  // ── 8. ADR-030 read model rows ────────────────────────────────
  console.log('  I) 2 sis_student_active_accommodations rows (ADR-030 read model demo):');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_active_accommodations ' +
      '(id, school_id, student_id, plan_type, accommodation_type, description, applies_to, specific_assignment_types, effective_from, source_iep_accommodation_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, NULL, $8::date, $9::uuid), ' +
      '       ($10::uuid, $11::uuid, $12::uuid, $13, $14, $15, $16, NULL, $17::date, $18::uuid)',
    generateId(),
    schoolId,
    mayaStudentId,
    '504',
    'EXTENDED_TIME',
    'Maya receives 1.5x time on all assessments and quizzes.',
    'ALL_ASSESSMENTS',
    '2025-08-15',
    accExtId,
    generateId(),
    schoolId,
    mayaStudentId,
    '504',
    'REDUCED_DISTRACTION',
    'Maya completes assessments in a quiet alternate location separate from the main classroom.',
    'ALL_ASSESSMENTS',
    '2025-08-15',
    accDistId,
  );
  console.log('     - EXTENDED_TIME + REDUCED_DISTRACTION upserted by source_iep_accommodation_id');

  console.log('');
  console.log('  Health seed complete. ' + TODAY_ISO);
}

seedHealth()
  .then(() => disconnectAll())
  .catch(async (err) => {
    console.error(err);
    await disconnectAll();
    process.exit(1);
  });
