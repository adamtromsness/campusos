import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-communications-advanced.ts — Phase 2 Cycle 19 sub-cycle a (P2-19a).
 *
 * Idempotent. Gated on whether msg_templates already has rows for the
 * demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 3 language preferences — David Chen Spanish auto-translate
 *      incoming, Maya Chen Mandarin manual (no auto-translate),
 *      principal English default. (Maya speaks Mandarin at home —
 *      stand-in for the multilingual scenario.)
 *   B) 4 translations cached in msg_translations — 2 English -> Spanish
 *      and 2 English -> Mandarin, all pointing at synthetic message_ids
 *      since msg_messages is composite-partitioned and we only need to
 *      exercise the cache lookup keystone (UNIQUE(message_id,
 *      target_language)). The Step 4 TranslationService would normally
 *      write these rows by hand on its first call.
 *   C) 3 templates — Snow Day Announcement with {school_name,
 *      closure_date, reopen_date}, Field Trip Reminder with
 *      {student_name, trip_destination, trip_date}, Welcome New Family
 *      with {family_name, orientation_date}. allowed_roles scopes each
 *      template to admin + staff usage.
 *   D) 3 broadcast segments — ALL_PARENTS (filter_criteria empty),
 *      GRADE_LEVEL grade 5, TRANSPORT_ROUTE (Route 7 stand-in).
 *   E) 2 broadcast analytics rows — one with a real msg_broadcast_segments
 *      ref (per-segment row) and one with segment_id=NULL (aggregate
 *      rollup row). broadcast_id is a synthetic UUID since msg_broadcasts
 *      is a forward-referenced future table.
 *   F) 4 template usage log entries — 3 for Snow Day (most-used) plus 1
 *      for Field Trip Reminder, so the analytics endpoint shows non-
 *      trivial counts on first read.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedCommunicationsAdvanced(): Promise<void> {
  console.log('');
  console.log('  Communications Advanced Seed (P2-19a)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate
  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.msg_templates WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  msg_templates already populated for demo school — skipping.');
    return;
  }

  // Resolve users
  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const david = await findUserByEmail('parent@demo.campusos.dev');
  const maya = await findUserByEmail('student@demo.campusos.dev');

  // ── A. 3 language preferences ──────────────────────────────────
  console.log(
    '  Seeding 3 language preferences (David Spanish auto, Maya Mandarin manual, Mitchell English)...',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_user_language_preferences (id, user_id, preferred_language, auto_translate_incoming, auto_translate_outgoing) ' +
      "VALUES ($1::uuid, $2::uuid, 'es', true, false) " +
      'ON CONFLICT (user_id) DO NOTHING',
    generateId(),
    david.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_user_language_preferences (id, user_id, preferred_language, auto_translate_incoming, auto_translate_outgoing) ' +
      "VALUES ($1::uuid, $2::uuid, 'zh', false, false) " +
      'ON CONFLICT (user_id) DO NOTHING',
    generateId(),
    maya.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_user_language_preferences (id, user_id, preferred_language, auto_translate_incoming, auto_translate_outgoing) ' +
      "VALUES ($1::uuid, $2::uuid, 'en', false, false) " +
      'ON CONFLICT (user_id) DO NOTHING',
    generateId(),
    mitchell.accountId,
  );

  // ── B. 4 cached translations ───────────────────────────────────
  console.log('  Seeding 4 cached translations (2 en->es, 2 en->zh)...');
  const synthA = generateId();
  const synthB = generateId();
  const synthAt = '2026-05-10T09:00:00Z';
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_translations (id, message_id, message_created_at, target_language, translated_text, source_language, model_version, confidence, requested_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'es', 'Bienvenido de nuevo al colegio.', 'en', 'stub-translation-v1', 0.97, $4::uuid)",
    generateId(),
    synthA,
    synthAt,
    david.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_translations (id, message_id, message_created_at, target_language, translated_text, source_language, model_version, confidence) ' +
      "VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'es', 'El bus llegara con retraso de quince minutos.', 'en', 'stub-translation-v1', 0.93)",
    generateId(),
    synthB,
    synthAt,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_translations (id, message_id, message_created_at, target_language, translated_text, source_language, model_version, confidence, requested_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'zh', '欢迎回到学校。', 'en', 'stub-translation-v1', 0.95, $4::uuid)",
    generateId(),
    synthA,
    synthAt,
    maya.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_translations (id, message_id, message_created_at, target_language, translated_text, source_language, model_version, confidence) ' +
      "VALUES ($1::uuid, $2::uuid, $3::timestamptz, 'zh', '校车将延迟十五分钟到达。', 'en', 'stub-translation-v1', 0.91)",
    generateId(),
    synthB,
    synthAt,
  );

  // ── C. 3 templates ─────────────────────────────────────────────
  console.log('  Seeding 3 templates (Snow Day, Field Trip Reminder, Welcome New Family)...');
  const snowDayId = generateId();
  const fieldTripId = generateId();
  const welcomeId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_templates (id, school_id, name, category, subject_template, body_template, variables, allowed_roles, is_active, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::text[], true, $9::uuid)',
    snowDayId,
    schoolId,
    'Snow Day Announcement',
    'EMERGENCY',
    '{school_name} closed {closure_date}',
    'Due to severe weather, {school_name} will be closed on {closure_date}. We expect to reopen on {reopen_date}. Stay safe and warm. — Lincoln Elementary Administration',
    JSON.stringify([
      { name: 'school_name', description: 'School display name', required: true },
      {
        name: 'closure_date',
        description: 'Date school is closed (e.g. Monday March 11)',
        required: true,
      },
      { name: 'reopen_date', description: 'Expected reopen date', required: true },
    ]),
    ['SCHOOL_ADMIN', 'TEACHER'],
    mitchell.accountId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_templates (id, school_id, name, category, subject_template, body_template, variables, allowed_roles, is_active, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::text[], true, $9::uuid)',
    fieldTripId,
    schoolId,
    'Field Trip Reminder',
    'REMINDER',
    'Field Trip reminder — {trip_destination} on {trip_date}',
    'Hello, this is a reminder that {student_name} has a field trip to {trip_destination} on {trip_date}. Please ensure your child arrives at school by 8:00 AM with a packed lunch and weather-appropriate clothing.',
    JSON.stringify([
      { name: 'student_name', description: 'Student first + last name', required: true },
      { name: 'trip_destination', description: 'Destination of the trip', required: true },
      { name: 'trip_date', description: 'Date of the trip', required: true, default_value: 'TBD' },
    ]),
    ['SCHOOL_ADMIN', 'TEACHER'],
    mitchell.accountId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_templates (id, school_id, name, category, subject_template, body_template, variables, allowed_roles, is_active, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::text[], true, $9::uuid)',
    welcomeId,
    schoolId,
    'Welcome New Family',
    'WELCOME',
    'Welcome to Lincoln Elementary, the {family_name} family',
    'Dear {family_name} family, welcome to Lincoln Elementary. Please join us for new-family orientation on {orientation_date}. We will cover the school day schedule, transportation, and how to reach your child’s teacher.',
    JSON.stringify([
      { name: 'family_name', description: 'Family surname', required: true },
      { name: 'orientation_date', description: 'Orientation event date', required: true },
    ]),
    ['SCHOOL_ADMIN'],
    mitchell.accountId,
  );

  // ── D. 3 broadcast segments ────────────────────────────────────
  console.log('  Seeding 3 broadcast segments (ALL_PARENTS, GRADE_LEVEL 5, TRANSPORT_ROUTE)...');
  const allParentsId = generateId();
  const grade5Id = generateId();
  const route7Id = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_broadcast_segments (id, school_id, name, description, segment_type, filter_criteria, estimated_recipients, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'ALL_PARENTS', '{}'::jsonb, 247, true, $5::uuid)",
    allParentsId,
    schoolId,
    'All Parents',
    'Every active guardian with portal access at Lincoln Elementary.',
    mitchell.accountId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_broadcast_segments (id, school_id, name, description, segment_type, filter_criteria, estimated_recipients, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'GRADE_LEVEL', $5::jsonb, 42, true, $6::uuid)",
    grade5Id,
    schoolId,
    'Grade 5 Families',
    'Guardians of all grade-5 students.',
    JSON.stringify({ grade_level: '5' }),
    mitchell.accountId,
  );

  // Use a synthetic route_id since the transport tables are seeded by seed-transport
  // and we want this seed to run independently. The TRANSPORT_ROUTE segment_type
  // is validated by the CHECK; filter_criteria shape is interpreted at resolve time.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_broadcast_segments (id, school_id, name, description, segment_type, filter_criteria, estimated_recipients, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'TRANSPORT_ROUTE', $5::jsonb, 18, true, $6::uuid)",
    route7Id,
    schoolId,
    'Route 7 Riders',
    'Families with at least one student assigned to bus Route 7.',
    JSON.stringify({ route_ids: [generateId()] }),
    mitchell.accountId,
  );

  // ── E. 2 broadcast analytics rows ──────────────────────────────
  console.log('  Seeding 2 broadcast analytics rows (1 per-segment, 1 aggregate)...');
  const synthBroadcastId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_broadcast_analytics (id, broadcast_id, segment_id, total_recipients, delivered, opened, clicked, bounced, unsubscribed, delivery_rate, open_rate, click_rate, last_updated_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, 42, 40, 28, 6, 2, 0, 0.9524, 0.7000, 0.2143, now())',
    generateId(),
    synthBroadcastId,
    grade5Id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_broadcast_analytics (id, broadcast_id, segment_id, total_recipients, delivered, opened, clicked, bounced, unsubscribed, delivery_rate, open_rate, click_rate, last_updated_at) ' +
      'VALUES ($1::uuid, $2::uuid, NULL, 42, 40, 28, 6, 2, 0, 0.9524, 0.7000, 0.2143, now())',
    generateId(),
    synthBroadcastId,
  );

  // ── F. 4 template usage log entries ────────────────────────────
  console.log('  Seeding 4 template usage log entries...');
  // Snow Day used 3 times (most-used)
  for (let i = 0; i < 3; i++) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_template_usage_log (id, template_id, used_by, used_at, broadcast_id, thread_id, rendered_subject) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - ($4 * interval '1 day'), $5::uuid, NULL, $6)",
      generateId(),
      snowDayId,
      mitchell.accountId,
      i + 1,
      generateId(),
      'Lincoln Elementary closed Mar ' + (10 + i),
    );
  }
  // Field Trip used 1 time
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_template_usage_log (id, template_id, used_by, used_at, broadcast_id, thread_id, rendered_subject) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '7 days', NULL, $4::uuid, $5)",
    generateId(),
    fieldTripId,
    mitchell.accountId,
    generateId(),
    'Field Trip reminder — Springfield Science Museum on April 18',
  );

  console.log('');
  console.log('  Communications Advanced seed complete.');
}

seedCommunicationsAdvanced()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
