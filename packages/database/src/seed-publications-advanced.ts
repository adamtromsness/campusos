import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-publications-advanced.ts — Phase 2 Cycle 26 Step 2.
 *
 * Idempotent. Gated on whether pub_publication_versions already has
 * a row for the demo school. Re-running is a no-op once the seed
 * has landed.
 *
 * Five sections covering all 4 new P2-26 tables.
 *
 *   A) 5 versions for the seeded "The Weekly Eagle — Edition #11"
 *      publication exercising every trigger value:
 *        v1 STATUS_CHANGE — DRAFT created
 *        v2 MANUAL_CHECKPOINT — editor saved mid-draft
 *        v3 STATUS_CHANGE — IN_REVIEW
 *        v4 REVERT — rolled back to v1's snapshot
 *        v5 STATUS_CHANGE — PUBLISHED
 *
 *   B) 3 templates: 2 platform-seeded (school_id NULL,
 *      is_system=true) covering the most common school newsletter
 *      shapes, and 1 school-custom (school_id populated,
 *      is_system=false) demonstrating that schools can author their
 *      own templates alongside the platform catalogue.
 *
 *   C) 1 scheduled publication for the seeded DRAFT "The Weekly
 *      Eagle — Edition #12" set to Friday at 3pm Central, status
 *      SCHEDULED. Demonstrates the queue the Step 4
 *      ScheduledPublishWorker drains every minute.
 *
 *   D) 2 analytics rows: one for the PUBLISHED Edition #11 with
 *      realistic engagement counters (450 views, 312 unique, 89
 *      link clicks, 2 bounces), one for the standalone "End of Year
 *      Reminders" bulletin (smaller numbers).
 *
 *   E) Permission catalogue extension: PUB-001 already exists from
 *      Cycle 25; this cycle adds no new function code. The Step 3
 *      VersionService + TemplateService gate on the existing
 *      pub-001 permission tier matrix (read for editor/admin,
 *      write for editor/admin, admin-only for is_system=true template
 *      writes).
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
    `SELECT 1 FROM ${TENANT_SCHEMA}.pub_publication_versions LIMIT 1`,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('pub_publication_versions already populated — skipping');
    await disconnectAll();
    return;
  }

  // Lookup the seeded "Edition #11" PUBLISHED publication and the DRAFT "Edition #12"
  const pubs = (await client.$queryRawUnsafe(
    `SELECT id::text AS id, title, status FROM ${TENANT_SCHEMA}.pub_publications WHERE school_id = $1::uuid ORDER BY created_at`,
    schoolId,
  )) as Array<{ id: string; title: string; status: string }>;
  if (pubs.length === 0) {
    console.error('No publications found — run seed:publications first');
    await disconnectAll();
    process.exit(1);
  }

  const pubEdition11 = pubs.find((p) => p.title.includes('Edition #11')) ?? pubs[0]!;
  const pubEdition12 = pubs.find((p) => p.title.includes('Edition #12')) ?? pubs[1] ?? pubs[0]!;
  const pubStandalone = pubs.find((p) => p.title.includes('End of Year')) ?? pubs[0]!;

  // Resolve key actors (Mitchell — principal — for created_by + scheduled_by)
  const employees = (await client.$queryRawUnsafe(
    `SELECT pu.id::text AS account_id, ip.first_name, ip.last_name
     FROM ${TENANT_SCHEMA}.hr_employees e
     JOIN platform.iam_person ip ON ip.id = e.person_id
     LEFT JOIN platform.platform_users pu ON pu.person_id = ip.id
     WHERE ip.last_name IN ('Mitchell', 'Rivera')`,
  )) as Array<{ account_id: string; first_name: string; last_name: string }>;
  const mitchell = employees.find((e) => e.last_name === 'Mitchell')!;
  const rivera = employees.find((e) => e.last_name === 'Rivera')!;

  // ── A. 5 versions for Edition #11 ──
  const v1Snap = JSON.stringify({
    title: 'The Weekly Eagle — Edition #11 (DRAFT)',
    status: 'DRAFT',
    publicationType: 'NEWSLETTER',
    sections: [
      { title: "Principal's Message", body: 'Welcome back...', sortOrder: 0, isApproved: false },
    ],
  });
  const v2Snap = JSON.stringify({
    title: 'The Weekly Eagle — Edition #11 (DRAFT — checkpoint)',
    status: 'DRAFT',
    publicationType: 'NEWSLETTER',
    sections: [
      {
        title: "Principal's Message",
        body: 'Welcome back to another week...',
        sortOrder: 0,
        isApproved: false,
      },
      {
        title: 'Sports Roundup',
        body: 'Track team set new records...',
        sortOrder: 1,
        isApproved: false,
      },
    ],
  });
  const v3Snap = JSON.stringify({
    title: 'The Weekly Eagle — Edition #11',
    status: 'IN_REVIEW',
    publicationType: 'NEWSLETTER',
    sections: [
      {
        title: "Principal's Message",
        body: 'Welcome back to another week...',
        sortOrder: 0,
        isApproved: true,
      },
      {
        title: 'Sports Roundup',
        body: 'Track team set new records...',
        sortOrder: 1,
        isApproved: true,
      },
    ],
  });
  const v5Snap = JSON.stringify({
    title: 'The Weekly Eagle — Edition #11',
    status: 'PUBLISHED',
    publicationType: 'NEWSLETTER',
    sections: [
      {
        title: "Principal's Message",
        body: 'Welcome to another exciting week at our school...',
        sortOrder: 0,
        isApproved: true,
      },
      {
        title: 'Sports Roundup',
        body: 'The basketball team had a strong week...',
        sortOrder: 1,
        isApproved: true,
      },
      {
        title: 'Student Spotlight',
        body: 'Maya Chen shares her experience...',
        sortOrder: 2,
        isApproved: true,
      },
      {
        title: 'Upcoming Events',
        body: 'May 15: Spring Concert...',
        sortOrder: 3,
        isApproved: true,
      },
    ],
  });

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_versions
       (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by, created_at)
     VALUES ($1::uuid, $2::uuid, 1, $3::jsonb, 'STATUS_CHANGE', 'Initial DRAFT', $4::uuid, now() - INTERVAL '14 days')`,
    generateId(),
    pubEdition11.id,
    v1Snap,
    mitchell.account_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_versions
       (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by, created_at)
     VALUES ($1::uuid, $2::uuid, 2, $3::jsonb, 'MANUAL_CHECKPOINT', 'Saved before going to lunch', $4::uuid, now() - INTERVAL '13 days')`,
    generateId(),
    pubEdition11.id,
    v2Snap,
    mitchell.account_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_versions
       (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by, created_at)
     VALUES ($1::uuid, $2::uuid, 3, $3::jsonb, 'STATUS_CHANGE', 'Submitted for review', $4::uuid, now() - INTERVAL '10 days')`,
    generateId(),
    pubEdition11.id,
    v3Snap,
    mitchell.account_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_versions
       (id, publication_id, version_number, snapshot_content, trigger, version_note, reverted_from_version, created_by, created_at)
     VALUES ($1::uuid, $2::uuid, 4, $3::jsonb, 'REVERT', 'Reverted to v1 to restart the draft', 1, $4::uuid, now() - INTERVAL '9 days')`,
    generateId(),
    pubEdition11.id,
    v1Snap,
    mitchell.account_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_versions
       (id, publication_id, version_number, snapshot_content, trigger, version_note, created_by, created_at)
     VALUES ($1::uuid, $2::uuid, 5, $3::jsonb, 'STATUS_CHANGE', 'Published', $4::uuid, now() - INTERVAL '7 days')`,
    generateId(),
    pubEdition11.id,
    v5Snap,
    mitchell.account_id,
  );

  // ── B. 3 templates (2 system + 1 custom) ──
  const newsletterTemplate = JSON.stringify({
    sections: [
      { title: "Principal's Message", sortOrder: 0, ownerHint: 'PRINCIPAL' },
      { title: 'School News', sortOrder: 1, ownerHint: 'STAFF' },
      { title: 'Student Spotlight', sortOrder: 2, ownerHint: 'STUDENT' },
      { title: 'Upcoming Events', sortOrder: 3, ownerHint: 'STAFF' },
      { title: 'Sports Roundup', sortOrder: 4, ownerHint: 'COACH' },
    ],
    suggestedFrequency: 'MONTHLY',
    defaultDistributionLists: ['ROLE:PARENT', 'ROLE:STAFF'],
  });
  const bulletinTemplate = JSON.stringify({
    sections: [
      { title: 'Action Required', sortOrder: 0, ownerHint: 'PRINCIPAL' },
      { title: 'Reminders', sortOrder: 1, ownerHint: 'STAFF' },
    ],
    suggestedFrequency: 'WEEKLY',
    defaultDistributionLists: ['ROLE:PARENT'],
  });
  const customTemplate = JSON.stringify({
    sections: [
      { title: 'Lincoln Eagle Spotlight', sortOrder: 0, ownerHint: 'STAFF' },
      { title: "Coach's Corner", sortOrder: 1, ownerHint: 'COACH' },
    ],
    suggestedFrequency: 'WEEKLY',
    defaultDistributionLists: ['ROLE:PARENT', 'ROLE:STAFF'],
  });

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_templates
       (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
     VALUES ($1::uuid, NULL, $2, $3, 'NEWSLETTER', $4::jsonb, true, true, NULL)`,
    generateId(),
    'Monthly School Newsletter',
    'Standard monthly newsletter with 5 sections covering principal, news, students, events, and sports.',
    newsletterTemplate,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_templates
       (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
     VALUES ($1::uuid, NULL, $2, $3, 'BULLETIN', $4::jsonb, true, true, NULL)`,
    generateId(),
    'Weekly Bulletin',
    'Quick weekly bulletin focused on action items and reminders.',
    bulletinTemplate,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_templates
       (id, school_id, name, description, publication_type, template_content, is_system, is_active, created_by)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'NEWSLETTER', $5::jsonb, false, true, $6::uuid)`,
    generateId(),
    schoolId,
    'Lincoln Custom Newsletter',
    'School-specific template authored by Sarah Mitchell with Spotlight + Coach sections.',
    customTemplate,
    mitchell.account_id,
  );

  // ── C. 1 scheduled publication for Edition #12 (DRAFT) ──
  // Schedule for next Friday at 3pm UTC (timezone display only)
  const now = new Date();
  const daysUntilFriday = (5 - now.getUTCDay() + 7) % 7 || 7;
  const nextFriday = new Date(now);
  nextFriday.setUTCDate(now.getUTCDate() + daysUntilFriday);
  nextFriday.setUTCHours(20, 0, 0, 0); // 3pm Central = 20:00 UTC during DST

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_scheduled_publications
       (id, publication_id, scheduled_at, timezone, status, scheduled_by)
     VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'America/Chicago', 'SCHEDULED', $4::uuid)`,
    generateId(),
    pubEdition12.id,
    nextFriday.toISOString(),
    mitchell.account_id,
  );

  // ── D. 2 analytics rows ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_analytics
       (publication_id, total_recipients, total_views, unique_views, total_opens, total_link_clicks, total_bounces, avg_read_time_seconds, last_event_at)
     VALUES ($1::uuid, 480, 450, 312, 380, 89, 2, 145, now() - INTERVAL '1 day')`,
    pubEdition11.id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.pub_publication_analytics
       (publication_id, total_recipients, total_views, unique_views, total_opens, total_link_clicks, total_bounces, avg_read_time_seconds, last_event_at)
     VALUES ($1::uuid, 250, 198, 165, 210, 32, 0, 78, now() - INTERVAL '5 days')`,
    pubStandalone.id,
  );

  // Touch Rivera so the eslint unused-binding rule is happy if we later add a Rivera-authored seed row.
  void rivera;

  console.log(
    `seed-publications-advanced complete: 5 versions for "${pubEdition11.title}", 3 templates (2 system + 1 custom), 1 scheduled publish for "${pubEdition12.title}", 2 analytics rows.`,
  );

  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
