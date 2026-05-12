import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-it-advanced.ts — P2-20a Step 3.
 *
 * M62 IT Advanced. Idempotent — gated on whether tech_remote_actions
 * already has rows for the demo school. Sections:
 *
 *   A) 3 remote actions — LOCK COMPLETED + WIPE COMPLETED + LOCATE
 *      PENDING. All with justification trimmed >= 20 chars. The WIPE
 *      action's parent asset has status=AVAILABLE post-seed to mirror
 *      the auto-reset invariant the Step 4 service applies live.
 *   B) 2 licence renewals — Adobe Creative Suite + Zoom. Previous +
 *      new expiry + cost. The seed updates tech_software_licences
 *      expiry_date inside the same script so it stays consistent.
 *   C) 10 device usage summaries across 3 devices for the last 10
 *      days. One row carries flagged_activity=true.
 *   D) 1 COMPLETED inventory audit (45 expected / 42 found / 2
 *      missing / 1 unrecorded) + 8 audit items (5 found GOOD, 2
 *      found FAIR, 1 not found).
 *   E) 10 VOIP phone extensions (5 DESK, 3 CLASSROOM, 1 OFFICE,
 *      1 FAX). 7 assigned to hr_employees, 3 unassigned.
 *   F) 3 config documentation rows (NETWORK_TOPOLOGY v2 with diagram,
 *      WIFI v1, BACKUP v3).
 *   G) 3 monitoring checks (SIS API HTTP 5min, Payment Gateway HTTP
 *      5min, Email Server PING 10min) + 5 alerts (2 active DOWN,
 *      1 DEGRADED acknowledged, 2 RECOVERED).
 *   H) Extends 5 existing infrastructure items with last_checked_at
 *      stamps so the registry shows a fresh-vs-stale split.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedItAdvanced() {
  console.log('');
  console.log('  IT Advanced Seed (P2-20a Step 3)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.tech_remote_actions r ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.tech_assets a ON a.id = r.asset_id ' +
      'WHERE a.school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  tech_remote_actions already populated for demo school. Skipping.');
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

  // hr_employees ids (Mitchell stands in for IT admin)
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, ip.first_name || $1 || ip.last_name AS name ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id',
    ' ',
  )) as Array<{ id: string; name: string }>;
  const empByName = new Map(employees.map((e) => [e.name, e.id]));
  const mitchellEmpId = empByName.get('Sarah Mitchell');
  const riveraEmpId = empByName.get('James Rivera');
  const parkEmpId = empByName.get('Linda Park');
  const hayesEmpId = empByName.get('Marcus Hayes');

  // Pull existing tech_assets for remote actions + audit + usage
  const assets = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, asset_tag, status FROM ' +
      TENANT_SCHEMA +
      '.tech_assets WHERE school_id = $1::uuid ORDER BY asset_tag LIMIT 8',
    schoolId,
  )) as Array<{ id: string; asset_tag: string; status: string }>;
  if (assets.length < 3) {
    console.log('  Need at least 3 tech_assets seeded first (run seed:it). Skipping.');
    return;
  }

  // ── Section A: 3 remote actions ──
  const lockId = generateId();
  const wipeId = generateId();
  const locateId = generateId();
  const completedAt1 = new Date(Date.now() - 1000 * 60 * 60 * 24 * 2); // 2 days ago
  const completedAt2 = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5); // 5 days ago

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_remote_actions (id, asset_id, action_type, initiated_by, justification, mdm_command_ref, status, completed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::timestamptz)',
    lockId,
    assets[0]!.id,
    'LOCK',
    principal.personId,
    'Student reported iPad lost at bus stop, locking to prevent unauthorized access until recovered',
    'mdm_cmd_lock_001',
    'COMPLETED',
    completedAt1.toISOString(),
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_remote_actions (id, asset_id, action_type, initiated_by, justification, mdm_command_ref, status, completed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8::timestamptz)',
    wipeId,
    assets[1]!.id,
    'WIPE',
    principal.personId,
    'Device reassignment from departing teacher to new hire, performing factory reset to remove personal config and prior assignment data',
    'mdm_cmd_wipe_001',
    'COMPLETED',
    completedAt2.toISOString(),
  );

  // Reflect the WIPE auto-reset invariant — Step 4 service will flip
  // tech_assets.status to AVAILABLE on WIPE + COMPLETED. Mirror that in
  // the seed so the demo state matches the runtime contract.
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      ".tech_assets SET status = 'AVAILABLE', updated_at = now() WHERE id = $1::uuid",
    assets[1]!.id,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_remote_actions (id, asset_id, action_type, initiated_by, justification, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6)',
    locateId,
    assets[2]!.id,
    'LOCATE',
    principal.personId,
    'Parent reported student left iPad at school over weekend, requesting location for retrieval',
    'PENDING',
  );

  // ── Section B: 2 licence renewals ──
  const licences = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, software_name, expiry_date::text AS expiry_date FROM ' +
      TENANT_SCHEMA +
      '.tech_software_licences WHERE school_id = $1::uuid ORDER BY software_name LIMIT 3',
    schoolId,
  )) as Array<{ id: string; software_name: string; expiry_date: string | null }>;

  if (licences.length >= 2) {
    // First renewal — Adobe
    const adobePrev = licences[0]!.expiry_date ?? '2026-06-30';
    const adobeNew = '2027-06-30';
    const adobeRenewalId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_licence_renewals (id, licence_id, previous_expiry_date, new_expiry_date, renewal_cost, renewed_by, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5::numeric, $6::uuid, $7)',
      adobeRenewalId,
      licences[0]!.id,
      adobePrev,
      adobeNew,
      1200.0,
      principal.personId,
      'Annual renewal for ' + licences[0]!.software_name,
    );
    await client.$executeRawUnsafe(
      'UPDATE ' +
        TENANT_SCHEMA +
        '.tech_software_licences SET expiry_date = $1::date, updated_at = now() WHERE id = $2::uuid',
      adobeNew,
      licences[0]!.id,
    );

    // Second renewal — Zoom (or Google)
    const zoomPrev = licences[1]!.expiry_date ?? '2026-08-31';
    const zoomNew = '2027-08-31';
    const zoomRenewalId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_licence_renewals (id, licence_id, previous_expiry_date, new_expiry_date, renewal_cost, renewed_by, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5::numeric, $6::uuid, $7)',
      zoomRenewalId,
      licences[1]!.id,
      zoomPrev,
      zoomNew,
      800.0,
      principal.personId,
      'Annual renewal for ' + licences[1]!.software_name,
    );
    await client.$executeRawUnsafe(
      'UPDATE ' +
        TENANT_SCHEMA +
        '.tech_software_licences SET expiry_date = $1::date, updated_at = now() WHERE id = $2::uuid',
      zoomNew,
      licences[1]!.id,
    );
  }

  // ── Section C: 10 device usage summaries ──
  // 3 devices, ~3-4 days each. One row carries flagged_activity=true.
  const usageAssets = assets.slice(0, 3);
  let usageCount = 0;
  for (let d = 0; d < 4 && usageCount < 10; d++) {
    for (let a = 0; a < usageAssets.length && usageCount < 10; a++) {
      const day = new Date();
      day.setUTCDate(day.getUTCDate() - d);
      const dayIso = day.toISOString().slice(0, 10);
      const flagged = usageCount === 5;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.tech_device_usage_summaries (id, asset_id, summary_date, screen_time_minutes, apps_used, flagged_activity, summary_source, recorded_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3::date, $4::int, $5::text[], $6::boolean, $7, $8::uuid)',
        generateId(),
        usageAssets[a]!.id,
        dayIso,
        180 + a * 20 + d * 10,
        flagged
          ? ['Safari', 'YouTube', 'Unknown App', 'Bypass Tool']
          : ['Chrome', 'Google Classroom', 'Khan Academy', 'Notes'],
        flagged,
        'MDM_PROVIDER_SYNC',
        principal.personId,
      );
      usageCount += 1;
    }
  }

  // ── Section D: 1 COMPLETED audit + 8 audit items ──
  const auditId = generateId();
  const auditDate = new Date();
  auditDate.setUTCDate(auditDate.getUTCDate() - 3);
  const auditCompletedAt = new Date(auditDate);
  auditCompletedAt.setUTCHours(auditCompletedAt.getUTCHours() + 4);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_inventory_audits (id, school_id, audit_name, building, conducted_by, audit_date, total_assets_expected, total_assets_found, total_assets_missing, total_assets_unrecorded, audit_notes, status, completed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6::date, $7::int, $8::int, $9::int, $10::int, $11, $12, $13::timestamptz)',
    auditId,
    schoolId,
    'Building A Annual Device Audit',
    'Building A',
    principal.personId,
    auditDate.toISOString().slice(0, 10),
    45,
    42,
    2,
    1,
    'Annual physical inventory audit. 2 missing devices flagged for follow-up investigation. 1 unrecorded asset discovered.',
    'COMPLETED',
    auditCompletedAt.toISOString(),
  );

  // 8 audit items
  const auditItems: Array<{
    asset_id: string | null;
    asset_tag: string;
    found: boolean;
    condition: string | null;
    notes: string | null;
  }> = [
    {
      asset_id: assets[0]!.id,
      asset_tag: assets[0]!.asset_tag,
      found: true,
      condition: 'GOOD',
      notes: null,
    },
    {
      asset_id: assets[1]!.id,
      asset_tag: assets[1]!.asset_tag,
      found: true,
      condition: 'GOOD',
      notes: null,
    },
    {
      asset_id: assets[2]!.id,
      asset_tag: assets[2]!.asset_tag,
      found: true,
      condition: 'GOOD',
      notes: null,
    },
    {
      asset_id: assets[3]!.id,
      asset_tag: assets[3]!.asset_tag,
      found: true,
      condition: 'FAIR',
      notes: 'Hinge wear',
    },
    {
      asset_id: assets[4]!.id,
      asset_tag: assets[4]!.asset_tag,
      found: true,
      condition: 'GOOD',
      notes: null,
    },
    {
      asset_id: assets[5]!.id,
      asset_tag: assets[5]!.asset_tag,
      found: true,
      condition: 'FAIR',
      notes: 'Keyboard worn',
    },
    {
      asset_id: assets[6]!.id,
      asset_tag: assets[6]!.asset_tag,
      found: false,
      condition: null,
      notes: 'Could not locate in expected building wing',
    },
    {
      asset_id: null,
      asset_tag: 'UNREC-LAB3-001',
      found: true,
      condition: 'GOOD',
      notes: 'Unrecorded Chromebook discovered in Lab 3 — needs registration',
    },
  ];
  for (const item of auditItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_inventory_audit_items (id, audit_id, asset_id, asset_tag, found, condition_observed, location_observed, discrepancy_notes, scanned_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::boolean, $6, $7, $8, $9::uuid)',
      generateId(),
      auditId,
      item.asset_id,
      item.asset_tag,
      item.found,
      item.condition,
      'Building A',
      item.notes,
      principal.personId,
    );
  }

  // ── Section E: 10 VOIP extensions ──
  const ext = (
    num: string,
    type: string,
    assignedTo: string | null,
    displayName: string | null,
    location: string | null,
    department: string | null,
  ) => ({
    num,
    type,
    assignedTo,
    displayName,
    location,
    department,
  });
  const extensions = [
    ext(
      '1001',
      'OFFICE',
      mitchellEmpId ?? null,
      'Principal Office',
      'Main Office',
      'Administration',
    ),
    ext(
      '1002',
      'DESK',
      riveraEmpId ?? null,
      'Teacher Lounge — Rivera',
      'Teacher Lounge',
      'Faculty',
    ),
    ext('1003', 'DESK', parkEmpId ?? null, 'VP Office', 'Main Office', 'Administration'),
    ext(
      '1004',
      'DESK',
      hayesEmpId ?? null,
      'Counsellor Office',
      'Counselling Suite',
      'Student Services',
    ),
    ext('1005', 'DESK', null, 'Front Desk', 'Reception', 'Administration'),
    ext('2001', 'CLASSROOM', null, 'Room 101', 'Room 101', 'Faculty'),
    ext('2002', 'CLASSROOM', null, 'Room 102', 'Room 102', 'Faculty'),
    ext('2003', 'CLASSROOM', null, 'Room 103', 'Room 103', 'Faculty'),
    ext('3001', 'DESK', null, 'IT Helpdesk', 'IT Office', 'IT'),
    ext('9001', 'FAX', null, 'Main Office Fax', 'Main Office', 'Administration'),
  ];
  for (const e of extensions) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_phone_extensions (id, school_id, extension_number, assigned_to, display_name, location, department, extension_type, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, true)',
      generateId(),
      schoolId,
      e.num,
      e.assignedTo,
      e.displayName,
      e.location,
      e.department,
      e.type,
    );
  }

  // ── Section F: 3 config docs ──
  const docs = [
    {
      title: 'Network Topology — Building A',
      category: 'NETWORK_TOPOLOGY',
      version: 2,
      diagram: 's3://campusos-it-docs/demo/network-topology-v2.png',
      content:
        '# Network Topology — Building A\n\nThis diagram shows the topology of Building A: main router → core switch → 3 access points covering floors 1-3.\n\n## Updates in v2\n- Added access point in Room 305\n- Replaced legacy switch in MDF',
    },
    {
      title: 'WiFi Configuration',
      category: 'WIFI',
      version: 1,
      diagram: null,
      content:
        '# WiFi Configuration\n\nSchool-wide WiFi: SSID "CampusOS-Staff" + "CampusOS-Student" + "CampusOS-Guest". WPA2-Enterprise with RADIUS auth.',
    },
    {
      title: 'Backup Procedures',
      category: 'BACKUP',
      version: 3,
      diagram: null,
      content:
        '# Backup Procedures\n\nDaily incremental + weekly full. Offsite replication to AWS S3. RPO 24h, RTO 4h.\n\n## v3 changes\n- Added test restore on first Monday of each month\n- Encryption-at-rest verified',
    },
  ];
  for (const d of docs) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_config_documentation (id, school_id, title, category, content_markdown, version, diagram_s3_key, last_updated_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7, $8::uuid)',
      generateId(),
      schoolId,
      d.title,
      d.category,
      d.content,
      d.version,
      d.diagram,
      principal.personId,
    );
  }

  // ── Section G: 3 monitoring checks + 5 alerts ──
  const sisCheckId = generateId();
  const payCheckId = generateId();
  const emailCheckId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_monitoring_checks (id, school_id, system_name, check_url, check_type, interval_minutes, expected_status_code, timeout_seconds, consecutive_failures_to_alert, last_status, last_checked_at, consecutive_failures, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'SIS API', 'https://sis.example.com/health', 'HTTP', 5, 200, 10, 2, 'DOWN', now() - interval '3 minutes', 3, $3::uuid)",
    sisCheckId,
    schoolId,
    principal.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_monitoring_checks (id, school_id, system_name, check_url, check_type, interval_minutes, expected_status_code, timeout_seconds, consecutive_failures_to_alert, last_status, last_checked_at, consecutive_failures, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Payment Gateway', 'https://pay.example.com/health', 'HTTP', 5, 200, 10, 2, 'DEGRADED', now() - interval '1 minute', 1, $3::uuid)",
    payCheckId,
    schoolId,
    principal.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_monitoring_checks (id, school_id, system_name, check_url, check_type, interval_minutes, expected_status_code, timeout_seconds, consecutive_failures_to_alert, last_status, last_checked_at, consecutive_failures, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Email Server', NULL, 'PING', 10, NULL, 10, 2, 'HEALTHY', now() - interval '2 minutes', 0, $3::uuid)",
    emailCheckId,
    schoolId,
    principal.personId,
  );

  // 5 alerts
  const alerts = [
    {
      check_id: sisCheckId,
      alert_type: 'DOWN',
      detected_offset: -120,
      resolved_offset: null,
      response_time: null,
      status_code: null,
      error: 'Connection timeout after 10 seconds',
      ack_by: null,
    },
    {
      check_id: payCheckId,
      alert_type: 'DEGRADED',
      detected_offset: -90,
      resolved_offset: null,
      response_time: 8500,
      status_code: 200,
      error: 'Response time exceeded 5s threshold',
      ack_by: vp.personId,
    },
    {
      check_id: sisCheckId,
      alert_type: 'RECOVERED',
      detected_offset: -300,
      resolved_offset: -240,
      response_time: 145,
      status_code: 200,
      error: null,
      ack_by: principal.personId,
    },
    {
      check_id: emailCheckId,
      alert_type: 'DOWN',
      detected_offset: -480,
      resolved_offset: null,
      response_time: null,
      status_code: null,
      error: 'Ping packet loss > 50%',
      ack_by: null,
    },
    {
      check_id: payCheckId,
      alert_type: 'RECOVERED',
      detected_offset: -600,
      resolved_offset: -540,
      response_time: 240,
      status_code: 200,
      error: null,
      ack_by: principal.personId,
    },
  ];
  for (const a of alerts) {
    const detectedAt = new Date(Date.now() + a.detected_offset * 60 * 1000);
    const resolvedAt =
      a.resolved_offset === null ? null : new Date(Date.now() + a.resolved_offset * 60 * 1000);
    const ackAt =
      a.ack_by === null ? null : new Date(Date.now() + (a.detected_offset + 5) * 60 * 1000);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_monitoring_alerts (id, check_id, alert_type, detected_at, resolved_at, response_time_ms, status_code, error_message, acknowledged_by, acknowledged_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz, $6::int, $7::int, $8, $9::uuid, $10::timestamptz)',
      generateId(),
      a.check_id,
      a.alert_type,
      detectedAt.toISOString(),
      resolvedAt === null ? null : resolvedAt.toISOString(),
      a.response_time,
      a.status_code,
      a.error,
      a.ack_by,
      ackAt === null ? null : ackAt.toISOString(),
    );
  }

  // ── Section H: stamp last_checked_at on existing infra ──
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      ".tech_infrastructure_items SET last_checked_at = now() - interval '2 days' WHERE school_id = $1::uuid",
    schoolId,
  );

  console.log('  Seeded:');
  console.log(
    '    3 remote actions (1 LOCK COMPLETED, 1 WIPE COMPLETED + asset reset, 1 LOCATE PENDING)',
  );
  console.log('    2 licence renewals (expiry dates updated on parent licences)');
  console.log('    10 device usage summaries (1 flagged)');
  console.log('    1 COMPLETED inventory audit + 8 audit items');
  console.log('    10 VOIP extensions (7 assigned)');
  console.log('    3 config docs');
  console.log('    3 monitoring checks + 5 alerts (2 active DOWN, 1 DEGRADED, 2 RECOVERED)');
  console.log('    last_checked_at stamped on existing infrastructure items');
}

(async () => {
  try {
    await seedItAdvanced();
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    await disconnectAll();
  }
})();
