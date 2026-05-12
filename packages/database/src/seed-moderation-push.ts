import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-moderation-push.ts — Phase 2 Cycle 19 sub-cycle b (P2-19b).
 *
 * Idempotent. Gated on whether msg_moderation_rules already has rows
 * for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 3 moderation rules — 1 PLATFORM non-negotiable profanity rule
 *      (school_id NULL, scope=PLATFORM, BLOCK), 1 DISTRICT bullying
 *      rule (scope=DISTRICT, FLAG_FOR_REVIEW, ai_sensitivity_threshold
 *      0.70), 1 BUILDING custom self-harm rule (scope=BUILDING,
 *      ESCALATE_TO_COUNSELLOR, ai_sensitivity_threshold 0.50). The
 *      three-tier resolution exercises every keyword_action.
 *   B) 5 moderation actions covering the full review lifecycle — 2
 *      BLOCKED PENDING (one against each of the BLOCK rule and the
 *      ESCALATE rule), 1 FLAGGED_FOR_REVIEW with review_status
 *      RELEASED (admin cleared a false positive), 1 ESCALATED_TO_
 *      COUNSELLOR PENDING, 1 AUTO_APPROVED with review_status
 *      RELEASED (clean message, no rule matched but the worker
 *      stamped it for audit completeness).
 *   C) 1 OVERTURNED appeal — David Chen appealed Maya Chen's BLOCKED
 *      action and the admin OVERTURNED it. The seeded action row was
 *      already flipped to RELEASED at section B so the post-OVERTURN
 *      schema state is consistent (the runtime AppealService.patch
 *      flow flips both atomically; the seed pre-stages both states).
 *   D) 3 AI moderation results — one per FLAGGED / BLOCKED / ESCALATED
 *      action, cached with the message_id pinned to the action's
 *      message_id so the cache hit is exercised on next read.
 *   E) 2 push campaigns — 1 SENT 3 days ago (Snow Day Closure broadcast
 *      with all the analytics counters populated), 1 SCHEDULED for
 *      next Monday morning (Back-to-School Reminder).
 *   F) 2 push analytics rows — paired 1:1 with the campaigns. The
 *      SENT row carries non-zero counters + rates; the SCHEDULED row
 *      has total_targeted=0 (worker has not dispatched yet).
 *   G) 5 push device tokens — 3 IOS (principal phone, principal iPad,
 *      David Chen phone) + 2 ANDROID (Maya Chen phone, teacher phone).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedModerationPush(): Promise<void> {
  console.log('');
  console.log('  Moderation + Push Seed (P2-19b)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate
  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.msg_moderation_rules WHERE school_id = $1::uuid OR scope = $2',
    schoolId,
    'PLATFORM',
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  msg_moderation_rules already populated for demo school — skipping.');
    return;
  }

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
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');

  // ── A. 3 moderation rules (1 PLATFORM, 1 DISTRICT, 1 BUILDING) ────
  console.log(
    '  Seeding 3 moderation rules (PLATFORM profanity, DISTRICT bullying, BUILDING self-harm)...',
  );
  const platformRuleId = generateId();
  const districtRuleId = generateId();
  const buildingRuleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_rules (id, school_id, scope, name, description, keywords, keyword_action, ai_sensitivity_threshold, is_active, created_by) ' +
      "VALUES ($1::uuid, NULL, 'PLATFORM', 'Profanity Block (Platform)', $2, $3::text[], 'BLOCK', NULL, true, $4::uuid)",
    platformRuleId,
    'Non-negotiable PLATFORM-tier rule blocking common profanity. Applies to every tenant. Tenant admins cannot deactivate.',
    ['fuck', 'shit', 'bitch'],
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_rules (id, school_id, scope, name, description, keywords, keyword_action, ai_sensitivity_threshold, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'DISTRICT', 'Bullying Detection (District)', $3, $4::text[], 'FLAG_FOR_REVIEW', 0.70, true, $5::uuid)",
    districtRuleId,
    schoolId,
    'District-tier rule flagging language patterns associated with bullying. Combines keyword detection with AI sensitivity scoring (threshold 0.70).',
    ['stupid', 'loser', 'hate you'],
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_rules (id, school_id, scope, name, description, keywords, keyword_action, ai_sensitivity_threshold, is_active, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'BUILDING', 'Self-Harm Watchlist (Lincoln)', $3, $4::text[], 'ESCALATE_TO_COUNSELLOR', 0.50, true, $5::uuid)",
    buildingRuleId,
    schoolId,
    'BUILDING-tier rule escalating self-harm signals to the counsellor team. Lower AI threshold (0.50) because the cost of a missed escalation is high.',
    ['kill myself', 'end it all'],
    mitchell.accountId,
  );

  // ── B. 5 moderation actions across the lifecycle ──────────────
  console.log(
    '  Seeding 5 moderation actions (2 BLOCKED PENDING, 1 FLAGGED_FOR_REVIEW RELEASED, 1 ESCALATED PENDING, 1 AUTO_APPROVED)...',
  );
  const action1Id = generateId(); // BLOCKED PENDING (profanity)
  const action2Id = generateId(); // BLOCKED RELEASED (against the platform rule, released by appeal)
  const action3Id = generateId(); // FLAGGED_FOR_REVIEW RELEASED
  const action4Id = generateId(); // ESCALATED PENDING
  const action5Id = generateId(); // AUTO_APPROVED clean message
  const baseTs = "now() - interval '2 days'";
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions (id, message_id, message_created_at, rule_id, action_taken, matched_keywords, ai_sensitivity_score, review_status, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, 'BLOCKED', $4::text[], 0.95, 'PENDING', " +
      baseTs +
      ')',
    action1Id,
    generateId(),
    platformRuleId,
    ['shit'],
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions (id, message_id, message_created_at, rule_id, action_taken, matched_keywords, ai_sensitivity_score, review_status, reviewed_by, reviewed_at, reviewer_notes, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, 'BLOCKED', $4::text[], 0.85, 'RELEASED', $5::uuid, now() - interval '1 day', $6, " +
      baseTs +
      ')',
    action2Id,
    generateId(),
    platformRuleId,
    ['shit'],
    mitchell.accountId,
    'Released after appeal review — context was a quote from a curriculum-approved reading.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions (id, message_id, message_created_at, rule_id, action_taken, matched_keywords, ai_sensitivity_score, review_status, reviewed_by, reviewed_at, reviewer_notes, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, 'FLAGGED_FOR_REVIEW', $4::text[], 0.72, 'RELEASED', $5::uuid, now() - interval '12 hours', $6, " +
      baseTs +
      ')',
    action3Id,
    generateId(),
    districtRuleId,
    ['stupid'],
    mitchell.accountId,
    'False positive — message was supportive context, not bullying.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions (id, message_id, message_created_at, rule_id, action_taken, matched_keywords, ai_sensitivity_score, review_status, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, 'ESCALATED_TO_COUNSELLOR', $4::text[], 0.65, 'PENDING', " +
      baseTs +
      ')',
    action4Id,
    generateId(),
    buildingRuleId,
    ['end it all'],
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions (id, message_id, message_created_at, rule_id, action_taken, matched_keywords, ai_sensitivity_score, review_status, reviewed_by, reviewed_at, reviewer_notes, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, 'AUTO_APPROVED', $4::text[], 0.05, 'RELEASED', $5::uuid, " +
      baseTs +
      ', $6, ' +
      baseTs +
      ')',
    action5Id,
    generateId(),
    platformRuleId,
    [],
    mitchell.accountId,
    'No rule matched — auto-approved at moderation time for audit completeness.',
  );

  // ── C. 1 OVERTURNED appeal — paired with action2 (already RELEASED) ─
  console.log('  Seeding 1 OVERTURNED appeal (David Chen → action2)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_appeals (id, action_id, action_created_at, appealed_by, appeal_reason, status, reviewed_by, reviewed_at, reviewer_notes, created_at) ' +
      'VALUES ($1::uuid, $2::uuid, ' +
      baseTs +
      ", $3::uuid, $4, 'OVERTURNED', $5::uuid, now() - interval '1 day', $6, now() - interval '36 hours')",
    generateId(),
    action2Id,
    david.accountId,
    'This was a direct quote from the Tom Sawyer reading our class is studying. The system flagged a literary quotation as profanity.',
    mitchell.accountId,
    'Reviewed and agreed — overturned. The message is restored to recipients. The platform rule should ideally exclude curriculum context.',
  );

  // ── D. 3 AI moderation results cached for the matching actions ────
  console.log('  Seeding 3 AI moderation result cache entries...');
  // Pull the message_ids back from the action rows so the cache joins.
  const actionMessages = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, message_id::text AS message_id, message_created_at::text AS message_created_at, ai_sensitivity_score::text AS score ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.msg_moderation_actions WHERE id = ANY($1::uuid[])',
    [action1Id, action3Id, action4Id],
  )) as Array<{ id: string; message_id: string; message_created_at: string; score: string | null }>;

  for (const action of actionMessages) {
    const categories =
      action.id === action1Id
        ? { profanity: 0.95, bullying: 0.1, self_harm: 0.0 }
        : action.id === action3Id
          ? { profanity: 0.0, bullying: 0.72, self_harm: 0.0 }
          : { profanity: 0.0, bullying: 0.3, self_harm: 0.65 };
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_ai_moderation_results (id, message_id, message_created_at, sensitivity_score, categories_detected, model_version, computed_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4, $5::jsonb, 'stub-moderation-v1', now() - interval '2 days')",
      generateId(),
      action.message_id,
      action.message_created_at,
      Number(action.score ?? '0'),
      JSON.stringify(categories),
    );
  }

  // ── E. 2 push campaigns (1 SENT, 1 SCHEDULED) ─────────────────
  console.log('  Seeding 2 push campaigns (SENT snow day, SCHEDULED back-to-school)...');
  const sentCampaignId = generateId();
  const scheduledCampaignId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_push_campaigns (id, school_id, title, body, deep_link_url, audience_segment_id, scheduled_at, sent_at, status, created_by, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, now() - interval '3 days', now() - interval '3 days', 'SENT', $6::uuid, now() - interval '4 days')",
    sentCampaignId,
    schoolId,
    'Snow Day — School Closed Tomorrow',
    'Lincoln Elementary will be closed Monday March 11 due to forecast snowfall. All buses cancelled. Updates: https://lincoln.demo.campusos.dev',
    'https://lincoln.demo.campusos.dev/snow-day',
    mitchell.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_push_campaigns (id, school_id, title, body, deep_link_url, audience_segment_id, scheduled_at, status, created_by, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULL, now() + interval '7 days', 'SCHEDULED', $6::uuid, now())",
    scheduledCampaignId,
    schoolId,
    'Welcome Back — Term 2 Starts Monday',
    'Term 2 begins Monday with normal bus schedules and a 9:30am late start. Check your child profile for any updates.',
    'https://lincoln.demo.campusos.dev/term2',
    mitchell.accountId,
  );

  // ── F. 2 push analytics rows (SENT campaign populated, SCHEDULED zeros) ─
  console.log('  Seeding 2 push analytics rows...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_push_analytics (id, campaign_id, total_targeted, total_delivered, total_opened, total_clicked, delivery_rate, open_rate, click_rate, last_updated_at) ' +
      "VALUES ($1::uuid, $2::uuid, 245, 240, 198, 87, 0.9796, 0.8250, 0.4394, now() - interval '2 days')",
    generateId(),
    sentCampaignId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_push_analytics (id, campaign_id, total_targeted, total_delivered, total_opened, total_clicked, last_updated_at) ' +
      'VALUES ($1::uuid, $2::uuid, 0, 0, 0, 0, NULL)',
    generateId(),
    scheduledCampaignId,
  );

  // ── G. 5 device tokens (3 IOS + 2 ANDROID) ─────────────────────
  console.log('  Seeding 5 push device tokens (3 IOS + 2 ANDROID)...');
  const devices = [
    {
      userId: mitchell.accountId,
      token: 'apns-device-' + generateId(),
      platform: 'IOS',
      name: 'Principal iPhone',
      version: '17.4',
    },
    {
      userId: mitchell.accountId,
      token: 'apns-device-' + generateId(),
      platform: 'IOS',
      name: 'Principal iPad',
      version: '17.4',
    },
    {
      userId: david.accountId,
      token: 'apns-device-' + generateId(),
      platform: 'IOS',
      name: 'David Chen iPhone',
      version: '17.2',
    },
    {
      userId: maya.accountId,
      token: 'fcm-device-' + generateId(),
      platform: 'ANDROID',
      name: 'Maya Chen Pixel',
      version: 'Android 14',
    },
    {
      userId: teacher.accountId,
      token: 'fcm-device-' + generateId(),
      platform: 'ANDROID',
      name: 'Teacher Pixel',
      version: 'Android 14',
    },
  ];
  for (const d of devices) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_push_device_tokens (id, user_id, device_token, platform, device_name, app_version, registered_at, last_used_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, now() - interval '14 days', now() - interval '2 hours')",
      generateId(),
      d.userId,
      d.token,
      d.platform,
      d.name,
      d.version,
    );
  }

  console.log('');
  console.log('  Moderation + Push seed complete.');
}

seedModerationPush()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
