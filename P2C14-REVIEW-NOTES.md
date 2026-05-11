# P2C14-REVIEW-NOTES — Phase 2 Cycle 14 (Behaviour Advanced)

Peer-review scaffold for the post-cycle architecture review. Plan at `docs/campusos-p2c14-behaviour-advanced.html`. Handoff at `HANDOFF-P2C14.md`.

## Review dimensions

1. **Restorative justice agreement follow-through pattern** — Does the conference auto-transition to RESOLVED_SUCCESSFULLY when (and only when) every agreement action lands COMPLETED, inside one tenant tx?
2. **Multi-column lockstep on `sis_rj_agreement_actions.completed_chk`** — Does the schema accept only the two legitimate shapes (PENDING/OVERDUE ⇒ completed_at + verified_by both null; COMPLETED ⇒ both populated)?
3. **Multi-column lockstep on `sis_restorative_justice_conferences.resolved_chk`** — Does the schema enforce `resolution_date IS NULL` on non-terminal states + NOT NULL on RESOLVED_SUCCESSFULLY / FAILED?
4. **Peer mediation schema CHECKs** — Are `parties_chk` (party_a ≠ party_b) and `mediator_chk` (mediator is not either party) enforced at the DB layer?
5. **Positive points ledger pattern** — Is `points > 0` enforced at the schema layer + direction carried by `transaction_type` (AWARD/REDEMPTION), with `redemption_chk` keeping category populated on AWARD + reward_id populated on REDEMPTION?
6. **Redemption concurrency** — Does `PositiveBehaviourService.redeem` lock the reward row inside a tenant tx, recompute balance under the lock, validate balance ≥ points_cost, INSERT the REDEMPTION transaction, AND decrement quantity_available atomically?
7. **Reward marketplace authority** — Are catalogue mutations (POST/PATCH /rewards) restricted to `beh-001:admin`?
8. **Tenant validation** — Do all incoming UUIDs (incident, student, employee) get validated against the calling tenant before INSERT?
9. **Outbox vs best-effort emit choice** — Why is `beh.rj_conference.resolved` durable (outbox) and `beh.positive_points.awarded` best-effort?
10. **OverdueActionWorker tenant safety** — Does the worker fail-soft per tenant?
11. **BIP feedback row-scope** — Does the submit path enforce `teacher_id = actor.employeeId` for non-counsellor non-admin actors?
12. **Category config storage choice** — Is the use of tenant-scoped `school_config` (rather than the plan-referenced non-existent `platform_tenant_configs`) sound?
13. **Test coverage** — Are the 21 pinned regression tests sufficient to catch a future regression on each of the keystones above?
14. **CI parity** — Format, lint, builds, tests all green.

## Pattern decisions worth review attention

### A) Restorative-justice agreement follow-through

The keystone is `RestorativeJusticeService.completeAction()`. It runs entirely inside one `executeInTenantTransaction`:

1. SELECT FOR UPDATE on the action + parent conference row.
2. Refuse if status is already COMPLETED.
3. UPDATE action to status=COMPLETED with `completed_at + verified_by` populated together (multi-column `completed_chk` requires both).
4. COUNT _ FILTER (status=COMPLETED) AS done, COUNT _ AS total under the same lock.
5. If `done === total > 0`, SELECT FOR UPDATE on the parent conference; if its status is not already terminal, UPDATE to RESOLVED_SUCCESSFULLY with `resolution_date = now()` (multi-column `resolved_chk` requires both for terminal states).
6. `outbox.enqueueInTx(tx, ...)` writes the durable outbox row inside the same tx with a deterministic v5-shape event_id.

**Race property**: Two parallel completion requests both racing to complete the final two actions will serialise on the action `FOR UPDATE` lock. Exactly one of them sees `done === total` and triggers the conference flip; the other sees the conference already RESOLVED_SUCCESSFULLY and doesn't re-emit. The outbox row is unique per `(eventId)` so even a retried emit would dedup downstream.

### B) Positive-points + rewards economics

Ledger model: `points > 0` always at the schema level; `transaction_type` flips direction. Balance is computed at read time:

```
balance = SUM(points WHERE transaction_type='AWARD') - SUM(points WHERE transaction_type='REDEMPTION')
```

Redemption flow (in one tenant tx):

1. SELECT FOR UPDATE on the reward row (locks the catalogue entry to serialise concurrent redeems).
2. Validate `is_active=true` AND (`quantity_available IS NULL OR quantity_available > 0`).
3. Validate student is in this school.
4. Compute balance under the same lock.
5. Refuse if `balance < points_cost`.
6. INSERT a REDEMPTION row with `points = reward.points_cost` + `reward_id` populated (multi-column `redemption_chk` enforces the shape).
7. If `quantity_available IS NOT NULL`, UPDATE `quantity_available = quantity_available - 1`.

**Concurrency property**: Two students both redeeming the last sticker at the same time → reward row lock serialises; one INSERTs and decrements, the other re-reads `quantity_available=0` and gets `ConflictException('Reward is out of stock')`.

### C) Peer mediation trained-mediator validation

Schema enforces:

- `party_a_student_id ≠ party_b_student_id` (parties_chk)
- `mediator_student_id ∉ {party_a, party_b}` (mediator_chk)
- `is_mediator_trained BOOLEAN DEFAULT true`

Service layer additionally validates all 3 students belong to the calling tenant. The `is_mediator_trained` flag is set on the mediation row at INSERT time; future training-roster integration (P2-4 HR Training cross-link) would maintain this from a `sis_peer_mediator_training` roster table — deferred per the plan.

`PeerMediationService.listTrainedMediators()` returns distinct mediators from prior mediations with `is_mediator_trained=true`. Pre-pilot improvement: a dedicated roster table populated via a trained-mediator onboarding workflow.

### D) BIP feedback integration

No new table. Extends Cycle 11 `svc_bip_teacher_feedback` (schema unchanged) with three new endpoints. The partial UNIQUE `(plan_id, teacher_id) WHERE submitted_at IS NULL` from Cycle 11 catches double-requests. The service layer reuses the multi-column `effectiveness_chk` from Cycle 11's schema.

Submit path:

1. SELECT FOR UPDATE on the row.
2. Refuse if `submitted_at` is already populated.
3. Row-scope: non-counsellor non-admin actor must match `teacher_id = actor.employeeId`.
4. UPDATE with submitted_at + supplied fields. The partial UNIQUE on pending rows releases automatically once `submitted_at` is set.

### E) Category configuration choice

The plan referenced `platform_tenant_configs` which does not exist in the platform schema. The actual tenant-scoped JSONB config home is the Cycle-0 `school_config` table (`config_key TEXT UNIQUE`, `config_value JSONB`). CategoryConfigService uses this with key `positive_behaviour_categories` + a sensible default fallback (Respect / Responsibility / Leadership). Same functional outcome — tenant-scoped, key/value JSONB, school-configurable.

## Open carry-overs to Phase 2 punch list

- Notification fan-out for OVERDUE actions (Cycle 14 NotificationConsumer wiring).
- Behaviour pattern detection AI (requires AI Inference service).
- Parent-visible positive behaviour feed (backend ready, parent UI deferred).
- Peer mediator training programme integration with P2-4 HR Training.
- Positive behaviour leaderboards (privacy gates needed).
- Whole-class reward redemption workflow.
- `beh.rj_conference.resolved` consumer for parent IN_APP fan-out.

## Reviewer attention checklist

- [ ] Multi-column lockstep CHECKs reject every mismatch direction on `completed_chk`, `resolved_chk`, `redemption_chk`.
- [ ] Schema CHECK constraints `parties_chk` + `mediator_chk` reject self-mediation + same-party pairs.
- [ ] `points > 0` CHECK is enforced and the AWARD/REDEMPTION direction is correct in the ledger arithmetic.
- [ ] Redemption locks the reward row and validates balance under the same lock.
- [ ] Reward marketplace `POST/PATCH /rewards` require `beh-001:admin`.
- [ ] All RJ + mediation + points service calls validate UUIDs against the calling tenant before INSERT.
- [ ] `beh.rj_conference.resolved` lands via `OutboxService.enqueueInTx` (durable) — confirmed deterministic event_id.
- [ ] `beh.positive_points.awarded` best-effort emit acceptable for parent fan-out (rationale: non-safety-critical; mirrors Cycle 6 invoice/payment best-effort emit before outbox uplift).
- [ ] OverdueActionWorker is best-effort per tenant.
- [ ] BIP feedback row-scope enforced for non-counsellor submit.
- [ ] 21-test spec covers all 14 review dimensions above; CI green.
- [ ] Plan deviations documented (migration number, category config storage, ledger pattern).
