# REVIEW-CYCLE10-CHATGPT — Round 2 verdict + fix log

**Round 1** (against `cycle10-complete` at `e631cce`) returned **REJECT pending 1 privacy fix**.

**Round 2** (after the fix below) is being re-submitted at the new HEAD with `cycle10-approved` tagged.

The reviewer carried 2 MAJOR follow-ups + accepted 2 product-side decisions; only the BLOCKING was a code-side fix needed for approval.

---

## Triage table

| #   | Severity     | Finding                                                                                                                                                                                                                                                                      | Status                                    | Where it lives                                                                                                                                                                                                                                                                                                   |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **BLOCKING** | Parent can read medication administration history via `GET /health/medications/:id/administrations` (clinical dose log including missed reasons, dose given, parent-notified, administering staff) — endpoint was gated on `hlt-001:read` with a GUARDIAN branch in service. | **FIXED**                                 | `apps/api/src/health/administration.{controller,service}.ts`                                                                                                                                                                                                                                                     |
| 2   | MAJOR        | Scheduled-dose duplicate logging — `administer()` and `logMissed()` insert without UNIQUE / advisory lock on `(medication, schedule_entry, date)`, so two nurses could double-log the same scheduled dose.                                                                   | **DEFERRED** to Wave 2 Phase 2 punch list | The reviewer explicitly accepted this as a non-blocking carry-over: "After [the BLOCKING fix], I would approve Cycle 10 with the duplicate-dose issue carried as a major follow-up."                                                                                                                             |
| 3   | MAJOR        | Staff role health permissions are broad — counsellor / VP / nurse all share the same `Staff` role grant of all 5 HLT codes read+write.                                                                                                                                       | **DEFERRED**                              | Already documented in CLAUDE.md Wave 2 Phase 2 punch list (#9 Counsellor role split) plus a new entry for Nurse / Health Office split. Acceptable for demo; locked-product decision before pilot.                                                                                                                |
| 4   | MAJOR        | IEP parent visibility is full at the API even though the Step 9 parent UI hides it.                                                                                                                                                                                          | **PRODUCT DECISION**                      | Documented in CLAUDE.md as a locked product decision — parents are full IEP team participants per IDEA / 504 statute, so the API is correct; the UI choice is presentation-side. The reviewer agrees: "That is acceptable if intentional, but it should be a locked product/security decision before pilot use." |

---

## BLOCKING fix details

### Before

`apps/api/src/health/administration.controller.ts`:

```ts
@Get('health/medications/:id/administrations')
@RequirePermission('hlt-001:read')   // ← parents hold this
@ApiOperation({
  summary:
    "Per-medication dose history. Inherits the parent medication's row scope (nurse / admin / parent only; teachers 403 service-layer). Writes a VIEW_MEDICATIONS audit row.",
})
```

`apps/api/src/health/administration.service.ts`:

```ts
async listForMedication(medicationId: string, actor: ResolvedActor): Promise<AdministrationResponseDto[]> {
  const { studentId } = await this.medications.loadStudentForMedication(medicationId);
  const includeRead =
    (await this.records.assertCanReadStudentExternal(studentId, actor)).isManager ||
    actor.personType === 'GUARDIAN';   // ← the explicit parent-allow branch
  if (!includeRead) {
    throw new ForbiddenException(
      'Medication administration history is visible to nurses, admins, and parents only',
    );
  }
  // ...returns full dose / notes / missed-reason / parent-notified / staff name
}
```

### After

Controller — re-gated to `hlt-002:read` (which guardians do NOT hold):

```ts
@Get('health/medications/:id/administrations')
@RequirePermission('hlt-002:read')   // ← was hlt-001:read; tightened per BLOCKING
@ApiOperation({
  summary:
    "Per-medication dose history. Nurse / admin only — gated on hlt-002:read so guardians never reach this clinical log per REVIEW-CYCLE10 BLOCKING. Parents see medication summary + scheduled times via the Step 5 /students/:studentId/medications endpoint instead. Writes a VIEW_MEDICATIONS audit row.",
})
```

Service — GUARDIAN branch removed; `hasNurseScope` is the defence-in-depth check:

```ts
async listForMedication(medicationId: string, actor: ResolvedActor): Promise<AdministrationResponseDto[]> {
  const { studentId } = await this.medications.loadStudentForMedication(medicationId);
  if (!(await this.records.hasNurseScope(actor))) {
    throw new ForbiddenException(
      'Medication administration history is visible to nurses and admins only',
    );
  }
  // ...same SELECT as before
}
```

### Live verification (`tenant_demo`, 2026-05-04)

```
=== R1 admin GET /health/medications/<id>/administrations 200 ===
status=200
=== R2 counsellor (Staff role with HLT-002:read) GET 200 ===
status=200
=== R3 parent GET /health/medications/<id>/administrations 403 (BLOCKING fix) ===
status=403
  message: You do not have the required permission for this action
=== R4 teacher GET 403 ===
status=403
=== R5 student GET 403 ===
status=403

=== R6 parent CAN still read /students/<maya>/medications (parent-safe summary) ===
  Albuterol Inhaler route=INHALER dosage=90mcg per puff prescribing_physician=None schedule_count=1
```

The parent surface for medications stops at the per-student summary + scheduled times (`GET /health/students/:studentId/medications`). That DTO already strips `prescribingPhysician` for guardians per the Step 6 visibility model. The clinical dose-by-dose log (administered_at, dose given, missed_reason, parent_notified flag, administering staff name) is now staff-only.

### CAT script extension

`docs/cycle10-cat-script.md` Scenario 7 gains a new **S7.I** sub-check that explicitly verifies the parent denial on `/health/medications/:id/administrations` and documents the BLOCKING fix inline. Future regression check.

---

## Reviewer's "strong passes" (preserved verbatim)

- Health schemas preserve soft cross-schema integrity with zero cross-schema FKs.
- The ADR-030 accommodation bridge was verified end-to-end: `hlth_iep_accommodations` changes reconcile into `sis_student_active_accommodations`, and teachers read the SIS read model rather than `hlth_*`.
- HIPAA access logging is exercised in CAT, with audit entries created across multiple health read paths.
- Parent row scope for other children is correctly 404, and parent access to screenings, medication dashboard, and access log is denied.

The fix above adds parent denial on the per-medication administration-history endpoint to that list.

---

## Final gate decision (Round 2)

After the BLOCKING fix lands and is live-verified, the reviewer's stated approval condition is satisfied: _"After that, I would approve Cycle 10 with the duplicate-dose issue carried as a major follow-up."_

Tagging `cycle10-approved` on the closeout commit. The duplicate-dose issue (MAJOR 1) joins the Wave 2 Phase 2 punch list as a non-blocking carry-over for the Cycle 11 / pilot-readiness round.

---

## Wave 2 Phase 2 punch list updates

Adding the following items after the REVIEW-CYCLE10 round:

1. **Scheduled-dose duplicate logging.** Add a per-(medication, schedule_entry, date) advisory lock + existence check (or a partial UNIQUE INDEX `(schedule_entry_id, administered_at::date) WHERE was_missed=false`) in `AdministrationService.administer()` and `logMissed()` so concurrent calls from two nurses can't double-log the same scheduled dose. Pattern lives in Cycle 6 `InvoiceService.generateFromSchedule` (advisory lock + in-tx existence check).
2. **Nurse / Health Office / Counsellor role split.** The Staff role currently grants all 5 HLT codes read+write — fine for demo where one Staff persona acts as nurse, but a real school will want narrower roles. Carry alongside the existing Counsellor split (Wave 2 Phase 2 punch list #9) before pilot.
3. **IEP parent visibility — locked product decision.** `IepPlanService.buildVisibility` GUARDIAN branch is the source of truth for parent IEP API access; the Step 9 `/children/[id]/health` parent UI deliberately omits IEP from the summary card. If a school wants the API to mirror the UI restriction, the visibility model would need to drop GUARDIAN — but parents being full IEP team participants is the IDEA / 504 default. Decision documented; review before pilot.
