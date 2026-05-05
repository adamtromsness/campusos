import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-emergency.ts — Cycle 14 Step 3.
 *
 * Idempotent. Gated on whether msg_emergency_alerts already has rows
 * for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 2 additional alert types per the Cycle 14 plan — "Severe
 *      Weather" (severity=EMERGENCY, channels=[PUSH,APP],
 *      requires_acknowledgement=true) and "Early Dismissal"
 *      (severity=WARNING, channels=[APP],
 *      requires_acknowledgement=false). The Cycle 3 seed already
 *      lands GENERAL_ANNOUNCEMENT, PARENT_INFORMATIONAL,
 *      WEATHER_CLOSURE in msg_alert_types; this seed extends the
 *      catalogue.
 *   B) 1 sample emergency alert — "Severe Weather Drill"
 *      status=ACTIVE issued by Mitchell, with 3 deliveries
 *      (PUSH to Rivera DELIVERED+acknowledged,
 *      APP to David Chen DELIVERED,
 *      APP to Maya PENDING).
 *   C) msg_thread_stats backfill — for every existing thread on
 *      the demo school, compute message_count + last_message_at +
 *      last_message_preview from msg_messages so the inbox renders
 *      correctly on first boot ahead of the Step 4 Kafka consumer.
 *
 * The Cycle 14 plan also describes 1 announcement + 3 moderation
 * policies in this seed list; those already exist from the Cycle 3
 * seed-messaging.ts. This seed does not duplicate them.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedEmergency() {
  console.log('');
  console.log('  Emergency Alerts Seed (Cycle 14 Step 3)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate
  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.msg_emergency_alerts WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  Emergency alerts already seeded for demo school. Skipping.');
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
  const rivera = await findUserByEmail('teacher@demo.campusos.dev');
  const david = await findUserByEmail('parent@demo.campusos.dev');
  const maya = await findUserByEmail('student@demo.campusos.dev');

  // ── A. 2 additional alert types ────────────────────────────────
  console.log('  Seeding 2 alert types (Severe Weather, Early Dismissal)...');
  const severeWeatherTypeId = generateId();
  const earlyDismissalTypeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_alert_types (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'EMERGENCY', ARRAY['PUSH','APP']::TEXT[], true, true) " +
      'ON CONFLICT (school_id, name) DO NOTHING',
    severeWeatherTypeId,
    schoolId,
    'Severe Weather',
    'Severe weather event requiring shelter-in-place or other safety action. Acknowledgement required from every staff member.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_alert_types (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 'WARNING', ARRAY['APP']::TEXT[], false, true) " +
      'ON CONFLICT (school_id, name) DO NOTHING',
    earlyDismissalTypeId,
    schoolId,
    'Early Dismissal',
    'School dismisses early due to weather, scheduling, or operational reasons. No acknowledgement required.',
  );

  // Re-resolve type id (in case ON CONFLICT skipped insert, we still want the actual id)
  const severeWeatherRow = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".msg_alert_types WHERE school_id = $1::uuid AND name = 'Severe Weather'",
    schoolId,
  )) as Array<{ id: string }>;
  const severeId = severeWeatherRow[0]!.id;

  // ── B. 1 sample emergency alert + 3 deliveries ─────────────────
  console.log('  Seeding 1 ACTIVE emergency alert with 3 deliveries...');
  const alertId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_emergency_alerts (id, school_id, alert_type_id, title, body, issued_by, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, 'ACTIVE')",
    alertId,
    schoolId,
    severeId,
    'Severe Weather Drill',
    'This is a drill. In a real severe weather event you would shelter in place per the Lincoln Elementary safety plan. Please acknowledge to confirm you have read this message.',
    mitchell.accountId,
  );

  // 3 deliveries — Rivera PUSH delivered+acknowledged, David APP delivered, Maya APP pending
  const riveraDelivId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status, sent_at, acknowledged_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PUSH', 'DELIVERED', now() - interval '3 minutes', now() - interval '2 minutes')",
    riveraDelivId,
    alertId,
    rivera.accountId,
  );

  const davidDelivId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status, sent_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'DELIVERED', now() - interval '3 minutes')",
    davidDelivId,
    alertId,
    david.accountId,
  );

  const mayaDelivId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_emergency_alert_deliveries (id, alert_id, recipient_id, channel, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'APP', 'PENDING')",
    mayaDelivId,
    alertId,
    maya.accountId,
  );

  // ── C. msg_thread_stats backfill ───────────────────────────────
  console.log('  Backfilling msg_thread_stats from existing seeded threads...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_thread_stats (thread_id, school_id, message_count, last_message_at, last_message_preview, last_sender_id, updated_at) ' +
      'SELECT t.id, t.school_id, COUNT(m.id)::int, MAX(m.created_at), ' +
      '  (SELECT LEFT(body, 100) FROM ' +
      TENANT_SCHEMA +
      '.msg_messages WHERE thread_id = t.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1), ' +
      '  (SELECT sender_id FROM ' +
      TENANT_SCHEMA +
      '.msg_messages WHERE thread_id = t.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1), ' +
      '  now() ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.msg_threads t ' +
      'LEFT JOIN ' +
      TENANT_SCHEMA +
      '.msg_messages m ON m.thread_id = t.id AND m.deleted_at IS NULL ' +
      'WHERE t.school_id = $1::uuid ' +
      'GROUP BY t.id, t.school_id ' +
      'ON CONFLICT (thread_id) DO UPDATE SET ' +
      '  message_count = EXCLUDED.message_count, ' +
      '  last_message_at = EXCLUDED.last_message_at, ' +
      '  last_message_preview = EXCLUDED.last_message_preview, ' +
      '  last_sender_id = EXCLUDED.last_sender_id, ' +
      '  updated_at = now()',
    schoolId,
  );

  console.log('');
  console.log('  Emergency seed complete.');
}

seedEmergency()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
