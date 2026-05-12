import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-facilities-advanced-b.ts — Phase 2 Cycle 18 sub-cycle b (P2-18b).
 *
 * M65 Facilities Advanced — fire drills + assets + energy + space
 * utilisation + sustainability. Idempotent — gated on whether
 * fac_asset_categories already has rows for the demo school. Depends on
 * Cycle 21 fac_* tables (run seed:facilities first) and P2-18a (run
 * seed:facilities-advanced-a first) for the Main Building + Park / Hayes
 * staff personas.
 *
 * Sections:
 *   A) 2 fire drills — last month (met target, evac 280s vs target
 *      300s) + 3 weeks ago (did NOT meet, evac 380s vs target 300s,
 *      issues_noted populated).
 *   B) 3 asset categories — HVAC (15yr depreciation 6mo maintenance),
 *      Electrical (20yr 12mo), Elevator (25yr 6mo).
 *   C) 8 assets — 5 ACTIVE (Rooftop HVAC, Main Electrical Panel, North
 *      Wing AHU, Lobby Elevator, Gym Lighting), 2 UNDER_MAINTENANCE
 *      (Cafeteria HVAC unit, Server Room AC), 1 DECOMMISSIONED (Old
 *      service elevator car).
 *   D) 5 maintenance records — 1 overdue next_maintenance_date (date
 *      strictly in the past) to demonstrate the dashboard.
 *   E) 1 disposal — the DECOMMISSIONED service elevator → SCRAP with
 *      $350 value recovered.
 *   F) 3 utility meters — Main Electricity (kWh), Main Gas (therms),
 *      Main Water (gallons).
 *   G) 12 energy readings — 4 monthly readings per meter spanning
 *      4 months back from the most-recent reading, with consumption
 *      pre-computed for the per-row demo (Step 4 EnergyService
 *      computes on insert from prior row but seed plants the
 *      materialised value so the dashboard renders out-of-the-box).
 *   H) 2 energy targets — MONTHLY Electricity 10,000 kWh + ANNUAL
 *      Gas 4,500 therms.
 *   I) 10 space utilisation records — 5 classrooms × 2 dates each.
 *      One classroom seeded as consistently underused (< 50%) for the
 *      Step 4 underused-rooms demo.
 *   J) 2 sustainability initiatives — LED Lighting Retrofit (ACTIVE,
 *      ENERGY, 25% target reduction) + Water Conservation Audit
 *      (ACTIVE, WATER, 15% target).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedFacilitiesAdvancedB() {
  console.log('');
  console.log('  Facilities Advanced Seed (P2-18b)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.fac_asset_categories WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  fac_asset_categories already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT pu.id::text AS account_id, ip.id::text AS person_id ' +
        'FROM platform.platform_users pu ' +
        'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
        'WHERE pu.email = $1 LIMIT 1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('User not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const vp = await findUserByEmail('vp@demo.campusos.dev');

  const building = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".fac_buildings WHERE school_id = $1::uuid AND name = 'Main Building' LIMIT 1",
    schoolId,
  )) as Array<{ id: string }>;
  if (building.length === 0) throw new Error('Main Building missing — run seed:facilities first');
  const buildingId = building[0]!.id;

  const spaceRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.fac_spaces',
  )) as Array<{ id: string; name: string }>;
  const spaceByName = new Map(spaceRows.map((s) => [s.name, s.id]));

  // ── Section A: 2 fire drills ──
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const threeWeeksAgo = new Date(Date.now() - 21 * 86400_000);
  const drill1Id = generateId();
  const drill2Id = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_fire_drills (id, school_id, building_id, drill_date, drill_time, duration_seconds, total_occupants, evacuation_time_seconds, target_evacuation_seconds, met_target, conducted_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, '10:15'::time, $5, $6, $7, $8, true, $9::uuid)",
    drill1Id,
    schoolId,
    buildingId,
    lastMonth.toISOString().slice(0, 10),
    600,
    420,
    280,
    300,
    principal.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_fire_drills (id, school_id, building_id, drill_date, drill_time, duration_seconds, total_occupants, evacuation_time_seconds, target_evacuation_seconds, met_target, issues_noted, conducted_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, '13:45'::time, $5, $6, $7, $8, false, $9, $10::uuid)",
    drill2Id,
    schoolId,
    buildingId,
    threeWeeksAgo.toISOString().slice(0, 10),
    700,
    415,
    380,
    300,
    'Slow evacuation from second floor — north stairwell congestion. Recommend additional drill within 6 weeks.',
    principal.personId,
  );

  // ── Section B: 3 asset categories ──
  const hvacCatId = generateId();
  const electCatId = generateId();
  const elevCatId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
    hvacCatId,
    schoolId,
    'HVAC',
    'Heating, ventilation, and air conditioning equipment.',
    15,
    6,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
    electCatId,
    schoolId,
    'Electrical',
    'Switchgear, panels, and major electrical infrastructure.',
    20,
    12,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)',
    elevCatId,
    schoolId,
    'Elevator',
    'Passenger and service elevators.',
    25,
    6,
  );

  // ── Section C: 8 assets ──
  const rooftopHvacId = generateId();
  const mainPanelId = generateId();
  const ahuNorthId = generateId();
  const lobbyElevId = generateId();
  const gymLightingId = generateId();
  const cafeHvacId = generateId();
  const serverAcId = generateId();
  const oldElevId = generateId();
  const nowIso = new Date().toISOString();

  const assetRows: Array<{
    id: string;
    category: string;
    name: string;
    make: string;
    model: string;
    serial: string;
    installDate: string;
    warrantyExpiry: string | null;
    lifespanYears: number;
    replacementCost: number;
    priority: string;
    status: string;
    spaceName: string | null;
  }> = [
    {
      id: rooftopHvacId,
      category: hvacCatId,
      name: 'Rooftop HVAC Unit 1',
      make: 'Carrier',
      model: '50TC-024',
      serial: 'CAR-2024-001',
      installDate: '2018-06-15',
      warrantyExpiry: '2028-06-15',
      lifespanYears: 15,
      replacementCost: 48000,
      priority: 'MEDIUM',
      status: 'ACTIVE',
      spaceName: null,
    },
    {
      id: mainPanelId,
      category: electCatId,
      name: 'Main Electrical Distribution Panel',
      make: 'Square D',
      model: 'I-Line 600A',
      serial: 'SD-MP-2010-A',
      installDate: '2010-03-20',
      warrantyExpiry: null,
      lifespanYears: 30,
      replacementCost: 65000,
      priority: 'CRITICAL',
      status: 'ACTIVE',
      spaceName: null,
    },
    {
      id: ahuNorthId,
      category: hvacCatId,
      name: 'North Wing Air Handler',
      make: 'Trane',
      model: 'M-Series 20T',
      serial: 'TRA-AHU-N-022',
      installDate: '2022-08-01',
      warrantyExpiry: '2027-08-01',
      lifespanYears: 18,
      replacementCost: 38000,
      priority: 'MEDIUM',
      status: 'ACTIVE',
      spaceName: null,
    },
    {
      id: lobbyElevId,
      category: elevCatId,
      name: 'Lobby Passenger Elevator',
      make: 'Otis',
      model: 'Gen3-2500',
      serial: 'OTIS-LBY-2015',
      installDate: '2015-09-10',
      warrantyExpiry: null,
      lifespanYears: 25,
      replacementCost: 125000,
      priority: 'HIGH',
      status: 'ACTIVE',
      spaceName: null,
    },
    {
      id: gymLightingId,
      category: electCatId,
      name: 'Gymnasium Lighting System',
      make: 'Cree',
      model: 'LED Bay 200W',
      serial: 'CREE-GYM-2020',
      installDate: '2020-07-15',
      warrantyExpiry: '2030-07-15',
      lifespanYears: 12,
      replacementCost: 18000,
      priority: 'LOW',
      status: 'ACTIVE',
      spaceName: 'Gymnasium',
    },
    {
      id: cafeHvacId,
      category: hvacCatId,
      name: 'Cafeteria HVAC Unit',
      make: 'Lennox',
      model: 'X-Series 15T',
      serial: 'LX-CAFE-2019',
      installDate: '2019-04-22',
      warrantyExpiry: '2024-04-22',
      lifespanYears: 15,
      replacementCost: 32000,
      priority: 'HIGH',
      status: 'UNDER_MAINTENANCE',
      spaceName: 'Cafeteria',
    },
    {
      id: serverAcId,
      category: hvacCatId,
      name: 'Server Room Precision AC',
      make: 'Liebert',
      model: 'CRV-PA050',
      serial: 'LBT-SVR-2021',
      installDate: '2021-01-08',
      warrantyExpiry: '2026-01-08',
      lifespanYears: 12,
      replacementCost: 22000,
      priority: 'CRITICAL',
      status: 'UNDER_MAINTENANCE',
      spaceName: null,
    },
    {
      id: oldElevId,
      category: elevCatId,
      name: 'Old Service Elevator',
      make: 'Schindler',
      model: 'S-3300',
      serial: 'SCH-SVC-1998',
      installDate: '1998-11-01',
      warrantyExpiry: null,
      lifespanYears: 25,
      replacementCost: 110000,
      priority: 'CRITICAL',
      status: 'DECOMMISSIONED',
      spaceName: null,
    },
  ];

  for (const a of assetRows) {
    const isDecom = a.status === 'DECOMMISSIONED';
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_assets (id, school_id, category_id, building_id, space_id, name, make, model, serial_number, install_date, warranty_expiry, expected_lifespan_years, replacement_cost_estimate, replacement_priority, status, decommissioned_at, decommissioned_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9, $10::date, $11::date, $12, $13, $14, $15, $16::timestamptz, $17::uuid)',
      a.id,
      schoolId,
      a.category,
      buildingId,
      a.spaceName ? (spaceByName.get(a.spaceName) ?? null) : null,
      a.name,
      a.make,
      a.model,
      a.serial,
      a.installDate,
      a.warrantyExpiry,
      a.lifespanYears,
      a.replacementCost,
      a.priority,
      a.status,
      isDecom ? nowIso : null,
      isDecom ? principal.personId : null,
    );
  }

  // ── Section D: 5 maintenance records (1 with overdue next date) ──
  const today = new Date();
  const fourMonthsAgo = new Date(today);
  fourMonthsAgo.setMonth(today.getMonth() - 4);
  const lastQuarter = new Date(today);
  lastQuarter.setMonth(today.getMonth() - 3);
  const twoMonthsAgo = new Date(today);
  twoMonthsAgo.setMonth(today.getMonth() - 2);
  const oneMonthAgo = new Date(today);
  oneMonthAgo.setMonth(today.getMonth() - 1);
  const pastDue = new Date(today);
  pastDue.setMonth(today.getMonth() - 1);

  // 1 — rooftop HVAC scheduled (next date today + 6 months — current)
  const futureNext = new Date(today);
  futureNext.setMonth(today.getMonth() + 6);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_maintenance_records (id, asset_id, maintenance_type, performed_date, performed_by, cost, description, next_maintenance_date, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date, $9::uuid)',
    generateId(),
    rooftopHvacId,
    'SCHEDULED',
    fourMonthsAgo.toISOString().slice(0, 10),
    'AceMech HVAC Services',
    485.0,
    'Quarterly filter change, coil cleaning, condenser inspection.',
    futureNext.toISOString().slice(0, 10),
    principal.personId,
  );

  // 2 — main electrical panel annual inspection (next date 8 months
  // ahead — current)
  const future8 = new Date(today);
  future8.setMonth(today.getMonth() + 8);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_maintenance_records (id, asset_id, maintenance_type, performed_date, performed_by, cost, description, next_maintenance_date, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date, $9::uuid)',
    generateId(),
    mainPanelId,
    'INSPECTION',
    lastQuarter.toISOString().slice(0, 10),
    'Lincoln Electric Services',
    850.0,
    'Annual thermal imaging inspection. No hot spots.',
    future8.toISOString().slice(0, 10),
    principal.personId,
  );

  // 3 — lobby elevator scheduled (next date OVERDUE — past)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_maintenance_records (id, asset_id, maintenance_type, performed_date, performed_by, cost, description, next_maintenance_date, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date, $9::uuid)',
    generateId(),
    lobbyElevId,
    'SCHEDULED',
    twoMonthsAgo.toISOString().slice(0, 10),
    'Otis Service Contract',
    520.0,
    'Monthly safety inspection — cables, brakes, doors.',
    pastDue.toISOString().slice(0, 10),
    principal.personId,
  );

  // 4 — cafeteria HVAC corrective (under-maintenance, in progress)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_maintenance_records (id, asset_id, maintenance_type, performed_date, performed_by, cost, description, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid)',
    generateId(),
    cafeHvacId,
    'CORRECTIVE',
    oneMonthAgo.toISOString().slice(0, 10),
    'AceMech HVAC Services',
    1850.0,
    'Compressor failure — replacing under warranty.',
    principal.personId,
  );

  // 5 — old elevator final inspection (right before decommission)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_maintenance_records (id, asset_id, maintenance_type, performed_date, performed_by, cost, description, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::uuid)',
    generateId(),
    oldElevId,
    'INSPECTION',
    fourMonthsAgo.toISOString().slice(0, 10),
    'Schindler Inspections',
    600.0,
    'Final inspection ahead of decommission. End-of-life confirmed.',
    principal.personId,
  );

  // ── Section E: 1 disposal (DECOMMISSIONED only) ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_asset_disposals (id, school_id, asset_id, disposal_method, disposal_date, value_recovered, recipient_name, disposed_by, authorised_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6, $7, $8::uuid, $9::uuid, $10)',
    generateId(),
    schoolId,
    oldElevId,
    'SCRAP',
    today.toISOString().slice(0, 10),
    350.0,
    'Midwest Metal Recycling',
    vp.personId,
    principal.personId,
    'Service elevator car removed and sold for scrap weight. Hoistway sealed.',
  );

  // ── Section F: 3 utility meters ──
  const elecMeterId = generateId();
  const gasMeterId = generateId();
  const waterMeterId = generateId();
  const meterRows: Array<{ id: string; name: string; type: string; ref: string; unit: string }> = [
    {
      id: elecMeterId,
      name: 'Main Electricity Meter',
      type: 'ELECTRICITY',
      ref: 'METER-ELEC-001',
      unit: 'kWh',
    },
    {
      id: gasMeterId,
      name: 'Main Gas Meter',
      type: 'GAS',
      ref: 'METER-GAS-001',
      unit: 'therms',
    },
    {
      id: waterMeterId,
      name: 'Main Water Meter',
      type: 'WATER',
      ref: 'METER-WATER-001',
      unit: 'gallons',
    },
  ];
  for (const m of meterRows) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.fac_utility_meters (id, school_id, building_id, meter_name, utility_type, meter_reference, unit) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
      m.id,
      schoolId,
      buildingId,
      m.name,
      m.type,
      m.ref,
      m.unit,
    );
  }

  // ── Section G: 12 energy readings (4 per meter) ──
  // Plant 4 monthly readings per meter spanning 4 months back. The
  // first reading per meter carries consumption=NULL (no prior), the
  // next 3 carry the materialised consumption value so the dashboard
  // renders without re-running the EnergyService computation.
  const monthsBack: number[] = [4, 3, 2, 1];
  const energyData: Array<{ meterId: string; baseValue: number; usage: number; cost: number }> = [
    { meterId: elecMeterId, baseValue: 120000, usage: 9800, cost: 1372 },
    { meterId: gasMeterId, baseValue: 8500, usage: 380, cost: 456 },
    { meterId: waterMeterId, baseValue: 245000, usage: 12500, cost: 187.5 },
  ];
  for (const e of energyData) {
    let previous: number | null = null;
    for (let i = 0; i < monthsBack.length; i++) {
      // monthsBack is descending [4,3,2,1] — biggest offset is earliest.
      // Reading_value increments monotonically with each step so the
      // computed consumption stays positive (matches a real-world meter
      // which only counts up).
      const offset = monthsBack[i]!;
      const d = new Date(today);
      d.setMonth(today.getMonth() - offset);
      d.setDate(1);
      const reading = e.baseValue + (i + 1) * e.usage;
      const consumption = previous === null ? null : Number((reading - previous).toFixed(2));
      const costEstimate =
        consumption === null ? null : Number((consumption * (e.cost / e.usage)).toFixed(2));
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fac_energy_readings (id, meter_id, reading_date, reading_value, consumption, cost_estimate, recorded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7::uuid)',
        generateId(),
        e.meterId,
        d.toISOString().slice(0, 10),
        reading,
        consumption,
        costEstimate,
        principal.personId,
      );
      previous = reading;
    }
  }

  // ── Section H: 2 energy targets ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_energy_targets (id, school_id, utility_type, target_period, target_value, academic_year, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
    generateId(),
    schoolId,
    'ELECTRICITY',
    'MONTHLY',
    10000,
    '2025-2026',
    'Monthly electricity cap aligning with the LED retrofit goal.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_energy_targets (id, school_id, utility_type, target_period, target_value, academic_year, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)',
    generateId(),
    schoolId,
    'GAS',
    'ANNUAL',
    4500,
    '2025-2026',
    'Annual gas baseline — review after winter season ends.',
  );

  // ── Section I: 10 space utilisation records ──
  // Pick 5 classrooms × 2 record dates each. One classroom seeded with
  // consistently low utilisation (< 50%) so the underused-rooms demo
  // surfaces it.
  const utilSpaces: Array<{ name: string; cap: number; occ: number }> = [
    { name: 'Room 101', cap: 30, occ: 26 },
    { name: 'Room 102', cap: 30, occ: 24 },
    { name: 'Room 103', cap: 30, occ: 28 },
    { name: 'Room 104', cap: 30, occ: 11 }, // consistently underused
    { name: 'Gymnasium', cap: 200, occ: 165 },
  ];
  const utilDates = [
    new Date(today.getTime() - 86400_000).toISOString().slice(0, 10),
    new Date(today.getTime() - 7 * 86400_000).toISOString().slice(0, 10),
  ];
  for (const sp of utilSpaces) {
    const spaceId = spaceByName.get(sp.name);
    if (!spaceId) continue;
    for (const d of utilDates) {
      const rate = sp.cap > 0 ? Number((sp.occ / sp.cap).toFixed(4)) : null;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.fac_space_utilization_records (id, space_id, record_date, occupancy_count, capacity, utilisation_rate, source) ' +
          "VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, 'ATTENDANCE')",
        generateId(),
        spaceId,
        d,
        sp.occ,
        sp.cap,
        rate,
      );
    }
  }

  // ── Section J: 2 sustainability initiatives ──
  const sustStart1 = new Date(today);
  sustStart1.setMonth(today.getMonth() - 2);
  const sustEnd1 = new Date(today);
  sustEnd1.setMonth(today.getMonth() + 10);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_sustainability_initiatives (id, school_id, name, description, category, start_date, target_completion_date, target_reduction_percent, status, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9, $10::uuid)',
    generateId(),
    schoolId,
    'LED Lighting Retrofit',
    'Replace 100% of fluorescent fixtures with LED across the Main Building.',
    'ENERGY',
    sustStart1.toISOString().slice(0, 10),
    sustEnd1.toISOString().slice(0, 10),
    25.0,
    'ACTIVE',
    principal.personId,
  );
  const sustStart2 = new Date(today);
  sustStart2.setMonth(today.getMonth() - 1);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.fac_sustainability_initiatives (id, school_id, name, description, category, start_date, target_reduction_percent, status, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9::uuid)',
    generateId(),
    schoolId,
    'Water Conservation Audit',
    'Building-wide audit of fixtures with low-flow retrofit plan.',
    'WATER',
    sustStart2.toISOString().slice(0, 10),
    15.0,
    'ACTIVE',
    principal.personId,
  );

  console.log('  Seeded 2 fire drills (1 met target + 1 overrun with issues_noted)');
  console.log('  Seeded 3 asset categories (HVAC Electrical Elevator) + 8 assets');
  console.log('  Seeded 5 asset maintenance records (1 with overdue next_maintenance_date)');
  console.log('  Seeded 1 disposal (DECOMMISSIONED elevator → SCRAP $350 value recovered)');
  console.log('  Seeded 3 utility meters + 12 energy readings');
  console.log(
    '  Seeded 2 energy targets + 10 space utilisation records (1 consistently underused)',
  );
  console.log('  Seeded 2 sustainability initiatives (LED Retrofit + Water Audit)');
}

async function main() {
  try {
    await seedFacilitiesAdvancedB();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('Facilities Advanced (P2-18b) seed failed:', err);
  process.exit(1);
});
