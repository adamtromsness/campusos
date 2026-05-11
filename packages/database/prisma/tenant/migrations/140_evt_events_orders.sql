/*
 * 140_evt_events_orders.sql — Phase 2 Cycle 12 sub-cycle a (P2-12a).
 *
 * M101 Events and Ticketing — 5 base tables in this migration. The
 * P2-12 cycle ships 9 tables total across 140 plus 141.
 *
 *   evt_events            School event header. 8-value event_type
 *                         CHECK (ATHLETIC_GAME PERFORMANCE DANCE
 *                         FUNDRAISER GRADUATION ASSEMBLY COMMUNITY
 *                         OTHER). 5-value status lifecycle (DRAFT
 *                         then ON_SALE then SOLD_OUT or COMPLETED
 *                         or CANCELLED). total_tier_quantity is a
 *                         denormalised running total maintained at
 *                         the service layer inside the same tenant
 *                         tx as every evt_ticket_tiers INSERT or
 *                         UPDATE or DELETE because the tenant
 *                         provisioner SQL splitter cuts on every
 *                         semicolon regardless of quoting context
 *                         and a DB trigger function body cannot be
 *                         expressed without internal semicolons.
 *                         The CHECK constraint event_capacity_chk
 *                         (total_capacity IS NULL OR
 *                         total_tier_quantity less than or equal
 *                         to total_capacity) is the schema-side
 *                         belt-and-braces so a service-layer bug
 *                         cannot oversell at the venue level.
 *                         INDEX(school_id event_date status) backs
 *                         the public calendar hot path.
 *   evt_ticket_tiers      Per-event ticket pricing tier. ATOMIC
 *                         SALE keystone — UPDATE
 *                         SET quantity_sold equals quantity_sold
 *                         plus qty WHERE id equals tier_id AND
 *                         quantity_sold plus qty less than or
 *                         equal to quantity. NEVER select then
 *                         update. Zero rows matched equals 409
 *                         Sold Out. quantity_sold INT NOT NULL
 *                         DEFAULT 0 with a non-negative CHECK
 *                         plus the column-level sold_chk that
 *                         quantity_sold less than or equal to
 *                         quantity. Partial INDEX on
 *                         (event_id sale_starts_at sale_ends_at)
 *                         WHERE is_active equals true for the
 *                         on-sale-now filter.
 *   evt_orders            Per-purchase order. 4-value status
 *                         lifecycle (PENDING then CONFIRMED or
 *                         CANCELLED or REFUNDED). PENDING orders
 *                         carry expires_at and are swept by the
 *                         OrderExpiryWorker every 5 minutes —
 *                         expiry path cancels the order plus
 *                         decrements every linked tier.quantity_sold
 *                         plus cancels the Stripe PaymentIntent.
 *                         Partial INDEX on expires_at WHERE status
 *                         equals PENDING is the worker hot path.
 *                         Multi-column confirmed_chk plus
 *                         cancelled_chk lockstep keeps the
 *                         timestamps consistent with status.
 *   evt_tickets           Per-ticket QR code holder. qr_code_token
 *                         TEXT NOT NULL UNIQUE is the scannable
 *                         identifier. ATOMIC GATE SCAN keystone —
 *                         UPDATE SET status equals USED
 *                         scanned_at equals now() WHERE
 *                         qr_code_token equals token AND status
 *                         equals VALID. Zero rows matched means
 *                         the ticket was already scanned or the
 *                         token is invalid. 4-value status CHECK
 *                         (VALID USED CANCELLED REFUNDED).
 *                         INDEX(qr_code_token) backs the gate
 *                         scan hot path.
 *   evt_refunds           Per-refund audit. amount must be
 *                         positive. reason TEXT NOT NULL — admin
 *                         must justify every refund. On INSERT
 *                         the service flips the parent order to
 *                         REFUNDED, every linked ticket to
 *                         REFUNDED, and decrements
 *                         tier.quantity_sold for each ticket all
 *                         inside one tenant tx. Emits
 *                         evt.refund.issued for the Cycle 26
 *                         GLConsumer to post the refund journal
 *                         entry.
 *
 * Soft FKs to platform.iam_person plus ath_games plus fac_spaces
 * per ADR-001 and ADR-020 are not enforced at the schema layer.
 * DB-enforced FKs to evt_events use ON DELETE CASCADE on the tier
 * link because a tier has no meaning without its event. DB-enforced
 * FKs to evt_orders use ON DELETE CASCADE on the ticket and refund
 * link because tickets and refunds carry no audit value past the
 * order being hard-deleted (and orders are not hard-deleted in
 * production — CANCELLED is the soft path).
 *
 * No semicolons inside string literals or block comments. The
 * tenant provisioner splits the migration on every semicolon
 * regardless of quoting context.
 */

CREATE TABLE IF NOT EXISTS evt_events (
  id                       UUID PRIMARY KEY,
  school_id                UUID NOT NULL,
  title                    TEXT NOT NULL,
  description              TEXT,
  event_type               TEXT NOT NULL,
  event_date               DATE NOT NULL,
  start_time               TIME NOT NULL,
  end_time                 TIME,
  venue_id                 UUID,
  venue_name               TEXT,
  total_capacity           INT,
  total_tier_quantity      INT NOT NULL DEFAULT 0,
  linked_game_id           UUID,
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  created_by               UUID NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_events_type_chk CHECK (
    event_type IN ('ATHLETIC_GAME','PERFORMANCE','DANCE','FUNDRAISER','GRADUATION','ASSEMBLY','COMMUNITY','OTHER')
  ),
  CONSTRAINT evt_events_status_chk CHECK (
    status IN ('DRAFT','ON_SALE','SOLD_OUT','COMPLETED','CANCELLED')
  ),
  CONSTRAINT evt_events_capacity_chk CHECK (
    total_capacity IS NULL OR total_capacity > 0
  ),
  CONSTRAINT evt_events_tier_total_chk CHECK (
    total_tier_quantity >= 0
  ),
  CONSTRAINT evt_events_venue_capacity_chk CHECK (
    total_capacity IS NULL OR total_tier_quantity <= total_capacity
  ),
  CONSTRAINT evt_events_window_chk CHECK (
    end_time IS NULL OR end_time > start_time
  )
);

CREATE INDEX IF NOT EXISTS evt_events_school_date_status_idx
  ON evt_events(school_id, event_date, status);

CREATE INDEX IF NOT EXISTS evt_events_linked_game_idx
  ON evt_events(linked_game_id) WHERE linked_game_id IS NOT NULL;

COMMENT ON TABLE evt_events IS
  'School event header. 8-value event_type CHECK plus 5-value status lifecycle. total_tier_quantity is denormalised and maintained at the service layer inside every tier write tx because the tenant provisioner splits on every semicolon and cannot host a trigger function body. The venue_capacity_chk constraint catches any service-layer drift at write time.';

COMMENT ON COLUMN evt_events.linked_game_id IS
  'Soft FK to ath_games(id) per ADR-001 and ADR-020 for ATHLETIC_GAME events. Step 9 auto-populates the comp list from the linked games roster.';

COMMENT ON COLUMN evt_events.venue_id IS
  'Soft FK to fac_spaces(id) per ADR-001 and ADR-020. venue_name is the free-text fallback when the venue is off-campus or fac_spaces has not been provisioned.';

CREATE TABLE IF NOT EXISTS evt_ticket_tiers (
  id                  UUID PRIMARY KEY,
  event_id            UUID NOT NULL,
  name                TEXT NOT NULL,
  price               NUMERIC(8,2) NOT NULL,
  quantity            INT NOT NULL,
  quantity_sold       INT NOT NULL DEFAULT 0,
  sale_starts_at      TIMESTAMPTZ,
  sale_ends_at        TIMESTAMPTZ,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_tiers_event_fk FOREIGN KEY (event_id)
    REFERENCES evt_events(id) ON DELETE CASCADE,
  CONSTRAINT evt_tiers_price_chk CHECK (price >= 0),
  CONSTRAINT evt_tiers_quantity_chk CHECK (quantity > 0),
  CONSTRAINT evt_tiers_sold_chk CHECK (quantity_sold >= 0 AND quantity_sold <= quantity),
  CONSTRAINT evt_tiers_window_chk CHECK (
    sale_ends_at IS NULL OR sale_starts_at IS NULL OR sale_ends_at > sale_starts_at
  )
);

CREATE INDEX IF NOT EXISTS evt_tiers_event_idx
  ON evt_ticket_tiers(event_id);

CREATE INDEX IF NOT EXISTS evt_tiers_active_window_idx
  ON evt_ticket_tiers(event_id, sale_starts_at, sale_ends_at) WHERE is_active = true;

COMMENT ON TABLE evt_ticket_tiers IS
  'Per-event ticket pricing tier. ATOMIC SALE keystone — UPDATE SET quantity_sold equals quantity_sold plus qty WHERE id equals tier_id AND quantity_sold plus qty less than or equal to quantity. Zero rows matched equals 409 Sold Out. NEVER select then update. The sold_chk column-level invariant means a Postgres-level violation can never sell beyond capacity even if the service-layer math drifts.';

COMMENT ON COLUMN evt_ticket_tiers.quantity_sold IS
  'Total tickets sold across all CONFIRMED and PENDING orders. Decremented on order CANCEL or REFUND. Maintained inside tenant tx by the OrderService atomic UPDATE WHERE clause.';

CREATE TABLE IF NOT EXISTS evt_orders (
  id                          UUID PRIMARY KEY,
  event_id                    UUID NOT NULL,
  purchaser_id                UUID NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'PENDING',
  total_amount                NUMERIC(8,2) NOT NULL,
  stripe_payment_intent_id    TEXT,
  expires_at                  TIMESTAMPTZ,
  confirmed_at                TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  cancellation_reason         TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_orders_event_fk FOREIGN KEY (event_id)
    REFERENCES evt_events(id) ON DELETE CASCADE,
  CONSTRAINT evt_orders_status_chk CHECK (
    status IN ('PENDING','CONFIRMED','CANCELLED','REFUNDED')
  ),
  CONSTRAINT evt_orders_amount_chk CHECK (total_amount >= 0),
  CONSTRAINT evt_orders_confirmed_chk CHECK (
    (status IN ('PENDING','CANCELLED') AND confirmed_at IS NULL)
    OR (status IN ('CONFIRMED','REFUNDED') AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT evt_orders_cancelled_chk CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL)
    OR (status <> 'CANCELLED' AND (cancelled_at IS NULL OR status = 'REFUNDED'))
  )
);

CREATE INDEX IF NOT EXISTS evt_orders_event_status_idx
  ON evt_orders(event_id, status);

CREATE INDEX IF NOT EXISTS evt_orders_purchaser_idx
  ON evt_orders(purchaser_id, created_at DESC);

CREATE INDEX IF NOT EXISTS evt_orders_pending_expiry_idx
  ON evt_orders(expires_at) WHERE status = 'PENDING';

COMMENT ON TABLE evt_orders IS
  'Per-purchase order. 4-value status lifecycle (PENDING then CONFIRMED or CANCELLED or REFUNDED). PENDING orders carry expires_at and are swept every 5 minutes by the OrderExpiryWorker. Expiry path runs inside a tenant tx — cancels the order then decrements every linked tier.quantity_sold then cancels the Stripe PaymentIntent. Multi-column confirmed_chk plus cancelled_chk lockstep enforces timestamp consistency with status.';

COMMENT ON COLUMN evt_orders.purchaser_id IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. The purchaser is the buyer of record — receives the QR tickets and is the only person who can request a refund through the parent surface.';

CREATE TABLE IF NOT EXISTS evt_tickets (
  id                UUID PRIMARY KEY,
  order_id          UUID NOT NULL,
  tier_id           UUID NOT NULL,
  holder_name       TEXT,
  qr_code_token     TEXT NOT NULL UNIQUE,
  status            TEXT NOT NULL DEFAULT 'VALID',
  scanned_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_tickets_order_fk FOREIGN KEY (order_id)
    REFERENCES evt_orders(id) ON DELETE CASCADE,
  CONSTRAINT evt_tickets_tier_fk FOREIGN KEY (tier_id)
    REFERENCES evt_ticket_tiers(id) ON DELETE RESTRICT,
  CONSTRAINT evt_tickets_status_chk CHECK (
    status IN ('VALID','USED','CANCELLED','REFUNDED')
  ),
  CONSTRAINT evt_tickets_scanned_chk CHECK (
    (status = 'USED' AND scanned_at IS NOT NULL)
    OR (status <> 'USED' AND scanned_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS evt_tickets_qr_token_idx
  ON evt_tickets(qr_code_token);

CREATE INDEX IF NOT EXISTS evt_tickets_order_idx
  ON evt_tickets(order_id);

CREATE INDEX IF NOT EXISTS evt_tickets_tier_status_idx
  ON evt_tickets(tier_id, status);

COMMENT ON TABLE evt_tickets IS
  'Per-ticket QR-code holder. qr_code_token TEXT NOT NULL UNIQUE is the scannable identifier. ATOMIC GATE SCAN keystone — UPDATE SET status equals USED scanned_at equals now() WHERE qr_code_token equals token AND status equals VALID. Zero rows matched means already scanned or invalid token. The scanned_chk multi-column lockstep keeps scanned_at populated only when status equals USED.';

COMMENT ON COLUMN evt_tickets.qr_code_token IS
  'Cryptographically random token rendered as the QR code payload. Generated by OrderService via crypto.randomBytes(24).toString(hex) so each ticket has a 48-character hex identifier unique within the tenant.';

CREATE TABLE IF NOT EXISTS evt_refunds (
  id                  UUID PRIMARY KEY,
  order_id            UUID NOT NULL,
  refund_amount       NUMERIC(8,2) NOT NULL,
  reason              TEXT NOT NULL,
  stripe_refund_id    TEXT,
  refunded_by         UUID NOT NULL,
  refunded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evt_refunds_order_fk FOREIGN KEY (order_id)
    REFERENCES evt_orders(id) ON DELETE CASCADE,
  CONSTRAINT evt_refunds_amount_chk CHECK (refund_amount > 0)
);

CREATE INDEX IF NOT EXISTS evt_refunds_order_idx
  ON evt_refunds(order_id);

CREATE INDEX IF NOT EXISTS evt_refunds_refunded_at_idx
  ON evt_refunds(refunded_at DESC);

COMMENT ON TABLE evt_refunds IS
  'Per-refund audit. amount must be positive. reason is required — admin must justify every refund. On INSERT the RefundService flips parent order to REFUNDED, linked tickets to REFUNDED, decrements tier.quantity_sold for each ticket all inside one tenant tx. Emits evt.refund.issued for the Cycle 26 GLConsumer to post the refund journal entry.';

COMMENT ON COLUMN evt_refunds.refunded_by IS
  'Soft FK to platform.iam_person(id) per ADR-001 and ADR-020. Identifies the admin who issued the refund for audit. Required so a refund row can never land without an authoriser.';
