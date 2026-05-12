import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-alumni.ts — P2-22a Step 4.
 *
 * M102 Alumni. Idempotent — gated on whether the demo school
 * already has any alm_alumni_profiles rows.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 5 alumni profiles (Class of 2020). 4 opted in, 1 opted out.
 *     All link to platform.iam_person — the seed creates 5 fresh
 *     iam_person rows for the alumni since the demo school's
 *     identity catalogue is current-student-focused.
 *   - 9 tags across the 5 alumni (Alex, Priya, Hiroshi, Sophia
 *     get 2 each + David 1): STEM_MENTOR, DONOR, INTERNATIONAL,
 *     BOARD_MEMBER, CAREER_SPEAKER.
 *   - 1 campaign "New Science Lab" ACTIVE, $50K goal USD,
 *     created by Sarah Mitchell.
 *   - 3 donations: 2 USD ($2K + $1.5K), 1 GBP (£500 at 1.27 =
 *     $635). 1 of the 3 is anonymous.
 *   - 5 campaign recipients across the 5 outreach_status states
 *     (PENDING, SENT, OPENED, RESPONDED, DONATED). UNSUBSCRIBED
 *     stays unused — terminal state for production opt-outs.
 *   - 2 alumni news articles: 1 ACHIEVEMENT published, 1
 *     OPPORTUNITY published.
 *   - 1 reunion group: Class of 2020 PLANNING, organiser is
 *     Alex Rivera (alumni #1), event_date + RSVP deadline set.
 *   - 1 alumni event "Homecoming Weekend" with evt_event_id set
 *     to a synthetic UUID — the Step 6 AlumniEventService
 *     resolves it against the Events API at read time and falls
 *     back to rsvp_url when the call fails (typical when the
 *     Events module is not enabled for this school).
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

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.alm_alumni_profiles WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('Alumni profiles already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve Sarah Mitchell for campaign created_by and news author_id
  const mitchellRows = (await client.$queryRawUnsafe(
    `SELECT ip.id::text AS person_id
     FROM platform.iam_person ip
     WHERE ip.first_name = 'Sarah' AND ip.last_name = 'Mitchell'
     LIMIT 1`,
  )) as Array<{ person_id: string }>;
  const mitchellPersonId = mitchellRows[0]?.person_id;
  if (!mitchellPersonId) {
    console.error('Sarah Mitchell not found — ensure tenant_demo is fully seeded');
    process.exit(1);
  }

  // ── A. 5 alumni iam_person rows + alm_alumni_profiles ──
  type Alumnus = {
    firstName: string;
    lastName: string;
    employer: string | null;
    title: string | null;
    linkedin: string | null;
    contactEmail: string;
    optedIn: boolean;
    tags: string[];
  };
  const alumni: Alumnus[] = [
    {
      firstName: 'Alex',
      lastName: 'Rivera',
      employer: 'TechCorp',
      title: 'Software Engineer',
      linkedin: 'https://linkedin.com/in/alex-rivera-2020',
      contactEmail: 'alex.rivera.2020@example.com',
      optedIn: true,
      tags: ['STEM_MENTOR', 'DONOR'],
    },
    {
      firstName: 'Priya',
      lastName: 'Patel',
      employer: 'Goldman Sachs',
      title: 'Investment Analyst',
      linkedin: 'https://linkedin.com/in/priya-patel-2020',
      contactEmail: 'priya.p@example.com',
      optedIn: true,
      tags: ['DONOR', 'BOARD_MEMBER'],
    },
    {
      firstName: 'Hiroshi',
      lastName: 'Tanaka',
      employer: 'University of Tokyo',
      title: 'PhD Researcher',
      linkedin: 'https://linkedin.com/in/hiroshi-tanaka-2020',
      contactEmail: 'hiroshi.t@example.com',
      optedIn: true,
      tags: ['INTERNATIONAL', 'STEM_MENTOR'],
    },
    {
      firstName: 'Sophia',
      lastName: 'Martinez',
      employer: 'Pixar',
      title: 'Visual Effects Artist',
      linkedin: 'https://linkedin.com/in/sophia-martinez-2020',
      contactEmail: 'sophia.m@example.com',
      optedIn: true,
      tags: ['CAREER_SPEAKER', 'DONOR'],
    },
    {
      firstName: 'David',
      lastName: 'Okonkwo',
      employer: null,
      title: null,
      linkedin: null,
      contactEmail: 'david.o@example.com',
      optedIn: false, // opted out
      tags: ['INTERNATIONAL'],
    },
  ];

  const alumniIds: Record<string, string> = {};
  for (const a of alumni) {
    const personId = generateId();
    await client.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, date_of_birth, preferred_language)
       VALUES ($1::uuid, $2, $3, 'ALUMNI'::"PersonType", '2002-06-15', 'en')`,
      personId,
      a.firstName,
      a.lastName,
    );
    const alumniId = generateId();
    alumniIds[a.firstName] = alumniId;
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.alm_alumni_profiles
         (id, school_id, person_id, graduation_year, degree_programme, current_employer, current_title, linkedin_url, contact_email, is_opted_in)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 2020, $4, $5, $6, $7, $8, $9)`,
      alumniId,
      schoolId,
      personId,
      'High School Diploma',
      a.employer,
      a.title,
      a.linkedin,
      a.contactEmail,
      a.optedIn,
    );
    for (const tag of a.tags) {
      await client.$executeRawUnsafe(
        `INSERT INTO ${TENANT_SCHEMA}.alm_alumni_tags (id, alumni_id, tag)
         VALUES ($1::uuid, $2::uuid, $3)`,
        generateId(),
        alumniId,
        tag,
      );
    }
  }

  // ── B. 1 campaign ──
  const campaignId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_campaigns
       (id, school_id, title, description, goal_amount, reporting_currency, start_date, end_date, status, created_by, activated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 50000, 'USD', $5::date, $6::date, 'ACTIVE', $7::uuid, now() - INTERVAL '14 days')`,
    campaignId,
    schoolId,
    'New Science Lab',
    'Help us build a state-of-the-art science lab for the next generation of Lincoln Academy students. Your donation funds equipment, lab benches, and digital learning tools.',
    '2026-04-01',
    '2026-12-31',
    mitchellPersonId,
  );

  // ── C. 3 donations ──
  // Donation 1: Alex Rivera $2,000 USD (DONATED)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_donations
       (id, campaign_id, donor_alumni_id, amount, currency, fx_rate_at_donation, amount_in_reporting_currency, payment_ref, stripe_payment_intent_id, donated_at, is_anonymous)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 2000, 'USD', NULL, 2000, 'pay_alex_1', 'pi_dev_alex_1', now() - INTERVAL '10 days', false)`,
    generateId(),
    campaignId,
    alumniIds['Alex'],
  );

  // Donation 2: Priya Patel $1,500 USD (anonymous)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_donations
       (id, campaign_id, donor_alumni_id, amount, currency, fx_rate_at_donation, amount_in_reporting_currency, payment_ref, stripe_payment_intent_id, donated_at, is_anonymous)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 1500, 'USD', NULL, 1500, 'pay_priya_1', 'pi_dev_priya_1', now() - INTERVAL '7 days', true)`,
    generateId(),
    campaignId,
    alumniIds['Priya'],
  );

  // Donation 3: Hiroshi Tanaka £500 GBP at 1.27 = $635 USD
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_donations
       (id, campaign_id, donor_alumni_id, amount, currency, fx_rate_at_donation, amount_in_reporting_currency, payment_ref, stripe_payment_intent_id, donated_at, is_anonymous)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 500, 'GBP', 1.270000, 635, 'pay_hiroshi_1', 'pi_dev_hiroshi_1', now() - INTERVAL '3 days', false)`,
    generateId(),
    campaignId,
    alumniIds['Hiroshi'],
  );

  // ── D. 5 campaign recipients across the 5 outreach states ──
  const recipientStates: Array<{ name: string; status: string; stamp: string | null }> = [
    { name: 'Alex', status: 'DONATED', stamp: 'donated_at' },
    { name: 'Priya', status: 'DONATED', stamp: 'donated_at' }, // also donated (anonymous)
    { name: 'Hiroshi', status: 'RESPONDED', stamp: 'responded_at' },
    { name: 'Sophia', status: 'OPENED', stamp: 'opened_at' },
    { name: 'David', status: 'SENT', stamp: 'sent_at' },
  ];
  for (const r of recipientStates) {
    const cols = ['id', 'campaign_id', 'alumni_id', 'outreach_status'];
    const vals = ['$1::uuid', '$2::uuid', '$3::uuid', '$4'];
    const args: unknown[] = [generateId(), campaignId, alumniIds[r.name], r.status];
    if (r.stamp) {
      cols.push(r.stamp);
      vals.push("now() - INTERVAL '5 days'");
    }
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.alm_campaign_recipients (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
      ...args,
    );
  }

  // ── E. 2 alumni news articles ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_alumni_news
       (id, school_id, author_id, title, body, category, published_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ACHIEVEMENT', now() - INTERVAL '20 days')`,
    generateId(),
    schoolId,
    mitchellPersonId,
    'Class of 2020 — Where Are They Now?',
    'Five years after walking across the graduation stage, the Class of 2020 has spread across the globe. Alex Rivera is engineering at TechCorp, Priya Patel is on the trading floor at Goldman Sachs, Hiroshi Tanaka is pursuing a PhD in Tokyo, and Sophia Martinez has made it to Pixar. We could not be prouder.',
  );

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_alumni_news
       (id, school_id, author_id, title, body, category, published_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'OPPORTUNITY', now() - INTERVAL '5 days')`,
    generateId(),
    schoolId,
    mitchellPersonId,
    'Mentorship Programme — Now Recruiting Mentors',
    'We are launching a formal alumni mentorship programme this fall. If you have professional experience to share, please reach out to the alumni office. Mentees are matched with mentors based on academic interest and career field.',
  );

  // ── F. 1 reunion group ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_reunion_groups
       (id, school_id, graduation_year, name, organiser_id, event_date, rsvp_deadline, status, description, venue)
     VALUES ($1::uuid, $2::uuid, 2020, $3, $4::uuid, $5::date, $6::date, 'PLANNING', $7, $8)`,
    generateId(),
    schoolId,
    'Class of 2020 — 5-Year Reunion',
    alumniIds['Alex'],
    '2026-08-22',
    '2026-08-01',
    'Five years on. Come reconnect with classmates at the school field and the original gym. Catered dinner. Tours.',
    'Lincoln Academy — Main Campus',
  );

  // ── G. 1 alumni event ──
  // evt_event_id is a synthetic UUID — represents a row in the
  // future P2-12 evt_events table. The Step 6 AlumniEventService
  // attempts to resolve via the Events API and gracefully falls
  // back to rsvp_url when the row is missing or Events is not
  // enabled for this tenant.
  const syntheticEvtEventId = '00000000-0000-0000-0000-000022000001';
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.alm_events
       (id, school_id, title, description, event_date, venue, rsvp_url, evt_event_id)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, $8::uuid)`,
    generateId(),
    schoolId,
    'Homecoming Weekend',
    'Three days of alumni events: Friday night football game, Saturday tailgate, Sunday brunch. Family-friendly. Tickets via P2-12 ticketing when enabled.',
    '2026-10-15',
    'Lincoln Academy — Main Stadium',
    'https://example.com/homecoming-2026/rsvp',
    syntheticEvtEventId,
  );

  console.log('Alumni seed complete:');
  console.log('  5 profiles (4 opted-in, 1 opted-out)');
  console.log('  9 tags across 5 alumni');
  console.log('  1 campaign "New Science Lab" ACTIVE, $50K goal');
  console.log('  3 donations ($2K USD + $1.5K USD anonymous + £500 GBP = $4,135 reporting)');
  console.log('  5 campaign recipients (1 SENT, 1 OPENED, 1 RESPONDED, 2 DONATED)');
  console.log('  2 alumni news articles (ACHIEVEMENT + OPPORTUNITY published)');
  console.log('  1 reunion group (Class of 2020 PLANNING)');
  console.log('  1 alumni event (Homecoming Weekend, evt_event_id soft-linked)');
  await disconnectAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
