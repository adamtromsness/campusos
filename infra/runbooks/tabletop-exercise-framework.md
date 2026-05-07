# Quarterly Tabletop Exercise Framework

**Cycle 32 Step 10.** Quarterly facilitated walkthrough of a
disaster scenario with the full engineering + ops team. Two-hour
slot. The point is not to break anything — it's to find the gaps in
the runbook + the team's mental model BEFORE a real incident finds
them.

## Cadence

- Every quarter, on a calendar date scheduled 30 days in advance.
- Rotate scenarios — at least one of the six runbook scenarios per
  year, plus at least one "novel" scenario the runbook doesn't yet
  cover.
- 2 hours: 30 min scenario brief + 60 min walkthrough + 30 min
  retrospective.

## Roles

- **Facilitator** — runs the exercise, presents the scenario in
  bite-sized injects, takes notes. Rotates each quarter; never the
  on-call engineer.
- **Incident commander** — leads the response per the runbook.
  Rotates each quarter (good practice for everyone on the IC roster).
- **Communications lead** — drafts comms using the templates,
  practises the verbatim language.
- **DPO observer** — present if the scenario involves PII (data
  corruption, regional failure that touches EU tenants).
- **Engineering / ops team** — everyone else, in role.

## Format

1. **Scenario brief (30 min).** The facilitator presents the
   starting state: time of day, what's failing, who's reporting it,
   what the customer impact is. Team has 5 minutes to read; then
   the IC declares the incident severity and starts the response.

2. **Walkthrough (60 min).** Team follows the runbook step by step.
   Facilitator injects new information at pre-planned intervals
   (the failover takes longer than expected; a second tenant reports
   a different symptom; a parent in the EU calls about access). The
   IC adapts. The team logs decisions, gaps, and questions in real
   time in a shared doc.

3. **Retrospective (30 min).** Open discussion:
   - What worked?
   - What was unclear in the runbook?
   - What information did the IC wish they had earlier?
   - What action items would prevent this from being painful next
     time?

## Deliverables per exercise

- **Decision log** — who decided what, when, on what evidence.
- **Gap identification** — runbook steps that were unclear,
  incomplete, or wrong.
- **Action items** — remediation items with owners + deadlines.
- **Updated runbook** — incorporate lessons learned within 7 days.

## Library of scenarios

### From the DR runbook (`infra/runbooks/dr-runbook.md`)

1. Single instance failure (rarely interesting; useful for
   onboarding new IC).
2. Availability Zone failure.
3. Primary database failure.
4. Full regional failure.
5. Kafka cluster failure.
6. Data corruption.

### Novel scenarios (rotate these in)

- **Partial replication failure.** us-east-1 → us-west-2 lag spikes
  to 2 minutes mid-day; on-call must decide whether to fail over
  preemptively.
- **DPO breach during a regional failover.** A SAR comes in for an
  EU tenant during a us-east-1 outage. The home-region routing
  works, but the EU primary's standby is also degraded.
- **Cascading dependency outage.** Stripe is down + the IAM Redis
  cache breaker is OPEN simultaneously. Payments + login both
  affected.
- **Misconfigured deploy.** A production deploy went out with
  `AWS_REGION=us-east-1` baked in for a tenant that should be on
  `eu-west-2`. The Cycle 32 Step 6 RegionMismatchInterceptor
  returns 421 for every EU request. How long until the team
  notices? How do they roll back?
- **DLQ flood.** An upstream producer bug causes 50,000 DLQ rows
  in 10 minutes. The Cycle 31 Step 8 alert fires immediately;
  on-call must decide whether to halt the producer or fix forward.
- **Tabletop on the tabletop.** A scenario where the tabletop itself
  reveals a gap in the runbook (meta-exercise; reserved for the
  most-experienced facilitator).

## Output retention

- Decision log + gap identification + action items: stored at
  `infra/runbooks/tabletop-exercise-YYYY-Q[1-4].md` for at least 5
  years (longer if it informs a real-incident retrospective).
- Updated runbook: committed to source control with a reference to
  the exercise that drove the change.

## Sign-off

The DR readiness checklist (`dr-readiness-checklist.md`) requires a
tabletop exercise within the last 90 days. Failure to conduct a
quarterly tabletop drops the platform out of compliance with the
DR readiness gate.
