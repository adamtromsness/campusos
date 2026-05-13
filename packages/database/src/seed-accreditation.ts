import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-accreditation.ts — P2-23a Step 3.
 *
 * M85 Accreditation. Idempotent — gated on whether the platform
 * AdvancED framework already exists for the platform layer, and on
 * whether Lincoln Academy already has an active framework adoption
 * for the tenant layer.
 *
 * Two write surfaces:
 *   1. PLATFORM (one-time, idempotent on framework name): seeds 3
 *      accreditation frameworks (AdvancED/Cognia, IB MYP, CIS) with
 *      ~70 standards across them. Future frameworks land by extending
 *      the seed file — schools see new frameworks automatically on
 *      next adoption page load (Step 8 platform-framework seeder
 *      pattern).
 *   2. TENANT (per-school): seeds 1 adoption (Lincoln Academy adopts
 *      AdvancED), 1 custom framework ("Lincoln Teaching Excellence"),
 *      8 evidence items spanning all 5 evidence_type values, 10 self-
 *      study ratings for the 2025-2026 cycle, 2 action plans (1
 *      IN_PROGRESS, 1 OVERDUE — exercises the ActionPlanOverdueWorker
 *      target_date < CURRENT_DATE branch), 1 site visit prep PREPARING
 *      with readiness_score=75.
 */

const TENANT_SCHEMA = 'tenant_demo';

type StandardSpec = {
  code: string;
  domain: string;
  text: string;
  guidance?: string;
};

// ── AdvancED / Cognia — 7 domains × ~4-5 standards = 30 ──
const ADVANCED_STANDARDS: StandardSpec[] = [
  {
    code: '1.1',
    domain: 'Purpose and Direction',
    text: 'The system commits to a purpose statement that defines beliefs about teaching and learning.',
  },
  {
    code: '1.2',
    domain: 'Purpose and Direction',
    text: 'Stakeholders collectively demonstrate actions to ensure the achievement of the systems purpose.',
  },
  {
    code: '1.3',
    domain: 'Purpose and Direction',
    text: 'The system engages in a systematic, inclusive, and comprehensive process to review, revise, and communicate a system-wide purpose for student success.',
  },
  {
    code: '2.1',
    domain: 'Governance and Leadership',
    text: 'The governing body establishes policies and supports practices that ensure effective administration of the system and its schools.',
  },
  {
    code: '2.2',
    domain: 'Governance and Leadership',
    text: 'The governing body operates responsibly and functions effectively.',
  },
  {
    code: '2.3',
    domain: 'Governance and Leadership',
    text: 'Leaders engage stakeholders to support the achievement of the systems purpose and direction.',
    guidance:
      'Evidence often includes parent surveys, advisory council minutes, and community engagement reports.',
  },
  {
    code: '2.4',
    domain: 'Governance and Leadership',
    text: 'Leadership and staff foster a culture consistent with the systems purpose and direction.',
  },
  {
    code: '3.1',
    domain: 'Teaching and Assessing for Learning',
    text: 'The systems curriculum provides equitable and challenging learning experiences that ensure all students have sufficient opportunities to develop learning, thinking, and life skills.',
  },
  {
    code: '3.2',
    domain: 'Teaching and Assessing for Learning',
    text: 'Curriculum, instruction, and assessment throughout the system are monitored and adjusted systematically in response to data from multiple assessments of student learning and an examination of professional practice.',
  },
  {
    code: '3.3',
    domain: 'Teaching and Assessing for Learning',
    text: 'Teachers throughout the district engage students in their learning through instructional strategies that ensure achievement of learning expectations.',
  },
  {
    code: '3.4',
    domain: 'Teaching and Assessing for Learning',
    text: 'System and school leaders monitor and support the improvement of instructional practices of teachers to ensure student success.',
  },
  {
    code: '3.5',
    domain: 'Teaching and Assessing for Learning',
    text: 'The system operates as a collaborative learning organization through structures that support improved instruction and student learning at all levels.',
  },
  {
    code: '4.1',
    domain: 'Resources and Support Systems',
    text: 'The system engages in a systematic process to recruit, employ, and retain a sufficient number of qualified professional and support staff.',
  },
  {
    code: '4.2',
    domain: 'Resources and Support Systems',
    text: 'Instructional time, material resources, and fiscal resources are sufficient to support the purpose and direction of the system, its schools, and educational programs.',
  },
  {
    code: '4.3',
    domain: 'Resources and Support Systems',
    text: 'The system maintains facilities, services, and equipment to provide a safe, clean, and healthy environment for all students and staff.',
  },
  {
    code: '4.4',
    domain: 'Resources and Support Systems',
    text: 'The system demonstrates strategic resource management that includes long-range planning and use of resources in support of the systems purpose and direction.',
  },
  {
    code: '4.5',
    domain: 'Resources and Support Systems',
    text: 'The system provides, coordinates, and evaluates the effectiveness of information resources and related personnel to support educational programs throughout the system.',
  },
  {
    code: '5.1',
    domain: 'Using Results for Continuous Improvement',
    text: 'The system establishes and maintains a clearly defined and comprehensive student assessment system.',
  },
  {
    code: '5.2',
    domain: 'Using Results for Continuous Improvement',
    text: 'Professional and support staff continuously collect, analyze, and apply learning from a range of data sources.',
  },
  {
    code: '5.3',
    domain: 'Using Results for Continuous Improvement',
    text: 'Throughout the system, professional and support staff are trained in the evaluation, interpretation, and use of data.',
  },
  {
    code: '5.4',
    domain: 'Using Results for Continuous Improvement',
    text: 'The system engages in a continuous process to determine verifiable improvement in student learning, including readiness for and success at the next level.',
  },
  {
    code: '5.5',
    domain: 'Using Results for Continuous Improvement',
    text: 'Leadership monitors and communicates comprehensive information about student learning, school performance, and the achievement of system and school improvement goals to stakeholders.',
  },
  {
    code: '6.1',
    domain: 'Stakeholder Communication and Relationships',
    text: 'The system fosters collaboration with community stakeholders to support student learning.',
  },
  {
    code: '6.2',
    domain: 'Stakeholder Communication and Relationships',
    text: 'Communication is timely and reaches all stakeholders.',
  },
  {
    code: '6.3',
    domain: 'Stakeholder Communication and Relationships',
    text: 'Stakeholder engagement is documented through structured feedback channels.',
  },
  {
    code: '7.1',
    domain: 'Learning Environment',
    text: 'The school maintains a positive and safe learning environment for all students.',
  },
  {
    code: '7.2',
    domain: 'Learning Environment',
    text: 'The school provides a learning environment that is conducive to engagement and academic risk-taking.',
  },
  {
    code: '7.3',
    domain: 'Learning Environment',
    text: 'Students and staff feel respected and included.',
  },
  {
    code: '7.4',
    domain: 'Learning Environment',
    text: 'The school environment supports physical, social, and emotional well-being.',
  },
  {
    code: '7.5',
    domain: 'Learning Environment',
    text: 'The school maintains discipline and conduct standards aligned with restorative practices.',
  },
];

// ── IB MYP — 4 domains × 4 standards = 16 ──
const IB_MYP_STANDARDS: StandardSpec[] = [
  {
    code: 'A.1',
    domain: 'Philosophy',
    text: 'The schools published statements of mission and philosophy align with those of the IB.',
  },
  {
    code: 'A.2',
    domain: 'Philosophy',
    text: 'The governing body, administrative and pedagogical leadership, and staff demonstrate understanding of IB philosophy.',
  },
  {
    code: 'A.3',
    domain: 'Philosophy',
    text: 'The school develops and promotes international-mindedness and all attributes of the IB learner profile across the school community.',
  },
  {
    code: 'A.4',
    domain: 'Philosophy',
    text: 'The school commits to an inclusive education programme that addresses learner diversity.',
  },
  {
    code: 'B.1',
    domain: 'Organization',
    text: 'The school has effective leadership and governance structures.',
  },
  {
    code: 'B.2',
    domain: 'Organization',
    text: 'The school plans for the implementation of the IB programme.',
  },
  {
    code: 'B.3',
    domain: 'Organization',
    text: 'The school makes provision for ongoing professional development for its teachers and pedagogical leadership team.',
  },
  {
    code: 'B.4',
    domain: 'Organization',
    text: 'The school commits to the assessment policies, expectations, and procedures of the MYP.',
  },
  {
    code: 'C.1',
    domain: 'Curriculum',
    text: 'Collaborative planning and reflection address the requirements of the programme.',
  },
  {
    code: 'C.2',
    domain: 'Curriculum',
    text: 'Written curriculum reflects IB philosophy and meets MYP requirements.',
  },
  { code: 'C.3', domain: 'Curriculum', text: 'Teaching and learning reflects IB philosophy.' },
  {
    code: 'C.4',
    domain: 'Curriculum',
    text: 'Assessment at the school reflects IB assessment philosophy.',
  },
  {
    code: 'D.1',
    domain: 'Students',
    text: 'Students develop the attributes of the IB learner profile.',
  },
  {
    code: 'D.2',
    domain: 'Students',
    text: 'Students engage with the personal project as the culminating experience of the MYP.',
  },
  {
    code: 'D.3',
    domain: 'Students',
    text: 'Students experience service as action as a meaningful part of MYP.',
  },
  {
    code: 'D.4',
    domain: 'Students',
    text: 'Students with diverse needs are supported through inclusive practices.',
  },
];

// ── CIS — 8 domains × 3 standards = 24 ──
const CIS_STANDARDS: StandardSpec[] = [
  {
    code: 'A.1',
    domain: 'Purpose and Direction',
    text: 'The school has a clearly stated purpose, vision, and core values.',
  },
  {
    code: 'A.2',
    domain: 'Purpose and Direction',
    text: 'The school plans strategically and acts in support of its purpose.',
  },
  {
    code: 'A.3',
    domain: 'Purpose and Direction',
    text: 'The school monitors and reviews progress against strategic intent.',
  },
  {
    code: 'B.1',
    domain: 'Governance and Leadership',
    text: 'Governance arrangements support effective leadership.',
  },
  {
    code: 'B.2',
    domain: 'Governance and Leadership',
    text: 'Leadership is collaborative and inclusive.',
  },
  { code: 'B.3', domain: 'Governance and Leadership', text: 'Leaders model the schools values.' },
  { code: 'C.1', domain: 'The Curriculum', text: 'The curriculum supports the school purpose.' },
  { code: 'C.2', domain: 'The Curriculum', text: 'The curriculum addresses learner diversity.' },
  {
    code: 'C.3',
    domain: 'The Curriculum',
    text: 'The curriculum reflects international-mindedness.',
  },
  {
    code: 'D.1',
    domain: 'Teaching and Assessing for Learning',
    text: 'Teaching practice supports student learning.',
  },
  {
    code: 'D.2',
    domain: 'Teaching and Assessing for Learning',
    text: 'Assessment practices inform teaching.',
  },
  {
    code: 'D.3',
    domain: 'Teaching and Assessing for Learning',
    text: 'Reporting communicates student progress to families.',
  },
  { code: 'E.1', domain: 'Wellbeing', text: 'The school promotes student wellbeing.' },
  { code: 'E.2', domain: 'Wellbeing', text: 'The school promotes staff wellbeing.' },
  {
    code: 'E.3',
    domain: 'Wellbeing',
    text: 'Safeguarding policies and procedures protect all members of the community.',
  },
  { code: 'F.1', domain: 'Staffing', text: 'Staffing arrangements support the schools purpose.' },
  { code: 'F.2', domain: 'Staffing', text: 'Professional learning supports staff development.' },
  { code: 'F.3', domain: 'Staffing', text: 'Staff appraisal supports continuous improvement.' },
  {
    code: 'G.1',
    domain: 'Premises and Physical Resources',
    text: 'Premises support the educational programme.',
  },
  {
    code: 'G.2',
    domain: 'Premises and Physical Resources',
    text: 'Resources support teaching and learning.',
  },
  {
    code: 'G.3',
    domain: 'Premises and Physical Resources',
    text: 'Health and safety arrangements protect the community.',
  },
  {
    code: 'H.1',
    domain: 'Community and Home Partnerships',
    text: 'The school partners with families to support learning.',
  },
  {
    code: 'H.2',
    domain: 'Community and Home Partnerships',
    text: 'The school engages alumni in the life of the school.',
  },
  {
    code: 'H.3',
    domain: 'Community and Home Partnerships',
    text: 'The school contributes to its wider community.',
  },
];

async function ensurePlatformFramework(
  client: ReturnType<typeof getPlatformClient>,
  args: {
    name: string;
    abbreviation: string;
    organisation: string;
    description: string;
    version: string;
    standards: StandardSpec[];
  },
): Promise<{ id: string; created: boolean }> {
  const existing = (await client.$queryRawUnsafe(
    'SELECT id::text FROM platform.acc_frameworks_platform WHERE name = $1 LIMIT 1',
    args.name,
  )) as Array<{ id: string }>;
  if (existing.length > 0) {
    return { id: existing[0]!.id, created: false };
  }
  const id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO platform.acc_frameworks_platform (id, name, abbreviation, organisation, description, version) ' +
      'VALUES ($1::uuid, $2, $3, $4, $5, $6)',
    id,
    args.name,
    args.abbreviation,
    args.organisation,
    args.description,
    args.version,
  );
  for (let i = 0; i < args.standards.length; i++) {
    const s = args.standards[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO platform.acc_standards_platform (id, framework_id, standard_code, domain, standard_text, guidance_notes, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
      generateId(),
      id,
      s.code,
      s.domain,
      s.text,
      s.guidance ?? null,
      i + 1,
    );
  }
  return { id, created: true };
}

async function seedAccreditation(): Promise<void> {
  console.log('');
  console.log('  Accreditation Seed (P2-23a Step 3)');
  console.log('');

  const client = getPlatformClient();

  // ── A. Platform frameworks (idempotent on name) ──
  const advanced = await ensurePlatformFramework(client, {
    name: 'AdvancED Performance Standards',
    abbreviation: 'AdvancED',
    organisation: 'Cognia (formerly AdvancED / SACS / NCA / NWAC)',
    description:
      'Cognia / AdvancED accreditation standards for primary, secondary, and post-secondary institutions. Organised across 7 domains covering purpose, governance, teaching, resources, results, stakeholder communication, and learning environment.',
    version: '2024',
    standards: ADVANCED_STANDARDS,
  });

  const ibMyp = await ensurePlatformFramework(client, {
    name: 'International Baccalaureate Middle Years Programme',
    abbreviation: 'IB MYP',
    organisation: 'International Baccalaureate Organization',
    description:
      'IB Middle Years Programme (MYP) standards and practices. Organised across 4 sections — Philosophy, Organization, Curriculum, and Students.',
    version: '2024',
    standards: IB_MYP_STANDARDS,
  });

  const cis = await ensurePlatformFramework(client, {
    name: 'Council of International Schools',
    abbreviation: 'CIS',
    organisation: 'Council of International Schools',
    description:
      'CIS evaluation and accreditation framework. Organised across 8 domains covering purpose, governance, curriculum, teaching, wellbeing, staffing, premises, and community.',
    version: '2024',
    standards: CIS_STANDARDS,
  });

  const totalStandards = ADVANCED_STANDARDS.length + IB_MYP_STANDARDS.length + CIS_STANDARDS.length;
  console.log(
    '  Platform frameworks: AdvancED ' +
      (advanced.created ? '(NEW)' : '(existing)') +
      ', IB MYP ' +
      (ibMyp.created ? '(NEW)' : '(existing)') +
      ', CIS ' +
      (cis.created ? '(NEW)' : '(existing)') +
      ' — ' +
      totalStandards +
      ' total platform standards',
  );

  // ── B. Tenant-side seed (gated on existing adoption) ──
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) {
    console.log('  demo school not found — skipping tenant accreditation seed');
    return;
  }

  const existingAdoption = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.acc_school_framework_adoptions WHERE school_id = $1::uuid',
    school.id,
  )) as Array<{ c: number }>;
  if (existingAdoption[0]!.c > 0) {
    console.log('  acc_school_framework_adoptions already populated for demo school — skipping');
    return;
  }

  // Resolve users + employees needed for FK / soft-FK fields
  async function findUser(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT pu.id::text AS account_id, pu.person_id::text AS person_id ' +
        'FROM platform.platform_users pu WHERE pu.email = $1 LIMIT 1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('user not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  async function findEmployeeId(personId: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text FROM ' + TENANT_SCHEMA + '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
      personId,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees row not found for person ' + personId);
    return rows[0]!.id;
  }

  const principal = await findUser('principal@demo.campusos.dev');
  const vp = await findUser('vp@demo.campusos.dev');
  const teacher = await findUser('teacher@demo.campusos.dev');
  const vpEmpId = await findEmployeeId(vp.personId);
  const teacherEmpId = await findEmployeeId(teacher.personId);

  // ── B1. Adoption: Lincoln adopts AdvancED ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.acc_school_framework_adoptions (id, school_id, platform_framework_id, adopted_at, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, true)',
    generateId(),
    school.id,
    advanced.id,
    '2025-08-15',
  );

  // ── B2. Custom framework: "Lincoln Teaching Excellence" ──
  const customFwId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.acc_frameworks (id, school_id, name, description, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, true)',
    customFwId,
    school.id,
    'Lincoln Teaching Excellence',
    'Lincoln Academy in-house teaching standards — supplements AdvancED with school-specific expectations on student-centred instruction, restorative practice, and family partnership.',
  );

  // Pull the first 10 AdvancED platform standards for ratings/evidence
  const platformStandardRows = (await client.$queryRawUnsafe(
    'SELECT id::text, standard_code, domain FROM platform.acc_standards_platform WHERE framework_id = $1::uuid ORDER BY sort_order ASC LIMIT 10',
    advanced.id,
  )) as Array<{ id: string; standard_code: string; domain: string }>;

  // ── B3. Evidence items: 8 items spanning 5 evidence_type values ──
  // Mix of statuses: 4 APPROVED, 2 SUBMITTED, 2 DRAFT
  const std11 = platformStandardRows[0]!; // 1.1 Purpose and Direction
  const std23 = platformStandardRows[5]!; // 2.3 Stakeholder engagement
  const std31 = platformStandardRows[7]!; // 3.1 Curriculum
  const std33 = platformStandardRows[9]!; // 3.3 Teaching strategies (or close)

  const evidenceRows: Array<{
    standardId: string;
    type: string;
    title: string;
    description: string | null;
    s3Key: string | null;
    url: string | null;
    metric: string | null;
    status: string;
    reviewerNotes: string | null;
  }> = [
    {
      standardId: std11.id,
      type: 'DOCUMENT',
      title: 'School mission statement (2025-2026)',
      description: 'Reviewed and ratified by board on 2025-08-01.',
      s3Key: 'accreditation/lincoln/mission-2025-2026.pdf',
      url: null,
      metric: null,
      status: 'APPROVED',
      reviewerNotes: 'Clear alignment with AdvancED 1.1 — direct mission statement reference.',
    },
    {
      standardId: std11.id,
      type: 'URL',
      title: 'Lincoln Academy strategic plan 2025-2028',
      description: 'Public strategic plan landing page.',
      s3Key: null,
      url: 'https://lincolnacademy.example.org/strategic-plan',
      metric: null,
      status: 'APPROVED',
      reviewerNotes: 'Aligns to mission and is publicly accessible.',
    },
    {
      standardId: std23.id,
      type: 'SURVEY',
      title: 'Spring 2026 parent engagement survey results',
      description: '78% response rate, 4.2 / 5 average satisfaction.',
      s3Key: 'accreditation/lincoln/parent-survey-spring-2026.pdf',
      url: null,
      metric: null,
      status: 'APPROVED',
      reviewerNotes: 'Strong evidence of stakeholder engagement.',
    },
    {
      standardId: std23.id,
      type: 'OBSERVATION',
      title: 'Q2 community advisory council minutes',
      description: 'Minutes from Oct, Nov, Dec 2025 meetings.',
      s3Key: 'accreditation/lincoln/cac-minutes-q2-2025.pdf',
      url: null,
      metric: null,
      status: 'SUBMITTED',
      reviewerNotes: null,
    },
    {
      standardId: std31.id,
      type: 'METRIC',
      title: 'Cross-grade curriculum coverage report',
      description:
        'Percentage of CCSS ELA standards explicitly addressed in published curriculum maps.',
      s3Key: null,
      url: null,
      metric: '94%',
      status: 'APPROVED',
      reviewerNotes: 'Above the 90% benchmark.',
    },
    {
      standardId: std31.id,
      type: 'DOCUMENT',
      title: 'Grade 5 ELA curriculum map (PUBLISHED)',
      description: 'Full annual scope and sequence ratified by department head.',
      s3Key: 'accreditation/lincoln/g5-ela-curriculum-map.pdf',
      url: null,
      metric: null,
      status: 'SUBMITTED',
      reviewerNotes: null,
    },
    {
      standardId: std33.id,
      type: 'OBSERVATION',
      title: 'Fall 2025 classroom walkthrough summary',
      description: 'Inconsistent implementation of cooperative learning across grade bands.',
      s3Key: 'accreditation/lincoln/walkthrough-fall-2025.pdf',
      url: null,
      metric: null,
      status: 'DRAFT',
      reviewerNotes: null,
    },
    {
      standardId: std33.id,
      type: 'URL',
      title: 'Department PD calendar 2025-2026',
      description: 'Internal sharepoint of monthly PD topics.',
      s3Key: null,
      url: 'https://lincolnacademy.example.org/internal/pd-calendar',
      metric: null,
      status: 'DRAFT',
      reviewerNotes: null,
    },
  ];

  for (let i = 0; i < evidenceRows.length; i++) {
    const e = evidenceRows[i]!;
    const isReviewed = e.status === 'APPROVED' || e.status === 'REJECTED';
    const submittedAt = e.status === 'DRAFT' ? null : '2025-12-01T10:00:00Z';
    const reviewedAt = isReviewed ? '2025-12-08T15:00:00Z' : null;
    const reviewedBy = isReviewed ? principal.accountId : null;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.acc_evidence_items (id, school_id, standard_id, evidence_type, title, description, s3_key, url, metric_value, status, submitted_by, submitted_at, reviewed_by, reviewed_at, reviewer_notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11::uuid, $12::timestamptz, $13::uuid, $14::timestamptz, $15)',
      generateId(),
      school.id,
      e.standardId,
      e.type,
      e.title,
      e.description,
      e.s3Key,
      e.url,
      e.metric,
      e.status,
      teacher.accountId,
      submittedAt,
      reviewedBy,
      reviewedAt,
      e.reviewerNotes,
    );
  }

  // ── B4. Self-study ratings: 10 ratings for cycle 2025-2026 ──
  // 4 ACCOMPLISHED, 3 DEVELOPING, 2 EXEMPLARY, 1 NOT_MET
  const ratings: Array<{ stdId: string; rating: string; rationale: string }> = [
    {
      stdId: platformStandardRows[0]!.id,
      rating: 'EXEMPLARY',
      rationale:
        'Mission and direction are clearly articulated and stakeholders demonstrate deep alignment. Annual strategic review captured in board minutes.',
    },
    {
      stdId: platformStandardRows[1]!.id,
      rating: 'ACCOMPLISHED',
      rationale: 'Stakeholders consistently support the systems purpose with documented action.',
    },
    {
      stdId: platformStandardRows[2]!.id,
      rating: 'ACCOMPLISHED',
      rationale: 'Annual review process is in place with stakeholder participation.',
    },
    {
      stdId: platformStandardRows[3]!.id,
      rating: 'EXEMPLARY',
      rationale: 'Board policy is comprehensive and well-administered.',
    },
    {
      stdId: platformStandardRows[4]!.id,
      rating: 'ACCOMPLISHED',
      rationale: 'Board operates effectively with documented self-evaluation.',
    },
    {
      stdId: platformStandardRows[5]!.id,
      rating: 'DEVELOPING',
      rationale: 'Stakeholder engagement is improving but inconsistent across community segments.',
    },
    {
      stdId: platformStandardRows[6]!.id,
      rating: 'ACCOMPLISHED',
      rationale: 'Leadership culture aligns with school purpose.',
    },
    {
      stdId: platformStandardRows[7]!.id,
      rating: 'DEVELOPING',
      rationale: 'Curriculum coverage is strong but vertical alignment needs strengthening.',
    },
    {
      stdId: platformStandardRows[8]!.id,
      rating: 'NOT_MET',
      rationale: 'Systematic curriculum monitoring against assessment data is not yet established.',
    },
    {
      stdId: platformStandardRows[9]!.id,
      rating: 'DEVELOPING',
      rationale: 'Teaching strategies vary in effectiveness across grade bands.',
    },
  ];

  for (const r of ratings) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.acc_self_study_ratings (id, school_id, standard_id, cycle_id, rating, rationale, rated_by, rated_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, $8::timestamptz)',
      generateId(),
      school.id,
      r.stdId,
      '2025-2026',
      r.rating,
      r.rationale,
      principal.accountId,
      '2025-12-15T10:00:00Z',
    );
  }

  // ── B5. Action plans: 1 IN_PROGRESS, 1 OVERDUE ──
  // OVERDUE one's target_date in the past — exercises ActionPlanOverdueWorker
  const actionsInProgress = JSON.stringify([
    {
      description: 'Select classroom-management framework',
      due_date: '2026-01-15',
      status: 'COMPLETED',
    },
    {
      description: 'Staff training on selected framework',
      due_date: '2026-03-15',
      status: 'COMPLETED',
    },
    {
      description: 'Classroom observation cycle (round 1)',
      due_date: '2026-08-30',
      status: 'PENDING',
    },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.acc_action_plans (id, school_id, standard_id, goal, actions, responsible_party, target_date, status, notes, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid, $7::date, $8, $9, $10::uuid)',
    generateId(),
    school.id,
    platformStandardRows[9]!.id, // 3.3 (DEVELOPING)
    'Implement consistent classroom management framework across all grade bands.',
    actionsInProgress,
    vpEmpId,
    '2026-09-30',
    'IN_PROGRESS',
    'On track for September 2026 — observation cycle still pending.',
    principal.accountId,
  );

  const actionsOverdue = JSON.stringify([
    {
      description: 'Establish curriculum monitoring rubric',
      due_date: '2026-02-01',
      status: 'COMPLETED',
    },
    {
      description: 'Train department heads on rubric application',
      due_date: '2026-04-01',
      status: 'PENDING',
    },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.acc_action_plans (id, school_id, standard_id, goal, actions, responsible_party, target_date, status, notes, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::uuid, $7::date, $8, $9, $10::uuid)',
    generateId(),
    school.id,
    platformStandardRows[8]!.id, // 3.2 (NOT_MET)
    'Establish systematic curriculum monitoring against assessment data.',
    actionsOverdue,
    teacherEmpId,
    '2026-04-30',
    'OVERDUE',
    'Department head training slipped — plan being re-baselined.',
    principal.accountId,
  );

  // ── B6. Site visit prep: PREPARING with readiness_score=75 ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.acc_site_visit_prep (id, school_id, visit_date, accreditor_org, lead_contact_name, lead_contact_email, status, readiness_score, notes, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, $10::uuid)',
    generateId(),
    school.id,
    '2026-10-15',
    'AdvancED Southern Region',
    'Dr. Pat Smith',
    'pat.smith@advanced.example.org',
    'PREPARING',
    75,
    'Initial readiness target met — pushing to close gaps on Standard 3 evidence + a few unrated standards.',
    principal.accountId,
  );

  console.log(
    '  Tenant adoption: AdvancED + 1 custom framework + 8 evidence items + 10 ratings + 2 action plans (1 IN_PROGRESS, 1 OVERDUE) + 1 site visit prep (PREPARING, score=75)',
  );
}

(async (): Promise<void> => {
  try {
    await seedAccreditation();
    console.log('');
    console.log('  Accreditation seed complete.');
  } catch (err) {
    console.error('Accreditation seed failed:', err);
    process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
})();
