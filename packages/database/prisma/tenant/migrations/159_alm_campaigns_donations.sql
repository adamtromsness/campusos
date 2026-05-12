/*
 * 159_alm_campaigns_donations.sql — P2-22a Step 2.
 *
 * Alumni Module (M102) continued. Fundraising campaigns with
 * multi-currency donation tracking and campaign recipient outreach
 * funnel.
 *
 *   alm_campaigns               Fundraising campaign header. 4 value
 *                               status CHECK DRAFT / ACTIVE /
 *                               COMPLETED / CANCELLED. goal_amount in
 *                               reporting_currency (default USD).
 *                               created_by is a soft ref to
 *                               platform.iam_person per ADR-001/020.
 *                               Emits alm.campaign.activated on
 *                               DRAFT to ACTIVE transition.
 *
 *   alm_donations               Multi-currency donation record. The
 *                               schema stores both the original amount
 *                               plus currency and the converted
 *                               amount_in_reporting_currency at the
 *                               FX rate (fx_rate_at_donation) from the
 *                               payment processor at charge time. The
 *                               Step 5 DonationService computes
 *                               amount_in_reporting_currency BEFORE
 *                               insert. Campaign totals SUM the
 *                               reporting_currency column, cached in
 *                               Redis campaign:raised:{campaign_id}
 *                               TTL 5 minutes. is_anonymous=true
 *                               hides the donor from public campaign
 *                               pages but keeps donor_alumni_id
 *                               visible to admin. Emits
 *                               alm.donation.received.
 *
 *   alm_campaign_recipients     Per-(campaign, alumni) outreach row.
 *                               UNIQUE(campaign_id, alumni_id).
 *                               6 value outreach_status CHECK
 *                               PENDING / SENT / OPENED / RESPONDED
 *                               / DONATED / UNSUBSCRIBED — the
 *                               funnel that the Step 5 service rolls
 *                               up for the campaign dashboard.
 *
 * FK summary (intra-tenant only, 0 cross-schema FK constraints):
 *   alm_donations.campaign_id          alm_campaigns(id) ON DELETE CASCADE
 *   alm_donations.donor_alumni_id      alm_alumni_profiles(id) NO ACTION
 *   alm_campaign_recipients.campaign_id  alm_campaigns(id) ON DELETE CASCADE
 *   alm_campaign_recipients.alumni_id    alm_alumni_profiles(id) ON DELETE CASCADE
 *
 * Splitter discipline — no semicolons inside string literals, default
 * expressions, COMMENT bodies, CHECK predicates, or block comments.
 * Idempotent — safe to re-run.
 */


CREATE TABLE IF NOT EXISTS alm_campaigns (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  description              TEXT,
  goal_amount              NUMERIC(10,2),
  reporting_currency       CHAR(3) NOT NULL DEFAULT 'USD',
  start_date               DATE,
  end_date                 DATE,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  created_by               UUID NOT NULL,
  activated_at             TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_campaigns_status_chk CHECK (
    status IN ('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED')
  ),
  CONSTRAINT alm_campaigns_goal_chk CHECK (
    goal_amount IS NULL OR goal_amount >= 0
  ),
  CONSTRAINT alm_campaigns_dates_chk CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT alm_campaigns_currency_chk CHECK (
    reporting_currency ~ '^[A-Z]{3}$'
  )
);

CREATE INDEX IF NOT EXISTS alm_campaigns_status_idx
  ON alm_campaigns (school_id, status);

CREATE INDEX IF NOT EXISTS alm_campaigns_active_idx
  ON alm_campaigns (school_id, end_date)
  WHERE status = 'ACTIVE';

COMMENT ON TABLE alm_campaigns IS
  'P2-22a — Fundraising campaign header. 4 value status CHECK plus multi-column nullable date range. reporting_currency is the canonical currency for goal_amount and the SUM(amount_in_reporting_currency) over linked donations. Emits alm.campaign.activated AFTER tx commit on DRAFT to ACTIVE.';


CREATE TABLE IF NOT EXISTS alm_donations (
  id                          UUID PRIMARY KEY,
  campaign_id                 UUID NOT NULL,
  donor_alumni_id             UUID NOT NULL,
  amount                      NUMERIC(10,2) NOT NULL,
  currency                    CHAR(3) NOT NULL DEFAULT 'USD',
  fx_rate_at_donation         NUMERIC(12,6),
  amount_in_reporting_currency NUMERIC(10,2) NOT NULL,
  payment_ref                 TEXT,
  stripe_payment_intent_id    TEXT,
  donated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_anonymous                BOOLEAN NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_donations_amount_chk CHECK (amount > 0),
  CONSTRAINT alm_donations_reporting_chk CHECK (
    amount_in_reporting_currency > 0
  ),
  CONSTRAINT alm_donations_fx_chk CHECK (
    fx_rate_at_donation IS NULL OR fx_rate_at_donation > 0
  ),
  CONSTRAINT alm_donations_currency_chk CHECK (
    currency ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT alm_donations_campaign_fk FOREIGN KEY (campaign_id)
    REFERENCES alm_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT alm_donations_donor_fk FOREIGN KEY (donor_alumni_id)
    REFERENCES alm_alumni_profiles(id)
);

CREATE INDEX IF NOT EXISTS alm_donations_campaign_idx
  ON alm_donations (campaign_id, donated_at DESC);

CREATE INDEX IF NOT EXISTS alm_donations_donor_idx
  ON alm_donations (donor_alumni_id, donated_at DESC);

CREATE INDEX IF NOT EXISTS alm_donations_stripe_idx
  ON alm_donations (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON TABLE alm_donations IS
  'P2-22a — Multi-currency donation. The schema stores BOTH the original amount plus currency AND the converted amount_in_reporting_currency at fx_rate_at_donation. Campaign totals SUM(amount_in_reporting_currency) and cache the result in Redis campaign:raised:{id} TTL 5min. Anonymous donations keep donor_alumni_id populated so admin can audit, public views suppress.';

COMMENT ON COLUMN alm_donations.fx_rate_at_donation IS
  'FX rate from the payment processor at charge time. amount_in_reporting_currency = amount * fx_rate_at_donation. NULL when currency equals the campaign reporting_currency (rate is implicitly 1.0).';


CREATE TABLE IF NOT EXISTS alm_campaign_recipients (
  id                       UUID PRIMARY KEY,
  campaign_id              UUID NOT NULL,
  alumni_id                UUID NOT NULL,
  outreach_status          TEXT NOT NULL DEFAULT 'PENDING',
  sent_at                  TIMESTAMPTZ,
  opened_at                TIMESTAMPTZ,
  responded_at             TIMESTAMPTZ,
  donated_at               TIMESTAMPTZ,
  unsubscribed_at          TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alm_campaign_recipients_uq UNIQUE (campaign_id, alumni_id),
  CONSTRAINT alm_campaign_recipients_status_chk CHECK (
    outreach_status IN (
      'PENDING', 'SENT', 'OPENED', 'RESPONDED', 'DONATED', 'UNSUBSCRIBED'
    )
  ),
  CONSTRAINT alm_campaign_recipients_campaign_fk FOREIGN KEY (campaign_id)
    REFERENCES alm_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT alm_campaign_recipients_alumni_fk FOREIGN KEY (alumni_id)
    REFERENCES alm_alumni_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS alm_campaign_recipients_campaign_idx
  ON alm_campaign_recipients (campaign_id, outreach_status);

CREATE INDEX IF NOT EXISTS alm_campaign_recipients_alumni_idx
  ON alm_campaign_recipients (alumni_id);

COMMENT ON TABLE alm_campaign_recipients IS
  'P2-22a — Per-(campaign, alumni) outreach funnel row. UNIQUE(campaign_id, alumni_id). 6 value outreach_status CHECK is the funnel state — PENDING is the seed state at bulk-add, SENT after the outreach email goes out via Cycle 14 Communications, OPENED on tracking pixel hit, RESPONDED on follow-up form submit, DONATED auto-transitions when a matching alm_donations row lands, UNSUBSCRIBED is terminal.';
