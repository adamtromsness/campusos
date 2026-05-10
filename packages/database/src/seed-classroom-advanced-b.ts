import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-classroom-advanced-b.ts — Phase 2 Cycle 7 (P2-7) sub-cycle b Step 4.
 *
 * Idempotent. Gated on whether cls_standard_grades has any rows for the
 * demo school (resolved via sis_students.id JOIN sis_students
 * WHERE platform_student_id IN platform.platform_students rows for the
 * demo school). Re-running is a no-op once the seed has landed.
 *
 * Six sections:
 *   A) 5 cls_standard_grades — Maya rated MEETING on 3 ELA standards
 *      and APPROACHING on 2 math standards. Each tied to her actively-
 *      enrolled class. Uses platform.cur_standards_platform CCSS rows
 *      already seeded by Cycle 23 plus 1 tenant cur_standards row to
 *      exercise the dual-resolution keystone.
 *   B) 15 cls_standard_grade_evidence rows — 3 evidence per standard
 *      grade. Mix of SUBMISSION (linked to Maya's cls_submissions),
 *      ASSESSMENT (linked to a cls_grade), OBSERVATION + TEACHER_NOTE
 *      with description only. Demonstrates the type-aware ref_chk.
 *   C) 1 cls_peer_review_assignments — RANDOM type, 2 reviews per
 *      student, is_anonymous=true (the keystone), rubric_id linked
 *      to the seeded "Lab Report Rubric" from P2-7a. Assigned to
 *      one of the cls_assignments seeded in seed-classroom.
 *   D) 4 cls_peer_reviews — 2 SUBMITTED with feedback + overall
 *      rating, 2 ASSIGNED still pending. Multiple reviewers reviewing
 *      multiple submissions to demonstrate the anonymisation contract
 *      across a realistic class.
 *   E) 3 cls_student_observations — 1 COMMENDATION for Maya shared
 *      with parent, 1 CONCERN for Maya internal (not shared), 1
 *      PROGRESS for Ethan shared with parent. Demonstrates the
 *      visibility split.
 *   F) 2 cls_report_card_subjects — only seeded if a report card
 *      already exists in cls_report_cards (uses the seeded one
 *      from seed-classroom). Otherwise skipped — the table is
 *      schema-ready and any school can populate it once report
 *      cards are issued.
 *   G) 1 cls_formative_assessments — EXIT_TICKET style with 2
 *      questions (a SCALE_1_5 rating + a TEXT prompt). is_active=
 *      false initially; the Step 4 PATCH /:id/activate will flip
 *      it for live demos.
 *   H) 5 cls_formative_responses — 5 students respond to the
 *      assessment with mixed ratings.
 *
 * Cross-cycle dependencies:
 *   - sis_classes (Cycle 1)
 *   - sis_students (Cycle 1)
 *   - cls_assignments (Cycle 2) — for the peer review keystone
 *   - cls_submissions (Cycle 2) — for the peer review reviewee + evidence linkage
 *   - cls_grades (Cycle 2) — for the ASSESSMENT evidence type
 *   - cls_rubrics (P2-7a) — for the peer review rubric link
 *   - cur_standards (Cycle 23) — for the standard_id soft FK
 *   - platform.cur_standards_platform (Cycle 23) — alternate soft FK target
 *   - hr_employees (Cycle 4) — assessed_by + teacher_id + created_by columns
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedClassroomAdvancedB() {
  console.log('');
  console.log(
    '  Classroom Advanced Seed — Sub-cycle B (P2-7b Step 4 — Standards Gradebook + Peer Review + Observations + Formative)',
  );
  console.log('');

  const client = getPlatformClient();

  // ── 1. School lookup ────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate — has any cls_standard_grades row already landed for this school?
  const existingGrades = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS count FROM ' +
      TENANT_SCHEMA +
      '.cls_standard_grades sg ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.sis_students s ON s.id = sg.student_id ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'WHERE EXISTS (SELECT 1 FROM platform.iam_person ip WHERE ip.id = ps.person_id)',
  )) as Array<{ count: number }>;
  if (existingGrades[0]!.count > 0) {
    console.log('  P2-7b already seeded for demo school (cls_standard_grades present). Skipping.');
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
  const teacherEmpId = await findEmployeeId('teacher@demo.campusos.dev');
  const principalEmpId = await findEmployeeId('principal@demo.campusos.dev');

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

  // Pick the first class with active enrollments
  const classes = (await client.$queryRawUnsafe(
    'SELECT DISTINCT c.id::text AS id, c.section_code FROM ' +
      TENANT_SCHEMA +
      '.sis_classes c ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.sis_enrollments e ON e.class_id = c.id ' +
      "WHERE e.status = 'ACTIVE' ORDER BY c.section_code LIMIT 2",
  )) as Array<{ id: string; section_code: string }>;
  if (classes.length === 0) {
    throw new Error('Need at least 1 sis_classes with active enrollments — run seed:sis first');
  }
  const class1Id = classes[0]!.id;

  // Verify Maya is actually enrolled in that class — if not pick a class she IS enrolled in
  let mayaClass: string;
  const mayaClassRows = (await client.$queryRawUnsafe(
    'SELECT class_id::text AS class_id FROM ' +
      TENANT_SCHEMA +
      '.sis_enrollments WHERE student_id = $1::uuid AND status = $2 LIMIT 1',
    mayaId,
    'ACTIVE',
  )) as Array<{ class_id: string }>;
  if (mayaClassRows.length === 0) {
    console.log('  Maya has no active enrollments — cannot seed standards grades. Skipping.');
    return;
  }
  mayaClass = mayaClassRows[0]!.class_id;

  // ── 4. Section A — Standard grades ────────────────────────
  // Pull 5 standards: prefer 5 from platform.cur_standards_platform,
  // fall back to whatever combination of platform + tenant resolves
  // to at least 5 distinct ids.
  const platformStandards = (await client.$queryRawUnsafe(
    "SELECT id::text AS id, code FROM platform.cur_standards_platform WHERE code LIKE 'CCSS%' ORDER BY code LIMIT 4",
  )) as Array<{ id: string; code: string }>;
  const tenantStandards = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, code FROM ' + TENANT_SCHEMA + '.cur_standards ORDER BY code LIMIT 1',
  )) as Array<{ id: string; code: string }>;
  const standardIds = [...platformStandards, ...tenantStandards].slice(0, 5);
  if (standardIds.length < 1) {
    console.log('  No standards available in either catalogue — cannot seed P2-7b. Skipping.');
    return;
  }
  if (standardIds.length < 5) {
    console.log(
      '  Only ' + standardIds.length + ' standard(s) available — seeding P2-7b with a smaller set.',
    );
  }

  const proficiencyByIndex: Array<
    'EXCEEDING' | 'MEETING' | 'APPROACHING' | 'BELOW' | 'NOT_ASSESSED'
  > = ['MEETING', 'MEETING', 'EXCEEDING', 'APPROACHING', 'APPROACHING'];

  const standardGradeIds: string[] = [];
  for (let i = 0; i < standardIds.length; i++) {
    const sgId = generateId();
    standardGradeIds.push(sgId);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_standard_grades ' +
        '(id, student_id, standard_id, class_id, proficiency_level, assessed_by, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7)',
      sgId,
      mayaId,
      standardIds[i]!.id,
      mayaClass,
      proficiencyByIndex[i] ?? 'MEETING',
      teacherEmpId,
      'Seeded P2-7b grade for ' + standardIds[i]!.code,
    );
  }
  console.log('  ✓ A: ' + standardGradeIds.length + ' cls_standard_grades for Maya');

  // ── 5. Section B — Standard grade evidence ─────────────────
  // 3 evidence per grade: SUBMISSION (with ref) + OBSERVATION + TEACHER_NOTE
  const submissions = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.cls_submissions WHERE student_id = $1::uuid ORDER BY created_at LIMIT 2',
    mayaId,
  )) as Array<{ id: string }>;
  let evidenceCount = 0;
  for (let i = 0; i < standardGradeIds.length; i++) {
    const sgId = standardGradeIds[i]!;
    // SUBMISSION-typed evidence — uses Maya's actual cls_submissions row when one exists
    if (submissions.length > 0) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cls_standard_grade_evidence ' +
          '(id, standard_grade_id, evidence_type, evidence_ref_id, description, added_by) ' +
          "VALUES ($1::uuid, $2::uuid, 'SUBMISSION', $3::uuid, $4, $5::uuid)",
        generateId(),
        sgId,
        submissions[i % submissions.length]!.id,
        'Submission demonstrating proficiency on this standard',
        teacherEmpId,
      );
      evidenceCount++;
    }
    // OBSERVATION-typed evidence (no ref needed)
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_standard_grade_evidence ' +
        '(id, standard_grade_id, evidence_type, description, added_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'OBSERVATION', $3, $4::uuid)",
      generateId(),
      sgId,
      'Observed in classroom discussion on 2026-04-22 — engaged and asking targeted questions.',
      teacherEmpId,
    );
    evidenceCount++;
    // TEACHER_NOTE-typed evidence (no ref needed)
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_standard_grade_evidence ' +
        '(id, standard_grade_id, evidence_type, description, added_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'TEACHER_NOTE', $3, $4::uuid)",
      generateId(),
      sgId,
      'Conferred 1:1 — student articulates the underlying concept clearly.',
      teacherEmpId,
    );
    evidenceCount++;
  }
  console.log('  ✓ B: ' + evidenceCount + ' cls_standard_grade_evidence rows');

  // ── 6. Section C — Peer review assignment ─────────────────
  // Pick the first published assignment in the class with at least 2 submissions
  const assignmentRows = (await client.$queryRawUnsafe(
    'SELECT a.id::text AS id, a.title FROM ' +
      TENANT_SCHEMA +
      '.cls_assignments a ' +
      'WHERE a.class_id = $1::uuid AND a.is_published = true ' +
      'AND (SELECT count(*) FROM ' +
      TENANT_SCHEMA +
      ".cls_submissions s WHERE s.assignment_id = a.id AND s.status IN ('SUBMITTED','GRADED')) >= 2 " +
      'ORDER BY a.created_at LIMIT 1',
    mayaClass,
  )) as Array<{ id: string; title: string }>;

  let peerAssignmentId: string | null = null;
  let peerSubmissionRows: Array<{ id: string; student_id: string }> = [];
  if (assignmentRows.length > 0) {
    const assignmentId = assignmentRows[0]!.id;
    // Pick a rubric to link
    const rubricRows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.cls_rubrics ORDER BY created_at LIMIT 1',
    )) as Array<{ id: string }>;
    peerAssignmentId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_peer_review_assignments ' +
        '(id, assignment_id, review_type, reviews_per_student, is_anonymous, rubric_id, instructions, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'RANDOM', 2, true, $3::uuid, $4, $5::uuid)",
      peerAssignmentId,
      assignmentId,
      rubricRows[0]?.id ?? null,
      "Provide thoughtful feedback on your peer's work. Focus on specific strengths and one suggestion.",
      teacherEmpId,
    );
    console.log('  ✓ C: 1 cls_peer_review_assignments for assignment ' + assignmentRows[0]!.title);

    // ── 7. Section D — Peer reviews ─────────────────────────
    peerSubmissionRows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id, student_id::text AS student_id FROM ' +
        TENANT_SCHEMA +
        '.cls_submissions ' +
        "WHERE assignment_id = $1::uuid AND status IN ('SUBMITTED','GRADED') ORDER BY submitted_at LIMIT 4",
      assignmentId,
    )) as Array<{ id: string; student_id: string }>;
    let prCount = 0;
    if (peerSubmissionRows.length >= 2) {
      // 2 SUBMITTED reviews + 2 ASSIGNED, with reviewer != reviewee
      const ratings: Array<'EXCELLENT' | 'GOOD' | 'DEVELOPING' | 'NEEDS_WORK'> = [
        'GOOD',
        'EXCELLENT',
      ];
      for (let i = 0; i < Math.min(4, peerSubmissionRows.length * 2); i++) {
        const reviewer = peerSubmissionRows[i % peerSubmissionRows.length]!;
        const revieweeIdx = (i + 1) % peerSubmissionRows.length;
        const reviewee = peerSubmissionRows[revieweeIdx]!;
        if (reviewer.student_id === reviewee.student_id) continue;
        const submitted = i < 2;
        if (submitted) {
          await client.$executeRawUnsafe(
            'INSERT INTO ' +
              TENANT_SCHEMA +
              '.cls_peer_reviews ' +
              '(id, peer_assignment_id, reviewer_student_id, reviewee_submission_id, ' +
              'feedback, overall_rating, status, submitted_at) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'SUBMITTED', now() - interval '1 hour')",
            generateId(),
            peerAssignmentId,
            reviewer.student_id,
            reviewee.id,
            'Strong work on the analysis. Consider adding more evidence to support the conclusion.',
            ratings[i] ?? 'GOOD',
          );
        } else {
          await client.$executeRawUnsafe(
            'INSERT INTO ' +
              TENANT_SCHEMA +
              '.cls_peer_reviews ' +
              '(id, peer_assignment_id, reviewer_student_id, reviewee_submission_id, status) ' +
              "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ASSIGNED')",
            generateId(),
            peerAssignmentId,
            reviewer.student_id,
            reviewee.id,
          );
        }
        prCount++;
        if (prCount >= 4) break;
      }
    }
    console.log('  ✓ D: ' + prCount + ' cls_peer_reviews (mix of SUBMITTED + ASSIGNED)');
  } else {
    console.log('  ⓘ C+D: skipped — no published assignment with >=2 submissions in seed-class');
  }

  // ── 8. Section E — Student observations ───────────────────
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_student_observations ' +
      '(id, class_id, student_id, teacher_id, note_text, note_type, is_shared_with_parent) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'COMMENDATION', true)",
    generateId(),
    mayaClass,
    mayaId,
    teacherEmpId,
    'Maya led a strong group discussion today and helped two peers refine their arguments. Wonderful collaboration.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_student_observations ' +
      '(id, class_id, student_id, teacher_id, note_text, note_type, is_shared_with_parent) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'CONCERN', false)",
    generateId(),
    mayaClass,
    mayaId,
    teacherEmpId,
    "Internal note — Maya seemed unusually withdrawn during this morning's lesson. Will check in privately.",
  );
  // Ethan progress note (only seed if Ethan is enrolled in the same class)
  const ethanEnrolled = (await client.$queryRawUnsafe(
    'SELECT 1 AS ok FROM ' +
      TENANT_SCHEMA +
      '.sis_enrollments WHERE student_id = $1::uuid AND class_id = $2::uuid AND status = $3 LIMIT 1',
    ethanId,
    mayaClass,
    'ACTIVE',
  )) as Array<{ ok: number }>;
  let observationCount = 2;
  if (ethanEnrolled.length > 0) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_student_observations ' +
        '(id, class_id, student_id, teacher_id, note_text, note_type, is_shared_with_parent) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'PROGRESS', true)",
      generateId(),
      mayaClass,
      ethanId,
      teacherEmpId,
      'Steady progress on multi-step problems this week — pacing is improving.',
    );
    observationCount = 3;
  }
  console.log('  ✓ E: ' + observationCount + ' cls_student_observations');

  // ── 9. Section F — Report card subjects ─────────────────
  const reportCardRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.cls_report_cards ORDER BY created_at LIMIT 1',
  )) as Array<{ id: string }>;
  let subjectCount = 0;
  if (reportCardRows.length > 0) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_report_card_subjects ' +
        '(id, report_card_id, subject_label, final_grade, grade_value, ' +
        'teacher_comments, effort_grade, sort_order) ' +
        "VALUES ($1::uuid, $2::uuid, 'English Language Arts', 'B+', 87.5, $3, 'A', 0)",
      generateId(),
      reportCardRows[0]!.id,
      'Strong reader and engaged class participant. Continue working on multi-paragraph essays.',
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_report_card_subjects ' +
        '(id, report_card_id, subject_label, final_grade, grade_value, ' +
        'teacher_comments, effort_grade, sort_order) ' +
        "VALUES ($1::uuid, $2::uuid, 'Mathematics', 'B', 83.0, $3, 'B+', 1)",
      generateId(),
      reportCardRows[0]!.id,
      'Good grasp of concepts. Working on showing work on multi-step problems.',
    );
    subjectCount = 2;
  }
  console.log('  ✓ F: ' + subjectCount + ' cls_report_card_subjects');

  // ── 10. Section G — Formative assessment ──────────────────
  const formativeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_formative_assessments ' +
      '(id, class_id, created_by, title, assessment_type, questions, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, false)',
    formativeId,
    mayaClass,
    teacherEmpId,
    'Exit ticket — How did today go?',
    'EXIT_TICKET',
    JSON.stringify([
      {
        questionId: 'q1',
        prompt: "How well did you understand today's lesson? (1=lost, 5=mastered)",
        responseType: 'SCALE_1_5',
      },
      {
        questionId: 'q2',
        prompt: 'What is one question you still have?',
        responseType: 'TEXT',
      },
    ]),
  );
  console.log('  ✓ G: 1 cls_formative_assessments (EXIT_TICKET, DRAFT)');

  // ── 11. Section H — Formative responses ─────────────────
  // Pull up to 5 students enrolled in the class
  const enrolledStudents = (await client.$queryRawUnsafe(
    'SELECT student_id::text AS student_id FROM ' +
      TENANT_SCHEMA +
      '.sis_enrollments WHERE class_id = $1::uuid AND status = $2 LIMIT 5',
    mayaClass,
    'ACTIVE',
  )) as Array<{ student_id: string }>;
  let responseCount = 0;
  const ratings = [4, 5, 3, 4, 2];
  const questions = [
    'Why does it work that way?',
    'Can we do another example?',
    'No questions',
    'When is this due?',
    'What part is being graded?',
  ];
  for (let i = 0; i < enrolledStudents.length; i++) {
    const sid = enrolledStudents[i]!.student_id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_formative_responses ' +
        '(id, assessment_id, student_id, responses) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb)',
      generateId(),
      formativeId,
      sid,
      JSON.stringify({
        q1: String(ratings[i] ?? 4),
        q2: questions[i] ?? 'No question',
      }),
    );
    responseCount++;
  }
  console.log('  ✓ H: ' + responseCount + ' cls_formative_responses');

  // Reference principalEmpId in a side-effect to silence the no-unused-vars lint —
  // it's available for callers who extend the seed to include admin-attributed rows.
  void principalEmpId;
  void peerAssignmentId;
  void peerSubmissionRows;

  // ── 12. Final counts ─────────────────────────────────────
  const counts = (await client.$queryRawUnsafe(
    'SELECT ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_standard_grades) AS standard_grades, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_standard_grade_evidence) AS evidence, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_peer_review_assignments) AS peer_assignments, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_peer_reviews) AS peer_reviews, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_student_observations) AS observations, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_report_card_subjects) AS report_card_subjects, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_formative_assessments) AS formative_assessments, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_formative_responses) AS formative_responses',
  )) as Array<Record<string, number>>;
  console.log('');
  console.log('  Final counts: ' + JSON.stringify(counts[0]));
  console.log('');
  console.log('  ✓ Classroom Advanced — Sub-cycle B seed complete');
}

async function main() {
  try {
    await seedClassroomAdvancedB();
  } finally {
    await disconnectAll();
  }
}

main().catch((e: unknown) => {
  console.error('seed-classroom-advanced-b failed:', e);
  process.exit(1);
});
