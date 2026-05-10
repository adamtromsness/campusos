/* 122_enr_tour_bookings_booked_by_nullable
 *
 * Phase 2 Cycle 5 (P2-5) — REVIEW-P2-5 Round 2 BLOCKING fix.
 *
 * Reviewer flagged a remaining last-seat race on the public tour
 * booking endpoint. The Round 1 fix put a slot pre-flight read
 * BEFORE iam_person creation, which catches bogus / unpublished /
 * cancelled / already-full slot ids. But under concurrent
 * last-seat pressure, two requests can both pass the pre-flight,
 * both create fresh iam_person rows, and then only one wins the
 * locked-tx capacity check — leaving the loser with an orphan
 * iam_person.
 *
 * The reviewer offered three acceptable fixes. We took Option C
 * (the reviewer's "cleanest abuse-resistant model"): no iam_person
 * on public tour booking at all. The booking already carries
 * family_name + contact_email + contact_phone columns, so the
 * contact info is preserved on the row itself. iam_person stays
 * NULL on public bookings — EOs stitch identities later via the
 * /tour-bookings/:id/link-application admin path once an
 * application or some other verified workflow proves ownership.
 *
 * This migration drops the NOT NULL on enr_tour_bookings.booked_by.
 * Existing rows (seeded + Round 1 smoke residue + the authenticated
 * booking path) keep their booked_by populated. Only the public
 * path going forward writes NULL.
 *
 * Splitter rules — no semicolons inside any block comment header,
 * single-quoted string, or COMMENT ON ... text.
 */

ALTER TABLE enr_tour_bookings
  ALTER COLUMN booked_by DROP NOT NULL;

COMMENT ON COLUMN enr_tour_bookings.booked_by IS
  'Tenant-local soft reference to platform.iam_person(id) per ADR-001/020. NULL when the booking came in through the unauthenticated public path — no platform identity is created at booking time per REVIEW-P2-5 Round 2 BLOCKING fix to dodge orphan-identity races on the last-seat capacity gate. EOs stitch identities later via POST /tour-bookings/:id/link-application once a verified application surfaces. Authenticated bookings (via parent dashboard etc.) populate this with the actor person id at insert time.';

/* The UNIQUE(slot_id, booked_by) constraint stays. With NULL booked_by
 * values the UNIQUE allows multiple NULL rows per slot which is the
 * right shape for public bookings (each public booking is a distinct
 * prospective family even if they share NULL identity).
 */
