import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-classroom-advanced.ts — Phase 2 Cycle 7 (P2-7) sub-cycle a Step 2.
 *
 * Idempotent. Gated on whether cls_hall_pass_settings has a row for the
 * demo school. Re-running is a no-op once the seed has landed.
 *
 * Seven sections, one per surface:
 *   A) 1 cls_hall_pass_settings row for the demo school with the
 *      schema defaults (max 3 concurrent, max 5 daily, 10 minute
 *      default duration, the 5-destination catalogue, teacher
 *      approval required).
 *   B) 5 cls_hall_passes covering all 4 lifecycle states —
 *      2 ACTIVE (Maya to Bathroom expected back in 5 minutes,
 *      Aiden to Library expected back in 8 minutes), 1 RETURNED
 *      (Maya to Nurse from earlier today, returned 4 minutes
 *      after issue), 1 OVERDUE (Ethan to Office issued 25
 *      minutes ago, expected back 15 minutes ago — drives the
 *      Step 6 OverdueWorker UI), 1 RECALLED (Maya to Other
 *      issued yesterday, admin recalled).
 *   C) 2 cls_rubrics — a template "Narrative Writing Rubric"
 *      with 4 criteria (Ideas + Organisation + Voice +
 *      Conventions, weights 25 + 25 + 25 + 25 summing to 100,
 *      max points 10 each) and an assignment-specific
 *      "Lab Report Rubric" with 3 criteria (Hypothesis +
 *      Method + Analysis, weights 30 + 30 + 40 summing to 100,
 *      max points 15 each). is_template flag distinguishes the
 *      shared library rubric from the per-assignment one.
 *   D) 8 cls_rubric_scores — 4 criteria scored on 2 different
 *      submissions for the Narrative Writing rubric. Each row
 *      carries points_awarded + performance_level (Excellent /
 *      Good / Developing / Beginning) + a short feedback note.
 *   E) 3 cls_class_moments — "Field trip to the museum",
 *      "Science fair winners", and "Last day of term party".
 *      Each is_approved=true (teacher-posted).
 *   F) 5 cls_class_moment_photos — 2 photos on the field trip
 *      moment, 2 on the science fair, 1 on the term party.
 *   G) 8 cls_class_moment_reactions — David Chen LIKEs the
 *      field trip + LOVE the science fair, Sarah Mitchell
 *      CELEBRATEs the science fair + LIKEs the field trip,
 *      Linda Park LIKEs the term party + LOVES the field trip,
 *      James Rivera LOVES the science fair + CELEBRATEs the
 *      term party.
 *
 * Cross-cycle dependencies:
 *   - sis_classes (Cycle 1)
 *   - sis_students (Cycle 1)
 *   - cls_submissions (Cycle 2) — for the rubric scores keystone
 *   - hr_employees (Cycle 4) — issued_by + posted_by + scored_by +
 *     created_by columns are soft FKs to hr_employees.id per ADR-055
 *   - platform.iam_person (Cycle 0) — reacted_by is a soft FK to
 *     iam_person.id since parents react via the class feed
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedClassroomAdvanced() {
  console.log('');
  console.log('  Classroom Advanced Seed (P2-7a Step 2 — Hall Passes + Rubrics + Class Moments)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. School lookup ────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate — has a settings row already landed?
  const existingSettings = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS count FROM ' +
      TENANT_SCHEMA +
      '.cls_hall_pass_settings WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ count: number }>;
  if (existingSettings[0]!.count > 0) {
    console.log(
      '  Classroom Advanced already seeded for demo school (cls_hall_pass_settings present). Skipping.',
    );
    return;
  }

  // ── 2. Resolve helper actors ────────────────────────────────
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
  async function findPersonId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT p.id::text AS id FROM platform.iam_person p ' +
        'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('iam_person not found for ' + email);
    return rows[0]!.id;
  }

  const teacherEmpId = await findEmployeeId('teacher@demo.campusos.dev');
  const principalEmpId = await findEmployeeId('principal@demo.campusos.dev');
  const teacherPersonId = await findPersonId('teacher@demo.campusos.dev');
  const principalPersonId = await findPersonId('principal@demo.campusos.dev');
  const parentPersonId = await findPersonId('parent@demo.campusos.dev');
  const vpPersonId = await findPersonId('vp@demo.campusos.dev');

  // ── 3. Resolve students + classes ───────────────────────────
  async function findStudentId(studentNumber: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_students WHERE student_number = $1',
      studentNumber,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('sis_students not found for ' + studentNumber);
    return rows[0]!.id;
  }
  const mayaId = await findStudentId('S-1001');
  const ethanId = await findStudentId('S-1002');
  // Aiden — pick any third student
  const aidenRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_students WHERE student_number NOT IN ('S-1001','S-1002') ORDER BY student_number LIMIT 1",
  )) as Array<{ id: string }>;
  if (aidenRows.length === 0) throw new Error('No third student found for hall pass demo');
  const aidenId = aidenRows[0]!.id;

  // Pick the first 2 classes — period 1 + period 2 from seed-sis
  const classes = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, section_code FROM ' +
      TENANT_SCHEMA +
      '.sis_classes ORDER BY section_code LIMIT 3',
  )) as Array<{ id: string; section_code: string }>;
  if (classes.length < 2)
    throw new Error('Need at least 2 sis_classes for the hall pass + moments seed');
  const class1Id = classes[0]!.id;
  const class2Id = classes[1]!.id;
  const class3Id = classes[2]?.id ?? class2Id;

  // Pick 2 cls_submissions for rubric scores
  const submissions = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, student_id::text AS student_id FROM ' +
      TENANT_SCHEMA +
      '.cls_submissions ORDER BY created_at LIMIT 2',
  )) as Array<{ id: string; student_id: string }>;
  if (submissions.length < 2)
    throw new Error('Need at least 2 cls_submissions — run seed:classroom first');

  // ── 4. Section A — settings ────────────────────────────────
  const settingsId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_pass_settings (id, school_id) VALUES ($1::uuid, $2::uuid)',
    settingsId,
    schoolId,
  );
  console.log('  ✓ A: 1 cls_hall_pass_settings row for demo school');

  // ── 5. Section B — 5 hall passes covering 4 lifecycle states ─
  // ACTIVE x 2
  const hp1Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_passes (id, school_id, student_id, class_id, issued_by, destination, ' +
      'issued_at, expected_return_at, status) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Bathroom', " +
      "now() - interval '2 minutes', now() + interval '5 minutes', 'ACTIVE')",
    hp1Id,
    schoolId,
    mayaId,
    class1Id,
    teacherEmpId,
  );
  const hp2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_passes (id, school_id, student_id, class_id, issued_by, destination, ' +
      'issued_at, expected_return_at, status) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Library', " +
      "now() - interval '1 minute', now() + interval '8 minutes', 'ACTIVE')",
    hp2Id,
    schoolId,
    aidenId,
    class2Id,
    teacherEmpId,
  );
  // RETURNED
  const hp3Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_passes (id, school_id, student_id, class_id, issued_by, destination, ' +
      'issued_at, expected_return_at, returned_at, status) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Nurse', " +
      "now() - interval '40 minutes', now() - interval '30 minutes', " +
      "now() - interval '36 minutes', 'RETURNED')",
    hp3Id,
    schoolId,
    mayaId,
    class1Id,
    teacherEmpId,
  );
  // OVERDUE
  const hp4Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_passes (id, school_id, student_id, class_id, issued_by, destination, ' +
      'issued_at, expected_return_at, status) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Office', " +
      "now() - interval '25 minutes', now() - interval '15 minutes', 'OVERDUE')",
    hp4Id,
    schoolId,
    ethanId,
    class2Id,
    teacherEmpId,
  );
  // RECALLED
  const hp5Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_hall_passes (id, school_id, student_id, class_id, issued_by, destination, ' +
      'issued_at, expected_return_at, returned_at, status, notes) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Other', " +
      "now() - interval '1 day', now() - interval '23 hours 50 minutes', " +
      "now() - interval '23 hours 45 minutes', 'RECALLED', " +
      "'Recalled by admin. Pass was issued in error.')",
    hp5Id,
    schoolId,
    mayaId,
    class3Id,
    teacherEmpId,
  );
  console.log('  ✓ B: 5 cls_hall_passes (2 ACTIVE, 1 RETURNED, 1 OVERDUE, 1 RECALLED)');

  // ── 6. Section C — 2 rubrics ────────────────────────────────
  // Template rubric — Narrative Writing
  const rubric1Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubrics (id, school_id, created_by, title, description, is_template, total_points) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Narrative Writing Rubric', " +
      "'Standard 4-criterion rubric for narrative essays. Reusable across assignments.', " +
      'true, 40)',
    rubric1Id,
    schoolId,
    teacherEmpId,
  );
  const ideasCriterionId = generateId();
  const orgCriterionId = generateId();
  const voiceCriterionId = generateId();
  const convCriterionId = generateId();
  const narrativeLevels = JSON.stringify([
    { level_name: 'Excellent', description: 'Exceeds expectations', points: 10 },
    { level_name: 'Good', description: 'Meets expectations', points: 8 },
    { level_name: 'Developing', description: 'Approaching expectations', points: 5 },
    { level_name: 'Beginning', description: 'Below expectations', points: 2 },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'Ideas', 'Original, focused thesis with supporting evidence.', 25, 10, 1, $3::jsonb)",
    ideasCriterionId,
    rubric1Id,
    narrativeLevels,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'Organisation', 'Clear structure with effective transitions.', 25, 10, 2, $3::jsonb)",
    orgCriterionId,
    rubric1Id,
    narrativeLevels,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'Voice', 'Distinct authorial voice appropriate to audience.', 25, 10, 3, $3::jsonb)",
    voiceCriterionId,
    rubric1Id,
    narrativeLevels,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'Conventions', 'Spelling, grammar, and punctuation.', 25, 10, 4, $3::jsonb)",
    convCriterionId,
    rubric1Id,
    narrativeLevels,
  );

  // Assignment-specific — Lab Report
  const rubric2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubrics (id, school_id, created_by, title, description, is_template, total_points) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Lab Report Rubric', " +
      "'Tailored 3-criterion rubric for lab reports. Higher weight on analysis.', " +
      'false, 45)',
    rubric2Id,
    schoolId,
    teacherEmpId,
  );
  const labLevels = JSON.stringify([
    { level_name: 'Excellent', description: 'Exceeds expectations', points: 15 },
    { level_name: 'Good', description: 'Meets expectations', points: 12 },
    { level_name: 'Developing', description: 'Approaching expectations', points: 8 },
    { level_name: 'Beginning', description: 'Below expectations', points: 3 },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES (gen_random_uuid(), $1::uuid, 'Hypothesis', 'Clear, testable hypothesis tied to background.', 30, 15, 1, $2::jsonb)",
    rubric2Id,
    labLevels,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES (gen_random_uuid(), $1::uuid, 'Method', 'Reproducible procedure with controls.', 30, 15, 2, $2::jsonb)",
    rubric2Id,
    labLevels,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria (id, rubric_id, criterion_name, description, weight, max_points, sort_order, performance_levels) ' +
      "VALUES (gen_random_uuid(), $1::uuid, 'Analysis', 'Data-driven discussion connecting back to hypothesis.', 40, 15, 3, $2::jsonb)",
    rubric2Id,
    labLevels,
  );
  console.log('  ✓ C: 2 cls_rubrics (1 template + 1 assignment-specific) with 7 criteria total');

  // ── 7. Section D — 8 rubric scores against 2 submissions ────
  const sub1Id = submissions[0]!.id;
  const sub2Id = submissions[1]!.id;
  const criteria1 = [
    { id: ideasCriterionId, points: 8, level: 'Good', feedback: 'Solid thesis with good support.' },
    {
      id: orgCriterionId,
      points: 10,
      level: 'Excellent',
      feedback: 'Exceptional structure throughout.',
    },
    {
      id: voiceCriterionId,
      points: 8,
      level: 'Good',
      feedback: 'Clear voice, could be more distinctive.',
    },
    {
      id: convCriterionId,
      points: 5,
      level: 'Developing',
      feedback: 'Several spelling errors to address.',
    },
  ];
  const criteria2 = [
    { id: ideasCriterionId, points: 5, level: 'Developing', feedback: 'Thesis needs sharpening.' },
    {
      id: orgCriterionId,
      points: 8,
      level: 'Good',
      feedback: 'Structure works, transitions need polish.',
    },
    {
      id: voiceCriterionId,
      points: 10,
      level: 'Excellent',
      feedback: 'Distinctive and engaging voice.',
    },
    {
      id: convCriterionId,
      points: 8,
      level: 'Good',
      feedback: 'Minor errors only.',
    },
  ];
  for (const c of criteria1) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_rubric_scores (id, submission_id, criterion_id, scored_by, points_awarded, performance_level, feedback) ' +
        'VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6)',
      sub1Id,
      c.id,
      teacherEmpId,
      c.points,
      c.level,
      c.feedback,
    );
  }
  for (const c of criteria2) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_rubric_scores (id, submission_id, criterion_id, scored_by, points_awarded, performance_level, feedback) ' +
        'VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::numeric, $5, $6)',
      sub2Id,
      c.id,
      teacherEmpId,
      c.points,
      c.level,
      c.feedback,
    );
  }
  console.log('  ✓ D: 8 cls_rubric_scores (4 criteria x 2 submissions, all by Teacher)');

  // ── 8. Section E — 3 class moments ────────────────────────
  const moment1Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moments (id, class_id, posted_by, caption, posted_at) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, 'Field trip to the museum — what a day! The kids were fascinated by the dinosaur exhibit.', " +
      "now() - interval '7 days')",
    moment1Id,
    class1Id,
    teacherEmpId,
  );
  const moment2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moments (id, class_id, posted_by, caption, posted_at) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, 'Science fair winners! So proud of our top 3 projects.', " +
      "now() - interval '3 days')",
    moment2Id,
    class2Id,
    teacherEmpId,
  );
  const moment3Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moments (id, class_id, posted_by, caption, posted_at) VALUES ' +
      "($1::uuid, $2::uuid, $3::uuid, 'Last day of term party — pizza and games!', " +
      "now() - interval '1 day')",
    moment3Id,
    class3Id,
    teacherEmpId,
  );
  console.log('  ✓ E: 3 cls_class_moments');

  // ── 9. Section F — 5 photos ───────────────────────────────
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos (id, moment_id, s3_key, sort_order) VALUES ' +
      '(gen_random_uuid(), $1::uuid, $2, 0)',
    moment1Id,
    'demo/moments/' + moment1Id + '/dinosaur-exhibit-1.jpg',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos (id, moment_id, s3_key, sort_order) VALUES ' +
      '(gen_random_uuid(), $1::uuid, $2, 1)',
    moment1Id,
    'demo/moments/' + moment1Id + '/group-photo.jpg',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos (id, moment_id, s3_key, sort_order) VALUES ' +
      '(gen_random_uuid(), $1::uuid, $2, 0)',
    moment2Id,
    'demo/moments/' + moment2Id + '/winners.jpg',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos (id, moment_id, s3_key, sort_order) VALUES ' +
      '(gen_random_uuid(), $1::uuid, $2, 1)',
    moment2Id,
    'demo/moments/' + moment2Id + '/first-place.jpg',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos (id, moment_id, s3_key, sort_order) VALUES ' +
      '(gen_random_uuid(), $1::uuid, $2, 0)',
    moment3Id,
    'demo/moments/' + moment3Id + '/party.jpg',
  );
  console.log('  ✓ F: 5 cls_class_moment_photos');

  // ── 10. Section G — 8 reactions ─────────────────────────
  // David Chen LIKE on field trip
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LIKE')",
    moment1Id,
    parentPersonId,
  );
  // Sarah Mitchell LIKE on field trip
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LIKE')",
    moment1Id,
    principalPersonId,
  );
  // Linda Park LOVE on field trip
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LOVE')",
    moment1Id,
    vpPersonId,
  );
  // David LOVE science fair
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LOVE')",
    moment2Id,
    parentPersonId,
  );
  // Sarah CELEBRATE science fair
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'CELEBRATE')",
    moment2Id,
    principalPersonId,
  );
  // James LOVE science fair
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LOVE')",
    moment2Id,
    teacherPersonId,
  );
  // Linda LIKE term party
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'LIKE')",
    moment3Id,
    vpPersonId,
  );
  // James CELEBRATE term party
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions (id, moment_id, reacted_by, reaction_type) VALUES ' +
      "(gen_random_uuid(), $1::uuid, $2::uuid, 'CELEBRATE')",
    moment3Id,
    teacherPersonId,
  );
  console.log('  ✓ G: 8 cls_class_moment_reactions');

  // ── Sanity counts ─────────────────────────────────────
  const counts = (await client.$queryRawUnsafe(
    'SELECT ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_hall_pass_settings) AS settings, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_hall_passes) AS passes, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_rubrics) AS rubrics, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_rubric_criteria) AS criteria, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_rubric_scores) AS scores, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_class_moments) AS moments, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_class_moment_photos) AS photos, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_class_moment_reactions) AS reactions',
  )) as Array<{
    settings: number;
    passes: number;
    rubrics: number;
    criteria: number;
    scores: number;
    moments: number;
    photos: number;
    reactions: number;
  }>;
  console.log('');
  console.log('  Final counts: ' + JSON.stringify(counts[0]));
  console.log('');
  console.log('  ✓ Classroom Advanced seed complete');
}

async function main() {
  try {
    await seedClassroomAdvanced();
  } finally {
    await disconnectAll();
  }
}

main().catch((e: unknown) => {
  console.error('seed-classroom-advanced failed:', e);
  process.exit(1);
});
