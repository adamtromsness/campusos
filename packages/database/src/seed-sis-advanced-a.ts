import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-sis-advanced-a.ts — Phase 2 Cycle 13 sub-cycle a (P2-13a) Step 2.
 *
 * M20 SIS Advanced — Student Profiles + Custom Fields + Parent Updates.
 * Idempotent — gated on whether sis_student_profiles already has rows
 * for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 3 student profiles — Maya (APPROVED avatar), Aaliyah (PENDING),
 *      Ethan (REJECTED). Each carries bio plus interests plus motto.
 *   B) 4 custom field definitions — Shirt Size ENUM (STUDENT), Bus
 *      Route Preference TEXT (STUDENT), Employer TEXT (GUARDIAN),
 *      Room Setup ENUM (CLASS).
 *   C) 6 custom field values — Maya Shirt Size M, Maya Bus Route
 *      Westside, Aaliyah Shirt Size L, Ethan Shirt Size S, David Chen
 *      Employer Chen Engineering LLC, Class 1 Room Setup ROWS.
 *   D) 3 parent update requests — 1 APPROVED + applied (phone update),
 *      1 PENDING (address change), 1 AUTO_APPROVED (personal_email).
 *   E) 2 auto-approval rules — phone auto-approve, address manual.
 *   F) 3 student photos — OFFICIAL for Maya, Aaliyah, Ethan all 2025-26.
 *   G) 4 student notes — ACADEMIC parent-visible, BEHAVIOURAL staff,
 *      PASTORAL staff, CONFIDENTIAL author-only.
 *   H) 1 family relationship — Chen family DIVORCED JOINT custody
 *      (synthetic second guardian for the demo).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedSisAdvancedA(): Promise<void> {
  console.log('');
  console.log('  SIS Advanced A Seed (P2-13a Step 2)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.sis_student_profiles p ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.sis_students s ON s.id = p.student_id ' +
      'WHERE s.school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  sis_student_profiles already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  async function findStudent(
    firstName: string,
    lastName: string,
  ): Promise<{ studentId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS student_id, ip.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        'WHERE ip.first_name = $1 AND ip.last_name = $2 LIMIT 1',
      firstName,
      lastName,
    )) as Array<{ student_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('Student not found: ' + firstName + ' ' + lastName);
    return { studentId: rows[0]!.student_id, personId: rows[0]!.person_id };
  }

  async function findGuardian(
    firstName: string,
    lastName: string,
  ): Promise<{ guardianId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT g.id::text AS guardian_id, ip.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_guardians g ' +
        'JOIN platform.iam_person ip ON ip.id = g.person_id ' +
        'WHERE ip.first_name = $1 AND ip.last_name = $2 LIMIT 1',
      firstName,
      lastName,
    )) as Array<{ guardian_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('Guardian not found: ' + firstName + ' ' + lastName);
    return { guardianId: rows[0]!.guardian_id, personId: rows[0]!.person_id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const parent = await findUserByEmail('parent@demo.campusos.dev');

  const maya = await findStudent('Maya', 'Chen');
  const aaliyah = await findStudent('Aaliyah', 'Johnson');
  const ethan = await findStudent('Mason', 'Goldberg');

  const davidChen = await findGuardian('David', 'Chen');

  // Pull a class id for the CLASS-typed custom field.
  const classRows = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' + TENANT_SCHEMA + '.sis_classes ORDER BY section_code LIMIT 1',
  )) as Array<{ id: string }>;
  if (classRows.length === 0) throw new Error('No sis_classes found — run seed-sis first');
  const class1Id = classRows[0]!.id;

  // Pull the Chen family_id by joining through sis_family_members on the
  // student's person_id. sis_students does not carry family_id directly —
  // the membership is captured in sis_family_members.
  const familyRows = (await client.$queryRawUnsafe(
    'SELECT fm.family_id::text FROM ' +
      TENANT_SCHEMA +
      '.sis_family_members fm WHERE fm.person_id = $1::uuid LIMIT 1',
    maya.personId,
  )) as Array<{ family_id: string | null }>;
  if (familyRows.length === 0 || !familyRows[0]!.family_id) {
    throw new Error('Maya Chen has no sis_family_members row — run seed-sis first');
  }
  const chenFamilyId = familyRows[0]!.family_id;

  // ── A. 3 student profiles ──
  console.log('  Seeding 3 student profiles...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_profiles (id, student_id, bio, currently_reading, favourite_song, interests, motto, avatar_s3_key, avatar_status, avatar_reviewed_by, avatar_reviewed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text[], $7, $8, 'APPROVED', $9::uuid, now())",
    generateId(),
    maya.studentId,
    'Grade 9 student. Love science class and hiking on weekends.',
    'A Wrinkle in Time',
    'Stairway to Heaven',
    ['Science', 'Hiking', 'Photography'],
    'Curiosity over certainty',
    'avatars/maya-2025-26.jpg',
    teacher.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_profiles (id, student_id, bio, interests, avatar_s3_key, avatar_status) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, 'PENDING_APPROVAL')",
    generateId(),
    aaliyah.studentId,
    'Future engineer.',
    ['Robotics', 'Coding'],
    'avatars/aaliyah-uploaded-pending.jpg',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_profiles (id, student_id, bio, interests, avatar_s3_key, avatar_status, avatar_reviewed_by, avatar_reviewed_at, avatar_review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5, 'REJECTED', $6::uuid, now(), $7)",
    generateId(),
    ethan.studentId,
    'I play guitar.',
    ['Music', 'Skateboarding'],
    'avatars/ethan-rejected.jpg',
    teacher.personId,
    'Photo does not match school dress code. Please re-upload in school uniform.',
  );

  // ── B. 4 custom field definitions ──
  console.log('  Seeding 4 custom field definitions...');
  const shirtSizeDefId = generateId();
  const busRouteDefId = generateId();
  const employerDefId = generateId();
  const roomSetupDefId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_definitions (id, school_id, entity_type, field_name, field_label, field_type, enum_options, is_required, is_visible_to_parent, sort_order) ' +
      "VALUES ($1::uuid, $2::uuid, 'STUDENT', 'shirt_size', 'Shirt Size', 'ENUM', $3::text[], false, true, 10)",
    shirtSizeDefId,
    schoolId,
    ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_definitions (id, school_id, entity_type, field_name, field_label, field_type, is_required, is_visible_to_parent, sort_order) ' +
      "VALUES ($1::uuid, $2::uuid, 'STUDENT', 'bus_route_preference', 'Bus Route Preference', 'TEXT', false, true, 20)",
    busRouteDefId,
    schoolId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_definitions (id, school_id, entity_type, field_name, field_label, field_type, is_required, is_visible_to_parent, sort_order) ' +
      "VALUES ($1::uuid, $2::uuid, 'GUARDIAN', 'employer', 'Employer', 'TEXT', false, false, 10)",
    employerDefId,
    schoolId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_definitions (id, school_id, entity_type, field_name, field_label, field_type, enum_options, is_required, is_visible_to_parent, sort_order) ' +
      "VALUES ($1::uuid, $2::uuid, 'CLASS', 'room_setup', 'Room Setup', 'ENUM', $3::text[], false, false, 10)",
    roomSetupDefId,
    schoolId,
    ['ROWS', 'GROUPS', 'CIRCLE', 'U_SHAPE'],
  );

  // ── C. 6 custom field values ──
  console.log('  Seeding 6 custom field values...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_enum) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'M')",
    generateId(),
    shirtSizeDefId,
    maya.studentId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_text) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
    generateId(),
    busRouteDefId,
    maya.studentId,
    'Westside Route 7',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_enum) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'L')",
    generateId(),
    shirtSizeDefId,
    aaliyah.studentId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_enum) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'S')",
    generateId(),
    shirtSizeDefId,
    ethan.studentId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_text) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
    generateId(),
    employerDefId,
    davidChen.guardianId,
    'Chen Engineering LLC',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_custom_field_values (id, definition_id, entity_id, value_enum) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ROWS')",
    generateId(),
    roomSetupDefId,
    class1Id,
  );

  // ── D. 2 auto-approval rules first (so AUTO_APPROVED in section E behaves) ──
  console.log('  Seeding 2 auto-approval rules...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_auto_approval_rules (id, school_id, target_type, field_name, auto_approve) ' +
      "VALUES ($1::uuid, $2::uuid, 'GUARDIAN_INFO', 'personal_email', true)",
    generateId(),
    schoolId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_auto_approval_rules (id, school_id, target_type, field_name, auto_approve) ' +
      "VALUES ($1::uuid, $2::uuid, 'GUARDIAN_INFO', 'mailing_address', false)",
    generateId(),
    schoolId,
  );

  // ── E. 3 parent update requests ──
  console.log('  Seeding 3 parent update requests...');
  // E1: APPROVED + applied (phone update, manually reviewed even though
  // technically could auto-approve in a real flow — this row is historical).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_parent_info_update_requests (id, school_id, submitted_by, target_type, target_id, proposed_changes, change_reason, status, reviewed_by, reviewed_at, reviewer_notes, applied_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'GUARDIAN_INFO', $4::uuid, $5::jsonb, $6, 'APPROVED', $7::uuid, now() - interval '7 days', $8, now() - interval '7 days')",
    generateId(),
    schoolId,
    parent.personId,
    davidChen.guardianId,
    JSON.stringify({ phone_primary: '+1-555-0145' }),
    'Updated phone number.',
    principal.personId,
    'Verified and applied.',
  );

  // E2: PENDING address change (manual review required).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_parent_info_update_requests (id, school_id, submitted_by, target_type, target_id, proposed_changes, change_reason, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'GUARDIAN_INFO', $4::uuid, $5::jsonb, $6, 'PENDING')",
    generateId(),
    schoolId,
    parent.personId,
    davidChen.guardianId,
    JSON.stringify({ mailing_address: '1234 Elm Street, Springfield IL' }),
    'Family moved to new address.',
  );

  // E3: AUTO_APPROVED personal_email update.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_parent_info_update_requests (id, school_id, submitted_by, target_type, target_id, proposed_changes, change_reason, status, applied_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'GUARDIAN_INFO', $4::uuid, $5::jsonb, $6, 'AUTO_APPROVED', now() - interval '2 days')",
    generateId(),
    schoolId,
    parent.personId,
    davidChen.guardianId,
    JSON.stringify({ personal_email: 'david.chen+new@example.com' }),
    'Email change.',
  );

  // ── F. 3 student photos ──
  console.log('  Seeding 3 student photos...');
  for (const s of [maya, aaliyah, ethan]) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_student_photos (id, student_id, photo_type, s3_key, academic_year, is_current, uploaded_by) ' +
        "VALUES ($1::uuid, $2::uuid, 'OFFICIAL', $3, '2025-2026', true, $4::uuid)",
      generateId(),
      s.studentId,
      'photos/official/2025-26/' + s.studentId + '.jpg',
      principal.personId,
    );
  }

  // ── G. 4 student notes ──
  console.log('  Seeding 4 student notes...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_notes (id, school_id, student_id, author_id, note_type, note_text, is_parent_visible, is_confidential) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACADEMIC', $5, true, false)",
    generateId(),
    schoolId,
    maya.studentId,
    teacher.personId,
    'Maya is excelling in science. Recommending advanced placement next year.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_notes (id, school_id, student_id, author_id, note_type, note_text, is_parent_visible, is_confidential) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BEHAVIOURAL', $5, false, false)",
    generateId(),
    schoolId,
    aaliyah.studentId,
    teacher.personId,
    'Disruptive in maths class on 2026-04-22. Verbal warning given.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_notes (id, school_id, student_id, author_id, note_type, note_text, is_parent_visible, is_confidential) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PASTORAL', $5, false, false)",
    generateId(),
    schoolId,
    maya.studentId,
    principal.personId,
    'Maya mentioned feeling overwhelmed with workload. Counsellor referral made.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_notes (id, school_id, student_id, author_id, note_type, note_text, is_parent_visible, is_confidential) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'CONFIDENTIAL', $5, false, true)",
    generateId(),
    schoolId,
    ethan.studentId,
    principal.personId,
    'Internal safeguarding observation. See file.',
  );

  // ── H. 1 family relationship — Chen family ──
  console.log('  Seeding 1 family relationship (Chen DIVORCED JOINT)...');
  // The seed assumes David Chen exists; we need a synthetic second guardian
  // for the demo. For Cycle 13 we model the relationship row between two
  // existing guardians (David Chen plus Tasha Johnson is the simplest swap).
  // In production this would be Maya's actual second guardian.
  const tasha = await findGuardian('Tasha', 'Johnson');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_family_relationships (id, family_id, guardian_a_id, guardian_b_id, relationship_type, custody_arrangement, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DIVORCED', 'JOINT', $5)",
    generateId(),
    chenFamilyId,
    davidChen.guardianId,
    tasha.guardianId,
    'Demo family relationship row — joint custody arrangement post-divorce.',
  );

  console.log('');
  console.log('  SIS Advanced A seed complete.');
  console.log('    Profiles: 3 (1 APPROVED, 1 PENDING, 1 REJECTED)');
  console.log('    Custom field defs: 4 (2 STUDENT, 1 GUARDIAN, 1 CLASS)');
  console.log('    Custom field values: 6');
  console.log('    Parent update requests: 3 (1 APPROVED, 1 PENDING, 1 AUTO_APPROVED)');
  console.log('    Auto-approval rules: 2');
  console.log('    Student photos: 3 OFFICIAL');
  console.log('    Student notes: 4 (1 CONFIDENTIAL)');
  console.log('    Family relationships: 1 (DIVORCED JOINT)');
}

seedSisAdvancedA()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
