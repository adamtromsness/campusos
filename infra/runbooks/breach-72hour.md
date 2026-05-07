# Runbook: GDPR Breach 72-Hour Notification Deadline

**Alert:** `BreachNotificationDeadlineWithin2Hours` (PAGE)
**Owner:** DPO on-call (primary), campusos-platform on-call (secondary)

## What it means

An active `dpo_data_breach_records` row has `notificationDeadline` (= discovery + 72h) within 2 hours and `supervisoryAuthorityNotificationRequired=true`. **Missing this window is a regulatory violation** under GDPR Article 33.

## Immediate actions

1. Open the breach in `/governance/breaches/<id>` on the admin portal.
2. Confirm with the DPO that the supervisory authority notification has either:
   a. Already been sent (mark via `Notify supervisory authority` action with the reference number), OR
   b. Is in flight (DPO confirms via Slack #campusos-dpo)
3. If neither (a) nor (b), the DPO must file the notification immediately and update the record. Bypass any non-emergency steps — the regulatory clock does not pause for triage.

## Backstop: TaskWorker

The Cycle 7 TaskWorker subscribes to `dpo.breach.discovered` and creates an URGENT 72-hour escalating task on every school admin's list. This alert is the second tier of defence; if it fires it means the URGENT task was not closed. Investigate why.

## Post-incident

- Capture the timeline in the breach record's investigation notes.
- File an internal post-mortem within 7 days regardless of whether the deadline was met.
- Review `dpo.breach.discovered` envelope landed correctly in DLQ status — if the topic was parked, the TaskWorker never received it.

## Escalation

Page primary DPO on-call immediately. If unreachable within 15 minutes, escalate to the school principal AND the secondary platform on-call.
