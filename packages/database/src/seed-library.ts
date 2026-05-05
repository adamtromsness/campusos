import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-library.ts — Cycle 12 Step 4.
 *
 * Idempotent. Gated on whether lib_locations already has rows for the
 * demo school. Re-running is a no-op once the seed has landed.
 *
 * Eleven sections covering all 14 lib_* tables:
 *   A) 3 lib_locations rows (Fiction Shelves SHELF, Non-Fiction
 *      Shelves SHELF, New Arrivals Display DISPLAY).
 *   B) 5 lib_catalogue_items rows (The Giver, Charlotte's Web,
 *      Number the Stars, Holes, Wonder) with ISBN + author + Dewey
 *      decimal + cover_image_url placeholder.
 *   C) 11 lib_catalogue_copies rows — 3 copies of The Giver
 *      (LIB-FIC-001 through 003) + 2 copies each of the other 4
 *      titles (3 + 2×4 = 11). 1 copy of The Giver (#001)
 *      is_available=false + location_status=CHECKED_OUT (Maya's
 *      active checkout). Plan said "12 copies" but the math is 11
 *      — we ship 11 to match what the section actually plants.
 *   D) 2 lib_checkout_policies rows — STUDENT (max=5, loan=14d,
 *      renewals=2, fine=$0.25) + STAFF (max=20, loan=30d, renewals=5,
 *      fine=$0).
 *   E) 3 lib_checkouts rows:
 *        - Maya ACTIVE The Giver copy 001, checked out 5 days ago,
 *          due in 9 days.
 *        - Ethan RETURNED Charlotte's Web (returned 3 days ago, on
 *          time — no fine).
 *        - Maya RETURNED Holes 2 days overdue (returned 2 days past
 *          due_date, generates the OVERDUE fine in section H).
 *   F) 1 lib_holds row — Ethan PENDING on The Giver.
 *   G) 1 lib_fines row — Maya's overdue Holes return: OVERDUE, 2
 *      days × $0.25 = $0.50, status=OUTSTANDING.
 *   H) 1 lib_reading_programmes row — Summer Reading Challenge 2026,
 *      SCHOOL_WIDE, target_books=10, ACTIVE.
 *   I) 1 lib_programme_progress row for Maya — books_read=2,
 *      pages_read=313 (Holes 233 + Charlotte's Web in-progress 80),
 *      is_complete=false.
 *   J) 2 lib_reading_logs rows for Maya:
 *        - Holes completed, 233 pages, rating=4
 *        - Charlotte's Web in-progress, 80 pages so far
 *   K) 1 lib_reading_lists row — "Grade 5 Fiction Essentials" CLASS
 *      type, published, by Mitchell. 3 lib_reading_list_items rows:
 *        - The Giver REQUIRED
 *        - Charlotte's Web RECOMMENDED
 *        - Number the Stars EXTENSION
 *   L) 1 lib_reviews row — Maya 4-star review on Holes.
 *
 * Final seed shape — 14 lib_* tables touched, 35 rows total
 * (3 locations + 5 items + 11 copies + 2 policies + 3 checkouts +
 * 1 hold + 1 fine + 1 programme + 1 progress + 2 logs + 1 list +
 * 3 list-items + 1 review).
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

async function seedLibrary() {
  console.log('');
  console.log('  Library Seed (Cycle 12 Step 4 — Catalogue + Circulation + Reading + Reviews)');
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
    return rows[0].id;
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
    return { studentId: rows[0].sis_id, personId: rows[0].person_id };
  }

  const mitchellEmpId = await findEmployeeId('principal@demo.campusos.dev');
  const maya = await findStudentByName('Maya', 'Chen');
  const ethan = await findStudentByName('Ethan', 'Rodriguez');

  // ── 2. Idempotency gate ──────────────────────────────────────
  const existingLocations = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' + TENANT_SCHEMA + '.lib_locations WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingLocations[0] && existingLocations[0].c > 0) {
    console.log('  lib_locations already populated for demo school — skipping');
    return;
  }

  // ── 3. Locations ─────────────────────────────────────────────
  console.log('  A) 3 locations:');
  const locFiction = generateId();
  const locNonFiction = generateId();
  const locDisplay = generateId();
  const locations: Array<{ id: string; name: string; type: string; sort: number }> = [
    { id: locFiction, name: 'Fiction Shelves', type: 'SHELF', sort: 0 },
    { id: locNonFiction, name: 'Non-Fiction Shelves', type: 'SHELF', sort: 1 },
    { id: locDisplay, name: 'New Arrivals Display', type: 'DISPLAY', sort: 2 },
  ];
  for (const l of locations) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_locations (id, school_id, name, location_type, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      l.id,
      schoolId,
      l.name,
      l.type,
      l.sort,
    );
    console.log('     - ' + l.name + ' (' + l.type + ')');
  }

  // ── 4. Catalogue items ───────────────────────────────────────
  console.log('  B) 5 catalogue items:');
  const itemTheGiver = generateId();
  const itemCharlottesWeb = generateId();
  const itemNumberTheStars = generateId();
  const itemHoles = generateId();
  const itemWonder = generateId();

  const items: Array<{
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
      id: itemTheGiver,
      title: 'The Giver',
      author: 'Lois Lowry',
      isbn: '978-0544336261',
      publisher: 'HMH Books',
      year: 1993,
      category: 'Fiction',
      dewey: '813.54',
    },
    {
      id: itemCharlottesWeb,
      title: "Charlotte's Web",
      author: 'E. B. White',
      isbn: '978-0061124952',
      publisher: 'HarperCollins',
      year: 1952,
      category: 'Fiction',
      dewey: '813.54',
    },
    {
      id: itemNumberTheStars,
      title: 'Number the Stars',
      author: 'Lois Lowry',
      isbn: '978-0547577098',
      publisher: 'HMH Books',
      year: 1989,
      category: 'Historical Fiction',
      dewey: '813.54',
    },
    {
      id: itemHoles,
      title: 'Holes',
      author: 'Louis Sachar',
      isbn: '978-0440414803',
      publisher: 'Yearling',
      year: 1998,
      category: 'Fiction',
      dewey: '813.54',
    },
    {
      id: itemWonder,
      title: 'Wonder',
      author: 'R. J. Palacio',
      isbn: '978-0375869020',
      publisher: 'Knopf',
      year: 2012,
      category: 'Fiction',
      dewey: '813.6',
    },
  ];

  for (const it of items) {
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
    console.log('     - ' + it.title + ' by ' + it.author + ' (ISBN ' + it.isbn + ')');
  }

  // ── 5. Catalogue copies ──────────────────────────────────────
  console.log('  C) 11 copies:');
  const copyGiver1 = generateId();
  const copyGiver2 = generateId();
  const copyGiver3 = generateId();
  const copyCharlotte1 = generateId();
  const copyCharlotte2 = generateId();
  const copyNumber1 = generateId();
  const copyNumber2 = generateId();
  const copyHoles1 = generateId();
  const copyHoles2 = generateId();
  const copyWonder1 = generateId();
  const copyWonder2 = generateId();
  const copyGiver1bis = copyGiver1; // alias for readability
  void copyGiver1bis;

  const copies: Array<{
    id: string;
    itemId: string;
    title: string;
    locationId: string;
    barcode: string;
    condition: string;
    available: boolean;
    status: string;
    replacement: number;
  }> = [
    // The Giver — 3 copies. Copy #1 is CHECKED_OUT (Maya's active checkout).
    {
      id: copyGiver1,
      itemId: itemTheGiver,
      title: 'The Giver',
      locationId: locFiction,
      barcode: 'LIB-FIC-001',
      condition: 'GOOD',
      available: false,
      status: 'CHECKED_OUT',
      replacement: 9.99,
    },
    {
      id: copyGiver2,
      itemId: itemTheGiver,
      title: 'The Giver',
      locationId: locFiction,
      barcode: 'LIB-FIC-002',
      condition: 'NEW',
      available: true,
      status: 'ON_SHELF',
      replacement: 9.99,
    },
    {
      id: copyGiver3,
      itemId: itemTheGiver,
      title: 'The Giver',
      locationId: locFiction,
      barcode: 'LIB-FIC-003',
      condition: 'FAIR',
      available: true,
      status: 'ON_SHELF',
      replacement: 9.99,
    },
    // Charlotte's Web — 2 copies
    {
      id: copyCharlotte1,
      itemId: itemCharlottesWeb,
      title: "Charlotte's Web",
      locationId: locFiction,
      barcode: 'LIB-FIC-101',
      condition: 'GOOD',
      available: true,
      status: 'ON_SHELF',
      replacement: 8.99,
    },
    {
      id: copyCharlotte2,
      itemId: itemCharlottesWeb,
      title: "Charlotte's Web",
      locationId: locFiction,
      barcode: 'LIB-FIC-102',
      condition: 'NEW',
      available: true,
      status: 'ON_SHELF',
      replacement: 8.99,
    },
    // Number the Stars — 2 copies
    {
      id: copyNumber1,
      itemId: itemNumberTheStars,
      title: 'Number the Stars',
      locationId: locFiction,
      barcode: 'LIB-FIC-201',
      condition: 'GOOD',
      available: true,
      status: 'ON_SHELF',
      replacement: 8.99,
    },
    {
      id: copyNumber2,
      itemId: itemNumberTheStars,
      title: 'Number the Stars',
      locationId: locFiction,
      barcode: 'LIB-FIC-202',
      condition: 'FAIR',
      available: true,
      status: 'ON_SHELF',
      replacement: 8.99,
    },
    // Holes — 2 copies
    {
      id: copyHoles1,
      itemId: itemHoles,
      title: 'Holes',
      locationId: locFiction,
      barcode: 'LIB-FIC-301',
      condition: 'GOOD',
      available: true,
      status: 'ON_SHELF',
      replacement: 9.5,
    },
    {
      id: copyHoles2,
      itemId: itemHoles,
      title: 'Holes',
      locationId: locFiction,
      barcode: 'LIB-FIC-302',
      condition: 'NEW',
      available: true,
      status: 'ON_SHELF',
      replacement: 9.5,
    },
    // Wonder — 2 copies on the New Arrivals Display
    {
      id: copyWonder1,
      itemId: itemWonder,
      title: 'Wonder',
      locationId: locDisplay,
      barcode: 'LIB-FIC-401',
      condition: 'NEW',
      available: true,
      status: 'ON_SHELF',
      replacement: 12.99,
    },
    {
      id: copyWonder2,
      itemId: itemWonder,
      title: 'Wonder',
      locationId: locDisplay,
      barcode: 'LIB-FIC-402',
      condition: 'NEW',
      available: true,
      status: 'ON_SHELF',
      replacement: 12.99,
    },
  ];

  for (const c of copies) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_catalogue_copies (id, catalogue_item_id, location_id, barcode, condition, is_available, replacement_value, location_status) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)',
      c.id,
      c.itemId,
      c.locationId,
      c.barcode,
      c.condition,
      c.available,
      c.replacement,
      c.status,
    );
    console.log(
      '     - ' +
        c.barcode +
        ' / ' +
        c.title +
        ' / ' +
        c.condition +
        ' / ' +
        (c.available ? 'available' : 'CHECKED_OUT'),
    );
  }
  if (copies.length !== 11) {
    // The plan calls for 12 copies but the seed plants 11 since The Giver has 3 + the 4 other titles have 2 each = 11.
    // Re-reading the plan: "12 copies: 3 copies of The Giver + 2 each of the other 4 titles". 3 + 2×4 = 11.
    // Plan says 12 but math says 11. We follow the math; the plan summary in HANDOFF reflects the actual 11.
    void copies;
  }

  // ── 6. Checkout policies ─────────────────────────────────────
  console.log('  D) 2 checkout policies:');
  const policyStudentId = generateId();
  const policyStaffId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_checkout_policies (id, school_id, patron_type, max_checkouts, loan_period_days, renewals_allowed, overdue_fine_per_day) ' +
      "VALUES ($1::uuid, $2::uuid, 'STUDENT', 5, 14, 2, 0.25)",
    policyStudentId,
    schoolId,
  );
  console.log('     - STUDENT max=5 loan=14d renewals=2 fine=$0.25/day');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_checkout_policies (id, school_id, patron_type, max_checkouts, loan_period_days, renewals_allowed, overdue_fine_per_day) ' +
      "VALUES ($1::uuid, $2::uuid, 'STAFF', 20, 30, 5, 0)",
    policyStaffId,
    schoolId,
  );
  console.log('     - STAFF max=20 loan=30d renewals=5 fine=$0');

  // ── 7. Checkouts ─────────────────────────────────────────────
  console.log('  E) 3 checkouts:');
  // (1) Maya ACTIVE The Giver copy #1, 5 days ago, due in 9 days
  const checkoutMayaActiveId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, 'ACTIVE')",
    checkoutMayaActiveId,
    copyGiver1,
    maya.personId,
    dateOnlyOffset(-5),
    dateOnlyOffset(9),
  );
  console.log(
    '     - Maya ACTIVE The Giver (copy LIB-FIC-001) checked out ' +
      dateOnlyOffset(-5) +
      ' due ' +
      dateOnlyOffset(9),
  );

  // (2) Ethan RETURNED Charlotte's Web — checked out 17 days ago, returned 3 days ago (on time)
  const checkoutEthanReturnedId = generateId();
  const ethanReturnedAt = isoDateOffset(-3);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, returned_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::timestamptz, 'RETURNED')",
    checkoutEthanReturnedId,
    copyCharlotte1,
    ethan.personId,
    dateOnlyOffset(-17),
    dateOnlyOffset(-3),
    ethanReturnedAt.toISOString(),
  );
  console.log(
    "     - Ethan RETURNED Charlotte's Web (copy LIB-FIC-101) on time (returned " +
      ethanReturnedAt.toISOString().slice(0, 10) +
      ')',
  );

  // (3) Maya RETURNED Holes 2 days overdue — checked out 23 days ago, due 9 days ago, returned 7 days ago (2 days late)
  const checkoutMayaOverdueReturnedId = generateId();
  const mayaOverdueReturnedAt = isoDateOffset(-7);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_checkouts (id, copy_id, patron_id, checkout_date, due_date, returned_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::timestamptz, 'RETURNED')",
    checkoutMayaOverdueReturnedId,
    copyHoles1,
    maya.personId,
    dateOnlyOffset(-23),
    dateOnlyOffset(-9),
    mayaOverdueReturnedAt.toISOString(),
  );
  console.log(
    '     - Maya RETURNED Holes (copy LIB-FIC-301) 2 days overdue (due ' +
      dateOnlyOffset(-9) +
      ', returned ' +
      mayaOverdueReturnedAt.toISOString().slice(0, 10) +
      ')',
  );

  // ── 8. Hold ──────────────────────────────────────────────────
  console.log('  F) 1 hold:');
  const holdEthanGiverId = generateId();
  const holdPlacedAt = isoDateOffset(-2);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_holds (id, catalogue_item_id, patron_id, placed_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, 'PENDING')",
    holdEthanGiverId,
    itemTheGiver,
    ethan.personId,
    holdPlacedAt.toISOString(),
  );
  console.log(
    '     - Ethan PENDING hold on The Giver (placed ' +
      holdPlacedAt.toISOString().slice(0, 10) +
      ')',
  );

  // ── 9. Fine ──────────────────────────────────────────────────
  console.log('  G) 1 fine:');
  const fineMayaHolesId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_fines (id, checkout_id, patron_id, fine_type, amount, days_overdue, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'OVERDUE', 0.50, 2, 'OUTSTANDING')",
    fineMayaHolesId,
    checkoutMayaOverdueReturnedId,
    maya.personId,
  );
  console.log('     - Maya OUTSTANDING $0.50 OVERDUE on Holes (2 days × $0.25)');

  // ── 10. Reading programme + progress ─────────────────────────
  console.log('  H) 1 reading programme:');
  const programmeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_programmes (id, school_id, name, description, target_books, target_audience_type, start_date, end_date, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'Summer Reading Challenge 2026', $3, 10, 'SCHOOL_WIDE', $4::date, $5::date, true)",
    programmeId,
    schoolId,
    'Read 10 books over the school year. Earn a completion certificate when you finish.',
    dateOnlyOffset(-30),
    dateOnlyOffset(180),
  );
  console.log('     - Summer Reading Challenge 2026 SCHOOL_WIDE target_books=10 ACTIVE');

  console.log('  I) 1 programme progress row for Maya:');
  const progressMayaId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_programme_progress (id, programme_id, student_id, books_read, pages_read, last_updated_at, is_complete) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::timestamptz, false)',
    progressMayaId,
    programmeId,
    maya.studentId,
    2,
    313,
    isoDateOffset(-7).toISOString(),
  );
  console.log(
    "     - Maya: books_read=2, pages_read=313 (Holes 233 + Charlotte's Web 80), is_complete=false",
  );

  // ── 11. Reading logs ─────────────────────────────────────────
  console.log('  J) 2 reading logs for Maya:');
  const logHolesId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_logs (id, student_id, catalogue_item_id, started_date, completed_date, pages_read, rating, review_text) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6, $7, $8)',
    logHolesId,
    maya.studentId,
    itemHoles,
    dateOnlyOffset(-23),
    dateOnlyOffset(-7),
    233,
    4,
    'Loved how the past and present storylines wove together. Stanley is a great character.',
  );
  console.log('     - Holes COMPLETED 233 pages rating=4');

  const logCharlotteId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_logs (id, student_id, catalogue_item_id, started_date, pages_read) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5)',
    logCharlotteId,
    maya.studentId,
    itemCharlottesWeb,
    dateOnlyOffset(-3),
    80,
  );
  console.log("     - Charlotte's Web IN PROGRESS 80 pages so far");

  // ── 12. Reading list + items ─────────────────────────────────
  console.log('  K) 1 reading list with 3 items:');
  const listId = generateId();
  const listPublishedAt = isoDateOffset(-5);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reading_lists (id, school_id, name, description, list_type, created_by, is_published, published_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'Grade 5 Fiction Essentials', $3, 'CLASS', $4::uuid, true, $5::timestamptz)",
    listId,
    schoolId,
    'A core fiction list for Grade 5 — three titles to anchor classroom reading discussions.',
    mitchellEmpId,
    listPublishedAt.toISOString(),
  );
  console.log(
    '     - Grade 5 Fiction Essentials CLASS published ' +
      listPublishedAt.toISOString().slice(0, 10),
  );

  const listItems: Array<{
    id: string;
    catalogueItemId: string;
    title: string;
    type: string;
    sort: number;
  }> = [
    {
      id: generateId(),
      catalogueItemId: itemTheGiver,
      title: 'The Giver',
      type: 'REQUIRED',
      sort: 0,
    },
    {
      id: generateId(),
      catalogueItemId: itemCharlottesWeb,
      title: "Charlotte's Web",
      type: 'RECOMMENDED',
      sort: 1,
    },
    {
      id: generateId(),
      catalogueItemId: itemNumberTheStars,
      title: 'Number the Stars',
      type: 'EXTENSION',
      sort: 2,
    },
  ];
  for (const li of listItems) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.lib_reading_list_items (id, reading_list_id, catalogue_item_id, item_type, sort_order, added_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)',
      li.id,
      listId,
      li.catalogueItemId,
      li.type,
      li.sort,
      mitchellEmpId,
    );
    console.log('     - ' + li.title + ' ' + li.type + ' (sort=' + li.sort + ')');
  }

  // ── 13. Review ───────────────────────────────────────────────
  console.log('  L) 1 review:');
  const reviewMayaId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.lib_reviews (id, item_id, student_id, rating, review_text, is_approved) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true)',
    reviewMayaId,
    itemHoles,
    maya.studentId,
    4,
    'A really clever story. The desert setting felt vivid and the family-curse twist was unexpected.',
  );
  console.log('     - Maya rates Holes 4/5 — review approved');

  console.log('');
  console.log('  Library seed complete!');
}

seedLibrary()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => process.exit(1));
  });
