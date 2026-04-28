import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

// Notification types used by seed prefs + queue. These match the names the Step 5
// consumers will translate Kafka topics into (att.student.marked_tardy →
// 'attendance.tardy', etc).
var NOTIFICATION_TYPES = [
  'attendance.tardy',
  'attendance.absent',
  'grade.published',
  'progress_note.published',
  'absence.requested',
  'absence.reviewed',
  'message.posted',
  'announcement.published',
];

// Channels that get email by default (plan: EMAIL enabled for grade.published
// and attendance.tardy). Everything else is IN_APP only.
var EMAIL_TYPES = new Set(['grade.published', 'attendance.tardy']);

async function seedMessaging() {
  console.log('');
  console.log('  Messaging & Notifications Seed (Cycle 3 Step 4)');
  console.log('');

  var client = getPlatformClient();

  // ── Idempotency check ──────────────────────────────────────
  var existingThreadTypes = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT count(*)::bigint AS count FROM ' + TENANT_SCHEMA + '.msg_thread_types',
  );
  if (existingThreadTypes[0] && existingThreadTypes[0].count > 0n) {
    console.log(
      '  Messaging data already seeded (' +
        existingThreadTypes[0].count +
        ' msg_thread_types rows) — skipping',
    );
    return;
  }

  // ── Look up dependencies seeded by seed.ts / seed-sis.ts ──
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var userByEmail: Record<string, { id: string; displayName: string }> = {};
  var emails = [
    'admin@demo.campusos.dev',
    'principal@demo.campusos.dev',
    'teacher@demo.campusos.dev',
    'student@demo.campusos.dev',
    'parent@demo.campusos.dev',
  ];
  for (var ei = 0; ei < emails.length; ei++) {
    var u = await client.platformUser.findFirst({ where: { email: emails[ei]! } });
    if (!u) throw new Error(emails[ei] + ' not found — run pnpm seed first');
    userByEmail[emails[ei]!] = { id: u.id, displayName: u.displayName ?? '' };
  }
  var teacherUserId = userByEmail['teacher@demo.campusos.dev']!.id;
  var parentUserId = userByEmail['parent@demo.campusos.dev']!.id;
  var studentUserId = userByEmail['student@demo.campusos.dev']!.id;
  var principalUserId = userByEmail['principal@demo.campusos.dev']!.id;
  var adminUserId = userByEmail['admin@demo.campusos.dev']!.id;

  // Period 1 class id
  var classes = await client.$queryRawUnsafe<Array<{ id: string; section_code: string }>>(
    'SELECT id::text AS id, section_code FROM ' + TENANT_SCHEMA + '.sis_classes',
  );
  var p1ClassId: string | null = null;
  for (var ci = 0; ci < classes.length; ci++) {
    if (classes[ci]!.section_code === '1') p1ClassId = classes[ci]!.id;
  }
  if (!p1ClassId) throw new Error('Period 1 class not found — run seed:sis first');

  // (We don't need to look up the P1 student platform_user ids here — only
  // Maya (S-1001) currently has a platform_users account; the other 14
  // SIS students are platform_students only. The class-discussion thread
  // therefore uses the teacher + Maya as the two account-holding
  // participants. See HANDOFF "Known limitations" for context.)

  // ── 1. Thread types (4) ──────────────────────────────────
  interface ThreadTypeSpec {
    name: string;
    description: string;
    allowedRoles: string[];
    isSystem: boolean;
  }
  var threadTypeSpecs: ThreadTypeSpec[] = [
    {
      name: 'TEACHER_PARENT',
      description: 'Direct conversations between a teacher and a parent or guardian.',
      allowedRoles: ['TEACHER', 'PARENT', 'SCHOOL_ADMIN'],
      isSystem: false,
    },
    {
      name: 'CLASS_DISCUSSION',
      description: 'Class-wide discussion thread, scoped to the roster of a single class.',
      allowedRoles: ['TEACHER', 'STUDENT'],
      isSystem: false,
    },
    {
      name: 'ADMIN_STAFF',
      description: 'Internal staff conversations for school administration.',
      allowedRoles: ['SCHOOL_ADMIN', 'TEACHER', 'PLATFORM_ADMIN'],
      isSystem: false,
    },
    {
      name: 'SYSTEM_NOTIFICATION',
      description: 'System-generated threads. Created by the platform, not by users.',
      allowedRoles: [],
      isSystem: true,
    },
  ];
  var threadTypeIdByName: Record<string, string> = {};
  for (var tti = 0; tti < threadTypeSpecs.length; tti++) {
    var t = threadTypeSpecs[tti]!;
    var tid = generateId();
    threadTypeIdByName[t.name] = tid;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_thread_types (id, school_id, name, description, allowed_participant_roles, is_system, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6, true)',
      tid,
      schoolId,
      t.name,
      t.description,
      t.allowedRoles,
      t.isSystem,
    );
  }
  console.log('  ' + threadTypeSpecs.length + ' msg_thread_types');

  // ── 2. Sample threads + messages ─────────────────────────
  // Helper: insert a thread + its participants + a sequence of messages, and
  // bump the thread's last_message_at to the latest message timestamp.
  async function insertThread(
    typeName: string,
    subject: string | null,
    createdBy: string,
    participants: Array<{ accountId: string; role: 'OWNER' | 'PARTICIPANT' | 'OBSERVER' }>,
    messages: Array<{ senderId: string; body: string; createdAt: string }>,
  ): Promise<{ threadId: string; messages: Array<{ id: string; createdAt: string }> }> {
    var threadId = generateId();
    var lastAt = messages.length > 0 ? messages[messages.length - 1]!.createdAt : null;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_threads (id, school_id, thread_type_id, subject, created_by, last_message_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::timestamptz)',
      threadId,
      schoolId,
      threadTypeIdByName[typeName]!,
      subject,
      createdBy,
      lastAt,
    );
    for (var pi = 0; pi < participants.length; pi++) {
      var p = participants[pi]!;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.msg_thread_participants (id, thread_id, school_id, platform_user_id, role) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
        generateId(),
        threadId,
        schoolId,
        p.accountId,
        p.role,
      );
    }
    var inserted: Array<{ id: string; createdAt: string }> = [];
    for (var mi = 0; mi < messages.length; mi++) {
      var msg = messages[mi]!;
      var msgId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.msg_messages (id, thread_id, school_id, sender_id, body, created_at, updated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $6::timestamptz)',
        msgId,
        threadId,
        schoolId,
        msg.senderId,
        msg.body,
        msg.createdAt,
      );
      inserted.push({ id: msgId, createdAt: msg.createdAt });
    }
    return { threadId: threadId, messages: inserted };
  }

  // Thread A — Rivera ↔ David Chen about Maya's progress (3 messages)
  var threadA = await insertThread(
    'TEACHER_PARENT',
    'Maya — Spring 2026 progress check-in',
    teacherUserId,
    [
      { accountId: teacherUserId, role: 'OWNER' },
      { accountId: parentUserId, role: 'PARTICIPANT' },
    ],
    [
      {
        senderId: teacherUserId,
        body: "Hi David, just wanted to share a quick update on Maya. She's been engaged in class and her last quiz was strong. One thing I'd love to see her work on is showing more steps in her algebra solutions — happy to chat about strategies if you're interested.",
        createdAt: '2026-04-20T14:30:00Z',
      },
      {
        senderId: parentUserId,
        body: 'Thanks, James — appreciate the heads up. We can definitely reinforce that at home. Is there a worksheet or resource you recommend for showing work?',
        createdAt: '2026-04-20T19:15:00Z',
      },
      {
        senderId: teacherUserId,
        body: "I'll send a copy of the rubric I use for grading proofs and a couple of practice sheets. Let's check back in two weeks.",
        createdAt: '2026-04-21T09:05:00Z',
      },
    ],
  );

  // Thread B — Period 1 class discussion (5 messages from different senders)
  // Maya is the only enrolled student with a platform_users account, so the
  // other "student" senders fall back to the teacher to keep the thread > 2
  // participants without inventing accounts. (Step 4 plan: 5 messages from
  // different students; we approximate with available accounts — the schema
  // is what matters here, not the social fidelity.)
  var classDiscussionParticipants: Array<{
    accountId: string;
    role: 'OWNER' | 'PARTICIPANT' | 'OBSERVER';
  }> = [
    { accountId: teacherUserId, role: 'OWNER' },
    { accountId: studentUserId, role: 'PARTICIPANT' },
  ];
  var threadB = await insertThread(
    'CLASS_DISCUSSION',
    'P1 Algebra — Quadratics homework Q&A',
    teacherUserId,
    classDiscussionParticipants,
    [
      {
        senderId: teacherUserId,
        body: 'Posting a thread here for any questions on the Quadratics Homework Set due Friday. Use this thread instead of email and the whole class benefits.',
        createdAt: '2026-04-13T08:00:00Z',
      },
      {
        senderId: studentUserId,
        body: 'For Q4, do we factor first or use the formula? The numbers are kind of ugly.',
        createdAt: '2026-04-13T19:42:00Z',
      },
      {
        senderId: teacherUserId,
        body: 'Good question. Try factoring first — if the discriminant is a perfect square, factoring will be cleaner. Otherwise fall back to the formula.',
        createdAt: '2026-04-13T20:05:00Z',
      },
      {
        senderId: studentUserId,
        body: "Got it. Also Q7 says 'sketch the parabola' — should we show the vertex and intercepts on the sketch?",
        createdAt: '2026-04-14T07:30:00Z',
      },
      {
        senderId: teacherUserId,
        body: 'Yes — vertex, both x-intercepts (if real), and the y-intercept. Label them.',
        createdAt: '2026-04-14T08:15:00Z',
      },
    ],
  );

  // Thread C — Admin/staff thread (principal ↔ teacher, 2 messages)
  var threadC = await insertThread(
    'ADMIN_STAFF',
    'PD day — April calendar',
    principalUserId,
    [
      { accountId: principalUserId, role: 'OWNER' },
      { accountId: teacherUserId, role: 'PARTICIPANT' },
    ],
    [
      {
        senderId: principalUserId,
        body: 'Reminder: PD day is April 30. Department leads should send their session topics to me by EOD Friday.',
        createdAt: '2026-04-22T10:00:00Z',
      },
      {
        senderId: teacherUserId,
        body: "Got it — math department's leaning toward a session on differentiated instruction in mixed-ability sections. I'll write it up and send tomorrow.",
        createdAt: '2026-04-22T16:45:00Z',
      },
    ],
  );

  var totalThreads = 3;
  var totalMessages = threadA.messages.length + threadB.messages.length + threadC.messages.length;
  console.log('  ' + totalThreads + ' msg_threads (3 sample threads)');
  console.log('  ' + totalMessages + ' msg_messages');

  // ── 2b. A few read marks so the unread-count UI has data to show ──
  // David has read all of his own messages and the first message from James
  // in thread A. Maya has read the teacher's two replies in thread B.
  var readMarks: Array<{
    messageId: string;
    messageCreatedAt: string;
    threadId: string;
    readerId: string;
  }> = [
    {
      messageId: threadA.messages[0]!.id,
      messageCreatedAt: threadA.messages[0]!.createdAt,
      threadId: threadA.threadId,
      readerId: parentUserId,
    },
    {
      messageId: threadB.messages[0]!.id,
      messageCreatedAt: threadB.messages[0]!.createdAt,
      threadId: threadB.threadId,
      readerId: studentUserId,
    },
    {
      messageId: threadB.messages[2]!.id,
      messageCreatedAt: threadB.messages[2]!.createdAt,
      threadId: threadB.threadId,
      readerId: studentUserId,
    },
    {
      messageId: threadB.messages[4]!.id,
      messageCreatedAt: threadB.messages[4]!.createdAt,
      threadId: threadB.threadId,
      readerId: studentUserId,
    },
  ];
  for (var rmi = 0; rmi < readMarks.length; rmi++) {
    var rm = readMarks[rmi]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_message_reads (id, message_id, message_created_at, thread_id, reader_id, read_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::uuid, $5::uuid, now())',
      generateId(),
      rm.messageId,
      rm.messageCreatedAt,
      rm.threadId,
      rm.readerId,
    );
  }
  console.log('  ' + readMarks.length + ' msg_message_reads');

  // ── 3. Alert types (3 — used by announcements + emergency-style notifications) ──
  interface AlertSpec {
    name: string;
    description: string;
    severity: 'INFO' | 'WARNING' | 'URGENT' | 'EMERGENCY';
    channels: string[];
    requiresAck: boolean;
  }
  var alertSpecs: AlertSpec[] = [
    {
      name: 'GENERAL_ANNOUNCEMENT',
      description: 'Standard announcements posted by school staff.',
      severity: 'INFO',
      channels: ['IN_APP'],
      requiresAck: false,
    },
    {
      name: 'PARENT_INFORMATIONAL',
      description:
        'Time-sensitive but non-urgent updates aimed at parents (e.g. conference schedules).',
      severity: 'INFO',
      channels: ['IN_APP', 'EMAIL'],
      requiresAck: false,
    },
    {
      name: 'WEATHER_CLOSURE',
      description: 'Weather-related early dismissal or closure notice.',
      severity: 'URGENT',
      channels: ['IN_APP', 'EMAIL', 'SMS'],
      requiresAck: false,
    },
  ];
  var alertIdByName: Record<string, string> = {};
  for (var ai = 0; ai < alertSpecs.length; ai++) {
    var al = alertSpecs[ai]!;
    var alId = generateId();
    alertIdByName[al.name] = alId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_alert_types (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, true)',
      alId,
      schoolId,
      al.name,
      al.description,
      al.severity,
      al.channels,
      al.requiresAck,
    );
  }
  console.log('  ' + alertSpecs.length + ' msg_alert_types');

  // ── 4. Notification preferences (one row per (user, notification_type)) ──
  var prefRowCount = 0;
  for (var ui = 0; ui < emails.length; ui++) {
    var email = emails[ui]!;
    var accountId = userByEmail[email]!.id;
    var isParent = email === 'parent@demo.campusos.dev';
    for (var nti = 0; nti < NOTIFICATION_TYPES.length; nti++) {
      var ntype = NOTIFICATION_TYPES[nti]!;
      var channels = EMAIL_TYPES.has(ntype) ? ['IN_APP', 'EMAIL'] : ['IN_APP'];
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.msg_notification_preferences ' +
          '(id, school_id, platform_user_id, notification_type, channels, is_enabled, quiet_hours_start, quiet_hours_end) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], true, $6::time, $7::time)',
        generateId(),
        schoolId,
        accountId,
        ntype,
        channels,
        isParent ? '22:00' : null,
        isParent ? '07:00' : null,
      );
      prefRowCount++;
    }
  }
  console.log(
    '  ' +
      prefRowCount +
      ' msg_notification_preferences (' +
      emails.length +
      ' users × ' +
      NOTIFICATION_TYPES.length +
      ' types; David has 22:00–07:00 quiet hours)',
  );

  // ── 5. Moderation policies (PLATFORM + BUILDING) ─────────
  var platformPolicyId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_policies ' +
      '(id, school_id, scope, scope_id, name, description, keywords, keyword_action, sensitivity_threshold, escalation_rules, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'PLATFORM', NULL, $3, $4, $5::text[], 'BLOCK', 80, $6::jsonb, true)",
    platformPolicyId,
    schoolId,
    'Platform Default Profanity Filter',
    'Baseline profanity and threat keyword block-list applied to every tenant. Tenants cannot disable this policy.',
    ['fuck', 'shit', 'damn', 'asshole', 'bastard', 'kill you', 'i hate'],
    JSON.stringify({ notify_admins_on_block: true }),
  );

  var buildingPolicyId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_moderation_policies ' +
      '(id, school_id, scope, scope_id, name, description, keywords, keyword_action, sensitivity_threshold, escalation_rules, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'BUILDING', $2::uuid, $3, $4, $5::text[], 'FLAG_FOR_REVIEW', 60, $6::jsonb, true)",
    buildingPolicyId,
    schoolId,
    'Lincoln Elementary — School-Specific',
    'Building-level supplements to the platform default. Flags substance-use and bullying keywords for counsellor review.',
    ['vape', 'weed', 'bullying', 'bully'],
    JSON.stringify({ route_to: 'counsellor', priority: 'medium' }),
  );
  console.log('  2 msg_moderation_policies (1 PLATFORM, 1 BUILDING)');

  // ── 6. Sample announcements (2) ──────────────────────────
  // 6a. Welcome Back to School — ALL_SCHOOL, published, with audience + reads.
  var welcomeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_announcements (id, school_id, author_id, title, body, audience_type, audience_ref, alert_type_id, publish_at, expires_at, is_published) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ALL_SCHOOL', NULL, $6::uuid, $7::timestamptz, $8::timestamptz, true)",
    welcomeId,
    schoolId,
    principalUserId,
    'Welcome Back to School',
    "Welcome back to Lincoln Elementary for the Spring 2026 semester. We're excited to have everyone back. A few reminders: drop-off opens at 7:30am, the after-school program restarts Monday, and our first all-school assembly is Friday at 2pm. Let's have a great term.",
    alertIdByName['GENERAL_ANNOUNCEMENT']!,
    '2026-01-15T08:00:00Z',
    '2026-02-15T08:00:00Z',
  );

  // 6b. Parent-Teacher Conference Dates — ROLE=PARENT, published, with audience.
  var conferenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_announcements (id, school_id, author_id, title, body, audience_type, audience_ref, alert_type_id, publish_at, expires_at, is_published) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'ROLE', 'PARENT', $6::uuid, $7::timestamptz, $8::timestamptz, true)",
    conferenceId,
    schoolId,
    principalUserId,
    'Parent-Teacher Conference Dates',
    'Spring conferences will run Tuesday May 5 (4–7pm) and Saturday May 9 (9am–12pm). Booking opens April 28 via the Parent Portal. Each slot is 15 minutes. Email the front office with any scheduling conflicts.',
    alertIdByName['PARENT_INFORMATIONAL']!,
    '2026-04-25T08:00:00Z',
    '2026-05-10T08:00:00Z',
  );
  console.log('  2 msg_announcements (1 ALL_SCHOOL, 1 ROLE=PARENT)');

  // ── 6c. Announcement audiences ────────────────────────────
  // Welcome Back: every test user gets a row. Conference: parents only.
  // Real fan-out is the AudienceFanOutWorker's job (Step 7) — for the seed we
  // just pre-populate so the announcement UI has data to display.
  var welcomeAudience = [parentUserId, studentUserId, teacherUserId, principalUserId, adminUserId];
  for (var wai = 0; wai < welcomeAudience.length; wai++) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status, delivered_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DELIVERED', $5::timestamptz)",
      generateId(),
      schoolId,
      welcomeId,
      welcomeAudience[wai]!,
      '2026-01-15T08:05:00Z',
    );
  }

  // Conference audience: David Chen + the 9 seeded guardians (look them up).
  var guardianAccounts = await client.$queryRawUnsafe<Array<{ id: string }>>(
    "SELECT id::text AS id FROM platform.platform_users WHERE email LIKE '%@parents.demo.campusos.dev'",
  );
  var conferenceAudience: string[] = [parentUserId];
  for (var gi = 0; gi < guardianAccounts.length; gi++) {
    conferenceAudience.push(guardianAccounts[gi]!.id);
  }
  for (var cai = 0; cai < conferenceAudience.length; cai++) {
    var deliveryStatus = cai === conferenceAudience.length - 1 ? 'PENDING' : 'DELIVERED';
    var deliveredAt = deliveryStatus === 'DELIVERED' ? '2026-04-25T08:05:00Z' : null;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status, delivered_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)',
      generateId(),
      schoolId,
      conferenceId,
      conferenceAudience[cai]!,
      deliveryStatus,
      deliveredAt,
    );
  }
  console.log(
    '  ' +
      (welcomeAudience.length + conferenceAudience.length) +
      ' msg_announcement_audiences (' +
      welcomeAudience.length +
      ' welcome + ' +
      conferenceAudience.length +
      ' conference)',
  );

  // 6d. Announcement reads — David has read both, Maya has read welcome.
  var readEntries = [
    { announcementId: welcomeId, readerId: parentUserId },
    { announcementId: welcomeId, readerId: studentUserId },
    { announcementId: welcomeId, readerId: teacherUserId },
    { announcementId: conferenceId, readerId: parentUserId },
  ];
  for (var rei = 0; rei < readEntries.length; rei++) {
    var re = readEntries[rei]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.msg_announcement_reads (id, school_id, announcement_id, reader_id, read_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now())',
      generateId(),
      schoolId,
      re.announcementId,
      re.readerId,
    );
  }
  console.log('  ' + readEntries.length + ' msg_announcement_reads');

  // ── 7. Notification queue entries (3 — pre-seeded so the bell has data) ─
  var sentTardyId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_notification_queue ' +
      '(id, school_id, recipient_id, notification_type, payload, status, idempotency_key, scheduled_for, sent_at, attempts, correlation_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'attendance.tardy', $4::jsonb, 'SENT', $5, $6::timestamptz, $6::timestamptz, 1, $7::uuid)",
    sentTardyId,
    schoolId,
    parentUserId,
    JSON.stringify({
      student_name: 'Maya Chen',
      student_id: 'S-1001',
      class_name: 'P1 Algebra 1',
      period: '1',
      status: 'TARDY',
      occurred_at: '2026-04-22T08:05:00Z',
    }),
    'seed-tardy-maya-2026-04-22-p1',
    '2026-04-22T08:06:00Z',
    generateId(),
  );

  var sentGradeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_notification_queue ' +
      '(id, school_id, recipient_id, notification_type, payload, status, idempotency_key, scheduled_for, sent_at, attempts, correlation_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'grade.published', $4::jsonb, 'SENT', $5, $6::timestamptz, $6::timestamptz, 1, $7::uuid)",
    sentGradeId,
    schoolId,
    studentUserId,
    JSON.stringify({
      assignment_title: 'Linear Equations Quiz',
      class_name: 'P1 Algebra 1',
      grade_value: 92,
      letter_grade: 'A',
      max_points: 100,
    }),
    'seed-grade-maya-linear-eq-quiz',
    '2026-02-16T10:30:00Z',
    generateId(),
  );

  var pendingId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_notification_queue ' +
      '(id, school_id, recipient_id, notification_type, payload, status, idempotency_key, scheduled_for, attempts, correlation_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'message.posted', $4::jsonb, 'PENDING', $5, now(), 0, $6::uuid)",
    pendingId,
    schoolId,
    parentUserId,
    JSON.stringify({
      thread_id: threadA.threadId,
      thread_subject: 'Maya — Spring 2026 progress check-in',
      sender_name: 'James Rivera',
      preview:
        "I'll send a copy of the rubric I use for grading proofs and a couple of practice sheets.",
    }),
    'seed-message-thread-a-pending',
    generateId(),
  );

  // 7b. One delivery log row per SENT queue entry (the IN_APP delivery the
  // worker would record). Skip the PENDING one — by definition it has not
  // been delivered yet.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_notification_log ' +
      '(id, school_id, queue_id, recipient_id, notification_type, channel, status, sent_at, delivered_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'attendance.tardy', 'IN_APP', 'DELIVERED', $5::timestamptz, $5::timestamptz)",
    generateId(),
    schoolId,
    sentTardyId,
    parentUserId,
    '2026-04-22T08:06:00Z',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.msg_notification_log ' +
      '(id, school_id, queue_id, recipient_id, notification_type, channel, status, sent_at, delivered_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'grade.published', 'IN_APP', 'DELIVERED', $5::timestamptz, $5::timestamptz)",
    generateId(),
    schoolId,
    sentGradeId,
    studentUserId,
    '2026-02-16T10:30:00Z',
  );
  console.log('  3 msg_notification_queue (2 SENT, 1 PENDING)');
  console.log('  2 msg_notification_log');

  console.log('');
  console.log('  Messaging seed complete!');
  console.log('  Next: rebuild permission cache → tsx src/build-cache.ts');
}

if (require.main === module) {
  seedMessaging()
    .then(function () {
      return disconnectAll();
    })
    .then(function () {
      process.exit(0);
    })
    .catch(function (e) {
      console.error('Messaging seed failed:', e);
      disconnectAll().then(function () {
        process.exit(1);
      });
    });
}

export { seedMessaging };
