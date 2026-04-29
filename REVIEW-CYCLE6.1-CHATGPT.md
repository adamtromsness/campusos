# Cycle 6.1 Architecture Review — ChatGPT (Adversarial)

**Reviewer:** ChatGPT
**Scope:** Full Cycle 6.1 (Profile & Household — `iam_person` + `platform_families` + `platform_family_members` extensions in Step 1, `sis_student_demographics` + `sis_guardians` employment in Step 2, `usr-001` permission in Step 3, seed in Step 4, ProfileModule in Step 5, HouseholdsModule in Step 6, Profile UI + avatar dropdown in Step 7, vertical-slice CAT in Step 8). The reviewer's brief is `REVIEW-CYCLE6.1-HANDOFF-CHATGPT.md`.
**Round 1 SHA under review:** _(TBD — set at review time)_
**Round 1 verdict:** _(TBD)_
**Round 2 SHA under review:** _(TBD if Round 1 returns REJECT)_
**Final verdict:** _(TBD)_

**Verdict trail:**

| Round | Date  | SHA   | Verdict |
| ----: | ----- | ----- | ------- |
|     1 | _TBD_ | _TBD_ | _TBD_   |
|     2 | _TBD_ | _TBD_ | _TBD_   |

---

## Round 1 — pending review

The review hasn't run yet. The pre-review brief is in `REVIEW-CYCLE6.1-HANDOFF-CHATGPT.md` and lists 12 specific hostile-test concerns the implementer flagged for the reviewer to hammer. After the reviewer files findings, this section gets a triage table mirroring the Cycle 6 review:

|   # | Reviewer's claim | Triage (Claude) |
| --: | ---------------- | --------------- |
|     |                  |                 |

The triage classifies each item as one of:

- **VALID — BLOCKING**: must fix in Round 2 before APPROVE.
- **VALID — MAJOR**: must fix in Round 2 before APPROVE.
- **VALID — MINOR**: should fix but not blocking; lands in the closeout commit if cheap.
- **WRONG**: the reviewer read stale or unrelated code; cite the file:line that disproves the claim.
- **ACCEPTED-DEVIATION**: known forward-looking item already on the Phase 2 punch list, or re-litigates a previously-approved ADR. Cite the prior ADR/review and remain on Phase 2.

---

## Strong passes _(to be filled in by reviewer)_

These are the patterns Cycle 6.1 should have got right:

- ADR-055: `iam_person` remains the canonical identity table; new columns are personal-projection data on the canonical row.
- ADR-001 / ADR-020: 0 cross-schema FKs introduced. `sis_student_demographics → sis_students` is intra-tenant.
- Locked-read concurrency: every state-change in HouseholdsService opens a `prisma.$transaction`, takes `SELECT ... FOR UPDATE` on `platform_families.id`, runs the membership gate inside the same tx, then mutates.
- Atomic primary-contact promotion: explicit clear-then-set inside the same tx, with the partial UNIQUE INDEX as schema-side fallback.
- Tenant transaction discipline: profile tenant-side writes use `executeInTenantTransaction`; household platform-side writes use a regular `prisma.$transaction` (split documented in HANDOFF-CYCLE6.1.md front-matter).
- ADR-057 envelope shape: `iam.household.member_changed` emits go through `KafkaProducerService.emit({sourceModule:'iam'})`; 4 envelopes captured live in the CAT.
- Persona-aware row scope: profile reads compose persona-conditional payloads; household admin endpoint returns 404 (not 403) for non-member non-admin.
- ValidationPipe `forbidNonWhitelisted` enforces self-service ALLOW-LIST at the boundary before the service layer.
- Idempotent seed gating: `seed-profile.ts` skips cleanly on re-run when Chen Family already has a HEAD_OF_HOUSEHOLD member.

---

## Round 2 verification _(to be filled in after fixes land)_

For each VALID finding from Round 1, document:

- **Fix commit SHA + file:line**.
- **Mechanism** (e.g. "added `pg_advisory_xact_lock`", "switched to `executeInTenantTransaction`", "added partial UNIQUE INDEX").
- **Live verification** (CAT-style: command + observed result, or build-artifact inspection if live verification is impractical).

Mark each VALID finding as ✅ Fixed.

---

## Notes for downstream cycles

After Cycle 6.1 ships APPROVED:

- Tag `cycle6.1-complete` on the Step 8 CAT commit (CI must be green).
- Tag `cycle6.1-approved` on the final fix commit (or on the Step 8 commit if Round 1 returns APPROVED unchanged).
- Update `CLAUDE.md` Project Status entry to "**APPROVED at <SHA>**" + record any accepted DEVIATIONs as Phase 2 punch-list items.
- Future Cycle 7 (Helpdesk) does not depend on Cycle 6.1 outputs, so the `cycle7-step*` work can start immediately after Cycle 6.1 is APPROVED — no blocking carry-overs expected.
