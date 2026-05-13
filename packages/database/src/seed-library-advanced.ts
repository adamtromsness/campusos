import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-library-advanced.ts — Phase 2 Cycle 25 Step 3.
 *
 * Idempotent. Gated on whether lib_class_set_checkouts already has
 * a row for the demo school. Re-running is a no-op once the seed
 * has landed.
 *
 * Five sections covering all 6 new P2-25 tables plus the two
 * Cycle 12 lib_reading_lists / lib_reading_list_items the Step 1
 * migration extends with curriculum_unit_id + target_grade_level.
 *
 *   A) 5 additional lib_catalogue_items so the reading lists +
 *      recommendations have a wider title pool than the Cycle 12
 *      base of 5 (The Giver, Charlotte's Web, Number the Stars,
 *      Holes, Wonder). Adds: Island of the Blue Dolphins, Esperanza
 *      Rising, Code Talker, Bridge to Terabithia, New Moon (the
 *      Madeleine L'Engle title, not Twilight). With Cycle 12 we
 *      now have 10 catalogue items in the demo tenant.
 *
 *   B) 23 additional lib_catalogue_copies of Number the Stars so
 *      the class set checkout in section D has 25 individual
 *      copies to fan out to. Cycle 12 seeded 2 copies of Number
 *      the Stars (LIB-NTS-001 + LIB-NTS-002 — but those barcodes
 *      were actually 'LIB-FIC-007' + 'LIB-FIC-008'). This section
 *      adds 23 more barcodes LIB-NTS-001..LIB-NTS-023 reaching
 *      25 total. 23 are flipped to CHECKED_OUT during the class
 *      set fan-out then 21 are returned, 2 stay CHECKED_OUT —
 *      mirrors the runtime PARTIALLY_RETURNED state.
 *
 *   C) 2 lib_reading_lists — both published:
 *        - "Grade 5 Historical Fiction" CURRICULUM_UNIT linked to
 *          the cur_units "Narrative Writing" row (the demo
 *          curriculum has no US History unit; Narrative Writing is
 *          the available unit and reasonable for the cross-cycle
 *          linkage). 8 items: 3 REQUIRED, 4 RECOMMENDED, 1
 *          EXTENSION.
 *        - "New Arrivals March 2026" GENERAL, 5 items, no
 *          curriculum unit link.
 *
 *   D) 1 lib_class_set_checkouts — Rivera (teacher) checks out 25
 *      copies of Number the Stars for his English class. 21
 *      returned 4 days ago, 2 still ACTIVE past due_date but in
 *      this seed we set due_date=tomorrow so the class set stays
 *      PARTIALLY_RETURNED rather than tripping the OVERDUE worker
 *      until the runtime exercises that path.
 *
 *      Wait — the plan says 23 returned + 2 outstanding for a 25
 *      copy checkout. We honour that: 23 individual lib_checkouts
 *      with returned_at + status=RETURNED, 2 with returned_at NULL
 *      + status=ACTIVE. Class set row has returned_count=23 +
 *      status=PARTIALLY_RETURNED.
 *
 *      lib_catalogue_copies state after seed: 23 of Number the
 *      Stars copies are is_available=true + ON_SHELF, 2 are
 *      is_available=false + CHECKED_OUT.
 *
 *   E) 15 lib_recommendations across 3 students (Maya, Ethan,
 *      Aaliyah) — 5 per student, one row of each reason_type
 *      (COLLABORATIVE_FILTERING, READING_LEVEL_MATCH, SUBJECT_MATCH,
 *      NEW_ARRIVAL, STAFF_PICK). Scores normalised 0.45–0.95
 *      across the rows so the Step 6 dashboard renders a useful
 *      ranking spread. generated_at = today.
 *
 *   F) 2 lib_interlibrary_loans — both via "Eastside Elementary":
 *        - 1 BORROWED ACTIVE for "The Outsiders" by S. E. Hinton,
 *          requested 7d ago, received 4d ago, due in 21d. ISBN
 *          populated but catalogue_item_id NULL because the book
 *          is not in our catalogue.
 *        - 1 LENT RETURNED for Number the Stars to "Westside
 *          Middle School", request 30d ago, sent 28d ago,
 *          returned 5d ago. catalogue_item_id populated.
 *
 *   G) 1 lib_catalogue_import_jobs — ISBN_BATCH COMPLETED 14d ago.
 *      total_records=50, records_imported=45, records_skipped=3,
 *      records_failed=2. error_log_s3_key populated.
 *
 * IAM grants — none needed. Cycle 12 already grants Staff
 * LIB-002:write + LIB-003:write so the librarian processes class
 * sets + ILL + import. Teacher already holds LIB-003:write so
 * they can author reading lists. Student already holds
 * LIB-003:read+write covering recommendation reads + dismiss +
 * book reviews. Parent holds LIB-001:read covering published
 * list browsing. School Admin + Platform Admin already hold all
 * LIB-*:admin via everyFunction.
 *
 * Final seed shape — 8 tables touched (5 + 23 + 2 + 13 + 1 + 25 +
 * 15 + 2 + 1 = 87 rows planted; 5 lists items + 23 copies + 2
 * lists + 13 list items + 1 class set + 25 class-set checkouts +
 * 15 recommendations + 2 ILLs + 1 import = 87 rows).
 */

const TENANT_SCHEMA = 'tenant_demo';

function isoDateOffset(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d;
}

function dateOnlyOffset(daysFromToday: number): string {
  return isoDateOffset(daysFromToday).toISOString().slice(0, 10);
}

async function seedLibraryAdvanced(): Promise<void> {
  console.log('');
  console.log(
    '  Library Advanced Seed (P2-25 Step 3 — Reading lists + Class sets + Recs + ILL + Import)',
  );
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  async function findEmployeeId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT he.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees he ' +
        'JOIN platform.iam_person p ON p.id = he.person_id ' +
        'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees not found for ' + email);
    return rows[0]!.id;
  }

  async function findEmployeePersonId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT he.person_id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees he ' +
        'JOIN platform.platform_users pu ON pu.person_id = he.person_id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees not found for ' + email);
    return rows[0]!.id;
  }

  async function findStudentByName(
    firstName: string,
    lastName: string,
  ): Promise<{ studentId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS sis_id, p.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2',
      firstName,
      lastName,
    )) as Array<{ sis_id: string; person_id: string }>;
    if (rows.length === 0)
      throw new Error('sis_students not found for ' + firstName + ' ' + lastName);
    return { studentId: rows[0]!.sis_id, personId: rows[0]!.person_id };
  }

  async function findCatalogueItemByTitle(title: string): Promise<string | null> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.lib_catalogue_items WHERE school_id = $1::uuid AND title = $2',
      schoolId,
      title,
    )) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  async function findCurriculumUnitByTitle(title: string): Promise<string | null> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT u.id::text AS id FROM ' + TENANT_SCHEMA + '.cur_units u WHERE u.title = $1',
      title,
    )) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  async function findLocationByName(name: string): Promise<string | null> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.lib_locations WHERE school_id = $1::uuid AND name = $2',
      schoolId,
      name,
    )) as Array<{ id: string }>;
    return rows.length === 0 ? null : rows[0]!.id;
  }

  const mitchellEmpId = await findEmployeeId('principal@demo.campusos.dev');
  const riveraEmpId = await findEmployeeId('teacher@demo.campusos.dev');
  const riveraPersonId = await findEmployeePersonId('teacher@demo.campusos.dev');
  const maya = await findStudentByName('Maya', 'Chen');
  const ethan = await findStudentByName('Ethan', 'Rodriguez');
  const aaliyah = await findStudentByName('Aaliyah', 'Johnson');

  // ── 2. Idempotency gate ──────────────────────────────────────
  const existingClassSets = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.lib_class_set_checkouts WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingClassSets[0] && existingClassSets[0].c > 0) {
    console.log('  lib_class_set_checkouts already populated for demo school — skipping');
    return;
  }

  // Lookups for cross-cycle linkage + Cycle 12 base catalogue
  const itemNumberTheStarsId = await findCatalogueItemByTitle('Number the Stars');
  if (!itemNumberTheStarsId)
    throw new Error('Number the Stars not found in catalogue — run seed-library first');
  const itemTheGiverId = await findCatalogueItemByTitle('The Giver');
  if (!itemTheGiverId) throw new Error('The Giver not found in catalogue');
  const itemHolesId = await findCatalogueItemByTitle('Holes');
  if (!itemHolesId) throw new Error('Holes not found in catalogue');
  const itemWonderId = await findCatalogueItemByTitle('Wonder');
  if (!itemWonderId) throw new Error('Wonder not found in catalogue');
  const itemCharlottesWebId = await findCatalogueItemByTitle("Charlotte's Web");
  if (!itemCharlottesWebId) throw new Error("Charlotte's Web not found in catalogue");

  const curriculumUnitNarrativeId = await findCurriculumUnitByTitle('Narrative Writing');
  if (!curriculumUnitNarrativeId)
    throw new Error('Curriculum unit "Narrative Writing" not found — run seed-curriculum first');

  const locFictionId = await findLocationByName('Fiction Shelves');
  if (!locFictionId) throw new Error('Fiction Shelves location not found');

  // ── A. 5 additional catalogue items ──────────────────────────
  console.log('  A) 5 additional catalogue items:');
  const itemIslandId = generateId();
  const itemEsperanzaId = generateId();
  const itemCodeTalkerId = generateId();
  const itemBridgeId = generateId();
  const itemNewMoonId = generateId();

  const newItems: Array<{
    id: string;
    title: string;
    author: string;
    isbn: string;
    publisher: string;
    year: number;
    category: string;
    dewey: string;
  }> = [
    {
      id: itemIslandId,
      title: 'Island of the Blue Dolphins',
      author: "Scott O'Dell",
      isbn: '978-0547328614',
      publisher: 'HMH Books',
      year: 1960,
      category: 'Historical Fiction',
      dewey: '813.54',
    },
    {
      id: itemEsperanzaId,
      title: 'Esperanza Rising',
      author: 'Pam Muñoz Ryan',
      isbn: '978-0439120425',
      publisher: 'Scholastic',
      year: 2000,
      category: 'Historical Fiction',
      dewey: '813.54',
    },
    {
      id: itemCodeTalkerId,
      title: 'Code Talker',
      author: 'Joseph Bruchac',
      isbn: '978-0142405963',
      publisher: 'Speak',
      year: 2005,
      category: 'Historical Fiction',
      dewey: '813.54',
    },
    {
      id: itemBridgeId,
      title: 'Bridge to Terabithia',
      author: 'Katherine Paterson',
      isbn: '978-0064401845',
      publisher: 'HarperCollins',
      year: 1977,
      category: 'Fiction',
      dewey: '813.54',
    },
    {
      id: itemNewMoonId,
      title: 'A Wrinkle in Time',
      author: "Madeleine L'Engle",
      isbn: '978-0312367541',
      publisher: 'Square Fish',
      year: 1962,
      category: 'Fiction',
      dewey: '813.54',
    },
  ];

  for (const it of newItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_catalogue_items (id, school_id, title, author, isbn, publisher, publish_year, category, dewey_decimal, description, cover_image_url) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      it.id,
      schoolId,
      it.title,
      it.author,
      it.isbn,
      it.publisher,
      it.year,
      it.category,
      it.dewey,
      'A novel by ' + it.author + ' (' + it.year + ').',
      'https://covers.example.com/' + it.isbn + '.jpg',
    );
    console.log('     - ' + it.title + ' by ' + it.author);
  }

  // ── B. 23 additional copies of Number the Stars ──────────────
  console.log('  B) 23 additional copies of Number the Stars (LIB-NTS-001..023):');
  const numberCopyIds: string[] = [];
  for (let i = 1; i <= 23; i++) {
    const copyId = generateId();
    numberCopyIds.push(copyId);
    const barcode = 'LIB-NTS-' + String(i).padStart(3, '0');
    // First 21 are returned (ON_SHELF), last 2 are still CHECKED_OUT
    const isReturned = i <= 21;
    const isAvailable = isReturned;
    const status = isReturned ? 'ON_SHELF' : 'CHECKED_OUT';
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_catalogue_copies (id, catalogue_item_id, location_id, barcode, condition, is_available, location_status, replacement_value) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)',
      copyId,
      itemNumberTheStarsId,
      locFictionId,
      barcode,
      'GOOD',
      isAvailable,
      status,
      6.99,
    );
  }
  console.log('     - 21 RETURNED to ON_SHELF, 2 still CHECKED_OUT');

  // Plan says 23 returned + 2 outstanding. We use the 21+2 split on
  // the 23 new copies and add the 2 existing copies from Cycle 12
  // as the additional "returned" rows so the class set spans 25
  // copies cleanly. The Cycle 12 copies (LIB-FIC-007 + LIB-FIC-008)
  // are already available; we'll link them into the class set as
  // RETURNED rows so the final tally is 23 returned + 2 outstanding.
  const cycle12NumberCopyRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, barcode FROM ' +
      TENANT_SCHEMA +
      '.lib_catalogue_copies WHERE catalogue_item_id = $1::uuid AND id != ALL($2::uuid[]) ORDER BY barcode',
    itemNumberTheStarsId,
    numberCopyIds,
  )) as Array<{ id: string; barcode: string }>;
  if (cycle12NumberCopyRows.length < 2) {
    throw new Error(
      'Expected at least 2 Cycle 12 Number the Stars copies, found ' + cycle12NumberCopyRows.length,
    );
  }
  const cycle12NumberCopyIds = cycle12NumberCopyRows.slice(0, 2).map((r) => r.id);
  console.log(
    '     - Reusing Cycle 12 copies ' +
      cycle12NumberCopyRows
        .slice(0, 2)
        .map((r) => r.barcode)
        .join(', ') +
      ' as part of the 25-copy class set',
  );

  // ── C. 2 reading lists + 13 items ────────────────────────────
  console.log('  C) 2 reading lists with items:');

  // C1. Grade 5 Historical Fiction CURRICULUM_UNIT
  const histListId = generateId();
  const histListPublishedAt = isoDateOffset(-10).toISOString();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_lists (id, school_id, name, description, list_type, created_by, target_grade_level, curriculum_unit_id, is_published, published_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'Grade 5 Historical Fiction', $3, 'CURRICULUM_UNIT', $4::uuid, '5', $5::uuid, true, $6::timestamptz)",
    histListId,
    schoolId,
    'A curated booklist tied to the Narrative Writing curriculum unit — students explore historical settings through fictional protagonists. Three required reads anchor the unit; four recommendations support varied reading levels; one extension challenges advanced readers.',
    mitchellEmpId,
    curriculumUnitNarrativeId,
    histListPublishedAt,
  );
  console.log('     - Grade 5 Historical Fiction CURRICULUM_UNIT (linked to Narrative Writing)');

  const histListItems: Array<{
    catalogueItemId: string;
    title: string;
    type: string;
    sort: number;
  }> = [
    { catalogueItemId: itemNumberTheStarsId, title: 'Number the Stars', type: 'REQUIRED', sort: 0 },
    {
      catalogueItemId: itemIslandId,
      title: 'Island of the Blue Dolphins',
      type: 'REQUIRED',
      sort: 1,
    },
    { catalogueItemId: itemEsperanzaId, title: 'Esperanza Rising', type: 'REQUIRED', sort: 2 },
    { catalogueItemId: itemCodeTalkerId, title: 'Code Talker', type: 'RECOMMENDED', sort: 3 },
    { catalogueItemId: itemTheGiverId, title: 'The Giver', type: 'RECOMMENDED', sort: 4 },
    { catalogueItemId: itemHolesId, title: 'Holes', type: 'RECOMMENDED', sort: 5 },
    { catalogueItemId: itemBridgeId, title: 'Bridge to Terabithia', type: 'RECOMMENDED', sort: 6 },
    { catalogueItemId: itemWonderId, title: 'Wonder', type: 'EXTENSION', sort: 7 },
  ];
  for (const li of histListItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_reading_list_items (id, reading_list_id, catalogue_item_id, item_type, sort_order, added_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)',
      generateId(),
      histListId,
      li.catalogueItemId,
      li.type,
      li.sort,
      mitchellEmpId,
    );
  }
  console.log('     - 8 items (3 REQUIRED, 4 RECOMMENDED, 1 EXTENSION)');

  // C2. New Arrivals March 2026 GENERAL
  const newArrivalsListId = generateId();
  const newArrivalsPublishedAt = isoDateOffset(-3).toISOString();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_lists (id, school_id, name, description, list_type, created_by, is_published, published_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'New Arrivals March 2026', $3, 'GENERAL', $4::uuid, true, $5::timestamptz)",
    newArrivalsListId,
    schoolId,
    'Newest additions to the library this month.',
    mitchellEmpId,
    newArrivalsPublishedAt,
  );
  console.log('     - New Arrivals March 2026 GENERAL');

  const newArrivalsItems: Array<{ catalogueItemId: string; title: string; sort: number }> = [
    { catalogueItemId: itemEsperanzaId, title: 'Esperanza Rising', sort: 0 },
    { catalogueItemId: itemCodeTalkerId, title: 'Code Talker', sort: 1 },
    { catalogueItemId: itemBridgeId, title: 'Bridge to Terabithia', sort: 2 },
    { catalogueItemId: itemIslandId, title: 'Island of the Blue Dolphins', sort: 3 },
    { catalogueItemId: itemNewMoonId, title: 'A Wrinkle in Time', sort: 4 },
  ];
  for (const li of newArrivalsItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_reading_list_items (id, reading_list_id, catalogue_item_id, item_type, sort_order, added_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)',
      generateId(),
      newArrivalsListId,
      li.catalogueItemId,
      'RECOMMENDED',
      li.sort,
      mitchellEmpId,
    );
  }
  console.log('     - 5 items (all RECOMMENDED)');

  // ── D. 1 class set checkout + 25 individual checkouts ────────
  console.log('  D) 1 class set checkout (Number the Stars, 25 copies, PARTIALLY_RETURNED):');
  const classSetId = generateId();
  const checkoutDate = dateOnlyOffset(-21);
  const dueDate = dateOnlyOffset(1); // due tomorrow — not yet OVERDUE
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_class_set_checkouts (id, school_id, catalogue_item_id, teacher_patron_id, copy_count, checkout_date, due_date, returned_count, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 25, $5::date, $6::date, 23, 'PARTIALLY_RETURNED', $7)",
    classSetId,
    schoolId,
    itemNumberTheStarsId,
    riveraPersonId,
    checkoutDate,
    dueDate,
    "Rivera's English 9 class — 3-week study unit on WWII historical fiction.",
  );
  console.log(
    '     - class set id ' +
      classSetId +
      ' returned_count=23 status=PARTIALLY_RETURNED due ' +
      dueDate,
  );

  // 25 individual checkouts. 23 are RETURNED, 2 are ACTIVE.
  // First 21 use the new LIB-NTS-001..LIB-NTS-021 copies (RETURNED).
  // Next 2 use the Cycle 12 copies (RETURNED).
  // Last 2 use LIB-NTS-022 + LIB-NTS-023 (still ACTIVE).
  const returnedNewCopyIds = numberCopyIds.slice(0, 21);
  const activeNewCopyIds = numberCopyIds.slice(21, 23); // LIB-NTS-022 + LIB-NTS-023
  const allCheckouts: Array<{ copyId: string; returned: boolean }> = [];
  for (const id of returnedNewCopyIds) allCheckouts.push({ copyId: id, returned: true });
  for (const id of cycle12NumberCopyIds) allCheckouts.push({ copyId: id, returned: true });
  for (const id of activeNewCopyIds) allCheckouts.push({ copyId: id, returned: false });

  const returnedAt = isoDateOffset(-4).toISOString();
  for (const c of allCheckouts) {
    const checkoutId = generateId();
    if (c.returned) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, returned_at, status, class_set_checkout_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::timestamptz, 'RETURNED', $7::uuid)",
        checkoutId,
        c.copyId,
        riveraPersonId,
        checkoutDate,
        dueDate,
        returnedAt,
        classSetId,
      );
    } else {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, status, class_set_checkout_id) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 'ACTIVE', $6::uuid)",
        checkoutId,
        c.copyId,
        riveraPersonId,
        checkoutDate,
        dueDate,
        classSetId,
      );
    }
  }
  console.log(
    '     - 25 individual lib_checkouts linked via class_set_checkout_id (23 RETURNED, 2 ACTIVE)',
  );

  // Flip the Cycle 12 copies that were ON_SHELF to RETURNED (no-op
  // for is_available) and ensure LIB-NTS-022 + LIB-NTS-023 stay
  // CHECKED_OUT (already set in section B).

  // ── E. 15 recommendations across 3 students ──────────────────
  console.log('  E) 15 recommendations across 3 students (5 each, one of each reason_type):');
  const recReasons: Array<{
    reason: string;
    score: number;
    title: string;
    itemKey: string;
    metadata: Record<string, unknown>;
  }> = [
    {
      reason: 'COLLABORATIVE_FILTERING',
      score: 0.92,
      title: 'Island of the Blue Dolphins',
      itemKey: 'island',
      metadata: { sharedCheckoutCount: 5, similarStudentCount: 3 },
    },
    {
      reason: 'READING_LEVEL_MATCH',
      score: 0.85,
      title: 'Esperanza Rising',
      itemKey: 'esperanza',
      metadata: { studentLexile: 800, itemLexile: 750 },
    },
    {
      reason: 'NEW_ARRIVAL',
      score: 0.65,
      title: 'A Wrinkle in Time',
      itemKey: 'newmoon',
      metadata: { addedDaysAgo: 7 },
    },
    {
      reason: 'SUBJECT_MATCH',
      score: 0.78,
      title: 'Code Talker',
      itemKey: 'codetalker',
      metadata: { matchedTags: ['historical fiction', 'WWII'] },
    },
    {
      reason: 'STAFF_PICK',
      score: 0.55,
      title: 'The Giver',
      itemKey: 'giver',
      metadata: { listName: 'New Arrivals March 2026' },
    },
  ];

  const itemKeyToId: Record<string, string> = {
    island: itemIslandId,
    esperanza: itemEsperanzaId,
    newmoon: itemNewMoonId,
    codetalker: itemCodeTalkerId,
    giver: itemTheGiverId,
  };

  const students: Array<{ studentId: string; name: string }> = [
    { studentId: maya.studentId, name: 'Maya' },
    { studentId: ethan.studentId, name: 'Ethan' },
    { studentId: aaliyah.studentId, name: 'Aaliyah' },
  ];

  const generatedAt = new Date().toISOString();
  for (const s of students) {
    for (const r of recReasons) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.lib_recommendations (id, student_id, recommended_item_id, reason_type, score, reason_metadata, generated_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::timestamptz)',
        generateId(),
        s.studentId,
        itemKeyToId[r.itemKey],
        r.reason,
        r.score,
        JSON.stringify(r.metadata),
        generatedAt,
      );
    }
    console.log('     - ' + s.name + ': 5 recommendations (CF + RLM + SM + NA + SP)');
  }

  // ── F. 2 interlibrary loans ──────────────────────────────────
  console.log('  F) 2 interlibrary loans (1 BORROWED ACTIVE, 1 LENT RETURNED):');
  const illBorrowedId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_interlibrary_loans (id, school_id, loan_direction, partner_institution, title, author, isbn, request_date, received_date, due_date, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'BORROWED', $3, $4, $5, $6, $7::date, $8::date, $9::date, 'ACTIVE', $10)",
    illBorrowedId,
    schoolId,
    'Eastside Elementary',
    'The Outsiders',
    'S. E. Hinton',
    '978-0140385724',
    dateOnlyOffset(-7),
    dateOnlyOffset(-4),
    dateOnlyOffset(21),
    'Student request — not in our catalogue. Eastside is shipping their second copy.',
  );
  console.log('     - BORROWED ACTIVE: The Outsiders (Eastside Elementary), due in 21d');

  const illLentId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_interlibrary_loans (id, school_id, loan_direction, partner_institution, catalogue_item_id, title, author, isbn, request_date, sent_date, due_date, returned_date, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'LENT', $3, $4::uuid, $5, $6, $7, $8::date, $9::date, $10::date, $11::date, 'RETURNED', $12)",
    illLentId,
    schoolId,
    'Westside Middle School',
    itemNumberTheStarsId,
    'Number the Stars',
    'Lois Lowry',
    '978-0547577098',
    dateOnlyOffset(-30),
    dateOnlyOffset(-28),
    dateOnlyOffset(-7),
    dateOnlyOffset(-5),
    'Returned on time and in good condition.',
  );
  console.log('     - LENT RETURNED: Number the Stars to Westside Middle School');

  // ── G. 1 import job ──────────────────────────────────────────
  console.log('  G) 1 catalogue import job (ISBN_BATCH COMPLETED):');
  const importJobId = generateId();
  const importStartedAt = isoDateOffset(-14).toISOString();
  const importCompletedAt = isoDateOffset(-14).toISOString();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_catalogue_import_jobs (id, school_id, import_type, total_records, records_imported, records_skipped, records_failed, status, initiated_by, error_log_s3_key, started_at, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'ISBN_BATCH', 50, 45, 3, 2, 'COMPLETED', $3::uuid, $4, $5::timestamptz, $6::timestamptz)",
    importJobId,
    schoolId,
    mitchellEmpId,
    'imports/2026-04/import-' + importJobId + '-errors.csv',
    importStartedAt,
    importCompletedAt,
  );
  console.log('     - ISBN_BATCH COMPLETED: 50 total, 45 imported, 3 skipped, 2 failed');

  void riveraEmpId;
  void ethan; // referenced via students array
  void aaliyah; // referenced via students array

  console.log('');
  console.log('  ✓ Library Advanced seed complete:');
  console.log('     - 5 new catalogue items');
  console.log('     - 23 new copies of Number the Stars');
  console.log('     - 2 reading lists with 8 + 5 = 13 items');
  console.log('     - 1 class set checkout PARTIALLY_RETURNED + 25 individual checkouts');
  console.log('     - 15 recommendations across 3 students');
  console.log('     - 2 interlibrary loans (1 BORROWED ACTIVE + 1 LENT RETURNED)');
  console.log('     - 1 ISBN_BATCH import job COMPLETED');
}

async function main(): Promise<void> {
  try {
    await seedLibraryAdvanced();
  } catch (e: unknown) {
    console.error('seed-library-advanced failed:', e);
    process.exitCode = 1;
  } finally {
    await disconnectAll();
  }
}

main();
