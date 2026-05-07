# Incident Communication Templates

**Cycle 32 Step 7.** The exact wording the on-call team uses when
communicating with schools during an incident. Pre-approved by the
schools relations team and the legal team — operators send these
verbatim, only filling in the bracketed values.

---

## T1 — Initial incident notification (within 5 minutes of detection)

**Channel:** All affected school admins via in-app notification +
email + SMS (for severity PAGE).

**Subject:** CampusOS service disruption

**Body:**

> CampusOS is experiencing a service disruption that may affect [scope:
>
> > attendance / grading / messaging / login / etc.]. Our team is
> > actively investigating. Your data is safe. We expect to resolve this
> > within [ETA window — e.g. "the next 30 minutes"]. We will send the
> > next update at [specific time — e.g. "10:30 AM ET"].

---

## T2 — 30-minute / 60-minute progress update

**Channel:** same as T1.

**Subject:** CampusOS service disruption — update [N]

**Body:**

> [Scope] is still being restored. Progress so far: [1-line summary].
> Current ETA for full resolution: [ETA]. We will send the next update
> at [specific time]. Thank you for your patience.

---

## T3 — Resolution notification

**Channel:** same as T1.

**Subject:** CampusOS service restored

**Body:**

> Service has been fully restored as of [time, with timezone]. The
> incident affected [scope] for [duration, e.g. "approximately 18
>
> > minutes"]. No data was lost. We will share a detailed incident
> > report within 48 hours.

---

## T4 — Data corruption / partial data loss notification (rare)

**Channel:** affected school admins only, plus the school's primary
contact via direct phone call from a senior engineer.

**Subject:** CampusOS service notice — important

**Body:**

> A data integrity issue was detected in CampusOS at [time]. We have
> isolated the affected systems and are restoring from a known-good
> backup taken at [timestamp]. Data written between [start] and [end]
> may need to be re-entered. Affected modules: [list]. We are working
> with [N] schools that are impacted.
>
> What you should do now:
>
> - [List specific actions, if any. Often "no action required, we
>   > will email you again with re-entry guidance".]
>
> A senior engineer is available at [contact] to answer questions
> directly. We will send a full timeline within 24 hours.

---

## T5 — Post-incident report (within 48 hours)

**Channel:** affected school admins via email + posted to the
CampusOS status page.

**Subject:** Post-incident report — [date]

**Body sections:**

1. **Summary** — one paragraph, plain-English description of what
   happened and what was done.
2. **Timeline** — 5-minute granularity from first alert through full
   resolution. Include who was paged, what was tried, what worked.
3. **Root cause** — the technical cause. Avoid blaming individuals.
4. **Impact** — number of schools affected, duration of degradation,
   data loss (if any).
5. **What went well** — paths that worked correctly during the
   incident.
6. **What didn't** — gaps, slow alerts, unclear runbook steps.
7. **Action items** — specific changes with owners + deadlines that
   prevent recurrence.
8. **Apology** — direct, owned, no qualifying language.

---

## Internal escalation matrix

Distinct from the external comms above, the internal team activation
sequence:

| Severity | Page within               | Notify within  | Escalate within                 |
| -------- | ------------------------- | -------------- | ------------------------------- |
| WARNING  | n/a                       | 1 hour (Slack) | n/a                             |
| CRITICAL | n/a                       | 15 min (Slack) | 1 hour (architecture)           |
| PAGE     | 5 min (PagerDuty primary) | 5 min (Slack)  | 15 min (architecture secondary) |

For data-residency incidents (EU tenant data leaves EU), the DPO
on-call (`campusos-dpo-primary` PagerDuty escalation) is paged
unconditionally, regardless of overall severity. This is the GDPR
Article 33 keystone — see `infra/runbooks/breach-72hour.md`.

---

## SMS (high-severity only)

For Scenario 4 (full regional failure), school admins receive a 160-
character SMS in addition to the in-app/email channel:

> CampusOS is currently down. We are restoring service. Estimated
> resolution: [ETA, e.g. "10:30 AM ET"]. Updates: status.campusos.com

The SMS list is pre-cached in the standby region's Redis on a daily
cron so it survives a primary-region outage without depending on the
primary database.
