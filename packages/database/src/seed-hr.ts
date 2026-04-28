import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

// Staff accounts that get an hr_employees row in Cycle 4 Step 0.
//
// admin@ is intentionally NOT bridged — it represents a system-admin persona,
// not a school employee. Two emails on the same iam_person (Mitchell appears
// as both admin@ and principal@) means we have to pick one of them; principal@
// wins because it's the school-scoped persona. UNIQUE(person_id) on hr_employees
// makes the choice exclusive.
interface StaffSpec {
  email: string;
  hireDate: string;
  employmentType:
    | 'FULL_TIME'
    | 'PART_TIME'
    | 'CONTRACT'
    | 'TEMPORARY'
    | 'INTERN'
    | 'VOLUNTEER';
  employeeNumber: string;
  // Display label for the seed log only.
  positionLabel: string;
}

var STAFF: StaffSpec[] = [
  {
    email: 'principal@demo.campusos.dev',
    hireDate: '2018-08-15',
    employmentType: 'FULL_TIME',
    employeeNumber: 'EMP-1001',
    positionLabel: 'Principal',
  },
  {
    email: 'teacher@demo.campusos.dev',
    hireDate: '2021-08-23',
    employmentType: 'FULL_TIME',
    employeeNumber: 'EMP-1002',
    positionLabel: 'Teacher',
  },
  {
    email: 'vp@demo.campusos.dev',
    hireDate: '2019-08-19',
    employmentType: 'FULL_TIME',
    employeeNumber: 'EMP-1003',
    positionLabel: 'Vice Principal',
  },
  {
    email: 'counsellor@demo.campusos.dev',
    hireDate: '2022-08-22',
    employmentType: 'FULL_TIME',
    employeeNumber: 'EMP-1004',
    positionLabel: 'Counsellor',
  },
];

async function seedHr() {
  console.log('');
  console.log('  HR Seed (Cycle 4 Step 0 — HR-Employee Identity Migration)');
  console.log('');

  var client = getPlatformClient();

  // ── 1. School lookup ─────────────────────────────────────
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) {
    throw new Error('demo school not found — run pnpm seed first');
  }
  var schoolId = school.id;

  // ── 2. Resolve (account_id, person_id) pairs for the 4 staff ──
  interface StaffRow {
    spec: StaffSpec;
    accountId: string;
    personId: string;
  }
  var staffRows: StaffRow[] = [];
  for (var i = 0; i < STAFF.length; i++) {
    var spec = STAFF[i]!;
    var account = await client.platformUser.findFirst({
      where: { email: spec.email },
      select: { id: true, personId: true },
    });
    if (!account) {
      throw new Error(spec.email + ' not found — run pnpm seed first');
    }
    staffRows.push({ spec: spec, accountId: account.id, personId: account.personId });
  }

  // ── 3. INSERT hr_employees rows (idempotent via ON CONFLICT) ──
  // ON CONFLICT on the person_id UNIQUE so reruns are no-ops on already-bridged
  // staff. account_id UNIQUE is also asserted at the table level so a re-insert
  // with a different account_id would be rejected.
  var inserted = 0;
  for (var j = 0; j < staffRows.length; j++) {
    var row = staffRows[j]!;
    var existing = await client.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees WHERE person_id = $1::uuid',
      row.personId,
    );
    if (existing.length > 0) {
      console.log(
        '  hr_employees row already exists for ' + row.spec.email + ' (' + row.spec.positionLabel + ')',
      );
      continue;
    }
    var employeeId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_employees ' +
        '(id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'ACTIVE', $7::date)",
      employeeId,
      row.personId,
      row.accountId,
      schoolId,
      row.spec.employeeNumber,
      row.spec.employmentType,
      row.spec.hireDate,
    );
    inserted += 1;
    console.log('  hr_employees row inserted for ' + row.spec.email + ' (' + row.spec.positionLabel + ')');
  }

  // ── 4. Bridge UPDATEs — re-point soft FKs from iam_person.id to hr_employees.id ──
  // Naturally idempotent: the join only matches rows whose column still holds
  // an iam_person.id; once the bridge has run, the column holds hr_employees.id
  // and the join finds nothing on a re-run.
  var bridgeStatements: Array<{ table: string; column: string }> = [
    { table: 'sis_class_teachers', column: 'teacher_employee_id' },
    { table: 'cls_grades', column: 'teacher_id' },
    { table: 'cls_lessons', column: 'teacher_id' },
    { table: 'cls_student_progress_notes', column: 'author_id' },
  ];
  console.log('');
  console.log('  Bridging soft FKs from iam_person.id to hr_employees.id:');
  for (var k = 0; k < bridgeStatements.length; k++) {
    var stmt = bridgeStatements[k]!;
    var bridgeCount = await client.$executeRawUnsafe(
      'UPDATE ' +
        TENANT_SCHEMA +
        '.' +
        stmt.table +
        ' t SET ' +
        stmt.column +
        ' = e.id ' +
        'FROM ' +
        TENANT_SCHEMA +
        '.hr_employees e ' +
        'WHERE e.person_id = t.' +
        stmt.column,
    );
    console.log('    ' + stmt.table + '.' + stmt.column + ' — bridged ' + bridgeCount + ' row(s)');
  }

  // ── 5. Verification — orphan check across all four bridged columns ──
  console.log('');
  console.log('  Orphan check (every value in a bridged column must resolve in hr_employees):');
  for (var m = 0; m < bridgeStatements.length; m++) {
    var b = bridgeStatements[m]!;
    var orphans = await client.$queryRawUnsafe<Array<{ orphans: bigint }>>(
      'SELECT count(*)::bigint AS orphans ' +
        'FROM ' +
        TENANT_SCHEMA +
        '.' +
        b.table +
        ' t ' +
        'WHERE t.' +
        b.column +
        ' IS NOT NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM ' +
        TENANT_SCHEMA +
        '.hr_employees e WHERE e.id = t.' +
        b.column +
        ')',
    );
    var n = orphans[0] ? Number(orphans[0].orphans) : 0;
    console.log('    ' + b.table + '.' + b.column + ' — ' + n + ' orphan(s)');
    if (n > 0) {
      throw new Error(
        'Bridge incomplete: ' +
          n +
          ' row(s) in ' +
          b.table +
          '.' +
          b.column +
          ' do not resolve to hr_employees.id',
      );
    }
  }

  // ── 6. Summary ────────────────────────────────────────────
  var totalEmployees = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_employees',
  );
  console.log('');
  console.log(
    '  HR seed complete — ' +
      (totalEmployees[0] ? Number(totalEmployees[0].c) : 0) +
      ' total hr_employees rows, ' +
      inserted +
      ' inserted this run',
  );
}

seedHr()
  .then(function () {
    return disconnectAll();
  })
  .then(function () {
    process.exit(0);
  })
  .catch(function (e) {
    console.error('HR seed failed:', e);
    disconnectAll().then(function () {
      process.exit(1);
    });
  });
