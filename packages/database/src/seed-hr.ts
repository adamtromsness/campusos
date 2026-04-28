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

  // ── 6. Step 5 layers: positions, leave, certifications, onboarding ──
  await seedStep5Layers(client, schoolId);

  // ── 7. Summary ────────────────────────────────────────────
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

interface EmployeeRow {
  id: string;
  account_email: string;
  hire_date: string;
}

async function loadEmployeesForSeed(client: any): Promise<EmployeeRow[]> {
  return client.$queryRawUnsafe<EmployeeRow[]>(
    'SELECT e.id::text AS id, u.email::text AS account_email, e.hire_date::text AS hire_date ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e ' +
      'JOIN platform.platform_users u ON u.id = e.account_id ' +
      'ORDER BY e.hire_date',
  );
}

async function seedStep5Layers(client: any, schoolId: string): Promise<void> {
  console.log('');
  console.log('  Step 5 layers — positions, leave, certifications, onboarding:');

  var employees = await loadEmployeesForSeed(client);
  var employeeByEmail: Record<string, EmployeeRow> = {};
  for (var i = 0; i < employees.length; i++) employeeByEmail[employees[i]!.account_email] = employees[i]!;
  var rivera = employeeByEmail['teacher@demo.campusos.dev'];
  var mitchell = employeeByEmail['principal@demo.campusos.dev'];
  var park = employeeByEmail['vp@demo.campusos.dev'];
  var hayes = employeeByEmail['counsellor@demo.campusos.dev'];
  if (!rivera || !mitchell || !park || !hayes) {
    throw new Error('seed-hr Step 5: missing employee rows. Run pnpm seed first.');
  }

  // Current academic year for balances and CPD targets.
  var ayRows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years WHERE is_current = true LIMIT 1',
  );
  if (ayRows.length === 0) {
    throw new Error('seed-hr Step 5: no current academic year. Run seed:sis first.');
  }
  var academicYearId = ayRows[0]!.id;

  await seedPositions(client, schoolId, rivera, mitchell, park, hayes);
  await seedLeave(client, schoolId, academicYearId, rivera, mitchell, park, hayes);
  await seedCertifications(client, schoolId, rivera, mitchell);
  await seedTrainingRequirements(client, schoolId);
  await seedTrainingCompliance(client, rivera, mitchell);
  await seedDocumentTypes(client, schoolId);
  await seedOnboarding(client, schoolId, rivera);
}

async function seedPositions(
  client: any,
  schoolId: string,
  rivera: EmployeeRow,
  mitchell: EmployeeRow,
  park: EmployeeRow,
  hayes: EmployeeRow,
): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_positions',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    positions already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }

  interface PositionSpec {
    title: string;
    isTeachingRole: boolean;
    holder: EmployeeRow | null;
  }
  var positions: PositionSpec[] = [
    { title: 'Teacher', isTeachingRole: true, holder: rivera },
    { title: 'Principal', isTeachingRole: false, holder: mitchell },
    { title: 'Vice Principal', isTeachingRole: false, holder: park },
    { title: 'Counsellor', isTeachingRole: false, holder: hayes },
    { title: 'Administrative Assistant', isTeachingRole: false, holder: null },
  ];

  for (var i = 0; i < positions.length; i++) {
    var spec = positions[i]!;
    var posId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_positions (id, school_id, title, is_teaching_role) VALUES ($1::uuid, $2::uuid, $3, $4)',
      posId,
      schoolId,
      spec.title,
      spec.isTeachingRole,
    );
    if (spec.holder) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.hr_employee_positions (id, employee_id, position_id, is_primary, fte, effective_from) VALUES ($1::uuid, $2::uuid, $3::uuid, true, 1.000, $4::date)',
        generateId(),
        spec.holder.id,
        posId,
        spec.holder.hire_date,
      );
    }
  }
  console.log('    positions: 5 rows + 4 employee_position assignments inserted');
}

async function seedLeave(
  client: any,
  schoolId: string,
  academicYearId: string,
  rivera: EmployeeRow,
  mitchell: EmployeeRow,
  park: EmployeeRow,
  hayes: EmployeeRow,
): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_leave_types',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    leave types already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }

  interface LeaveTypeSpec {
    name: string;
    isPaid: boolean;
    accrualRate: number;
    maxBalance: number | null;
  }
  var leaveTypes: LeaveTypeSpec[] = [
    { name: 'Sick Leave', isPaid: true, accrualRate: 10.0, maxBalance: 30.0 },
    { name: 'Personal Leave', isPaid: true, accrualRate: 3.0, maxBalance: 9.0 },
    { name: 'Bereavement Leave', isPaid: true, accrualRate: 5.0, maxBalance: 5.0 },
    { name: 'Professional Development', isPaid: true, accrualRate: 5.0, maxBalance: 10.0 },
    { name: 'Unpaid Leave', isPaid: false, accrualRate: 0.0, maxBalance: null },
  ];

  var typeIdByName: Record<string, string> = {};
  for (var i = 0; i < leaveTypes.length; i++) {
    var spec = leaveTypes[i]!;
    var id = generateId();
    typeIdByName[spec.name] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_leave_types (id, school_id, name, is_paid, accrual_rate, max_balance) VALUES ($1::uuid, $2::uuid, $3, $4, $5::numeric, $6::numeric)',
      id,
      schoolId,
      spec.name,
      spec.isPaid,
      spec.accrualRate.toFixed(2),
      spec.maxBalance === null ? null : spec.maxBalance.toFixed(2),
    );
  }

  var employees = [rivera, mitchell, park, hayes];
  // Per-employee balance shape — Rivera has used some sick/personal so the CAT can show running totals.
  interface BalanceState {
    accrued: number;
    used: number;
    pending: number;
  }
  function balanceFor(employee: EmployeeRow, typeName: string): BalanceState {
    if (typeName === 'Unpaid Leave') return { accrued: 0, used: 0, pending: 0 };
    var spec = leaveTypes.filter(function (l) { return l.name === typeName; })[0]!;
    // Rivera's running totals must agree with the seeded leave request rows
    // (one APPROVED Sick request for 2 days, one PENDING PD request for 1 day).
    // The non-negative balance CHECKs from migration 012 fail loudly if a
    // cancel underflows, so getting these in sync is essential for the
    // approval-flow smoke + the CAT.
    if (employee.account_email === 'teacher@demo.campusos.dev') {
      if (typeName === 'Sick Leave') return { accrued: spec.accrualRate, used: 2.0, pending: 0.0 };
      if (typeName === 'Professional Development') {
        return { accrued: spec.accrualRate, used: 0.0, pending: 1.0 };
      }
    }
    return { accrued: spec.accrualRate, used: 0, pending: 0 };
  }

  for (var ei = 0; ei < employees.length; ei++) {
    var employee = employees[ei]!;
    for (var ti = 0; ti < leaveTypes.length; ti++) {
      var type = leaveTypes[ti]!;
      var bal = balanceFor(employee, type.name);
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.hr_leave_balances (id, employee_id, leave_type_id, academic_year_id, accrued, used, pending) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::numeric, $6::numeric, $7::numeric)',
        generateId(),
        employee.id,
        typeIdByName[type.name],
        academicYearId,
        bal.accrued.toFixed(2),
        bal.used.toFixed(2),
        bal.pending.toFixed(2),
      );
    }
  }

  // 2 sample requests for Rivera — one APPROVED last March, one PENDING for next month.
  var approvedReviewedAt = '2026-03-08T15:00:00Z';
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days_requested, status, reason, submitted_at, reviewed_at, reviewed_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::numeric, 'APPROVED', $7, $8::timestamptz, $9::timestamptz, $10::uuid)",
    generateId(),
    rivera.id,
    typeIdByName['Sick Leave'],
    '2026-03-09',
    '2026-03-10',
    2.0,
    'Flu',
    '2026-03-08T08:00:00Z',
    approvedReviewedAt,
    mitchell.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_leave_requests (id, employee_id, leave_type_id, start_date, end_date, days_requested, status, reason) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6::numeric, 'PENDING', $7)",
    generateId(),
    rivera.id,
    typeIdByName['Professional Development'],
    '2026-05-15',
    '2026-05-15',
    1.0,
    'NCTM regional conference',
  );
  console.log(
    '    leave: 5 types, ' +
      employees.length * leaveTypes.length +
      ' balances, 2 sample requests (1 APPROVED, 1 PENDING)',
  );
}

async function seedCertifications(
  client: any,
  schoolId: string,
  rivera: EmployeeRow,
  mitchell: EmployeeRow,
): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_staff_certifications',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    certifications already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }

  // Rivera Teaching Licence expires in 60 days from today — drives the
  // CAT compliance dashboard amber row.
  var today = new Date();
  function daysFromNow(days: number): string {
    var d = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  interface CertSpec {
    employee: EmployeeRow;
    type: string;
    name: string;
    issuingBody: string;
    referenceNumber: string;
    issuedDate: string;
    expiryDate: string | null;
    status: string;
  }
  var certs: CertSpec[] = [
    {
      employee: rivera,
      type: 'TEACHING_LICENCE',
      name: 'Texas Standard Teaching Licence',
      issuingBody: 'Texas Education Agency',
      referenceNumber: 'TX-LIC-198473',
      issuedDate: '2021-08-01',
      expiryDate: daysFromNow(60),
      status: 'VERIFIED',
    },
    {
      employee: rivera,
      type: 'FIRST_AID',
      name: 'Adult and Pediatric First Aid / CPR / AED',
      issuingBody: 'American Red Cross',
      referenceNumber: 'ARC-FA-2025-9182',
      issuedDate: '2025-04-15',
      expiryDate: '2027-04-15',
      status: 'VERIFIED',
    },
    {
      employee: rivera,
      type: 'SAFEGUARDING_LEVEL1',
      name: 'Safeguarding Level 1 — School Staff',
      issuingBody: 'Lincoln Elementary',
      referenceNumber: 'LE-SG1-RIV-2026',
      issuedDate: '2026-01-12',
      expiryDate: '2027-01-12',
      status: 'VERIFIED',
    },
    {
      employee: mitchell,
      type: 'DBS_ENHANCED',
      name: 'DBS Enhanced Disclosure',
      issuingBody: 'UK DBS',
      referenceNumber: 'DBS-001234567890',
      issuedDate: '2024-08-20',
      expiryDate: '2027-08-20',
      status: 'VERIFIED',
    },
  ];

  for (var i = 0; i < certs.length; i++) {
    var c = certs[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_staff_certifications (id, employee_id, certification_type, certification_name, issuing_body, reference_number, issued_date, expiry_date, verification_status, verified_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::date, $8::date, $9, now())',
      generateId(),
      c.employee.id,
      c.type,
      c.name,
      c.issuingBody,
      c.referenceNumber,
      c.issuedDate,
      c.expiryDate,
      c.status,
    );
  }
  console.log(
    '    certifications: 4 rows (Rivera Teaching Licence expires ' +
      daysFromNow(60) +
      ' — CAT amber row trigger)',
  );
  // Suppress unused-variable warning when the function body is unreachable post-skip.
  void schoolId;
}

async function seedTrainingRequirements(client: any, schoolId: string): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_training_requirements',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    training requirements already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }
  var teacherPos = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_positions WHERE school_id = $1::uuid AND title = $2',
    schoolId,
    'Teacher',
  );
  var teacherPosId = teacherPos[0]?.id ?? null;

  interface RequirementSpec {
    name: string;
    certificationType: string | null;
    frequency: string;
    positionId: string | null;
  }
  var requirements: RequirementSpec[] = [
    { name: 'Annual Safeguarding Refresh', certificationType: 'SAFEGUARDING_LEVEL1', frequency: 'ANNUAL', positionId: null },
    { name: 'First Aid Recertification', certificationType: 'FIRST_AID', frequency: 'BIENNIAL', positionId: null },
    { name: 'Annual Fire Safety Briefing', certificationType: null, frequency: 'ANNUAL', positionId: null },
    { name: 'Teaching Licence Renewal', certificationType: 'TEACHING_LICENCE', frequency: 'ANNUAL', positionId: teacherPosId },
  ];

  for (var i = 0; i < requirements.length; i++) {
    var spec = requirements[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_training_requirements (id, school_id, position_id, training_name, certification_type, frequency) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
      generateId(),
      schoolId,
      spec.positionId,
      spec.name,
      spec.certificationType,
      spec.frequency,
    );
  }
  console.log('    training requirements: 4 rows (3 school-wide, 1 position-specific Teaching Licence Renewal)');
}

async function seedTrainingCompliance(
  client: any,
  rivera: EmployeeRow,
  mitchell: EmployeeRow,
): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_training_compliance',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    training compliance already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }
  // Resolve requirement ids by name.
  var reqRows = await client.$queryRawUnsafe<Array<{ id: string; training_name: string }>>(
    'SELECT id::text AS id, training_name FROM ' + TENANT_SCHEMA + '.hr_training_requirements',
  );
  var reqIdByName: Record<string, string> = {};
  for (var r = 0; r < reqRows.length; r++) reqIdByName[reqRows[r]!.training_name] = reqRows[r]!.id;

  // Resolve cert ids by (employee, type).
  var certRows = await client.$queryRawUnsafe<Array<{ id: string; employee_id: string; certification_type: string }>>(
    'SELECT id::text AS id, employee_id::text AS employee_id, certification_type FROM ' +
      TENANT_SCHEMA +
      '.hr_staff_certifications',
  );
  function findCert(employeeId: string, certType: string): string | null {
    for (var i = 0; i < certRows.length; i++) {
      if (certRows[i]!.employee_id === employeeId && certRows[i]!.certification_type === certType) {
        return certRows[i]!.id;
      }
    }
    return null;
  }

  interface ComplianceSpec {
    employee: EmployeeRow;
    requirement: string;
    isCompliant: boolean;
    lastCompletedDate: string | null;
    nextDueDate: string | null;
    linkedCert: string | null;
    daysUntilDue: number | null;
  }
  var rows: ComplianceSpec[] = [
    {
      employee: rivera,
      requirement: 'Annual Safeguarding Refresh',
      isCompliant: true,
      lastCompletedDate: '2026-01-12',
      nextDueDate: '2027-01-12',
      linkedCert: findCert(rivera.id, 'SAFEGUARDING_LEVEL1'),
      daysUntilDue: 259,
    },
    {
      employee: rivera,
      requirement: 'First Aid Recertification',
      isCompliant: true,
      lastCompletedDate: '2025-04-15',
      nextDueDate: '2027-04-15',
      linkedCert: findCert(rivera.id, 'FIRST_AID'),
      daysUntilDue: 351,
    },
    {
      employee: rivera,
      requirement: 'Teaching Licence Renewal',
      isCompliant: false,
      lastCompletedDate: '2021-08-01',
      nextDueDate: null,
      linkedCert: findCert(rivera.id, 'TEACHING_LICENCE'),
      daysUntilDue: 60,
    },
    {
      employee: mitchell,
      requirement: 'Annual Safeguarding Refresh',
      isCompliant: false,
      lastCompletedDate: null,
      nextDueDate: null,
      linkedCert: null,
      daysUntilDue: null,
    },
  ];

  for (var i = 0; i < rows.length; i++) {
    var c = rows[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_training_compliance (id, employee_id, requirement_id, is_compliant, last_completed_date, next_due_date, linked_certification_id, days_until_due) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::uuid, $8)',
      generateId(),
      c.employee.id,
      reqIdByName[c.requirement],
      c.isCompliant,
      c.lastCompletedDate,
      c.nextDueDate,
      c.linkedCert,
      c.daysUntilDue,
    );
  }
  console.log(
    '    training compliance: 4 pre-computed rows (Rivera 2 compliant + 1 amber Teaching Licence; Mitchell 1 non-compliant Safeguarding)',
  );
}

async function seedDocumentTypes(client: any, schoolId: string): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_document_types',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    document types already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }
  var docTypes = [
    { name: 'Employment Contract', isRequired: true, retentionDays: 2555 },
    { name: 'Background Check', isRequired: true, retentionDays: 2555 },
    { name: 'Tax Form W-4', isRequired: true, retentionDays: 1825 },
    { name: 'Teaching Licence Copy', isRequired: false, retentionDays: 1825 },
  ];
  for (var i = 0; i < docTypes.length; i++) {
    var d = docTypes[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_document_types (id, school_id, name, is_required, retention_days) VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      generateId(),
      schoolId,
      d.name,
      d.isRequired,
      d.retentionDays,
    );
  }
  console.log('    document types: 4 rows (Contract, Background Check, W-4, Teaching Licence Copy)');
}

async function seedOnboarding(client: any, schoolId: string, rivera: EmployeeRow): Promise<void> {
  var existing = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.hr_onboarding_templates',
  );
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('    onboarding template already seeded (' + existing[0].c + ' rows) — skipping');
    return;
  }
  var teacherPos = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_positions WHERE school_id = $1::uuid AND title = $2',
    schoolId,
    'Teacher',
  );
  var teacherPosId = teacherPos[0]?.id ?? null;

  var templateId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_onboarding_templates (id, school_id, name, description, position_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)',
    templateId,
    schoolId,
    'New Teacher Onboarding',
    'Standard onboarding workflow for new teaching hires.',
    teacherPosId,
  );

  // Seed Rivera with this checklist (NOT_STARTED — fresh template).
  var checklistId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      ".hr_onboarding_checklists (id, employee_id, template_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOT_STARTED')",
    checklistId,
    rivera.id,
    templateId,
  );

  interface TaskSpec {
    title: string;
    description: string;
    category: string;
    isRequired: boolean;
    dueDays: number;
    sortOrder: number;
  }
  var tasks: TaskSpec[] = [
    { title: 'Submit signed employment contract', description: 'Return signed contract to HR.', category: 'DOCUMENT', isRequired: true, dueDays: 0, sortOrder: 1 },
    { title: 'Complete I-9 / right-to-work verification', description: 'Bring eligible documents to HR for verification.', category: 'DOCUMENT', isRequired: true, dueDays: 3, sortOrder: 2 },
    { title: 'Submit Tax Form W-4', description: 'Federal withholding election.', category: 'DOCUMENT', isRequired: true, dueDays: 3, sortOrder: 3 },
    { title: 'Background check authorisation', description: 'Sign release form so HR can run the check.', category: 'DOCUMENT', isRequired: true, dueDays: 1, sortOrder: 4 },
    { title: 'Safeguarding Level 1 training', description: 'Complete the online module.', category: 'TRAINING', isRequired: true, dueDays: 14, sortOrder: 5 },
    { title: 'First Aid certification', description: 'Attend the in-person Red Cross session.', category: 'TRAINING', isRequired: true, dueDays: 30, sortOrder: 6 },
    { title: 'Issue laptop and SIS account', description: 'IT provisions equipment and platform access.', category: 'SYSTEM_ACCESS', isRequired: true, dueDays: 1, sortOrder: 7 },
    { title: 'Classroom orientation walkthrough', description: 'Tour with assigned mentor teacher.', category: 'ORIENTATION', isRequired: true, dueDays: 7, sortOrder: 8 },
  ];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_onboarding_tasks (id, checklist_id, title, description, category, is_required, due_days_from_start, sort_order) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8)',
      generateId(),
      checklistId,
      t.title,
      t.description,
      t.category,
      t.isRequired,
      t.dueDays,
      t.sortOrder,
    );
  }
  console.log('    onboarding: 1 template + 1 NOT_STARTED checklist (Rivera) + 8 tasks');
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
