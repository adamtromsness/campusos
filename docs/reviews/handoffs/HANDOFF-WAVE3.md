# HANDOFF — Wave 3 (m87-safety / m23-health / m27-student-services)

**Scope:** Per `docs/campusos-test-strategy-v3.html` Wave 3 — safety-critical
modules. ≥90% coverage target. The IMMUTABLE-trigger contracts are the
headline DB-level deliverable; per-module deep specs build on top.

## Step status

| Step | Title                                                                       | Status     |
| ---- | --------------------------------------------------------------------------- | ---------- |
| 1    | `wave3-immutable-contracts/wave3-immutable-contracts.spec.ts` — 3 new DB-level IMMUTABLE triggers (inc_incident_timeline, hlth_health_access_log, svc_referral_activity) — 16 tests | ✅ |
| 2    | `m87-safety/incident-lifecycle.spec.ts` (declare KEYSTONE: inc_incidents + inc_declaration_outbox in same tx + Kafka emit AFTER commit; resolve/cancel state machine with SELECT FOR UPDATE; cross-school scoping; TimelineService append-only contract + 49 tests) | ✅ |
| 3    | `m23-health/health-records.spec.ts` (incl. hlth.allergy_alert.changed outbox-in-tx KEYSTONE; create + update + getFullRecord with VIEW_RECORD audit-in-tx; nurse-scope + STAFF-class-link + GUARDIAN row scope; 38 tests) | ✅ |
| 4    | `m23-health/iep-plans.spec.ts` (incl. iep.accommodation.updated outbox-in-tx; 29 tests covering plan + accommodation lifecycle + snapshot emit on add/update/remove + EXPIRED plan empty-array contract + shape validation + auth gates) | ✅ |
| 5    | `m27-student-services/referral-lifecycle.spec.ts` (full lifecycle SUBMITTED→TRIAGED→ACCEPTED→IN_PROGRESS→COMPLETED + CrisisEscalationService.escalate KEYSTONE outbox-in-tx + auth/scope gates + 28 tests) | ✅ |
| 6    | `m27-student-services/counselling-sessions.spec.ts` (SessionService row-locked transitions + counsellor-owned row scope + UNIQUE participant + SessionNoteService FERPA gate via `student_counseling_record:read` + IRREVERSIBLE lock with multi-column locked_chk + no unlock surface; 42 tests) | ✅ |
| 7    | `m27-student-services/wellbeing.spec.ts`                                    | ⏳ pending |
| 8    | `m27-student-services/mtss.spec.ts`                                         | ⏳ pending |

## Cumulative IMMUTABLE contracts (now 8)

| #   | Table                                       | Module             | Wave |
| --- | ------------------------------------------- | ------------------ | ---- |
| 1   | fin_gl_entries                              | m83-finance        | 1    |
| 2   | pay_credit_notes                            | m84-payments       | 1    |
| 3   | pay_payment_reversals                       | m84-payments       | 1    |
| 4   | pay_lunch_account_balance_transfers         | m84-payments       | 1    |
| 5   | fds_inventory_transactions                  | m86-procurement    | 1    |
| 6   | dpo_pseudonymisation_log                    | m00-platform       | 2    |
| 7   | inc_incident_timeline                       | m87-safety         | 3    |
| 8   | hlth_health_access_log                      | m23-health         | 3    |
| 9   | svc_referral_activity                       | m27-student-services | 3  |
