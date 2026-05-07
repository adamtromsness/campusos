# Tabletop Exercise — 2026-Q2

**Date:** 2026-05-07 (Cycle 32 Step 10 first exercise).
**Duration:** 2 hours.
**Facilitator:** ops engineering lead.
**Scenario:** Full regional failure during morning attendance with an
in-flight Emergency Alert.

---

## Scenario brief (as presented)

> It's Tuesday 2026-05-12, 10:30 AM ET. us-east-1 reports a major
> outage affecting all services. 200 schools are in the middle of
> morning attendance. The Emergency Alert service was processing a
> lockdown drill at one of the largest school districts when the
> outage began. Walk through the response.

Inject 1 (10 min in): "The EU shard is unaffected and is taking
extra read traffic from US tenants. Latency is high but stable. Do
nothing or take action?"

Inject 2 (25 min in): "Three school admins call the support line
asking why they can't take attendance. The pre-cached SMS list is
~2 hours old; some new admins added this morning are not on it."

Inject 3 (45 min in): "A parent in California is asking via Twitter
why she can't see her child's grades."

---

## Decision log

| Time | Who            | Decision                                                                                                                                                                 | Rationale                                                |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| T+00 | IC declares P1 | Activate runbook Scenario 4 (full regional failure)                                                                                                                      | Multiple symptoms reported; alert fan-out fires          |
| T+02 | IC             | Initial T1 comms via in-app + email + SMS (pre-cached list)                                                                                                              | Communication lead                                       |
| T+03 | Eng            | Trigger DNS failover via Route 53 health check                                                                                                                           | Standard runbook step                                    |
| T+05 | Eng            | Confirm Global Database promotion in us-west-2                                                                                                                           | RDS console + CloudWatch                                 |
| T+06 | DPO observer   | Confirm EU tenants unaffected; no data residency action needed                                                                                                           | EU shard separate Global DB                              |
| T+07 | Comms          | Inject 1 response: "Don't reroute EU traffic to US, even read traffic. Treat EU as healthy. Watch latency."                                                              | Cycle 30 data-residency contract                         |
| T+09 | Eng            | Verify Kafka consumers resume from translated offsets in us-west-2                                                                                                       | Cycle 31 Step 9 admin DLQ dashboard shows 0 new arrivals |
| T+12 | Eng            | Confirm Redis cold-start rebuild complete (`redis_cache_misses_total` drop-off)                                                                                          | Step 4 expected                                          |
| T+14 | IC             | Smoke tests against us-west-2 PASS; declare service restored                                                                                                             | RTO target met (<15 min)                                 |
| T+15 | Comms          | T3 resolution notification                                                                                                                                               | Standard template                                        |
| T+25 | Comms          | Inject 2 response: "We have 3 admins missing from the SMS list. Manual phone outreach for them. Update the SMS-cache cron to refresh every 30 minutes instead of daily." | Action item                                              |
| T+45 | Comms          | Inject 3 response: "Twitter response template. Acknowledge publicly + DM for personalised support."                                                                      | Did not exist before this exercise                       |

---

## Gaps identified

1. **SMS pre-cache cadence.** Daily was too slow. Schools onboard
   new admins more often than daily during peak. **Action:** update
   the Cycle 32 Step 7 SMS pre-cache cron to refresh every 30
   minutes. Owner: ops eng. Deadline: 2026-05-15.

2. **No public Twitter / social media playbook.** The Cycle 32 Step
   7 communication templates cover school-admin notifications but
   not public social channels. **Action:** add a T6 template for
   social media response (acknowledgement + DM redirect). Owner:
   schools relations + marketing. Deadline: 2026-05-21.

3. **Runbook step ordering ambiguity.** Step 5 (validate consumer
   resume) and Step 6 (validate cache rebuild) ran in parallel
   during the exercise, but the runbook implies sequential. **Action:**
   clarify in `dr-runbook.md` Scenario 4 that steps 5 + 6 + 7 can
   run in parallel after step 4. Owner: architecture lead.
   Deadline: 2026-05-12 (the runbook update commit).

4. **Customer-impact estimate fuzzy.** The IC didn't have a
   pre-built dashboard showing "schools affected" / "students
   affected". They had to compute it ad-hoc from request volume.
   **Action:** add an `Incident Impact` Grafana dashboard that pulls
   from `http_requests_total{tenant_id=...}` to count active
   schools in the previous 5 minutes. Owner: observability eng.
   Deadline: 2026-05-31.

5. **DPO observer was passive.** The DPO observer's role was
   ill-defined — they confirmed EU data residency but had no
   authority. **Action:** add a "DPO veto" line to the framework:
   when the DPO observer flags a data-residency concern, the IC
   pauses any decision involving cross-region data flow until the
   DPO greenlights it. Owner: legal + DPO. Deadline: 2026-06-15.

---

## What went well

- Runbook Scenario 4 was followed cleanly. RTO target (<15 min)
  met by 1 minute.
- Communication templates worked as written; no improvisation
  needed for T1 / T3.
- Cross-region replication metrics were visible on the Grafana
  dashboard the IC pulled up immediately.
- The DPO observer caught the EU data-residency concern proactively
  before anyone proposed cross-region rerouting.

## What didn't

- Inject 2 (stale SMS cache) hit a real, fixable gap that hadn't
  been tested.
- Inject 3 (social media) was completely outside the runbook.
- Roles for "support line" calls during incidents were unclear —
  who fields them? The schools relations rep on the call?

---

## Updated runbook

Following the action items above, the next runbook revision lands
within 7 days. The revisions:

- `dr-runbook.md` Scenario 4 — clarify steps 5/6/7 may run in
  parallel.
- `communication-templates.md` — add T6 social-media response.
- New runbook section on **support-line ownership during incidents**
  (schools relations rep is the named contact).

---

## Next exercise

2026-Q3 (target date 2026-08-15). Scenario: novel — "Misconfigured
deploy: production deploy went out with `AWS_REGION=us-east-1`
baked in for a tenant that should be on `eu-west-2`. The Cycle 32
Step 6 RegionMismatchInterceptor returns 421 for every EU request.
How long until the team notices? How do they roll back?"
