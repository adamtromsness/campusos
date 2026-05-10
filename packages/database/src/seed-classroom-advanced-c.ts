import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-classroom-advanced-c.ts — Phase 2 Cycle 7 (P2-7) sub-cycle c Step 6.
 *
 * Idempotent. Gated on whether cls_ai_tutoring_sessions has any rows for
 * the demo school. Re-running is a no-op once the seed has landed.
 *
 * Five sections:
 *   A) 2 cls_ai_tutoring_sessions — 1 COMPLETED with 8 messages and 3
 *      learning signals demonstrating the full conversation +
 *      signal-extraction shape, 1 ACTIVE so the resume-session UI has
 *      a row to render.
 *   B) 8 cls_ai_tutoring_messages on the COMPLETED session in alternating
 *      STUDENT then ASSISTANT order. The messages live in the
 *      RANGE-partitioned table; they land in the matching monthly leaf
 *      via the created_at default.
 *   C) 3 cls_ai_tutoring_learning_signals on the COMPLETED session — 1
 *      MISCONCEPTION, 1 STRENGTH, 1 INTEREST — demonstrating the 5-value
 *      signal_type CHECK and the confidence NUMERIC(3,2) field.
 *   D) 1 cls_lesson_recordings COMPLETE with 1 cls_lesson_transcripts +
 *      1 cls_lesson_summaries inlined. The seed lands the post-pipeline
 *      shape so the read path renders end-to-end without waiting for the
 *      Video Processing service.
 *   E) 3 cls_ai_usage_log rows across the 3 supported job types
 *      (TUTORING, SUMMARISATION, STUDENT_SUMMARY) so the AI Usage admin
 *      dashboard renders a non-empty by-type breakdown.
 *   F) 1 cls_ai_tutoring_opt_outs row — David Chen opts out Ethan
 *      (the second seeded student) demonstrating the parent-opts-out
 *      keystone. The CAT scenario for "opted-out student receives 403"
 *      will use this row.
 *
 * Permissions extension — TCH-007:read+write is already on Student +
 * Teacher + Vice Principal per the existing seed. The TCH-007:admin
 * tier gates the AI Usage dashboard and lands via the School Admin /
 * Platform Admin everyFunction grant.
 *
 * Cross-cycle dependencies:
 *   - sis_students (Cycle 1) — for student_id on sessions + opt-outs.
 *   - sis_classes (Cycle 1) — optional class scope on sessions.
 *   - cls_lessons (Cycle 2) — for the recording lesson_id.
 *   - sis_student_guardians + sis_guardians (Cycle 1) — for the
 *     guardian-relationship lookup on the David-opts-out-Ethan row.
 *   - hr_employees (Cycle 4) — for the recorded_by FK on recordings.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedClassroomAdvancedC() {
  console.log('');
  console.log(
    '  Classroom Advanced Seed — Sub-cycle C (P2-7c Step 6 — AI Tutoring + Lesson Recording + AI Usage + Opt-Out)',
  );
  console.log('');

  const client = getPlatformClient();

  // ── 1. School lookup ────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Gate — has any cls_ai_tutoring_sessions row already landed for this school?
  const existingSessions = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS count FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_sessions WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ count: number }>;
  if (existingSessions[0]!.count > 0) {
    console.log(
      '  P2-7c already seeded for demo school (cls_ai_tutoring_sessions present). Skipping.',
    );
    return;
  }

  // ── 2. Resolve helper actors + students ─────────────────────
  async function findStudentId(studentNumber: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_students WHERE student_number = $1',
      studentNumber,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('sis_students not found for ' + studentNumber);
    return rows[0]!.id;
  }
  const mayaId = await findStudentId('S-1001');
  const ethanId = await findStudentId('S-1002');

  // Resolve David Chen's iam_person.id for the opt-out keystone
  const davidRows = (await client.$queryRawUnsafe(
    'SELECT ip.id::text AS id FROM platform.iam_person ip ' +
      "JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.email = 'parent@demo.campusos.dev'",
  )) as Array<{ id: string }>;
  if (davidRows.length === 0) throw new Error('parent@demo.campusos.dev iam_person not found');
  const davidPersonId = davidRows[0]!.id;

  // Resolve principal's iam_person.id for the parent-side opt-out actor
  const principalRows = (await client.$queryRawUnsafe(
    'SELECT ip.id::text AS id, pu.id::text AS account_id FROM platform.iam_person ip ' +
      "JOIN platform.platform_users pu ON pu.person_id = ip.id WHERE pu.email = 'principal@demo.campusos.dev'",
  )) as Array<{ id: string; account_id: string }>;
  if (principalRows.length === 0) throw new Error('principal not found');
  const principalAccountId = principalRows[0]!.account_id;

  // Resolve Mitchell hr_employees.id (principal stands in as a teacher record)
  const mitchellRows = (await client.$queryRawUnsafe(
    'SELECT he.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_employees he JOIN platform.iam_person p ON p.id = he.person_id ' +
      "JOIN platform.platform_users pu ON pu.person_id = p.id WHERE pu.email = 'principal@demo.campusos.dev'",
  )) as Array<{ id: string }>;
  if (mitchellRows.length === 0) throw new Error('Mitchell hr_employees not found');
  const mitchellEmpId = mitchellRows[0]!.id;

  // ── 3. Pick a class for the AI tutoring session context ─────
  const mayaClassRows = (await client.$queryRawUnsafe(
    'SELECT class_id::text AS class_id FROM ' +
      TENANT_SCHEMA +
      '.sis_enrollments WHERE student_id = $1::uuid AND status = $2 LIMIT 1',
    mayaId,
    'ACTIVE',
  )) as Array<{ class_id: string }>;
  const mayaClass = mayaClassRows[0]?.class_id ?? null;

  // ── 4. Section A — AI tutoring sessions ─────────────────────
  const completedSessionId = generateId();
  const activeSessionId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_sessions ' +
      '(id, school_id, student_id, class_id, subject, status, started_at, ended_at, total_messages, learning_signals_extracted) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'COMPLETED', now() - interval '2 days', now() - interval '2 days' + interval '15 minutes', 8, true)",
    completedSessionId,
    schoolId,
    mayaId,
    mayaClass,
    'Algebra — Quadratic Equations',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_sessions ' +
      '(id, school_id, student_id, class_id, subject, status, total_messages) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'ACTIVE', 0)",
    activeSessionId,
    schoolId,
    mayaId,
    mayaClass,
    'Photosynthesis review',
  );
  console.log('  ✓ A: 2 cls_ai_tutoring_sessions (1 COMPLETED, 1 ACTIVE)');

  // ── 5. Section B — Conversation messages ────────────────────
  const conversation: Array<{ role: 'STUDENT' | 'ASSISTANT'; content: string; tokens: number }> = [
    { role: 'STUDENT', content: 'Can you help me factor x^2 + 5x + 6?', tokens: 25 },
    {
      role: 'ASSISTANT',
      content:
        'Sure! To factor x^2 + 5x + 6, look for two numbers that multiply to 6 and add to 5. What pair comes to mind?',
      tokens: 50,
    },
    { role: 'STUDENT', content: '2 and 3?', tokens: 8 },
    {
      role: 'ASSISTANT',
      content: 'Exactly. So x^2 + 5x + 6 = (x + 2)(x + 3). Want to try x^2 + 7x + 12 next?',
      tokens: 40,
    },
    { role: 'STUDENT', content: 'Let me think... 3 and 4? So (x+3)(x+4)?', tokens: 18 },
    {
      role: 'ASSISTANT',
      content: 'Yes! Great work. Want to try one with negative numbers?',
      tokens: 25,
    },
    { role: 'STUDENT', content: "Yes, what's the trick when the middle is negative?", tokens: 20 },
    {
      role: 'ASSISTANT',
      content:
        'When the middle term is negative but the constant is positive, both numbers are negative. Try x^2 - 5x + 6.',
      tokens: 50,
    },
  ];
  for (const msg of conversation) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_ai_tutoring_messages ' +
        '(id, session_id, role, content, tokens_used) VALUES ' +
        '($1::uuid, $2::uuid, $3, $4, $5::int)',
      generateId(),
      completedSessionId,
      msg.role,
      msg.content,
      msg.tokens,
    );
  }
  console.log('  ✓ B: 8 cls_ai_tutoring_messages on the COMPLETED session');

  // ── 6. Section C — Learning signals ─────────────────────────
  const signals: Array<{
    type: 'MISCONCEPTION' | 'STRENGTH' | 'STRUGGLE' | 'INTEREST' | 'ENGAGEMENT';
    description: string;
    confidence: number;
  }> = [
    {
      type: 'STRENGTH',
      description: 'Student grasps positive-coefficient factoring quickly without hints.',
      confidence: 0.85,
    },
    {
      type: 'INTEREST',
      description: 'Student volunteered curiosity about the negative-middle case.',
      confidence: 0.75,
    },
    {
      type: 'MISCONCEPTION',
      description:
        'Student paused on the negative-middle case — likely needs more practice with sign rules in factoring.',
      confidence: 0.6,
    },
  ];
  for (const sig of signals) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_ai_tutoring_learning_signals ' +
        '(id, session_id, signal_type, signal_description, confidence) VALUES ' +
        '($1::uuid, $2::uuid, $3, $4, $5::numeric)',
      generateId(),
      completedSessionId,
      sig.type,
      sig.description,
      sig.confidence,
    );
  }
  console.log('  ✓ C: 3 cls_ai_tutoring_learning_signals');

  // ── 7. Section D — Lesson recording + transcript + summary ─
  // Pick a lesson Mitchell can plausibly own — fall back gracefully if no lesson exists
  const lessonRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, class_id::text AS class_id FROM ' +
      TENANT_SCHEMA +
      '.cls_lessons ORDER BY created_at LIMIT 1',
  )) as Array<{ id: string; class_id: string }>;

  let recordingId: string | null = null;
  if (lessonRows.length > 0) {
    recordingId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_lesson_recordings ' +
        '(id, lesson_id, class_id, school_id, recorded_by, s3_key, duration_seconds, processing_status) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7::int, 'COMPLETE')",
      recordingId,
      lessonRows[0]!.id,
      lessonRows[0]!.class_id,
      schoolId,
      mitchellEmpId,
      'demo/recordings/2026-05-10/algebra-quadratics.mp4',
      1834,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_lesson_transcripts ' +
        '(id, recording_id, transcript_text, word_count, language) VALUES ' +
        "($1::uuid, $2::uuid, $3, 612, 'en')",
      generateId(),
      recordingId,
      "Welcome class. Today we are going to review factoring of quadratic expressions. Let's start with x squared plus 5 x plus 6 ...",
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_lesson_summaries ' +
        '(id, recording_id, summary_text, key_topics, action_items, model_version, tokens_used) VALUES ' +
        '($1::uuid, $2::uuid, $3, $4::text[], $5::text[], $6, 420)',
      generateId(),
      recordingId,
      'A 30-minute lesson on factoring quadratic expressions with positive coefficients, ending with two practice problems for homework.',
      ['quadratic factoring', 'positive coefficients', 'practice problems'],
      ['Complete homework problems 1 to 5', 'Review video before next lesson'],
      'stub-v1',
    );
    console.log('  ✓ D: 1 cls_lesson_recordings COMPLETE + transcript + summary');
  } else {
    console.log('  ⓘ D: skipped — no cls_lessons in seed-classroom');
  }

  // ── 8. Section E — AI usage log ─────────────────────────────
  const usageEntries: Array<{
    type: 'GRADING' | 'SUMMARISATION' | 'TUTORING' | 'STUDENT_SUMMARY';
    tokens: number;
    cost: number;
  }> = [
    { type: 'TUTORING', tokens: 236, cost: 0.0024 },
    { type: 'SUMMARISATION', tokens: 420, cost: 0.0042 },
    { type: 'STUDENT_SUMMARY', tokens: 200, cost: 0.002 },
  ];
  for (const u of usageEntries) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.cls_ai_usage_log ' +
        '(id, school_id, job_type, tokens_used, cost_usd, actor_id) VALUES ' +
        '($1::uuid, $2::uuid, $3, $4::int, $5::numeric, $6::uuid)',
      generateId(),
      schoolId,
      u.type,
      u.tokens,
      u.cost,
      principalAccountId,
    );
  }
  console.log('  ✓ E: 3 cls_ai_usage_log entries (TUTORING + SUMMARISATION + STUDENT_SUMMARY)');

  // ── 9. Section F — Parent opts out keystone ────────────────
  // David Chen (guardian) opts out Ethan (his other seeded child).
  // The seed-sis pre-existing relationship makes David the guardian
  // for both Maya and Ethan, so this row exercises the parent-opt-out
  // path. The CAT will assert that AI tutoring on Ethan returns 403.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_opt_outs ' +
      '(id, student_id, opted_out_by, reason) VALUES ' +
      '($1::uuid, $2::uuid, $3::uuid, $4)',
    generateId(),
    ethanId,
    davidPersonId,
    'Family prefers human tutoring sessions for now.',
  );
  console.log('  ✓ F: 1 cls_ai_tutoring_opt_outs (David Chen opts out Ethan)');

  // ── 10. Final counts ────────────────────────────────────────
  const counts = (await client.$queryRawUnsafe(
    'SELECT ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_sessions) AS sessions, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_messages) AS messages, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_learning_signals) AS signals, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_lesson_recordings) AS recordings, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_lesson_transcripts) AS transcripts, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_lesson_summaries) AS summaries, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_usage_log) AS usage_log, ' +
      '(SELECT count(*)::int FROM ' +
      TENANT_SCHEMA +
      '.cls_ai_tutoring_opt_outs) AS opt_outs',
  )) as Array<Record<string, number>>;
  console.log('');
  console.log('  Final counts: ' + JSON.stringify(counts[0]));
  console.log('');
  console.log('  ✓ Classroom Advanced — Sub-cycle C seed complete');
}

async function main() {
  try {
    await seedClassroomAdvancedC();
  } finally {
    await disconnectAll();
  }
}

main().catch((e: unknown) => {
  console.error('seed-classroom-advanced-c failed:', e);
  process.exit(1);
});
