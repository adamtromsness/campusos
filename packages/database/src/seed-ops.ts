import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/**
 * P2-21b Internal Ops + Pricing seed.
 *
 * Idempotent: gates on `ops_employees` row count. Seeds two CampusOS
 * employees bridged from existing seeded iam_person rows (admin@ +
 * principal@), grants INTERNAL_ADMIN on the admin row, opens one
 * active 2-hour tenant access grant for the principal as an audit
 * trail demo, drops a couple of internal tickets in different status
 * states, and lands the canonical 3 pricing bands + 3 support tiers.
 */

async function seedOps(): Promise<void> {
  console.log('');
  console.log('  P2-21b Internal Ops + Pricing Seed');
  console.log('');

  const client = getPlatformClient();
  const existing = (await client.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM platform.ops_employees`,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  ops_employees already populated. Skipping.');
    return;
  }

  const personas = (await client.$queryRawUnsafe(
    `SELECT u.email AS email, p.id::text AS person_id
     FROM platform.platform_users u
     JOIN platform.iam_person p ON p.id = u.person_id
     WHERE u.email IN ('admin@demo.campusos.dev', 'principal@demo.campusos.dev', 'teacher@demo.campusos.dev')`,
  )) as Array<{ email: string; person_id: string }>;
  const byEmail = new Map(personas.map((r) => [r.email, r]));
  const platformAdmin = byEmail.get('admin@demo.campusos.dev');
  const principal = byEmail.get('principal@demo.campusos.dev');
  if (!platformAdmin || !principal) {
    throw new Error('Missing seeded admin@ / principal@ personas — run `pnpm seed` first');
  }

  // ── A. Two ops employees ──────────────────────────────────────
  const adminEmpId = generateId();
  const principalEmpId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.ops_employees
      (id, person_id, department, role, hire_date)
     VALUES
      ($1::uuid, $2::uuid, 'OPERATIONS', 'Founder / CEO', CURRENT_DATE - INTERVAL '3 years'),
      ($3::uuid, $4::uuid, 'CUSTOMER_SUCCESS', 'Customer Success Lead', CURRENT_DATE - INTERVAL '1 year')`,
    adminEmpId,
    platformAdmin.person_id,
    principalEmpId,
    principal.person_id,
  );

  // ── B. Permissions ─────────────────────────────────────────────
  // The admin gets INTERNAL_ADMIN (so they can approve tenant-access
  // grants) plus CRM_WRITE and SUPPORT.
  // The principal gets CRM_READ + TENANT_ACCESS (so they can request
  // tenant access; the admin approves).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.ops_permissions (id, employee_id, scope, granted_by)
     VALUES
      ($1::uuid, $2::uuid, 'INTERNAL_ADMIN', $2::uuid),
      ($3::uuid, $2::uuid, 'CRM_WRITE', $2::uuid),
      ($4::uuid, $2::uuid, 'SUPPORT', $2::uuid),
      ($5::uuid, $6::uuid, 'CRM_READ', $2::uuid),
      ($7::uuid, $6::uuid, 'TENANT_ACCESS', $2::uuid)`,
    generateId(),
    adminEmpId,
    generateId(),
    generateId(),
    generateId(),
    principalEmpId,
    generateId(),
  );

  // ── C. One active tenant access grant for the audit trail demo ──
  await client.$executeRawUnsafe(
    `INSERT INTO platform.ops_tenant_access_grants
      (id, employee_id, tenant_schema, justification, access_type,
       granted_at, expires_at, approved_by)
     VALUES ($1::uuid, $2::uuid, 'tenant_demo',
       'Investigating reported CSV import column-ordering issue for Lincoln Academy',
       'READ_ONLY', now(), now() + INTERVAL '2 hours', $3::uuid)`,
    generateId(),
    principalEmpId,
    adminEmpId,
  );

  // ── D. Internal tickets ─────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.ops_internal_tickets
      (id, title, description, category, priority, status, created_by, assigned_to)
     VALUES
      ($1::uuid, 'Investigate slow gradebook export', 'Lincoln Academy reports the
end-of-quarter export takes >2min. Profile the SQL.',
       'BUG', 'HIGH', 'IN_PROGRESS', $2::uuid, $3::uuid),
      ($4::uuid, 'Quarterly invoice template refresh',
       'Update PDF layout to match new brand guidelines.',
       'FEATURE_REQUEST', 'MEDIUM', 'OPEN', $2::uuid, NULL)`,
    generateId(),
    adminEmpId,
    principalEmpId,
    generateId(),
  );

  // ── E. Pricing bands ───────────────────────────────────────────
  const bandSmall = generateId();
  const bandMedium = generateId();
  const bandLarge = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_pricing_bands
      (id, name, student_range_min, student_range_max, monthly_price_cents, annual_price_cents)
     VALUES
      ($1::uuid, 'Small School', 0, 200, 9900, 99000),
      ($2::uuid, 'Medium School', 201, 1000, 19900, 199000),
      ($3::uuid, 'Large School', 1001, NULL, 39900, 399000)`,
    bandSmall,
    bandMedium,
    bandLarge,
  );

  // One historical price change on Medium so the audit trail panel is non-empty.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_pricing_history
      (id, band_id, previous_monthly_cents, new_monthly_cents,
       previous_annual_cents, new_annual_cents, effective_date, changed_by)
     VALUES ($1::uuid, $2::uuid, 17900, 19900, 179000, 199000,
       CURRENT_DATE - INTERVAL '90 days', $3::uuid)`,
    generateId(),
    bandMedium,
    adminEmpId,
  );

  // ── F. Support tiers ──────────────────────────────────────────
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_support_tiers
      (id, name, response_time_hours, includes_phone, includes_dedicated_csm, monthly_addon_cents)
     VALUES
      ($1::uuid, 'Standard', 48, false, false, 0),
      ($2::uuid, 'Premium', 8, true, false, 9900),
      ($3::uuid, 'Enterprise', 2, true, true, 49900)`,
    generateId(),
    generateId(),
    generateId(),
  );

  console.log(
    '  P2-21b Internal Ops + Pricing seeded: 2 employees, 5 permissions, 1 active tenant-access grant,',
  );
  console.log(
    '  2 internal tickets, 3 pricing bands + 1 historical price change, 3 support tiers.',
  );
}

async function main(): Promise<void> {
  try {
    await seedOps();
  } finally {
    await disconnectAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
