import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-curriculum.ts — Cycle 23 Step 3.
 *
 * M25 Curriculum & Standards. Idempotent — gated on whether the
 * platform CCSS ELA framework already exists.
 *
 * Two write surfaces:
 *   1. PLATFORM (one-time): seeds 3 national frameworks (CCSS ELA,
 *      CCSS Math, NGSS) with ~50 standards across them. The GIN
 *      index lights up immediately.
 *   2. TENANT (per-school): seeds 1 adoption (Lincoln Academy
 *      adopts CCSS ELA for 2025-2026), 1 custom framework
 *      ("Lincoln Academy Writing Standards") with 5 custom
 *      standards, 1 curriculum map "Grade 5 ELA 2025-2026"
 *      (PUBLISHED) with 4 units, 8 alignments on Narrative
 *      Writing (5 platform + 3 custom), 3 cls_lessons + 3 unit-
 *      lesson links, 4 delivery gap snapshot rows, 3 resources.
 */

const TENANT_SCHEMA = 'tenant_demo';

// ── 50 platform standards across 3 frameworks ──
type PlatformStdSpec = {
  code: string;
  description: string;
  gradeBand?: string;
  domain?: string;
  cluster?: string;
};

const CCSS_ELA_STANDARDS: PlatformStdSpec[] = [
  // Writing — narrative
  {
    code: 'CCSS.ELA-LITERACY.W.5.3a',
    description:
      'Orient the reader by establishing a situation and introducing a narrator and/or characters; organize an event sequence that unfolds naturally.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.3b',
    description:
      'Use narrative techniques, such as dialogue, description, and pacing, to develop experiences and events or show the responses of characters to situations.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.3c',
    description:
      'Use a variety of transitional words, phrases, and clauses to manage the sequence of events.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.3d',
    description:
      'Use concrete words and phrases and sensory details to convey experiences and events precisely.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.3e',
    description: 'Provide a conclusion that follows from the narrated experiences or events.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  // Writing — argument
  {
    code: 'CCSS.ELA-LITERACY.W.5.1',
    description:
      'Write opinion pieces on topics or texts, supporting a point of view with reasons and information.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.1a',
    description:
      'Introduce a topic or text clearly, state an opinion, and create an organizational structure that lists reasons logically.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Text Types and Purposes',
  },
  // Writing — research
  {
    code: 'CCSS.ELA-LITERACY.W.5.7',
    description:
      'Conduct short research projects that use several sources to build knowledge through investigation of different aspects of a topic.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Research to Build and Present Knowledge',
  },
  {
    code: 'CCSS.ELA-LITERACY.W.5.8',
    description:
      'Recall relevant information from experiences or gather relevant information from print and digital sources.',
    gradeBand: '5',
    domain: 'Writing',
    cluster: 'Research to Build and Present Knowledge',
  },
  // Reading literature
  {
    code: 'CCSS.ELA-LITERACY.RL.5.1',
    description:
      'Quote accurately from a text when explaining what the text says explicitly and when drawing inferences from the text.',
    gradeBand: '5',
    domain: 'Reading: Literature',
    cluster: 'Key Ideas and Details',
  },
  {
    code: 'CCSS.ELA-LITERACY.RL.5.2',
    description:
      'Determine a theme of a story, drama, or poem from details in the text, including how characters in a story or drama respond to challenges.',
    gradeBand: '5',
    domain: 'Reading: Literature',
    cluster: 'Key Ideas and Details',
  },
  {
    code: 'CCSS.ELA-LITERACY.RL.5.3',
    description:
      'Compare and contrast two or more characters, settings, or events in a story or drama, drawing on specific details in the text.',
    gradeBand: '5',
    domain: 'Reading: Literature',
    cluster: 'Key Ideas and Details',
  },
  // Reading informational
  {
    code: 'CCSS.ELA-LITERACY.RI.5.1',
    description:
      'Quote accurately from a text when explaining what the text says explicitly and when drawing inferences from the text.',
    gradeBand: '5',
    domain: 'Reading: Informational',
    cluster: 'Key Ideas and Details',
  },
  {
    code: 'CCSS.ELA-LITERACY.RI.5.2',
    description:
      'Determine two or more main ideas of a text and explain how they are supported by key details; summarize the text.',
    gradeBand: '5',
    domain: 'Reading: Informational',
    cluster: 'Key Ideas and Details',
  },
  // Speaking and listening
  {
    code: 'CCSS.ELA-LITERACY.SL.5.1',
    description:
      'Engage effectively in a range of collaborative discussions with diverse partners on grade 5 topics and texts, building on others ideas and expressing their own clearly.',
    gradeBand: '5',
    domain: 'Speaking and Listening',
    cluster: 'Comprehension and Collaboration',
  },
];

const CCSS_MATH_STANDARDS: PlatformStdSpec[] = [
  {
    code: 'CCSS.MATH.CONTENT.5.NBT.A.1',
    description:
      'Recognize that in a multi-digit number, a digit in one place represents 10 times as much as it represents in the place to its right and 1/10 of what it represents in the place to its left.',
    gradeBand: '5',
    domain: 'Number and Operations in Base Ten',
    cluster: 'Understand the place value system',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.NBT.B.5',
    description: 'Fluently multiply multi-digit whole numbers using the standard algorithm.',
    gradeBand: '5',
    domain: 'Number and Operations in Base Ten',
    cluster: 'Perform operations with multi-digit whole numbers',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.NBT.B.6',
    description:
      'Find whole-number quotients of whole numbers with up to four-digit dividends and two-digit divisors.',
    gradeBand: '5',
    domain: 'Number and Operations in Base Ten',
    cluster: 'Perform operations with multi-digit whole numbers',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.NF.A.1',
    description:
      'Add and subtract fractions with unlike denominators (including mixed numbers) by replacing given fractions with equivalent fractions.',
    gradeBand: '5',
    domain: 'Number and Operations — Fractions',
    cluster: 'Use equivalent fractions as a strategy',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.NF.B.4',
    description:
      'Apply and extend previous understandings of multiplication to multiply a fraction or whole number by a fraction.',
    gradeBand: '5',
    domain: 'Number and Operations — Fractions',
    cluster:
      'Apply and extend previous understandings of multiplication and division to multiply and divide fractions',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.MD.A.1',
    description:
      'Convert among different-sized standard measurement units within a given measurement system, and use these conversions in solving multi-step real world problems.',
    gradeBand: '5',
    domain: 'Measurement and Data',
    cluster: 'Convert like measurement units within a given measurement system',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.MD.C.3',
    description:
      'Recognize volume as an attribute of solid figures and understand concepts of volume measurement.',
    gradeBand: '5',
    domain: 'Measurement and Data',
    cluster: 'Geometric measurement: understand concepts of volume',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.G.A.1',
    description:
      'Use a pair of perpendicular number lines, called axes, to define a coordinate system, with the intersection of the lines (the origin) arranged to coincide with the 0 on each line.',
    gradeBand: '5',
    domain: 'Geometry',
    cluster: 'Graph points on the coordinate plane to solve real-world and mathematical problems',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.OA.A.1',
    description:
      'Use parentheses, brackets, or braces in numerical expressions, and evaluate expressions with these symbols.',
    gradeBand: '5',
    domain: 'Operations and Algebraic Thinking',
    cluster: 'Write and interpret numerical expressions',
  },
  {
    code: 'CCSS.MATH.CONTENT.5.OA.B.3',
    description:
      'Generate two numerical patterns using two given rules. Identify apparent relationships between corresponding terms.',
    gradeBand: '5',
    domain: 'Operations and Algebraic Thinking',
    cluster: 'Analyze patterns and relationships',
  },
];

const NGSS_STANDARDS: PlatformStdSpec[] = [
  {
    code: 'NGSS.5-PS1-1',
    description:
      'Develop a model to describe that matter is made of particles too small to be seen.',
    gradeBand: '5',
    domain: 'Physical Science',
    cluster: 'Structure and Properties of Matter',
  },
  {
    code: 'NGSS.5-PS1-2',
    description:
      'Measure and graph quantities to provide evidence that regardless of the type of change that occurs when heating, cooling, or mixing substances, the total weight of matter is conserved.',
    gradeBand: '5',
    domain: 'Physical Science',
    cluster: 'Structure and Properties of Matter',
  },
  {
    code: 'NGSS.5-LS1-1',
    description:
      'Support an argument that plants get the materials they need for growth chiefly from air and water.',
    gradeBand: '5',
    domain: 'Life Science',
    cluster: 'Photosynthesis and Cellular Respiration',
  },
  {
    code: 'NGSS.5-LS2-1',
    description:
      'Develop a model to describe the movement of matter among plants, animals, decomposers, and the environment.',
    gradeBand: '5',
    domain: 'Life Science',
    cluster: 'Ecosystem Dynamics',
  },
  {
    code: 'NGSS.5-ESS1-1',
    description:
      'Support an argument that differences in the apparent brightness of the sun compared to other stars is due to their relative distances from Earth.',
    gradeBand: '5',
    domain: 'Earth and Space Science',
    cluster: 'Earth in the Universe',
  },
  {
    code: 'NGSS.5-ESS2-1',
    description:
      'Develop a model using an example to describe ways the geosphere, biosphere, hydrosphere, and/or atmosphere interact.',
    gradeBand: '5',
    domain: 'Earth and Space Science',
    cluster: 'Earth Systems',
  },
  {
    code: 'NGSS.5-ESS3-1',
    description:
      'Obtain and combine information about ways individual communities use science ideas to protect the Earths resources and environment.',
    gradeBand: '5',
    domain: 'Earth and Space Science',
    cluster: 'Earth and Human Activity',
  },
  {
    code: 'NGSS.5-ETS1-1',
    description:
      'Define a simple design problem reflecting a need or a want that includes specified criteria for success and constraints on materials, time, or cost.',
    gradeBand: '5',
    domain: 'Engineering Design',
    cluster: 'Engineering Design',
  },
];

async function seedCurriculum() {
  console.log('');
  console.log('  Curriculum & Standards Seed (Cycle 23 Step 3)');
  console.log('');

  const client = getPlatformClient();

  // ── A. Platform frameworks (idempotent on framework name) ──
  const ccssElaName = 'Common Core State Standards — ELA';
  const ccssMathName = 'Common Core State Standards — Math';
  const ngssName = 'Next Generation Science Standards';

  async function ensureFramework(
    name: string,
    body: string,
    region: string,
    version: string,
    standards: PlatformStdSpec[],
  ): Promise<string> {
    const existing = (await client.$queryRawUnsafe(
      'SELECT id::text FROM platform.cur_standards_frameworks_platform WHERE name = $1 LIMIT 1',
      name,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      return existing[0]!.id;
    }
    const id = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO platform.cur_standards_frameworks_platform (id, name, body, region, version) VALUES ($1::uuid, $2, $3, $4, $5)',
      id,
      name,
      body,
      region,
      version,
    );
    for (const s of standards) {
      await client.$executeRawUnsafe(
        'INSERT INTO platform.cur_standards_platform (id, framework_id, code, description, grade_band, domain, cluster) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
        generateId(),
        id,
        s.code,
        s.description,
        s.gradeBand ?? null,
        s.domain ?? null,
        s.cluster ?? null,
      );
    }
    return id;
  }

  const ccssElaId = await ensureFramework(
    ccssElaName,
    'National Governors Association Center for Best Practices, Council of Chief State School Officers',
    'United States',
    '2010',
    CCSS_ELA_STANDARDS,
  );
  void (await ensureFramework(
    ccssMathName,
    'National Governors Association Center for Best Practices, Council of Chief State School Officers',
    'United States',
    '2010',
    CCSS_MATH_STANDARDS,
  ));
  void (await ensureFramework(ngssName, 'Achieve Inc.', 'United States', '2013', NGSS_STANDARDS));

  const totalPlatformStandards =
    CCSS_ELA_STANDARDS.length + CCSS_MATH_STANDARDS.length + NGSS_STANDARDS.length;
  console.log(
    `  Seeded 3 platform frameworks + ${totalPlatformStandards} platform standards (CCSS ELA + CCSS Math + NGSS)`,
  );

  // ── B. Tenant-side seed ──
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');

  const existingMap = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.cur_curriculum_maps WHERE school_id = $1::uuid',
    school.id,
  )) as Array<{ c: number }>;
  if (existingMap[0]!.c > 0) {
    console.log('  cur_curriculum_maps already populated for demo school. Skipping tenant seed.');
    return;
  }

  // Resolve users + academic year + class for cls_lessons seed
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' +
      TENANT_SCHEMA +
      ".sis_academic_years WHERE school_id = $1::uuid AND name = '2025-2026' LIMIT 1",
    school.id,
  )) as Array<{ id: string }>;
  if (yearRows.length === 0) throw new Error('2025-2026 academic year not found — run seed:sis');
  const yearId = yearRows[0]!.id;

  async function findUser(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT pu.id::text AS account_id, pu.person_id::text AS person_id FROM platform.platform_users pu WHERE pu.email = $1 LIMIT 1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('user not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const principal = await findUser('principal@demo.campusos.dev');
  const teacher = await findUser('teacher@demo.campusos.dev');

  // Find Rivera's hr_employees.id (for cls_lessons.teacher_id)
  const teacherEmpRows = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' + TENANT_SCHEMA + '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
    teacher.personId,
  )) as Array<{ id: string }>;
  const teacherEmpId = teacherEmpRows.length > 0 ? teacherEmpRows[0]!.id : null;

  // Find one of Rivera's classes (English 9 — that's an ELA class)
  const classRows = (await client.$queryRawUnsafe(
    'SELECT c.id::text FROM ' +
      TENANT_SCHEMA +
      '.sis_classes c JOIN ' +
      TENANT_SCHEMA +
      '.sis_courses co ON co.id = c.course_id WHERE c.school_id = $1::uuid LIMIT 1',
    school.id,
  )) as Array<{ id: string }>;
  const classId = classRows.length > 0 ? classRows[0]!.id : null;

  // ── B1. Adoption: school adopts CCSS ELA for 2025-2026 ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_school_framework_adoptions (id, school_id, platform_framework_id, academic_year_id, adopted_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)',
    generateId(),
    school.id,
    ccssElaId,
    yearId,
    principal.accountId,
    'Lincoln Academy adopts CCSS ELA for the 2025-2026 academic year.',
  );

  // ── B2. Custom framework "Lincoln Academy Writing Standards" ──
  const customFwId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_standards_frameworks (id, school_id, name, version, description, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    customFwId,
    school.id,
    'Lincoln Academy Writing Standards',
    '1.0',
    'School-specific writing standards layered on top of CCSS ELA — voice, audience awareness, and academic discourse.',
    principal.accountId,
  );

  const customStandards = [
    {
      code: 'LA.WRITE.VOICE.1',
      description: 'Develop a distinctive authorial voice across narrative pieces.',
      domain: 'Voice',
    },
    {
      code: 'LA.WRITE.AUDIENCE.1',
      description: 'Adapt tone and register based on the intended audience.',
      domain: 'Audience Awareness',
    },
    {
      code: 'LA.WRITE.DISCOURSE.1',
      description:
        'Use academic discourse markers (claim, evidence, warrant) in argumentative writing.',
      domain: 'Academic Discourse',
    },
    {
      code: 'LA.WRITE.REVISION.1',
      description: 'Apply substantive revision across multiple drafts based on peer feedback.',
      domain: 'Process',
    },
    {
      code: 'LA.WRITE.MENTOR.1',
      description: 'Identify craft moves in mentor texts and apply them in own writing.',
      domain: 'Mentor Texts',
    },
  ];
  const customStandardIds: string[] = [];
  for (const s of customStandards) {
    const id = generateId();
    customStandardIds.push(id);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cur_standards (id, framework_id, code, description, grade_band, domain) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
      id,
      customFwId,
      s.code,
      s.description,
      '5',
      s.domain,
    );
  }

  // ── B3. Curriculum map "Grade 5 ELA 2025-2026" PUBLISHED ──
  const mapId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_curriculum_maps (id, school_id, framework_id, academic_year_id, subject, grade_level, title, description, status, created_by, published_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'English Language Arts', '5', 'Grade 5 ELA 2025-2026', $5, 'PUBLISHED', $6::uuid, now())",
    mapId,
    school.id,
    ccssElaId,
    yearId,
    'Grade 5 English Language Arts curriculum map for the 2025-2026 academic year. Layered against CCSS ELA + Lincoln Academy Writing Standards.',
    principal.accountId,
  );

  // ── B4. 4 units in scope-and-sequence order ──
  const unit1Id = generateId();
  const unit2Id = generateId();
  const unit3Id = generateId();
  const unit4Id = generateId();
  const unitsSpec = [
    {
      id: unit1Id,
      title: 'Narrative Writing',
      description:
        'Personal narratives, short stories, and creative non-fiction. Story arc, dialogue, sensory detail.',
      seq: 1,
      weeks: 4,
      eq: ['How do narrative techniques bring a story to life?', 'What makes a story memorable?'],
    },
    {
      id: unit2Id,
      title: 'Persuasive Essays',
      description:
        'Opinion writing with claim + reasons + evidence. Argument structure, rebuttal, audience awareness.',
      seq: 2,
      weeks: 3,
      eq: ['How do writers persuade readers?', 'What makes evidence convincing?'],
    },
    {
      id: unit3Id,
      title: 'Research Reports',
      description:
        'Multi-source research projects on focused topics. Source evaluation, citation, synthesis.',
      seq: 3,
      weeks: 5,
      eq: ['How do we know what we know?', 'What makes a source trustworthy?'],
    },
    {
      id: unit4Id,
      title: 'Poetry & Creative Writing',
      description:
        'Poetry forms, figurative language, mentor texts. Free verse, narrative poetry, performance.',
      seq: 4,
      weeks: 3,
      eq: ['What makes poetry different from prose?', 'How does form shape meaning?'],
    },
  ];
  for (const u of unitsSpec) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cur_units (id, curriculum_map_id, title, description, sequence_order, estimated_weeks, essential_questions) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[])',
      u.id,
      mapId,
      u.title,
      u.description,
      u.seq,
      u.weeks,
      u.eq,
    );
  }

  // ── B5. 8 unit-standard alignments on Narrative Writing ──
  // Resolve 5 platform standards (W.5.3a..W.5.3e)
  const narrativeStdRows = (await client.$queryRawUnsafe(
    "SELECT id::text, code FROM platform.cur_standards_platform WHERE framework_id = $1::uuid AND code LIKE 'CCSS.ELA-LITERACY.W.5.3%' ORDER BY code",
    ccssElaId,
  )) as Array<{ id: string; code: string }>;
  for (const s of narrativeStdRows) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cur_unit_standards (id, unit_id, standard_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
      generateId(),
      unit1Id,
      s.id,
    );
  }
  // 3 custom standards on Narrative Writing
  for (const sid of customStandardIds.slice(0, 3)) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cur_unit_standards (id, unit_id, standard_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
      generateId(),
      unit1Id,
      sid,
    );
  }

  // ── B6. 3 cls_lessons + 3 cur_unit_lessons ──
  let lessonIds: string[] = [];
  if (classId) {
    const lessonsSpec = [
      {
        title: 'Lesson 1: What Makes a Story?',
        description: 'Introduce narrative arc + character + setting. Read aloud + discussion.',
        date: '2025-09-08',
        status: 'PUBLISHED',
      },
      {
        title: 'Lesson 2: Show, Don’t Tell',
        description: 'Sensory detail workshop. Mentor text analysis.',
        date: '2025-09-15',
        status: 'PUBLISHED',
      },
      {
        title: 'Lesson 3: Dialogue & Pacing',
        description: 'Practising dialogue tags + pacing variation.',
        date: '2025-09-22',
        status: 'DRAFT',
      },
    ];
    for (const l of lessonsSpec) {
      const lid = generateId();
      lessonIds.push(lid);
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cls_lessons (id, school_id, class_id, teacher_id, title, description, date, duration_minutes, learning_objectives, status) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, 50, ARRAY[]::text[], $8)',
        lid,
        school.id,
        classId,
        teacherEmpId,
        l.title,
        l.description,
        l.date,
        l.status,
      );
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.cur_unit_lessons (id, unit_id, cls_lesson_id) VALUES ($1::uuid, $2::uuid, $3::uuid)',
        generateId(),
        unit1Id,
        lid,
      );
    }
  }

  // ── B7. Delivery gap snapshot rows (4 rows on Narrative Writing) ──
  // The Step 6 worker will recompute these later — these are an
  // initial seeded snapshot so the UI has visible state before
  // the worker runs.
  const w53a = narrativeStdRows.find((s) => s.code === 'CCSS.ELA-LITERACY.W.5.3a');
  const w53b = narrativeStdRows.find((s) => s.code === 'CCSS.ELA-LITERACY.W.5.3b');
  const w53c = narrativeStdRows.find((s) => s.code === 'CCSS.ELA-LITERACY.W.5.3c');
  const w53d = narrativeStdRows.find((s) => s.code === 'CCSS.ELA-LITERACY.W.5.3d');
  const gapSpec: Array<{ stdId: string; type: string; planned: number; delivered: number }> = [];
  if (w53a) gapSpec.push({ stdId: w53a.id, type: 'COMPLETE', planned: 2, delivered: 2 });
  if (w53b) gapSpec.push({ stdId: w53b.id, type: 'PARTIAL', planned: 2, delivered: 1 });
  if (w53c) gapSpec.push({ stdId: w53c.id, type: 'NOT_STARTED', planned: 1, delivered: 0 });
  if (w53d) gapSpec.push({ stdId: w53d.id, type: 'NOT_STARTED', planned: 1, delivered: 0 });
  for (const g of gapSpec) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cur_delivery_gaps (id, unit_id, standard_id, gap_type, lessons_planned, lessons_delivered, last_assessed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now())',
      generateId(),
      unit1Id,
      g.stdId,
      g.type,
      g.planned,
      g.delivered,
    );
  }

  // ── B8. 3 resource links ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_resource_links (id, unit_id, resource_type, title, description, s3_key, is_teacher_only, uploaded_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'FILE', 'Narrative Writing Rubric', 'Teacher rubric for grading 5th-grade narratives.', 'curriculum/g5-ela/narrative-rubric.pdf', true, $3::uuid)",
    generateId(),
    unit1Id,
    teacher.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_resource_links (id, unit_id, resource_type, title, description, url, is_teacher_only, uploaded_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'URL', 'Story Structure Guide', 'Student-friendly handout on five-act story arc.', 'https://learn.lincoln-academy.example/story-arc', false, $3::uuid)",
    generateId(),
    unit1Id,
    teacher.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cur_resource_links (id, unit_id, resource_type, title, description, s3_key, is_teacher_only, uploaded_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'FILE', 'Example Narratives', 'Three exemplar 5th-grade narratives (high / mid / approaching).', 'curriculum/g5-ela/example-narratives.pdf', false, $3::uuid)",
    generateId(),
    unit1Id,
    teacher.accountId,
  );

  console.log('  Seeded 1 school adoption + 1 custom framework + 5 custom standards');
  console.log(
    `  Seeded 1 curriculum map "Grade 5 ELA 2025-2026" + 4 units + 8 alignments + ${lessonIds.length} lesson links`,
  );
  console.log(`  Seeded ${gapSpec.length} delivery gap rows + 3 resource links`);
}

async function main() {
  try {
    await seedCurriculum();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('Curriculum seed failed:', err);
  process.exit(1);
});
