# Cycle 13 Customer Acceptance Test (CAT) — Athletics

**Audience:** Architecture reviewers + future maintainers.
**Reference:** `docs/campusos-cycle13-implementation-plan.html`, `HANDOFF-CYCLE13.md`.
**Tagged commit:** `cycle13-complete` (after CI green).

This document is the reproducible end-to-end vertical slice test for Cycle 13 (Athletics). It walks through the 10 plan scenarios live against `tenant_demo` and confirms the keystone behaviours: GPA eligibility check (reads back into Cycle 2 gradebook), game scheduling + result entry + season record auto-update + `ath.game.result.entered` Kafka emit, the **6-step concussion return-to-play protocol with step-sequencing enforcement**, and the medical-clearance → return-to-play closure that restores roster eligibility atomically.

---

## Schema preamble (8 checks)

Run against `tenant_demo` after `pnpm seed:athletics` has landed. All checks should pass.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='tenant_demo' AND table_type='BASE TABLE'
    AND table_name NOT SIMILAR TO '%\_(p[0-9]|h[0-9]+|y[0-9]+|2024|2025|2026|2027|2028|2029|2030)%') AS base_tables,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema='tenant_demo' AND table_name LIKE 'ath\_%') AS ath_tables,
  (SELECT COUNT(*) FROM pg_constraint c
    WHERE c.connamespace='tenant_demo'::regnamespace AND c.contype='f'
    AND c.conname LIKE 'ath\_%fkey') AS ath_intra_fks;
"
```

Expected: **base_tables=203, ath_tables=14, ath_intra_fks=25** (6 from Step 1 + 10 from Step 2 + 9 from Step 3).

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SET search_path TO tenant_demo, platform, public;
SELECT
  (SELECT COUNT(*) FROM ath_programmes) AS programmes,
  (SELECT COUNT(*) FROM ath_seasons) AS seasons,
  (SELECT COUNT(*) FROM ath_rosters) AS rosters,
  (SELECT COUNT(*) FROM ath_roster_members) AS members,
  (SELECT COUNT(*) FROM ath_games) AS games,
  (SELECT COUNT(*) FROM ath_game_results) AS results,
  (SELECT COUNT(*) FROM ath_player_game_stats) AS stats,
  (SELECT COUNT(*) FROM ath_season_records) AS records,
  (SELECT COUNT(*) FROM ath_coaching_assignments) AS coaches,
  (SELECT COUNT(*) FROM ath_injuries) AS injuries,
  (SELECT COUNT(*) FROM ath_concussion_protocol_steps) AS steps,
  (SELECT COUNT(*) FROM ath_medical_clearances) AS clearances;
"
```

Expected (post-Step-4 seed): **programmes=2, seasons=2, rosters=2, members=3, games=3, results=2, stats=6, records=1, coaches=1, injuries=1, steps=3, clearances=0**.

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
SELECT pu.email,
  bool_or('ath-001:read'  = ANY(eac.permission_codes)) AS r001,
  bool_or('ath-001:write' = ANY(eac.permission_codes)) AS w001,
  bool_or('ath-004:read'  = ANY(eac.permission_codes)) AS r004,
  bool_or('ath-004:write' = ANY(eac.permission_codes)) AS w004
FROM platform.iam_effective_access_cache eac
JOIN platform.platform_users pu ON pu.id = eac.account_id
GROUP BY pu.email
ORDER BY pu.email;
"
```

Expected: admin/principal/vp/counsellor have all four flags; teacher r001+r004 only; student r001+r004 only; parent r001 only.

---

## 10 plan scenarios

The scenarios assume the API is running on `localhost:4000` and that the seven dev personas each return a JWT via `POST /api/v1/auth/dev-login`.

### S1 — Programme + season creation

The AD creates a "Soccer" programme (FALL, [VARSITY], min_gpa=2.5), opens a 2025-2026 season (status=ACTIVE), and creates a VARSITY roster.

```bash
PRINCIPAL_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"principal@demo.campusos.dev"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
H="Authorization: Bearer $PRINCIPAL_TOKEN"
T="X-Tenant-Subdomain: demo"
J="Content-Type: application/json"

PROG=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"sportName":"CAT Soccer","season":"FALL","levelsOffered":["VARSITY"],"minGpa":2.5}' \
  http://localhost:4000/api/v1/athletics/programmes \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

SEASON=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"academicYear":"2025-2026","status":"ACTIVE","firstGameDate":"2025-09-15","lastGameDate":"2025-11-30"}' \
  http://localhost:4000/api/v1/athletics/programmes/$PROG/seasons \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

ROSTER=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"level":"VARSITY"}' \
  http://localhost:4000/api/v1/athletics/seasons/$SEASON/rosters \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
```

Expected: 3 IDs returned. Programme appears in `GET /athletics/programmes`.

### S2 — GPA eligibility check keystone

Add Maya Chen (Cycle 2 seed gives her published grades averaging well above the 2.5 threshold) → `eligibility_status=ELIGIBLE`. The check reads `cls_grades.percentage` for PUBLISHED grades and bands the average to a 4-point GPA.

```bash
MAYA_ID=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT s.id FROM tenant_demo.sis_students s JOIN platform.platform_students ps ON ps.id=s.platform_student_id JOIN platform.iam_person p ON p.id=ps.person_id WHERE p.first_name='Maya' AND p.last_name='Chen';")

curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"studentId\":\"$MAYA_ID\",\"jerseyNumber\":\"7\",\"position\":\"Striker\"}" \
  http://localhost:4000/api/v1/athletics/rosters/$ROSTER/members | python3 -m json.tool
```

Expected: `eligibilityStatus="ELIGIBLE"` (or `PENDING_PHYSICAL` if Maya has no published grades yet, depending on seed state). `liveGpa` is populated when grades exist.

### S3 — Game scheduling

```bash
GAME1=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"rosterId\":\"$ROSTER\",\"gameDate\":\"2025-09-15\",\"gameTime\":\"15:00\",\"opponentName\":\"CAT Eagles\",\"location\":\"HOME\",\"isConferenceGame\":true}" \
  http://localhost:4000/api/v1/athletics/games \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

GAME2=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"rosterId\":\"$ROSTER\",\"gameDate\":\"2025-09-22\",\"gameTime\":\"15:00\",\"opponentName\":\"CAT Hawks\",\"location\":\"AWAY\",\"isConferenceGame\":true}" \
  http://localhost:4000/api/v1/athletics/games \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
```

### S4 — Result entry + season record auto-update + `ath.game.result.entered` Kafka emit

```bash
curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"homeScore":3,"awayScore":1,"outcome":"WIN"}' \
  http://localhost:4000/api/v1/athletics/games/$GAME1/result | python3 -m json.tool

curl -s -H "$H" -H "$T" http://localhost:4000/api/v1/athletics/season-records/$ROSTER \
  | python3 -m json.tool
```

Expected: result.outcome=WIN; season record `wins=1, losses=0, draws=0, conferenceWins=1`. The `ath.game.result.entered` envelope is emitted on `dev.ath.game.result.entered` (verifiable via `kcat -C -t dev.ath.game.result.entered -o end -e -q`).

### S5 — Player stats

```bash
curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"stats\":[{\"studentId\":\"$MAYA_ID\",\"statCategory\":\"goals\",\"statValue\":2},{\"studentId\":\"$MAYA_ID\",\"statCategory\":\"assists\",\"statValue\":1}]}" \
  http://localhost:4000/api/v1/athletics/games/$GAME1/stats | python3 -m json.tool

curl -s -H "$H" -H "$T" http://localhost:4000/api/v1/athletics/games/$GAME1/stats | python3 -m json.tool
```

Expected: 2 stat lines per Maya for game 1.

### S6 — Coaching assignment

```bash
RIVERA=$(docker exec campusos-postgres psql -U campusos -d campusos_dev -tA -c \
  "SELECT p.id FROM platform.iam_person p JOIN platform.platform_users pu ON pu.person_id=p.id WHERE pu.email='teacher@demo.campusos.dev';")

curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"coachPersonId\":\"$RIVERA\",\"role\":\"HEAD_COACH\",\"stipendAmount\":5000}" \
  http://localhost:4000/api/v1/athletics/rosters/$ROSTER/coaches | python3 -m json.tool

curl -s -H "$H" -H "$T" http://localhost:4000/api/v1/athletics/rosters/$ROSTER/coaches | python3 -m json.tool
```

### S7 — Injury + concussion protocol keystone

Log a head-contact MODERATE concussion injury for Maya. Expect roster member eligibility flips automatically to INJURED_NOT_CLEARED.

```bash
INJURY=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d "{\"studentId\":\"$MAYA_ID\",\"injuryDate\":\"2025-10-01\",\"practiceDate\":\"2025-10-01\",\"bodyPart\":\"Head\",\"injuryDescription\":\"CAT smoke head injury\",\"severity\":\"MODERATE\",\"returnToPlayStatus\":\"CONCUSSION_PROTOCOL\"}" \
  http://localhost:4000/api/v1/athletics/injuries \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# Roster member eligibility now INJURED_NOT_CLEARED
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT eligibility_status FROM tenant_demo.ath_roster_members WHERE student_id='$MAYA_ID' AND removed_at IS NULL;"
```

Expected: `INJURED_NOT_CLEARED` for every active membership Maya has.

The 6-step protocol enforces step-N+1 cannot start until step-N is completed, symptom-free, and minimum-duration-hours have elapsed. With `minimumDurationHours=1` we can simulate the gates inline by using SQL to backdate `started_at`. (Real flows wait 24 hours per CDC guidance.)

```bash
# Start step 1 with 1-hour minimum (so we can simulate elapsed time via SQL backdate)
S1ID=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"stepNumber":1,"stepName":"Complete rest","minimumDurationHours":1}' \
  http://localhost:4000/api/v1/athletics/injuries/$INJURY/protocol/steps \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# Try starting step 2 BEFORE step 1 is complete — expect 400
curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"stepNumber":2,"stepName":"Light aerobic","minimumDurationHours":1}' \
  http://localhost:4000/api/v1/athletics/injuries/$INJURY/protocol/steps | python3 -m json.tool
# Expected: {"statusCode":400,"message":"Cannot start step 2 until the previous step is completed."}

# Backdate step 1 by 2 hours and complete it
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "UPDATE tenant_demo.ath_concussion_protocol_steps SET started_at = now() - interval '2 hours' WHERE id='$S1ID';"

curl -s -H "$H" -H "$T" -H "$J" -X PATCH \
  -d '{"symptomFree":true}' \
  http://localhost:4000/api/v1/athletics/concussion-steps/$S1ID | python3 -m json.tool
# Expected: completedAt populated, symptomFree=true, clearedBy populated
```

Repeat the start + backdate + complete pattern for steps 2–6. Each `Start` call refuses unless `(now - prev.started_at) >= prev.minimum_duration_hours` AND `prev.symptom_free=true` AND `prev.completed_at IS NOT NULL`.

### S8 — Medical clearance + return-to-play closure

Upload a clearance, AD ACCEPTs, and watch the injury auto-flip to CLEARED + roster eligibility restore to ELIGIBLE.

```bash
CLR=$(curl -s -H "$H" -H "$T" -H "$J" -X POST \
  -d '{"documentS3Key":"clearances/cat-smoke.pdf","physicianName":"Dr CAT","clearanceDate":"2025-10-15"}' \
  http://localhost:4000/api/v1/athletics/injuries/$INJURY/clearances \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

curl -s -H "$H" -H "$T" -H "$J" -X PATCH \
  -d '{"decision":"ACCEPTED","reviewNotes":"Cleared after 6-step protocol completion"}' \
  http://localhost:4000/api/v1/athletics/medical-clearances/$CLR/review | python3 -m json.tool

# Verify injury flipped to CLEARED only when all 6 protocol steps are complete
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT return_to_play_status FROM tenant_demo.ath_injuries WHERE id='$INJURY';"
docker exec campusos-postgres psql -U campusos -d campusos_dev -c \
  "SELECT eligibility_status FROM tenant_demo.ath_roster_members WHERE student_id='$MAYA_ID' AND removed_at IS NULL;"
```

Expected: when all 6 steps are complete, injury → `CLEARED`, roster eligibility → `ELIGIBLE`. If any step is unfinished, the clearance stays ACCEPTED but the injury holds.

### S9 — Visibility (5 personas)

```bash
STUDENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"student@demo.campusos.dev"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
PARENT_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"parent@demo.campusos.dev"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
TEACHER_TOKEN=$(curl -sX POST http://localhost:4000/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -H 'X-Tenant-Subdomain: demo' \
  -d '{"email":"teacher@demo.campusos.dev"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")

# Student sees own injuries only (row-scoped)
curl -s -H "Authorization: Bearer $STUDENT_TOKEN" -H "$T" \
  http://localhost:4000/api/v1/athletics/injuries | python3 -c "import sys,json;d=json.load(sys.stdin);print(f'rows={len(d)}')"

# Parent denied on /athletics/injuries (no ATH-004:read)
curl -s -o /dev/null -w "parent /injuries: %{http_code}\n" \
  -H "Authorization: Bearer $PARENT_TOKEN" -H "$T" \
  http://localhost:4000/api/v1/athletics/injuries

# Teacher denied on POST /programmes (no ATH-001:write)
curl -s -o /dev/null -w "teacher POST /programmes: %{http_code}\n" \
  -H "Authorization: Bearer $TEACHER_TOKEN" -H "$T" -H "$J" \
  -X POST -d '{"sportName":"X","season":"FALL","levelsOffered":["VARSITY"]}' \
  http://localhost:4000/api/v1/athletics/programmes

# Student denied on POST /games (no ATH-002:write)
curl -s -o /dev/null -w "student POST /games: %{http_code}\n" \
  -H "Authorization: Bearer $STUDENT_TOKEN" -H "$T" -H "$J" \
  -X POST -d '{"rosterId":"00000000-0000-0000-0000-000000000000","gameDate":"2030-01-01","gameTime":"15:00","opponentName":"X","location":"HOME"}' \
  http://localhost:4000/api/v1/athletics/games
```

Expected: parent 403; teacher 403; student 403 on writes; student row-scoped to own injuries.

### S10 — Roster certification

```bash
# Refuses if any active member is INELIGIBLE
curl -s -H "$H" -H "$T" -H "$J" -X POST \
  http://localhost:4000/api/v1/athletics/rosters/$ROSTER/certify | python3 -m json.tool
```

Expected: success when all active members are ELIGIBLE; 400 with "Cannot certify a roster with INELIGIBLE members" otherwise. The atomic stamp of `is_certified=true / certified_at / certified_by` per the multi-column `certified_chk` keystone is verifiable in psql.

---

## Cleanup

The CAT plants ~10 rows. Cleanup is straightforward:

```bash
docker exec campusos-postgres psql -U campusos -d campusos_dev -c "
DELETE FROM tenant_demo.ath_player_game_stats WHERE game_id IN (SELECT id FROM tenant_demo.ath_games WHERE opponent_name LIKE 'CAT %');
DELETE FROM tenant_demo.ath_game_results WHERE game_id IN (SELECT id FROM tenant_demo.ath_games WHERE opponent_name LIKE 'CAT %');
DELETE FROM tenant_demo.ath_games WHERE opponent_name LIKE 'CAT %';
DELETE FROM tenant_demo.ath_medical_clearances WHERE injury_id IN (SELECT id FROM tenant_demo.ath_injuries WHERE injury_description LIKE 'CAT %');
DELETE FROM tenant_demo.ath_concussion_protocol_steps WHERE injury_id IN (SELECT id FROM tenant_demo.ath_injuries WHERE injury_description LIKE 'CAT %');
DELETE FROM tenant_demo.ath_injuries WHERE injury_description LIKE 'CAT %';
DELETE FROM tenant_demo.ath_coaching_assignments WHERE notes LIKE 'CAT %' OR roster_id IN (SELECT r.id FROM tenant_demo.ath_rosters r JOIN tenant_demo.ath_seasons s ON s.id=r.season_id JOIN tenant_demo.ath_programmes p ON p.id=s.programme_id WHERE p.sport_name='CAT Soccer');
DELETE FROM tenant_demo.ath_season_records WHERE roster_id IN (SELECT r.id FROM tenant_demo.ath_rosters r JOIN tenant_demo.ath_seasons s ON s.id=r.season_id JOIN tenant_demo.ath_programmes p ON p.id=s.programme_id WHERE p.sport_name='CAT Soccer');
DELETE FROM tenant_demo.ath_roster_members WHERE roster_id IN (SELECT r.id FROM tenant_demo.ath_rosters r JOIN tenant_demo.ath_seasons s ON s.id=r.season_id JOIN tenant_demo.ath_programmes p ON p.id=s.programme_id WHERE p.sport_name='CAT Soccer');
DELETE FROM tenant_demo.ath_rosters WHERE season_id IN (SELECT s.id FROM tenant_demo.ath_seasons s JOIN tenant_demo.ath_programmes p ON p.id=s.programme_id WHERE p.sport_name='CAT Soccer');
DELETE FROM tenant_demo.ath_seasons WHERE programme_id IN (SELECT id FROM tenant_demo.ath_programmes WHERE sport_name='CAT Soccer');
DELETE FROM tenant_demo.ath_programmes WHERE sport_name='CAT Soccer';
"
```

Restores `tenant_demo` to the post-Step-4 seed shape exactly.

---

## Reviewer attention items (non-blocking, Phase 2 polish)

1. **Cross-school game proposals (ADR-069)** — schema + backend service ship, but the receiving school's UI for accepting a proposal is a polish item. Today the AD on both sides hits the API via curl or the future cross-tenant entity directory.
2. **Live GPA eligibility re-check via gradebook Kafka consumer** — the read-back query is in place (synchronous on add-member + bulk re-check endpoint), but Cycle 2's `cls.grade.published` Kafka emit isn't yet consumed by the athletics module. A future polish wires a `RosterEligibilityConsumer` that re-runs the GPA check whenever a grade flips PUBLISHED.
3. **All-time record auto-detection** — manual entry only this cycle. A future polish runs against `ath.game.result.entered` to detect single-game records on result entry.
4. **Season record DB trigger** — service-side update only this cycle. A future migration could add a trigger on `ath_game_results` insert to bump `ath_season_records` deterministically, freeing the service from the responsibility.
5. **Athletic Director role split** — Staff role currently grants all 5 ATH codes read+write. Real schools want a dedicated AD role that excludes counsellor / nurse access; joins the Wave 2 Phase 2 punch list (Counsellor / Nurse / Librarian / AD splits) before pilot.
6. **`ath.game.result.entered` consumer** — emit lands cleanly with full ADR-057 envelope; no consumer fans out today. Future polish wires a parent IN_APP notification path so families learn the result without checking the schedule page.

---

## Wave 2 closeout

Cycle 13 completes Wave 2 Student Services. The platform now covers the full student experience:

- **Wave 1 (Cycles 0–8):** academic + operational core — SIS / Classroom / Communications / HR / Scheduling / Enrollment / Payments / Profile-Household / Tasks / Approvals / Service Tickets.
- **Wave 2 (Cycles 9–13):** student services — Behaviour / Health / Counselling / Wellbeing / Library / Athletics.

Wave 3 begins with Communications & Community — meetings, enrolment polish, clubs (M64), groups, and the cross-school proposal acceptance flow.
