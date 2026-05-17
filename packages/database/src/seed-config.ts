import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/**
 * P2-H2 Step 4 — seed school_config + school_feature_flags rows.
 *
 * The BLOCKING audit finding was that these two tables existed in
 * schema but had no seed data, so cycles that read from them (e.g.
 * Cycle 24 Engagement weights, Cycle 12 Library recommendation
 * weights, Cycle 30 DPO breach escalation thresholds) fell back to
 * service-layer defaults silently. With this seed, the demo tenant
 * has explicit config rows exercising every documented key.
 *
 * Both tables are SCHOOL-SCOPED (single config row per key per
 * school) so the demo seed lands a single row per key in tenant_demo.
 * `UNIQUE (config_key)` / `UNIQUE (flag_key)` is the dedup gate.
 *
 * Idempotent: gated on whether school_config already has the seed
 * keys. Re-running skips cleanly.
 */

const TENANT_SCHEMA = 'tenant_demo';

interface ConfigRow {
  key: string;
  value: Record<string, unknown>;
  description: string;
}

interface FlagRow {
  key: string;
  isEnabled: boolean;
  config: Record<string, unknown>;
  description: string;
}

const CONFIG_ROWS: ConfigRow[] = [
  // ── Engagement (Cycle 24 + P2-H1 Step 5) ──
  {
    key: 'engagement_score_weights',
    value: { attendance: 20, communication: 25, conference: 25, volunteer: 15, payment: 15 },
    description:
      'Per-component weights for the family engagement composite score. Must sum to 100. P2-H1 Step 5 restricts per-component visibility to ENG-001:admin.',
  },
  {
    key: 'engagement_level_thresholds',
    value: { highlyEngaged: 75, engaged: 50, minimal: 25 },
    description:
      'Composite-score thresholds for engagement level resolution: HIGHLY_ENGAGED >= 75, ENGAGED >= 50, MINIMAL >= 25, AT_RISK < 25.',
  },
  {
    key: 'engagement_score_purpose',
    value: {
      purpose: 'family_outreach',
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy: 'demo_school_admin',
      forbiddenUses: ['admissions_decisions', 'discipline_decisions', 'financial_aid_decisions'],
    },
    description:
      'P2-H1 Step 5 — school acknowledgement that engagement scores are for family-outreach planning only. Phase 2 hardening required schools to record purpose explicitly before component view is enabled.',
  },
  // ── Library (Cycle 25 P2C25 carry-over → P2-H2 baseline) ──
  {
    key: 'library_recommendation_weights',
    value: {
      collaborative_filtering: 30,
      reading_level_match: 25,
      subject_match: 20,
      new_arrival: 15,
      staff_pick: 10,
    },
    description: 'P2-25 Cycle 25 recommendation strategy weights. Must sum to 100 (±0.5).',
  },
  // ── DPO / breach (Cycle 30) ──
  {
    key: 'breach_escalation_thresholds',
    value: {
      auto_escalate_to_supervisory_authority_after_hours: 70,
      ic_review_after_hours: 24,
      dpo_review_after_hours: 4,
      page_dpo_on_severity: ['HIGH', 'CRITICAL'],
    },
    description:
      'Cycle 30 M120 breach response. The 72h Article 33 supervisory-authority deadline backs the auto-escalation threshold; the others gate downstream paging.',
  },
  // ── SAR (Cycle 30) ──
  {
    key: 'sar_default_deadline_days',
    value: { gdpr: 30, ferpa: 45 },
    description:
      'Cycle 30 SAR processing deadlines. GDPR Article 12: 30 days. FERPA inspection-and-review: 45 days. Service uses the higher value when both regimes apply.',
  },
  // ── Wellbeing (Cycle 11.1) ──
  {
    key: 'wellbeing_alert_thresholds',
    value: {
      scale_1_5_self_harm_value: 1,
      scale_1_5_feels_unsafe_value: 2,
      scale_1_10_feels_unsafe_max: 2,
      auto_escalate_alert_types: ['SELF_HARM_INDICATOR'],
    },
    description:
      'Cycle 11.1 wellbeing check-in alert evaluation. SELF_HARM_INDICATOR is unconditionally auto-escalated; FEELS_UNSAFE pages but does not escalate.',
  },
  // ── Transport (Cycle 19) ──
  {
    key: 'no_show_alert_window_minutes',
    value: { afternoonAlertAfterMinutes: 15, morningAlertAfterMinutes: 10 },
    description:
      'Cycle 19 NoShowService alert thresholds. AM and PM use different windows because PM ridership patterns vary more.',
  },
  // ── Engagement payment-component toggle (P2-H1 Step 5 carry-over) ──
  {
    key: 'engagement_payment_component_enabled',
    value: { enabled: true },
    description:
      'P2-H1 Step 5 — schools may disable the payment-component contribution to engagement scores if local policy treats payment behaviour as too sensitive. Default true preserves legacy behaviour.',
  },
  // ── School-size preset (P2-H4 Step 5 ADV-07) ──
  {
    key: 'school_size_preset',
    value: {
      preset: 'STANDARD',
      hideAdvancedFinance: false,
      hideComplexProcurement: false,
      hideAiMinutes: false,
      hideAccreditation: false,
      hideAdvancedAnalytics: false,
    },
    description:
      'P2-H4 ADV-07 — UI navigation visibility preset. Values MICRO/SMALL/STANDARD/ADVANCED. MICRO/SMALL hide advanced finance, complex procurement, AI minutes, accreditation, advanced analytics in launchpad + sidebar — features remain reachable via direct URL. Backend permissions are unchanged.',
  },
];

const FLAG_ROWS: FlagRow[] = [
  {
    key: 'enrolment_public_search_enabled',
    isEnabled: true,
    config: { radius_miles_default: 25, radius_miles_max: 100 },
    description:
      'Phase 2 Parent Polish — public unauthenticated /find-schools route. Schools can opt out per tenant via this flag.',
  },
  {
    key: 'payment_integration_stripe_live',
    isEnabled: false,
    config: { reason: 'dev_demo_mode_uses_stubbed_pi_dev_uuid_intents' },
    description:
      'Cycle 6 + P2-H3 — flip to true when a school has completed Stripe onboarding. Today every demo payment is a pi_dev_<uuid> stub.',
  },
  {
    key: 'ai_tutoring_enabled',
    isEnabled: true,
    config: { quota_daily_tokens: 100000, quota_fail_closed: false },
    description:
      'P2-7c Cycle 7 AI tutoring. quota_fail_closed=true flips Redis-based per-tenant rate limit from fail-OPEN to fail-CLOSED on Redis outage (production-recommended).',
  },
  {
    key: 'guardian_health_access_strict',
    isEnabled: false,
    config: {
      require_full_portal_scope: true,
      require_custody_or_emergency: true,
    },
    description:
      'P2-H1 Step 3 — when enabled, GuardianAuthorizationService.canViewHealthRecord requires FULL scope AND custody OR emergency contact. Default OFF preserves the current seed behaviour where every guardian sees their child health record; production schools that narrow guardian access enable this.',
  },
];

async function seedConfig(): Promise<void> {
  const client = getPlatformClient();

  await client.$executeRawUnsafe('SET search_path TO "' + TENANT_SCHEMA + '", platform, public');

  const existingRows = (await client.$queryRawUnsafe(
    'SELECT config_key FROM school_config WHERE config_key = ANY($1::text[])',
    CONFIG_ROWS.map((r) => r.key),
  )) as Array<{ config_key: string }>;
  const existingKeys = new Set(existingRows.map((r) => r.config_key));

  let configInserted = 0;
  for (const row of CONFIG_ROWS) {
    if (existingKeys.has(row.key)) continue;
    await client.$executeRawUnsafe(
      'INSERT INTO school_config (id, config_key, config_value, description) VALUES ($1::uuid, $2, $3::jsonb, $4)',
      generateId(),
      row.key,
      JSON.stringify(row.value),
      row.description,
    );
    configInserted++;
  }

  const existingFlags = (await client.$queryRawUnsafe(
    'SELECT flag_key FROM school_feature_flags WHERE flag_key = ANY($1::text[])',
    FLAG_ROWS.map((r) => r.key),
  )) as Array<{ flag_key: string }>;
  const existingFlagKeys = new Set(existingFlags.map((r) => r.flag_key));

  let flagsInserted = 0;
  for (const row of FLAG_ROWS) {
    if (existingFlagKeys.has(row.key)) continue;
    await client.$executeRawUnsafe(
      'INSERT INTO school_feature_flags (id, flag_key, is_enabled, config, enabled_at) VALUES ($1::uuid, $2, $3, $4::jsonb, now())',
      generateId(),
      row.key,
      row.isEnabled,
      JSON.stringify(row.config),
    );
    flagsInserted++;
  }

  await client.$executeRawUnsafe('SET search_path TO platform, public');

  console.log(
    `[seed:config] school_config: +${configInserted} new (${existingKeys.size} already present); school_feature_flags: +${flagsInserted} new (${existingFlagKeys.size} already present)`,
  );
}

async function main(): Promise<void> {
  try {
    await seedConfig();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error('[seed:config] failed:', err);
  process.exit(1);
});
