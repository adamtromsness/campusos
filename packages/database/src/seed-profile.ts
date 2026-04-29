import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-profile.ts — Profile and Household Mini-Cycle Step 4.
 *
 * Idempotent. Gated on whether the existing Chen Family already has a member
 * with role HEAD_OF_HOUSEHOLD. The seed at platform-init time created the
 * Chen Family with David PARENT primary-contact and Maya STUDENT — Step 4
 * migrates those values to HEAD_OF_HOUSEHOLD and CHILD respectively, so the
 * gate condition is "the Chen family has a HEAD_OF_HOUSEHOLD member".
 *
 * Five sections:
 *   A) update platform_families row for Chen Family with shared address +
 *      home phone + home language defaults.
 *   B) migrate Chen Family member roles  PARENT  to HEAD_OF_HOUSEHOLD,
 *      STUDENT to CHILD.
 *   C) populate iam_person personal fields on the 5 demo accounts plus Maya
 *      (preferred_name, suffix where natural, primary_phone, phone_type,
 *      personal_email, profile_updated_at, plus Maya date_of_birth).
 *   D) insert sis_student_demographics rows for all 15 seeded students with
 *      primary_language English. Maya additionally gets gender Female so the
 *      Step 7 Demographics tab has something to render.
 *   E) update David Chen sis_guardians row with employer Chen Engineering
 *      LLC, employer_phone, occupation, work_address.
 */

const TENANT_SCHEMA = 'tenant_demo';

const TODAY_ISO = new Date().toISOString();

interface PersonalFieldUpdate {
  email: string;
  middleName?: string;
  preferredName?: string;
  suffix?: string;
  primaryPhone?: string;
  phoneTypePrimary?: 'MOBILE' | 'HOME' | 'WORK';
  secondaryPhone?: string;
  phoneTypeSecondary?: 'MOBILE' | 'HOME' | 'WORK';
  workPhone?: string;
  personalEmail?: string;
  preferredLanguage?: string;
  dateOfBirth?: string;
}

const PERSONAL_UPDATES: PersonalFieldUpdate[] = [
  {
    email: 'parent@demo.campusos.dev', // David Chen
    preferredName: 'Dave',
    primaryPhone: '+1-217-555-0123',
    phoneTypePrimary: 'MOBILE',
    workPhone: '+1-217-555-0177',
    personalEmail: 'david.chen@example.com',
    preferredLanguage: 'en',
  },
  {
    email: 'student@demo.campusos.dev', // Maya Chen
    preferredName: 'Maya',
    dateOfBirth: '2011-03-15',
    primaryPhone: '+1-217-555-0124',
    phoneTypePrimary: 'MOBILE',
    preferredLanguage: 'en',
  },
  {
    email: 'principal@demo.campusos.dev', // Sarah Mitchell
    preferredName: 'Sarah',
    primaryPhone: '+1-217-555-0140',
    phoneTypePrimary: 'MOBILE',
    workPhone: '+1-217-555-0100',
    personalEmail: 'sarah.mitchell@example.com',
    preferredLanguage: 'en',
  },
  {
    email: 'teacher@demo.campusos.dev', // James Rivera
    preferredName: 'Jim',
    primaryPhone: '+1-217-555-0145',
    phoneTypePrimary: 'MOBILE',
    workPhone: '+1-217-555-0102',
    personalEmail: 'jim.rivera@example.com',
    preferredLanguage: 'en',
  },
  {
    email: 'vp@demo.campusos.dev', // Linda Park
    preferredName: 'Linda',
    primaryPhone: '+1-217-555-0150',
    phoneTypePrimary: 'MOBILE',
    workPhone: '+1-217-555-0101',
    personalEmail: 'linda.park@example.com',
    preferredLanguage: 'en',
  },
  {
    email: 'counsellor@demo.campusos.dev', // Marcus Hayes
    preferredName: 'Marc',
    primaryPhone: '+1-217-555-0155',
    phoneTypePrimary: 'MOBILE',
    workPhone: '+1-217-555-0103',
    personalEmail: 'marcus.hayes@example.com',
    preferredLanguage: 'en',
  },
];

async function seedProfile(): Promise<void> {
  const client = getPlatformClient();

  console.log('');
  console.log('  Profile and Household Seed');
  console.log('');

  // Locate the Chen Family. Created at platform-init time as a single row.
  const chenFamily = await client.platformFamily.findFirst({
    where: { name: 'Chen Family' },
  });
  if (!chenFamily) {
    console.log('  Chen Family row not found in platform.platform_families. Run pnpm seed first.');
    return;
  }

  // Idempotency gate. If the Chen Family already has a HEAD_OF_HOUSEHOLD
  // member, the seed has already run successfully — skip with a message.
  const headRow = await client.familyMember.findFirst({
    where: { familyId: chenFamily.id, memberRole: 'HEAD_OF_HOUSEHOLD' },
  });
  if (headRow) {
    console.log('  Chen Family already migrated to household roles. Skipping.');
    return;
  }

  // ── A) Update Chen Family shared-household fields ────────────────────
  await client.platformFamily.update({
    where: { id: chenFamily.id },
    data: {
      addressLine1: '1234 Oak Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
      homePhone: '+1-217-555-0123',
      homeLanguage: 'en',
      mailingAddressSame: true,
    },
  });
  console.log('  A) Chen Family address + home phone populated');

  // ── B) Migrate Chen Family member roles ──────────────────────────────
  // David Chen PARENT  to HEAD_OF_HOUSEHOLD  primary-contact stays true.
  // Maya Chen STUDENT  to CHILD.
  const davidUpdate = await client.familyMember.updateMany({
    where: { familyId: chenFamily.id, memberRole: 'PARENT' },
    data: { memberRole: 'HEAD_OF_HOUSEHOLD' },
  });
  const mayaUpdate = await client.familyMember.updateMany({
    where: { familyId: chenFamily.id, memberRole: 'STUDENT' },
    data: { memberRole: 'CHILD' },
  });
  console.log(
    '  B) Chen members migrated PARENT to HEAD_OF_HOUSEHOLD count ' +
      davidUpdate.count +
      ', STUDENT to CHILD count ' +
      mayaUpdate.count,
  );

  // ── C) Populate iam_person personal fields ───────────────────────────
  let cUpdated = 0;
  for (const upd of PERSONAL_UPDATES) {
    const account = await client.platformUser.findUnique({
      where: { email: upd.email },
      select: { personId: true },
    });
    if (!account) {
      console.log('     skipping ' + upd.email + ' — no platform_users row');
      continue;
    }
    await client.iamPerson.update({
      where: { id: account.personId },
      data: {
        middleName: upd.middleName ?? null,
        preferredName: upd.preferredName ?? null,
        suffix: upd.suffix ?? null,
        primaryPhone: upd.primaryPhone ?? null,
        phoneTypePrimary: upd.phoneTypePrimary ?? null,
        secondaryPhone: upd.secondaryPhone ?? null,
        phoneTypeSecondary: upd.phoneTypeSecondary ?? null,
        workPhone: upd.workPhone ?? null,
        personalEmail: upd.personalEmail ?? null,
        preferredLanguage: upd.preferredLanguage ?? 'en',
        dateOfBirth: upd.dateOfBirth ? new Date(upd.dateOfBirth) : undefined,
        profileUpdatedAt: new Date(TODAY_ISO),
      },
    });
    cUpdated += 1;
  }
  console.log('  C) iam_person personal fields populated on ' + cUpdated + ' accounts');

  // ── D) sis_student_demographics — one row per seeded student ─────────
  // tenant_demo schema-qualified raw SQL. Maya gets gender Female; the rest
  // get only primary_language so the schema is exercised but the UI starts
  // with admin-completable fields.
  const studentRows = await client.$queryRawUnsafe<{ id: string; person_id: string }[]>(
    'SELECT s.id::text AS id, ps.person_id::text AS person_id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id',
  );

  const mayaPersonId = (
    await client.platformUser.findUnique({
      where: { email: 'student@demo.campusos.dev' },
      select: { personId: true },
    })
  )?.personId;

  let dInserted = 0;
  for (const row of studentRows) {
    const isMaya = row.person_id === mayaPersonId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_student_demographics (id, student_id, gender, primary_language) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4) ON CONFLICT (student_id) DO NOTHING',
      generateId(),
      row.id,
      isMaya ? 'Female' : null,
      'English',
    );
    dInserted += 1;
  }
  console.log('  D) sis_student_demographics rows inserted or kept ' + dInserted);

  // ── E) David Chen sis_guardians employment ───────────────────────────
  const davidPersonId = (
    await client.platformUser.findUnique({
      where: { email: 'parent@demo.campusos.dev' },
      select: { personId: true },
    })
  )?.personId;

  if (davidPersonId) {
    const updateE = await client.$executeRawUnsafe(
      'UPDATE ' +
        TENANT_SCHEMA +
        '.sis_guardians SET employer = $1, employer_phone = $2, occupation = $3, work_address = $4, updated_at = now() ' +
        'WHERE person_id = $5::uuid',
      'Chen Engineering LLC',
      '+1-217-555-0177',
      'Mechanical Engineer',
      '100 Engineering Blvd, Springfield, IL 62701',
      davidPersonId,
    );
    console.log('  E) David Chen sis_guardians employment populated rowsAffected ' + updateE);
  }

  console.log('');
  console.log('  Profile and Household seed complete!');
}

async function main(): Promise<void> {
  try {
    await seedProfile();
  } finally {
    await disconnectAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
