import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-events.ts — Phase 2 Cycle 12 sub-cycle a (P2-12a) Step 3.
 *
 * M101 Events & Ticketing. Idempotent — gated on whether evt_events
 * already has rows for the demo school. Re-running is a no-op once
 * the seed has landed.
 *
 * Sections:
 *   A) 2 events — "Spring Musical: Grease" (PERFORMANCE ON_SALE
 *      capacity 300) plus "Varsity Basketball vs Eastside"
 *      (ATHLETIC_GAME COMPLETED).
 *   B) 5 tiers — Musical: General $10 qty 200 sold 180, Reserved
 *      $15 qty 80 sold 65, VIP $25 qty 20 sold 20 (sold out).
 *      Basketball: Adult $8 qty 150 sold 120, Student $5 qty 100
 *      sold 95.
 *   C) 4 orders — 2 CONFIRMED with Stripe intent, 1 PENDING
 *      (expires in 10 min), 1 REFUNDED.
 *   D) 8 tickets — 5 VALID, 2 USED (scanned), 1 REFUNDED. Each
 *      with unique QR token.
 *   E) 1 refund — $15 for cancelled Reserved ticket.
 *   F) 10 ticket scans — 6 VALID + 2 ALREADY_SCANNED + 1 INVALID
 *      + 1 EXPIRED.
 *   G) 1 season pass — "All Sports 2025-26" $50 ACTIVE,
 *      events_included = all athletic events.
 *   H) 5 comp list entries — 3 ATHLETE + 1 COACH + 1 MEDIA for
 *      basketball game.
 *   I) 3 volunteers — 2 CONFIRMED gate volunteers + 1 SIGNED_UP
 *      usher.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedEvents() {
  console.log('');
  console.log('  Events & Ticketing Seed (P2-12 Step 3)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.evt_events WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  evt_events already populated for demo school. Skipping.');
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

  async function findStudentPerson(firstName: string, lastName: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT ip.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        'WHERE ip.first_name = $1 AND ip.last_name = $2 LIMIT 1',
      firstName,
      lastName,
    )) as Array<{ person_id: string }>;
    if (rows.length === 0)
      throw new Error('Student person not found: ' + firstName + ' ' + lastName);
    return rows[0]!.person_id;
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const parent = await findUserByEmail('parent@demo.campusos.dev');
  const student = await findUserByEmail('student@demo.campusos.dev');
  const counsellor = await findUserByEmail('counsellor@demo.campusos.dev');

  const ethanPerson = await findStudentPerson('Ethan', 'Rodriguez');
  const aaliyahPerson = await findStudentPerson('Aaliyah', 'Johnson');

  // ── A. 2 events ──
  console.log('  Seeding 2 events (Spring Musical, Basketball Game)...');
  const musicalId = generateId();
  const basketballId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_events (id, school_id, title, description, event_type, event_date, start_time, end_time, venue_name, total_capacity, total_tier_quantity, status, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::time, $8::time, $9, $10, $11, $12, $13::uuid)',
    musicalId,
    schoolId,
    'Spring Musical: Grease',
    'Annual spring musical performance. Three nights only — book early for best seats.',
    'PERFORMANCE',
    '2026-05-15',
    '19:00',
    '22:00',
    'Main Auditorium',
    300,
    300, // 200 + 80 + 20 across all three tiers
    'ON_SALE',
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_events (id, school_id, title, description, event_type, event_date, start_time, end_time, venue_name, total_capacity, total_tier_quantity, status, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::time, $8::time, $9, $10, $11, $12, $13::uuid)',
    basketballId,
    schoolId,
    'Varsity Basketball vs Eastside',
    'Conference rivalry game. Senior night ceremony at half time.',
    'ATHLETIC_GAME',
    '2026-04-20',
    '18:30',
    '21:00',
    'Gymnasium',
    400,
    250, // 150 Adult + 100 Student
    'COMPLETED',
    principal.personId,
  );

  // ── B. 5 tiers ──
  console.log('  Seeding 5 ticket tiers...');
  const tierMusicalGA = generateId();
  const tierMusicalReserved = generateId();
  const tierMusicalVip = generateId();
  const tierBasketballAdult = generateId();
  const tierBasketballStudent = generateId();

  for (const [id, eventId, name, price, quantity, sold] of [
    [tierMusicalGA, musicalId, 'General Admission', 10.0, 200, 180],
    [tierMusicalReserved, musicalId, 'Reserved Seating', 15.0, 80, 65],
    [tierMusicalVip, musicalId, 'VIP Front Row', 25.0, 20, 20],
    [tierBasketballAdult, basketballId, 'Adult', 8.0, 150, 120],
    [tierBasketballStudent, basketballId, 'Student', 5.0, 100, 95],
  ] as Array<[string, string, string, number, number, number]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.evt_ticket_tiers (id, event_id, name, price, quantity, quantity_sold, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, true)',
      id,
      eventId,
      name,
      price,
      quantity,
      sold,
    );
  }

  // ── C. 4 orders ──
  console.log('  Seeding 4 orders (2 CONFIRMED, 1 PENDING, 1 REFUNDED)...');
  const orderConfirmedA = generateId();
  const orderConfirmedB = generateId();
  const orderPending = generateId();
  const orderRefunded = generateId();

  // 2 CONFIRMED with Stripe intent
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_orders (id, event_id, purchaser_id, status, total_amount, stripe_payment_intent_id, confirmed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz)',
    orderConfirmedA,
    musicalId,
    parent.personId,
    'CONFIRMED',
    20.0,
    'pi_demo_evt_musical_confA',
    '2026-04-15 14:22:00+00',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_orders (id, event_id, purchaser_id, status, total_amount, stripe_payment_intent_id, confirmed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz)',
    orderConfirmedB,
    basketballId,
    parent.personId,
    'CONFIRMED',
    16.0,
    'pi_demo_evt_basket_confB',
    '2026-04-18 09:11:00+00',
  );
  // 1 PENDING expires in 10 min from now
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_orders (id, event_id, purchaser_id, status, total_amount, stripe_payment_intent_id, expires_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now() + interval '10 minutes')",
    orderPending,
    musicalId,
    teacher.personId,
    'PENDING',
    30.0,
    'pi_demo_evt_musical_pendingC',
  );
  // 1 REFUNDED — was originally CONFIRMED
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_orders (id, event_id, purchaser_id, status, total_amount, stripe_payment_intent_id, confirmed_at, cancelled_at, cancellation_reason) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9)',
    orderRefunded,
    musicalId,
    parent.personId,
    'REFUNDED',
    15.0,
    'pi_demo_evt_musical_refundD',
    '2026-04-10 16:05:00+00',
    '2026-04-12 10:30:00+00',
    'Customer schedule conflict — issued full refund.',
  );

  // ── D. 8 tickets ──
  console.log('  Seeding 8 tickets (5 VALID, 2 USED, 1 REFUNDED)...');
  const t1 = generateId();
  const t2 = generateId();
  const t3 = generateId();
  const t4 = generateId();
  const t5 = generateId();
  const t6 = generateId();
  const t7 = generateId();
  const t8 = generateId();

  for (const [id, orderId, tierId, holder, token, status, scannedAt] of [
    [t1, orderConfirmedA, tierMusicalGA, 'David Chen', 'TKN-DEMO-GA-0001', 'VALID', null],
    [t2, orderConfirmedA, tierMusicalGA, 'Linda Chen', 'TKN-DEMO-GA-0002', 'VALID', null],
    [
      t3,
      orderConfirmedB,
      tierBasketballAdult,
      'David Chen',
      'TKN-DEMO-BB-0001',
      'USED',
      '2026-04-20 18:42:00+00',
    ],
    [
      t4,
      orderConfirmedB,
      tierBasketballStudent,
      'Maya Chen',
      'TKN-DEMO-BB-0002',
      'USED',
      '2026-04-20 18:43:00+00',
    ],
    [t5, orderPending, tierMusicalReserved, 'James Rivera', 'TKN-DEMO-RS-0001', 'VALID', null],
    [t6, orderPending, tierMusicalReserved, 'Linda Rivera', 'TKN-DEMO-RS-0002', 'VALID', null],
    [t7, orderRefunded, tierMusicalReserved, 'David Chen', 'TKN-DEMO-RF-0001', 'REFUNDED', null],
    [t8, orderConfirmedA, tierMusicalVip, 'David Chen', 'TKN-DEMO-VIP-0001', 'VALID', null],
  ] as Array<[string, string, string, string, string, string, string | null]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.evt_tickets (id, order_id, tier_id, holder_name, qr_code_token, status, scanned_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::timestamptz)',
      id,
      orderId,
      tierId,
      holder,
      token,
      status,
      scannedAt,
    );
  }

  // ── E. 1 refund ──
  console.log('  Seeding 1 refund ($15 for cancelled Reserved ticket)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_refunds (id, order_id, refund_amount, reason, stripe_refund_id, refunded_by, refunded_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, $7::timestamptz)',
    generateId(),
    orderRefunded,
    15.0,
    'Customer schedule conflict — refunded per family request.',
    're_demo_evt_refund_0001',
    principal.personId,
    '2026-04-12 10:30:00+00',
  );

  // ── F. 10 ticket scans (RANGE-partitioned by scanned_at MONTHLY) ──
  console.log('  Seeding 10 ticket scans (6 VALID, 2 ALREADY_SCANNED, 1 INVALID, 1 EXPIRED)...');
  const scans: Array<[string | null, string | null, string | null, string, string, string]> = [
    [t3, 'TKN-DEMO-BB-0001', basketballId, '2026-04-20 18:42:00+00', principal.personId, 'VALID'],
    [t4, 'TKN-DEMO-BB-0002', basketballId, '2026-04-20 18:43:00+00', principal.personId, 'VALID'],
    [
      t3,
      'TKN-DEMO-BB-0001',
      basketballId,
      '2026-04-20 18:45:00+00',
      principal.personId,
      'ALREADY_SCANNED',
    ],
    [
      null,
      'TKN-BOGUS-DOESNOTEXIST',
      basketballId,
      '2026-04-20 18:48:00+00',
      principal.personId,
      'INVALID',
    ],
    [t1, 'TKN-DEMO-GA-0001', musicalId, '2026-05-15 19:02:00+00', principal.personId, 'VALID'],
    [t2, 'TKN-DEMO-GA-0002', musicalId, '2026-05-15 19:03:00+00', principal.personId, 'VALID'],
    [t8, 'TKN-DEMO-VIP-0001', musicalId, '2026-05-15 19:04:00+00', principal.personId, 'VALID'],
    [t5, 'TKN-DEMO-RS-0001', musicalId, '2026-05-15 19:05:00+00', counsellor.personId, 'VALID'],
    [
      t5,
      'TKN-DEMO-RS-0001',
      musicalId,
      '2026-05-15 19:07:00+00',
      counsellor.personId,
      'ALREADY_SCANNED',
    ],
    [t7, 'TKN-DEMO-RF-0001', musicalId, '2026-05-15 19:08:00+00', counsellor.personId, 'EXPIRED'],
  ];
  for (const [ticketId, token, eventId, scannedAt, scannedBy, result] of scans) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.evt_ticket_scans (id, ticket_id, qr_code_token, event_id, scanned_at, scanned_by, scan_result, scan_source) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz, $6::uuid, $7, $8)',
      generateId(),
      ticketId,
      token,
      eventId,
      scannedAt,
      scannedBy,
      result,
      'KIOSK_GATE_A',
    );
  }

  // ── G. 1 season pass ──
  console.log('  Seeding 1 season pass (All Sports 2025-26, $50, ACTIVE)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.evt_season_passes (id, school_id, person_id, pass_type, events_included, price, purchased_at, stripe_payment_intent_id, status, academic_year) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid[], $6, $7::timestamptz, $8, $9, $10)',
    generateId(),
    schoolId,
    parent.personId,
    'All Sports',
    [basketballId],
    50.0,
    '2025-09-01 12:00:00+00',
    'pi_demo_evt_season_chen',
    'ACTIVE',
    '2025-2026',
  );

  // ── H. 5 comp list entries ──
  console.log('  Seeding 5 comp list entries (3 ATHLETE, 1 COACH, 1 MEDIA)...');
  for (const [compType, personId] of [
    ['ATHLETE', ethanPerson],
    ['ATHLETE', aaliyahPerson],
    ['ATHLETE', student.personId],
    ['COACH', teacher.personId],
    ['MEDIA', counsellor.personId],
  ] as Array<[string, string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.evt_comp_lists (id, event_id, comp_type, person_id, added_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid)',
      generateId(),
      basketballId,
      compType,
      personId,
      principal.personId,
    );
  }

  // ── I. 3 volunteers ──
  console.log('  Seeding 3 volunteers (2 CONFIRMED, 1 SIGNED_UP)...');
  for (const [eventId, personId, role, status] of [
    [musicalId, teacher.personId, 'gate volunteer', 'CONFIRMED'],
    [musicalId, parent.personId, 'usher', 'CONFIRMED'],
    [basketballId, counsellor.personId, 'concessions', 'SIGNED_UP'],
  ] as Array<[string, string, string, string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.evt_volunteers (id, event_id, person_id, role, status) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5)',
      generateId(),
      eventId,
      personId,
      role,
      status,
    );
  }

  console.log('');
  console.log('  Events seed complete.');
  console.log('    Events: 2 (Spring Musical, Varsity Basketball)');
  console.log('    Tiers: 5 / Orders: 4 (2 CONFIRMED, 1 PENDING, 1 REFUNDED)');
  console.log('    Tickets: 8 (5 VALID, 2 USED, 1 REFUNDED) / Refunds: 1');
  console.log('    Scans: 10 (6 VALID, 2 ALREADY_SCANNED, 1 INVALID, 1 EXPIRED)');
  console.log('    Season passes: 1 (All Sports, ACTIVE)');
  console.log('    Comp list: 5 (3 ATHLETE, 1 COACH, 1 MEDIA)');
  console.log('    Volunteers: 3 (2 CONFIRMED, 1 SIGNED_UP)');
}

seedEvents()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
