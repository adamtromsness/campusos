import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-dpo.ts — Cycle 30 Step 4.
 *
 * M120 DPO Compliance Suite. Idempotent — gated on whether
 * dpo_processing_activities already has at least one row for the
 * demo school.
 *
 * Tenant-only seed targeting tenant_demo (test tenant stays empty
 * by convention):
 *   - 5 processing activities (1 high_risk + 1 with no DPIA = the
 *     DPIA gap row that surfaces on the compliance dashboard).
 *   - 3 retention policies: Academic 7y FERPA / Health 25y / CCTV 30d.
 *   - 1 DPIA: Biometric Attendance, COMPLETED + APPROVED, residual=LOW.
 *   - 4 third-party processors (AWS active + DPA / Stripe active + DPA
 *     / OpenAI no DPA = gap / Google expired DPA = gap).
 *   - 2 DPAs (AWS active, Stripe active).
 *   - 1 data breach record: Stolen Laptop, THEFT, HIGH, 72h ticking.
 *   - 1 SAR: David Chen for Maya, IN_PROGRESS, deadline +25d.
 *   - 1 erasure request: PARTIALLY_COMPLETED.
 *   - 1 pseudonymisation log entry: 47 audit_log rows pseudonymised.
 *   - 3 consent records: 2 active CONSENTED + 1 WITHDRAWN.
 *   - 1 privacy notice v2.1.
 *   - 1 compliance dashboard config (30-day SAR, 70-hour breach escalation).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function main() {
  const client = getPlatformClient();

  const routingRows = (await client.$queryRawUnsafe(
    'SELECT schema_name FROM platform.platform_tenant_routing WHERE schema_name = $1 LIMIT 1',
    TENANT_SCHEMA,
  )) as Array<{ schema_name: string }>;
  if (routingRows.length === 0) {
    console.error(`Tenant ${TENANT_SCHEMA} not provisioned — run pnpm seed first`);
    process.exit(1);
  }

  const schoolRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, organisation_id::text AS organisation_id FROM platform.schools LIMIT 1',
  )) as Array<{ id: string; organisation_id: string }>;
  const schoolId = schoolRows[0]!.id;
  const organisationId = schoolRows[0]!.organisation_id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    `SELECT 1 FROM ${TENANT_SCHEMA}.dpo_processing_activities WHERE school_id = $1::uuid LIMIT 1`,
    schoolId,
  )) as Array<unknown>;
  if (existing.length > 0) {
    console.log('DPO seed already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  // ─── Resolve identities + cross-cycle anchors ───
  const principalRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_users WHERE email = 'principal@demo.campusos.dev' LIMIT 1`,
  )) as Array<{ id: string }>;
  const principalAccountId = principalRows[0]?.id ?? null;

  const parentRows = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_users WHERE email = 'parent@demo.campusos.dev' LIMIT 1`,
  )) as Array<{ id: string }>;
  const parentAccountId = parentRows[0]?.id ?? null;

  // Maya Chen — student data subject for SAR + erasure
  const mayaRows = (await client.$queryRawUnsafe(
    `SELECT ip.id::text AS person_id
       FROM ${TENANT_SCHEMA}.sis_students s
       JOIN platform.platform_students ps ON ps.id = s.platform_student_id
       JOIN platform.iam_person ip ON ip.id = ps.person_id
      WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen' LIMIT 1`,
  )) as Array<{ person_id: string }>;
  const mayaPersonId = mayaRows[0]?.person_id ?? null;

  // David Chen — guardian who submits SARs
  const davidRows = (await client.$queryRawUnsafe(
    `SELECT ip.id::text AS person_id
       FROM platform.iam_person ip
      WHERE ip.first_name = 'David' AND ip.last_name = 'Chen' LIMIT 1`,
  )) as Array<{ person_id: string }>;
  const davidPersonId = davidRows[0]?.person_id ?? null;

  console.log('DPO seed — context resolved:');
  console.log(
    `  schoolId=${schoolId.slice(0, 8)}... organisationId=${organisationId.slice(0, 8)}...`,
  );
  console.log(`  principalAccountId=${principalAccountId?.slice(0, 8) ?? 'null'}...`);
  console.log(`  parentAccountId=${parentAccountId?.slice(0, 8) ?? 'null'}...`);
  console.log(`  mayaPersonId=${mayaPersonId?.slice(0, 8) ?? 'null'}...`);
  console.log(`  davidPersonId=${davidPersonId?.slice(0, 8) ?? 'null'}...`);

  if (!principalAccountId || !mayaPersonId || !davidPersonId) {
    console.error('Missing required identities — run platform + sis seeds first');
    process.exit(1);
  }

  // ─── A) 3 Retention Policies ───
  const academicRetentionId = generateId();
  const healthRetentionId = generateId();
  const cctvRetentionId = generateId();
  const today = new Date().toISOString().slice(0, 10);
  const inOneYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_retention_policies
     (id, school_id, data_category, retention_period, legal_basis_for_retention, review_frequency, last_reviewed_at, next_review_date, reviewed_by, links_to_archive_tier, notes)
     VALUES ($1::uuid, $2::uuid, 'Academic Records', '7 years from graduation', 'FERPA + state education code', 'ANNUAL', $3::date, $4::date, $5::uuid, 'cls_grades / cls_submissions / sis_attendance_records', 'FERPA-aligned retention; archive tier referenced for read access post-retention.')`,
    academicRetentionId,
    schoolId,
    today,
    inOneYear,
    principalAccountId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_retention_policies
     (id, school_id, data_category, retention_period, legal_basis_for_retention, review_frequency, last_reviewed_at, next_review_date, reviewed_by, links_to_archive_tier, notes)
     VALUES ($1::uuid, $2::uuid, 'Health & Medical Records', '25 years (medical records standard)', 'Public Health Act + safeguarding obligations', 'ANNUAL', $3::date, $4::date, $5::uuid, 'hlth_health_records / hlth_medications / hlth_iep_plans', 'Long-tail retention covers paediatric medical history obligations.')`,
    healthRetentionId,
    schoolId,
    today,
    inOneYear,
    principalAccountId,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_retention_policies
     (id, school_id, data_category, retention_period, legal_basis_for_retention, review_frequency, last_reviewed_at, next_review_date, reviewed_by, links_to_archive_tier, notes)
     VALUES ($1::uuid, $2::uuid, 'CCTV Footage', '30 days rolling', 'Legitimate interests — campus security', 'ANNUAL', $3::date, $4::date, $5::uuid, 'fac_cctv_recordings (M65 future)', 'Auto-purged at 30 days unless flagged for incident review.')`,
    cctvRetentionId,
    schoolId,
    today,
    inOneYear,
    principalAccountId,
  );
  console.log('  ✓ 3 retention policies (Academic 7y / Health 25y / CCTV 30d)');

  // ─── B) 1 DPIA (Biometric Attendance — completed + approved) ───
  const dpiaBioId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_dpias
     (id, school_id, processing_activity_id, dpia_title, trigger_reason, status, description_of_processing, necessity_proportionality_assessment, risks_identified, residual_risk_level, dpo_opinion, supervisory_authority_consultation_required, completed_at, completed_by, approved_by, document_s3_key)
     VALUES ($1::uuid, $2::uuid, NULL, 'Biometric Attendance Pilot DPIA', 'New processing of biometric data (fingerprint scan for class entry).', 'APPROVED', 'Optical fingerprint scan at classroom entry, immediately hashed and stored as one-way template.', 'Less intrusive than swipe cards (no token to lose), more accurate than name-call. Necessity established. Proportionality satisfied via opt-out + retention limit.', $3::jsonb, 'LOW', 'Approved with conditions: opt-out path documented, templates auto-purged on student withdrawal, sub-processor agreement signed.', false, $4::date, $5::uuid, $6::uuid, 's3://campusos-dpo/dpia/biometric-attendance-v1.pdf')`,
    dpiaBioId,
    schoolId,
    JSON.stringify([
      {
        risk_description: 'Template re-identification by attacker with rainbow tables',
        likelihood: 'low',
        severity: 'medium',
        mitigation_measures: 'Per-school salt + bcrypt-strength hashing + at-rest encryption.',
      },
      {
        risk_description: 'Function creep — repurposing for other identification',
        likelihood: 'medium',
        severity: 'medium',
        mitigation_measures:
          'Hard-coded purpose limitation in attendance.service.ts; access scoped at row layer.',
      },
    ]),
    today,
    principalAccountId,
    principalAccountId,
  );
  console.log('  ✓ 1 DPIA (Biometric Attendance, COMPLETED+APPROVED, residual=LOW)');

  // ─── C) 5 Processing Activities (1 high_risk no DPIA = gap; 1 high_risk with DPIA) ───
  const paAttendance = generateId();
  const paGradebook = generateId();
  const paBiometric = generateId();
  const paAiTutor = generateId();
  const paCctv = generateId();

  // PA1 — Attendance (low risk, retention linked)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_activities
     (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_policy_id, transfers_outside_uk_eea, transfer_safeguards, automated_decision_making, profiling, high_risk_processing, dpia_id, is_active, last_reviewed_at, reviewed_by, notes)
     VALUES ($1::uuid, $2::uuid, 'Daily Attendance Marking', 'Statutory record-keeping for school attendance compliance.', 'LEGAL_OBLIGATION', $3::text[], $4::text[], $5::uuid, false, NULL, false, false, false, NULL, true, $6::date, $7::uuid, NULL)`,
    paAttendance,
    schoolId,
    ['Attendance status', 'Date / time', 'Class enrolment'],
    ['Students', 'Pupils'],
    academicRetentionId,
    today,
    principalAccountId,
  );
  // PA2 — Gradebook (low risk)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_activities
     (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_policy_id, transfers_outside_uk_eea, transfer_safeguards, automated_decision_making, profiling, high_risk_processing, dpia_id, is_active, last_reviewed_at, reviewed_by, notes)
     VALUES ($1::uuid, $2::uuid, 'Gradebook & Assessment Records', 'Recording academic achievement for progression and reporting.', 'LEGAL_OBLIGATION', $3::text[], $4::text[], $5::uuid, false, NULL, false, false, false, NULL, true, $6::date, $7::uuid, NULL)`,
    paGradebook,
    schoolId,
    ['Assessment scores', 'Teacher comments', 'Submission text'],
    ['Students'],
    academicRetentionId,
    today,
    principalAccountId,
  );
  // PA3 — Biometric Attendance (high risk, has DPIA — link DPIA back later)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_activities
     (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_policy_id, transfers_outside_uk_eea, transfer_safeguards, automated_decision_making, profiling, high_risk_processing, dpia_id, is_active, last_reviewed_at, reviewed_by, notes)
     VALUES ($1::uuid, $2::uuid, 'Biometric Attendance Scanning', 'Frictionless classroom-entry attendance via fingerprint template.', 'CONSENT', $3::text[], $4::text[], $5::uuid, false, NULL, false, false, true, $8::uuid, true, $6::date, $7::uuid, 'Opt-out path: traditional roll-call. DPIA required + completed.')`,
    paBiometric,
    schoolId,
    ['Biometric template (hashed)', 'Class entry timestamp'],
    ['Students (opt-in only)'],
    academicRetentionId,
    today,
    principalAccountId,
    dpiaBioId,
  );
  // PA4 — AI Tutor Recommendations (HIGH RISK + NO DPIA = the gap row)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_activities
     (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_policy_id, transfers_outside_uk_eea, transfer_safeguards, automated_decision_making, profiling, high_risk_processing, dpia_id, is_active, last_reviewed_at, reviewed_by, notes)
     VALUES ($1::uuid, $2::uuid, 'AI-Driven Tutor Recommendations', 'OpenAI-backed recommendation of remediation activities based on submission patterns.', 'LEGITIMATE_INTERESTS', $3::text[], $4::text[], NULL, true, 'Standard Contractual Clauses', false, true, true, NULL, true, $5::date, $6::uuid, 'OUTSTANDING — DPIA required because of profiling + automated content generation, not yet started. Surfaces as a red row on the compliance dashboard.')`,
    paAiTutor,
    schoolId,
    ['Submission text', 'Assessment scores', 'Behaviour patterns'],
    ['Students'],
    today,
    principalAccountId,
  );
  // PA5 — CCTV
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_activities
     (id, school_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_policy_id, transfers_outside_uk_eea, transfer_safeguards, automated_decision_making, profiling, high_risk_processing, dpia_id, is_active, last_reviewed_at, reviewed_by, notes)
     VALUES ($1::uuid, $2::uuid, 'Campus CCTV', 'Safeguarding + asset protection.', 'LEGITIMATE_INTERESTS', $3::text[], $4::text[], $5::uuid, false, NULL, false, false, false, NULL, true, $6::date, $7::uuid, NULL)`,
    paCctv,
    schoolId,
    ['Video footage', 'Audio (entrances only)'],
    ['Pupils', 'Staff', 'Visitors'],
    cctvRetentionId,
    today,
    principalAccountId,
  );
  console.log(
    '  ✓ 5 processing activities (1 high_risk no DPIA = gap, 1 high_risk + DPIA, 3 standard)',
  );

  // ─── D) 4 Processors + 2 DPAs ───
  const procAws = generateId();
  const procStripe = generateId();
  const procOpenai = generateId();
  const procGoogle = generateId();
  const dpaAws = generateId();
  const dpaStripe = generateId();
  const inSixMonths = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // AWS — DPA in place
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_third_party_processors
     (id, school_id, processor_name, processor_type, registered_country, data_categories_processed, dpa_in_place, dpa_id, adequacy_decision_applicable, transfer_mechanism, last_reviewed_at, next_review_date, notes)
     VALUES ($1::uuid, $2::uuid, 'Amazon Web Services EMEA SARL', 'CLOUD_INFRASTRUCTURE', 'Luxembourg', $3::text[], true, $4::uuid, true, 'ADEQUACY_DECISION', $5::date, $6::date, 'eu-west-1 region only. Data residency confirmed.')`,
    procAws,
    schoolId,
    ['Encrypted data at rest (all categories)', 'Application logs'],
    dpaAws,
    today,
    inOneYear,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_data_processing_agreements
     (id, school_id, processor_id, agreement_reference, effective_from, effective_to, document_s3_key, sub_processors_disclosed, sub_processor_list_s3_key, review_date, signed_by, status, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'AWS-DPA-2025-LINCOLN', $4::date, NULL, 's3://campusos-dpo/dpa/aws-2025.pdf', true, 's3://campusos-dpo/dpa/aws-subprocessors-2025.pdf', $5::date, $6::uuid, 'ACTIVE', 'EU SCC Module 2 (controller-to-processor).')`,
    dpaAws,
    schoolId,
    procAws,
    oneYearAgo,
    inOneYear,
    principalAccountId,
  );

  // Stripe — DPA in place
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_third_party_processors
     (id, school_id, processor_name, processor_type, registered_country, data_categories_processed, dpa_in_place, dpa_id, adequacy_decision_applicable, transfer_mechanism, last_reviewed_at, next_review_date, notes)
     VALUES ($1::uuid, $2::uuid, 'Stripe Payments Europe Ltd', 'PAYMENT_PROCESSOR', 'Ireland', $3::text[], true, $4::uuid, true, 'ADEQUACY_DECISION', $5::date, $6::date, 'PCI-DSS Level 1 attested.')`,
    procStripe,
    schoolId,
    ['Card identifiers (token only)', 'Family billing email', 'Invoice references'],
    dpaStripe,
    today,
    inOneYear,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_data_processing_agreements
     (id, school_id, processor_id, agreement_reference, effective_from, effective_to, document_s3_key, sub_processors_disclosed, sub_processor_list_s3_key, review_date, signed_by, status, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'STRIPE-DPA-2025', $4::date, NULL, 's3://campusos-dpo/dpa/stripe-2025.pdf', true, NULL, $5::date, $6::uuid, 'ACTIVE', 'Standard Stripe DPA accepted via dashboard.')`,
    dpaStripe,
    schoolId,
    procStripe,
    oneYearAgo,
    inOneYear,
    principalAccountId,
  );

  // OpenAI — NO DPA = gap
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_third_party_processors
     (id, school_id, processor_name, processor_type, registered_country, data_categories_processed, dpa_in_place, dpa_id, adequacy_decision_applicable, transfer_mechanism, last_reviewed_at, next_review_date, notes)
     VALUES ($1::uuid, $2::uuid, 'OpenAI LLC', 'AI_PROVIDER', 'United States', $3::text[], false, NULL, false, 'SCCs', $4::date, $5::date, 'GAP — DPA negotiation in progress, escalated to organisation legal team. Surfaces as red row on the dashboard.')`,
    procOpenai,
    schoolId,
    ['Submission text (PII redacted at app layer)'],
    today,
    inSixMonths,
  );

  // Google Workspace — DPA EXPIRED = gap
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_third_party_processors
     (id, school_id, processor_name, processor_type, registered_country, data_categories_processed, dpa_in_place, dpa_id, adequacy_decision_applicable, transfer_mechanism, last_reviewed_at, next_review_date, notes)
     VALUES ($1::uuid, $2::uuid, 'Google Workspace for Education', 'EMAIL_PROVIDER', 'United States', $3::text[], false, NULL, false, 'SCCs', $4::date, $5::date, 'GAP — Workspace DPA expired and renewal under review. Treat as DPA-not-in-place until renewal lands.')`,
    procGoogle,
    schoolId,
    ['Staff email content', 'Calendar metadata'],
    sixMonthsAgo,
    inSixMonths,
  );
  console.log(
    '  ✓ 4 processors (AWS active, Stripe active, OpenAI gap, Google expired gap) + 2 DPAs',
  );

  // ─── E) 1 Data Breach Record (Stolen Laptop, 72h ticking) ───
  const breachId = generateId();
  // Discovery 18 hours ago — 54 hours remaining on the GDPR window
  const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000).toISOString();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_data_breach_records
     (id, school_id, breach_title, breach_type, discovery_date, breach_start_date, personal_data_categories_involved, estimated_affected_individuals, risk_level, risk_to_individuals, supervisory_authority_notification_required, supervisory_authority_notified_at, supervisory_authority_reference, data_subjects_notification_required, data_subjects_notified_at, breach_cause, remediation_actions, is_resolved, resolved_at, reported_by, status)
     VALUES ($1::uuid, $2::uuid, 'Stolen staff laptop containing student records', 'THEFT', $3::timestamptz, $4::date, $5::text[], 32, 'HIGH', 'LIKELY', true, NULL, NULL, true, NULL, 'Teacher laptop stolen from car overnight. Disk-level encryption was active but password could be brute-forced.', 'Device remote-wipe issued via MDM (Cycle 22 IT). Password reset for affected accounts. Police report filed.', false, NULL, $6::uuid, 'UNDER_INVESTIGATION')`,
    breachId,
    schoolId,
    eighteenHoursAgo,
    today,
    ['Names', 'Class enrolment', 'Limited assessment scores (cached locally)'],
    principalAccountId,
  );
  console.log('  ✓ 1 breach record (THEFT, HIGH, 18h since discovery — 54h remaining)');

  // ─── F) 1 SAR (David Chen for Maya, IN_PROGRESS, deadline +25d) ───
  const sarId = generateId();
  const inTwentyFiveDays = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_subject_access_requests
     (id, school_id, data_subject_id, requested_by, request_type, request_details, deadline_date, status, response_s3_key, completed_at, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACCESS', 'Modules in scope: SIS, Classroom, Health, Behaviour, Counselling.', $5::date, 'IN_PROGRESS', NULL, NULL, 'Parent requested complete academic + health export for transition to new school district.')`,
    sarId,
    schoolId,
    mayaPersonId,
    davidPersonId,
    inTwentyFiveDays,
  );
  console.log('  ✓ 1 SAR (David Chen → Maya, IN_PROGRESS, deadline +25d)');

  // ─── G) 1 Erasure Request (PARTIALLY_COMPLETED — academic retained, audit pseudonymised) ───
  const erasureId = generateId();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  // Synthetic withdrawn-student id (not a real student in tenant_demo seed, intentional)
  const withdrawnStudentPersonId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_erasure_requests
     (id, school_id, data_subject_id, requested_by, request_details, status, categories_erased, categories_retained, categories_pseudonymised, reviewed_by, completed_at, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Withdrawn student — guardian invoked Right to Erasure post-transfer.', 'PARTIALLY_COMPLETED', $5::text[], $6::text[], $7::text[], $4::uuid, $8::timestamptz, 'Academic + financial records retained per FERPA + tax statute. Audit log metadata pseudonymised since direct erasure would break the audit chain (ADR-010).')`,
    erasureId,
    schoolId,
    withdrawnStudentPersonId,
    principalAccountId,
    ['Profile photo', 'Optional dietary preferences', 'Communication consent records'],
    ['Academic transcripts', 'Attendance records', 'Financial / billing records'],
    ['Audit log metadata fields'],
    twoDaysAgo,
  );
  console.log(
    '  ✓ 1 erasure request (PARTIALLY_COMPLETED — academic retained, audit pseudonymised)',
  );

  // ─── H) 1 Pseudonymisation Log (audit_log.metadata, 47 rows, opaque token) ───
  const pseudoLogId = generateId();
  const pseudoToken = `psd_${generateId().replace(/-/g, '').slice(0, 16)}`;
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_pseudonymisation_log
     (id, school_id, erasure_request_id, data_subject_id, target_table, target_field, rows_pseudonymised, pseudonymisation_token, pseudonymised_at, pseudonymised_by, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'platform_audit_log', 'metadata', 47, $5::text, $6::timestamptz, $7::uuid, 'JSON paths actor_name + subject_name rewritten to opaque token. Audit chain preserved.')`,
    pseudoLogId,
    schoolId,
    erasureId,
    withdrawnStudentPersonId,
    pseudoToken,
    twoDaysAgo,
    principalAccountId,
  );
  console.log(`  ✓ 1 pseudonymisation log entry (47 audit_log rows, token=${pseudoToken})`);

  // ─── I) 3 Consent Records (2 active + 1 withdrawn) ───
  const consent1 = generateId();
  const consent2 = generateId();
  const consent3 = generateId();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  // C1 — Parent consents for Maya in biometric attendance
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_consent_records
     (id, school_id, data_subject_id, processing_activity_id, consented, consent_method, consent_given_at, consent_withdrawn_at, evidence_s3_key, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, 'DIGITAL', $5::timestamptz, NULL, 's3://campusos-dpo/consent/maya-biometric-2026.json', 'Captured via parent portal opt-in flow.')`,
    consent1,
    schoolId,
    mayaPersonId,
    paBiometric,
    thirtyDaysAgo,
  );
  // C2 — Parent consents for AI tutor recommendations
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_consent_records
     (id, school_id, data_subject_id, processing_activity_id, consented, consent_method, consent_given_at, consent_withdrawn_at, evidence_s3_key, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, 'DIGITAL', $5::timestamptz, NULL, 's3://campusos-dpo/consent/maya-ai-tutor-2026.json', NULL)`,
    consent2,
    schoolId,
    mayaPersonId,
    paAiTutor,
    fortyFiveDaysAgo,
  );
  // C3 — Withdrawn consent (synthetic)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_processing_consent_records
     (id, school_id, data_subject_id, processing_activity_id, consented, consent_method, consent_given_at, consent_withdrawn_at, evidence_s3_key, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, false, 'DIGITAL', $5::timestamptz, $6::timestamptz, NULL, 'Parent withdrew consent for AI tutor profiling for sibling.')`,
    consent3,
    schoolId,
    withdrawnStudentPersonId,
    paAiTutor,
    fortyFiveDaysAgo,
    twoDaysAgo,
  );
  console.log('  ✓ 3 consent records (2 ACTIVE + 1 WITHDRAWN)');

  // ─── J) 1 Privacy Notice v2.1 ───
  const noticeId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_privacy_notices
     (id, school_id, notice_version, effective_from, content_summary, document_s3_key, published_by, published_at, superseded_at)
     VALUES ($1::uuid, $2::uuid, 'v2.1', $3::date, 'Updated for biometric attendance opt-in path and AI tutor recommendations transparency. Audience: parents, students, staff.', 's3://campusos-dpo/notices/lincoln-privacy-v2.1.pdf', $4::uuid, $5::timestamptz, NULL)`,
    noticeId,
    schoolId,
    today,
    principalAccountId,
    thirtyDaysAgo,
  );
  console.log('  ✓ 1 privacy notice (v2.1, PUBLISHED)');

  // ─── K) 1 Compliance Dashboard Config ───
  const configId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TENANT_SCHEMA}.dpo_compliance_dashboard_config
     (id, school_id, sar_default_deadline_days, breach_escalation_hours, retention_review_reminder_days, dpa_review_reminder_days, dpia_review_reminder_days, notes)
     VALUES ($1::uuid, $2::uuid, 30, 70, 30, 60, 90, 'DPO contact: principal@demo.campusos.dev. Pre-pilot rotation candidate for the dedicated org-scoped DPO role per ADR-052.')`,
    configId,
    schoolId,
  );
  console.log('  ✓ 1 compliance dashboard config (SAR 30d / breach escalation 70h)');

  console.log('');
  console.log('DPO seed complete.');
  console.log('Wave 7 (Analytics & Governance) seed surface ready for Step 5+.');

  await disconnectAll();
}

main().catch(async (err) => {
  console.error('seed-dpo failed:', err);
  await disconnectAll();
  process.exit(1);
});
