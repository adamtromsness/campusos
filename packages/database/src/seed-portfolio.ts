import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-portfolio.ts — Cycle 24 Step 3.
 *
 * M26 Portfolio. Idempotent — gated on whether Maya already has
 * a portfolio row.
 *
 * Tenant-only seed. Maya gets:
 *   - 1 portfolio "My Academic Journey" (visibility=TEACHER)
 *   - 5 portfolio items: SUBMISSION (Industrial Revolution Essay,
 *     featured=true), GRADE (Cell Structure Test grade), REFLECTION
 *     (personal growth in writing), CERTIFICATE (S3 stub for the
 *     Summer Reading Certificate), EXTERNAL_FILE (S3 stub for a
 *     science fair photo).
 *   - 3 achievements: "Outstanding Writer" ACADEMIC (awarded by
 *     Rivera, manual), "Summer Reading Champion" COMMUNITY
 *     (source_module=library, source_ref_id is a synthetic UUID
 *     that the Cycle 12 lib_programme_completions backfill on
 *     completion would real-fill), "Community Service Star"
 *     COMMUNITY (source_module=clubs, source_ref_id resolves to
 *     Maya's seeded ext_service_progress row from Cycle 17).
 *   - 1 share link (token-32-byte hex, expires +30d, recipient
 *     uncle@example.com)
 *   - 1 achievement share (Outstanding Writer via EMAIL)
 *
 * Cross-cycle source resolution is verified at the application
 * layer — the seed plants the soft FK shape so the Step 4 service
 * can demo the resolver against real Cycle 2 + Cycle 17 rows.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function main() {
  const client = getPlatformClient();

  // Resolve tenant routing
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

  // Resolve Maya
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

  // Idempotency gate: skip if Maya already has a portfolio
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.pfl_portfolios WHERE student_id = $1::uuid`,
    maya.sis_student_id,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log("Maya's portfolio already exists — skipping");
    await disconnectAll();
    return;
  }

  // Resolve Rivera (teacher who awards "Outstanding Writer")
  const riveraRows = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS employee_id
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id
     WHERE ip.first_name = 'James' AND ip.last_name = 'Rivera'
     LIMIT 1`,
  )) as Array<{ employee_id: string }>;
  const riveraEmployeeId = riveraRows[0]?.employee_id;

  // Resolve a real Maya cls_submission + cls_grade (for source_ref_id resolution demo)
  const submissionRows = (await client.$queryRawUnsafe(
    `SELECT s.id::text AS submission_id, a.title AS assignment_title
     FROM ${TENANT_SCHEMA}.cls_submissions s
     JOIN ${TENANT_SCHEMA}.cls_assignments a ON a.id = s.assignment_id
     WHERE s.student_id = $1::uuid AND a.title LIKE '%Industrial Revolution%'
     LIMIT 1`,
    maya.sis_student_id,
  )) as Array<{ submission_id: string; assignment_title: string }>;
  const submissionId = submissionRows[0]?.submission_id ?? generateId();
  const submissionTitle = submissionRows[0]?.assignment_title ?? 'Industrial Revolution Essay';

  const gradeRows = (await client.$queryRawUnsafe(
    `SELECT g.id::text AS grade_id, a.title AS assignment_title
     FROM ${TENANT_SCHEMA}.cls_grades g
     JOIN ${TENANT_SCHEMA}.cls_assignments a ON a.id = g.assignment_id
     WHERE g.student_id = $1::uuid AND a.title LIKE '%Cell Structure%'
     LIMIT 1`,
    maya.sis_student_id,
  )) as Array<{ grade_id: string; assignment_title: string }>;
  const gradeId = gradeRows[0]?.grade_id ?? generateId();
  const gradeTitle = gradeRows[0]?.assignment_title ?? 'Cell Structure Test';

  // Resolve Maya's seeded service progress row (Cycle 17 cross-cycle keystone)
  const serviceRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS progress_id
     FROM ${TENANT_SCHEMA}.ext_service_progress
     WHERE student_id = $1::uuid
     LIMIT 1`,
    maya.sis_student_id,
  )) as Array<{ progress_id: string }>;
  const serviceProgressId = serviceRows[0]?.progress_id ?? null;

  // ── A. portfolio ──
  const portfolioId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolios (id, student_id, school_id, title, description, visibility, share_link_enabled)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)`,
    portfolioId,
    maya.sis_student_id,
    schoolId,
    'My Academic Journey',
    'A collection of work and achievements from Grade 5.',
    'TEACHER',
    true,
  );

  // ── B. 3 achievements ──
  const ach1Id = generateId(); // Outstanding Writer ACADEMIC (manual, awarded by Rivera)
  const ach2Id = generateId(); // Summer Reading Champion COMMUNITY (source_module=library)
  const ach3Id = generateId(); // Community Service Star COMMUNITY (source_module=clubs, ext_service_progress)

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_achievements
       (id, student_id, school_id, title, achievement_type, source_module, source_ref_id, awarded_at, awarded_by, description, badge_image_url)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, NULL, NULL, CURRENT_DATE - INTERVAL '14 days', $6::uuid, $7, $8)`,
    ach1Id,
    maya.sis_student_id,
    schoolId,
    'Outstanding Writer',
    'ACADEMIC',
    riveraEmployeeId,
    'Awarded for excellence in narrative writing across the Grade 5 ELA scope-and-sequence.',
    'https://placeholder.campusos.dev/badges/outstanding-writer.svg',
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_achievements
       (id, student_id, school_id, title, achievement_type, source_module, source_ref_id, awarded_at, awarded_by, description, badge_image_url)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, CURRENT_DATE - INTERVAL '7 days', NULL, $8, $9)`,
    ach2Id,
    maya.sis_student_id,
    schoolId,
    'Summer Reading Champion',
    'COMMUNITY',
    'library',
    generateId(), // synthetic source_ref_id — Cycle 12 lib_programme_completions backfill on completion would real-fill
    'Completed all books in the Summer Reading Challenge.',
    'https://placeholder.campusos.dev/badges/summer-reading.svg',
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_achievements
       (id, student_id, school_id, title, achievement_type, source_module, source_ref_id, awarded_at, awarded_by, description, badge_image_url)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::uuid, CURRENT_DATE - INTERVAL '3 days', NULL, $8, $9)`,
    ach3Id,
    maya.sis_student_id,
    schoolId,
    'Community Service Star',
    'COMMUNITY',
    'clubs',
    serviceProgressId, // Cycle 17 ext_service_progress row id
    serviceProgressId
      ? 'Logged service hours through the M64 Service Programme module.'
      : 'Service hour milestone achievement.',
    'https://placeholder.campusos.dev/badges/community-service.svg',
  );

  // ── C. 5 portfolio items ──
  // C1 SUBMISSION (Industrial Revolution Essay, featured)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_items
       (id, portfolio_id, item_type, source_ref_id, title, description, is_featured, added_at)
     VALUES ($1::uuid, $2::uuid, 'SUBMISSION', $3::uuid, $4, $5, true, now() - INTERVAL '5 days')`,
    generateId(),
    portfolioId,
    submissionId,
    submissionTitle,
    'My favourite essay from the year.',
  );

  // C2 GRADE (Cell Structure Test)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_items
       (id, portfolio_id, item_type, source_ref_id, title, description, is_featured, added_at)
     VALUES ($1::uuid, $2::uuid, 'GRADE', $3::uuid, $4, NULL, false, now() - INTERVAL '4 days')`,
    generateId(),
    portfolioId,
    gradeId,
    gradeTitle,
  );

  // C3 REFLECTION
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_items
       (id, portfolio_id, item_type, source_ref_id, title, description, is_featured, added_at)
     VALUES ($1::uuid, $2::uuid, 'REFLECTION', NULL, $3, $4, false, now() - INTERVAL '3 days')`,
    generateId(),
    portfolioId,
    'My growth as a writer this year',
    'I learned how to use dialogue to make characters come alive. Mr Rivera helped me see how pacing changes the way a story feels.',
  );

  // C4 CERTIFICATE (Summer Reading)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_items
       (id, portfolio_id, item_type, source_ref_id, title, description, s3_key, is_featured, added_at)
     VALUES ($1::uuid, $2::uuid, 'CERTIFICATE', NULL, $3, $4, $5, false, now() - INTERVAL '2 days')`,
    generateId(),
    portfolioId,
    'Summer Reading Certificate',
    'Earned by completing the Summer Reading Challenge.',
    'tenant_demo/portfolios/maya/summer-reading-cert.pdf',
  );

  // C5 EXTERNAL_FILE (science fair photo)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_items
       (id, portfolio_id, item_type, source_ref_id, title, description, s3_key, is_featured, added_at)
     VALUES ($1::uuid, $2::uuid, 'EXTERNAL_FILE', NULL, $3, $4, $5, false, now() - INTERVAL '1 day')`,
    generateId(),
    portfolioId,
    'Science Fair photo',
    'Photo of my science fair display board on photosynthesis.',
    'tenant_demo/portfolios/maya/science-fair.jpg',
  );

  // ── D. 1 share link ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_portfolio_shares
       (id, portfolio_id, share_token, expires_at, recipient_email, status, created_by)
     VALUES ($1::uuid, $2::uuid, $3, now() + INTERVAL '30 days', $4, 'ACTIVE', $5::uuid)`,
    generateId(),
    portfolioId,
    'seedportfoliotokenmaya000000000000000abc',
    'uncle@example.com',
    maya.account_id,
  );

  // ── E. 1 achievement share (Outstanding Writer via EMAIL) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pfl_achievement_shares
       (id, achievement_id, shared_by, platform, shared_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'EMAIL', now() - INTERVAL '6 days')`,
    generateId(),
    ach1Id,
    maya.account_id,
  );

  console.log('Cycle 24 portfolio seed complete:');
  console.log("  - 1 portfolio (Maya's My Academic Journey, TEACHER visibility)");
  console.log(
    '  - 5 items (1 SUBMISSION featured + 1 GRADE + 1 REFLECTION + 1 CERTIFICATE + 1 EXTERNAL_FILE)',
  );
  console.log(
    '  - 3 achievements (Outstanding Writer ACADEMIC + Summer Reading Champion COMMUNITY + Community Service Star COMMUNITY)',
  );
  console.log('  - 1 portfolio share link (uncle@example.com, expires +30d)');
  console.log('  - 1 achievement share (Outstanding Writer via EMAIL)');

  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
