import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-portfolio-advanced.ts — Phase 2 Cycle 27 Step 4.
 *
 * Portfolio Advanced demo data across 8 P2-27 tables. Idempotent —
 * gated on whether the demo school already has a readiness pathway.
 * Each section short-circuits if its anchor row already exists so
 * re-runs are no-ops.
 *
 * Lands on top of Cycle 24 seed-portfolio.ts:
 *   A. 4 sections on Maya's portfolio (Academic, Art, Community
 *      Service, Athletics) with sort_order. Reassign Maya's
 *      seeded SUBMISSION + GRADE + REFLECTION items into Academic
 *      Work; leave CERTIFICATE + EXTERNAL_FILE unsectioned to
 *      exercise the nullable section_id path.
 *   B. 2 reflections on Maya's portfolio items with prompted
 *      questions.
 *   C. 2 endorsements (Rivera TEACHER with [Critical Thinking,
 *      Written Communication], Hayes COUNSELLOR with [Leadership,
 *      Self-Direction]).
 *   D. 2 pathways: College Prep (12 milestones) and Career &
 *      Technical (8 milestones). 2 milestones carry
 *      auto_check_source.
 *   E. 2 pathway assignments: Maya on College Prep (8/12 = 67%
 *      progress, ACTIVE). Ethan on Career & Technical (3/8 = 38%,
 *      ACTIVE).
 *   F. 3 college applications for Maya: Stanford RESEARCHING,
 *      MIT SUBMITTED, State U ACCEPTED.
 *   G. 1 resume profile for Maya with objective, skills,
 *      extracurriculars, service hours, 1 reference.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function main() {
  const client = getPlatformClient();

  // Tenant routing
  const routingRows = (await client.$queryRawUnsafe(
    'SELECT schema_name FROM platform.platform_tenant_routing WHERE schema_name = $1 LIMIT 1',
    TENANT_SCHEMA,
  )) as Array<{ schema_name: string }>;
  if (routingRows.length === 0) {
    console.error(`Tenant ${TENANT_SCHEMA} not provisioned — run pnpm seed first`);
    process.exit(1);
  }

  // Resolve school
  const schoolRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string }>;
  const schoolId = schoolRows[0]!.id;

  // Resolve personae
  const mayaRows = (await client.$queryRawUnsafe(
    `SELECT s.id::text AS sis_student_id, ip.id::text AS person_id, pu.id::text AS account_id
     FROM ${TENANT_SCHEMA}.sis_students s
     JOIN platform.platform_students ps ON ps.id = s.platform_student_id
     JOIN platform.iam_person ip ON ip.id = ps.person_id
     JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen'
     LIMIT 1`,
  )) as Array<{ sis_student_id: string; person_id: string; account_id: string }>;
  const maya = mayaRows[0];
  if (!maya) {
    console.error('Maya Chen not found — ensure tenant_demo is fully seeded');
    process.exit(1);
  }

  const ethanRows = (await client.$queryRawUnsafe(
    `SELECT s.id::text AS sis_student_id
     FROM ${TENANT_SCHEMA}.sis_students s
     JOIN platform.platform_students ps ON ps.id = s.platform_student_id
     JOIN platform.iam_person ip ON ip.id = ps.person_id
     WHERE ip.first_name = 'Ethan' AND ip.last_name = 'Rodriguez'
     LIMIT 1`,
  )) as Array<{ sis_student_id: string }>;
  const ethanStudentId = ethanRows[0]?.sis_student_id ?? null;

  // Resolve teachers/counsellor by name
  const employees = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS employee_id, ip.first_name, ip.last_name
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id`,
  )) as Array<{ employee_id: string; first_name: string; last_name: string }>;
  const rivera = employees.find((e) => e.first_name === 'James' && e.last_name === 'Rivera');
  const hayes = employees.find((e) => e.first_name === 'Marcus' && e.last_name === 'Hayes');

  // Maya portfolio + items
  const portfolioRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TENANT_SCHEMA}.pfl_portfolios WHERE student_id = $1::uuid LIMIT 1`,
    maya.sis_student_id,
  )) as Array<{ id: string }>;
  if (portfolioRows.length === 0) {
    console.error('Maya portfolio not seeded — run seed-portfolio.ts first');
    process.exit(1);
  }
  const portfolioId = portfolioRows[0]!.id;

  // Idempotency gate
  const existingPathway = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.pfl_readiness_pathways WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existingPathway.length > 0) {
    console.log('Portfolio advanced already seeded — skipping');
    await disconnectAll();
    return;
  }

  // ── A. 4 sections on Maya's portfolio ──
  const academicSectionId = generateId();
  const artSectionId = generateId();
  const communitySectionId = generateId();
  const athleticsSectionId = generateId();

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_sections (id, portfolio_id, title, description, sort_order)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    academicSectionId,
    portfolioId,
    'Academic Work',
    'Essays, lab reports, and graded assessments that show my best thinking.',
    1,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_sections (id, portfolio_id, title, description, sort_order)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    artSectionId,
    portfolioId,
    'Art Portfolio',
    'My visual art and design work across the year.',
    2,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_sections (id, portfolio_id, title, description, sort_order)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    communitySectionId,
    portfolioId,
    'Community Service',
    'Volunteer work and service hours.',
    3,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_sections (id, portfolio_id, title, description, sort_order)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
    athleticsSectionId,
    portfolioId,
    'Athletic Highlights',
    'Game footage and athletic achievements.',
    4,
  );

  // Reassign Maya's SUBMISSION + GRADE + REFLECTION items to Academic section.
  // Leave CERTIFICATE + EXTERNAL_FILE unsectioned (nullable path test).
  await client.$executeRawUnsafe(
    `UPDATE ${TENANT_SCHEMA}.pfl_portfolio_items
     SET section_id = $1::uuid
     WHERE portfolio_id = $2::uuid AND item_type IN ('SUBMISSION', 'GRADE', 'REFLECTION')`,
    academicSectionId,
    portfolioId,
  );

  // ── B. 2 reflections ──
  const itemRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id, item_type
     FROM ${TENANT_SCHEMA}.pfl_portfolio_items
     WHERE portfolio_id = $1::uuid
     ORDER BY added_at ASC`,
    portfolioId,
  )) as Array<{ id: string; item_type: string }>;
  const submissionItem = itemRows.find((i) => i.item_type === 'SUBMISSION');
  const gradeItem = itemRows.find((i) => i.item_type === 'GRADE');

  if (submissionItem) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_reflections
         (id, portfolio_item_id, student_id, prompt, reflection_text, written_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now() - INTERVAL '3 days')`,
      generateId(),
      submissionItem.id,
      maya.sis_student_id,
      'What did you learn from this work, and what would you do differently?',
      'This essay taught me to structure arguments with evidence. I revised it 3 times before I was satisfied. Next time I would start with my counterargument first to set up the whole essay.',
    );
  }

  if (gradeItem) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_reflections
         (id, portfolio_item_id, student_id, prompt, reflection_text, written_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, now() - INTERVAL '2 days')`,
      generateId(),
      gradeItem.id,
      maya.sis_student_id,
      'How does this work connect to your goals?',
      'The cell structure unit was the first time biology felt like detective work to me. I want to take AP Biology next year because of this class.',
    );
  }

  // ── C. 2 endorsements ──
  if (rivera) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_endorsements
         (id, portfolio_id, endorsed_by, endorser_role, skills, comment, is_visible_on_share, endorsed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'TEACHER', $4, $5, true, now() - INTERVAL '5 days')`,
      generateId(),
      portfolioId,
      rivera.employee_id,
      ['Critical Thinking', 'Written Communication', 'Perseverance'],
      'Maya demonstrates exceptional analytical writing. Her revisions show genuine engagement with feedback and a willingness to defend her arguments.',
    );
  }

  if (hayes) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_endorsements
         (id, portfolio_id, endorsed_by, endorser_role, skills, comment, is_visible_on_share, endorsed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'COUNSELLOR', $4, $5, true, now() - INTERVAL '4 days')`,
      generateId(),
      portfolioId,
      hayes.employee_id,
      ['Leadership', 'Self-Direction', 'Goal Setting'],
      'Maya consistently advocates for herself and her peers. She approached me in October with a clear plan for her post-secondary readiness path.',
    );
  }

  // ── D. 2 pathways with milestones ──
  const collegePrepId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_readiness_pathways
       (id, school_id, name, description, pathway_type, is_active)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'COLLEGE_PREP', true)`,
    collegePrepId,
    schoolId,
    'College Prep',
    'Traditional 4-year college application track.',
  );

  const collegeMilestones = [
    { name: 'SAT or ACT taken', cat: 'TESTING', source: null },
    { name: '3 AP courses completed', cat: 'ACADEMIC', source: null },
    {
      name: 'Community service 40 hours',
      cat: 'SERVICE',
      source: 'graduation_audit:SERVICE_HOURS',
    },
    { name: 'College essay drafted', cat: 'APPLICATION', source: null },
    { name: '3 teacher recommendations gathered', cat: 'APPLICATION', source: null },
    { name: 'Transcript requested', cat: 'APPLICATION', source: 'transcript:GENERATED' },
    { name: 'FAFSA filed', cat: 'FINANCIAL_AID', source: null },
    { name: 'Counsellor 1-on-1 meeting', cat: 'OTHER', source: null },
    { name: 'Major colleges shortlisted', cat: 'APPLICATION', source: null },
    { name: '2 college visits', cat: 'APPLICATION', source: null },
    { name: 'PSAT taken Grade 10', cat: 'TESTING', source: null },
    { name: 'Resume drafted', cat: 'APPLICATION', source: null },
  ];

  const collegeMilestoneIds: string[] = [];
  for (let i = 0; i < collegeMilestones.length; i += 1) {
    const m = collegeMilestones[i]!;
    const id = generateId();
    collegeMilestoneIds.push(id);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_pathway_milestones
         (id, pathway_id, milestone_name, category, sort_order, is_required, auto_check_source)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, $6)`,
      id,
      collegePrepId,
      m.name,
      m.cat,
      i + 1,
      m.source,
    );
  }

  const careerTechId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_readiness_pathways
       (id, school_id, name, description, pathway_type, is_active)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'CAREER_TECHNICAL', true)`,
    careerTechId,
    schoolId,
    'Career & Technical',
    'Vocational / trade school + industry certification track.',
  );

  const careerMilestones = [
    { name: 'Skills assessment completed', cat: 'TESTING' },
    { name: 'Industry certification earned', cat: 'ACADEMIC' },
    { name: 'Internship secured', cat: 'APPLICATION' },
    { name: 'Mentor identified', cat: 'OTHER' },
    { name: 'Trade school applications filed', cat: 'APPLICATION' },
    { name: 'Financial aid filed', cat: 'FINANCIAL_AID' },
    { name: 'Portfolio of work assembled', cat: 'APPLICATION' },
    { name: 'Career counselling sessions x3', cat: 'OTHER' },
  ];

  const careerMilestoneIds: string[] = [];
  for (let i = 0; i < careerMilestones.length; i += 1) {
    const m = careerMilestones[i]!;
    const id = generateId();
    careerMilestoneIds.push(id);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_pathway_milestones
         (id, pathway_id, milestone_name, category, sort_order, is_required, auto_check_source)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NULL)`,
      id,
      careerTechId,
      m.name,
      m.cat,
      i + 1,
    );
  }

  // ── E. 2 pathway assignments ──
  if (hayes) {
    // Maya on College Prep — 8/12 milestones complete (67% progress)
    // First 8 COMPLETED, last 4 mix of IN_PROGRESS / NOT_STARTED
    const mayaStatuses = collegeMilestoneIds.map((id, idx) => {
      if (idx < 6)
        return {
          milestone_id: id,
          status: 'COMPLETED',
          completed_at: new Date(Date.now() - (40 - idx) * 86400000).toISOString(),
          notes: null,
        };
      if (idx < 8)
        return {
          milestone_id: id,
          status: 'COMPLETED',
          completed_at: new Date(Date.now() - (15 - idx) * 86400000).toISOString(),
          notes: null,
        };
      if (idx < 10)
        return {
          milestone_id: id,
          status: 'IN_PROGRESS',
          completed_at: null,
          notes: 'Drafted, awaiting review',
        };
      return { milestone_id: id, status: 'NOT_STARTED', completed_at: null, notes: null };
    });

    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pfl_student_pathway_assignments
         (id, student_id, pathway_id, assigned_by, milestone_statuses, overall_progress, status, notes)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, 67, 'ACTIVE', $6)`,
      generateId(),
      maya.sis_student_id,
      collegePrepId,
      hayes.employee_id,
      JSON.stringify(mayaStatuses),
      'Strong candidate. On-track for Ivy applications. Discuss SAT II Subject Tests next session.',
    );

    if (ethanStudentId) {
      // Ethan on Career & Technical — 3/8 milestones complete (38%)
      const ethanStatuses = careerMilestoneIds.map((id, idx) => {
        if (idx < 3)
          return {
            milestone_id: id,
            status: 'COMPLETED',
            completed_at: new Date(Date.now() - (20 - idx) * 86400000).toISOString(),
            notes: null,
          };
        if (idx < 5)
          return { milestone_id: id, status: 'IN_PROGRESS', completed_at: null, notes: null };
        return { milestone_id: id, status: 'NOT_STARTED', completed_at: null, notes: null };
      });

      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.pfl_student_pathway_assignments
           (id, student_id, pathway_id, assigned_by, milestone_statuses, overall_progress, status, notes)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, 38, 'ACTIVE', $6)`,
        generateId(),
        ethanStudentId,
        careerTechId,
        hayes.employee_id,
        JSON.stringify(ethanStatuses),
        'Interested in HVAC. Connecting with local trade school in November.',
      );
    }
  }

  // ── F. 3 college applications for Maya ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_college_applications
       (id, student_id, college_name, application_type, deadline, status, notes, recommendation_count)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8)`,
    generateId(),
    maya.sis_student_id,
    'Stanford University',
    'REGULAR',
    '2027-01-02',
    'RESEARCHING',
    'Reach school. Visit scheduled for spring break.',
    0,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_college_applications
       (id, student_id, college_name, application_type, deadline, status, notes, recommendation_count, transcript_sent)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9)`,
    generateId(),
    maya.sis_student_id,
    'Massachusetts Institute of Technology',
    'EARLY_ACTION',
    '2026-11-01',
    'SUBMITTED',
    'Essay submitted. Awaiting interview invitation.',
    2,
    true,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_college_applications
       (id, student_id, college_name, application_type, deadline, status, notes, recommendation_count, transcript_sent, decision_date)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8, $9, $10::date)`,
    generateId(),
    maya.sis_student_id,
    'Kansas State University',
    'ROLLING',
    '2026-12-15',
    'ACCEPTED',
    'Safety school — accepted with scholarship offer.',
    2,
    true,
    new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  );

  // ── G. 1 resume profile for Maya ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_resume_profiles
       (id, student_id, objective_statement, skills, work_experience, extracurriculars, awards, service_hours_total, "references")
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb)`,
    generateId(),
    maya.sis_student_id,
    'Aspiring biomedical researcher pursuing a 4-year degree with focus on neuroscience and writing.',
    [
      'Critical Thinking',
      'Written Communication',
      'Perseverance',
      'Leadership',
      'Self-Direction',
      'Goal Setting',
    ],
    JSON.stringify([
      {
        employer: 'Lincoln Public Library',
        role: 'Volunteer reading tutor',
        start_date: '2025-09-01',
        end_date: null,
        description: 'Tutored younger readers in phonics and comprehension.',
      },
    ]),
    JSON.stringify([
      { activity: 'Debate Club', role: 'Vice President', years: '2025-2026' },
      { activity: 'Junior Varsity Basketball', role: 'Player', years: '2025-2026' },
    ]),
    JSON.stringify([
      { title: 'Outstanding Writer', awarded_by: 'James Rivera', date: '2026-05-01' },
      { title: 'Summer Reading Champion', awarded_by: 'Library Program', date: '2026-08-15' },
    ]),
    42.5,
    JSON.stringify([
      {
        name: 'James Rivera',
        title: 'English Teacher',
        relationship: 'Grade 5 ELA teacher',
        email: 'teacher@demo.campusos.dev',
      },
    ]),
  );

  console.log('Phase 2 Cycle 27 portfolio advanced seed complete:');
  console.log('  - 4 sections on Maya portfolio (Academic, Art, Community, Athletics)');
  console.log('  - 2 reflections (English essay + Cell Structure grade)');
  console.log('  - 2 endorsements (Rivera TEACHER + Hayes COUNSELLOR)');
  console.log('  - 2 pathways (College Prep 12 milestones + Career & Technical 8 milestones)');
  console.log('  - 2 assignments (Maya College Prep 67%, Ethan Career Tech 38%)');
  console.log('  - 3 college applications (Stanford RESEARCHING, MIT SUBMITTED, KSU ACCEPTED)');
  console.log('  - 1 resume profile for Maya with auto-shape data');

  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
