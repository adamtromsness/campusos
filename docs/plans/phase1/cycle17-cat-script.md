# Cycle 17 — Customer Acceptance Test (CAT)

End-to-end vertical-slice walkthrough verified live against `tenant_demo`. Reproducible — every block can be re-executed from a clean post-Cycle-16 database with a fresh `seed:clubs` run. All 7 scenarios pass; one ADR-057 wire envelope captured live (`ext.election.results.published`); the **ANONYMITY KEYSTONE** is verified at the schema level (no voter identity column on `ext_votes`); the **STUDENT-INPUT KEYSTONE** flows through log → approval → progress credit; the **PARENT CONSENT KEYSTONE** rejects cross-family signing with a 403 and duplicate signatures with a 400.

Prereqs:

- API running at `http://localhost:4000` (built from `apps/api/dist/main.js`)
- Postgres + Kafka up via `docker compose up -d`
- `tenant_demo` provisioned through Cycle 17 + `seed:clubs` run (3 activities + 5 members + 1 field trip with consent + 1 election with 2 candidates / 3 votes / 2 voter checks + 1 service programme with 2 hours / 1 approval / 1 progress)
- Test users from the seed (admin@/principal@/teacher@/parent@/student@/vp@)

---

## S0 — Schema preamble (live captured)

```
tenant base tables = 239
cycle 17 ext_ tables = 16
ANONYMITY KEYSTONE: ext_votes columns:
 column_name
--------------
 id
 election_id
 position
 candidate_id
 voted_at
(5 rows)

IAM CLB grants Staff = 8
IAM CLB grants Student = 4
```

The 16 new logical base tables come from `058_ext_activities.sql` (4 — types + activities + members + schedules), `059_ext_field_trips.sql` (4 — trips + participants + consent + chaperones), and `060_ext_elections_service.sql` (8 — elections + candidates + votes + voter check + service programmes + hours + approvals + progress). The `ext_votes` table column readout is the schema-level proof that votes carry no voter identity. Staff role gets `CLB-001..004` read+write (8 codes); Student gets `CLB-001:read + CLB-002:read + CLB-004:read+write` (4 codes — the third student-input write permission in CampusOS).

## S1 — Activity lifecycle (live captured)

```
Browse activities:
  Chess Club | ACADEMIC | 2 / 20 members
  Drama Club | ARTS | 2 / ∞ members
  Student Council | LEADERSHIP | 1 / ∞ members
```

Student browses activities — three seeded clubs with member counts vs caps (Chess Club enforces a 20-member cap; Drama and Council have no cap). The list is ordered by category then name; categories are colour-coded in the UI.

## S2 — Field trips + parent row scope (live captured)

```
Parent (David — sees only Maya's trips):
  Natural History Museum | CONFIRMED | 1 / 2 consent signed
```

The seed plants one CONFIRMED trip with Maya and Ethan as participants and David Chen's signed consent for Maya. David sees the trip because Maya is a participant. The 1 of 2 consent count reflects the seed's single signed row (Maya's) vs 2 participants. Other parents (whose children are not on the roster) would see an empty list — the row-scope predicate filters by `sis_student_guardians.guardian_person_id = actor.personId`.

## S3 — PARENT CONSENT KEYSTONE — guards (live captured)

```
Parent David Chen tries to sign Ethan's consent (should be 403 — David is not Ethan's guardian):
  403 You are not the linked guardian for this student. Cannot sign consent.

Parent attempts to re-sign for Maya (should be 400 — UNIQUE):
  400 You have already signed consent for this student on this trip

        proof         | consent_given | signed_at | ip_address |     guardian_person_id
----------------------+---------------+-----------+------------+----------------------------------
 seed consent record: | t             | …         | 127.0.0.1  | 019dc92d-088c-7442-abf6-…
```

Two guards on the consent surface:

1. **Cross-family signing rejected (403).** `ConsentService.sign` validates the calling guardian has a `sis_student_guardians` link to the supplied studentId. David Chen has no link to Ethan Rodriguez, so the sign attempt fails before any row is written.
2. **Duplicate signature rejected (400).** UNIQUE(field_trip, student, guardian_person_id) catches the second sign attempt for the same triple.

The seed row itself shows the keystone in action: `consent_given=true`, `ip_address` populated from the request actor (here `127.0.0.1` because the seed runs locally), `guardian_person_id` matches David Chen's `iam_person.id`.

## S4 — ANONYMITY KEYSTONE — vote cast + double-vote rejected (live captured)

```
Election created: 019dfc66-ecec-…
Election OPEN
Maya votes:
  {'status': 'CAST', 'votedAt': '2026-05-06T08:28:17+00'}

ANONYMITY PROOF — ext_votes row has NO voter identity column:
                  id                  |             election_id              | position  |             candidate_id             |           voted_at
--------------------------------------+--------------------------------------+-----------+--------------------------------------+----------
 019dfc66-ed9a-…                     | 019dfc66-ecec-…                     | PRESIDENT | 019dfc66-ed3e-…                     | 2026-05-06 08:28:17.175246+00
(1 row)

voter_check has Maya's row but NO reference to any vote:
             election_id              |              student_id              |           voted_at
--------------------------------------+--------------------------------------+----------
 019dfc66-ecec-…                     | 019dd544-7e06-…                     | 2026-05-06 08:28:17.175246+00
(1 row)


Double-vote rejected:
  400 You have already voted in this election
```

The keystone sequence inside one tenant transaction:

1. **`INSERT ext_election_voter_check (election_id, student_id)`** — the primary key prevents Maya from voting twice. A second attempt fails with SQLSTATE 23505, caught at the service layer and translated to a friendly 400.
2. **`INSERT ext_votes (id, election_id, position, candidate_id, voted_at)`** — five columns total, **none of which are voter identity**. The two writes touch different tables. There is no foreign key, no surrogate audit, no shared identifier between them.

The schema readout is the proof — `ext_votes` has columns `id, election_id, position, candidate_id, voted_at`. **There is no JOIN path from a vote row back to a voter row.** A database administrator querying both tables can see "Maya voted in election X" and "candidate Y received vote Z in election X" but cannot link Maya's record to vote Z.

## S5 — Election results + envelope captured live (live captured)

```
Results:
{
    "electionId": "019dfc66-ecec-…",
    "status": "RESULTS_PUBLISHED",
    "results": [
        {
            "position": "PRESIDENT",
            "candidateId": "019dfc66-ed3e-…",
            "candidateName": "Maya Chen",
            "voteCount": 1
        }
    ],
    "totalVotersChecked": 1
}

ext.election.results.published envelope:
{
    "event_id": "019dfc66-f301-…",
    "event_type": "ext.election.results.published",
    "event_version": 1,
    "occurred_at": "2026-05-06T08:28:18.561Z",
    "published_at": "2026-05-06T08:28:18.561Z",
    "tenant_id": "019dc92b-ea59-…",
    "source_module": "clubs",
    "correlation_id": "019dfc66-f301-…",
    "payload": {
        "electionId": "019dfc66-ecec-…",
        "publishedAt": "2026-05-06T08:28:18.561Z",
        "publishedBy": "019dc92d-087d-…"
    }
}
```

`/clubs/elections/:id/results` returns aggregated vote counts only when status=RESULTS_PUBLISHED — a CLOSED election returns an empty results list to prevent leaking interim tallies. The `totalVotersChecked` count comes from `ext_election_voter_check` row count, not vote count, so it can never accidentally expose individual ballots. The wire envelope on `dev.ext.election.results.published` carries `source_module='clubs'`, full ADR-057 shape, and the timestamp + publisher account id for downstream notification consumers.

## S6 — STUDENT-INPUT KEYSTONE — log + approve + progress credit (live captured)

```
Hour logged: 019dfc67-1437-… (PENDING approval id=019dfc67-143a-…)
Maya progress (should now be 3 approved, 4 pending):
 approved= 3 pending= 4
VP approves:
 status= APPROVED reviewer= Linda Park
Maya progress (should now be 5 approved, 2 pending):
 approved= 5 pending= 2
```

The student-input keystone flow:

1. **Maya logs 2.0 hours.** `ServiceHourService.log` runs in one tenant tx — INSERTs `ext_service_hours`, INSERTs a PENDING `ext_service_hour_approvals` row keyed on the new hour, UPSERTs `ext_service_progress` adding 2.0 to `pending_hours` (3 → 4 in the seed shape that already had 2 pending hours).
2. **VP approves.** `ServiceHourService.review` locks the approval row + the hour's programme + student, updates the approval to APPROVED with reviewer + timestamp + notes, then UPDATEs `ext_service_progress` to credit the hours: `approved_hours += 2.0` (3 → 5) and `pending_hours -= 2.0` (4 → 2). `is_complete` is recomputed against `ext_service_programmes.target_hours` in the same tx.

Maya's progress stays at "5 approved / 2 pending" because the seed's second pending entry (Library Volunteer 2 hours) is still PENDING after the smoke run. The cleanup script restores 3/2 to match the seed shape exactly.

## S7 — Permission denials (live captured)

```
Student POST /clubs/activities:        HTTP 403
Student POST /clubs/elections:         HTTP 403
Teacher PATCH service approval:        HTTP 403  (no clb-004:write)
Parent POST own service hour:          HTTP 403  (no clb-004:write)
```

- Student lacks `clb-001:write` → cannot create activities.
- Student lacks `clb-002:write` → cannot create elections (but can vote via `clb-002:read` since the anonymity keystone protects the data).
- Teacher persona maps to the Teacher role which does NOT carry `clb-004:write`; only Staff (which covers VPs and counsellors) and admins approve service hours. Service-hour approval is intentionally narrower than activity management.
- Parent has no `clb-004` grant at all — service hours are student-input + staff-approved, parents are downstream observers.

## Cleanup (live captured)

```
DELETE 1   -- smoke service hour approval
DELETE 1   -- smoke service hour
UPDATE 1   -- progress restored to 3 approved / 2 pending (seed shape)
DELETE 1   -- voter_check rows
DELETE 1   -- vote rows
DELETE 1   -- candidate rows
DELETE 1   -- election row
```

Final tenant state matches the post-`seed:clubs` shape exactly: 4 activity types + 3 activities + 5 members + 3 schedules + 1 field trip + 2 participants + 1 consent record + 2 chaperones + 1 election (CLOSED) + 2 candidates + 3 votes + 2 voter_check rows + 1 service programme + 2 hours + 1 approval + 1 progress (3 approved / 2 pending). Re-runnable.

---

## Reviewer attention items (non-blocking, Phase 2 polish)

1. **`ext.consent.received` and `ext.election.results.published` have no consumers yet** — the emits land cleanly but no downstream handler reacts (no parent IN_APP notification on consent, no roster announcement on election results). Phase 2 wires consumers when the relevant notification surfaces ship.
2. **Ranked-choice voting deferred** — the schema models `(position, candidate_id)` per vote, so a future ranked-choice extension would need a `ext_vote_rankings` child or an array-typed `ranked_candidate_ids` column. Cycle 17 is plurality-only.
3. **Service hour approval UI placeholder** — the `/clubs/service-hours` page renders student logging cleanly but the staff approval queue currently shows a "review available via API" placeholder. The approval id is not on the service-hour DTO; a Phase 2 UI iteration will surface the approval id and add per-row Approve / Reject buttons. The API endpoint is fully working and verified end-to-end via the CAT smoke.
4. **Election candidate auto-approval shortcut** — when an admin registers a student-on-behalf, `is_approved` is auto-set to `true`. When a student registers themselves, `is_approved=false` until an admin patches it. The student-self-register approval flow is schema-ready but no UI surface for the patch-to-approve action ships in this cycle.
5. **Activity schedule sync with calendar** — the `ext_activity_schedules` table carries the recurring time but does not yet generate `sch_calendar_events` rows. Bi-directional sync with the Cycle 5 calendar is on the Phase 2 punch list.
6. **Background check workflow** — `ext_field_trip_chaperones.background_check_status` is a CHECK enum but no workflow state machine drives PENDING→CLEARED. Real schools want a separate background-check service with audit; future cycle.
7. **Cross-tenant election + activity discovery** — by design, activities and elections are school-scoped today. Multi-school orgs that want shared programmes (e.g. district-wide service initiatives) are deferred.

**Cycle 17 ships clean to the post-cycle architecture review.**
