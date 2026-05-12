import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/**
 * P2-21c Community Exchange seed.
 *
 * Idempotent: gates on `platform_community_profiles` row count. Seeds
 * community profiles for the 5 main demo personas + Lincoln Academy
 * sample marketplace activity covering all 6 listing types, one
 * completed asset transaction with the 5% fee split keystone, paired
 * SELLER_LISTING and BUYER_RECEIPT condition reports, an active watch
 * list, a few star ratings + reputation log entries, and a populated
 * search index so the GIN-backed full-text endpoint returns results
 * straight away.
 */

async function seedCommunity(): Promise<void> {
  console.log('');
  console.log('  P2-21c Community Exchange Seed');
  console.log('');

  const client = getPlatformClient();
  const existing = (await client.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM platform.platform_community_profiles`,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  platform_community_profiles already populated. Skipping.');
    return;
  }

  // Look up the seeded demo personas + the demo school.
  const personas = (await client.$queryRawUnsafe(
    `SELECT u.email AS email, p.id::text AS person_id,
            p.first_name AS first_name, p.last_name AS last_name
     FROM platform.platform_users u
     JOIN platform.iam_person p ON p.id = u.person_id
     WHERE u.email IN (
       'admin@demo.campusos.dev',
       'principal@demo.campusos.dev',
       'teacher@demo.campusos.dev',
       'parent@demo.campusos.dev',
       'student@demo.campusos.dev'
     )`,
  )) as Array<{ email: string; person_id: string; first_name: string; last_name: string }>;
  const byEmail = new Map(personas.map((r) => [r.email, r]));

  const principal = byEmail.get('principal@demo.campusos.dev');
  const teacher = byEmail.get('teacher@demo.campusos.dev');
  const parent = byEmail.get('parent@demo.campusos.dev');
  const student = byEmail.get('student@demo.campusos.dev');
  if (!principal || !teacher || !parent || !student) {
    throw new Error('Missing seeded personas — run `pnpm seed` first');
  }

  const schoolRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS school_id FROM platform.schools
     WHERE subdomain='demo' LIMIT 1`,
  )) as Array<{ school_id: string }>;
  if (schoolRows.length === 0) {
    throw new Error('demo school not found — run `pnpm seed` first');
  }
  const schoolId = schoolRows[0]!.school_id;

  // ── A. Community profiles ─────────────────────────────────────────
  const profileTeacherId = generateId();
  const profilePrincipalId = generateId();
  const profileParentId = generateId();
  const profileStudentId = generateId();

  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_community_profiles
      (id, person_id, display_name, bio, school_name, role_label, reputation_points)
     VALUES
      ($1::uuid, $2::uuid, 'James Rivera',
       'Grade 5 ELA teacher who loves sharing classroom resources.',
       'Lincoln Academy', 'Teacher', 45),
      ($3::uuid, $4::uuid, 'Sarah Mitchell',
       'Principal at Lincoln Academy — building bridges across schools.',
       'Lincoln Academy', 'Principal', 120),
      ($5::uuid, $6::uuid, 'David Chen',
       'Parent of Maya, Grade 5 at Lincoln Academy.',
       'Lincoln Academy', 'Parent', 0),
      ($7::uuid, $8::uuid, 'Maya Chen',
       'Grade 5 student.',
       'Lincoln Academy', 'Student', 0)`,
    profileTeacherId,
    teacher.person_id,
    profilePrincipalId,
    principal.person_id,
    profileParentId,
    parent.person_id,
    profileStudentId,
    student.person_id,
  );

  // ── B. Marketplace listings ────────────────────────────────────────
  // Cover all 6 listing types. Mix of DRAFT, ACTIVE, SOLD statuses so
  // the demo UI has rows in each filter bucket.
  const listingBookId = generateId();
  const listingEducationalId = generateId();
  const listingSurplusId = generateId();
  const listingFieldTripId = generateId();
  const listingPortfolioId = generateId();
  const listingKnowledgeId = generateId();

  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_marketplace_listings
      (id, listing_type, title, description, seller_school_id, seller_profile_id,
       price_cents, condition, category, tags, status, published_at, search_keywords)
     VALUES
      ($1::uuid, 'BOOK',
       'Set of 30 Grade 5 ELA novels',
       'Class set of Charlotte''s Web and Holes — 15 of each, lightly used. Pickup or carrier shipping.',
       $2::uuid, $3::uuid, 12000, 'GOOD', 'ELA',
       ARRAY['novels','grade-5','class-set']::text[],
       'ACTIVE', now() - INTERVAL '3 days',
       to_tsvector('english', 'Set of 30 Grade 5 ELA novels Charlotte Web Holes')),
      ($4::uuid, 'EDUCATIONAL',
       'Math manipulatives kit',
       'Complete fractions + decimals manipulatives kit — used for one academic year.',
       $2::uuid, $3::uuid, 4500, 'LIKE_NEW', 'Math',
       ARRAY['fractions','manipulatives','math']::text[],
       'ACTIVE', now() - INTERVAL '5 days',
       to_tsvector('english', 'Math manipulatives kit fractions decimals')),
      ($5::uuid, 'SURPLUS_ASSET',
       '12-seat student lab table',
       'Lab table from chemistry classroom remodel. Sturdy, scratched.',
       $2::uuid, $6::uuid, 30000, 'FAIR', 'Furniture',
       ARRAY['furniture','lab','table']::text[],
       'ACTIVE', now() - INTERVAL '7 days',
       to_tsvector('english', 'Lab table chemistry classroom')),
      ($7::uuid, 'FIELD_TRIP',
       'Local Aquarium docent-led trip',
       'Field trip slot for up to 60 students. Includes 90-min docent tour.',
       $2::uuid, $8::uuid, NULL, NULL, 'Science',
       ARRAY['field-trip','aquarium','science']::text[],
       'ACTIVE', now() - INTERVAL '1 day',
       to_tsvector('english', 'Local Aquarium docent led trip')),
      ($9::uuid, 'PORTFOLIO',
       'Class wall art: Geology mural',
       'Student-collaborative geology mural from Spring 2026. Available for digital reproduction.',
       $2::uuid, $3::uuid, 0, NULL, 'Art',
       ARRAY['art','portfolio','geology']::text[],
       'SOLD', now() - INTERVAL '14 days',
       to_tsvector('english', 'Class wall art Geology mural collaborative')),
      ($10::uuid, 'KNOWLEDGE',
       'Differentiated reading instruction playbook',
       'Multi-year playbook for differentiating Grade 4-6 reading. PDF + Google Doc.',
       $2::uuid, $8::uuid, 1500, NULL, 'Pedagogy',
       ARRAY['reading','differentiation','professional-development']::text[],
       'ACTIVE', now() - INTERVAL '2 days',
       to_tsvector('english', 'Differentiated reading instruction playbook'))`,
    listingBookId,
    schoolId,
    profileTeacherId,
    listingEducationalId,
    listingSurplusId,
    profilePrincipalId,
    listingFieldTripId,
    profilePrincipalId,
    listingPortfolioId,
    listingKnowledgeId,
  );

  // ── C. Asset transaction (CONFIRMED) with 5% fee split keystone ────
  // The portfolio mural sold for $0 (free) — no fee. Use the book set
  // for the live transaction so the fee math is exercised.
  const txnId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_asset_transactions
      (id, listing_id, buyer_type, buyer_school_id, seller_school_id, seller_profile_id,
       quantity, unit_price_cents, total_price_cents,
       platform_fee_cents, seller_receives_cents,
       stripe_payment_intent_id, status,
       shipping_method, tracking_number,
       paid_at, shipped_at, delivered_at, confirmed_at)
     VALUES ($1::uuid, $2::uuid, 'SCHOOL', $3::uuid, $3::uuid, $4::uuid,
       1, 12000, 12000, 600, 11400,
       'pi_dev_demo_book_set', 'CONFIRMED',
       'CARRIER', 'TRK-DEMO-001',
       now() - INTERVAL '6 days',
       now() - INTERVAL '5 days',
       now() - INTERVAL '3 days',
       now() - INTERVAL '2 days')`,
    txnId,
    listingBookId,
    schoolId,
    profileTeacherId,
  );

  // ── D. Condition reports (seller listing + buyer receipt) ──────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_asset_condition_reports
      (id, transaction_id, reporter_type, condition, condition_notes, reported_by, reported_at)
     VALUES
      ($1::uuid, $2::uuid, 'SELLER_LISTING', 'GOOD',
       'Lightly used. A few covers have minor wear.',
       $3::uuid, now() - INTERVAL '3 days'),
      ($4::uuid, $2::uuid, 'BUYER_RECEIPT', 'GOOD',
       'Books arrived as described. Quantity matched.',
       $5::uuid, now() - INTERVAL '2 days')`,
    generateId(),
    txnId,
    teacher.person_id,
    generateId(),
    principal.person_id,
  );

  // ── E. Watch list ─────────────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_marketplace_watch_lists
      (id, school_id, target_listing_type, search_keywords, max_price_cents,
       condition_min, status, created_by)
     VALUES ($1::uuid, $2::uuid, 'EDUCATIONAL', 'science lab kit', 5000,
       'GOOD', 'ACTIVE', $3::uuid)`,
    generateId(),
    schoolId,
    principal.person_id,
  );

  // ── F. Star ratings + reputation log ──────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_community_ratings
      (id, rateable_type, rateable_id, rated_by, score, review_text, helpful_votes)
     VALUES
      ($1::uuid, 'LISTING', $2::uuid, $3::uuid, 5,
       'Books were exactly as described. Smooth transaction.', 3),
      ($4::uuid, 'TRANSACTION', $5::uuid, $3::uuid, 5,
       'Great seller — fast shipping.', 1)`,
    generateId(),
    listingBookId,
    principal.person_id,
    generateId(),
    txnId,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_community_reputation_log
      (id, profile_id, points_delta, reason, reference_id)
     VALUES
      ($1::uuid, $2::uuid, 30, 'LISTING_SOLD', $3::uuid),
      ($4::uuid, $2::uuid, 10, 'RATING_RECEIVED', $5::uuid),
      ($6::uuid, $2::uuid, 5, 'HELPFUL_VOTE', $5::uuid),
      ($7::uuid, $8::uuid, 100, 'ADMIN_ADJUSTMENT', NULL),
      ($9::uuid, $8::uuid, 20, 'HELPFUL_VOTE', NULL)`,
    generateId(),
    profileTeacherId,
    txnId,
    generateId(),
    listingBookId,
    generateId(),
    generateId(),
    profilePrincipalId,
    generateId(),
  );

  // ── G. Search index (matches listings + one knowledge article stub) ─
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_search_index
      (id, content_type, content_id, title, body_preview, search_vector,
       school_id, author_profile_id, content_date)
     VALUES
      ($1::uuid, 'LISTING', $2::uuid,
       'Set of 30 Grade 5 ELA novels',
       'Class set of Charlotte''s Web and Holes',
       to_tsvector('english', 'Set of 30 Grade 5 ELA novels Charlotte Web Holes class set'),
       $3::uuid, $4::uuid, now() - INTERVAL '3 days'),
      ($5::uuid, 'LISTING', $6::uuid,
       'Math manipulatives kit',
       'Complete fractions + decimals manipulatives',
       to_tsvector('english', 'Math manipulatives kit fractions decimals'),
       $3::uuid, $4::uuid, now() - INTERVAL '5 days'),
      ($7::uuid, 'KNOWLEDGE_ARTICLE', $8::uuid,
       'Differentiated reading instruction playbook',
       'Multi-year playbook for Grade 4-6',
       to_tsvector('english', 'Differentiated reading instruction playbook Grade'),
       $3::uuid, $4::uuid, now() - INTERVAL '2 days'),
      ($9::uuid, 'PROFILE', $4::uuid,
       'James Rivera',
       'Grade 5 ELA teacher who loves sharing classroom resources',
       to_tsvector('english', 'James Rivera Grade 5 ELA teacher classroom resources'),
       $3::uuid, $4::uuid, now())`,
    generateId(),
    listingBookId,
    schoolId,
    profileTeacherId,
    generateId(),
    listingEducationalId,
    generateId(),
    listingKnowledgeId,
    generateId(),
  );

  console.log(
    '  P2-21c Community Exchange seeded: 4 profiles, 6 listings (all 6 types), 1 CONFIRMED transaction',
  );
  console.log(
    '  with 5% fee split ($120/$114 → $6/$114), 2 condition reports, 1 active watch list, 2 ratings,',
  );
  console.log(
    '  5 reputation log entries, 4 search-index rows. Lincoln Academy is buyer + seller for the demo.',
  );
}

async function main(): Promise<void> {
  try {
    await seedCommunity();
  } finally {
    await disconnectAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
