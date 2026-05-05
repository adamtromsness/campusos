/* 044_lib_circulation.sql
 * Cycle 12 Step 2 — M24 Library circulation engine (loan policies,
 * checkouts, holds, fines).
 *
 * Four new tenant base tables on top of Step 1 lib_locations + lib
 * catalogue_items + lib_catalogue_copies. The Step 6 CheckoutService
 * is the canonical writer for checkouts and the lib_catalogue_copies
 * is_available + location_status state machine on every checkout and
 * return. The Step 6 HoldService is the canonical writer for holds
 * and runs the auto-reassign logic on return that flips the oldest
 * PENDING hold to READY and walks the copy to ON_HOLD_SHELF. The
 * Step 6 FineService is the canonical writer for fines and emits
 * lib.fine.issued on every INSERT for the future Cycle 6 payment
 * integration consumer.
 *
 *   lib_checkout_policies   Per-school per-patron-type loan policy.
 *                           patron_type is a 2-value enum CHECK
 *                           STUDENT and STAFF. UNIQUE(school_id,
 *                           patron_type) so each school carries
 *                           exactly one policy per patron type. max
 *                           checkouts caps the active borrow count
 *                           the Step 6 service enforces at checkout
 *                           time. loan_period_days is the default
 *                           due-date offset. renewals_allowed is the
 *                           cap on renewal_count the Step 6 service
 *                           enforces. overdue_fine_per_day is a
 *                           NUMERIC(4,2) accommodating up to 99.99
 *                           per day. 0 marks a fine-free school.
 *
 *   lib_checkouts           One row per (copy, patron) borrow event.
 *                           patron_id is a soft UUID ref to platform
 *                           iam_person(id) per ADR-001 and ADR-020
 *                           covering both students and staff
 *                           uniformly. status is a 4-value enum
 *                           CHECK ACTIVE, RETURNED, OVERDUE, LOST.
 *                           Multi-column returned_chk keeps
 *                           returned_at in lockstep with status.
 *                           ACTIVE / OVERDUE / LOST require returned
 *                           at NULL. RETURNED requires returned_at
 *                           NOT NULL. INDEX (patron_id, checkout
 *                           date DESC) backs the my-checkouts view.
 *                           Partial INDEX WHERE returned_at IS NULL
 *                           backs the active-checkouts hot path.
 *                           Partial INDEX WHERE status='OVERDUE'
 *                           backs the overdue dashboard. The Step 6
 *                           CheckoutService.return path locks this
 *                           row and the parent copy in one tx,
 *                           stamps returned_at, computes the auto
 *                           fine if past due_date, and reassigns to
 *                           the oldest PENDING hold via the Step 6
 *                           HoldService.
 *
 *   lib_holds               Hold queue. patron_id is soft to platform
 *                           iam_person(id). status is a 5-value enum
 *                           CHECK PENDING, READY, COLLECTED,
 *                           EXPIRED, CANCELLED. PENDING is the
 *                           queue-while-no-copies state. READY
 *                           flips on a return when the oldest
 *                           PENDING hold is reassigned. COLLECTED is
 *                           terminal when the patron picks up the
 *                           reserved copy. EXPIRED is terminal when
 *                           the patron does not collect within the
 *                           grace window. CANCELLED is terminal when
 *                           the patron or the librarian cancels.
 *                           INDEX (catalogue_item_id, status) backs
 *                           the per-item hold-queue lookup. INDEX
 *                           (patron_id, status) backs the my-holds
 *                           view.
 *
 *   lib_fines               Outstanding fines. patron_id soft to
 *                           platform iam_person(id). fine_type is a
 *                           3-value enum CHECK OVERDUE, LOST,
 *                           DAMAGE. status is a 3-value enum CHECK
 *                           OUTSTANDING, PAID, WAIVED. amount is a
 *                           NUMERIC(6,2) with non-negative CHECK.
 *                           days_overdue is the integer count for
 *                           OVERDUE fines and is nullable for LOST
 *                           or DAMAGE rows. invoice_id is a soft
 *                           UUID ref to pay_invoices(id) for the
 *                           future Cycle 6 payment integration.
 *                           No DB-enforced FK to pay_invoices because
 *                           the integration may flag a fine as
 *                           payable without materialising an invoice
 *                           row immediately. INDEX(patron_id, status)
 *                           backs the my-fines view. Emits lib.fine
 *                           issued on INSERT with status OUTSTANDING.
 *
 * Soft cross-schema refs per ADR-001 / ADR-020:
 *   lib_checkout_policies.school_id  -> platform.schools(id)
 *   lib_checkouts.patron_id          -> platform.iam_person(id)
 *   lib_holds.patron_id              -> platform.iam_person(id)
 *   lib_fines.patron_id              -> platform.iam_person(id)
 *   lib_fines.invoice_id             -> tenant pay_invoices(id) optional
 *
 * DB-enforced intra-tenant FKs (3 logical):
 *   lib_checkouts.copy_id          -> lib_catalogue_copies(id) NO ACTION
 *     A checkout row is a financial audit record. Refuse hard delete
 *     of a copy that has historical checkouts. The librarian flips
 *     the copy condition to LOST or removes the catalogue item via
 *     the parent CASCADE chain only after archiving the history.
 *   lib_holds.catalogue_item_id    -> lib_catalogue_items(id) CASCADE
 *     A hold is a queue row. Holds against a hard-deleted item carry
 *     no value. The CASCADE mirrors the lib_catalogue_copies CASCADE
 *     on the same parent so the full item delete chain is clean.
 *   lib_fines.checkout_id          -> lib_checkouts(id) NO ACTION
 *     A fine is a financial record. Refuse hard delete of the parent
 *     checkout while a fine references it. The fine survives the
 *     parent checkout via the schema-side NO ACTION.
 *
 * 0 cross-schema FKs.
 *
 * Migration discipline. CREATE TABLE IF NOT EXISTS for idempotency.
 * Block comment header, no semicolons inside any string literal or
 * comment per the splitter trap from Cycles 4 through 12.
 */

CREATE TABLE IF NOT EXISTS lib_checkout_policies (
  id                      UUID         PRIMARY KEY,
  school_id               UUID         NOT NULL,
  patron_type             TEXT         NOT NULL,
  max_checkouts           INT          NOT NULL,
  loan_period_days        INT          NOT NULL,
  renewals_allowed        INT          NOT NULL,
  overdue_fine_per_day    NUMERIC(4,2) NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_policies_patron_type_chk
    CHECK (patron_type IN ('STUDENT', 'STAFF')),
  CONSTRAINT lib_policies_max_checkouts_chk
    CHECK (max_checkouts >= 0),
  CONSTRAINT lib_policies_loan_period_chk
    CHECK (loan_period_days >= 0),
  CONSTRAINT lib_policies_renewals_chk
    CHECK (renewals_allowed >= 0),
  CONSTRAINT lib_policies_fine_chk
    CHECK (overdue_fine_per_day >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS lib_policies_school_patron_uq
  ON lib_checkout_policies (school_id, patron_type);

COMMENT ON TABLE lib_checkout_policies IS
  'Per-school per-patron-type loan policy. The Step 6 CheckoutService reads this on every checkout to compute due_date from loan_period_days, gate on max_checkouts, and stamp the policy reference into auto-fine calculation on return. UNIQUE(school_id, patron_type) so each school has exactly one policy per type. STAFF and STUDENT are the two patron classes today. If the M80 Volunteer Workforce module needs a third class the CHECK can be relaxed at that time.';

COMMENT ON COLUMN lib_checkout_policies.overdue_fine_per_day IS
  'NUMERIC(4,2) — the daily fine in the school local currency. 0 marks a fine-free school. The Step 6 CheckoutService.return computes (return_date - due_date) * overdue_fine_per_day and INSERTs an OVERDUE fine when the result is positive.';

CREATE TABLE IF NOT EXISTS lib_checkouts (
  id              UUID         PRIMARY KEY,
  copy_id         UUID         NOT NULL REFERENCES lib_catalogue_copies(id),
  patron_id       UUID         NOT NULL,
  checkout_date   DATE         NOT NULL,
  due_date        DATE         NOT NULL,
  returned_at     TIMESTAMPTZ,
  renewal_count   INT          NOT NULL DEFAULT 0,
  status          TEXT         NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_checkouts_status_chk
    CHECK (status IN ('ACTIVE', 'RETURNED', 'OVERDUE', 'LOST')),
  CONSTRAINT lib_checkouts_renewal_chk
    CHECK (renewal_count >= 0),
  CONSTRAINT lib_checkouts_dates_chk
    CHECK (due_date >= checkout_date),
  CONSTRAINT lib_checkouts_returned_chk
    CHECK (
      (status IN ('ACTIVE', 'OVERDUE', 'LOST') AND returned_at IS NULL)
      OR
      (status = 'RETURNED' AND returned_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS lib_checkouts_patron_date_idx
  ON lib_checkouts (patron_id, checkout_date DESC);

CREATE INDEX IF NOT EXISTS lib_checkouts_active_idx
  ON lib_checkouts (copy_id)
  WHERE returned_at IS NULL;

CREATE INDEX IF NOT EXISTS lib_checkouts_overdue_idx
  ON lib_checkouts (due_date)
  WHERE status = 'OVERDUE';

COMMENT ON TABLE lib_checkouts IS
  'One row per (copy, patron) borrow event. The Step 6 CheckoutService is the canonical writer. Both students and staff are first-class patrons via the soft patron_id ref to platform.iam_person(id) per ADR-055. NO ACTION on copy_id refuses copy delete while checkouts exist — financial-audit guard. The multi-column returned_chk keeps returned_at in lockstep with status across the four lifecycle phases.';

COMMENT ON COLUMN lib_checkouts.patron_id IS
  'Soft UUID ref to platform.iam_person(id) per ADR-001 / ADR-020. Covers students and staff uniformly via the ADR-055 person model. The Step 6 service resolves the patron_type from the iam_person link to platform.platform_users + the iam_role_assignment chain at checkout time and looks up the matching lib_checkout_policies row.';

COMMENT ON COLUMN lib_checkouts.status IS
  'ACTIVE on creation. OVERDUE flipped by a periodic sweep when due_date < today AND returned_at IS NULL. RETURNED on return path with returned_at stamped atomically. LOST is the librarian-marked write-off when the patron does not return the book within the school grace window. The lockstep CHECK prevents any half-state.';

CREATE TABLE IF NOT EXISTS lib_holds (
  id                  UUID         PRIMARY KEY,
  catalogue_item_id   UUID         NOT NULL REFERENCES lib_catalogue_items(id) ON DELETE CASCADE,
  patron_id           UUID         NOT NULL,
  placed_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  status              TEXT         NOT NULL DEFAULT 'PENDING',
  notified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_holds_status_chk
    CHECK (status IN ('PENDING', 'READY', 'COLLECTED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT lib_holds_window_chk
    CHECK (expires_at IS NULL OR expires_at > placed_at),
  CONSTRAINT lib_holds_pending_chk
    CHECK (status <> 'PENDING' OR notified_at IS NULL)
);

CREATE INDEX IF NOT EXISTS lib_holds_item_status_idx
  ON lib_holds (catalogue_item_id, status);

CREATE INDEX IF NOT EXISTS lib_holds_patron_status_idx
  ON lib_holds (patron_id, status);

CREATE INDEX IF NOT EXISTS lib_holds_pending_placed_idx
  ON lib_holds (catalogue_item_id, placed_at)
  WHERE status = 'PENDING';

COMMENT ON TABLE lib_holds IS
  'Hold queue. The Step 6 HoldService.placeHold inserts a PENDING row when a patron requests an item with all copies out. On return the Step 6 CheckoutService.return calls HoldService.fulfillNext which finds the oldest PENDING hold for the item via the partial INDEX, flips it to READY, stamps notified_at, and walks the returned copy to ON_HOLD_SHELF. CASCADE on the catalogue_item_id FK because hold queue rows have no value once the parent item is hard-deleted (which is rare — the soft-delete path is the lib_catalogue_copies is_available flag).';

COMMENT ON COLUMN lib_holds.status IS
  'PENDING on creation while the patron waits for a copy. READY when the oldest PENDING hold is fulfilled on a return — the Step 6 service stamps notified_at atomically and walks the copy to ON_HOLD_SHELF. COLLECTED when the patron picks up the reserved copy and the librarian creates the matching lib_checkouts row. EXPIRED when the school grace window passes without collection. CANCELLED when the patron or the librarian cancels — can happen from any non-terminal state.';

COMMENT ON CONSTRAINT lib_holds_pending_chk ON lib_holds IS
  'PENDING means the hold has not yet been notified. The CHECK pins notified_at to NULL while status is PENDING. Once status flips to READY, notified_at populates and persists through every later transition.';

CREATE TABLE IF NOT EXISTS lib_fines (
  id              UUID         PRIMARY KEY,
  checkout_id     UUID         NOT NULL REFERENCES lib_checkouts(id),
  patron_id       UUID         NOT NULL,
  fine_type       TEXT         NOT NULL,
  amount          NUMERIC(6,2) NOT NULL,
  days_overdue    INT,
  status          TEXT         NOT NULL DEFAULT 'OUTSTANDING',
  invoice_id      UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT lib_fines_type_chk
    CHECK (fine_type IN ('OVERDUE', 'LOST', 'DAMAGE')),
  CONSTRAINT lib_fines_status_chk
    CHECK (status IN ('OUTSTANDING', 'PAID', 'WAIVED')),
  CONSTRAINT lib_fines_amount_chk
    CHECK (amount >= 0),
  CONSTRAINT lib_fines_days_chk
    CHECK (days_overdue IS NULL OR days_overdue >= 0)
);

CREATE INDEX IF NOT EXISTS lib_fines_patron_status_idx
  ON lib_fines (patron_id, status);

CREATE INDEX IF NOT EXISTS lib_fines_checkout_idx
  ON lib_fines (checkout_id);

COMMENT ON TABLE lib_fines IS
  'Outstanding fines. The Step 6 FineService is the canonical writer. NO ACTION on the checkout_id FK refuses checkout delete while a fine references it — financial-audit guard mirroring lib_checkouts. The Step 6 service emits lib.fine.issued on every INSERT for the future Cycle 6 payment integration consumer that will materialise a pay_invoices row when the school configures the integration. invoice_id is a soft UUID ref to pay_invoices(id) populated by the consumer once the invoice row is created.';

COMMENT ON COLUMN lib_fines.fine_type IS
  'OVERDUE for a return past due_date — amount = days_overdue * lib_checkout_policies.overdue_fine_per_day. LOST for a copy marked LOST — amount defaults to lib_catalogue_copies.replacement_value. DAMAGE for a copy returned with damage requiring repair or replacement — amount is set by the librarian.';

COMMENT ON COLUMN lib_fines.invoice_id IS
  'Soft UUID ref to pay_invoices(id). NULL until the future Cycle 6 payment integration consumer materialises a pay_invoices row from this fine. No DB-enforced FK because the consumer flow may flag a fine as payable without immediately creating the invoice (e.g. when the patron is in a payment plan or the school requires manual review).';
