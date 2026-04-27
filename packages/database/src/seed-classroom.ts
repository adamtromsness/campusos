import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

// 12 assignments — 2 per class. The first per class is fully graded + published;
// the second is a mix of submitted + a few graded so the gradebook has both states.
interface AssignmentSpec {
  period: string;
  title: string;
  typeName: string;
  categoryName: 'Homework' | 'Assessments' | 'Participation';
  maxPoints: number;
  dueDate: string; // ISO timestamp
  fullyGraded: boolean;
}

var ASSIGNMENT_TYPES: Array<{ name: string; category: string; weightInCategory: number }> = [
  { name: 'Homework', category: 'HOMEWORK', weightInCategory: 100 },
  { name: 'Quiz', category: 'QUIZ', weightInCategory: 100 },
  { name: 'Test', category: 'TEST', weightInCategory: 100 },
  { name: 'Project', category: 'PROJECT', weightInCategory: 100 },
  { name: 'Classwork', category: 'CLASSWORK', weightInCategory: 100 },
];

// Per-class category weights — must sum to 100.
var CATEGORY_WEIGHTS: Array<{
  name: 'Homework' | 'Assessments' | 'Participation';
  weight: number;
  sortOrder: number;
}> = [
  { name: 'Homework', weight: 30, sortOrder: 1 },
  { name: 'Assessments', weight: 50, sortOrder: 2 },
  { name: 'Participation', weight: 20, sortOrder: 3 },
];

var ASSIGNMENTS: AssignmentSpec[] = [
  // P1 — Algebra 1 (MATH-101)
  {
    period: '1',
    title: 'Linear Equations Quiz',
    typeName: 'Quiz',
    categoryName: 'Assessments',
    maxPoints: 100,
    dueDate: '2026-02-15T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '1',
    title: 'Quadratics Homework Set',
    typeName: 'Homework',
    categoryName: 'Homework',
    maxPoints: 50,
    dueDate: '2026-04-15T15:00:00Z',
    fullyGraded: false,
  },
  // P2 — English 9 (ELA-101)
  {
    period: '2',
    title: 'To Kill a Mockingbird Essay',
    typeName: 'Test',
    categoryName: 'Assessments',
    maxPoints: 100,
    dueDate: '2026-02-20T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '2',
    title: 'Vocabulary Quiz #5',
    typeName: 'Quiz',
    categoryName: 'Assessments',
    maxPoints: 25,
    dueDate: '2026-04-20T15:00:00Z',
    fullyGraded: false,
  },
  // P3 — Biology (SCI-101)
  {
    period: '3',
    title: 'Cell Structure Test',
    typeName: 'Test',
    categoryName: 'Assessments',
    maxPoints: 100,
    dueDate: '2026-02-25T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '3',
    title: 'Photosynthesis Lab Report',
    typeName: 'Project',
    categoryName: 'Homework',
    maxPoints: 75,
    dueDate: '2026-04-25T15:00:00Z',
    fullyGraded: false,
  },
  // P4 — World History (SS-101)
  {
    period: '4',
    title: 'Industrial Revolution Essay',
    typeName: 'Test',
    categoryName: 'Assessments',
    maxPoints: 100,
    dueDate: '2026-03-01T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '4',
    title: 'Map Quiz: Europe',
    typeName: 'Quiz',
    categoryName: 'Assessments',
    maxPoints: 50,
    dueDate: '2026-04-22T15:00:00Z',
    fullyGraded: false,
  },
  // P5 — Geometry (MATH-201)
  {
    period: '5',
    title: 'Theorems & Proofs Test',
    typeName: 'Test',
    categoryName: 'Assessments',
    maxPoints: 100,
    dueDate: '2026-03-05T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '5',
    title: 'Triangles Homework',
    typeName: 'Homework',
    categoryName: 'Homework',
    maxPoints: 30,
    dueDate: '2026-04-26T15:00:00Z',
    fullyGraded: false,
  },
  // P6 — Chemistry (SCI-201)
  {
    period: '6',
    title: 'Periodic Table Quiz',
    typeName: 'Quiz',
    categoryName: 'Assessments',
    maxPoints: 50,
    dueDate: '2026-03-10T15:00:00Z',
    fullyGraded: true,
  },
  {
    period: '6',
    title: 'Stoichiometry Lab',
    typeName: 'Project',
    categoryName: 'Homework',
    maxPoints: 75,
    dueDate: '2026-04-28T15:00:00Z',
    fullyGraded: false,
  },
];

// Deterministic per-(student, assignment) percentage generator. Output range 70..98
// so realistic grade distribution. Maya is bumped to a steady 88-94 range so her
// parent-dashboard story shows clean B+/A-.
function pickPercentage(studentNumber: string, assignmentIndex: number, isMaya: boolean): number {
  if (isMaya) {
    var mayaSeq = [92, 88, 90, 94, 89, 91, 93, 87, 90, 92, 88, 91];
    return mayaSeq[assignmentIndex % mayaSeq.length]!;
  }
  // Hash-ish seed from "S-1003" + assignment index → 70..98
  var n = 0;
  for (var i = 0; i < studentNumber.length; i++) n = (n * 31 + studentNumber.charCodeAt(i)) | 0;
  var v = (n * 17 + assignmentIndex * 23) | 0;
  if (v < 0) v = -v;
  return 70 + (v % 29); // 70..98
}

function letterGrade(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

async function seedClassroom() {
  console.log('');
  console.log('  Classroom Seed (Cycle 2)');
  console.log('');

  var client = getPlatformClient();

  // ── Idempotency check ──
  var existingAssignments = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT count(*)::bigint AS count FROM ' + TENANT_SCHEMA + '.cls_assignments',
  );
  if (existingAssignments[0] && existingAssignments[0].count > 0n) {
    console.log(
      '  Classroom data already seeded (' +
        existingAssignments[0].count +
        ' cls_assignments rows) — skipping',
    );
    return;
  }

  // ── Look up dependencies seeded by seed.ts and seed-sis.ts ──
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var teacherUser = await client.platformUser.findFirst({
    where: { email: 'teacher@demo.campusos.dev' },
  });
  if (!teacherUser) throw new Error('teacher@demo.campusos.dev not found — run pnpm seed first');
  var teacherPersonId = teacherUser.personId;

  // Spring 2026 term
  var terms = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + ".sis_terms WHERE name = 'Spring 2026' LIMIT 1",
  );
  if (!terms[0]) throw new Error('Spring 2026 term not found — run seed:sis first');
  var termSpringId = terms[0].id;

  // Classes by period (section_code)
  var classes = await client.$queryRawUnsafe<Array<{ id: string; section_code: string }>>(
    'SELECT id::text AS id, section_code FROM ' + TENANT_SCHEMA + '.sis_classes',
  );
  if (classes.length === 0) throw new Error('No sis_classes found — run seed:sis first');
  var classIdByPeriod: Record<string, string> = {};
  for (var ci = 0; ci < classes.length; ci++) {
    classIdByPeriod[classes[ci]!.section_code] = classes[ci]!.id;
  }

  // Students (by student_number) — and remember the platform_student → person → name mapping for Maya
  var students = await client.$queryRawUnsafe<
    Array<{ id: string; student_number: string; platform_student_id: string }>
  >(
    'SELECT id::text AS id, student_number, platform_student_id::text AS platform_student_id FROM ' +
      TENANT_SCHEMA +
      '.sis_students',
  );
  if (students.length === 0) throw new Error('No sis_students found — run seed:sis first');
  var sisStudentIdByNumber: Record<string, string> = {};
  for (var si = 0; si < students.length; si++) {
    sisStudentIdByNumber[students[si]!.student_number] = students[si]!.id;
  }
  // Maya is S-1001 (per seed-sis)
  var mayaStudentNumber = 'S-1001';

  // Enrollments per class (active)
  var enrollments = await client.$queryRawUnsafe<
    Array<{ class_id: string; student_id: string; student_number: string }>
  >(
    'SELECT e.class_id::text AS class_id, e.student_id::text AS student_id, s.student_number ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.sis_enrollments e ' +
      'JOIN ' +
      TENANT_SCHEMA +
      ".sis_students s ON s.id = e.student_id WHERE e.status = 'ACTIVE'",
  );
  var rosterByClassId: Record<string, Array<{ studentId: string; studentNumber: string }>> = {};
  for (var ei = 0; ei < enrollments.length; ei++) {
    var en = enrollments[ei]!;
    if (!rosterByClassId[en.class_id]) rosterByClassId[en.class_id] = [];
    rosterByClassId[en.class_id]!.push({
      studentId: en.student_id,
      studentNumber: en.student_number,
    });
  }

  // ── 1. Default grading scale ──
  var gradingScaleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      ".grading_scales (id, name, scale_type, is_default, grades) VALUES ($1::uuid, $2, 'PERCENTAGE', true, $3::jsonb)",
    gradingScaleId,
    'Standard A-F (Percentage)',
    JSON.stringify([
      { letter: 'A', min: 90, max: 100 },
      { letter: 'B', min: 80, max: 89.99 },
      { letter: 'C', min: 70, max: 79.99 },
      { letter: 'D', min: 60, max: 69.99 },
      { letter: 'F', min: 0, max: 59.99 },
    ]),
  );
  console.log('  1 grading_scale (Standard A-F)');

  // ── 2. Assignment types (school-wide) ──
  var typeIdByName: Record<string, string> = {};
  for (var ati = 0; ati < ASSIGNMENT_TYPES.length; ati++) {
    var at = ASSIGNMENT_TYPES[ati]!;
    var atId = generateId();
    typeIdByName[at.name] = atId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_assignment_types (id, school_id, name, weight_in_category, category) VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5)',
      atId,
      schoolId,
      at.name,
      at.weightInCategory.toFixed(2),
      at.category,
    );
  }
  console.log('  ' + ASSIGNMENT_TYPES.length + ' cls_assignment_types');

  // ── 3. Categories per class (3 × 6 = 18) ──
  var categoryIdByClassAndName: Record<string, string> = {};
  var totalCategories = 0;
  for (var ki = 0; ki < classes.length; ki++) {
    var classId = classes[ki]!.id;
    for (var cwi = 0; cwi < CATEGORY_WEIGHTS.length; cwi++) {
      var cw = CATEGORY_WEIGHTS[cwi]!;
      var catId = generateId();
      categoryIdByClassAndName[classId + '|' + cw.name] = catId;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cls_assignment_categories (id, class_id, name, weight, sort_order) VALUES ($1::uuid, $2::uuid, $3, $4::numeric, $5)',
        catId,
        classId,
        cw.name,
        cw.weight.toFixed(2),
        cw.sortOrder,
      );
      totalCategories++;
    }
  }
  console.log(
    '  ' + totalCategories + ' cls_assignment_categories (3 per class, weights 30/50/20)',
  );

  // ── 4. Assignments (12) ──
  // Track the assignment context for the submission/grade/snapshot phases.
  interface AssignmentRow {
    id: string;
    classId: string;
    period: string;
    spec: AssignmentSpec;
    categoryId: string;
    indexInClass: number;
  }
  var assignmentRows: AssignmentRow[] = [];
  var classIndexCount: Record<string, number> = {};

  for (var ai = 0; ai < ASSIGNMENTS.length; ai++) {
    var a = ASSIGNMENTS[ai]!;
    var classIdForA = classIdByPeriod[a.period]!;
    var categoryId = categoryIdByClassAndName[classIdForA + '|' + a.categoryName]!;
    var assignmentTypeId = typeIdByName[a.typeName]!;
    var assignmentId = generateId();
    var idxInClass = classIndexCount[classIdForA] || 0;
    classIndexCount[classIdForA] = idxInClass + 1;

    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_assignments (id, class_id, assignment_type_id, category_id, grading_scale_id, title, instructions, due_date, max_points, is_published) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamptz, $9::numeric, $10)',
      assignmentId,
      classIdForA,
      assignmentTypeId,
      categoryId,
      gradingScaleId,
      a.title,
      'See class notes for details.',
      a.dueDate,
      a.maxPoints.toFixed(2),
      true,
    );
    assignmentRows.push({
      id: assignmentId,
      classId: classIdForA,
      period: a.period,
      spec: a,
      categoryId: categoryId,
      indexInClass: idxInClass,
    });
  }
  console.log(
    '  ' + assignmentRows.length + ' cls_assignments (12, 2 per class, all is_published=true)',
  );

  // ── 5. Submissions + 6. Grades ──
  // Rule:
  //   fullyGraded=true  → every enrolled student has a SUBMITTED+GRADED submission and a published grade
  //   fullyGraded=false → every enrolled student has a SUBMITTED submission;
  //                       half (rounded down) get a published grade as well, the rest stay ungraded.
  //   Two students are intentionally skipped (one in P1's second assignment, one in P5's second)
  //   to model "missed/in-progress" scenarios.
  var submissionCount = 0;
  var gradeCount = 0;
  var publishedGradeCount = 0;
  // (assignmentId, studentId) -> { gradeValue, isPublished }
  var gradesByAssignmentStudent: Record<string, { gradeValue: number; isPublished: boolean }> = {};

  for (var ari = 0; ari < assignmentRows.length; ari++) {
    var row = assignmentRows[ari]!;
    var roster = rosterByClassId[row.classId] || [];
    var partialDropStudent: string | null = null;
    if (
      !row.spec.fullyGraded &&
      (row.period === '1' || row.period === '5') &&
      row.indexInClass === 1
    ) {
      // Skip the last student in the roster to leave a "no submission" state.
      partialDropStudent = roster[roster.length - 1]!.studentNumber;
    }

    for (var ri = 0; ri < roster.length; ri++) {
      var stu = roster[ri]!;
      if (partialDropStudent && stu.studentNumber === partialDropStudent) continue;

      var subId = generateId();
      var submittedAt = row.spec.dueDate; // submitted right at the deadline for seed simplicity
      var subStatus: 'SUBMITTED' | 'GRADED';
      var willGrade: boolean;

      if (row.spec.fullyGraded) {
        willGrade = true;
        subStatus = 'GRADED';
      } else {
        // Half the roster (every even index) gets graded on partial assignments.
        willGrade = ri % 2 === 0;
        subStatus = willGrade ? 'GRADED' : 'SUBMITTED';
      }

      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cls_submissions (id, assignment_id, student_id, status, submission_text, submitted_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz)',
        subId,
        row.id,
        stu.studentId,
        subStatus,
        'Submitted via portal.',
        submittedAt,
      );
      submissionCount++;

      if (willGrade) {
        var isMaya = stu.studentNumber === mayaStudentNumber;
        var pct = pickPercentage(stu.studentNumber, ari, isMaya);
        var gradeValue = (row.spec.maxPoints * pct) / 100;
        var letter = letterGrade(pct);
        var isPublished = row.spec.fullyGraded ? true : ri % 4 === 0; // publish a quarter of partial-graded ones
        var gradeId = generateId();
        await client.$executeRawUnsafe(
          'INSERT INTO ' +
            TENANT_SCHEMA +
            '.cls_grades (id, assignment_id, student_id, submission_id, teacher_id, grade_value, letter_grade, feedback, is_published, graded_at, published_at) ' +
            'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::numeric, $7, $8, $9, $10::timestamptz, $11::timestamptz)',
          gradeId,
          row.id,
          stu.studentId,
          subId,
          teacherPersonId,
          gradeValue.toFixed(2),
          letter,
          isMaya ? 'Strong work overall — show more steps on assessments.' : null,
          isPublished,
          submittedAt,
          isPublished ? submittedAt : null,
        );
        gradeCount++;
        if (isPublished) publishedGradeCount++;
        if (isPublished) {
          gradesByAssignmentStudent[row.id + '|' + stu.studentId] = {
            gradeValue: gradeValue,
            isPublished: true,
          };
        }
      }
    }
  }
  console.log('  ' + submissionCount + ' cls_submissions');
  console.log(
    '  ' +
      gradeCount +
      ' cls_grades (' +
      publishedGradeCount +
      ' published, ' +
      (gradeCount - publishedGradeCount) +
      ' draft)',
  );

  // ── 7. Gradebook snapshots — weighted by category, only categories with at least one published grade contribute ──
  // For each (class, student): for each category in that class with published grades, average pct in that category;
  // weighted across categories renormalised to category weights actually used.
  var snapshotCount = 0;
  for (var cli = 0; cli < classes.length; cli++) {
    var classRow = classes[cli]!;
    var rosterForClass = rosterByClassId[classRow.id] || [];

    // Pull all published grades for this class joined to assignment + category
    var classGrades = await client.$queryRawUnsafe<
      Array<{
        student_id: string;
        category_name: string;
        category_weight: string;
        max_points: string;
        grade_value: string;
      }>
    >(
      'SELECT g.student_id::text AS student_id, c.name AS category_name, c.weight::text AS category_weight, ' +
        'a.max_points::text AS max_points, g.grade_value::text AS grade_value ' +
        'FROM ' +
        TENANT_SCHEMA +
        '.cls_grades g ' +
        'JOIN ' +
        TENANT_SCHEMA +
        '.cls_assignments a ON a.id = g.assignment_id ' +
        'JOIN ' +
        TENANT_SCHEMA +
        '.cls_assignment_categories c ON c.id = a.category_id ' +
        'WHERE a.class_id = $1::uuid AND g.is_published = true',
      classRow.id,
    );

    // Group by student → category → list of pct
    var pctByStudentCategory: Record<
      string,
      Record<string, { pcts: number[]; weight: number }>
    > = {};
    for (var gi = 0; gi < classGrades.length; gi++) {
      var gr = classGrades[gi]!;
      var pct2 = (Number(gr.grade_value) / Number(gr.max_points)) * 100;
      if (!pctByStudentCategory[gr.student_id]) pctByStudentCategory[gr.student_id] = {};
      var bucket = pctByStudentCategory[gr.student_id]![gr.category_name];
      if (!bucket) {
        pctByStudentCategory[gr.student_id]![gr.category_name] = {
          pcts: [pct2],
          weight: Number(gr.category_weight),
        };
      } else {
        bucket.pcts.push(pct2);
      }
    }

    var assignmentsTotalForClass = 0;
    for (var ari2 = 0; ari2 < assignmentRows.length; ari2++) {
      if (assignmentRows[ari2]!.classId === classRow.id) assignmentsTotalForClass++;
    }

    for (var rj = 0; rj < rosterForClass.length; rj++) {
      var stu2 = rosterForClass[rj]!;
      var perCat = pctByStudentCategory[stu2.studentId];
      if (!perCat) continue; // no published grades → no snapshot row

      var catNames = Object.keys(perCat);
      var weightedSum = 0;
      var weightTotal = 0;
      var assignmentsGraded = 0;
      for (var cni = 0; cni < catNames.length; cni++) {
        var catBucket = perCat[catNames[cni]!]!;
        var catAvg =
          catBucket.pcts.reduce(function (s, x) {
            return s + x;
          }, 0) / catBucket.pcts.length;
        weightedSum += catAvg * catBucket.weight;
        weightTotal += catBucket.weight;
        assignmentsGraded += catBucket.pcts.length;
      }
      var currentAvg = weightTotal > 0 ? weightedSum / weightTotal : 0;
      var snapId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cls_gradebook_snapshots (id, class_id, student_id, term_id, current_average, letter_grade, assignments_graded, assignments_total, last_grade_event_at, last_updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6, $7, $8, now(), now())',
        snapId,
        classRow.id,
        stu2.studentId,
        termSpringId,
        currentAvg.toFixed(2),
        letterGrade(currentAvg),
        assignmentsGraded,
        assignmentsTotalForClass,
      );
      snapshotCount++;
    }
  }
  console.log('  ' + snapshotCount + ' cls_gradebook_snapshots');

  // ── 8. One progress note for Maya in P1 Algebra 1 ──
  var mayaSisId = sisStudentIdByNumber[mayaStudentNumber];
  var p1ClassId = classIdByPeriod['1'];
  if (mayaSisId && p1ClassId) {
    var noteId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_student_progress_notes (id, class_id, student_id, term_id, author_id, note_text, overall_effort_rating, is_parent_visible, is_student_visible, published_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, now())',
      noteId,
      p1ClassId,
      mayaSisId,
      termSpringId,
      teacherPersonId,
      'Maya is engaged in class and consistently submits high-quality work. She would benefit from showing more steps in her solutions on assessments.',
      'GOOD',
      true,
      true,
    );
    console.log('  1 cls_student_progress_notes (Maya, P1 Algebra 1, parent + student visible)');
  }

  console.log('');
  console.log('  Classroom seed complete!');
  console.log('  Next: rebuild permission cache → tsx src/build-cache.ts');
}

if (require.main === module) {
  seedClassroom()
    .then(function () {
      return disconnectAll();
    })
    .then(function () {
      process.exit(0);
    })
    .catch(function (e) {
      console.error('Classroom seed failed:', e);
      disconnectAll().then(function () {
        process.exit(1);
      });
    });
}

export { seedClassroom };
