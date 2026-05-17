# AI Data Policy

**Production-launch prerequisite.** Defines what student data CampusOS may
send to third-party AI providers (OpenAI, Anthropic, etc.) and how
inferences flow back into the system.

P2-H4 Step 4 deliverable. Closes Plan IMP-03 and GPT SEC-02 audit findings.

## 1. Scope

Applies to every AI-driven feature in CampusOS:

- M21 Classroom Advanced: AI tutoring sessions, AI grading suggestions,
  lesson video summaries.
- M40 Communications Advanced: AI moderation, AI translation.
- M41 Meetings Advanced: AI minutes / transcription.
- M110 Analytics: at-risk early-warning system (uses model outputs but
  reads them from internal materialised columns; does not re-call
  providers).

Does **not** apply to deterministic rule-based features (e.g. attendance
auto-tasks, behaviour rule triggers, GL posting, allergen cross-check).

## 2. Hard Categorical Exclusions

The following categories are **never** sent to AI providers, even with
consent:

| Category                                                                                         | Stored in                                           | Reason                                      |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------- |
| Health records (medications, conditions, immunisations, IEPs, screenings, dietary, nurse visits) | `hlth_*`                                            | HIPAA-protected; ADR-040 KMS isolation      |
| Behaviour disciplinary records (incidents, actions, BIP detail)                                  | `sis_discipline_*`, `svc_behavior_plans`            | FERPA-protected; risk of profiling          |
| Counselling session notes, FERPA-protected                                                       | `svc_session_notes`                                 | FERPA + clinical confidentiality            |
| Wellbeing check-in responses                                                                     | `svc_wellbeing_responses`                           | Self-harm indicator handling per Cycle 11.1 |
| Coordinated care notes                                                                           | `svc_coordinated_care_notes`                        | Health + counselling intersection           |
| Mandatory reports (CPS filings)                                                                  | `svc_mandatory_reports`                             | Legal record + child-safety risk            |
| Visitor banned-persons list                                                                      | `vis_banned_persons`                                | ADR-015 third-party data restriction        |
| HR salary, payroll, performance reviews                                                          | `hr_payroll_records`, `hr_performance_reviews`      | Internal HR confidentiality                 |
| Financial transactions (payments, refunds, ledger)                                               | `pay_*`, `fin_*`                                    | PCI-adjacent + audit integrity              |
| DPO breach records, SAR contents                                                                 | `dpo_*`                                             | Regulatory record                           |
| Verification documents (DBS, work auth, transcripts)                                             | `hr_employee_documents`, `sis_transcript_documents` | Third-party data                            |

Even where a feature could plausibly benefit (e.g. AI summarisation of a
counselling note for a brief), the policy is "do not send" — the audit
risk and reputational risk of provider-side leakage outweigh the
classroom benefit.

## 3. PII Minimisation Before Provider Calls

Where AI is in scope (classroom tutoring, lesson summaries, message
moderation, meeting minutes), payloads sent to providers must be
**pseudonymised** before they leave the API process.

### 3.1 Replacement scheme

Per AI session, the service generates a stable pseudonym map:

```
{
  "<sis_students.id>": "Student-A",
  "<sis_students.id>": "Student-B",
  "<hr_employees.id>": "Teacher-1",
  ...
}
```

The map is kept in-memory for the duration of the request, written to
`cls_ai_tutoring_sessions.pseudonym_map_encrypted` (AES-256-GCM with the
SIS_LOCKER_KEY pattern) when the session is persisted, and used to
reverse the response before storing.

Fields replaced:

- Student first + last + preferred names.
- Teacher first + last names.
- Guardian first + last names + email + phone.
- School name (replaced with "School-N").
- Class section codes (replaced with "Class-N").

Fields **not** replaced because they have no PII content (audit logged
nonetheless):

- Assignment titles, question text, rubric criteria.
- Lesson titles, lesson plan content (rubric-style, not narrative).

### 3.2 Verification

The PII minimisation pipeline must:

1. Apply the replacement before the HTTP request to the provider.
2. Log to `cls_ai_inference_log` with `pii_minimisation_applied=true`
   and a hash of the outbound payload (for audit replay without
   storing the raw payload).
3. Reject the call if any of the hard categorical exclusions (§2) are
   detected in the payload via a string-match deny-list.
4. On response, reverse the pseudonym map before persisting any model
   output.

## 4. Provider Configuration

Required provider-side settings:

| Provider  | Setting            | Required value                                  |
| --------- | ------------------ | ----------------------------------------------- |
| OpenAI    | `data_retention`   | `0` (zero-retention API tier)                   |
| OpenAI    | Training opt-out   | `true`                                          |
| Anthropic | Data retention     | 0-day (enterprise account, contract addendum)   |
| Anthropic | Training opt-out   | `true`                                          |
| Generic   | Geographic region  | EU tenants → EU region; US tenants → US region  |
| Generic   | Sub-processor list | Reviewed annually; recorded in `dpo_processors` |

If a provider does not offer zero-retention or training opt-out, that
provider may not be used for any CampusOS feature.

## 5. Opt-Out Effect

A student or guardian (acting on behalf) may opt out of AI tutoring at
any time. The opt-out is stored as a row in
`cls_ai_tutoring_opt_outs(student_id, opted_out_at, opted_out_by_account_id)`.

On opt-out, within 24 hours:

- All future `cls_ai_tutoring_sessions` creation for that student is
  rejected at the service layer (403 with "Student is opted out of AI
  tutoring").
- All existing `cls_ai_tutoring_sessions`, `cls_ai_tutoring_messages`,
  and `cls_ai_tutoring_learning_signals` rows for that student are
  **hard-deleted** by a sweep worker. The opt-out row remains as audit.
- Provider-side data is requested for deletion via the provider's
  "right to be forgotten" endpoint (where supported), with the
  request id logged to `dpo_pseudonymisation_log` for audit.

Opt-out is irreversible from the student / guardian side. Re-enabling
requires an admin transition with `cou-004:admin` or `sch-001:admin`
permission and a documented justification.

## 6. Model Output Audit Retention

Model outputs that land in CampusOS (AI grading suggestions, lesson
summaries, AI minutes, moderation verdicts) are retained in their
respective domain tables (`cls_grades.ai_suggested_grade`,
`cls_lesson_summaries.summary_text`, `mtg_ai_minutes.minutes_text`,
`msg_moderation_log.ai_verdict_text`) per the table's normal retention.

Inference call audit rows live in `cls_ai_inference_log` with:

- Request hash, response hash, provider, model, latency, token counts.
- Pseudonymisation flag.
- Trigger event id (correlation with the originating request).

After 90 days, `cls_ai_inference_log` rows are **pseudonymised** (request
hash and response hash redacted; per-row tally counters retained for
analytics). The `dpo_pseudonymisation_log` records the bulk action with
`source_module='ai'` and the date range.

## 7. Implementation Status

As of P2-H4:

- Classroom AI tutoring (M21 advanced) ships the schema for sessions /
  messages / opt-outs / learning signals / inference log.
- The pseudonym replacement pipeline is **not yet wired** in the
  service layer. Phase 3 work: extract a shared
  `apps/api/src/ai/pseudonymiser.service.ts` that every AI-calling
  service routes through, and add the deny-list enforcement.
- Opt-out sweep worker (§5) is **not yet wired**. Phase 3 work:
  `apps/api/src/ai/opt-out-sweep.worker.ts` scheduled daily.
- Hard categorical exclusions (§2) are documented here. Phase 3
  audit: grep every AI-calling service to confirm no excluded data
  leaves the API process.

## 8. Audit + Review

This policy is reviewed annually by the DPO and the Engineering Lead.
Any change to the categorical exclusions (§2) requires:

- DPO sign-off.
- Engineering Lead sign-off.
- Update to `dpo_processing_activities` to reflect the new lawful basis.
- Update to the privacy notice presented at consent time.

Changes to provider configuration (§4) require DPO sign-off only.
