import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-groups.ts — Cycle 18 Step 3.
 *
 * M103 Groups and Communities. Idempotent — gated on whether
 * grp_groups already has rows for the demo school.
 *
 * Sections:
 *   A) 3 groups — Grade 5 Parents (YEAR_GROUP, APPROVAL_REQUIRED,
 *      Mitchell owner) / Chess Club Community (ACTIVITY, OPEN, Rivera
 *      owner, scope_id linked to Cycle 17 Chess Club) / Spring
 *      Concert Volunteers (CUSTOM, OPEN, Mitchell owner,
 *      auto_dissolve_at = today + 60 days).
 *   B) 6 members across the 3 groups.
 *   C) 3 notification prefs to demo the schema.
 *   D) 1 PENDING ownership transfer — Rivera initiates transfer of
 *      Chess Club to Mitchell.
 *   E) 2 announcements + 1 read.
 *   F) 2 events.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedGroups() {
  console.log('');
  console.log('  Groups & Communities Seed (Cycle 18 Step 3)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.grp_groups WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  grp_groups already populated for demo school. Skipping.');
    return;
  }

  // ── Resolve common refs ──
  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const rivera = await findUserByEmail('teacher@demo.campusos.dev');
  const davidChen = await findUserByEmail('parent@demo.campusos.dev');
  const maya = await findUserByEmail('student@demo.campusos.dev');

  // Maya's actual platform_user is the student — Ethan doesn't have one
  // since the seed only ships 5 personas. We'll use Maya's parent
  // (David Chen — has student@parent relationship via sis_student_guardians)
  // for the Grade 5 Parents group, and fall back to Mitchell as a
  // co-member / additional Chess Club member where the seed needs a
  // different second member. To stay close to the plan's intent we
  // also seed Aaliyah's parent surrogate by reusing David and adding
  // Mitchell as the second Chess Club member instead of Ethan.

  // Resolve a current academic year for the YEAR_GROUP scope_id
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_academic_years WHERE name = $1 LIMIT 1',
    '2025-2026',
  )) as Array<{ id: string }>;
  if (yearRows.length === 0) throw new Error('2025-2026 academic year not found');
  const academicYearId = yearRows[0]!.id;

  // Resolve Cycle 17 Chess Club for the ACTIVITY scope_id
  const chessRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".ext_activities WHERE name = 'Chess Club' LIMIT 1",
  )) as Array<{ id: string }>;
  if (chessRows.length === 0) {
    throw new Error('Cycle 17 Chess Club activity not found — run seed:clubs first');
  }
  const chessActivityId = chessRows[0]!.id;

  // ── A. 3 groups ──
  console.log(
    '  Seeding 3 groups (Grade 5 Parents, Chess Club Community, Spring Concert Volunteers)...',
  );
  const grade5Group = generateId();
  const chessGroup = generateId();
  const concertGroup = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_groups (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'YEAR_GROUP', $5::uuid, 'ACTIVE', 'APPROVAL_REQUIRED', $6::uuid)",
    grade5Group,
    schoolId,
    'Grade 5 Parents',
    'Community for Grade 5 parents and guardians.',
    academicYearId,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_groups (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVITY', $5::uuid, 'ACTIVE', 'OPEN', $6::uuid)",
    chessGroup,
    schoolId,
    'Chess Club Community',
    'Discussion + tournament prep for Chess Club members.',
    chessActivityId,
    rivera.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_groups (id, school_id, name, description, scope_type, status, join_policy, auto_dissolve_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'CUSTOM', 'ACTIVE', 'OPEN', now() + INTERVAL '60 days', $5::uuid)",
    concertGroup,
    schoolId,
    'Spring Concert Volunteers',
    'Temporary community for the spring concert. Auto-dissolves after the concert.',
    mitchell.accountId,
  );

  // ── B. 6 members ──
  console.log('  Seeding 6 members across the 3 groups...');
  const grade5MitchellMember = generateId();
  const grade5DavidMember = generateId();
  const chessRiveraMember = generateId();
  const chessMayaMember = generateId();
  const chessMitchellMember = generateId();
  const concertMitchellMember = generateId();

  // Grade 5 Parents — Mitchell OWNER + David MEMBER (approved)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now() - INTERVAL '30 days')",
    grade5MitchellMember,
    grade5Group,
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', 'ACTIVE', now() - INTERVAL '20 days')",
    grade5DavidMember,
    grade5Group,
    davidChen.accountId,
  );

  // Chess Club — Rivera OWNER + Maya MEMBER + Mitchell MEMBER (we use Mitchell instead of Ethan since the seed only ships 5 personas)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now() - INTERVAL '40 days')",
    chessRiveraMember,
    chessGroup,
    rivera.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', 'ACTIVE', now() - INTERVAL '30 days')",
    chessMayaMember,
    chessGroup,
    maya.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', 'ACTIVE', now() - INTERVAL '15 days')",
    chessMitchellMember,
    chessGroup,
    mitchell.accountId,
  );

  // Concert Volunteers — Mitchell OWNER
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_members (id, group_id, person_id, member_role, status, joined_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now() - INTERVAL '7 days')",
    concertMitchellMember,
    concertGroup,
    mitchell.accountId,
  );

  // ── C. 3 notification prefs ──
  console.log('  Seeding 3 notification prefs...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_member_notification_prefs (id, membership_id, notify_announcements, notify_events, preferred_channel) ' +
      "VALUES ($1::uuid, $2::uuid, true, true, 'IN_APP')",
    generateId(),
    grade5DavidMember,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_member_notification_prefs (id, membership_id, notify_announcements, notify_events, preferred_channel) ' +
      "VALUES ($1::uuid, $2::uuid, true, true, 'IN_APP')",
    generateId(),
    chessMayaMember,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_member_notification_prefs (id, membership_id, notify_announcements, notify_events, preferred_channel) ' +
      "VALUES ($1::uuid, $2::uuid, true, false, 'EMAIL')",
    generateId(),
    chessRiveraMember,
  );

  // ── D. 1 PENDING ownership transfer ──
  console.log('  Seeding 1 PENDING ownership transfer (Rivera → Mitchell on Chess Club)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_ownership_transfers (id, group_id, from_member_id, to_member_id, transfer_reason, status, expires_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'PENDING', now() + INTERVAL '7 days')",
    generateId(),
    chessGroup,
    chessRiveraMember,
    chessMitchellMember,
    'Stepping back from Chess Club leadership next term.',
  );

  // ── E. 2 announcements + 1 read ──
  console.log('  Seeding 2 announcements + 1 read receipt...');
  const chessAnnouncement = generateId();
  const grade5Announcement = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_announcements (id, group_id, author_id, title, body, pinned, publish_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true, now() - INTERVAL '1 day')",
    chessAnnouncement,
    chessGroup,
    rivera.personId,
    'Tournament Registration Open',
    'Registration for the Inter-School Chess Tournament is open until next Friday. RSVP via the event link.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_announcements (id, group_id, author_id, title, body, pinned, publish_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, false, now() - INTERVAL '7 days')",
    grade5Announcement,
    grade5Group,
    mitchell.personId,
    'Spring Concert Details',
    'The Spring Concert is scheduled for next month. See the linked event for time, location, and parent volunteer signup.',
  );

  // David read the Grade 5 Parents announcement
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_announcement_reads (id, announcement_id, reader_id) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid)',
    generateId(),
    grade5Announcement,
    davidChen.personId,
  );

  // ── F. 2 events ──
  console.log('  Seeding 2 events...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_events (id, group_id, created_by, title, description, location, starts_at, ends_at, event_type, requires_rsvp, max_attendees, is_public) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now() + INTERVAL '30 days', now() + INTERVAL '30 days 4 hours', 'COMPETITION', true, 16, false)",
    generateId(),
    chessGroup,
    rivera.personId,
    'Inter-School Chess Tournament',
    'Annual tournament with teams from neighbouring schools.',
    'Lincoln Elementary Gymnasium',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.grp_events (id, group_id, created_by, title, description, location, starts_at, ends_at, event_type, is_public) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now() + INTERVAL '40 days', now() + INTERVAL '40 days 2 hours', 'PERFORMANCE', true)",
    generateId(),
    grade5Group,
    mitchell.personId,
    'Spring Concert',
    'Annual Spring Concert featuring student performances.',
    'Lincoln Elementary Auditorium',
  );

  console.log('');
  console.log('  Groups seed complete.');
  console.log('    Groups: 3 (Grade 5 Parents / Chess Club Community / Spring Concert Volunteers)');
  console.log('    Members: 6 / Notification prefs: 3');
  console.log('    PENDING ownership transfers: 1 (Rivera → Mitchell on Chess Club)');
  console.log('    Announcements: 2 (1 pinned) / Reads: 1');
  console.log('    Events: 2 (1 RSVP-required, 1 public)');
}

seedGroups()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
