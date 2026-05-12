import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-analytics-engagement.ts — P2-15b Step 4 seed.
 *
 * Idempotent — gated on whether rpt_enr_funnel_summary already has at
 * least one row for the demo school. Each of the 9 engagement +
 * performance read-model tables receives one or more rows of
 * representative data so the dashboard UI renders cleanly on first boot.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 1 enrolment funnel row (current academic year)
 *   - 2 athletics season rows (basketball + soccer)
 *   - 2 officials marketplace weeks
 *   - 4 game results
 *   - 3 groups engagement rows (3 groups × 1 month)
 *   - 2 publications distribution rows (2 months)
 *   - 2 ext service summary rows (2 clubs)
 *   - 3 comms communication metrics rows (3 months)
 *   - 5 wellbeing domain trend rows (5 domains × 1 grade × 1 period)
 *
 * PRIVACY: the wellbeing rows carry no student_id (the table has no such
 * column). The seed sets avg_score on the SCALE_1_5 / SCALE_1_10 axis.
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
    `SELECT 1 FROM ${TENANT_SCHEMA}.rpt_enr_funnel_summary WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('analytics-engagement seed already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  console.log('Seeding P2-15b engagement + performance read models...');

  // ---- 1. rpt_enr_funnel_summary (1 row, current academic year)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_enr_funnel_summary
      (id, school_id, academic_year, applications_received, tours_booked, offers_made,
       offers_accepted, enrolled, waitlisted, conversion_rate, generated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::numeric, now())`,
    generateId(),
    schoolId,
    '2026-2027',
    142,
    98,
    115,
    87,
    82,
    18,
    '0.5775',
  );

  // ---- 2. rpt_ath_season_summary (2 programmes)
  const seasonId = 'aaaaaaaa-aaaa-7000-8000-000000000aa1';
  for (const [progId, sport, gp, w, l, d, roster, inj] of [
    ['bbbbbbbb-bbbb-7000-8000-000000000bb1', 'BASKETBALL', 18, 12, 5, 1, 14, 2],
    ['bbbbbbbb-bbbb-7000-8000-000000000bb2', 'SOCCER', 16, 9, 6, 1, 22, 3],
  ] as Array<[string, string, number, number, number, number, number, number]>) {
    const winRate = (w / gp).toFixed(4);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_ath_season_summary
        (id, school_id, season_id, programme_id, games_played, wins, losses, draws,
         win_rate, total_roster_size, injury_count, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::numeric, $10, $11, now())`,
      generateId(),
      schoolId,
      seasonId,
      progId,
      gp,
      w,
      l,
      d,
      winRate,
      roster,
      inj,
    );
    void sport;
  }

  // ---- 3. rpt_officials_marketplace (2 weeks)
  for (const [period, total, filled, cost, rOff, rSch] of [
    ['2026-04-06', 24, 22, '120.00', '4.40', '4.30'],
    ['2026-04-13', 28, 26, '125.00', '4.50', '4.40'],
  ] as Array<[string, number, number, string, string, string]>) {
    const fillRate = (filled / total).toFixed(4);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_officials_marketplace
        (id, school_id, period, total_assignments, fill_rate, avg_cost_per_game,
         avg_official_rating, avg_school_rating, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, now())`,
      generateId(),
      schoolId,
      period,
      total,
      fillRate,
      cost,
      rOff,
      rSch,
    );
  }

  // ---- 4. rpt_game_results (4 games)
  for (const [gameId, sport, home, away, result] of [
    ['cccccccc-cccc-7000-8000-000000000001', 'BASKETBALL', 72, 58, 'WIN'],
    ['cccccccc-cccc-7000-8000-000000000002', 'BASKETBALL', 65, 68, 'LOSS'],
    ['cccccccc-cccc-7000-8000-000000000003', 'SOCCER', 3, 1, 'WIN'],
    ['cccccccc-cccc-7000-8000-000000000004', 'SOCCER', 1, 1, 'DRAW'],
  ] as Array<[string, string, number, number, string]>) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_game_results
        (id, school_id, game_id, sport, home_score, away_score, result, season_id,
         statistical_leaders, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::jsonb, now())`,
      generateId(),
      schoolId,
      gameId,
      sport,
      home,
      away,
      result,
      seasonId,
      JSON.stringify([
        { playerId: 'p1', name: 'Demo Player', statType: 'POINTS', value: home > 50 ? 24 : 12 },
      ]),
    );
  }

  // ---- 5. rpt_grp_engagement_summary (3 groups × 1 period)
  for (const [groupId, totalMembers, activeMembers, posts, comments] of [
    ['dddddddd-dddd-7000-8000-000000000001', 32, 24, 18, 47],
    ['dddddddd-dddd-7000-8000-000000000002', 18, 12, 8, 22],
    ['dddddddd-dddd-7000-8000-000000000003', 45, 38, 24, 65],
  ] as Array<[string, number, number, number, number]>) {
    const engagementRate = (activeMembers / totalMembers).toFixed(4);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_grp_engagement_summary
        (id, school_id, group_id, period, total_members, active_members, posts_count,
         comments_count, engagement_rate, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9::numeric, now())`,
      generateId(),
      schoolId,
      groupId,
      '2026-04-01',
      totalMembers,
      activeMembers,
      posts,
      comments,
      engagementRate,
    );
  }

  // ---- 6. rpt_pub_distribution_summary (2 months)
  for (const [period, pubs, views, downloads, ttp] of [
    ['2026-03-01', 4, 320, 95, '7.50'],
    ['2026-04-01', 5, 410, 110, '6.20'],
  ] as Array<[string, number, number, number, string]>) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_pub_distribution_summary
        (id, school_id, period, publications_count, total_views, total_downloads,
         avg_time_to_publish_days, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::numeric, now())`,
      generateId(),
      schoolId,
      period,
      pubs,
      views,
      downloads,
      ttp,
    );
  }

  // ---- 7. rpt_ext_service_summary (2 clubs)
  for (const [clubId, totalMembers, attendance, events, budget] of [
    ['eeeeeeee-eeee-7000-8000-000000000001', 22, '0.8500', 9, '850.00'],
    ['eeeeeeee-eeee-7000-8000-000000000002', 14, '0.7200', 6, '420.00'],
  ] as Array<[string, number, string, number, string]>) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_ext_service_summary
        (id, school_id, academic_year, club_id, total_members, attendance_rate,
         events_held, budget_spent, generated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::numeric, $7, $8::numeric, now())`,
      generateId(),
      schoolId,
      '2026-2027',
      clubId,
      totalMembers,
      attendance,
      events,
      budget,
    );
  }

  // ---- 8. rpt_msg_communication_metrics (3 months)
  for (const [period, messages, broadcasts, dRate, rRate, respTime] of [
    ['2026-02-01', 1820, 22, '0.9850', '0.7200', '4.20'],
    ['2026-03-01', 1985, 28, '0.9870', '0.7450', '3.80'],
    ['2026-04-01', 2150, 31, '0.9890', '0.7600', '3.50'],
  ] as Array<[string, number, number, string, string, string]>) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_msg_communication_metrics
        (id, school_id, period, messages_sent, broadcasts_sent, delivery_rate,
         read_rate, avg_response_time_hours, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, $7::numeric, $8::numeric, now())`,
      generateId(),
      schoolId,
      period,
      messages,
      broadcasts,
      dRate,
      rRate,
      respTime,
    );
  }

  // ---- 9. rpt_wellbeing_domain_trends (5 domains × 1 grade × 1 period)
  for (const [domain, avgScore, responseCount, belowThreshold] of [
    ['ACADEMIC', '4.2', 48, 2],
    ['SOCIAL', '4.0', 48, 4],
    ['EMOTIONAL', '3.7', 48, 6],
    ['PHYSICAL', '4.1', 48, 3],
    ['SAFETY', '4.4', 48, 1],
  ] as Array<[string, string, number, number]>) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_wellbeing_domain_trends
        (id, school_id, period, grade_level, domain, avg_score, response_count,
         below_threshold_count, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, $7, $8, now())`,
      generateId(),
      schoolId,
      '2026-04-01',
      '5',
      domain,
      avgScore,
      responseCount,
      belowThreshold,
    );
  }

  console.log('analytics-engagement seed: 9 read-model tables populated for demo school');
  await disconnectAll();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectAll();
  process.exit(1);
});
