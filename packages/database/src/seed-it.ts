import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-it.ts — Cycle 22 Step 4.
 *
 * M62 IT Infrastructure. Idempotent — gated on whether
 * tech_asset_categories already has rows for the demo school.
 *
 * Sections:
 *   A) 2 asset categories — Chromebook (4yr depreciation) + iPad
 *      (3yr).
 *   B) 10 assets — 8 Chromebooks (IT-CB-001..008) + 2 iPads
 *      (IT-IP-001..002). 6 ASSIGNED, 2 AVAILABLE, 1 REPAIR, 1 LOST.
 *   C) 6 assignments — Maya / Rivera / VP / Counsellor / + 2 more.
 *   D) 2 asset documents — warranty PDFs.
 *   E) 3 software licences — Google Workspace SITE, Adobe
 *      Creative Suite PER_SEAT (25 seats / 4 used), Zoom
 *      SUBSCRIPTION.
 *   F) 4 licence assignments — Adobe to Rivera + 3 others
 *      (Mitchell + Park + Hayes); used_seats = 4.
 *   G) 2 vault entries with AES-256-GCM encryption — Wi-Fi
 *      Admin (CRITICAL) + Google Console (ELEVATED) + 2 access
 *      log entries.
 *   H) 5 infrastructure items — 2 switches, 2 access points,
 *      1 server.
 *   I) 1 MDM sync log + 1 STALE_CHECKIN alert.
 *   J) 1 damage report + 1 repair (WARRANTY_CLAIM IN_REPAIR).
 *   K) 1 procurement order — Q3 Chromebook Refresh (10 units,
 *      ORDERED).
 *   L) 2 device options + 1 selection — Chromebook 14in + iPad
 *      10th Gen + Aiden Park selected Chromebook (SELECTED).
 */

const TENANT_SCHEMA = 'tenant_demo';

// AES-256-GCM helper that mirrors the Step 6 CredentialVaultService
// encryption shape — a fixed key derived from a static seed string
// so the seeded ciphertext decrypts deterministically. Real
// production deployments derive from process.env.IT_VAULT_KEY.
const SEED_KEY_MATERIAL = 'campusos-demo-vault-seed-key-2026';
const SEED_KEY_SALT = 'campusos-demo-salt';
function deriveKey(): Buffer {
  return scryptSync(SEED_KEY_MATERIAL, SEED_KEY_SALT, 32);
}
function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Wire format: base64(iv).base64(tag).base64(ciphertext)
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

async function seedIt() {
  console.log('');
  console.log('  IT Infrastructure Seed (Cycle 22 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.tech_asset_categories WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  tech_asset_categories already populated for demo school. Skipping.');
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
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const student = await findUserByEmail('student@demo.campusos.dev');
  const vp = await findUserByEmail('vp@demo.campusos.dev');
  const counsellor = await findUserByEmail('counsellor@demo.campusos.dev');

  // hr_employees.id for the IT admin / procurement orderer (Mitchell
  // is the principal who stands in for IT admin on the Cycle 22 demo).
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, ip.first_name || $1 || ip.last_name AS name ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.iam_person ip ON ip.id = e.person_id',
    ' ',
  )) as Array<{ id: string; name: string }>;
  const empByName = new Map(employees.map((e) => [e.name, e.id]));
  const mitchellEmpId = empByName.get('Sarah Mitchell');

  // Find the existing tkt_vendors row for the WARRANTY_CLAIM repair
  const vendorRow = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.tkt_vendors LIMIT 1',
  )) as Array<{ id: string }>;
  const vendorId = vendorRow[0]?.id ?? null;

  // ── Section A: asset categories ──
  const chromeId = generateId();
  const ipadId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 4, 12)',
    chromeId,
    schoolId,
    'Chromebook',
    'Student + staff Chromebooks for daily classroom use',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_asset_categories (id, school_id, name, description, depreciation_years, maintenance_interval_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 3, 12)',
    ipadId,
    schoolId,
    'iPad',
    'Shared iPads for art / music / lower grades',
  );

  // ── Section B: 10 assets ──
  const assets: Array<{
    id: string;
    tag: string;
    cat: string;
    serial: string;
    make: string;
    model: string;
    status: string;
    purchase_date: string;
    purchase_cost: number;
    warranty_expiry: string;
  }> = [];
  for (let i = 1; i <= 8; i++) {
    assets.push({
      id: generateId(),
      tag: `IT-CB-${String(i).padStart(3, '0')}`,
      cat: chromeId,
      serial: `CB${1000 + i}`,
      make: 'HP',
      model: 'Chromebook 14',
      status: i <= 6 ? 'ASSIGNED' : i === 7 ? 'REPAIR' : 'AVAILABLE',
      purchase_date: '2024-08-15',
      purchase_cost: 350.0,
      warranty_expiry: '2027-08-15',
    });
  }
  for (let i = 1; i <= 2; i++) {
    assets.push({
      id: generateId(),
      tag: `IT-IP-${String(i).padStart(3, '0')}`,
      cat: ipadId,
      serial: `IP${2000 + i}`,
      make: 'Apple',
      model: 'iPad 10th Gen',
      status: 'ASSIGNED',
      purchase_date: '2024-09-01',
      purchase_cost: 449.0,
      warranty_expiry: '2026-09-01',
    });
  }
  for (const a of assets) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_assets (id, school_id, category_id, asset_tag, serial_number, make, model, purchase_date, purchase_cost, status, warranty_expiry) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9, $10, $11::date)',
      a.id,
      schoolId,
      a.cat,
      a.tag,
      a.serial,
      a.make,
      a.model,
      a.purchase_date,
      a.purchase_cost,
      a.status,
      a.warranty_expiry,
    );
  }

  const cb001 = assets.find((a) => a.tag === 'IT-CB-001')!;
  const cb002 = assets.find((a) => a.tag === 'IT-CB-002')!;
  const cb003 = assets.find((a) => a.tag === 'IT-CB-003')!;
  const cb004 = assets.find((a) => a.tag === 'IT-CB-004')!;
  const cb005 = assets.find((a) => a.tag === 'IT-CB-005')!;
  const cb006 = assets.find((a) => a.tag === 'IT-CB-006')!;
  const cb007 = assets.find((a) => a.tag === 'IT-CB-007')!;
  const ip001 = assets.find((a) => a.tag === 'IT-IP-001')!;
  const ip002 = assets.find((a) => a.tag === 'IT-IP-002')!;

  // ── Section C: 6 assignments ──
  const assignmentRows: Array<{
    asset: string;
    assignedTo: string;
    condition: string;
  }> = [
    { asset: cb001.id, assignedTo: student.accountId, condition: 'EXCELLENT' },
    { asset: cb002.id, assignedTo: teacher.accountId, condition: 'GOOD' },
    { asset: cb003.id, assignedTo: vp.accountId, condition: 'EXCELLENT' },
    { asset: cb004.id, assignedTo: counsellor.accountId, condition: 'GOOD' },
    { asset: cb005.id, assignedTo: principal.accountId, condition: 'EXCELLENT' },
    { asset: cb006.id, assignedTo: vp.accountId, condition: 'GOOD' },
    { asset: ip001.id, assignedTo: principal.accountId, condition: 'EXCELLENT' },
    { asset: ip002.id, assignedTo: teacher.accountId, condition: 'GOOD' },
  ];
  for (const a of assignmentRows) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_asset_assignments (id, asset_id, assigned_to_id, assigned_by, assigned_at, condition_at_assign) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() - interval '30 days', $5)",
      generateId(),
      a.asset,
      a.assignedTo,
      principal.accountId,
      a.condition,
    );
  }

  // ── Section D: 2 documents ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_asset_documents (id, asset_id, document_type, s3_key, file_name, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    generateId(),
    cb001.id,
    'WARRANTY',
    'docs/warranty/cb-001.pdf',
    'HP-Chromebook-3yr-Warranty.pdf',
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_asset_documents (id, asset_id, document_type, s3_key, file_name, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    generateId(),
    ip001.id,
    'WARRANTY',
    'docs/warranty/ip-001.pdf',
    'Apple-iPad-2yr-AppleCare.pdf',
    principal.accountId,
  );

  // ── Section E: 3 licences ──
  const workspaceLicId = generateId();
  const adobeLicId = generateId();
  const zoomLicId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_software_licences (id, school_id, software_name, vendor, licence_type, total_seats, used_seats, expiry_date, annual_cost, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Google Workspace for Education', 'Google', 'SITE', NULL, 0, '2026-12-31', 0, $3::uuid)",
    workspaceLicId,
    schoolId,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_software_licences (id, school_id, software_name, vendor, licence_type, total_seats, used_seats, expiry_date, annual_cost, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Adobe Creative Suite', 'Adobe', 'PER_SEAT', 25, 4, '2026-08-31', 7500, $3::uuid)",
    adobeLicId,
    schoolId,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_software_licences (id, school_id, software_name, vendor, licence_type, total_seats, used_seats, expiry_date, annual_cost, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Zoom Education', 'Zoom', 'SUBSCRIPTION', 100, 0, '2026-12-31', 1500, $3::uuid)",
    zoomLicId,
    schoolId,
    principal.accountId,
  );

  // ── Section F: 4 licence assignments (Adobe) ──
  const adobeAssignees = [
    teacher.accountId,
    principal.accountId,
    vp.accountId,
    counsellor.accountId,
  ];
  for (const aid of adobeAssignees) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_software_assignments (id, licence_id, assignee_id, assigned_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)',
      generateId(),
      adobeLicId,
      aid,
      principal.accountId,
    );
  }

  // ── Section G: 2 vault entries + 2 access logs ──
  const wifiCredId = generateId();
  const consoleCredId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_credential_vault (id, school_id, service_name, credential_type, username, encrypted_password, url, access_tier, last_rotated_at, rotation_due_at, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'WIFI_CREDENTIAL', $4, $5, NULL, 'CRITICAL', now() - interval '90 days', now() + interval '180 days', $6, $7::uuid)",
    wifiCredId,
    schoolId,
    'School Wi-Fi Admin',
    'admin@school',
    encrypt('SecureWifi-Admin-2026!'),
    'Network admin password — rotate every 9 months',
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_credential_vault (id, school_id, service_name, credential_type, username, encrypted_password, url, access_tier, last_rotated_at, rotation_due_at, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'ADMIN_SHARED', $4, $5, $6, 'ELEVATED', now() - interval '30 days', now() + interval '60 days', $7, $8::uuid)",
    consoleCredId,
    schoolId,
    'Google Workspace Admin Console',
    'admin@demo.campusos.dev',
    encrypt('Console-Admin-Pass-2026'),
    'https://admin.google.com',
    'Google Workspace super admin shared account',
    principal.accountId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_credential_access_log (id, credential_id, accessed_by, access_type, accessed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'CREATE', now() - interval '90 days')",
    generateId(),
    wifiCredId,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_credential_access_log (id, credential_id, accessed_by, access_type, accessed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'VIEW', now() - interval '7 days')",
    generateId(),
    consoleCredId,
    vp.accountId,
  );

  // ── Section H: 5 infrastructure items ──
  const infra: Array<{
    name: string;
    type: string;
    location: string;
    ip: string;
    mac: string;
    make: string;
    model: string;
    serial: string;
  }> = [
    {
      name: 'Core Switch',
      type: 'SWITCH',
      location: 'Main Building / Server Room',
      ip: '10.0.0.1',
      mac: 'A0:B1:C2:D3:E4:F5',
      make: 'Cisco',
      model: 'Catalyst 9300',
      serial: 'SW-CORE-001',
    },
    {
      name: 'Floor 1 Switch',
      type: 'SWITCH',
      location: 'Main Building / Floor 1',
      ip: '10.0.1.1',
      mac: 'A0:B1:C2:D3:E4:F6',
      make: 'Cisco',
      model: 'Catalyst 2960',
      serial: 'SW-F1-001',
    },
    {
      name: 'Library AP',
      type: 'ACCESS_POINT',
      location: 'Library',
      ip: '10.0.10.1',
      mac: 'B1:C2:D3:E4:F5:A6',
      make: 'Ubiquiti',
      model: 'U6-Pro',
      serial: 'AP-LIB-001',
    },
    {
      name: 'Gym AP',
      type: 'ACCESS_POINT',
      location: 'Gymnasium',
      ip: '10.0.10.2',
      mac: 'B1:C2:D3:E4:F5:A7',
      make: 'Ubiquiti',
      model: 'U6-Pro',
      serial: 'AP-GYM-001',
    },
    {
      name: 'File Server',
      type: 'SERVER',
      location: 'Main Building / Server Room',
      ip: '10.0.0.10',
      mac: 'C2:D3:E4:F5:A6:B7',
      make: 'Dell',
      model: 'PowerEdge R650',
      serial: 'SRV-FILE-001',
    },
  ];
  for (const i of infra) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_infrastructure_items (id, school_id, item_name, item_type, location, ip_address, mac_address, make, model, serial_number, purchase_date, warranty_expiry, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, '2023-08-01'::date, '2028-08-01'::date, 'ACTIVE')",
      generateId(),
      schoolId,
      i.name,
      i.type,
      i.location,
      i.ip,
      i.mac,
      i.make,
      i.model,
      i.serial,
    );
  }

  // ── Section I: 1 MDM sync + 1 alert ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_mdm_sync_logs (id, asset_id, mdm_provider, sync_at, device_name, os_version, last_check_in, is_compliant, compliance_details) ' +
      "VALUES ($1::uuid, $2::uuid, 'GOOGLE', now() - interval '1 day', $3, '124.0.6367.91', now() - interval '1 day', true, $4::jsonb)",
    generateId(),
    cb003.id,
    'CB-003 (VP)',
    JSON.stringify({ encryption: 'enabled', passcode: 'enforced', last_seen: 'yesterday' }),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_mdm_alerts (id, asset_id, alert_type, alert_detail, first_detected_at, last_detected_at, is_resolved) ' +
      "VALUES ($1::uuid, $2::uuid, 'STALE_CHECKIN', $3, now() - interval '7 days', now() - interval '1 day', false)",
    generateId(),
    cb005.id,
    'Device has not checked in for 7 days. Last seen 2026-04-29.',
  );

  // ── Section J: 1 damage report + 1 repair ──
  const damageId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_damage_reports (id, asset_id, reported_by, description, severity, photo_s3_keys, reported_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'MODERATE', $5::text[], now() - interval '5 days')",
    damageId,
    cb007.id,
    teacher.accountId,
    'Dropped on tile floor — screen has visible crack across lower-right corner. Still functional.',
    ['damage/cb007-1.jpg', 'damage/cb007-2.jpg'],
  );
  const repairId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_repair_records (id, asset_id, damage_report_id, vendor_id, repair_type, sent_for_repair_at, estimated_return_date, status, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'WARRANTY_CLAIM', now() - interval '4 days', (CURRENT_DATE + interval '14 days')::date, 'IN_REPAIR', $5::uuid)",
    repairId,
    cb007.id,
    damageId,
    vendorId,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      '.tech_damage_reports SET repair_record_id = $1::uuid WHERE id = $2::uuid',
    repairId,
    damageId,
  );

  // ── Section K: 1 procurement order ──
  if (mitchellEmpId) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_procurement_orders (id, school_id, order_title, vendor_id, purchase_order_number, ordered_by, order_date, expected_delivery_date, total_cost, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4::uuid, 'PO-2026-Q3-CB', $5::uuid, (CURRENT_DATE - interval '7 days')::date, (CURRENT_DATE + interval '21 days')::date, 3500, 'ORDERED')",
      generateId(),
      schoolId,
      'Q3 Chromebook Refresh — 10 units',
      vendorId,
      mitchellEmpId,
    );
  }

  // ── Section L: 2 device options + 1 selection ──
  const cbOption = generateId();
  const ipadOption = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_device_options (id, school_id, option_name, device_type, operating_system, specifications, software_available, cost_difference, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], 0, true)',
    cbOption,
    schoolId,
    'Chromebook 14in (Standard)',
    'LAPTOP',
    'Chrome OS',
    '14-inch HD display, 8GB RAM, 64GB storage, Intel Celeron',
    ['Google Workspace', 'Khan Academy', 'Read&Write'],
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tech_device_options (id, school_id, option_name, device_type, operating_system, specifications, software_available, cost_difference, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::text[], 100, true)',
    ipadOption,
    schoolId,
    'iPad 10th Gen (Premium)',
    'TABLET',
    'iPadOS',
    '10.9-inch Liquid Retina, 64GB, A14 Bionic, Wi-Fi only',
    ['Apple Suite', 'GarageBand', 'Notability', 'Procreate'],
  );
  // Aiden Park (existing seeded student) selects a Chromebook during ENROLMENT
  const aidenRow = (await client.$queryRawUnsafe(
    "SELECT p.id::text AS person_id FROM platform.iam_person p WHERE p.first_name='Aiden' AND p.last_name='Johnson' LIMIT 1",
  )) as Array<{ person_id: string }>;
  if (aidenRow.length > 0) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tech_device_selections (id, person_id, option_id, selection_context, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ENROLMENT', 'SELECTED')",
      generateId(),
      aidenRow[0]!.person_id,
      cbOption,
    );
  }

  // Suppress unused vars
  void zoomLicId;
  void workspaceLicId;

  console.log('  Seeded 2 categories + 10 assets + 8 assignments + 2 documents');
  console.log(
    '  Seeded 3 licences + 4 Adobe assignments (used_seats=4) + 2 vault entries + 2 access logs',
  );
  console.log('  Seeded 5 infrastructure items + 1 MDM sync + 1 STALE_CHECKIN alert');
  console.log('  Seeded 1 damage report + 1 WARRANTY_CLAIM repair (IN_REPAIR)');
  console.log('  Seeded 1 procurement order + 2 device options + 1 ENROLMENT selection (Aiden)');
}

async function main() {
  try {
    await seedIt();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('IT seed failed:', err);
  process.exit(1);
});
