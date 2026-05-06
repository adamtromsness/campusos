import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-publications.ts — Cycle 25 Step 4.
 *
 * M42 Publications. Idempotent — gated on whether "The Weekly
 * Eagle" series already exists for the demo school.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 1 series "The Weekly Eagle" (NEWSLETTER, WEEKLY)
 *   - 2 editions: #11 PUBLISHED + #12 DRAFT
 *   - 2 publications: Edition #11 newsletter (PUBLISHED, 4
 *     sections) + standalone "End of Year Reminders" BULLETIN
 *     (PUBLISHED)
 *   - 4 collaborators on Edition #12: Mitchell EDITOR + Rivera
 *     CONTRIBUTOR + Hayes REVIEWER + Maya CONTRIBUTOR (student —
 *     ADR-035 approval gate exercised)
 *   - 4 sections + 2 contributors on Edition #11: Principal's
 *     Message (Mitchell, ARTICLE, approved), Sports Roundup
 *     (Rivera, ARTICLE, approved), Student Spotlight (Maya,
 *     ARTICLE, is_approved=false pending), Upcoming Events
 *     (CALENDAR, approved). Hayes contributes to Sports Roundup.
 *   - 2 comments: Hayes on Maya's Spotlight + Maya's threaded
 *     reply
 *   - 1 distribution list "All Parents + Staff" + 2 rules
 *     (ROLE=PARENT + ROLE=STAFF) + 5 pre-computed recipients
 *     across 4 delivery_status values
 *   - 3 subscriptions (David SUBSCRIBED + Rivera SUBSCRIBED +
 *     Sarah Mitchell historically UNSUBSCRIBED)
 */

const TENANT_SCHEMA = 'tenant_demo';

async function main() {
  const client = getPlatformClient();

  const routingRows = (await client.$queryRawUnsafe(
    'SELECT schema_name FROM platform.platform_tenant_routing WHERE schema_name = $1 LIMIT 1',
    TENANT_SCHEMA,
  )) as Array<{ schema_name: string }>;
  if (routingRows.length === 0) {
    console.error(`Tenant ${TENANT_SCHEMA} not provisioned — run pnpm seed first`);
    process.exit(1);
  }

  const schoolRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string }>;
  const schoolId = schoolRows[0]!.id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.pub_series WHERE school_id = $1::uuid AND title = $2 LIMIT 1`,
    schoolId,
    'The Weekly Eagle',
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log("'The Weekly Eagle' series already exists — skipping");
    await disconnectAll();
    return;
  }

  // Resolve key actors
  const employees = (await client.$queryRawUnsafe(
    `SELECT e.id::text AS employee_id, ip.first_name, ip.last_name, pu.id::text AS account_id
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id
     LEFT JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.first_name IN ('Sarah', 'James', 'Marcus')`,
  )) as Array<{ employee_id: string; first_name: string; last_name: string; account_id: string }>;
  const mitchell = employees.find((e) => e.last_name === 'Mitchell')!;
  const rivera = employees.find((e) => e.last_name === 'Rivera')!;
  const hayes = employees.find((e) => e.last_name === 'Hayes')!;

  const mayaRows = (await client.$queryRawUnsafe(
    `SELECT pu.id::text AS account_id
     FROM platform.iam_person ip
     JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen'
     LIMIT 1`,
  )) as Array<{ account_id: string }>;
  const mayaAccountId = mayaRows[0]?.account_id;

  const davidRows = (await client.$queryRawUnsafe(
    `SELECT pu.id::text AS account_id
     FROM platform.iam_person ip
     JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.first_name = 'David' AND ip.last_name = 'Chen'
     LIMIT 1`,
  )) as Array<{ account_id: string }>;
  const davidAccountId = davidRows[0]?.account_id;

  // ── A. series ──
  const seriesId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_series
       (id, school_id, title, description, publication_type, frequency, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, true, $7::uuid)`,
    seriesId,
    schoolId,
    'The Weekly Eagle',
    "The school's weekly newsletter. News, sports, and student stories.",
    'NEWSLETTER',
    'WEEKLY',
    mitchell.employee_id,
  );

  // ── B. 2 editions ──
  const edition11Id = generateId();
  const edition12Id = generateId();

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_edition
       (id, series_id, edition_number, edition_label, theme, editorial_note, status, published_at, editor_id)
     VALUES ($1::uuid, $2::uuid, 11, 'Vol. 3 Issue 11', 'Spring activities', 'Welcome back!', 'PUBLISHED', now() - INTERVAL '7 days', $3::uuid)`,
    edition11Id,
    seriesId,
    mitchell.employee_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_edition
       (id, series_id, edition_number, edition_label, theme, editorial_note, status, editor_id)
     VALUES ($1::uuid, $2::uuid, 12, 'Vol. 3 Issue 12', 'Spring 2026', 'Look ahead to summer', 'DRAFT', $3::uuid)`,
    edition12Id,
    seriesId,
    mitchell.employee_id,
  );

  // ── C. 2 publications ──
  const pub11Id = generateId(); // Edition #11 newsletter (PUBLISHED)
  const standaloneId = generateId(); // Standalone bulletin

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publications
       (id, school_id, title, publication_type, series_id, edition_id, created_by, status, published_at)
     VALUES ($1::uuid, $2::uuid, $3, 'NEWSLETTER', $4::uuid, $5::uuid, $6::uuid, 'PUBLISHED', now() - INTERVAL '7 days')`,
    pub11Id,
    schoolId,
    'The Weekly Eagle — Edition #11',
    seriesId,
    edition11Id,
    mitchell.account_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publications
       (id, school_id, title, publication_type, created_by, status, published_at)
     VALUES ($1::uuid, $2::uuid, $3, 'BULLETIN', $4::uuid, 'PUBLISHED', now() - INTERVAL '14 days')`,
    standaloneId,
    schoolId,
    'End of Year Reminders',
    mitchell.account_id,
  );

  // ── D. 4 collaborators on Edition #12 (in DRAFT — exercises the ADR-035 gate) ──
  // For collaborators we need a publication; create the Edition #12 publication
  const pub12Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publications
       (id, school_id, title, publication_type, series_id, edition_id, created_by, status)
     VALUES ($1::uuid, $2::uuid, $3, 'NEWSLETTER', $4::uuid, $5::uuid, $6::uuid, 'DRAFT')`,
    pub12Id,
    schoolId,
    'The Weekly Eagle — Edition #12',
    seriesId,
    edition12Id,
    mitchell.account_id,
  );

  for (const c of [
    { account: mitchell.account_id, role: 'EDITOR' },
    { account: rivera.account_id, role: 'CONTRIBUTOR' },
    { account: hayes.account_id, role: 'REVIEWER' },
    ...(mayaAccountId ? [{ account: mayaAccountId, role: 'CONTRIBUTOR' }] : []),
  ]) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_publication_collaborators
         (id, publication_id, user_id, role, invited_by, accepted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, now() - INTERVAL '2 days')`,
      generateId(),
      pub12Id,
      c.account,
      c.role,
      mitchell.account_id,
    );
  }

  // ── E. 4 sections + 2 contributors on Edition #11 ──
  const sectionPrincipalId = generateId();
  const sectionSportsId = generateId();
  const sectionSpotlightId = generateId();
  const sectionEventsId = generateId();

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_sections
       (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ARTICLE', $5::uuid, 0, true)`,
    sectionPrincipalId,
    pub11Id,
    "Principal's Message",
    'Welcome to another exciting week at our school. We have so much to celebrate...',
    mitchell.employee_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_sections
       (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ARTICLE', $5::uuid, 1, true)`,
    sectionSportsId,
    pub11Id,
    'Sports Roundup',
    'The basketball team had a strong week, and the track team set new records...',
    rivera.employee_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_sections
       (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ARTICLE', NULL, 2, false)`,
    sectionSpotlightId,
    pub11Id,
    'Student Spotlight',
    'Maya Chen shares her experience writing for the school newspaper this semester...',
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_sections
       (id, publication_id, title, body, section_type, owner_id, sort_order, is_approved)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'CALENDAR', $5::uuid, 3, true)`,
    sectionEventsId,
    pub11Id,
    'Upcoming Events',
    'May 15: Spring Concert; May 20: Field Day; May 25: Senior Awards Night.',
    mitchell.employee_id,
  );

  // Maya as section contributor on Student Spotlight (her own owner is null since she's a student)
  if (mayaAccountId) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_section_contributors
         (id, section_id, contributor_id, contribution_note)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
      generateId(),
      sectionSpotlightId,
      mayaAccountId,
      'Submitted draft via portfolio integration',
    );
  }

  // Hayes as section contributor on Sports Roundup
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_section_contributors
       (id, section_id, contributor_id, contribution_note)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4)`,
    generateId(),
    sectionSportsId,
    hayes.account_id,
    'Provided counselling perspective on team wellness',
  );

  // ── F. 2 comments (threaded reply) ──
  if (mayaAccountId) {
    const commentRootId = generateId();
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_section_comments
         (id, section_id, author_id, body, is_resolved)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, false)`,
      commentRootId,
      sectionSpotlightId,
      hayes.account_id,
      'Could you add a sentence about the writing club editor who mentored you?',
    );

    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_section_comments
         (id, section_id, author_id, body, parent_comment_id, is_resolved)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, false)`,
      generateId(),
      sectionSpotlightId,
      mayaAccountId,
      'Done — added a paragraph thanking Mr Rivera.',
      commentRootId,
    );
  }

  // ── G. 1 distribution list + 2 rules + 5 recipients (Edition #11) ──
  const listId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_distribution_lists
       (id, publication_id, list_name, is_active)
     VALUES ($1::uuid, $2::uuid, 'All Parents + Staff', true)`,
    listId,
    pub11Id,
  );

  for (const ruleValue of ['PARENT', 'STAFF']) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_distribution_rules
         (id, distribution_list_id, rule_type, rule_value)
       VALUES ($1::uuid, $2::uuid, 'ROLE', $3)`,
      generateId(),
      listId,
      ruleValue,
    );
  }

  // 5 pre-computed recipients across all 4 delivery_status values
  const recipientStatuses = davidAccountId
    ? [
        { account: davidAccountId, status: 'OPENED' },
        { account: mitchell.account_id, status: 'DELIVERED' },
        { account: rivera.account_id, status: 'OPENED' },
        { account: hayes.account_id, status: 'DELIVERED' },
      ]
    : [];
  for (const r of recipientStatuses) {
    const deliveredAt = r.status !== 'PENDING' ? "now() - INTERVAL '6 days'" : 'NULL';
    const openedAt = r.status === 'OPENED' ? "now() - INTERVAL '5 days'" : 'NULL';
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_distribution_recipients
         (id, publication_id, recipient_id, delivery_status, delivered_at, opened_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ${deliveredAt}, ${openedAt})`,
      generateId(),
      pub11Id,
      r.account,
      r.status,
    );
  }
  // 1 PENDING for Maya
  if (mayaAccountId) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_distribution_recipients
         (id, publication_id, recipient_id, delivery_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')`,
      generateId(),
      pub11Id,
      mayaAccountId,
    );
  }

  // ── H. 3 subscriptions ──
  if (davidAccountId) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.pub_series_subscriptions
         (id, series_id, subscriber_id, status, subscribed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBSCRIBED', now() - INTERVAL '60 days')`,
      generateId(),
      seriesId,
      davidAccountId,
    );
  }
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_series_subscriptions
       (id, series_id, subscriber_id, status, subscribed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBSCRIBED', now() - INTERVAL '90 days')`,
    generateId(),
    seriesId,
    rivera.account_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_series_subscriptions
       (id, series_id, subscriber_id, status, subscribed_at, unsubscribed_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNSUBSCRIBED', now() - INTERVAL '120 days', now() - INTERVAL '30 days')`,
    generateId(),
    seriesId,
    hayes.account_id,
  );

  console.log('Cycle 25 publications seed complete:');
  console.log("  - 1 series 'The Weekly Eagle' (NEWSLETTER, WEEKLY)");
  console.log('  - 2 editions: #11 PUBLISHED + #12 DRAFT');
  console.log('  - 3 publications (Edition #11 + Edition #12 + standalone Bulletin)');
  console.log('  - 4 collaborators on Edition #12 (incl. Maya CONTRIBUTOR — ADR-035 student gate)');
  console.log('  - 4 sections (3 approved + 1 student pending)');
  console.log('  - 2 section contributors (Maya on Spotlight + Hayes on Sports)');
  console.log('  - 2 threaded comments on Spotlight');
  console.log('  - 1 distribution list + 2 ROLE rules + 5 recipients across 4 statuses');
  console.log('  - 3 subscriptions (2 SUBSCRIBED + 1 UNSUBSCRIBED)');

  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
