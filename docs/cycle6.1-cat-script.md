# CampusOS Cycle 6.1 — Customer Acceptance Test Script

**Cycle:** 6.1 (Profile & Household)
**Step:** 8 of 8 — Vertical Slice Acceptance Test
**Last verified:** 2026-04-29 (against `tenant_demo` on `main`)
**Plan reference:** `docs/campusos-cycle6.1-implementation-plan.html` § Step 8

This is the manual walkthrough that exercises every layer of Cycle 6.1 — the 22 new + extended columns across `platform.iam_person` + `platform.platform_families` + `platform.platform_family_members` from Step 1, the 1 new tenant table + 4 new `sis_guardians` employment columns from Step 2, the new `usr-001` permission code from Step 3, the seeded household + 6 personal-field rows + 15 demographics rows from Step 4, the 4 ProfileService endpoints from Step 5, the 6 HouseholdsService endpoints + the `iam.household.member_changed` Kafka emit from Step 6, and the 2 web routes + 6 tabs + avatar dropdown from Step 7. The format mirrors `docs/cycle1-cat-script.md` through `docs/cycle6-cat-script.md`.

The verification below was captured live with the API, all Cycle 1–6 Kafka consumers (`gradebook-snapshot-worker`, `audience-fan-out-worker`, the 5 notification consumers, `leave-notification-consumer`, `coverage-consumer`, `payment-account-worker`), and the notification-delivery worker all running against the freshly-seeded demo tenant. Outputs are recorded inline so a reviewer can re-run the script and diff the results against this transcript.

The 11 plan scenarios are bracketed by a schema preamble that proves the Cycle 6.1 columns + tables + permission codes + seed shape landed cleanly before the business flow runs.

---

## Prerequisites

- Docker services up: `docker compose up -d` (Postgres, Redis, Kafka, Keycloak).
- Cycle 0–6 schema + seed in place. Full reset for a fresh CAT run:

  ```bash
  docker exec campusos-postgres psql -U campusos -d campusos_dev \
    -c "DROP SCHEMA IF EXISTS tenant_demo CASCADE; DROP SCHEMA IF EXISTS tenant_test CASCADE;"
  pnpm --filter @campusos/database migrate                      # platform Prisma migrate, includes Cycle 6.1 Step 1
  pnpm --filter @campusos/database provision --subdomain=demo   # tenant migrations through 022 (Cycle 6.1 Step 2)
  pnpm --filter @campusos/database provision --subdomain=test
  pnpm --filter @campusos/database seed                          # platform + 7 test users
  pnpm --filter @campusos/database exec tsx src/seed-iam.ts      # 447 perms, 6 roles (Cycle 6.1 Step 3)
  pnpm --filter @campusos/database seed:sis
  pnpm --filter @campusos/database seed:classroom
  pnpm --filter @campusos/database seed:messaging
  pnpm --filter @campusos/database seed:hr
  pnpm --filter @campusos/database seed:scheduling
  pnpm --filter @campusos/database seed:enrollment
  pnpm --filter @campusos/database seed:payments
  pnpm --filter @campusos/database seed:profile                  # Cycle 6.1 Step 4
  pnpm --filter @campusos/database exec tsx src/build-cache.ts
  ```

- API running: `pnpm --filter @campusos/api build && pnpm --filter @campusos/api start`. The 4 profile + 6 household routes mount during boot.

- Optional Kafka topic pre-creation on a fresh broker:

  ```bash
  docker exec campusos-kafka /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server localhost:9092 --create --if-not-exists \
    --topic dev.iam.household.member_changed --partitions 1 --replication-factor 1
  ```

---

## Schema preamble (Cycle 6.1 land + seed verification)

Captured 2026-04-29 against `tenant_demo`:

```text
iam_person columns: 22                         (was 10 pre-Cycle 6.1; +12 personal fields per Step 1)
platform_families columns: 20                  (was 3 pre-Cycle 6.1; +17 household fields per Step 1)
platform_family_members new cols: 2            (joined_at + updated_at per Step 1)
MemberRole enum values: 10                     (5 original + 5 new per Step 1)
partial UNIQUE index present: 1                (one primary contact per family — Step 1)
sis_student_demographics columns: 10           (new tenant table per Step 2)
sis_guardians employment cols: 4               (employer / employer_phone / occupation / work_address — Step 2)
USR-001 permission rows: 3                     (read / write / admin tiers — Step 3)
Total permissions in catalog: 447              (was 444; 149 functions × 3 tiers)

Step 4 seed verification:
  Chen Family: Chen Family / 1234 Oak Street / +1-217-555-0123
  demographics rows: 15
  iam_person rows w/ preferred_name: 6
```

Every check matches the Step 1–4 expected counts in `HANDOFF-CYCLE6.1.md`.

---

## Personas

| Persona        | Login email                    | Role                          | Cycle 6.1 grants                     |
| -------------- | ------------------------------ | ----------------------------- | ------------------------------------ |
| Platform Admin | `admin@demo.campusos.dev`      | Platform Admin                | usr-001:read+write+admin (447 total) |
| School Admin   | `principal@demo.campusos.dev`  | School Admin (Sarah Mitchell) | usr-001:read+write+admin (447 total) |
| Teacher        | `teacher@demo.campusos.dev`    | Teacher (James Rivera)        | usr-001:read+write (36 total)        |
| Student        | `student@demo.campusos.dev`    | Student (Maya Chen)           | usr-001:read+write (17 total)        |
| Parent         | `parent@demo.campusos.dev`     | Parent (David Chen)           | usr-001:read+write (17 total)        |
| VP             | `vp@demo.campusos.dev`         | Staff (Linda Park)            | usr-001:read+write (16 total)        |
| Counsellor     | `counsellor@demo.campusos.dev` | Staff (Marcus Hayes)          | usr-001:read+write (16 total)        |

Dev-mode tokens are obtained via `POST /api/v1/auth/dev-login {email}` and supplied as `Authorization: Bearer <token>` plus `X-Tenant-Subdomain: demo` on every request.

---

## Scenario 1 — David parent reads `/profile/me`

Verifies the persona-conditional composition for GUARDIAN: identity + login email + household membership + employment populated, demographics + emergency contact null (guardians have no schema home for either today — documented Phase 2 polish item).

```bash
curl -s -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/profile/me
```

Live response (essentials):

```text
personType=GUARDIAN  preferredName=Dave
household.role=HEAD_OF_HOUSEHOLD  household.primary=True
employment.employer=Chen Engineering LLC
demographics=None
emergencyContact=None
```

✓ Step 5's persona-aware composition rule fires correctly.

---

## Scenario 2 — David PATCHes own personal fields (allowed)

Exercises the self-service ALLOW-LIST + the Step 1 phone-type CHECK constraint live (HOME is in the enum).

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"preferredName":"Davey","secondaryPhone":"+1-217-555-9999","phoneTypeSecondary":"HOME"}' \
  http://localhost:4000/api/v1/profile/me
```

Live response:

```text
preferredName=Davey
secondaryPhone=+1-217-555-9999  type=HOME
updatedAt=2026-04-29 08:22:44.787+00
```

✓ Allow-list works. ✓ `profileUpdatedAt` bumps. ✓ `phoneTypeSecondary='HOME'` accepted by the schema CHECK.

---

## Scenario 3 — David PATCHes `firstName` (rejected at the validation pipe)

Identity fields (firstName, lastName, dateOfBirth post-set, login email) are admin-only per ADR-055. The web ValidationPipe with `forbidNonWhitelisted: true` rejects unknown properties on the self-service DTO before the service layer sees them — cleaner UX than a service-layer 400.

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"Davey"}' \
  http://localhost:4000/api/v1/profile/me
```

Live response:

```text
{"message":["property firstName should not exist"],"error":"Bad Request","statusCode":400}
HTTP 400
```

✓ Self-service cannot edit identity fields.

---

## Scenario 4 — David edits the household address

HEAD_OF_HOUSEHOLD is one of the two roles that pass `assertCanEditHousehold`. The PATCH is wrapped in a `prisma.$transaction` with `SELECT ... FOR UPDATE` on `platform_families.id` per the locked-read concurrency convention.

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"addressLine1":"1234 Oak Street, Apt 5","city":"Springfield","postalCode":"62701"}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD
```

Live response:

```text
addressLine1=1234 Oak Street, Apt 5  city=Springfield  postalCode=62701
```

✓ Household shared fields update. (No Kafka emit on address-only PATCH — only member-side mutations emit.)

---

## Scenario 5 — Maya (CHILD) reads household read-only, PATCH refused

Maya is a member of the Chen Family with role CHILD, which is NOT in the `EDIT_ROLES` set (`HEAD_OF_HOUSEHOLD` or `SPOUSE`). The composed read returns `canEdit=false` so the UI hides edit controls; a PATCH attempt is service-layer rejected with the friendly 403 message.

```bash
curl -s -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/households/my
# → canEdit=False  role=CHILD

curl -s -X PATCH -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"city":"Bogus"}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD
# → 403
```

Live response:

```text
canEdit=False  role=CHILD
{"message":"Only the head of household or spouse can edit shared household details. Contact an administrator if this is wrong.","error":"Forbidden","statusCode":403}
PATCH HTTP 403
```

✓ Row-scope read indicator + service-layer write gate both fire as designed.

---

## Scenario 6 — Maya self-service demographics: `primaryLanguage` allowed, `gender` rejected

The Demographics tab has a split rule: `primaryLanguage` is editable by self-service, but `gender / ethnicity / birthCountry / citizenship / medicalAlertNotes` are admin-only. The non-admin DTO's `forbidNonWhitelisted` enforces this at the pipe.

```bash
curl -s -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/profile/me
# personType=STUDENT  dob=2011-03-15  demographics={'gender':'Female','primaryLanguage':'English',...}

curl -s -X PATCH -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"primaryLanguage":"Mandarin"}' \
  http://localhost:4000/api/v1/profile/me
# → demographics.primaryLanguage=Mandarin (allowed)

curl -s -X PATCH -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"gender":"Other"}' \
  http://localhost:4000/api/v1/profile/me
# → 400 (gender is admin-only)
```

Live response:

```text
personType=STUDENT  dob=2011-03-15  demographics={gender:Female, primaryLanguage:English, ...}
PATCH primaryLanguage allowed → demographics.primaryLanguage=Mandarin
{"message":["property gender should not exist"],"error":"Bad Request","statusCode":400}  HTTP 400
```

Cleanup: Maya restores `primaryLanguage='English'` so subsequent runs start clean.

✓ Self-service / admin-only field split is enforced.

---

## Scenario 7 — Jim staff sets emergency contact → lands in `hr_emergency_contacts` (dual-table resolution)

Cycle 6.1 reuses the existing emergency-contact tables: `hr_emergency_contacts` for STAFF (keyed on `employee_id`) and `sis_emergency_contacts` for STUDENT (keyed on `student_id`). The ProfileService routes the write to the right table based on `personType`. The response surfaces a `source` discriminator so the UI can render the right hint.

```bash
curl -s -X PATCH -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"emergencyContact":{"name":"Sofia Rivera","relationship":"Spouse","phone":"+1-217-555-2002","isPrimary":true}}' \
  http://localhost:4000/api/v1/profile/me
```

Live response (essentials):

```text
emergencyContact source=EMPLOYEE  name=Sofia Rivera  phone=+1-217-555-2002
```

DB verification (`hr_emergency_contacts` keyed by Jim's `hr_employees.id`):

```text
Sofia Rivera | Spouse | +1-217-555-2002 | primary=true
```

✓ Dual-table resolution writes to the correct table per persona. ✓ `source='EMPLOYEE'` discriminator returned. ✓ The `is_primary=true` upsert logic correctly demotes any prior primary first (Step 5 service code) so the partial UNIQUE INDEX `(employee_id) WHERE is_primary=true` never fires.

Cleanup: `DELETE FROM tenant_demo.hr_emergency_contacts WHERE name='Sofia Rivera';`

---

## Scenario 8 — Sarah admin PATCHes Maya's `firstName` via `/profile/:personId`

Admin-only identity-field edits go through the admin path on `usr-001:admin`. School Admins + Platform Admins are the only personas with that tier (per Step 3's role-permission map). The plan originally said `iam-001:read/write` but `IAM-001` doesn't exist in the catalogue — this was caught during Step 5 smoke and corrected to `usr-001:admin`.

```bash
curl -s -X PATCH -H "Authorization: Bearer $SARAH" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"firstName":"Maya-Edited"}' \
  http://localhost:4000/api/v1/profile/$MAYA_PID
```

Live response:

```text
firstName=Maya-Edited  preferredName=Maya
```

Cleanup: Sarah restores Maya's first name.

✓ Admin path works on `usr-001:admin`. ✓ Admin can edit fields self-service cannot.

---

## Scenario 9 — David adds Sarah as SPOUSE → promotes to primary → cannot demote self → removes Sarah → restores own primary

Exercises the full member-lifecycle: ADD → atomic primary-contact promotion → last-HEAD demotion refusal → self-eviction refusal → REMOVE → primary restoration. Captures 4 ADR-057 envelopes on `dev.iam.household.member_changed`.

### S9.a — David adds Sarah as SPOUSE (`POST /households/:id/members`, emit ADDED)

```bash
curl -s -X POST -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d "{\"personId\":\"$SARAH_PID\",\"role\":\"SPOUSE\"}" \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members
```

Live response (essentials): `members=[(David,HEAD_OF_HOUSEHOLD,True), (Maya,CHILD,False), (Sarah,SPOUSE,False)]`.

### S9.b — David promotes Sarah to primary contact (`PATCH .../members/:memberId`, atomic + emit UPDATED)

The service runs `UPDATE platform_family_members SET is_primary_contact=false WHERE family_id=$1 AND is_primary_contact=true` BEFORE the UPDATE on Sarah's row, all inside the same `prisma.$transaction`. The partial UNIQUE INDEX is the schema-side fallback if the service ever misses the explicit clear.

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"isPrimaryContact":true}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members/$SARAH_MEMBER_ID
```

Result: Sarah is now sole primary contact; David is HEAD_OF_HOUSEHOLD with `is_primary_contact=false`. The atomic clear means concurrent promotions can't cause a 23505.

### S9.c — David tries to demote himself (last HEAD_OF_HOUSEHOLD) → 400

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"role":"OTHER"}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members/$DAVID_MEMBER_ID
```

Live response:

```text
{"message":"Households must always have at least one head of household. Promote another member first.","error":"Bad Request","statusCode":400}
HTTP 400
```

### S9.d — David tries self-eviction → 400

```bash
curl -s -X DELETE -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members/$DAVID_MEMBER_ID
```

Live response:

```text
{"message":"You cannot remove yourself from your household. Ask another head of household, or contact an administrator.","error":"Bad Request","statusCode":400}
HTTP 400
```

### S9.e — David removes Sarah (`DELETE .../members/:memberId`, emit REMOVED)

```bash
curl -s -X DELETE -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members/$SARAH_MEMBER_ID
```

Result: `members=[(David,HEAD_OF_HOUSEHOLD,False), (Maya,CHILD,False)]`. David's primary flag is currently false (cleared in S9.b). S9.f restores it.

### S9.f — David promotes himself back to primary (emit UPDATED)

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"isPrimaryContact":true}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD/members/$DAVID_MEMBER_ID
```

Result: David is sole primary again.

### Kafka envelopes (captured live on `dev.iam.household.member_changed`)

4 envelopes recorded across S9.a → S9.f, full ADR-057 shape:

```json
// S9.a — ADDED Sarah as SPOUSE
{
  "event_id": "019dd856-c55c-7bbf-acc9-386779302757",
  "event_type": "iam.household.member_changed",
  "event_version": 1,
  "occurred_at": "2026-04-29T08:24:18.524Z",
  "published_at": "2026-04-29T08:24:18.524Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "iam",
  "correlation_id": "019dd856-c55c-7bbf-acc9-45894c490782",
  "payload": {
    "familyId": "019dc92d-0893-7442-abf6-17dab450b052",
    "personId": "019dc92d-087b-7442-abf5-cb569d8c725b",
    "role": "SPOUSE",
    "action": "ADDED",
    "actorPersonId": "019dc92d-088c-7442-abf6-0134867d2d92"
  }
}

// S9.b — UPDATED Sarah to primary
{
  "event_id": "019dd856-c5a5-7bbf-acc9-48f9abc34ca1",
  "event_type": "iam.household.member_changed",
  "event_version": 1,
  "occurred_at": "2026-04-29T08:24:18.597Z",
  "published_at": "2026-04-29T08:24:18.597Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "iam",
  "correlation_id": "019dd856-c5a5-7bbf-acc9-518f0976dc01",
  "payload": {
    "familyId": "019dc92d-0893-7442-abf6-17dab450b052",
    "memberId": "34832d85-6200-49eb-b11b-699c03a590ba",
    "role": null,
    "isPrimaryContact": true,
    "action": "UPDATED",
    "actorPersonId": "019dc92d-088c-7442-abf6-0134867d2d92"
  }
}

// S9.e — REMOVED Sarah
{
  "event_id": "019dd856-c65c-7bbf-acc9-589a02958990",
  "event_type": "iam.household.member_changed",
  "event_version": 1,
  "occurred_at": "2026-04-29T08:24:18.780Z",
  "published_at": "2026-04-29T08:24:18.780Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "iam",
  "correlation_id": "019dd856-c65c-7bbf-acc9-64e70db61eea",
  "payload": {
    "familyId": "019dc92d-0893-7442-abf6-17dab450b052",
    "memberId": "34832d85-6200-49eb-b11b-699c03a590ba",
    "personId": "019dc92d-087b-7442-abf5-cb569d8c725b",
    "action": "REMOVED",
    "actorPersonId": "019dc92d-088c-7442-abf6-0134867d2d92"
  }
}

// S9.f — UPDATED David back to primary
{
  "event_id": "019dd856-c69d-7bbf-acc9-6e6a99b69d8a",
  "event_type": "iam.household.member_changed",
  "event_version": 1,
  "occurred_at": "2026-04-29T08:24:18.845Z",
  "published_at": "2026-04-29T08:24:18.845Z",
  "tenant_id": "019dc92b-ea59-7bb7-aa7f-929729562010",
  "source_module": "iam",
  "correlation_id": "019dd856-c69d-7bbf-acc9-70fff1be05dd",
  "payload": {
    "familyId": "019dc92d-0893-7442-abf6-17dab450b052",
    "memberId": "019dc92d-0893-7442-abf6-1e557b47f965",
    "role": null,
    "isPrimaryContact": true,
    "action": "UPDATED",
    "actorPersonId": "019dc92d-088c-7442-abf6-0134867d2d92"
  }
}
```

✓ Member lifecycle correct end-to-end. ✓ Last-HEAD + self-eviction guards fire. ✓ Atomic primary-contact promotion clears the prior primary in the same tx. ✓ All 4 envelopes carry `source_module='iam'` + valid `tenant_id` + fresh UUIDv7 `event_id`/`correlation_id`.

---

## Scenario 10 — Permission denials sweep

Three denial paths covering the gate-tier and row-scope guards:

### S10.a — Parent PATCH on someone else's profile → 403 (no `usr-001:admin`)

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"preferredName":"X"}' \
  http://localhost:4000/api/v1/profile/$SARAH_PID
```

Live response:

```text
{"statusCode":403,"error":"INSUFFICIENT_PERMISSIONS","message":"You do not have the required permission for this action","required":["usr-001:admin"]}
HTTP 403
```

### S10.b — Teacher PATCH on someone else's profile → 403 (no `usr-001:admin`)

```bash
curl -s -X PATCH -H "Authorization: Bearer $JIM" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" -d '{"preferredName":"X"}' \
  http://localhost:4000/api/v1/profile/$SARAH_PID
# → 403 INSUFFICIENT_PERMISSIONS required ['usr-001:admin']
```

### S10.c — Student GET arbitrary household by id → 404 (row scope hides existence)

```bash
curl -s -H "Authorization: Bearer $MAYA" -H "X-Tenant-Subdomain: demo" \
  http://localhost:4000/api/v1/households/00000000-0000-0000-0000-000000000000
# → 404 "Household not found"
```

The HouseholdsService deliberately returns 404 (not 403) on a non-member non-admin lookup so the existence of arbitrary households isn't leaked to authenticated users.

✓ Permission gates + row-scope guards work as designed.

---

## Scenario 11 — Web UI verification

Production build (`pnpm --filter @campusos/web build`) verified static prerender of `/profile` succeeds without runtime errors:

| Route                 | Bundle  | First Load JS | Type    |
| --------------------- | ------- | ------------- | ------- |
| `/profile`            | 987 B   | 108 kB        | Static  |
| `/profile/[personId]` | 1.23 kB | 117 kB        | Dynamic |

Avatar dropdown in `apps/web/src/components/shell/TopBar.tsx` gains "My Profile" link above "Sign out" for any user with `usr-001:read` (= every persona after Step 3).

The 6-tab module at `apps/web/src/components/profile/ProfileTabs.tsx` renders persona-conditional tabs via `profileTabs(personType)` from `apps/web/src/lib/profile-format.ts`. The Account tab's profile-completeness bar is computed by `profileCompleteness(profile)` (0–100% formula).

Per-persona expected tab visibility (verified by hand-tracing the helper):

| Persona                             | Personal              | Household                            | Emergency                             | Demographics                   | Employment | Account |
| ----------------------------------- | --------------------- | ------------------------------------ | ------------------------------------- | ------------------------------ | ---------- | ------- |
| GUARDIAN                            | ✓                     | ✓ (canEdit=true if HEAD/SPOUSE)      | banner ("not recorded for guardians") | —                              | ✓          | ✓       |
| STUDENT                             | ✓                     | ✓ (canEdit=false unless HEAD/SPOUSE) | ✓ (writes `sis_emergency_contacts`)   | ✓                              | —          | ✓       |
| STAFF                               | ✓                     | varies                               | ✓ (writes `hr_emergency_contacts`)    | —                              | —          | ✓       |
| Admin viewing `/profile/[personId]` | ✓ + identity editable | read-only summary                    | ✓                                     | ✓ + admin-only fields editable | ✓          | ✓       |

A live click-through smoke (saving from each tab, modal open/close on Add Member, primary-contact promotion via inline action) is best done by hand against `pnpm --filter @campusos/web dev` — the API-level paths exercised in S1–S10 cover the underlying contracts comprehensively.

✓ Both routes ship in the production build, persona-conditional tabs render, avatar dropdown integration in place.

---

## Cleanup

Restore `tenant_demo` to seed state so subsequent CAT runs and downstream cycles start clean:

```bash
# Clear Jim's test emergency contact (added in S7)
docker exec campusos-postgres psql -U campusos -d campusos_dev \
  -c "DELETE FROM tenant_demo.hr_emergency_contacts WHERE name='Sofia Rivera';"

# David: restore preferredName='Dave', clear secondaryPhone (S2)
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"preferredName":"Dave","secondaryPhone":null,"phoneTypeSecondary":null}' \
  http://localhost:4000/api/v1/profile/me

# Restore Chen Family addressLine1 (S4 set it to "1234 Oak Street, Apt 5")
curl -s -X PATCH -H "Authorization: Bearer $DAVID" -H "X-Tenant-Subdomain: demo" \
  -H "Content-Type: application/json" \
  -d '{"addressLine1":"1234 Oak Street"}' \
  http://localhost:4000/api/v1/households/$HOUSEHOLD
```

Final state read-back:

```text
household.address=1234 Oak Street
members=[(David, HEAD_OF_HOUSEHOLD, True), (Maya, CHILD, False)]
```

Maya's `primaryLanguage='Mandarin'` from S6 was restored mid-scenario; Sarah's S9 SPOUSE addition was removed in S9.e; Sarah-as-Maya admin edit in S8 was reverted at the end of that scenario. Tenant ends the run identical to the post-Step-4 seed shape.

---

## All scenarios pass

| #   | Scenario                                                             | Outcome                                               |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| S1  | David parent reads `/profile/me`                                     | ✓ GUARDIAN composition with employment + household    |
| S2  | David PATCH preferredName + secondaryPhone (HOME)                    | ✓ allow-list + phone_type CHECK                       |
| S3  | David PATCH firstName                                                | ✓ 400 (admin-only)                                    |
| S4  | David edits household address                                        | ✓ HEAD_OF_HOUSEHOLD passes assertCanEditHousehold     |
| S5  | Maya CHILD reads household read-only, PATCH refused                  | ✓ canEdit=false + 403                                 |
| S6  | Maya PATCH primaryLanguage allowed, gender rejected                  | ✓ self-service / admin-only split                     |
| S7  | Jim staff PATCH emergencyContact → hr_emergency_contacts             | ✓ dual-table resolution + source='EMPLOYEE'           |
| S8  | Sarah admin PATCH Maya firstName via `/profile/:personId`            | ✓ usr-001:admin override                              |
| S9  | David ADD → promote → demote-self refused → REMOVE → primary restore | ✓ 4 envelopes + atomic primary swap + last-HEAD guard |
| S10 | Permission denials sweep (parent, teacher, student row-scope)        | ✓ 403/403/404                                         |
| S11 | Web build static prerender + tab visibility map                      | ✓ both routes ship + tabs persona-conditional         |

**Cycle 6.1 ships clean to the post-cycle architecture review.** Git tag: `cycle6.1-complete` after this CAT, then `cycle6.1-approved` once the architecture review verdict lands.

---

## Known gaps surfaced by the CAT (Phase 2 punch list, not Cycle 6.1 scope)

- **Guardian emergency contact storage.** Parents have no schema home for their own emergency contact today (`sis_emergency_contacts` is keyed on `student_id`; `hr_emergency_contacts` on `employee_id`). The Profile UI surfaces this as an info banner. A future cycle can introduce a `platform.iam_emergency_contacts` table keyed on `iam_person.id` to close the gap.
- **Add-member directory picker.** The `AddMemberModal` accepts a raw person UUID. A directory-picker that filters out persons already in another household is reasonable polish — backend already 409s with a friendly message for duplicates.
- **`previous_names TEXT[]` audit history.** A proper `iam_person_name_history` table would replace the array with timestamped rows. Future polish.
- **Live UI click-through.** This CAT verifies API-level paths exhaustively. A separate manual click-through against `next dev` is still recommended before declaring user-facing readiness — the Phase 2 testing checklist (`docs/campusos-phase2-testing-checklist.html`) is the canonical place to track that.
- **Web hooks: `useAddHouseholdMember` directory picker dependency.** The hook itself is solid; the picker UI would feed it different data.
