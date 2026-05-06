# REVIEW-CYCLE19-CHATGPT

**Round 1 verdict:** **Reject pending fixes** (against `cycle19-complete` at `dfca32b`).

The reviewer flagged 5 BLOCKING items + 5 MAJOR follow-ups. Cycle 19 ships M61 Transportation core; because this cycle touches student transportation, no-show safeguarding, QR scan identity, and driver/vehicle safety, the reviewer applied a stricter standard. The fix commit closes all 5 BLOCKING items + 3 of the actionable MAJORs (6 docs, 7 staff/admin route-change validation, 8 no-show resolve lock). MAJORs 9 + 10 are recommendation-class and move to the Phase 2 punch list as items 30 + 31.

**Round 2 verdict:** **Approved** (against `c309bd4`, 2026-05-06). Reviewer cache-busted each affected file in code and confirmed every BLOCKING fix landed (NO_BUS suppression on the no-show worker; QR-scan expected-assignment validation; run-start route lock + driver match + duplicate prevention; permanent-assignment academic_year_id required + written into the INSERT + defensive partial UNIQUE; route create/patch vehicle + driver safety) plus the three actionable MAJORs (HANDOFF status updated; staff/admin route-change soft-ref validation; no-show resolve row-lock + idempotent status). MAJORs 9 + 10 correctly carried as Phase 2 punch list items 30 + 31. **Cycle 19 ships clean — Wave 4 opens here.**

Tag chain:

- `cycle19-complete` on `2bb4cb3` (original closeout — triggered Round 1)
- `cycle19-approved` on `c309bd4` (Round 2 APPROVED — after the fix commit)

---

## Triage table

| #   | Severity | File                                                                    | Reviewer claim                                                                                                | Triage           | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | BLOCKING | `apps/api/src/transport/no-show.service.ts`                             | Approved `NO_BUS` requests still generate no-show alerts.                                                     | VALID            | `NoShowService.runOnce` query now `NOT EXISTS` against `trn_route_change_requests` filtered to APPROVED for the date — generalised to suppress permanent-assignment alerts whenever ANY approved change request exists for (student, date), so DIFFERENT_STOP / DIFFERENT_ROUTE overrides correctly drive expectation while the permanent stop drops out. Live verified: sweep before NO_BUS = 2 alerts; sweep after NO_BUS approval = 1 alert (Ethan). |
| 2   | BLOCKING | `apps/api/src/transport/ridership.service.ts`                           | QR scan does not validate the scanned student is expected on that route/stop/direction.                       | VALID            | `RidershipService.scan` adds an effective-assignment SELECT before INSERT — permanent or override row required, NO_BUS-suppressed students rejected, scan direction must match the assignment direction (or assignment must be BOTH). Live verified: scan at correct stop 200; scan at wrong stop 400; ALIGHTING on AM-only assignment 400.                                                                                                             |
| 3   | BLOCKING | `apps/api/src/transport/run-log.service.ts`                             | Any active employee can start any route run; no duplicate-run prevention.                                     | VALID            | `RunLogService.start` wrapped in `executeInTenantTransaction` with `SELECT ... FOR UPDATE` on the route. Requires `route.driver_id === actor.employeeId` unless `actor.isSchoolAdmin`; verifies driver carries VALID CDL + MEDICAL_CERTIFICATE; rejects when an IN_PROGRESS run already exists for (route, date). Schema-side belt-and-braces via partial UNIQUE in migration 067. Live verified: admin override 200; second IN_PROGRESS run 400.       |
| 4   | BLOCKING | `apps/api/src/transport/dto/transport.dto.ts` + `assignment.service.ts` | Permanent assignment uniqueness fails when `academic_year_id` is NULL; service did not even write the column. | VALID            | DTO gains `academicYearId` field. Service requires it for non-override assignments + writes it into the INSERT (was missing entirely). Migration 067 adds `trn_assignments_permanent_null_year_uq` partial UNIQUE on `(student_id) WHERE is_override=false AND academic_year_id IS NULL` as defence-in-depth. Live verified: POST without academicYearId → 400 "academicYearId is required for permanent assignments".                                  |
| 5   | BLOCKING | `apps/api/src/transport/route.service.ts`                               | Route create/patch accepts vehicle + driver soft refs without safety validation.                              | VALID            | Two new private helpers on `RouteService`: `assertVehicleAssignable` (exists + ACTIVE) + `assertDriverAssignable` (employee exists + VALID CDL + MEDICAL_CERTIFICATE). Called from `create()` and `patch()` whenever the relevant id is supplied. Live verified: bogus driverId 400; bogus vehicleId 400.                                                                                                                                               |
| 6   | MAJOR    | `HANDOFF-CYCLE19.md` + `docs/cycle19-cat-script.md`                     | Handoff still says IN PROGRESS / Pending; CAT lacks live observed-output trail.                               | VALID            | `HANDOFF-CYCLE19.md` updated to COMPLETE with all 10 steps marked Complete + a fix-log section appended documenting each fix with live verification observations. The CAT script remains the procedure manual; the live verification per fix lives in the handoff.                                                                                                                                                                                      |
| 7   | MAJOR    | `apps/api/src/transport/route-change-request.service.ts`                | Staff/admin route-change submission did not validate soft refs.                                               | VALID            | `submit()` now runs unconditional existence checks: `studentId` in `sis_students`, `requestedRouteId` in `trn_routes` + status=ACTIVE, `requestedStopId` in `trn_stops` + belongs to the resolved route when both are supplied. Applies regardless of actor.                                                                                                                                                                                            |
| 8   | MAJOR    | `apps/api/src/transport/no-show.service.ts`                             | `NoShowService.resolve` is not row-locked and not status-safe.                                                | VALID            | `resolve()` wrapped in `executeInTenantTransaction` with `SELECT ... FOR UPDATE`. Idempotent same-resolution noop accepted; different resolution from non-admin rejected with 400; school admin can override. Live verified: admin resolve OK; VP attempt to flip → 400; VP same-resolution → 200 (idempotent).                                                                                                                                         |
| 9   | MAJOR    | `apps/api/src/transport/transport.controller.ts` + service              | Vehicle / driver credential detail endpoints not actor-aware.                                                 | VALID — DEFERRED | Recommendation-class. The TRN permission grant is broad on Staff today (acceptable for demo phase per the reviewer); a dedicated TC role split is already on the Phase 2 punch list (item 9 / 11 / 13 / 16 / 22). Tightening row-scope on detail reads joins the same role-split work. Phase 2 punch list item 30.                                                                                                                                      |
| 10  | MAJOR    | `apps/api/src/transport/inspection.service.ts` + `run-log.service.ts`   | Run start uses inspection status but does not match inspection driver to route driver.                        | VALID — DEFERRED | The pre-trip inspection is vehicle-level today, and the run may legitimately be driven by a different person who certified the vehicle. The driver accountability refinement (require `inspection.driver_id === route.driver_id`, or surface an explicit "delegated certification" flag) is a Phase 2 polish. Phase 2 punch list item 31.                                                                                                               |

---

## Round 1 fixes summary (all in this commit)

- **BLOCKING 1** — `NoShowService.runOnce` query suppresses students with any APPROVED change request for the date.
- **BLOCKING 2** — `RidershipService.scan` validates expected assignment + direction before INSERT.
- **BLOCKING 3** — `RunLogService.start` wraps in tenant tx, locks route, requires assigned driver (or admin), verifies CDL + MEDICAL_CERTIFICATE valid, rejects duplicate IN_PROGRESS runs. Schema-side belt-and-braces via migration 067.
- **BLOCKING 4** — DTO + service require `academicYearId` for permanent assignments. Service writes the column into the INSERT (was missing). Migration 067 adds the NULL-year defensive partial UNIQUE.
- **BLOCKING 5** — `RouteService.create/patch` validate vehicle (exists + ACTIVE) and driver (employee + VALID CDL + MEDICAL_CERTIFICATE).
- **MAJOR 6** — Handoff updated to COMPLETE + fix log appended with live verification observations.
- **MAJOR 7** — Route-change `submit()` validates `studentId` + `requestedRouteId` + `requestedStopId` regardless of actor.
- **MAJOR 8** — No-show `resolve()` row-locked + idempotent status-safe.
- **MAJORs 9 + 10** carried to Phase 2 punch list (items 30 + 31).

All 8 code-level fixes verified live on `tenant_demo` 2026-05-06.

---

## Round 2 verdict

**Approved at `c309bd4`** (2026-05-06).

Reviewer's confirmed fix list:

- BLOCKING 1 — `NoShowService.runOnce` suppresses permanent-assignment alerts when an APPROVED route-change request exists for (student, date), including NO_BUS opt-outs and same-day route/stop overrides. Verified live (sweep before 2 → after 1).
- BLOCKING 2 — `RidershipService.scan` resolves student via QR token, resolves route from stop, verifies effective assignment for that (student, route, stop, date), rejects NO_BUS-suppressed students, validates direction.
- BLOCKING 3 — `RunLogService.start` runs in tenant tx, locks route, requires assigned driver (or admin), verifies CDL + MEDICAL_CERTIFICATE valid, rejects duplicate IN_PROGRESS runs, catches unique violations with friendly error.
- BLOCKING 4 — `AssignmentService.create` requires academicYearId for non-override permanents, validates the academic year exists, writes the column. Migration 067 adds the defensive null-year partial UNIQUE.
- BLOCKING 5 — `RouteService.create` and `patch` validate vehicleId (exists + ACTIVE) and driverId (employee + VALID CDL + MEDICAL_CERTIFICATE).
- MAJOR 6 — HANDOFF-CYCLE19.md marks Cycle 19 COMPLETE with Round 1 fixes landed, all 10 steps Complete, plus the live verification fix log.
- MAJOR 7 — `RouteChangeRequestService.submit` validates studentId / requestedRouteId (active) / requestedStopId (belongs to route) regardless of submitter persona.
- MAJOR 8 — `NoShowService.resolve` locks the alert row with FOR UPDATE, idempotent same-resolution accepted, mismatched resolution rejected unless school admin.

Reviewer's deferred items (not Cycle 19 blockers): MAJORs 9 + 10 — vehicle/driver credential detail row scope tightening (joins the broader role-split work), and run-start should match the inspection driver to route driver (delegated certification policy). Phase 2 punch list items 30 + 31.

**Final gate:** Approved. Tag `cycle19-approved` lives at `c309bd4`.
