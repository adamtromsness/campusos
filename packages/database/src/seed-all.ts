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
  { label: 'school_config + school_feature_flags (P2-H2)', script: 'seed-config.ts' },
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
  {
    label: 'Facilities Advanced (P2-18a) — cleaning routes, stocktakes, work order depth',
    script: 'seed-facilities-advanced-a.ts',
  },
  {
    label: 'Facilities Advanced (P2-18b) — fire drills, assets, energy, space utilisation',
    script: 'seed-facilities-advanced-b.ts',
  },
  { label: 'IT — devices, licences, vault', script: 'seed-it.ts' },
  { label: 'Curriculum + standards', script: 'seed-curriculum.ts' },
  { label: 'Portfolio — student-owned achievements', script: 'seed-portfolio.ts' },
  { label: 'Publications', script: 'seed-publications.ts' },
  { label: 'Finance — chart of accounts, GL, AP', script: 'seed-finance.ts' },
  { label: 'Procurement — requisitions, POs, vendors', script: 'seed-procurement.ts' },
  { label: 'Store — products, orders, inventory', script: 'seed-store.ts' },
  { label: 'Analytics — read models', script: 'seed-analytics.ts' },
  {
    label: 'Analytics Operations — P2-15a read models (procurement/store/fds/trn/fac/tech/lib)',
    script: 'seed-analytics-operations.ts',
  },
  {
    label:
      'Analytics Engagement — P2-15b read models (enr/ath/officials/grp/pub/clubs/comms/wellbeing)',
    script: 'seed-analytics-engagement.ts',
  },
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
  {
    label: 'Transportation Advanced — fleet maintenance, fuel, driver hours (P2-11a)',
    script: 'seed-transport-advanced.ts',
  },
  {
    label: 'Transportation Advanced — route generation, ad-hoc trips, contracted routes (P2-11b)',
    script: 'seed-transport-advanced-b.ts',
  },
  {
    label: 'Transportation Advanced — GPS telemetry, geofences, fleet dashboard (P2-11c)',
    script: 'seed-transport-advanced-c.ts',
  },
  {
    label: 'Events & Ticketing — events, tiers, orders, tickets, scans, season passes (P2-12)',
    script: 'seed-events.ts',
  },
  {
    label: 'SIS Advanced A — student profiles, custom fields, parent updates (P2-13a)',
    script: 'seed-sis-advanced-a.ts',
  },
  {
    label: 'SIS Advanced B — graduation requirements, service learning, GPA (P2-13b)',
    script: 'seed-sis-graduation.ts',
  },
  {
    label: 'SIS Advanced C — transcripts, transfers, lockers, reporting periods (P2-13c)',
    script: 'seed-sis-advanced-c.ts',
  },
  {
    label: 'Behaviour Advanced — RJ conferences + peer mediation + positive points (P2-14)',
    script: 'seed-behaviour-advanced.ts',
  },
  {
    label: 'Scheduling Advanced — rotation cycles + schedule generation + subject choices (P2-17a)',
    script: 'seed-scheduling-advanced.ts',
  },
  {
    label: 'Scheduling Advanced — exams + co-teaching + pull-out + cross-school + cover (P2-17b)',
    script: 'seed-scheduling-advanced-b.ts',
  },
  {
    label: 'Communications Advanced — translations + templates + broadcast segments (P2-19a)',
    script: 'seed-communications-advanced.ts',
  },
  {
    label: 'Moderation + Push Campaigns — three-tier rules + appeals + push (P2-19b)',
    script: 'seed-moderation-push.ts',
  },
  {
    label: 'Community Exchange — profiles + listings + transactions + ratings (P2-21c)',
    script: 'seed-community.ts',
  },
  {
    label: 'Alumni — profiles + tags + campaigns + donations + news + reunions + events (P2-22a)',
    script: 'seed-alumni.ts',
  },
  {
    label:
      'Accreditation — platform frameworks (AdvancED, IB MYP, CIS) + Lincoln adoption + evidence + ratings + action plans + site visit (P2-23a)',
    script: 'seed-accreditation.ts',
  },
  {
    label:
      'Parent Engagement — conference events + slots + bookings + engagement scores + parent survey (P2-24a)',
    script: 'seed-engagement.ts',
  },
  {
    label:
      'Library Advanced — reading lists + class sets + recommendations + ILL + catalogue import (P2-25a)',
    script: 'seed-library-advanced.ts',
  },
  {
    label:
      'Publications Templates (Platform) — system templates seeded once across all tenants (P2-26 Step 7)',
    script: 'seed-publications-templates-platform.ts',
  },
  {
    label:
      'Publications Advanced — version history + custom templates + scheduled publish + analytics (P2-26)',
    script: 'seed-publications-advanced.ts',
  },
  {
    label:
      'Portfolio Advanced — sections + reflections + endorsements + readiness pathways + college apps + resume (P2-27)',
    script: 'seed-portfolio-advanced.ts',
  },
  {
    label:
      'Commerce Bundle — vendor catalogues + contracts + departmental budgets + budget transfers + journal entry batches (P2-29a)',
    script: 'seed-commerce.ts',
  },
  {
    // Last step — populates platform_personas + David-Chen-as-Maya's-
    // parent LINKED family_child row for the 7 demo users. Must run
    // after seed-iam (role grants) + seed-sis (Maya's iam_person) +
    // seed-hr (Sarah/James/Linda/Marcus hr_employees rows). The
    // PersonaResolutionService at runtime would re-derive the same
    // rows on the next /auth/me, but seeding them eagerly is friendly:
    // a demo login lands straight on the launchpad instead of bouncing
    // through /getting-started while the cache rebuilds.
    label: 'Personas — platform_personas + Chen family_child for the 7 demo users',
    script: 'seed-personas.ts',
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
