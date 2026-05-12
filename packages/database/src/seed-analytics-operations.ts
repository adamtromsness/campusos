import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-analytics-operations.ts — P2-15a Step 2 seed.
 *
 * Idempotent — gated on whether rpt_procurement_summary already has
 * at least one row for the demo school. Each of the 9 operations
 * read-model tables receives one row of representative data so the
 * Step 2c read endpoints return useful data on first boot, and the
 * worker tests have something to UPSERT against.
 *
 * Tenant-only seed targeting tenant_demo:
 *   - 3 procurement rows (3 months × 1 vendor)
 *   - 5 store sales rows (5 products in one month)
 *   - 5 meal counts rows (5 service dates × LUNCH)
 *   - 2 NSLP summary rows (2 months)
 *   - 2 ridership rows (2 routes × 1 month)
 *   - 3 facilities condition rows (3 buildings × 1 space each)
 *   - 1 facilities KPI row (1 month)
 *   - 4 tech fleet status rows (4 device types)
 *   - 2 library circulation rows (2 months)
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
    `SELECT 1 FROM ${TENANT_SCHEMA}.rpt_procurement_summary WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('analytics-operations seed already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  console.log('Seeding P2-15a operations read models...');

  // ---- 1. rpt_procurement_summary (3 months × 1 vendor)
  const vendorId = '22222222-2222-7000-8000-000000000aaa';
  const procPeriods = ['2026-02-01', '2026-03-01', '2026-04-01'];
  for (let i = 0; i < procPeriods.length; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_procurement_summary (id, school_id, period, department, vendor_id, total_pos, total_spend, avg_lead_time_days, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5::uuid, $6, $7::numeric, $8::numeric, now())`,
      generateId(),
      schoolId,
      procPeriods[i],
      i === 0 ? 'IT' : i === 1 ? 'FACILITIES' : 'IT',
      vendorId,
      2 + i,
      (1200 + i * 800).toFixed(2),
      (4 + i * 0.5).toFixed(2),
    );
  }

  // ---- 2. rpt_store_sales (5 products)
  const products = [
    { id: 'aaaaaaaa-aaaa-7000-8000-000000000001', units: 20, revenue: '400.00', cogs: '180.00' },
    { id: 'aaaaaaaa-aaaa-7000-8000-000000000002', units: 15, revenue: '300.00', cogs: '120.00' },
    { id: 'aaaaaaaa-aaaa-7000-8000-000000000003', units: 32, revenue: '512.00', cogs: '224.00' },
    { id: 'aaaaaaaa-aaaa-7000-8000-000000000004', units: 8, revenue: '160.00', cogs: '64.00' },
    { id: 'aaaaaaaa-aaaa-7000-8000-000000000005', units: 50, revenue: '750.00', cogs: '300.00' },
  ];
  for (const p of products) {
    const revenue = parseFloat(p.revenue);
    const cogs = parseFloat(p.cogs);
    const margin = revenue > 0 ? ((revenue - cogs) / revenue).toFixed(4) : null;
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_store_sales (id, school_id, period, product_id, units_sold, revenue, cost_of_goods, profit_margin, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5, $6::numeric, $7::numeric, $8::numeric, now())`,
      generateId(),
      schoolId,
      '2026-04-01',
      p.id,
      p.units,
      p.revenue,
      p.cogs,
      margin,
    );
  }

  // ---- 3. rpt_fds_meal_counts (5 service dates × LUNCH)
  const mealDates = ['2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24', '2026-04-25'];
  for (let i = 0; i < mealDates.length; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_fds_meal_counts (id, school_id, service_date, meal_type, total_served, free_count, reduced_count, paid_count, waste_count, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9, now())`,
      generateId(),
      schoolId,
      mealDates[i],
      'LUNCH',
      180 + i * 5,
      80 + i,
      30 + i,
      70 + i * 4,
      5,
    );
  }

  // ---- 4. rpt_fds_nslp_summary (2 months)
  const nslpMonths = ['2026-03-01', '2026-04-01'];
  for (let i = 0; i < nslpMonths.length; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_fds_nslp_summary (id, school_id, month_year, free_meals, reduced_meals, paid_meals, total_reimbursement_estimate, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::numeric, now())`,
      generateId(),
      schoolId,
      nslpMonths[i],
      1600 + i * 100,
      600 + i * 50,
      1400 + i * 80,
      (8500 + i * 500).toFixed(2),
    );
  }

  // ---- 5. rpt_trn_ridership_summary (2 routes × 1 month)
  const routes = ['33333333-3333-7000-8000-000000000001', '33333333-3333-7000-8000-000000000002'];
  for (let i = 0; i < routes.length; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_trn_ridership_summary (id, school_id, route_id, period, total_runs, total_riders, avg_riders_per_run, on_time_rate, avg_duration_minutes, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7::numeric, $8::numeric, $9::numeric, now())`,
      generateId(),
      schoolId,
      routes[i],
      '2026-04-01',
      40 + i * 2,
      720 + i * 60,
      ((720 + i * 60) / (40 + i * 2)).toFixed(2),
      (0.92 - i * 0.05).toFixed(4),
      (35 + i * 5).toFixed(2),
    );
  }

  // ---- 6. rpt_facilities_condition (3 buildings × 1 space each)
  for (let i = 0; i < 3; i++) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_facilities_condition (id, school_id, building_id, space_id, last_inspection_date, condition_score, open_work_orders, overdue_work_orders, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::numeric, $7, $8, now())`,
      generateId(),
      schoolId,
      `44444444-4444-7000-8000-00000000000${i + 1}`,
      `55555555-5555-7000-8000-00000000000${i + 1}`,
      '2026-04-10',
      (8.5 - i * 0.5).toFixed(1),
      i * 2,
      i === 2 ? 1 : 0,
    );
  }

  // ---- 7. rpt_facilities_kpi (1 month)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.rpt_facilities_kpi (id, school_id, period, total_work_orders, completed_on_time, avg_resolution_days, energy_cost, cost_per_sqft, generated_at)
     VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6::numeric, $7::numeric, $8::numeric, now())`,
    generateId(),
    schoolId,
    '2026-04-01',
    18,
    14,
    '2.8',
    '12400.00',
    '0.1850',
  );

  // ---- 8. rpt_tech_fleet_status (4 device types)
  const deviceTypes = [
    {
      type: 'CHROMEBOOK',
      total: 250,
      active: 230,
      repair: 15,
      decom: 5,
      age: 18.5,
      rate: '0.0240',
    },
    { type: 'IPAD', total: 80, active: 76, repair: 3, decom: 1, age: 22.0, rate: '0.0125' },
    { type: 'DESKTOP', total: 45, active: 42, repair: 2, decom: 1, age: 36.0, rate: '0.0444' },
    { type: 'PRINTER', total: 12, active: 11, repair: 1, decom: 0, age: 48.0, rate: '0.0833' },
  ];
  for (const d of deviceTypes) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_tech_fleet_status (id, school_id, device_type, total_devices, active, in_repair, decommissioned, avg_age_months, incident_rate, generated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, now())`,
      generateId(),
      schoolId,
      d.type,
      d.total,
      d.active,
      d.repair,
      d.decom,
      d.age.toFixed(2),
      d.rate,
    );
  }

  // ---- 9. rpt_lib_circulation_summary (2 months)
  const libMonths = ['2026-03-01', '2026-04-01'];
  for (let i = 0; i < libMonths.length; i++) {
    const popularTitles = JSON.stringify([
      { title: 'The Giver', count: 15 - i * 2 },
      { title: 'Wonder', count: 12 - i },
      { title: 'Holes', count: 10 - i },
    ]);
    await client.$executeRawUnsafe(
      `INSERT INTO ${TENANT_SCHEMA}.rpt_lib_circulation_summary (id, school_id, period, total_checkouts, total_returns, overdue_count, popular_titles, avg_loan_duration_days, generated_at)
       VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::jsonb, $8::numeric, now())`,
      generateId(),
      schoolId,
      libMonths[i],
      120 + i * 15,
      115 + i * 12,
      4 + i,
      popularTitles,
      (10.5 + i * 0.5).toFixed(2),
    );
  }

  console.log(
    `Seeded P2-15a operations read models: 3 procurement, 5 store sales, 5 meal counts, 2 NSLP, 2 ridership, 3 facilities condition, 1 facilities KPI, 4 tech fleet, 2 library circulation`,
  );
  await disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
