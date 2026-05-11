import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { execSync } from 'child_process';
import { resolve } from 'path';

/**
 * seed-all — full demo-data orchestrator.
 *
 * Runs the documented seed sequence end-to-end so a fresh database
 * lands in the same state every CAT script + adversarial review
 * walks through. Each step is idempotent: re-running the chain on
 * an already-seeded DB skips populated fixtures and only fills in
 * what's new (e.g. after adding a domain seed).
 *
 * Order matters:
 *   1. `seed`           — platform org/school/users + Chen family +
 *                         provisions tenant_demo (applies all tenant
 *                         migrations).
 *   2. `seed-iam`       — 495 permissions, 21 roles (6 baseline +
 *                         15 specialist), role-permission grants,
 *                         user-role assignments.
 *   3. `build-cache`    — rebuilds iam_effective_access_cache after
 *                         the role-permission grants land.
 *   4. `seed-sis`       — students, guardians, families, enrollments,
 *                         attendance. Required by every downstream
 *                         seed because they reference sis_students.
 *   5..N domain seeds   — classroom, messaging, hr, scheduling,
 *                         enrollment, payments, etc. Per-cycle order
 *                         documented in CLAUDE.md.
 *
 * If a step fails, the script exits non-zero and stops. Re-run after
 * fixing the underlying issue — earlier idempotent steps no-op.
 *
 * Usage:
 *   pnpm db:seed                       (from repo root)
 *   pnpm --filter @campusos/database seed:all
 */
const SEED_STEPS: Array<{ label: string; script: string }> = [
  { label: 'platform + tenant_demo provision', script: 'seed.ts' },
  { label: 'IAM permissions + roles + assignments', script: 'seed-iam.ts' },
  { label: 'iam_effective_access_cache rebuild', script: 'build-cache.ts' },
  { label: 'SIS — students, guardians, attendance', script: 'seed-sis.ts' },
  { label: 'Classroom — assignments, grades, snapshots', script: 'seed-classroom.ts' },
  { label: 'Messaging — threads, notifications, moderation', script: 'seed-messaging.ts' },
  { label: 'Emergency alerts', script: 'seed-emergency.ts' },
  { label: 'HR — employees, positions, leave, certifications', script: 'seed-hr.ts' },
  { label: 'Scheduling — bell schedules, timetable, rooms', script: 'seed-scheduling.ts' },
  { label: 'Enrollment — admissions pipeline', script: 'seed-enrollment.ts' },
  { label: 'Payments — billing, invoices, ledger', script: 'seed-payments.ts' },
  { label: 'Profile + household', script: 'seed-profile.ts' },
  { label: 'Tasks + workflow templates', script: 'seed-tasks.ts' },
  { label: 'Tickets — categories, SLA, vendors', script: 'seed-tickets.ts' },
  { label: 'Behaviour — discipline + BIP', script: 'seed-behaviour.ts' },
  { label: 'Health — records, medications, IEP', script: 'seed-health.ts' },
  { label: 'Counselling — caseloads, sessions, MTSS', script: 'seed-counselling.ts' },
  { label: 'Wellbeing check-ins', script: 'seed-wellbeing.ts' },
  { label: 'Library — catalogue, circulation, reading', script: 'seed-library.ts' },
  { label: 'Athletics — programmes, rosters, games', script: 'seed-athletics.ts' },
  { label: 'Meetings + conferences', script: 'seed-meetings.ts' },
  { label: 'Onboarding checklists', script: 'seed-onboarding.ts' },
  { label: 'Clubs + student life', script: 'seed-clubs.ts' },
  { label: 'Groups + communities', script: 'seed-groups.ts' },
  { label: 'Transport — routes, buses, ridership', script: 'seed-transport.ts' },
  { label: 'Food service — menus, POS, allergens', script: 'seed-food-service.ts' },
  { label: 'Facilities — buildings, work orders', script: 'seed-facilities.ts' },
  { label: 'IT — devices, licences, vault', script: 'seed-it.ts' },
  { label: 'Curriculum + standards', script: 'seed-curriculum.ts' },
  { label: 'Portfolio — student-owned achievements', script: 'seed-portfolio.ts' },
  { label: 'Publications', script: 'seed-publications.ts' },
  { label: 'Finance — chart of accounts, GL, AP', script: 'seed-finance.ts' },
  { label: 'Procurement — requisitions, POs, vendors', script: 'seed-procurement.ts' },
  { label: 'Store — products, orders, inventory', script: 'seed-store.ts' },
  { label: 'Analytics — read models', script: 'seed-analytics.ts' },
  { label: 'DPO — governance + compliance', script: 'seed-dpo.ts' },
  { label: 'Visitors — kiosk, banned persons, muster (P2C1)', script: 'seed-visitors.ts' },
  {
    label: 'Incident & Emergency — declarations, accountability, drills (P2C2)',
    script: 'seed-incident.ts',
  },
  {
    label: 'Health Advanced — telehealth, immunisation compliance, screening referrals (P2C3)',
    script: 'seed-health-advanced.ts',
  },
  {
    label: 'Payroll — pay grades, salary scales, pay periods, payroll records (P2C4 sub-cycle a)',
    script: 'seed-payroll.ts',
  },
  {
    label:
      'Recruitment — job postings, applications, panels, interviews, offers (P2C4 sub-cycle b)',
    script: 'seed-recruitment.ts',
  },
  {
    label: 'Training — programmes, events, completions, certifications (P2C4 sub-cycle c)',
    script: 'seed-training.ts',
  },
  {
    label: 'Appraisals — frameworks, cycles, goals, expense claims (P2C4 sub-cycle c)',
    script: 'seed-appraisals.ts',
  },
  {
    label: 'Enrolment Advanced — tours, withdrawal, re-enrolment, mid-year admission (P2-5)',
    script: 'seed-enrolment-advanced.ts',
  },
  {
    label: 'Payments Advanced — financial aid, lunch accounts, billing ops (P2-6)',
    script: 'seed-payments-advanced.ts',
  },
  {
    label: 'Athletics Advanced — equipment, conferences, media (P2-8a)',
    script: 'seed-athletics-advanced-a.ts',
  },
  {
    label: 'Athletics Advanced — streaming, officials, recruiting (P2-8b)',
    script: 'seed-athletics-advanced-b.ts',
  },
  {
    label: 'Food Service Advanced — recipes, inventory, transfers, staff meals (P2-10a)',
    script: 'seed-food-service-advanced.ts',
  },
  {
    label: 'Food Service Advanced — preorders, production reports (P2-10b)',
    script: 'seed-food-service-advanced-b.ts',
  },
];

async function main(): Promise<void> {
  const packageRoot = resolve(__dirname, '..');
  console.log('CampusOS — full demo seed (' + SEED_STEPS.length + ' steps)');
  console.log('');

  const startedAt = Date.now();
  for (let i = 0; i < SEED_STEPS.length; i++) {
    const step = SEED_STEPS[i]!;
    const idx = String(i + 1).padStart(2, ' ');
    console.log('▶ [' + idx + '/' + SEED_STEPS.length + '] ' + step.label);
    const stepStarted = Date.now();
    try {
      execSync('tsx src/' + step.script, {
        cwd: packageRoot,
        stdio: 'inherit',
        env: process.env,
      });
    } catch (e: unknown) {
      console.error('');
      console.error('✗ Seed step failed: ' + step.script);
      console.error('  Re-run `pnpm db:seed` after fixing the underlying issue.');
      console.error('  Earlier idempotent steps will skip; the failed step will retry.');
      process.exit(1);
    }
    const stepMs = Date.now() - stepStarted;
    console.log('  ✓ ' + step.script + ' (' + stepMs + 'ms)');
    console.log('');
  }

  const totalMs = Date.now() - startedAt;
  console.log(
    'Demo seed complete (' + SEED_STEPS.length + ' steps in ' + Math.round(totalMs / 1000) + 's).',
  );
}

main().catch((e: unknown) => {
  console.error('seed-all failed:', e);
  process.exit(1);
});
