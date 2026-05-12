import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/**
 * P2-21a CRM seed — populates the platform CRM tables with a demo
 * dataset. Idempotent: gates on `crm_accounts` rows for the seeded
 * tenant_demo school.
 *
 * Sections:
 *   A) Account #1 — "Lincoln Academy" ACTIVE bound to tenant_demo
 *      school. Subscription, 3 contacts, 3 interactions, completed
 *      onboarding checklist (8 tasks), 4 weekly health scores, 1
 *      renewal pipeline row UPCOMING, 1 PAID + 1 OPEN invoice.
 *   B) Account #2 — "Maple Charter School" synthetic CRITICAL-risk
 *      example so /crm/health/at-risk isn't empty.
 */

async function seedCrm(): Promise<void> {
  console.log('');
  console.log('  P2-21a CRM Seed');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run `pnpm seed` first');

  const existing = (await client.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS c FROM platform.crm_accounts WHERE school_id = $1::uuid`,
    school.id,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  crm_accounts already populated for tenant_demo school. Skipping.');
    return;
  }

  // Personas lookup.
  const personas = (await client.$queryRawUnsafe(
    `SELECT u.email AS email,
            p.id::text AS person_id,
            u.id::text AS account_id
     FROM platform.platform_users u
     JOIN platform.iam_person p ON p.id = u.person_id
     WHERE u.email IN ('principal@demo.campusos.dev', 'teacher@demo.campusos.dev', 'admin@demo.campusos.dev')`,
  )) as Array<{ email: string; person_id: string; account_id: string }>;
  const byEmail = new Map(personas.map((r) => [r.email, r]));
  const principal = byEmail.get('principal@demo.campusos.dev');
  const teacher = byEmail.get('teacher@demo.campusos.dev');
  const platformAdmin = byEmail.get('admin@demo.campusos.dev');
  if (!principal || !platformAdmin) {
    throw new Error('Missing seeded principal@/admin@ personas — run `pnpm seed` first');
  }

  // ── A. Account #1 — Lincoln Academy ────────────────────────────
  const account1Id = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_accounts
      (id, school_id, organisation_id, account_name, status, billing_email,
       school_champion_person_id, signed_date, go_live_date, renewal_date,
       billing_address_json)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'ACTIVE', $5, $6::uuid,
       CURRENT_DATE - INTERVAL '12 months',
       CURRENT_DATE - INTERVAL '11 months',
       CURRENT_DATE + INTERVAL '60 days',
       $7::jsonb)`,
    account1Id,
    school.id,
    school.organisationId,
    'Lincoln Academy',
    'billing@lincolnacademy.edu',
    principal.person_id,
    JSON.stringify({
      street: '1234 Oak Street',
      city: 'Springfield',
      state: 'IL',
      postal: '62701',
      country: 'US',
    }),
  );

  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_subscriptions
      (id, account_id, plan_name, billing_interval, mrr_cents, student_count_at_sign,
       status, current_period_start, current_period_end)
     VALUES ($1::uuid, $2::uuid, 'Pro Plan', 'ANNUAL', 200000, 250, 'ACTIVE',
       CURRENT_DATE - INTERVAL '6 months', CURRENT_DATE + INTERVAL '6 months')`,
    generateId(),
    account1Id,
  );

  const contactSarah = generateId();
  const contactRivera = generateId();
  const contactBilling = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_contacts
      (id, account_id, person_id, name, email, role, is_primary)
     VALUES
      ($1::uuid, $2::uuid, $3::uuid, 'Sarah Mitchell', 'principal@demo.campusos.dev', 'DECISION_MAKER', true),
      ($4::uuid, $2::uuid, $5::uuid, 'James Rivera', 'teacher@demo.campusos.dev', 'CHAMPION', false),
      ($6::uuid, $2::uuid, NULL, 'Accounts Payable', 'ap@lincolnacademy.edu', 'BILLING_CONTACT', false)`,
    contactSarah,
    account1Id,
    principal.person_id,
    contactRivera,
    teacher?.person_id ?? principal.person_id,
    contactBilling,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_interactions
      (id, account_id, contact_id, interaction_type, subject, notes, logged_by, interaction_at)
     VALUES
      ($1::uuid, $2::uuid, $3::uuid, 'DEMO', 'Initial product demo',
       'Walked through SIS + Attendance + Communications. Strong interest in early dismissal flow.',
       $4::uuid, NOW() - INTERVAL '11 months'),
      ($5::uuid, $2::uuid, $3::uuid, 'MEETING', 'Onboarding kickoff',
       'Reviewed migration plan. Agreed to start with 3 grades in pilot.',
       $4::uuid, NOW() - INTERVAL '10 months'),
      ($6::uuid, $2::uuid, NULL, 'SUPPORT', 'Help with import format',
       'Teacher CSV import had column ordering issue — resolved with template.',
       $4::uuid, NOW() - INTERVAL '30 days')`,
    generateId(),
    account1Id,
    contactSarah,
    platformAdmin.person_id,
    generateId(),
    generateId(),
  );

  const checklistId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_onboarding_checklists
      (id, account_id, template_version, started_at, completed_at, status)
     VALUES ($1::uuid, $2::uuid, 1,
       NOW() - INTERVAL '11 months',
       NOW() - INTERVAL '10 months',
       'COMPLETED')`,
    checklistId,
    account1Id,
  );
  const tasks = [
    { name: 'Provision tenant schema', category: 'TECHNICAL' },
    { name: 'Configure SSO / SAML', category: 'CONFIGURATION' },
    { name: 'Import student roster', category: 'DATA_MIGRATION' },
    { name: 'Import staff directory', category: 'DATA_MIGRATION' },
    { name: 'Run administrator training', category: 'TRAINING' },
    { name: 'Run teacher training', category: 'TRAINING' },
    { name: 'Configure attendance + grading policies', category: 'CONFIGURATION' },
    { name: 'Go-live readiness review', category: 'GO_LIVE' },
  ];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    await client.$executeRawUnsafe(
      `INSERT INTO platform.crm_onboarding_tasks
        (id, checklist_id, task_name, task_category, sort_order,
         status, completed_at, completed_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'COMPLETED',
         NOW() - INTERVAL '10 months', $6::uuid)`,
      generateId(),
      checklistId,
      t.name,
      t.category,
      i,
      platformAdmin.person_id,
    );
  }

  const healthSeed: Array<{
    daysAgo: number;
    overall: number;
    risk: 'HEALTHY' | 'AT_RISK' | 'CRITICAL';
  }> = [
    { daysAgo: 21, overall: 88, risk: 'HEALTHY' },
    { daysAgo: 14, overall: 75, risk: 'HEALTHY' },
    { daysAgo: 7, overall: 62, risk: 'AT_RISK' },
    { daysAgo: 0, overall: 85, risk: 'HEALTHY' },
  ];
  for (const s of healthSeed) {
    await client.$executeRawUnsafe(
      `INSERT INTO platform.crm_health_scores
        (id, account_id, score_date, overall_score, adoption_score, engagement_score,
         support_ticket_score, nps_score, risk_level)
       VALUES ($1::uuid, $2::uuid, CURRENT_DATE - ($3 || ' days')::interval,
         $4, $5, $6, $7, $8, $9)`,
      generateId(),
      account1Id,
      String(s.daysAgo),
      s.overall,
      Math.min(100, s.overall + 5),
      Math.max(0, s.overall - 5),
      s.overall,
      s.risk === 'HEALTHY' ? 50 : s.risk === 'AT_RISK' ? 20 : -10,
      s.risk,
    );
  }

  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_renewal_pipeline
      (id, account_id, renewal_date, current_mrr_cents, proposed_mrr_cents,
       stage, risk_factors, assigned_csm, notes)
     VALUES ($1::uuid, $2::uuid, CURRENT_DATE + INTERVAL '60 days', 200000, 220000,
       'UPCOMING', ARRAY['Lower NPS in Q2']::text[], $3::uuid,
       'Renewal conversation scheduled for next month. Champion strong.')`,
    generateId(),
    account1Id,
    platformAdmin.person_id,
  );

  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_invoices
      (id, account_id, amount_cents, currency, status, invoice_date, due_date, paid_at)
     VALUES
      ($1::uuid, $2::uuid, 200000, 'usd', 'PAID', CURRENT_DATE - INTERVAL '180 days',
       CURRENT_DATE - INTERVAL '150 days', NOW() - INTERVAL '155 days'),
      ($3::uuid, $2::uuid, 200000, 'usd', 'OPEN', CURRENT_DATE - INTERVAL '10 days',
       CURRENT_DATE + INTERVAL '20 days', NULL)`,
    generateId(),
    account1Id,
    generateId(),
  );

  // ── B. Account #2 — Maple Charter (synthetic CRITICAL-risk) ────
  const account2Id = generateId();
  const orgIdForAccount2 = school.organisationId ?? '00000000-0000-0000-0000-00000000beef';
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_accounts
      (id, organisation_id, account_name, status, billing_email,
       signed_date, go_live_date, renewal_date)
     VALUES ($1::uuid, $2::uuid, 'Maple Charter School', 'ACTIVE',
       'billing@maplecharter.example',
       CURRENT_DATE - INTERVAL '18 months',
       CURRENT_DATE - INTERVAL '15 months',
       CURRENT_DATE + INTERVAL '14 days')`,
    account2Id,
    orgIdForAccount2,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_subscriptions
      (id, account_id, plan_name, billing_interval, mrr_cents, status,
       current_period_start, current_period_end)
     VALUES ($1::uuid, $2::uuid, 'Starter Plan', 'ANNUAL', 80000, 'PAST_DUE',
       CURRENT_DATE - INTERVAL '6 months', CURRENT_DATE + INTERVAL '6 months')`,
    generateId(),
    account2Id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_health_scores
      (id, account_id, score_date, overall_score, adoption_score, engagement_score,
       support_ticket_score, nps_score, risk_level)
     VALUES ($1::uuid, $2::uuid, CURRENT_DATE, 35, 30, 40, 30, -20, 'CRITICAL')`,
    generateId(),
    account2Id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_renewal_pipeline
      (id, account_id, renewal_date, current_mrr_cents, proposed_mrr_cents,
       stage, risk_factors, assigned_csm, notes)
     VALUES ($1::uuid, $2::uuid, CURRENT_DATE + INTERVAL '14 days', 80000, NULL,
       'CHURNING', ARRAY['Low usage', 'Open PAST_DUE invoice', 'No champion']::text[],
       $3::uuid, 'High churn risk — escalate to leadership.')`,
    generateId(),
    account2Id,
    platformAdmin.person_id,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.crm_invoices
      (id, account_id, amount_cents, currency, status, invoice_date, due_date)
     VALUES ($1::uuid, $2::uuid, 80000, 'usd', 'OPEN',
       CURRENT_DATE - INTERVAL '45 days', CURRENT_DATE - INTERVAL '15 days')`,
    generateId(),
    account2Id,
  );

  console.log('  P2-21a CRM seeded: 2 accounts, 2 subscriptions, 3 contacts, 3 interactions,');
  console.log('  1 onboarding checklist (8 tasks COMPLETED), 5 health scores,');
  console.log('  2 renewals, 3 invoices.');
}

async function main(): Promise<void> {
  try {
    await seedCrm();
  } finally {
    await disconnectAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
